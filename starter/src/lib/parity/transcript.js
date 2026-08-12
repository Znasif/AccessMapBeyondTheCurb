/**
 * The recorded STT transcript, replayed.
 *
 * ## Why STT is replayed and not re-executed
 *
 * The plan's pipeline is **audio → STT → l1 → l3**, and the JS arm cannot run
 * the middle step. Web Speech `SpeechRecognition` captures the default input
 * device: it takes no `MediaStream`, no `AudioBuffer`, no file. A WAV cannot be
 * fed to it without OS-level audio loopback, which is not a thing a benchmark
 * may require of the machine running it. The Python arm did not use Web Speech
 * either — it POSTed each WAV to `tools/macos_stt/stt_server.py`, which is
 * Apple's on-device `SFSpeechRecognizer` biased with 50 POI-name hints.
 *
 * So the recognizer's actual output is replayed out of the recorded run. Every
 * turn of `benchmark/results/arm1_curated_stt/parity_20260805_194151.json`
 * carries both strings:
 *
 *   `turns[].utterance`                    what Apple heard  → **heard** pass
 *   `turns[].spoken.reference_utterance`   the clean text    → **clean** pass
 *
 * plus `stt_sec`, `hints: 50`, `wer_errors` and `wer_words`, which are carried
 * through untouched so the emitted JSON keeps the Python's `spoken` block and
 * `compare_arms.py`'s WER column still works.
 *
 * Running both passes is what separates two questions that are otherwise
 * confounded. The **heard** pass keeps real recognition errors in the pipeline
 * — "soul spa" for "Solle Spa", "go by tax" for "go by taxi", a hallucinated
 * leading "Siri" on `NY-S4` — and is the arm that compares like-for-like against
 * `arm1_curated_stt`. The **clean** pass compares against
 * `arm1_curated_stt_text` and answers "is any gap STT's fault or ours".
 *
 * ⚠️ The heard text is **fixed**, which is a real limit on what this measures:
 * it is Apple's recognizer, not Chrome's on-device recognizer, and the WER a
 * browser session would actually produce is not measured anywhere yet. What is
 * measured is the JS stack's behaviour given the same words the Python stack
 * got, which is the variable this benchmark is isolating.
 *
 * Platform-free: the JSON arrives parsed.
 */

/** Which string a pass feeds to L1 and L3. */
export const INPUT = Object.freeze({
  /** What the recognizer heard. Compare against `arm1_curated_stt`. */
  HEARD: 'heard',
  /** The written reference. Compare against `arm1_curated_stt_text`. */
  CLEAN: 'clean',
});

/**
 * Read a recorded parity run into the case/turn shape the runner drives.
 *
 * @param {object} recorded  parsed `parity_<ts>.json`
 * @param {object} [options]
 * @param {object} [options.benchmark] parsed `mapio_benchmark.json`, used only to
 *   recover `grading_notes` when the recorded run predates them.
 * @returns {{source: object, cases: object[], turnCount: number}}
 */
export function loadRecordedTranscript(recorded, { benchmark } = {}) {
  if (!recorded || !Array.isArray(recorded.results)) {
    throw new Error('loadRecordedTranscript: expected a parity run with a `results` array');
  }

  const notesById = new Map();
  for (const c of benchmark?.cases || []) {
    for (const t of c.turns || [c]) {
      if (t.grading_notes) notesById.set(t.id || c.id, t.grading_notes);
    }
  }

  const cases = recorded.results.map((c) => ({
    id: c.id,
    map: c.map,
    turns: (c.turns || []).map((t) => {
      const spoken = t.spoken || null;
      return {
        id: t.id,
        category: t.category,
        position: t.position ?? null,
        /** What the recognizer produced. `utterance` in the recorded run. */
        heard: t.utterance,
        /** The written reference the WER was scored against. */
        clean: spoken?.reference_utterance ?? t.utterance,
        // Carried verbatim so the emitted `spoken` block is the recorded one:
        // wav path, stt_sec, hints, wer_errors, wer_words, wer_pct.
        spoken,
        gradingNotes: t.grading_notes || notesById.get(t.id) || '',
      };
    }),
  }));

  return {
    source: {
      timestamp: recorded.timestamp,
      label: recorded.label,
      model: recorded.model,
      server: recorded.server,
      formatter: recorded.formatter,
      benchmark: recorded.benchmark,
    },
    cases,
    turnCount: cases.reduce((n, c) => n + c.turns.length, 0),
  };
}

/**
 * Pick the utterance for a pass.
 *
 * @param {object} turn
 * @param {'heard'|'clean'} input
 * @returns {string}
 */
export function utteranceFor(turn, input) {
  if (input === INPUT.CLEAN) return turn.clean;
  if (input === INPUT.HEARD) return turn.heard;
  throw new Error(`utteranceFor: unknown input ${JSON.stringify(input)} (expected heard|clean)`);
}

/**
 * The `spoken` block to emit for a pass.
 *
 * On the **clean** pass the recorded WER is *not* carried through: the words
 * being sent are the reference, so the errors did not happen on this run and
 * reporting them would misattribute Apple's mistakes to a pass that never made
 * them. `sent_as: 'reference_text'` is the marker, matching what
 * `run_arms.py --no-audio` means by "the manifest still limits the run to
 * recorded turns, so it isolates what STT costs".
 *
 * @param {object} turn
 * @param {'heard'|'clean'} input
 */
export function spokenFor(turn, input) {
  if (!turn.spoken) return null;
  if (input === INPUT.HEARD) return { ...turn.spoken, sent_as: 'transcript', replayed: true };
  return {
    wav: turn.spoken.wav,
    reference_utterance: turn.spoken.reference_utterance,
    sent_as: 'reference_text',
    replayed: true,
    // Kept for provenance — this is what the recognizer HAD produced for this
    // turn — but explicitly not scored on this pass.
    recorded_transcript: turn.heard,
    recorded_wer_errors: turn.spoken.wer_errors,
    recorded_wer_words: turn.spoken.wer_words,
  };
}

/**
 * Word error rate, ignoring case and punctuation. Levenshtein over words.
 *
 * A JS transliteration of `run_parity_benchmark.py#word_error_rate`, including
 * its `[\w']+` tokenisation — the ASCII-only class it replaced split "café" into
 * "caf" and scored a diacritic as a substitution, on POI names, which is exactly
 * where the metric is supposed to be trustworthy. Unused by the replay passes
 * (the numbers come off the recorded run) and present so a future pass that
 * really does run STT can score itself the same way.
 *
 * @param {string} reference @param {string} hypothesis
 * @returns {{errors: number, words: number}}
 */
export function wordErrorRate(reference, hypothesis) {
  const words = (s) => String(s ?? '').toLowerCase().match(/[\p{L}\p{N}']+/gu) || [];
  const r = words(reference);
  const h = words(hypothesis);

  let previous = Array.from({ length: h.length + 1 }, (_, j) => j);
  for (let i = 1; i <= r.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= h.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return { errors: previous[h.length], words: r.length };
}

export default loadRecordedTranscript;
