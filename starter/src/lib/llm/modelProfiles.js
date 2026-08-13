/**
 * Model profiles for the in-tab backend — milestone 3w.
 *
 * A profile is everything the wllama transport needs to turn a tier name
 * (`l1`, `l3`) into a loaded `Wllama` instance: where the GGUF lives, how to
 * open the context, and what it is expected to cost in memory.
 *
 * Two facts from plan §8 shape this file and neither is negotiable:
 *
 *   1. **One model per `Wllama` instance.** v3 runs `n_parallel: 1`, so serving
 *      `l1` (EmbeddingGemma) and `l3` (Gemma 4) from the same page means TWO
 *      instances, each with its own worker and its own WASM heap. The cost is
 *      additive, which is why `planFootprint()` sums rather than maxes.
 *   2. **Thinking must be off.** Design doc §8.0: with `tools` present,
 *      thinking-on is fatal rather than slow. `LocalLLMClient` already sets
 *      `chat_template_kwargs.enable_thinking: false` per request; the profile
 *      sets `reasoning: false` AND `default_template_kwargs` at load time so a
 *      tool-less narration turn is covered too. Belt, braces, and a third belt,
 *      because the failure is silent.
 *
 * Weight sizes are file sizes, not guesses: the E2B figure is the byte count of
 * the GGUF prepared for the W spike (`explore/wllama-spike/models/`). E4B is
 * carried as a RANGE because two published quantisations differ by 300 MB and
 * plan §7.2 quotes both; a range that is honest beats a point that is invented.
 */

import { TIER } from '../localLLM.js';

const GB = 1024 ** 3;

/**
 * @typedef {object} ModelProfile
 * @property {string}  id
 * @property {string}  tier            TIER.EMBED | TIER.REASON
 * @property {string}  label
 * @property {string}  [url]           first shard; wllama auto-loads the rest
 * @property {object}  [hf]            {repo, filePath} alternative to `url`
 * @property {number}  [weightsBytes]  exact, when the file is known
 * @property {[number, number]} [weightsBytesRange]  when it is not
 * @property {object}  load            LoadModelParams for this profile
 */

/**
 * `n_cache_reuse` is the only KV lever wllama v3 leaves us (§8: configuration,
 * not control — v2's `kvClear`/`kvRemove` are gone). It is the minimum length
 * of a chunk llama.cpp will shift and reuse when a prompt diverges in the
 * MIDDLE; 256 is llama-server's own working default. It is a floor, not a
 * budget — raising it does not buy more reuse.
 *
 * ⚠️ MEASURED 2026-08-11, and it corrects an assumption in plan §8. Loading
 * Gemma 4 E2B through this profile makes llama.cpp print:
 *
 *     srv load_model: cache_reuse is not supported by this context,
 *                     it will be disabled
 *
 * Gemma 4 is an interleaved sliding-window model, so the context comes up as
 * `kv_unified = false` with a split iSWA cache (see `SWA_FULL_NOTE`), and the
 * shifting `n_cache_reuse` needs is unavailable there. The flag is kept because
 * it is free and correct for non-SWA models, but **it is not what serves this
 * system's prefix reuse.**
 *
 * The fallback would be `cache_prompt: true` plus llama-server's slot prompt
 * cache, which reuses the longest common prefix — precisely the append-only
 * history rule `toolLoop.js` enforces (§6.1). ⚠️ THAT DOES NOT WORK EITHER in
 * this configuration. Same run, second turn:
 *
 *     slot update_slots: id 0 | task 127 | forcing full prompt re-processing
 *     due to lack of cache data (likely due to SWA or hybrid/recurrent memory)
 *     — https://github.com/ggml-org/llama.cpp/pull/13194#issuecomment-2868343055
 *     slot update_slots: id 0 | task 132 | erased invalidated context
 *     checkpoint (pos_min = 674, pos_max = 1697, n_tokens = 1698,
 *     n_swa = 512, pos_next = 0, size = 6.006 MiB)
 *
 * `n_swa = 512` is the whole story, and it makes this structural rather than
 * incidental. The sliding-window layers retain 512 tokens. A 6.2–6.8k prompt is
 * 12–13 windows long, so positions before the last 512 cannot be reconstructed,
 * llama.cpp erases the checkpoint, and `pos_next = 0` — it restarts from token
 * ZERO. Not "reuses less than hoped": reuses nothing.
 *
 * ⚠️ CORRECTED 2026-08-12 by the harness, which measures reuse instead of
 * reading the log. The log lines above are real; the conclusion drawn from them
 * was too broad. **Append-only reuse was never broken.** bench item 6 — turn 2
 * appended to a byte-identical prefix, exactly §6.1's rule — reuses 0.997 of
 * 6397 tokens with `swa_full` OFF, on both machines. Continuing a prefix needs
 * no reconstruction, so the sliding window never has to reach back.
 *
 * What SWA actually defeats is reuse across a prompt that diverges in a stable
 * HEAD — the case `n_cache_reuse` exists for, and the case a new user turn
 * always is: same system prompt, freshly retrieved candidate block. There the
 * default reuses ZERO of 6363 tokens. That is still the cost that matters, so
 * the practical conclusion stands; only the mechanism was mis-stated.
 *
 * `SWA_FULL_NOTE` fixes it, and is now on by default.
 */
export const N_CACHE_REUSE = 256;

/**
 * The candidate fix for the reuse failure documented on `N_CACHE_REUSE`, and
 * llama.cpp's own documented workaround for it.
 *
 * `swa_full: true` allocates the sliding-window layers at full context length
 * instead of one window. On E2B at n_ctx 8192 the measured KV split is
 * 48 MiB (3 non-SWA layers × 8192 cells) + 12 MiB (12 SWA layers × 1024
 * cells) = 60 MiB; `swa_full` takes the second term to ~96 MiB, so roughly
 * +84 MiB total. That is nothing next to 2.6 GB of weights, and if it buys
 * full-prefix reuse on a 6.5k prompt it is the best trade in the file.
 *
 * ✅ MEASURED 2026-08-12 on both machines, and it is DEFAULT ON as a result.
 * Paired runs in `explore/wllama-spike/results/`, same build, same prompt, the
 * flag as the only difference — on the divergent-head call:
 *
 *                        cached / 6363     wall      new-token prefill    peak
 *     linux-x64  off          0          38.52 s        173.5 tok/s     6006.3 MB
 *     linux-x64  ON        6345           0.91 s        124.9 tok/s     6006.5 MB
 *     m1-8gb     off          0         119.52 s         53.8 tok/s     4975.6 MB
 *     m1-8gb     ON        6345           2.37 s         39.3 tok/s     4975.4 MB
 *
 * 42× on the desktop, 50× on the M1 — which is the difference between a
 * two-minute turn and a usable one. The predicted ~+84 MiB does not show up in
 * peak memory at all (−0.2 MB and +0.2 MB; both are noise). The cost is real
 * but small and consistent: ~27–28% slower prefill on tokens that genuinely
 * are new, since SWA layers now attend over the full context. Paying 28% more
 * per new token to prefill 50× fewer of them is not a close call.
 *
 * Re-measure with `npm run measure -- --swa-full` after any libllama bump, and
 * check the reuse row prints `swa_full=true` — a run whose label says swafull
 * but whose `loadParams.swa_full` is unset measures the default twice, which
 * happened once already.
 */
export const SWA_FULL_NOTE = 'default ON — measured 2026-08-12, 42–50× on divergent-head reuse, free on memory';

/**
 * 8192 matches the HTTP router's context. Plan-adjacent measurement recorded on
 * the 8 GB M1 that this is a latency/eviction choice, not a memory wall: the
 * curated prompt is 6.2–6.8k tokens and the reply is capped at 768, so 8192 is
 * the smallest context that fits a full round without ctx-shift eating the
 * prefix — which would destroy the reuse the slot prompt cache buys.
 */
export const DEFAULT_N_CTX = 8192;

/** Shared chat-tier load params. Profiles override `n_ctx`/urls, not these. */
const CHAT_LOAD = {
  n_ctx: DEFAULT_N_CTX,
  n_cache_reuse: N_CACHE_REUSE,
  // The jinja path is what carries tool-call rendering and `enable_thinking`.
  // Without it wllama falls back to a legacy formatter and the tools vanish.
  jinja: true,
  // §8.0, half one. Load-time reasoning switch.
  reasoning: false,
  // §8.0, half two. Merged UNDER any per-request kwargs by wllama itself
  // (`createChatCompletion` spreads defaults first), so this covers the turns
  // `LocalLLMClient` does not mark — narration rounds with no `tools` array.
  default_template_kwargs: { enable_thinking: false },
  n_gpu_layers: 99999,
  // Keeps a warm slot rather than tearing the context down between turns. THIS
  // is what carries prefix reuse for append-only history — see N_CACHE_REUSE.
  cache_idle_slots: true,
  // Allocates the sliding-window layers at full n_ctx so a prompt that diverges
  // in a stable head can still be reused. Measured, not assumed — SWA_FULL_NOTE
  // carries the paired numbers.
  swa_full: true,
};

const EMBED_LOAD = {
  // EmbeddingGemma's training length. Place documents are one line each, so the
  // context is sized for the longest document, not for a conversation.
  n_ctx: 2048,
  embeddings: true,
  // EmbeddingGemma is a mean-pooled sentence encoder. Getting this wrong does
  // not error — it silently returns last-token vectors and ranking degrades.
  pooling_type: 'mean',
  n_gpu_layers: 99999,
};

/**
 * ⚠️ **NEVER PUT A GLOB IN AN `hf.filePath`.** `loadModelFromHF` expands a glob
 * against the repo's file listing and loads whatever comes back, so a pattern
 * like `UD-Q4_K_XL/*.gguf` is a promise that a third party will never add a file
 * to that folder. They did. It matched an auxiliary Gemma 4 model, llama.cpp
 * printed
 *
 *     Gemma4Assistant requires ctx_other to be set
 *     GGML_ASSERT(ctx_tgt != nullptr) failed
 *
 * and a failed `GGML_ASSERT` aborts the entire WASM module — every later call in
 * the tab dies with `RuntimeError: unreachable`, including the retry, because
 * there is no module left to retry into. Pin exact filenames. A missing pinned
 * file is a 404 that the `url`→`hf` fallback in `wllamaTransport.js` can survive;
 * a wrong matched file is not survivable at all.
 *
 * `url` is the *local* source and `hf` the remote fallback, in that order (see
 * `WllamaEngine.load`). Which of the two a given deployment actually gets is a
 * deployment decision, so `llm/index.js#resolveModelSource` layers env vars over
 * both — see there for `VITE_MODEL_URL` and friends.
 */
export const PROFILES = {
  /**
   * The in-tab chat default. 2.62 GB is the exact size of
   * `gemma-4-E2B-it-qat-UD-Q4_K_XL.gguf` as split for the W spike — the same
   * QAT + UD-Q4_K_XL family as the E4B the native parity benchmark measured.
   *
   * `url` points at the FIRST SHARD of that split; wllama's `llama-gguf-split`
   * handling pulls 00002..00005 itself. In `npm run dev` this resolves through
   * `serveSpikeModels()` in `vite.config.js`, which serves `/models/*` out of
   * `../explore/wllama-spike/models/`. It does NOT resolve in a deployed build:
   * `pruneOversizedAssets()` drops everything over 100 MB from `dist/` because
   * GitHub Pages will not serve it, so a Pages build has no weights at all and
   * MUST be pointed at an external CORS host via `VITE_MODEL_URL` — or fall
   * through to `hf` below.
   *
   * ✅ TWO THINGS SETTLED 2026-08-12, after one wrong diagnosis each way.
   *
   * **The unsplit 2.62 GB file loads.** Verified cold: Chrome incognito on an
   * RTX 3080, OPFS at 0 MB, storage climbing to 2955 MB — 2.62 GB of E2B plus
   * ~318 MB of EmbeddingGemma, both tiers open, questions answered. So wllama v3
   * streams past the 2 GB `ArrayBuffer` cap that §0.1 cites as the reason for
   * `llama-gguf-split` support. The W spike's 5 shards work too; they are one
   * option, not a requirement.
   *
   * **The `hf` path below had no subfolder, and a 404 looks like a broken
   * model.** `UD-Q4_K_XL/<file>.gguf` returns `404 EntryNotFound` — the GGUF
   * sits at the repo ROOT. wllama cached the 15-byte error body and llama.cpp
   * failed to build a context from it, printing:
   *
   *     llama_init_from_model: failed to initialize the context:
   *       Gemma4Assistant requires ctx_other to be set
   *     GGML_ASSERT(ctx_tgt != nullptr) failed   (server-context.cpp:1259)
   *
   * ...which aborts the whole WASM module. **That signature means "no usable
   * model here", not "wrong model".** `Gemma4Assistant requires ctx_other` is
   * memory-fitting noise on the way down. Two diagnoses were built on it and
   * both were wrong: that a glob had matched an auxiliary "assistant" model, and
   * that shards were mandatory. The real tell is that
   * `model-00001-of-00001.gguf` is **wllama's cache name for any single-file
   * model** and identifies nothing about the source.
   *
   * Before changing any `hf.filePath`, curl it:
   *   curl -sSIL https://huggingface.co/<repo>/resolve/main/<path> | grep -E 'HTTP|content-length'
   * A 200 whose `content-length` equals `weightsBytes` is the only green light.
   */
  'gemma-4-e2b-q4': {
    id: 'gemma-4-e2b-q4',
    tier: TIER.REASON,
    label: 'Gemma 4 E2B (QAT, UD-Q4_K_XL)',
    url: '/models/gemma-4-E2B-it-qat-UD-Q4_K_XL.gguf',
    hf: {
      repo: 'unsloth/gemma-4-E2B-it-qat-GGUF',
      filePath: 'gemma-4-E2B-it-qat-UD-Q4_K_XL.gguf',
    },
    weightsBytes: 2_620_370_976,
    /**
     * MEASURED 2026-08-11 from llama.cpp's own load log at `n_ctx: 8192`:
     * 48 MiB non-SWA (8192 cells × 3 layers, f16 K+V) + 12 MiB SWA
     * (1024 cells × 12 layers) = 60 MiB. Note how far this is below
     * `kvUpperBoundBytes` — which is exactly the looseness that function's doc
     * comment warns about, now with a number attached. Compute buffer was a
     * further 118.52 MiB and the weights landed at 2699.90 MiB in-heap on the
     * CPU path (the WebGPU path streams them to GPU buffers instead).
     */
    measuredKvBytes: { 8192: 60 * 1024 * 1024 },
    load: { ...CHAT_LOAD },
  },

  /**
   * The 16 GB configuration. ⚠️ The weight figure is a RANGE, not a
   * measurement: plan §7.2 records Q4_0 at 4.84 GB and Google's QAT q4_0 at
   * 5.15 GB. Nobody has loaded this in a tab here — `measured: false` says so,
   * and `planFootprint()` reports the pessimistic end.
   *
   * ✅ `filePath` verified by HEAD 2026-08-12: 200, and the served
   * `content-length` is **4,215,695,776 bytes (3.93 GiB)**. ⚠️ That makes the
   * range below WRONG — plan §7.2's "~4.8–5.2 GB, over budget on an 8 GB M1"
   * quotes Q4_0 and Google's QAT q4_0, not the UD-Q4_K_XL this profile actually
   * points at, which is ~900 MB smaller. The range is kept until someone loads
   * it in a tab (`measured: false`), because a file size is not a footprint —
   * but re-derive the E4B budget from 3.93 GiB, not from 5.15.
   *
   * ⚠️ A wrong `filePath` is NOT harmless: wllama caches the 404 body and
   * llama.cpp aborts the WASM module trying to open it. Curl any path change.
   */
  'gemma-4-e4b-q4': {
    id: 'gemma-4-e4b-q4',
    tier: TIER.REASON,
    label: 'Gemma 4 E4B (QAT, q4)',
    hf: {
      repo: 'unsloth/gemma-4-E4B-it-qat-GGUF',
      filePath: 'gemma-4-E4B-it-qat-UD-Q4_K_XL.gguf',
    },
    weightsBytesRange: [4.84 * GB, 5.15 * GB],
    measured: false,
    load: { ...CHAT_LOAD },
  },

  'embeddinggemma-q8': {
    id: 'embeddinggemma-q8',
    tier: TIER.EMBED,
    label: 'EmbeddingGemma 300M (Q8_0)',
    hf: { repo: 'ggml-org/embeddinggemma-300M-GGUF', filePath: 'embeddinggemma-300M-Q8_0.gguf' },
    // 300M parameters at 8 bits plus the embedding matrix. Not weighed here.
    weightsBytesRange: [0.3 * GB, 0.4 * GB],
    measured: false,
    load: { ...EMBED_LOAD },
  },
};

/**
 * Per-instance fixed overhead: the wllama WASM module, the worker's own heap,
 * and llama.cpp's compute buffers. Charged once per `Wllama`, which is the
 * whole point of §8's "two instances is additive". The 7.6 MB `wllama.wasm` is
 * the floor; 192 MB is a working allowance for compute + scratch and is
 * deliberately round — replace it with `measureUserAgentSpecificMemory()` output
 * from `explore/wllama-spike/measure.mjs` when you have it.
 */
export const PER_INSTANCE_OVERHEAD_BYTES = 192 * 1024 * 1024;

/** `[lo, hi]` weight bounds for a profile, whether it carries a point or a range. */
export function weightBounds(profile) {
  if (typeof profile.weightsBytes === 'number') {
    return [profile.weightsBytes, profile.weightsBytes];
  }
  if (Array.isArray(profile.weightsBytesRange)) return [...profile.weightsBytesRange];
  return [0, 0];
}

/**
 * Upper bound on KV-cache bytes, from the context info llama.cpp reports after
 * load (`wllama.getLoadedContextInfo()`).
 *
 * ⚠️ It is an UPPER bound and materially loose for this model family. The
 * formula assumes every layer stores full-width K and V at `n_embd`, whereas
 * Gemma uses grouped-query attention (fewer KV heads than query heads) and
 * interleaves sliding-window layers that never hold the whole context. Both cut
 * the real figure, often by more than half. Use it to prove headroom exists,
 * never to claim a machine is out of memory — llama.cpp prints the true size in
 * its load log, and `measure.mjs` captures it.
 *
 * @param {{n_layer: number, n_embd: number, n_ctx: number}} ctx
 * @param {{cache_type_k?: string, cache_type_v?: string}} [load]
 */
export function kvUpperBoundBytes(ctx, load = {}) {
  if (!ctx?.n_layer || !ctx?.n_embd || !ctx?.n_ctx) return null;
  const width = (type) => (type === 'q8_0' ? 1.0625 : type === 'q4_0' ? 0.5625 : type === 'f32' ? 4 : 2);
  const k = width(load.cache_type_k);
  const v = width(load.cache_type_v);
  return Math.round(ctx.n_layer * ctx.n_embd * ctx.n_ctx * (k + v));
}

/**
 * The §7.2 budget arithmetic, as code rather than prose.
 *
 * @param {object} opts
 * @param {string} [opts.chat]   profile id for `l3`
 * @param {string} [opts.embed]  profile id for `l1`, or null for chat-only
 * @param {Record<string, number>} [opts.kvBytes]  measured KV per profile id
 * @returns {{instances: object[], totalBytes: [number, number], notes: string[]}}
 */
export function planFootprint({ chat = 'gemma-4-e2b-q4', embed = 'embeddinggemma-q8', kvBytes = {} } = {}) {
  const ids = [chat, embed].filter(Boolean);
  const instances = ids.map((id) => {
    const profile = PROFILES[id];
    if (!profile) throw new Error(`planFootprint: unknown profile "${id}"`);
    const [lo, hi] = weightBounds(profile);
    // A measured KV figure beats an unmeasured zero, and both beat the upper
    // bound — which for E2B overstates the truth by more than 30×.
    const kv = kvBytes[id] ?? profile.measuredKvBytes?.[profile.load?.n_ctx] ?? 0;
    return {
      id,
      tier: profile.tier,
      measured: profile.measured !== false,
      weightsBytes: [lo, hi],
      kvBytes: kv,
      overheadBytes: PER_INSTANCE_OVERHEAD_BYTES,
      totalBytes: [lo + kv + PER_INSTANCE_OVERHEAD_BYTES, hi + kv + PER_INSTANCE_OVERHEAD_BYTES],
    };
  });

  const totalBytes = instances.reduce(
    (acc, i) => [acc[0] + i.totalBytes[0], acc[1] + i.totalBytes[1]],
    [0, 0],
  );

  const notes = [];
  if (instances.length > 1) {
    notes.push('two Wllama instances: worker + WASM heap each, additive (plan §8)');
  }
  if (instances.some((i) => !i.measured)) {
    notes.push('contains unmeasured weight ranges — treat the upper bound as the budget');
  }
  const missingKv = instances.filter((i) => !i.kvBytes).map((i) => i.id);
  if (missingKv.length) {
    notes.push(`KV not counted for ${missingKv.join(', ')}: pass measured kvBytes from measure.mjs`);
  }
  return { instances, totalBytes, notes };
}

/**
 * Which chat profile to run in a tab.
 *
 * The important part is the default, and it is E2B. Plan §7.2 concluded "E2B is
 * the in-tab configuration on 8 GB machines; E4B in-tab is a 16 GB
 * configuration" — but a browser CANNOT TELL THE TWO APART. `navigator.
 * deviceMemory` is clamped to a maximum of 8 by the spec, for fingerprinting
 * reasons, so a 64 GB workstation and an 8 GB laptop both report `8`. A rule of
 * "pick E4B when deviceMemory >= 16" would therefore never fire, and a rule of
 * ">= 8" fires on exactly the machines §7.2 says it must not.
 *
 * So the honest policy: **E2B unless a human says otherwise.** E4B in a tab is
 * opt-in — either an explicit `profile` argument or `VITE_LLM_PROFILE`. E4B
 * remains the default on the HTTP-router backend, where the process can read
 * real system memory (§1.1).
 *
 * @param {object} [opts]
 * @param {string} [opts.profile]        explicit override, wins over everything
 * @param {number} [opts.deviceMemory]   navigator.deviceMemory, if known
 * @param {number} [opts.declaredMemoryGB]  real RAM, when a human supplied it
 * @returns {{id: string, reason: string}}
 */
export function chooseChatProfile({ profile, deviceMemory, declaredMemoryGB } = {}) {
  if (profile) {
    if (!PROFILES[profile]) throw new Error(`chooseChatProfile: unknown profile "${profile}"`);
    if (PROFILES[profile].tier !== TIER.REASON) {
      throw new Error(`chooseChatProfile: "${profile}" is not a ${TIER.REASON} profile`);
    }
    return { id: profile, reason: 'explicit override' };
  }
  if (declaredMemoryGB >= 16) {
    return { id: 'gemma-4-e4b-q4', reason: `declared ${declaredMemoryGB} GB of system memory` };
  }
  if (deviceMemory !== undefined && deviceMemory < 8) {
    return { id: 'gemma-4-e2b-q4', reason: `navigator.deviceMemory reports ${deviceMemory} GB` };
  }
  // Includes deviceMemory === 8, which means "8 or more" and nothing sharper.
  return {
    id: 'gemma-4-e2b-q4',
    reason: 'default: navigator.deviceMemory is clamped at 8 and cannot distinguish 8 GB from 32 GB',
  };
}

/** Human-readable byte count for the budget tables and the harness output. */
export function formatBytes(bytes) {
  if (bytes == null) return '?';
  if (bytes >= GB) return `${(bytes / GB).toFixed(2)} GB`;
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}
