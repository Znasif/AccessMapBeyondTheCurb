/**
 * Dispatcher — milestone 7. The escalation ladder, and the only caller of
 * `runToolLoop`.
 *
 * ## The ladder is not three answerers
 *
 * The design doc's diagram reads as four layers an utterance falls through. Two
 * of them do not behave that way:
 *
 *   - **L1 never answers.** Place resolution is retrieval, and candidate
 *     injection was measured as strictly better *unconditional* than gated. So
 *     L1 is not a rung the utterance can stop on — it is mandatory preprocessing
 *     for L3. (`placeIndex`'s `confident` flag exists to gate L2's fast path and
 *     therefore has **no consumer here**. Nothing in M7 reads it as a routing
 *     signal.)
 *   - **L2 does not exist.** M14 is deferred.
 *
 * So the real ladder is **L0 → (L1 preprocessing) → L3**, and the only decision
 * is whether L0 answers:
 *
 * ```
 * L0.1  control        whole-utterance match → the speaker, nothing else
 * L0.2  whats_here     live stream, fresh    → templated answer, no inference
 * L0.3  whats_here     deterministic at()    → templated answer, INCLUDING "nothing here"
 * L1    preprocessing  placeIndex.resolve(), always, never building the index
 * L3    tool loop      runToolLoop, executeTool → registry.dispatch
 * ```
 *
 * ## Three non-escalation rules
 *
 * 1. **Empty `at()`.** A complete, correct answer. Escalating it to L3 with a
 *    candidate block invites the model to name a nearby place as though the
 *    finger were on it.
 * 2. **Tier C adjacency.** Answer with the name and stop, rather than escalating
 *    for adjacency the world cannot supply.
 * 3. **`Unsupported` inside L3.** Returned to the model as `status:
 *    'unsupported'` with a narratable message; never retried, never re-planned.
 *    The tools needing the missing capability were never offered, so an
 *    `Unsupported` reaching a handler means the *adapter* is partial, not the
 *    session, and the honest move is to say so.
 *
 * ## Never build the index at turn time
 *
 * `placeIndex.resolve()` answering `no-index` means the utterance proceeds with
 * no candidates, not that the dispatcher stops to build one. 3,004 places is
 * 3,004 embeddings; index build is a session-start / window-change job.
 *
 * Everything is injected — `sources` for live values, `prefsStore`, `speak`,
 * `log`, `client`. Nothing global, no platform.
 */

import { runToolLoop } from './toolLoop.js';
import { buildSystemPrompt, buildUserTurn } from './candidateContext.js';
import { UNTRUSTED_PREAMBLE, sanitizeText } from './untrusted.js';
import { createTurnContext } from './turnContext.js';
import { matchL0, narrateWhatsHere } from './l0.js';
import { whatsHere } from './tools/whatsHere.js';
import { makeResult, unitsFor } from './toolResult.js';

/** Candidates retrieved per turn. Matches the envelope's `MAX_CANDIDATES`. */
export const CANDIDATE_K = 5;

export class Dispatcher {
  /**
   * @param {object} params
   * @param {import('./toolRegistry.js').ToolRegistry} params.registry
   * @param {object} params.adapter
   * @param {object} [params.client]      `LocalLLMClient`; only L3 needs it.
   * @param {object} [params.placeIndex]
   * @param {object} [params.surface]     `createSurface()` result.
   * @param {object} [params.sources]     `{uv, window, liveFeature, heading, now}`.
   * @param {{get: Function, set?: Function}} [params.prefsStore]
   * @param {(text: string, meta?: object) => void} [params.speak]
   * @param {(record: object) => void} [params.log]
   * @param {object} [params.session]     `{tier}`.
   * @param {number} [params.liveFeatureMaxAgeMs]
   */
  constructor({
    registry,
    adapter,
    client,
    placeIndex,
    surface,
    sources = {},
    prefsStore,
    speak,
    log,
    session = {},
    liveFeatureMaxAgeMs,
    maxRounds,
  } = {}) {
    if (!registry) throw new Error('Dispatcher: a ToolRegistry is required');
    if (!adapter) throw new Error('Dispatcher: a WorldAdapter is required');
    this.registry = registry;
    this.adapter = adapter;
    this.client = client;
    this.placeIndex = placeIndex;
    this.surface = surface;
    this.sources = sources;
    this.prefsStore = prefsStore;
    this.speak = speak;
    this.log = log;
    this.session = session;
    this.liveFeatureMaxAgeMs = liveFeatureMaxAgeMs;
    this.maxRounds = maxRounds;
    /** The stable half of the prompt, built once. See `candidateContext.js`. */
    this.systemPrompt = buildSystemPrompt({ extra: UNTRUSTED_PREAMBLE });
  }

  /** The frozen snapshot for one turn. Exposed so a caller can inspect it in tests. */
  context() {
    return createTurnContext({
      adapter: this.adapter,
      surface: this.surface,
      sources: this.sources,
      prefsStore: this.prefsStore,
      session: this.session,
      ...(this.liveFeatureMaxAgeMs ? { liveFeatureMaxAgeMs: this.liveFeatureMaxAgeMs } : {}),
    });
  }

  /**
   * The served tool block for this session.
   *
   * Recomputed whenever the frame changes, because `AudiomWorldAdapter` starts
   * `geographic` provisionally and `loadMapDefinition()` corrects it — and
   * because the tool block sits ahead of everything volatile in the prompt, so
   * it must be *stable* rather than merely *correct*.
   */
  served() {
    return this.registry.serve(this.adapter.session());
  }

  /**
   * Route one utterance.
   *
   * @param {string} utterance
   * @returns {Promise<{layer: string, intent?: string, text: string, envelopes: object[],
   *   turnId: string, matches: object[], rounds: number}>}
   */
  async handle(utterance) {
    const ctx = this.context();
    const started = ctx.startedAt;
    const record = {
      turnId: ctx.turnId,
      utterance,
      layer: null,
      intent: undefined,
      matches: [],
      toolCalls: [],
      rounds: 0,
      latencyMs: 0,
      escalationReason: null,
    };

    const finish = (result) => {
      record.layer = result.layer;
      record.intent = result.intent;
      record.rounds = result.rounds || 0;
      record.latencyMs = ctx.now() - started;
      this.log?.(record);
      return result;
    };

    /* -- L0.1 control ------------------------------------------------------- */
    const l0 = matchL0(utterance);
    if (l0?.intent === 'control') {
      record.escalationReason = 'l0-control';
      // The speech layer only. Deliberately no adapter, no tool, no model: a
      // "stop" that takes a 1–3 s round trip is not a stop.
      return finish({
        layer: 'L0', intent: 'control', command: l0.command, text: '', envelopes: [], turnId: ctx.turnId, matches: [],
      });
    }

    /* -- L0.2 / L0.3 whats_here --------------------------------------------- */
    if (l0?.intent === 'whats_here') {
      const envelope = this.#whatsHereEnvelope(ctx);
      const text = narrateWhatsHere(envelope);
      record.toolCalls = [{ name: 'whats_here', ok: true, result: envelope }];
      record.escalationReason = envelope.source ? `l0-${envelope.source}` : 'l0-at';
      this.speak?.(text, { layer: 'L0', turnId: ctx.turnId });
      return finish({
        layer: 'L0', intent: 'whats_here', text, envelopes: [envelope], turnId: ctx.turnId, matches: [],
      });
    }

    /* -- L1 preprocessing (always, never a rung) ---------------------------- */
    const matches = await this.#candidates(utterance, ctx, record);
    record.matches = matches.map((m) => m.name);

    /* -- L3 ------------------------------------------------------------------ */
    if (!this.client) {
      record.escalationReason = 'no-client';
      return finish({
        layer: 'L3', text: '', envelopes: [], turnId: ctx.turnId, matches, rounds: 0,
        error: 'no_client',
      });
    }

    const served = this.served();
    const envelopes = [];
    const loop = await runToolLoop({
      client: this.client,
      messages: [
        { role: 'system', content: this.systemPrompt },
        // The rule is in the system prompt (stable, rides the KV prefix); the
        // DATA is in the user turn (volatile). Names are sanitised on their way
        // into the line-oriented candidate block, where a forged newline would
        // otherwise forge a candidate.
        { role: 'user', content: buildUserTurn(matches, utterance) },
      ],
      tools: served.tools,
      maxRounds: this.maxRounds,
      executeTool: async (name, args) => {
        const envelope = await this.registry.dispatch(name, args, ctx, {
          adapter: this.adapter,
          served,
        });
        envelopes.push(envelope);
        record.toolCalls.push({ name, args, ok: envelope.status !== 'error', result: envelope });
        return envelope;
      },
      onNarration: (text) => this.speak?.(text, { layer: 'L3', turnId: ctx.turnId }),
    });

    // Only if L1 did not already record something more specific: "no-index" and
    // "index-error" say why this turn was worse than it should have been, and
    // "not-l0" would bury that under a fact already visible in `layer`.
    record.escalationReason ??= l0 ? 'l0-miss' : 'not-l0';
    return finish({
      layer: 'L3',
      text: loop.text,
      envelopes,
      turnId: ctx.turnId,
      matches,
      rounds: loop.rounds,
      stopReason: loop.stopReason,
    });
  }

  /**
   * `whats_here` at L0, through the very same handler L3 would call.
   *
   * One handler, two entry points, is the point: the envelope exists on this
   * path not because L0 needs it but because when L3 calls `whats_here`
   * explicitly it must be told what is missing and why, or it invents the
   * adjacency half out of the candidate block.
   */
  #whatsHereEnvelope(ctx) {
    const base = {
      frame: this.adapter.frame,
      worldId: this.adapter.worldId,
      units: unitsFor(this.adapter),
      acuityCell: ctx.acuityCell ?? undefined,
    };
    try {
      const raw = whatsHere({}, ctx, { adapter: this.adapter });
      return makeResult({ ...base, ...raw, units: { ...base.units, ...(raw.units || {}) } });
    } catch (error) {
      return makeResult({
        ...base,
        status: 'error',
        tool: 'whats_here',
        error: 'tool_failed',
        message: String(error?.message || error),
      });
    }
  }

  /**
   * L1: the candidate shortlist.
   *
   * ⚠️ `reason: 'no-index'` means proceed with none. It must **never** trigger a
   * build: the index is 3,004 embeddings on map 885, and building one inside a
   * voice turn turns a 1–3 s answer into a minute of silence.
   */
  async #candidates(utterance, ctx, record) {
    if (!this.placeIndex?.resolve) return [];
    try {
      const { matches, reason } = await this.placeIndex.resolve(utterance, {
        worldId: ctx.worldId,
        windowId: ctx.windowId,
        k: CANDIDATE_K,
      });
      if (reason === 'no-index') record.escalationReason = 'no-index';
      // Sanitised here, at composition time, and nowhere earlier: `placeIndex`
      // embeds the raw text and escaping it upstream would corrupt the vectors.
      return (matches || []).map((m) => ({ ...m, name: sanitizeText(m.name) }));
    } catch (error) {
      record.escalationReason = `index-error:${error?.message || error}`;
      return [];
    }
  }
}

export default Dispatcher;
