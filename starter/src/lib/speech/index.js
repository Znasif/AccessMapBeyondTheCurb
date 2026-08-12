/**
 * Milestone S — speech in and speech out.
 *
 * Two halves that meet in exactly one place, `linkBargeIn`:
 *
 *   recognizer.js  `SpeechRecognition`, Chrome-first with `processLocally`,
 *                  feature-detected, with a *visible* notice whenever audio
 *                  would leave the machine.
 *   narrator.js    `speechSynthesis` driven by `logic/announcementQueue.js` —
 *                  the ported `tts.py` — plus the watchdog and turn gating a
 *                  browser needs and pyttsx3 did not.
 *   sentences.js   segmentation, so narration starts on the first sentence
 *                  instead of after the last token.
 *
 * Platform-free ES modules, no platform imports, runnable in Node. See
 * `scripts/test_speech.mjs`.
 */

export {
  createRecognizer,
  readResult,
  buildPhrases,
  RecognizerState,
  SttMode,
  Availability,
  NoticeCode,
  ERROR_DISPOSITION,
  RESTART_DELAY_MS,
} from './recognizer.js';

export {
  createNarrator,
  estimateSpeechMs,
  watchdogMs,
  LAYER_CATEGORY,
  CATEGORY_PRIORITY,
  ERROR_INTERVAL_S,
  RATE_MIN,
  RATE_MAX,
  RATE_STEP,
  VOLUME_STEP,
  DEFAULT_RATE,
} from './narrator.js';

export {
  splitSentences,
  createSentenceSplitter,
  ABBREVIATIONS,
} from './sentences.js';

/**
 * Wire a recogniser's barge-in to a narrator, and the narrator's speaking state
 * back to the recogniser.
 *
 * Two couplings, and they pull in opposite directions:
 *
 *  - **Barge-in.** The user starts talking, so narration must stop. Design §10
 *    files stale narration under safety: a description of somewhere the finger
 *    has left is worse than silence.
 *  - **Echo.** ⚠️ With a loudspeaker and an open microphone, the recogniser
 *    hears our own `speechSynthesis` output and reports it as the user speaking.
 *    Barge-in wired naively to `speechstart` therefore silences the app the
 *    instant it opens its mouth, then transcribes what it just said as a
 *    command. Neither doc mentions this; it is the reason `bargeInOnSpeech`
 *    defaults to false and push-to-talk is the default interaction.
 *
 * `mode: 'button'` (default) is the safe pairing: the microphone is only open
 * while the user holds it, and pressing it is itself the barge-in — no echo path
 * exists. `mode: 'voice'` enables acoustic barge-in and is only correct on a
 * headset; it additionally suspends the microphone while the narrator speaks,
 * which is the best a browser can do without an echo canceller.
 *
 * @param {ReturnType<import('./recognizer.js').createRecognizer>} recognizer
 * @param {ReturnType<import('./narrator.js').createNarrator>} narrator
 * @param {{mode?: 'button'|'voice'}} [options]
 * @returns {{start: () => boolean, stop: () => boolean, dispose: () => void}}
 */
export function linkBargeIn(recognizer, narrator, options = {}) {
  const { mode = 'button' } = options;

  if (mode === 'voice') {
    recognizer.setHandlers({ onSpeechStart: () => narrator.stopSpeaking() });
  }

  return {
    /** Open the microphone. Call from a user gesture — it arms the narrator too. */
    start() {
      narrator.arm();
      // Pressing the button IS the barge-in: whatever is being said is now stale
      // by the user's own judgement.
      narrator.stopSpeaking();
      return recognizer.start();
    },
    stop() { return recognizer.stop(); },
    dispose() {
      if (mode === 'voice') recognizer.setHandlers({ onSpeechStart: undefined });
    },
  };
}
