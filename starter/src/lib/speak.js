/**
 * speak — milestone 5c's minimal speech path.
 *
 * This is the three lines that lived in `TactileExplorerGeneric.jsx:39`, lifted
 * so a second component tree can use them. Nothing more:
 *
 *   window.speechSynthesis.cancel();
 *   window.speechSynthesis.speak(new SpeechSynthesisUtterance(t));
 *
 * DELIBERATELY NOT A QUEUE. `lib/logic/announcementQueue.js` — the ported
 * `tts.py` priority / interrupt / category queue — already exists and replaces
 * this in milestone S. Rev 1 of the plan gated the first spoken output on that
 * milestone, which put the system's cheapest win behind its entire critical
 * path; §2.2 corrects that. So: cancel-then-speak, barge-in every time, and the
 * ordering problems stay unsolved until the queue arrives.
 *
 * What this module does owe the queue is a shape it can drop into. Milestone S
 * builds the queue with `speak(announcement)` / `cancel(announcement)`
 * callbacks and expects `finishCurrent()` when the utterance ends, so:
 *
 *   - `speak()` accepts a string OR anything with a `.text` — an
 *     `Announcement` passes through unchanged.
 *   - `speak(x, { onEnd })` wires `SpeechSynthesisUtterance.onend`, which is
 *     exactly where `finishCurrent()` goes.
 *   - `speak(x, { interrupt: false })` skips the cancel, because a queue
 *     serialises utterances itself and must not shoot down its own.
 *   - it returns whether the utterance actually started; a caller that gets
 *     `false` never receives `onEnd` and must not wait for it.
 *
 * MILESTONE S ADDED TWO THINGS AND CHANGED NOTHING ELSE:
 *
 *   - `speak(x, { onBoundary })` forwards `SpeechSynthesisUtterance.onboundary`'s
 *     `charIndex`. That is where `AnnouncementQueue.setSpokenIndex()` goes, and
 *     without it `togglePause()` can only resume from the start of a sentence —
 *     the ported queue's whole pause/resume feature is dead without a progress
 *     signal, and `boundary` is the only one a browser gives.
 *   - `speak(x, { rate, pitch, volume, lang, voice })` are passed through, so
 *     L0's "slower" / "louder" control words have something to act on.
 *
 * ⚠️ `onEnd` IS NOT A GUARANTEE. `speechSynthesis.speak()` is silently dropped
 * by engines that require a user gesture, and Chrome's synthesiser is known to
 * stall on long utterances; in both cases `onend` and `onerror` never fire. Any
 * queue that advances on `onEnd` alone therefore deadlocks on the first dropped
 * utterance. `speech/narrator.js` carries the watchdog that makes the contract
 * safe — see the note there. Do not build a second queue on this without one.
 *
 * PLATFORM-FREE AT MODULE SCOPE (§4 of the plan): `speechSynthesis` and
 * `SpeechSynthesisUtterance` are resolved off `globalThis` when a speaker is
 * *used*, never when this file is loaded, so it imports in Node and is covered
 * by `scripts/test_audiom_channel.mjs` against a fake synth.
 */

/**
 * @param {object} [options]
 * @param {{cancel: () => void, speak: (u: object) => void}} [options.synth]
 *   Defaults to `globalThis.speechSynthesis`, resolved per call.
 * @param {Function} [options.Utterance] Defaults to
 *   `globalThis.SpeechSynthesisUtterance`, resolved per call.
 * @param {(error: unknown) => void} [options.onError]
 */
export function createSpeaker(options = {}) {
  const { synth, Utterance, onError } = options;

  const getSynth = () => synth ?? globalThis.speechSynthesis ?? null;
  const getUtterance = () => Utterance ?? globalThis.SpeechSynthesisUtterance ?? null;

  /**
   * The text of a string, an `{ text }` object, or an `Announcement`.
   * @param {string|{text?: string}|null|undefined} input
   * @returns {string}
   */
  const textOf = (input) => {
    if (input == null) return '';
    if (typeof input === 'string') return input.trim();
    if (typeof input.text === 'string') return input.text.trim();
    return '';
  };

  /**
   * Stop whatever is being said.
   * @returns {boolean} Whether a synth was there to stop.
   */
  function cancel() {
    const s = getSynth();
    if (!s) return false;
    try { s.cancel(); return true; } catch (error) { onError?.(error); return false; }
  }

  /**
   * @param {string|{text?: string}} input
   * @param {object} [opts]
   * @param {boolean} [opts.interrupt=true]
   * @param {() => void} [opts.onEnd]
   * @param {(charIndex: number, event: object) => void} [opts.onBoundary]
   * @param {number} [opts.rate]
   * @param {number} [opts.pitch]
   * @param {number} [opts.volume]
   * @param {string} [opts.lang]
   * @param {object} [opts.voice]
   * @returns {boolean} Whether an utterance was started.
   */
  function speak(input, opts = {}) {
    const { interrupt = true, onEnd, onBoundary, rate, pitch, volume, lang, voice } = opts;
    const text = textOf(input);
    if (!text) return false;
    const s = getSynth();
    const U = getUtterance();
    if (!s || !U) return false;
    try {
      if (interrupt) s.cancel();
      const utterance = new U(text);
      // Only assign what the caller asked for: writing `undefined` onto a real
      // `SpeechSynthesisUtterance` sets rate to NaN rather than leaving the default.
      if (typeof rate === 'number') utterance.rate = rate;
      if (typeof pitch === 'number') utterance.pitch = pitch;
      if (typeof volume === 'number') utterance.volume = volume;
      if (typeof lang === 'string') utterance.lang = lang;
      if (voice) utterance.voice = voice;
      if (onEnd) {
        // Both paths must settle, or a queue built on `onEnd` stalls on the
        // first utterance the browser drops.
        utterance.onend = () => onEnd();
        utterance.onerror = () => onEnd();
      }
      if (onBoundary) {
        utterance.onboundary = (event) => {
          const index = event?.charIndex;
          onBoundary(Number.isFinite(index) ? index : 0, event);
        };
      }
      s.speak(utterance);
      return true;
    } catch (error) {
      onError?.(error);
      return false;
    }
  }

  return {
    speak,
    cancel,
    textOf,
    /** @returns {boolean} Whether this environment can speak at all. */
    isAvailable: () => Boolean(getSynth() && getUtterance()),
  };
}

/** @type {ReturnType<typeof createSpeaker>|null} */
let current = null;

/**
 * The process-wide speaker, created on first use so nothing touches the DOM at
 * import time.
 * @returns {ReturnType<typeof createSpeaker>}
 */
export function getSpeaker() {
  if (!current) current = createSpeaker();
  return current;
}

/**
 * Replace the process-wide speaker — the seam milestone S swaps the
 * `AnnouncementQueue` in through, and how the Node checks inject a fake synth.
 * Pass null to reset.
 * @param {ReturnType<typeof createSpeaker>|null} speaker
 */
export function setSpeaker(speaker) {
  current = speaker;
}

/**
 * Say something, interrupting whatever is in progress.
 * @param {string|{text?: string}} text
 * @param {{interrupt?: boolean, onEnd?: () => void}} [options]
 * @returns {boolean}
 */
export const speak = (text, options) => getSpeaker().speak(text, options);

/**
 * Stop speaking.
 * @returns {boolean}
 */
export const cancelSpeech = () => getSpeaker().cancel();
