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
 * Where a tier's weights come from, after the environment has had its say.
 *
 * Modelled on how `VITE_BUILDINGS_URL` is documented in
 * `docs/deploy-github-pages.md` §3.2, because the problem is the same one: an
 * asset too large for GitHub Pages, which therefore has a local path that is
 * right in `npm run dev` and wrong everywhere else.
 *
 *   unset  → the profile's own `url` (dev: `/models/…`, served by
 *            `serveSpikeModels()`), with `hf` still behind it as a fallback
 *   ''     → no local URL at all; go straight to Hugging Face. This is the
 *            Pages configuration, where `pruneOversizedAssets()` guarantees
 *            `/models/*.gguf` is a 404 and trying it first only wastes a
 *            request
 *   a URL  → that URL. An external CORS host, or the first shard of a split
 *            GGUF published as GitHub Release assets
 *
 * The HF override is two variables and they are all-or-nothing: a repo without
 * a file path has to be globbed to be useful, and globbing a third-party repo is
 * what aborted the WASM module (see the warning above `PROFILES`). Setting the
 * repo to `''` disables the fallback entirely, which is the right setting when a
 * pinned `VITE_MODEL_URL` must be the only thing that can ever load.
 *
 * @param {object} [opts]
 * @param {object} [opts.profile]  the profile whose defaults are being layered over
 * @param {object} [opts.env]      injected environment, for tests
 * @param {string} [opts.urlVar]   env var holding the local/first-shard URL
 * @param {string} [opts.repoVar]  env var holding the HF repo
 * @param {string} [opts.fileVar]  env var holding the HF file path (exact, never a glob)
 * @returns {{url?: string|undefined, hf?: object|undefined}} A patch to spread
 *   over a PROFILE (not over an engine spec — `WllamaEngine` resolves `url ??
 *   profile.url`, so an `undefined` in a spec means "not overridden" and could
 *   never express "there is no local copy"). A key is present only when the
 *   environment decided something; a present key whose value is `undefined`
 *   means that source is switched off.
 */
export function resolveModelSource({
  profile,
  env,
  urlVar = 'VITE_MODEL_URL',
  repoVar = 'VITE_MODEL_HF_REPO',
  fileVar = 'VITE_MODEL_HF_FILE',
} = {}) {
  const out = {};

  const url = readEnv(urlVar, env);
  // `undefined` is "not configured"; `''` is a configuration, and it means
  // "there is no local copy", which is exactly the Pages case.
  if (url !== undefined) out.url = String(url).trim() || undefined;

  const repo = readEnv(repoVar, env);
  const filePath = readEnv(fileVar, env);
  if (repo !== undefined || filePath !== undefined) {
    const repoValue = String(repo ?? profile?.hf?.repo ?? '').trim();
    const fileValue = String(filePath ?? profile?.hf?.filePath ?? '').trim();
    // Checked before the completeness test, and unconditionally: a glob is
    // wrong even when the rest of the configuration is too incomplete to use it.
    if (fileValue.includes('*') || fileValue.includes('?')) {
      throw new Error(
        `resolveModelSource: ${fileVar}="${fileValue}" is a glob. Pin an exact filename — ` +
        'a glob resolves against a third-party repo listing and can load a model that aborts ' +
        'the WASM module (see modelProfiles.js).',
      );
    }
    out.hf = repoValue && fileValue ? { repo: repoValue, filePath: fileValue } : undefined;
  }

  return out;
}

/**
 * Build a wllama transport with the profiles this system actually serves.
 *
 * Both tiers by default, because `placeIndex.js` needs `l1` and the tool loop
 * needs `l3`, and §8 is explicit that this is TWO instances rather than one
 * model with two modes. Pass `embed: null` for a chat-only page and save the
 * second worker.
 *
 * Both tiers take their weight source from the environment via
 * {@link resolveModelSource} — `VITE_MODEL_URL`/`VITE_MODEL_HF_*` for the chat
 * tier, `VITE_EMBED_URL`/`VITE_EMBED_HF_*` for the embedding one — applied to
 * the *profile*, so an explicit `chat: {url}` from a caller still wins over both.
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

  const chatProfile = { ...PROFILES[choice.id], ...resolveModelSource({ profile: PROFILES[choice.id], env }) };
  const embedProfile = {
    ...PROFILES['embeddinggemma-q8'],
    ...resolveModelSource({
      profile: PROFILES['embeddinggemma-q8'],
      env,
      urlVar: 'VITE_EMBED_URL',
      repoVar: 'VITE_EMBED_HF_REPO',
      fileVar: 'VITE_EMBED_HF_FILE',
    }),
  };

  const transport = new WllamaTransport({
    chat: { ...chat, profile: chat.profile ?? chatProfile },
    embed: embed === null ? undefined : { ...embed, profile: embed.profile ?? embedProfile },
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
