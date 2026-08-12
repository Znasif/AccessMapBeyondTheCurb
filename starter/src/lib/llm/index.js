/**
 * Backend selection for the LLM seam — milestone 3w.
 *
 * Plan §1.1: "the LLM runtime is one interface with two backends". This is the
 * one place that decides which. Everything above it — `placeIndex.js`,
 * `toolLoop.js`, the dispatcher, speech — takes a `LocalLLMClient` and never
 * learns which backend it got.
 *
 *     import { createLLMClient } from './lib/llm/index.js';
 *
 *     const client = await createLLMClient();                  // http (default)
 *     const client = await createLLMClient({ backend: 'wllama' });
 *     const client = await createLLMClient({ backend: 'auto' }); // env, else http
 *
 * The default is HTTP and that is deliberate, not laziness: §1.1 puts the
 * critical path on the router backend precisely so the conversational stack is
 * demoable on any desktop OS today, with 3w converting a working session into
 * the zero-install configuration rather than gating whether one exists. A
 * silent auto-switch to a 2.6 GB in-tab download would invert that.
 */

import { LocalLLMClient, TIER, HttpTransport } from '../localLLM.js';
import { WllamaTransport, WllamaEngine } from './wllamaTransport.js';
import { PROFILES, chooseChatProfile, planFootprint, formatBytes } from './modelProfiles.js';

export { WllamaTransport, WllamaEngine } from './wllamaTransport.js';
export * from './modelProfiles.js';

export const BACKEND = { HTTP: 'http', WLLAMA: 'wllama' };

/** Same env-lookup shape as `defaultBase()` in localLLM.js: Node first, then Vite. */
function readEnv(name, env) {
  if (env && name in env) return env[name];
  if (typeof process !== 'undefined' && process.env?.[name]) return process.env[name];
  if (typeof import.meta !== 'undefined' && import.meta.env?.[name]) return import.meta.env[name];
  return undefined;
}

/**
 * Name the backend without building it. Exported so a settings UI can show what
 * would happen, and so the choice is testable without a model.
 *
 * @param {object} [opts]
 * @param {'auto'|'http'|'wllama'} [opts.backend]
 * @param {object} [opts.env]  injected environment, for tests
 * @returns {{name: string, reason: string}}
 */
export function resolveBackend({ backend = 'auto', env } = {}) {
  if (backend !== 'auto') {
    if (backend !== BACKEND.HTTP && backend !== BACKEND.WLLAMA) {
      throw new Error(`resolveBackend: unknown backend "${backend}" (expected auto|http|wllama)`);
    }
    return { name: backend, reason: 'explicit argument' };
  }
  const fromEnv = readEnv('VITE_LLM_BACKEND', env);
  if (fromEnv) {
    if (fromEnv !== BACKEND.HTTP && fromEnv !== BACKEND.WLLAMA) {
      throw new Error(`resolveBackend: VITE_LLM_BACKEND="${fromEnv}" is not http|wllama`);
    }
    return { name: fromEnv, reason: 'VITE_LLM_BACKEND' };
  }
  return { name: BACKEND.HTTP, reason: 'default — plan §1.1 puts the critical path on the router backend' };
}

/**
 * What the current environment can actually do. Cheap and synchronous except
 * for the optional router ping.
 *
 * `crossOriginIsolated` is the one people miss: without COOP/COEP the browser
 * denies `SharedArrayBuffer`, wllama silently falls back to the single-thread
 * WASM build, and CPU-path prefill on a ~7k-token prompt goes from slow to
 * unusable. It does not affect the WebGPU path's decode, but prefill is the
 * number this system fears (§0.1).
 */
export async function probeRuntime({ fetchImpl, baseUrl, timeoutMs = 1500, env } = {}) {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  const report = {
    webgpu: !!nav?.gpu,
    crossOriginIsolated: typeof crossOriginIsolated !== 'undefined' ? crossOriginIsolated : false,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    deviceMemory: nav?.deviceMemory,
    hardwareConcurrency: nav?.hardwareConcurrency,
    router: null,
  };
  report.multithreadWasm = report.crossOriginIsolated && report.sharedArrayBuffer;

  const doFetch = fetchImpl || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
  const base = baseUrl || readEnv('VITE_LLM_BASE', env) || '/llm/v1';
  if (doFetch) {
    report.router = await doFetch(`${String(base).replace(/\/$/, '')}/models`, {
      signal: AbortSignal.timeout(timeoutMs),
    }).then((r) => r.ok).catch(() => false);
  }
  return report;
}

/**
 * Build a wllama transport with the profiles this system actually serves.
 *
 * Both tiers by default, because `placeIndex.js` needs `l1` and the tool loop
 * needs `l3`, and §8 is explicit that this is TWO instances rather than one
 * model with two modes. Pass `embed: null` for a chat-only page and save the
 * second worker.
 *
 * @param {object} [opts]
 * @param {string} [opts.profile]        chat profile id; see chooseChatProfile
 * @param {object} [opts.chat]           per-engine overrides {url, hf, load}
 * @param {object|null} [opts.embed]     same for l1; null disables the tier
 * @param {Function} [opts.createInstance]  injected in tests
 */
export function createWllamaTransport({
  profile,
  declaredMemoryGB,
  chat = {},
  embed = {},
  env,
  ...rest
} = {}) {
  const choice = chooseChatProfile({
    profile: profile ?? readEnv('VITE_LLM_PROFILE', env),
    deviceMemory: typeof navigator !== 'undefined' ? navigator.deviceMemory : undefined,
    declaredMemoryGB: declaredMemoryGB ?? (Number(readEnv('VITE_LLM_MEMORY_GB', env)) || undefined),
  });

  const transport = new WllamaTransport({
    chat: { profile: choice.id, ...chat },
    embed: embed === null ? undefined : { profile: 'embeddinggemma-q8', ...embed },
    ...rest,
  });
  transport.profileChoice = choice;
  return transport;
}

/**
 * The one entry point application code should use.
 *
 * @param {object} [opts]
 * @param {'auto'|'http'|'wllama'} [opts.backend]
 * @param {object} [opts.http]    forwarded to HttpTransport {baseUrl, fetchImpl, timeoutMs}
 * @param {object} [opts.wllama]  forwarded to createWllamaTransport
 * @returns {Promise<LocalLLMClient & {backend: string, backendReason: string}>}
 */
export async function createLLMClient({ backend = 'auto', env, http = {}, wllama = {}, preload = false } = {}) {
  const { name, reason } = resolveBackend({ backend, env });

  const transport = name === BACKEND.WLLAMA
    ? createWllamaTransport({ env, ...wllama })
    : new HttpTransport(http);

  const client = new LocalLLMClient({ transport, timeoutMs: http.timeoutMs });
  client.backend = name;
  client.backendReason = reason;
  if (name === BACKEND.WLLAMA && preload) await transport.preload();
  return client;
}

/**
 * The §7.2 budget for a given configuration, as a printable block. Used by the
 * measurement harness and by anything that wants to show a user why a machine
 * was given E2B.
 */
export function describeBudget({ chat, embed = 'embeddinggemma-q8', kvBytes } = {}) {
  const choice = chooseChatProfile({ profile: chat });
  const plan = planFootprint({ chat: choice.id, embed, kvBytes });
  const lines = [
    `chat  ${choice.id} — ${choice.reason}`,
    ...plan.instances.map((i) =>
      `  ${i.tier}  ${PROFILES[i.id].label}: weights ${formatBytes(i.weightsBytes[0])}` +
      `${i.weightsBytes[0] === i.weightsBytes[1] ? '' : `–${formatBytes(i.weightsBytes[1])}`}` +
      `${i.kvBytes ? ` + kv ${formatBytes(i.kvBytes)}` : ''} + overhead ${formatBytes(i.overheadBytes)}`),
    `  total ${formatBytes(plan.totalBytes[0])}` +
      `${plan.totalBytes[0] === plan.totalBytes[1] ? '' : `–${formatBytes(plan.totalBytes[1])}`}`,
    ...plan.notes.map((n) => `  note: ${n}`),
  ];
  return { choice, plan, text: lines.join('\n') };
}

export { TIER, LocalLLMClient };
