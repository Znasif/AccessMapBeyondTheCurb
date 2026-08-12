/**
 * The in-tab backend — milestone 3w.
 *
 * `LocalLLMClient` was written in milestone 3 as a seam with a `transport` slot
 * and a FROZEN request contract, specifically so this file could slot in behind
 * it (plan §5, milestone 3 row). Nothing above the seam changes. This module
 * implements exactly the two methods the seam names:
 *
 *     embeddings(body, { signal })            -> OpenAI embeddings response
 *     chat(body, { signal, onChunk })         -> OpenAI completion, or chunks
 *
 * and `LocalLLMClient` cannot tell it from `HttpTransport`.
 *
 * ── Why this is a translation layer and not a reimplementation ───────────────
 *
 * wllama v3 embeds llama-server's OWN request path in WASM
 * (`oaicompat_chat_params_parse` / `params_from_json_cmpl`): the whole options
 * object is `JSON.stringify`-ed and handed to that parser. So `tools`,
 * `tool_choice`, `chat_template_kwargs`, `cache_prompt`, per-request `grammar`
 * and `response_format.json_schema` all mean what they mean on the HTTP router,
 * with the same semantics and the same bugs. The frozen body passes through
 * essentially verbatim. Only four things genuinely differ, and they are the
 * four things this file exists to handle:
 *
 *   1. **`model` is not a routing field.** The HTTP router serves every tier
 *      from one port and picks with `model`. wllama v3 is `n_parallel: 1` —
 *      one model per instance — so `l1` and `l3` are two `Wllama` objects, two
 *      workers, two WASM heaps (plan §8, and the memory is additive). `model`
 *      therefore selects an *engine* here rather than being sent anywhere.
 *   2. **`signal` is called `abortSignal`** and lives inside the options object
 *      rather than beside it.
 *   3. **Streaming is a callback, not SSE.** `{stream: true, onData}` yields
 *      the same `chat.completion.chunk` objects `ChatAssembler` already eats,
 *      so there is no second parser and no second assembler.
 *   4. **Loading is explicit and slow.** HTTP has a server already running;
 *      here the first call would otherwise sit on a 2.6 GB download. Loads are
 *      idempotent, deduped, and observable via `onProgress`.
 *
 * ── What is NOT here, deliberately ──────────────────────────────────────────
 *
 * No imperative KV control. v3 dropped v2's `kvClear`/`kvRemove`; what survives
 * is configuration (`n_cache_reuse`, `cache_type_k/v`, `cache_idle_slots`) and
 * it lives in `modelProfiles.js`. Milestone 15 (slot save/restore) stays on the
 * HTTP backend for exactly this reason — do not add an API here that pretends
 * otherwise.
 *
 * Platform-free in the same sense as the rest of `src/lib`: no DOM, no fetch,
 * no static `@wllama/wllama` import. The `Wllama` class is injected or lazily
 * imported, which is what lets `test_wllama_backend.mjs` run the whole contract
 * in Node with no model, no GPU and no network.
 */

import { TIER, LOCAL_MAX_TOKENS } from '../localLLM.js';
import { PROFILES, kvUpperBoundBytes } from './modelProfiles.js';

/**
 * Fields the frozen body may carry that must NOT reach llama.cpp's parser.
 *
 * `stream` is owned by this layer: the caller says "stream" by passing
 * `onChunk`, and letting a stale `stream: true` through while `onData` is
 * absent flips wllama into its async-iterator overload, which returns an
 * iterator nobody reads and hangs the turn.
 */
const OWNED_BY_TRANSPORT = new Set(['stream', 'onData', 'abortSignal']);

/** Everything else rides through untouched — that is the point of the seam. */
function toWllamaOptions(body) {
  const out = {};
  for (const [key, value] of Object.entries(body)) {
    if (!OWNED_BY_TRANSPORT.has(key)) out[key] = value;
  }
  return out;
}

/**
 * The §8.0 guard, restated at the backend boundary.
 *
 * `LocalLLMClient.chatCompletion` already forces `enable_thinking: false`
 * whenever `tools` are present, and `modelProfiles.js` sets both
 * `reasoning: false` and `default_template_kwargs` at load time. This is the
 * third check, and it is not redundant paranoia: the measured failure is that
 * the model emits 256 tokens of chain-of-thought, finishes on `length`, and
 * emits NO TOOL CALL AT ALL — a silent product-path failure that looks like a
 * dumb model rather than a config bug. Anything constructing a body by hand and
 * handing it to this transport directly gets told, loudly, at the boundary.
 */
function assertThinkingDisabled(body) {
  if (!body.tools?.length) return;
  if (body.chat_template_kwargs?.enable_thinking !== false) {
    throw new Error(
      'WllamaTransport: refusing a tools request without chat_template_kwargs.enable_thinking === false ' +
      '(design doc §8.0 — with tools present, thinking-on emits no tool call at all). ' +
      'Build the request through LocalLLMClient.chatCompletion, which sets it.',
    );
  }
}

/** Same reasoning as `LOCAL_MAX_TOKENS` in localLLM.js; enforced again at the edge. */
function clampMaxTokens(body) {
  const asked = body.max_tokens ?? LOCAL_MAX_TOKENS;
  return Math.max(1, Math.min(asked, LOCAL_MAX_TOKENS));
}

/**
 * Default `Wllama` factory. Only ever runs in a browser — every Node test
 * injects `createInstance`, so `@wllama/wllama` is not a Node dependency of the
 * test suite and the HTTP backend never pulls it into a bundle.
 */
async function defaultCreateInstance({ wasmUrl, config } = {}) {
  const { Wllama } = await import('@wllama/wllama/esm/index.js');
  let resolved = wasmUrl;
  if (!resolved) {
    // Vite rewrites `?url` to the emitted asset path. Kept inside the factory
    // so nothing outside a browser build ever evaluates it.
    resolved = (await import('@wllama/wllama/esm/wasm/wllama.wasm?url')).default;
  }
  return new Wllama({ default: resolved }, config);
}

/**
 * One loaded model in one worker. The unit v3's `n_parallel: 1` forces on us.
 */
export class WllamaEngine {
  /**
   * @param {object}   opts
   * @param {object}   opts.profile          from `modelProfiles.js`
   * @param {string}   [opts.url]            first shard; overrides profile.url
   * @param {object}   [opts.hf]             {repo, filePath}; overrides profile.hf
   * @param {object}   [opts.load]           LoadModelParams overrides
   * @param {string}   [opts.wasmUrl]
   * @param {Function} [opts.createInstance] () => Promise<Wllama>; injected in tests
   * @param {(p: {loaded: number, total: number}) => void} [opts.onProgress]
   */
  constructor({ profile, url, hf, load, wasmUrl, wllamaConfig, createInstance, onProgress } = {}) {
    if (!profile) throw new Error('WllamaEngine: `profile` is required');
    this.profile = profile;
    this.url = url ?? profile.url;
    this.hf = hf ?? profile.hf;
    this.loadParams = { ...profile.load, ...load };
    this.wasmUrl = wasmUrl;
    this.wllamaConfig = wllamaConfig;
    this.createInstance = createInstance || defaultCreateInstance;
    this.onProgress = onProgress;

    this.instance = null;
    this.contextInfo = null;
    /** @type {'idle'|'loading'|'ready'|'failed'} */
    this.status = 'idle';
    this.error = null;
    /** In-flight load, so a burst of concurrent calls downloads once. Same
     * pattern `placeIndex.js` uses for concurrent index builds. */
    this.loading = null;
  }

  get ready() {
    return this.status === 'ready';
  }

  /**
   * Idempotent. Concurrent callers share one download; a caller that arrives
   * after a successful load returns immediately.
   */
  async load() {
    if (this.status === 'ready') return this.instance;
    if (this.loading) return this.loading;

    this.status = 'loading';
    this.error = null;
    this.loading = (async () => {
      const instance = await this.createInstance({
        wasmUrl: this.wasmUrl,
        config: this.wllamaConfig,
        profile: this.profile,
      });
      const params = {
        ...this.loadParams,
        progressCallback: (p) => this.onProgress?.({ ...p, profile: this.profile.id }),
      };
      if (this.url) {
        try {
          await instance.loadModelFromUrl(this.url, params);
        } catch (err) {
          if (this.hf) {
            console.warn(`[WllamaEngine] Local URL (${this.url}) unavailable, falling back to Hugging Face...`, err);
            await instance.loadModelFromHF(this.hf, params);
          } else {
            throw err;
          }
        }
      } else if (this.hf) {
        await instance.loadModelFromHF(this.hf, params);
      } else {
        throw new Error(
          `WllamaEngine(${this.profile.id}): no model source — pass \`url\` (first shard of a ` +
          'split GGUF) or `hf` {repo, filePath}',
        );
      }
      this.instance = instance;
      // Captured once: the transport's memory reporting and the harness both
      // read n_layer/n_embd/n_ctx from here rather than hardcoding architecture.
      try {
        this.contextInfo = instance.getLoadedContextInfo?.() ?? null;
      } catch {
        this.contextInfo = null;
      }
      this.status = 'ready';
      return instance;
    })();

    try {
      return await this.loading;
    } catch (err) {
      this.status = 'failed';
      this.error = err;
      throw err;
    } finally {
      this.loading = null;
    }
  }

  /** Free the worker and the heap. Safe to call when never loaded. */
  async unload() {
    const instance = this.instance;
    this.instance = null;
    this.contextInfo = null;
    this.status = 'idle';
    if (instance?.exit) await instance.exit().catch(() => {});
  }

  /**
   * What this instance costs. `kvUpperBoundBytes` is honest about being loose —
   * see its doc comment; GQA and sliding-window layers both cut the real figure.
   */
  footprint() {
    return {
      id: this.profile.id,
      tier: this.profile.tier,
      status: this.status,
      contextInfo: this.contextInfo,
      kvUpperBoundBytes: kvUpperBoundBytes(this.contextInfo, this.loadParams),
    };
  }
}

/**
 * The `transport` `LocalLLMClient` takes. Multiplexes the OpenAI `model` field
 * onto engines, because wllama cannot.
 */
export class WllamaTransport {
  /**
   * @param {object} opts
   * @param {Record<string, WllamaEngine>} [opts.engines]  tier -> engine
   * @param {object} [opts.chat]   {profile, url, hf, load, ...} for TIER.REASON
   * @param {object} [opts.embed]  same, for TIER.EMBED; omit for chat-only
   * @param {Function} [opts.createInstance]  injected in tests
   * @param {boolean} [opts.autoLoad]  load on first use (default true). False
   *        makes an unloaded tier a loud error instead of a 2.6 GB surprise
   *        download in the middle of a user's question.
   */
  constructor({ engines, chat, embed, createInstance, wasmUrl, wllamaConfig, onProgress, autoLoad = true } = {}) {
    /** @type {Record<string, WllamaEngine>} */
    this.engines = { ...engines };
    this.autoLoad = autoLoad;

    const build = (spec, tier) => {
      if (!spec) return;
      const profile = typeof spec.profile === 'string' ? PROFILES[spec.profile] : spec.profile;
      if (!profile) throw new Error(`WllamaTransport: unknown profile for tier ${tier}`);
      if (profile.tier !== tier) {
        throw new Error(`WllamaTransport: profile "${profile.id}" is tier ${profile.tier}, not ${tier}`);
      }
      this.engines[tier] = new WllamaEngine({
        ...spec, profile, createInstance, wasmUrl, wllamaConfig, onProgress,
      });
    };
    build(chat, TIER.REASON);
    build(embed, TIER.EMBED);

    // `LocalLLMClient` copies `transport.baseUrl` onto itself for scripts that
    // print it. There is no URL here, and saying so beats saying "/llm/v1".
    this.baseUrl = null;
  }

  /** @returns {WllamaEngine} */
  engineFor(tier) {
    const engine = this.engines[tier];
    if (!engine) {
      const have = Object.keys(this.engines).join(', ') || 'none';
      throw new Error(
        `WllamaTransport: no engine for tier "${tier}" (configured: ${have}). ` +
        `${tier === TIER.EMBED
          ? 'PlaceIndex needs an `embed` profile — l1 is a SECOND Wllama instance, not a mode of the chat one (plan §8).'
          : 'Pass a `chat` profile.'}`,
      );
    }
    return engine;
  }

  async #ready(tier) {
    const engine = this.engineFor(tier);
    if (engine.ready) return engine;
    if (!this.autoLoad) {
      throw new Error(
        `WllamaTransport: engine "${engine.profile.id}" (${tier}) is not loaded and autoLoad is off. ` +
        'Call preload() behind a progress indicator before the first turn.',
      );
    }
    await engine.load();
    return engine;
  }

  /**
   * Download and open models ahead of the first question. Loading 2.6 GB on the
   * first utterance is a product bug, not a latency figure.
   *
   * @param {string[]} [tiers]  defaults to every configured tier
   */
  async preload(tiers) {
    const list = tiers ?? Object.keys(this.engines);
    // Sequential on purpose: two simultaneous multi-GB downloads on a laptop
    // link is slower than one after the other, and the peak heap during load is
    // additive too.
    for (const tier of list) await this.engineFor(tier).load();
    return this.stats();
  }

  /** @see HttpTransport.embeddings — same contract, no HTTP. */
  async embeddings(body, { signal } = {}) {
    const engine = await this.#ready(body.model ?? TIER.EMBED);
    const { model, input, ...rest } = body;
    return engine.instance.createEmbedding({
      ...rest,
      input,
      // Honoured inside wllama's result-polling loop, so a barge-in during a
      // 3,000-place index build actually stops it.
      abortSignal: signal,
    });
  }

  /**
   * @see HttpTransport.chat — same contract, no HTTP.
   *
   * `body` is the already-final OpenAI request the frozen contract produces.
   * It is forwarded as-is apart from the four differences documented at the top
   * of this file.
   */
  async chat(body, { signal, onChunk } = {}) {
    assertThinkingDisabled(body);
    const engine = await this.#ready(body.model ?? TIER.REASON);
    const options = toWllamaOptions(body);
    options.max_tokens = clampMaxTokens(body);
    options.abortSignal = signal;

    if (!onChunk) {
      return engine.instance.createChatCompletion({ ...options, stream: false });
    }
    // Returns undefined; the client's ChatAssembler folds the chunks. These are
    // the same `chat.completion.chunk` objects the SSE path parses, so the
    // assembler needs no wllama-specific branch.
    await engine.instance.createChatCompletion({
      ...options,
      stream: true,
      onData: (chunk) => onChunk(chunk),
    });
    return undefined;
  }

  /** Everything the two-instance memory picture needs, per engine. */
  stats() {
    return Object.fromEntries(
      Object.entries(this.engines).map(([tier, engine]) => [tier, engine.footprint()]),
    );
  }

  async unload() {
    for (const engine of Object.values(this.engines)) await engine.unload();
  }
}
