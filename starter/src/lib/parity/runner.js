/**
 * The parity runner — platform-free, one implementation, two platforms.
 *
 * `scripts/parity_js.mjs` runs it in Node against the HTTP router;
 * `explore/wllama-spike/parity.html` runs the *same module* in a tab against
 * wllama. The only things that differ are injected: the `LocalLLMClient`
 * (`createLLMClient({ backend: 'http' | 'wllama' })` — the seam §1.1 exists for),
 * the parsed model JSONs, and where the result object is written. There is no
 * `fs`, no `fetch`, no `process` and no DOM below this line, and no per-platform
 * fork of the loop.
 *
 * ## What it drives
 *
 * The shipped stack, in the order the plan names it:
 *
 *   `placeIndex.resolve()`               L1, k=8
 *   `candidateContext.buildSystemPrompt` stable half — briefing + tools
 *   `candidateContext.buildUserTurn`     volatile half — candidates + position + utterance
 *   `toolFilter.filterTools` (via `ToolRegistry.serve`)
 *   `LocalLLMClient.chatCompletion`
 *   `toolLoop.runToolLoop`
 *   `toolRegistry.dispatch` → the six M7 tools + the three harness tools
 *
 * ## What it does NOT drive, and why
 *
 * **`Dispatcher`.** It is stateless by construction — `handle()` builds
 * `[system, user]` fresh every call — and one of the 18 cases is a nine-turn
 * conversation whose task 3 ("remember the hotel as 'my hotel'") has to survive
 * to task 9. The Python keeps `LLM.history` across a case and `reset()`s between
 * cases; this does the same by threading `runToolLoop`'s returned `messages`
 * forward, which is append-only and therefore keeps the KV prefix intact (§6.1).
 * `Dispatcher`'s L0 rungs are also absent from the Python, so bypassing them
 * keeps the two arms comparable rather than giving the JS arm a free templated
 * answer the Python had to reason for.
 *
 * ## History roll-back on a failed turn
 *
 * Straight from `run_parity_benchmark.py`: a turn that throws is rolled out of
 * the history entirely, so one context overflow does not cascade through the
 * remaining eight turns of `DT-SESSION` and turn one bad grade into nine.
 */

import { runToolLoop } from '../toolLoop.js';
import { buildUserTurn } from '../candidateContext.js';
import { createTurnContext, resetTurnIds } from '../turnContext.js';
import { TIER } from '../localLLM.js';
import { INPUT, utteranceFor, spokenFor } from './transcript.js';
import { resolvePositionSpec, positionBlock } from './world.js';

/** The paper's six grade classes, in the Python's order. Emitted verbatim. */
export const GRADES = Object.freeze([
  'deceptively_wrong',
  'not_replying',
  'blatantly_wrong',
  'partial_incomplete',
  'correct_not_optimal',
  'correct',
]);

/** The bar every graded run is scored against. Copied string for string. */
export const GPT4O_BAR =
  '94.74% correct + 5.26% correct_not_optimal (paper Table 4, iteration 8, New York map)';

/** Candidates per question. The Python arm's `--k 8`, so the arms see the same shortlist depth. */
export const DEFAULT_K = 8;

/**
 * Run every case, one map at a time.
 *
 * @param {object} params
 * @param {object[]} params.cases        from `loadRecordedTranscript()`
 * @param {(mapName: string) => Promise<object>} params.getWorld  memoised by the caller
 * @param {object} params.client         `LocalLLMClient`
 * @param {'heard'|'clean'} [params.input]
 * @param {number} [params.k]
 * @param {string} [params.model]        tier name; `l3` on the router
 * @param {number} [params.maxRounds]
 * @param {boolean} [params.warmup]      prime the prefix before the first turn
 * @param {(e: object) => void} [params.onEvent]
 * @param {() => number} [params.now]
 * @returns {Promise<{results: object[], warmupSec: number|null, worlds: object[]}>}
 */
export async function runParityBenchmark({
  cases,
  getWorld,
  client,
  input = INPUT.HEARD,
  k = DEFAULT_K,
  model = TIER.REASON,
  maxRounds,
  warmup = true,
  onEvent,
  now = () => Date.now(),
} = {}) {
  if (!Array.isArray(cases) || !cases.length) throw new Error('runParityBenchmark: `cases` is required');
  if (!client?.chatCompletion) throw new Error('runParityBenchmark: a LocalLLMClient is required');
  if (typeof getWorld !== 'function') throw new Error('runParityBenchmark: `getWorld` is required');

  resetTurnIds();

  // Grouped by map, in first-appearance order, exactly as the Python groups
  // them: building a world is a Floyd–Warshall plus 50 embeddings.
  const byMap = new Map();
  for (const c of cases) {
    if (!byMap.has(c.map)) byMap.set(c.map, []);
    byMap.get(c.map).push(c);
  }

  const results = [];
  const worldSummaries = [];
  let warmupSec = null;
  let warmupPending = warmup;

  for (const [mapName, mapCases] of byMap) {
    const world = await getWorld(mapName);
    worldSummaries.push({
      map: mapName,
      worldId: world.adapter.worldId,
      frame: world.adapter.frame,
      capabilities: [...world.adapter.capabilities],
      tools: world.served.tools.map((t) => t.function.name),
      withheld: world.withheld,
      harnessTools: world.harnessTools,
      briefingChars: world.briefing.length,
      systemPromptChars: world.systemPrompt.length,
    });
    onEvent?.({ type: 'world', ...worldSummaries[worldSummaries.length - 1] });

    for (const benchCase of mapCases) {
      /** Reset per case — `llm.reset()`. */
      let history = [{ role: 'system', content: world.systemPrompt }];

      // ⚠️ Two things are load-bearing here, both learned the expensive way by
      // `LLM.warm_up` (`llm.py:163`) and both easy to get wrong:
      //
      //   1. Warm AFTER the history is built, never before. A prefix warmed
      //      against a message the session then discards shares nothing with
      //      the turns that follow.
      //   2. **Send `tools`.** llama.cpp renders the tool definitions into the
      //      prompt via the chat template, so a warm-up that omits them primes
      //      a different prefix and caches nothing for the real turns —
      //      measured in the Python as "4205 tokens primed, cached=0 on the
      //      turn that followed". The tool block is ~1,330 tokens here, well
      //      over a third of the prefix.
      if (warmupPending) {
        warmupPending = false;
        const t0 = now();
        try {
          await client.chatCompletion({
            messages: [...history, { role: 'user', content: 'ready' }],
            tools: world.served.tools,
            model,
            maxTokens: 1,
          });
          warmupSec = round2((now() - t0) / 1000);
          onEvent?.({ type: 'warmup', seconds: warmupSec });
        } catch (error) {
          // Safe to skip: failing only costs latency on the first question.
          onEvent?.({ type: 'warmup-failed', message: String(error?.message || error) });
        }
      }

      const caseResult = { id: benchCase.id, map: mapName, turns: [] };

      for (const turn of benchCase.turns) {
        const record = await runTurn({
          world, turn, history, client, input, k, model, maxRounds, onEvent, now,
        });
        caseResult.turns.push(record.turn);
        history = record.history;
      }

      results.push(caseResult);
    }
  }

  return { results, warmupSec, worlds: worldSummaries };
}

/**
 * One turn: L1 → prompt → tool loop → record.
 *
 * @returns {Promise<{turn: object, history: object[]}>}
 */
async function runTurn({ world, turn, history, client, input, k, model, maxRounds, onEvent, now }) {
  const { adapter, registry, served, surface, placeIndex, graph, routeLog } = world;
  const utterance = utteranceFor(turn, input);

  routeLog.length = 0;
  // The memo is keyed on `acuityCell`, which the surface makes vary with the
  // position; clearing it per turn costs nothing here and removes any doubt
  // about a cached answer crossing a position change. See `world.js`.
  registry.clearMemo();

  let position = null;
  let positionError = null;
  try {
    position = resolvePositionSpec(graph, turn.position);
  } catch (error) {
    positionError = String(error?.message || error);
  }

  const uv = position ? adapter.coordsToUv(position.coords) : null;
  const ctx = createTurnContext({
    adapter,
    surface,
    sources: {
      uv: () => uv,
      window: () => adapter.bbox,
      now,
    },
    session: { tier: 'A' },
  });

  /* -- L1 ----------------------------------------------------------------- */
  const l1Started = now();
  let matches = [];
  let l1Reason = 'ok';
  try {
    const resolved = await placeIndex.resolve(utterance, {
      worldId: ctx.worldId,
      windowId: ctx.windowId,
      k,
    });
    matches = resolved.matches || [];
    l1Reason = resolved.reason;
  } catch (error) {
    l1Reason = `index-error:${error?.message || error}`;
  }
  const l1Ms = now() - l1Started;

  /* -- the user turn ------------------------------------------------------- */
  const userContent = buildUserTurn(matches, `${positionBlock(world, position)}${utterance}`);
  const messages = [...history, { role: 'user', content: userContent }];
  const historyStart = history.length;

  onEvent?.({ type: 'turn-start', id: turn.id, utterance, position: turn.position, candidates: matches.map((m) => m.name) });

  /* -- L3 ------------------------------------------------------------------ */
  const envelopes = [];
  const t0 = now();
  let loop = null;
  let failure = null;
  try {
    loop = await runToolLoop({
      client,
      messages,
      tools: served.tools,
      model,
      maxRounds,
      executeTool: async (name, args) => {
        const envelope = await registry.dispatch(name, args, ctx, { adapter, served });
        envelopes.push({ name, args, envelope });
        return envelope;
      },
    });
  } catch (error) {
    failure = { error: String(error?.message || error) };
  }
  const elapsed = now() - t0;

  const usage = loop?.usage || [];
  const last = usage.length ? usage[usage.length - 1] : null;

  // `toolLoop` catches an unparseable `arguments` string and feeds it back as a
  // tool result rather than throwing, which is the behaviour the Python's
  // `json.JSONDecodeError` branch had to work around. The event still deserves a
  // slot in the record — a model that does this once in nine turns is
  // disqualified regardless of how fast it is.
  const malformed = (loop?.toolCalls || [])
    .filter((c) => c.result?.error === 'invalid_arguments')
    .map((c) => ({ name: c.name, error: c.result.message, arguments: c.result.received }));

  const record = {
    id: turn.id,
    utterance,
    spoken: spokenFor(turn, input),
    category: turn.category,
    position: turn.position,
    answer: failure ? null : loop.text,
    malformed_tool_call: malformed.length ? malformed[0] : null,
    elapsed_sec: round2(elapsed / 1000),
    // MapIO's `guide_calls`, produced by the harness `route_to` handler, and
    // `routes` — the waypoints navigation would have received. Same two keys
    // `--routing local` writes.
    guide_calls: routeLog.map((entry) => entry.guide),
    routes: routeLog.filter((entry) => entry.route).map((entry) => ({
      action: entry.route.error ? 'ERROR' : 'ON_ROUTE',
      street_by_street: entry.route.streetByStreet ?? entry.guide.street_by_street,
      waypoints: entry.route.waypoints || null,
    })),
    usage_last_round: last,
    rounds: usage.map((u) => ({
      prompt_tokens: u?.prompt_tokens ?? null,
      completion_tokens: u?.completion_tokens ?? null,
      cached_tokens: u?.prompt_tokens_details?.cached_tokens ?? null,
      timings: null,
    })),
    transcript: extractTranscript(loop?.messages || messages, historyStart),
    grading_notes: turn.gradingNotes || '',
    // Post-hoc, always. `run_parity_benchmark.py` writes null here and a
    // `_graded.md` is produced later by a human against the six classes; this
    // produces transcripts with grade slots, not accuracy numbers.
    grade: null,
    /** JS-arm extras. Ignored by `compare_arms.py`; read by the harness tests. */
    js: {
      l1_ms: l1Ms,
      l1_reason: l1Reason,
      candidates: matches.map((m) => m.name),
      rounds: loop?.rounds ?? 0,
      stop_reason: loop?.stopReason ?? 'error',
      tool_results: envelopes.map((e) => ({
        name: e.name,
        args: e.args,
        status: e.envelope?.status,
        error: e.envelope?.error,
      })),
      position_error: positionError,
      error: failure?.error ?? null,
    },
  };

  onEvent?.({ type: 'turn-end', id: turn.id, seconds: record.elapsed_sec, answer: record.answer, calls: record.js.tool_results });

  return {
    turn: record,
    // A failed turn is rolled all the way out: the next turn of this case sees
    // the history it would have seen had this one never run.
    history: failure ? history : loop.messages,
  };
}

/**
 * A serializable view of the conversation appended since `start`.
 *
 * Shape-for-shape with `run_parity_benchmark.py#extract_transcript`, because
 * `compare_arms.py` reads `turn['transcript'][*]['tool_calls'][*]['name']` and
 * `['arguments']` and must keep working unchanged.
 *
 * @param {object[]} messages
 * @param {number} start
 */
export function extractTranscript(messages, start) {
  const out = [];
  for (const message of messages.slice(start)) {
    const entry = { role: message.role };
    if (message.content) entry.content = message.content;
    for (const call of message.tool_calls || []) {
      const fn = call.function || call;
      (entry.tool_calls ||= []).push({ name: fn.name, arguments: fn.arguments });
    }
    out.push(entry);
  }
  return out;
}

const round2 = (n) => Math.round(n * 100) / 100;

export default runParityBenchmark;
