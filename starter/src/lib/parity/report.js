/**
 * The output files, in the Python's shape.
 *
 * `browser-voice-exploration-plan.md` §6 says three harnesses already exist and
 * not to invent a fourth. That rule binds hardest here: the value of this run is
 * that it lands beside the Python's runs and is read by the same two tools.
 *
 *   `benchmark/compare_arms.py`   reads `results[].turns[]` — `id`,
 *                                 `elapsed_sec`, `answer`, `spoken.*`,
 *                                 `rounds[0].{prompt_tokens,cached_tokens}` and
 *                                 `transcript[].tool_calls[].{name,arguments}`
 *   the grading flow              reads the `.md`, one section per turn, ending
 *                                 in a blank `**Grade:**` line, and a human
 *                                 writes `parity_<ts>_graded.md` beside it
 *
 * So every key the Python writes is written, with the same name and the same
 * type, including the ones that are constants on this arm (`formatter`,
 * `routing`, `prompt`). JS-only facts go in additive keys — `arm`, `backend`,
 * `stack`, `harness_tools`, `worlds`, and `turns[].js` — which both readers
 * ignore.
 *
 * `grade` stays `null` on every turn. Grading is post-hoc and human; this
 * produces transcripts with grade slots, never accuracy numbers.
 *
 * Platform-free: returns strings, writes nothing.
 */

import { GRADES, GPT4O_BAR } from './runner.js';

/** `YYYYMMDD_HHMMSS`, local time, matching `datetime.now().strftime`. */
export function timestampOf(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}_`
    + `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

/**
 * Assemble the run object written as `parity_<ts>.json`.
 *
 * @param {object} params
 * @param {object[]} params.results     `runParityBenchmark()` output
 * @param {string} params.label         arm folder name
 * @param {string} params.arm
 * @param {string} params.model
 * @param {string} params.server        base URL, or `wllama:<profile>` in a tab
 * @param {string} params.backend       `http` | `wllama`
 * @param {number} params.k
 * @param {'heard'|'clean'} params.input
 * @param {number|null} [params.warmupSec]
 * @param {object[]} [params.worlds]
 * @param {string[]} [params.harnessTools]
 * @param {string} [params.timestamp]
 * @param {object} [params.transcriptSource] the recorded run being replayed
 * @param {object} [params.extra] additive top-level keys — the browser arm puts
 *        its environment, load time and footprint here
 * @returns {object}
 */
export function buildRunRecord({
  results,
  label,
  arm,
  model,
  server,
  backend,
  k,
  input,
  warmupSec = null,
  worlds = [],
  harnessTools = [],
  timestamp = timestampOf(),
  transcriptSource,
  extra = {},
}) {
  return {
    timestamp,
    label,
    server,
    model,
    k,
    // Constants on this arm, written because the Python writes them and
    // `compare_arms.py` prints them in its header line.
    formatter: 'curated',
    routing: 'local',
    // ⚠️ `text`, not `audio`, and the distinction matters: the Python's
    // `--input audio` sends the WAV to the model as an `input_audio` part. This
    // arm always sends text. Which text — heard or clean — is `stt_input`.
    input: 'text',
    prompt: 'candidateContext.js',
    benchmark: transcriptSource?.label
      ? `replay:${transcriptSource.label}/${transcriptSource.timestamp}`
      : 'replay',
    warmup_sec: warmupSec,
    // Apple's 50 POI-name hints were used when this transcript was recorded.
    stt_hints: true,
    grades: GRADES,
    gpt4o_bar: GPT4O_BAR,

    /* -- additive, JS-arm only ------------------------------------------- */
    arm,
    backend,
    stt: 'replayed',
    stt_input: input,
    stt_source: transcriptSource || null,
    harness_tools: harnessTools,
    stack: [
      'placeIndex.js',
      'candidateContext.js',
      'toolFilter.js',
      'localLLM.js',
      'toolLoop.js',
      'toolRegistry.js',
      'tools/*.js',
      'logic/graph.js',
      'parity/mapioAdapter.js',
    ],
    worlds,
    ...extra,

    results,
  };
}

/**
 * The human-gradable Markdown, section for section with the Python's writer.
 *
 * @param {object} run  `buildRunRecord()` output
 * @returns {string}
 */
export function buildRunMarkdown(run) {
  const out = [];
  out.push(
    `# MapIO parity run ${run.timestamp}\n\n`
    + `Model: \`${run.model}\` at \`${run.server}\`, k=${run.k}\n\n`
    + `Grade each answer with one of: ${GRADES.join(', ')}\n`
    + `(GPT-4o bar: 94.74% correct + 5.26% correct_not_optimal)\n`,
  );

  // The one deviation from the Python's header, and it is not decoration: a
  // grader has to know that three of the answered tools are harness-supplied
  // and that the words came from a replayed recogniser, or the grades mean
  // something other than what they say.
  out.push(
    `\nArm \`${run.arm}\` — backend \`${run.backend}\`, STT ${run.stt} (\`${run.stt_input}\`).`
    + (run.harness_tools?.length
      ? ` Harness-supplied tools: ${run.harness_tools.map((t) => `\`${t}\``).join(', ')}.`
      : '')
    + '\n',
  );

  for (const runCase of run.results) {
    for (const turn of runCase.turns) {
      out.push(`\n---\n\n## ${turn.id}  (${turn.category}, ${runCase.map})\n\n`);
      out.push(`**Q:** ${turn.utterance}\n\n`);
      const spoken = turn.spoken;
      if (spoken) {
        if (spoken.sent_as === 'transcript') {
          out.push(
            `**Heard from** \`${spoken.wav}\` in ${spoken.stt_sec}s, `
            // `toFixed(1)` because Python renders `0.0` and `JSON.parse` gives
            // the number 0 — the same figure spelled two ways in two files a
            // grader reads side by side.
            + `WER ${spoken.wer_errors}/${spoken.wer_words} = ${Number(spoken.wer_pct).toFixed(1)}% `
            + `(${spoken.hints} hints), replayed\n\n`,
          );
        } else {
          out.push(`**Sent** the written reference for \`${spoken.wav}\`, no STT in the path\n\n`);
        }
        out.push(`**Reference:** ${spoken.reference_utterance}\n\n`);
      }
      if (turn.position) out.push(`**Position:** \`${JSON.stringify(turn.position)}\`\n\n`);

      const calls = [];
      for (const message of turn.transcript || []) {
        for (const call of message.tool_calls || []) calls.push(`\`${call.name}(${call.arguments})\``);
      }
      if (calls.length) out.push(`**Tool calls:** ${calls.join(', ')}\n\n`);

      if (turn.routes?.length) {
        for (const route of turn.routes) {
          const steps = (route.waypoints || []).map((w) => `  - ${w.instructions}`).join('\n');
          out.push(
            `**Route (${route.action}, ${route.street_by_street ? 'street-by-street' : 'fly-me-there'}):**\n`
            + `${steps || '  - (none)'}\n\n`,
          );
        }
      }

      out.push(`**A (${turn.elapsed_sec}s):** ${turn.answer}\n\n`);
      out.push(`**Notes:** ${turn.grading_notes}\n\n`);
      out.push('**Grade:** \n');
    }
  }

  return out.join('');
}

/**
 * The console summary. Deliberately not accuracy: a run reports latency, tool
 * calls and failures, and a human supplies the grades afterwards.
 *
 * @param {object} run
 * @returns {string}
 */
export function summarise(run) {
  const turns = run.results.flatMap((c) => c.turns);
  const elapsed = turns.reduce((n, t) => n + (t.elapsed_sec || 0), 0);
  const silent = turns.filter((t) => !t.answer).length;
  const malformed = turns.filter((t) => t.malformed_tool_call).length;
  const withCalls = turns.filter((t) => (t.transcript || []).some((m) => m.tool_calls?.length)).length;
  const routed = turns.filter((t) => t.routes?.length).length;
  const maxRounds = turns.filter((t) => t.js?.stop_reason === 'max_rounds').length;

  const prompts = turns.flatMap((t) => t.rounds || []).map((r) => r.prompt_tokens).filter(Number.isFinite);
  const cached = turns.flatMap((t) => t.rounds || []).map((r) => r.cached_tokens).filter(Number.isFinite);

  return [
    `${run.arm}  ${turns.length} turns  ${elapsed.toFixed(1)}s total  `
      + `${(elapsed / Math.max(turns.length, 1)).toFixed(1)}s/turn`,
    `  tool calls on ${withCalls}/${turns.length} turns · ${routed} produced a route`,
    `  ${silent} silent · ${malformed} malformed tool calls · ${maxRounds} hit the round budget`,
    prompts.length
      ? `  prompt tokens ${Math.min(...prompts)}–${Math.max(...prompts)}`
        + (cached.length ? ` · cached up to ${Math.max(...cached)}` : ' · no cache figures')
      : '  no usage figures returned',
    '  grades are POST-HOC: grade the .md, then write parity_<ts>_graded.md beside it',
  ].join('\n');
}

export default buildRunRecord;
