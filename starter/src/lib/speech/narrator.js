/**
 * Speech out — milestone S, half two.
 *
 * `lib/logic/announcementQueue.js` is MapIO's `tts.py` with pyttsx3 removed:
 * categories, priorities, interrupts, per-category timestamps, pause/resume of a
 * part-spoken utterance. It was written in milestone P with two holes deliberately
 * left in it — `speak(announcement)` and `cancel(announcement)` are injected, and
 * completion is reported back with `finishCurrent()`. This file fills those holes
 * with `speechSynthesis`, and adds the three things a browser needs that a
 * pyttsx3 loop thread did not.
 *
 * ## 1. A watchdog, because `onend` is not a guarantee
 *
 * ⚠️ **This is the finding that shapes the module.** The ported queue advances
 * only when `finishCurrent()` is called, and the plan assumed
 * `SpeechSynthesisUtterance.onend` would always call it. It does not:
 *
 *   - engines that gate audio on a user gesture drop `speak()` **silently** —
 *     no `onend`, no `onerror`, no exception, and `speechSynthesis.speaking`
 *     stays false;
 *   - Chrome's synthesiser stalls on long utterances and never fires `onend`;
 *   - `cancel()` racing a queued utterance can swallow both events.
 *
 * Any one of those deadlocks a queue built on `onend` alone — permanently, on the
 * *first* occurrence, with every later announcement stuck behind it. In an
 * accessibility tool that is not a glitch, it is the app going mute. So every
 * utterance carries a timer sized to its own text, and whichever of `onend` and
 * the watchdog arrives first settles it. Both route through one idempotent
 * `settle(token)`, because a watchdog that fires late and then sees the real
 * `onend` would otherwise end the *next* announcement early.
 *
 * ## 2. Turn gating, because stale narration is a safety issue
 *
 * Design doc §10 and plan §8 both file stale narration under safety, not noise:
 * a finger sweeping a map outruns a 1–3 s model, so an answer that arrives after
 * the user has moved on describes somewhere they are no longer touching. The
 * queue cannot see this — it has no concept of a turn. So the narrator holds
 * `currentTurnId`, and:
 *
 *   - a first utterance for a **new** turn preempts (`stopAndSay`), clearing
 *     everything the previous turn had queued but not yet said;
 *   - later utterances for the **same** turn queue in order, which is what makes
 *     sentence-at-a-time streaming (§3) sound like one answer;
 *   - an utterance for a **retired** turn is dropped and counted.
 *
 * That last rule is the one that matters. Without it, a slow L3 reply to
 * question 1 arrives after question 2 has been answered and speaks over it.
 *
 * ## 3. Sentence streaming, the mitigation both risk registers name
 *
 * `narrateStream()` feeds `sentences.js` and says each sentence the moment it is
 * complete, so speech begins about one sentence into generation rather than
 * after it. Same turn, so the sentences queue rather than interrupt each other.
 *
 * ## What is deliberately NOT used
 *
 * `speechSynthesis.pause()` / `.resume()`. The ported queue implements pause as
 * *cancel, stash the unspoken tail, re-say it at HIGH priority*, which needs no
 * engine support and survives the engine dropping the utterance. Native pause is
 * unreliable across utterance boundaries and platform-dependent. Ported
 * semantics win; that is the point of having ported them.
 *
 * PLATFORM-FREE: timers, clock and synthesiser are all injected, so
 * `scripts/test_speech.mjs` drives the whole thing in Node against fakes.
 */

import {
  AnnouncementQueue,
  AnnouncementType,
  Category,
  Priority,
} from '../logic/announcementQueue.js';
import { createSpeaker } from '../speak.js';
import { createSentenceSplitter, splitSentences } from './sentences.js';

/* --------------------------------------------------------------- constants -- */

/**
 * Dispatcher layer → announcement category.
 *
 * `dispatcher.js` calls `speak(text, { layer, turnId })`, so this is the whole
 * translation between that seam and the ported queue. L0 readouts are GRAPH —
 * MapIO's category for "what the map says here". L2/L3 are LLM. L1 never
 * generates text (design §4) so it only ever speaks status.
 */
export const LAYER_CATEGORY = Object.freeze({
  L0: Category.GRAPH,
  L1: Category.SYSTEM,
  L2: Category.LLM,
  L3: Category.LLM,
});

/**
 * Category → default interrupt strength.
 *
 * ERROR outranks everything: a wrong-direction warning that queues behind a
 * paragraph of description has already failed. NAVIGATION is next for the same
 * reason. Descriptive readouts (GRAPH, LLM) sit at LOW so they never preempt a
 * warning — turn gating, not priority, is what keeps them fresh.
 */
export const CATEGORY_PRIORITY = Object.freeze({
  [Category.ERROR]: Priority.HIGH,
  [Category.NAVIGATION]: Priority.MEDIUM,
  [Category.SYSTEM]: Priority.MEDIUM,
  [Category.GRAPH]: Priority.LOW,
  [Category.LLM]: Priority.LOW,
});

/**
 * `MapIOTTS.ERROR_INTERVAL` — `mapio_tts.py:15`. Repeat errors inside this
 * window are dropped, which is why the ported queue keeps per-category
 * timestamps at all.
 */
export const ERROR_INTERVAL_S = 3.5;

/** Web Speech rate bounds we are willing to hand a user. */
export const RATE_MIN = 0.5;
export const RATE_MAX = 2.5;
export const RATE_STEP = 0.15;
export const VOLUME_STEP = 0.15;

/**
 * ⚠️ MapIO ships pyttsx3 at `DEFAULT_RATE = 200` wpm (`tts.py:70`), which is
 * *faster* than a Web Speech `rate: 1` (the voice's own default, typically
 * 150–180 wpm). The two scales are not comparable — pyttsx3's is absolute words
 * per minute, Web Speech's is a multiplier on a voice we do not control — so
 * there is no honest port of that constant. We keep 1.0 and let "faster" exist.
 */
export const DEFAULT_RATE = 1.0;

/**
 * Characters per second assumed when sizing a watchdog. Deliberately LOW
 * (≈145 wpm) so the estimate overshoots: a watchdog that fires early cuts a
 * live utterance short, which is worse than one that recovers slowly.
 */
const CHARS_PER_SECOND = 12;

/** Fixed slack added to every watchdog, ms — covers engine start-up latency. */
const WATCHDOG_GRACE_MS = 3000;

/** Multiplier on the estimate, on top of the grace. */
const WATCHDOG_SLACK = 1.5;

/**
 * How long an utterance of this text should take, in ms.
 * @param {string} text
 * @param {number} rate
 * @returns {number}
 */
export function estimateSpeechMs(text, rate = 1) {
  const chars = String(text ?? '').length;
  const safeRate = rate > 0 ? rate : 1;
  return (chars / CHARS_PER_SECOND) * 1000 / safeRate;
}

/**
 * The deadline after which an utterance is presumed lost.
 * @param {string} text
 * @param {number} rate
 * @returns {number}
 */
export function watchdogMs(text, rate = 1) {
  return Math.round(estimateSpeechMs(text, rate) * WATCHDOG_SLACK) + WATCHDOG_GRACE_MS;
}

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));

/* ---------------------------------------------------------------- narrator -- */

/**
 * @param {object} [options]
 * @param {ReturnType<typeof createSpeaker>} [options.speaker] Defaults to a
 *   speaker built from `synth` / `Utterance`.
 * @param {object} [options.synth] Passed to `createSpeaker`.
 * @param {Function} [options.Utterance] Passed to `createSpeaker`.
 * @param {boolean} [options.autoStart=false] Whether the queue drains straight
 *   away. Off by default: browsers gate `speechSynthesis` behind a user gesture,
 *   so the queue opens on `arm()`, which the mic button and the "What's here?"
 *   button both call.
 * @param {number} [options.rate=DEFAULT_RATE]
 * @param {number} [options.pitch]
 * @param {number} [options.volume=1]
 * @param {string} [options.lang]
 * @param {() => number} [options.now] Seconds. Injected for tests.
 * @param {(fn: Function, ms: number) => any} [options.setTimeout]
 * @param {(handle: any) => void} [options.clearTimeout]
 * @param {(announcement: object, info: {announced: boolean, started: boolean}) => void} [options.onAnnouncementEnded]
 * @param {(speaking: boolean) => void} [options.onSpeakingChange]
 * @param {(info: {text: string, turnId: any, reason: string}) => void} [options.onDropped]
 * @param {(error: unknown) => void} [options.onError]
 * @param {boolean} [options.watchdog=true] Only turn this off in a test that is
 *   *checking* the deadlock; production has no reason to.
 */
export function createNarrator(options = {}) {
  const {
    speaker: injectedSpeaker,
    synth,
    Utterance,
    autoStart = false,
    rate: initialRate = DEFAULT_RATE,
    pitch,
    volume: initialVolume = 1,
    lang,
    now = () => Date.now() / 1000,
    setTimeout: setTimer = globalThis.setTimeout,
    clearTimeout: clearTimer = globalThis.clearTimeout,
    onAnnouncementEnded,
    onSpeakingChange,
    onDropped,
    onError,
    watchdog: watchdogEnabled = true,
    generateId,
  } = options;

  const speaker = injectedSpeaker ?? createSpeaker({ synth, Utterance, onError });

  let rate = clamp(initialRate, RATE_MIN, RATE_MAX);
  let volume = clamp(initialVolume, 0, 1);

  /* -- watchdog bookkeeping ------------------------------------------------- */

  /** Monotonic token for the utterance in flight. */
  let token = 0;
  let timerHandle = null;
  /**
   * Whether the engine accepted each utterance, by announcement id. Not a single
   * flag: the `!started` path settles synchronously and re-enters `speak` for the
   * next announcement, so one shared variable would be overwritten before the
   * `onAnnouncementEnded` of the announcement it described.
   * @type {Map<string, boolean>}
   */
  const startedById = new Map();

  let watchdogFirings = 0;
  let droppedUtterances = 0;
  let staleDrops = 0;

  function clearWatchdog() {
    if (timerHandle !== null) { clearTimer(timerHandle); timerHandle = null; }
  }

  /**
   * End the utterance identified by `expected`, at most once. Both `onend` and
   * the watchdog call this; whichever is first wins and the other is a no-op.
   * @param {number} expected
   * @param {boolean} byWatchdog
   */
  function settle(expected, byWatchdog) {
    if (expected !== token) return;
    token += 1;
    clearWatchdog();
    if (byWatchdog) watchdogFirings += 1;
    queue.finishCurrent();
  }

  /* -- the queue ------------------------------------------------------------ */

  let lastSpoken = null;
  let speakingFlag = false;
  /**
   * Categories that have actually started an announcement. Needed because the
   * ported queue's per-category timestamps start at 0 and "never spoken" is
   * therefore indistinguishable from "spoken at t = 0" under any clock that
   * starts at zero. See `error()`.
   * @type {Set<string>}
   */
  const everSpoken = new Set();

  const queue = new AnnouncementQueue({
    now,
    generateId,
    speak: (announcement) => {
      const mine = token;
      everSpoken.add(announcement.category);

      if (announcement.type === AnnouncementType.PAUSE) {
        // A pause is queued like anything else so ordering is preserved; the
        // Python slept the loop thread, we schedule.
        startedById.set(announcement.id, true);
        const ms = Math.max(0, Number(announcement.duration ?? 0) * 1000);
        timerHandle = setTimer(() => { timerHandle = null; settle(mine, false); }, ms);
        return;
      }

      const text = announcement.text ?? '';
      lastSpoken = { text, category: announcement.category };

      const ok = speaker.speak(announcement, {
        // The queue serialises; it must not cancel its own predecessor here,
        // which `speak.js` defaults to doing.
        interrupt: false,
        rate,
        pitch,
        volume,
        lang,
        onEnd: () => settle(mine, false),
        // `charIndex` is the only progress signal a browser gives, and the
        // ported `togglePause()` needs it to resume mid-sentence.
        onBoundary: (index) => queue.setSpokenIndex(index),
      });

      startedById.set(announcement.id, ok);
      if (!ok) {
        // The engine refused it outright — no synth, no gesture, empty text.
        // `onEnd` will never come, so settle now or the queue stops here. The
        // ported queue is documented as synchronously driven, so this recursion
        // is its normal drain path, bounded by the queue length.
        droppedUtterances += 1;
        settle(mine, false);
        return;
      }

      if (watchdogEnabled) {
        timerHandle = setTimer(() => {
          timerHandle = null;
          settle(mine, true);
        }, watchdogMs(text, rate));
      }
    },
    cancel: () => {
      // Invalidate the in-flight token first: `synth.cancel()` fires `onerror`
      // on the pending utterance, and that must not be read as "the next one
      // finished".
      token += 1;
      clearWatchdog();
      speaker.cancel();
    },
    onAnnouncementEnded: (announcement, announced) => {
      // ⚠️ The ported queue reports `announced: true` for anything it dequeued,
      // including an utterance the engine silently refused. `started` is the
      // narrator's correction: it is the only one of the two that means "sound
      // came out".
      const startedThis = startedById.get(announcement.id) ?? false;
      startedById.delete(announcement.id);
      onAnnouncementEnded?.(announcement, { announced, started: startedThis });
      syncSpeaking();
    },
  });

  if (autoStart) queue.start();

  function syncSpeaking() {
    const next = queue.isSpeaking();
    if (next === speakingFlag) return;
    speakingFlag = next;
    onSpeakingChange?.(next);
  }

  /* -- turn gating ---------------------------------------------------------- */

  let currentTurnId = null;
  /** Retired turns, newest last, capped so a long session cannot grow it. */
  const retired = [];
  const retiredSet = new Set();
  const RETIRED_CAP = 64;

  function retire(turnId) {
    if (turnId == null || retiredSet.has(turnId)) return;
    retired.push(turnId);
    retiredSet.add(turnId);
    while (retired.length > RETIRED_CAP) retiredSet.delete(retired.shift());
  }

  /**
   * @param {any} turnId
   * @returns {'stale'|'new'|'current'}
   */
  function classifyTurn(turnId) {
    if (turnId == null) return 'current';
    if (retiredSet.has(turnId)) return 'stale';
    if (currentTurnId === null || turnId === currentTurnId) return 'current';
    return 'new';
  }

  /* -- narration ------------------------------------------------------------ */

  /**
   * Say something.
   *
   * @param {string} text
   * @param {object} [opts]
   * @param {any} [opts.turnId] Gating key. A new one preempts; a retired one is
   *   dropped; the same one queues in order.
   * @param {string} [opts.layer] `'L0'|'L1'|'L2'|'L3'` — the dispatcher's own field.
   * @param {string} [opts.category] Overrides the layer mapping.
   * @param {number} [opts.priority] Overrides the category mapping.
   * @param {boolean} [opts.interrupt] Overrides the turn rule.
   * @param {boolean} [opts.split=false] Split into sentences before queueing, so
   *   a long answer can be interrupted between sentences rather than only at its end.
   * @returns {object|null} The queued announcement, or null if nothing was queued.
   */
  function narrate(text, opts = {}) {
    const {
      turnId = null, layer = null, category, priority, interrupt, split = false,
    } = opts;

    const body = String(text ?? '').trim();
    if (!body) return null;

    const disposition = classifyTurn(turnId);
    if (disposition === 'stale') {
      staleDrops += 1;
      onDropped?.({ text: body, turnId, reason: 'stale-turn' });
      return null;
    }

    if (disposition === 'new') {
      retire(currentTurnId);
      currentTurnId = turnId;
    } else if (turnId != null && currentTurnId === null) {
      currentTurnId = turnId;
    }

    const cat = category ?? LAYER_CATEGORY[layer] ?? Category.LLM;
    const pri = priority ?? CATEGORY_PRIORITY[cat] ?? Priority.LOW;
    const shouldInterrupt = interrupt ?? (disposition === 'new');

    const pieces = split ? splitSentences(body) : [body];
    if (pieces.length === 0) return null;

    let first = null;
    for (let index = 0; index < pieces.length; index += 1) {
      const piece = pieces[index];
      const queued = (shouldInterrupt && index === 0)
        ? queue.stopAndSay(piece, cat, pri)
        : queue.say(piece, cat, pri);
      if (index === 0) {
        first = queued;
        if (queued === null && shouldInterrupt) {
          // `stopAndSay` refused: something at least as important is in flight.
          // The remaining sentences belong to the same refused answer, so they
          // are dropped too rather than queued behind it out of context.
          onDropped?.({ text: body, turnId, reason: 'outranked' });
          break;
        }
      }
    }
    syncSpeaking();
    return first;
  }

  /**
   * The shape `dispatcher.js` calls: `speak(text, { layer, turnId })`.
   * @param {string} text
   * @param {object} [meta]
   * @returns {object|null}
   */
  function fromDispatcher(text, meta = {}) {
    return narrate(text, { ...meta, split: true });
  }

  /**
   * An error, with MapIO's repeat suppression: identical-category errors inside
   * `ERROR_INTERVAL_S` are dropped, exactly as `MapIOTTS.wrong_direction` does.
   *
   * @param {string} text
   * @param {{minIntervalS?: number, force?: boolean}} [opts]
   * @returns {object|null}
   */
  function error(text, opts = {}) {
    const { minIntervalS = ERROR_INTERVAL_S, force = false } = opts;
    // ⚠️ The ported queue's per-category timestamps start at 0.0, and the Python
    // got away with comparing against that only because `time.time()` is ~1.7e9,
    // so `now - 0` was never inside any interval. Under a clock that starts at
    // zero — `performance.now()`, or any injected test clock — "never spoken"
    // reads as "spoken just now" and the FIRST error of the session is
    // suppressed. Tracking it explicitly is the only fix that does not depend on
    // the clock's epoch.
    if (!force && everSpoken.has(Category.ERROR)
        && queue.secondsSince(Category.ERROR) < minIntervalS) {
      onDropped?.({ text, turnId: null, reason: 'error-interval' });
      return null;
    }
    return narrate(text, { category: Category.ERROR, priority: Priority.HIGH, interrupt: true });
  }

  /**
   * Speak a model's output as it streams, one sentence at a time.
   *
   * Returns a handle: `push(delta)` per chunk, `end()` when generation stops,
   * `abandon()` if the turn is superseded mid-stream.
   *
   * @param {object} [opts]
   * @param {any} [opts.turnId]
   * @param {string} [opts.layer='L3']
   */
  function narrateStream(opts = {}) {
    const { turnId = null, layer = 'L3', ...rest } = opts;
    const splitter = createSentenceSplitter();
    let firstDone = false;
    let spoken = 0;

    const emit = (sentences) => {
      for (const sentence of sentences) {
        narrate(sentence, {
          ...rest,
          turnId,
          layer,
          // Only the first sentence of the turn preempts; the rest are the same
          // answer continuing and must queue behind it.
          interrupt: !firstDone,
        });
        firstDone = true;
        spoken += 1;
      }
    };

    return {
      /** @param {string} delta @returns {number} sentences started by this delta */
      push(delta) { const s = splitter.push(delta); emit(s); return s.length; },
      /** @returns {number} total sentences spoken */
      end() { emit(splitter.flush()); return spoken; },
      abandon() { splitter.reset(); retire(turnId); },
      pending: () => splitter.pending(),
    };
  }

  /* -- control (L0's CONTROL_LEXICON) --------------------------------------- */

  /**
   * Restart the current utterance from where it got to, at the current rate and
   * volume. Web Speech settings only apply to *new* utterances, so "slower"
   * would otherwise not be heard until the next sentence — which for a
   * paragraph-length answer is exactly when it stops being useful.
   *
   * Unlike `_pauseCurrent`, this does not exclude ERROR and GRAPH: refusing to
   * apply "louder" to an error readout would be perverse.
   *
   * @returns {boolean}
   */
  function restartCurrent() {
    const current = queue.currentAnnouncement;
    if (!queue.isSpeaking()) return false;
    if (current.type !== AnnouncementType.TEXT) return false;
    const tail = String(current.text ?? '').slice(queue.currentAnnouncementIndex);
    if (!tail.trim()) return false;
    // HIGH so `stopAndSay` cannot refuse its own continuation — the same trick
    // the ported `_resumePaused()` uses.
    queue.stopAndSay(tail, current.category, Priority.HIGH);
    return true;
  }

  /** @param {number} next @returns {number} the clamped value actually set */
  function setRate(next) {
    const value = clamp(Number(next), RATE_MIN, RATE_MAX);
    if (value === rate) return rate;
    rate = value;
    restartCurrent();
    return rate;
  }

  /** @param {number} next @returns {number} */
  function setVolume(next) {
    const value = clamp(Number(next), 0, 1);
    if (value === volume) return volume;
    volume = value;
    restartCurrent();
    return volume;
  }

  /** @returns {boolean} Whether anything was paused. */
  function pause() {
    if (queue.pausedAnnouncement !== null) return false; // already paused
    if (!queue.isSpeaking()) return false;
    queue.togglePause();
    syncSpeaking();
    return true;
  }

  /** @returns {boolean} Whether anything was resumed. */
  function resume() {
    if (queue.pausedAnnouncement === null) return false;
    queue.togglePause();
    syncSpeaking();
    return true;
  }

  /**
   * Say the last thing again. Prefers what is speaking now — "say that again"
   * during a long answer means this answer — and falls back to the last one
   * that finished.
   * @returns {object|null}
   */
  function repeat() {
    const current = queue.currentAnnouncement;
    const source = (queue.isSpeaking() && current.type === AnnouncementType.TEXT)
      ? { text: current.text, category: current.category }
      : lastSpoken;
    if (!source?.text) return null;
    return queue.stopAndSay(source.text, source.category, Priority.HIGH);
  }

  /** Everything stops, now. @returns {void} */
  function stopSpeaking() {
    token += 1;
    clearWatchdog();
    queue.stopSpeaking();
    syncSpeaking();
  }

  /**
   * Apply an L0 control command — the `command` field of
   * `matchL0(utterance)` / `dispatcher.dispatch()`'s `intent: 'control'` result.
   * Deliberately model-free: design §4 notes a "stop" that takes a 1–3 s round
   * trip is not a stop.
   *
   * @param {string} command
   * @returns {boolean} Whether the command was recognised and applied.
   */
  function control(command) {
    switch (command) {
      case 'stop': stopSpeaking(); return true;
      case 'pause': return pause() || true;
      case 'resume': return resume() || true;
      case 'repeat': repeat(); return true;
      case 'slower': setRate(rate - RATE_STEP); return true;
      case 'faster': setRate(rate + RATE_STEP); return true;
      case 'quieter': setVolume(volume - VOLUME_STEP); return true;
      case 'louder': setVolume(volume + VOLUME_STEP); return true;
      default: return false;
    }
  }

  /* -- gesture arming ------------------------------------------------------- */

  /**
   * Open the queue. Browsers gate `speechSynthesis` behind a user gesture, so
   * this belongs in a click handler — the mic button and "What's here?" both
   * call it.
   *
   * Anything queued *before* the first gesture is dropped by default: it is UI
   * chatter from before the user was listening, and hearing a backlog play out
   * on first click is worse than losing it.
   *
   * @param {{flush?: boolean}} [opts]
   * @returns {boolean} Whether this call was the one that opened the queue.
   */
  function arm(opts = {}) {
    const { flush = true } = opts;
    if (queue.isRunning()) return false;
    if (flush) queue.stopSpeaking();
    queue.start();
    syncSpeaking();
    return true;
  }

  /* -- the `speak.js` seam -------------------------------------------------- */

  /**
   * A `createSpeaker`-shaped object that routes through this queue.
   *
   * `speak.js` documents `setSpeaker()` as "the seam milestone S swaps the
   * `AnnouncementQueue` in through", so `setSpeaker(narrator.asSpeaker())` is
   * the whole wiring: `AudiomMap`'s "What's here?" button keeps calling the
   * module-level `speak()` and silently gains categories, priorities, interrupt
   * semantics and the watchdog, with no change to that component's logic.
   *
   * ⚠️ Its `speak()` returns whether the text was **queued**, not whether an
   * utterance started — through a queue those are different questions, and only
   * the first can be answered synchronously.
   */
  function asSpeaker() {
    return {
      /**
       * @param {string|{text?: string}} input
       * @param {{interrupt?: boolean, category?: string, priority?: number, turnId?: any, layer?: string}} [opts]
       * @returns {boolean}
       */
      speak(input, opts = {}) {
        // Every caller of the module-level `speak()` is on a user-interaction
        // path by construction (the button IS the gesture), so arming here is
        // correct rather than a shortcut. Non-gesture callers use `narrate()`.
        arm({ flush: false });
        const text = speaker.textOf(input);
        if (!text) return false;
        return narrate(text, {
          layer: 'L0',
          ...opts,
          interrupt: opts.interrupt ?? true,
        }) !== null;
      },
      cancel() { stopSpeaking(); return true; },
      textOf: speaker.textOf,
      isAvailable: speaker.isAvailable,
    };
  }

  /* ------------------------------------------------------------------------ */

  return {
    /* narration */
    narrate,
    narrateStream,
    error,
    speak: fromDispatcher,
    /**
     * Queue a silent gap, in seconds. Ordering-preserving, like the Python.
     * @param {number} seconds
     */
    addPause: (seconds) => queue.addPause(seconds),

    /* control */
    control,
    stopSpeaking,
    pause,
    resume,
    repeat,
    setRate,
    setVolume,
    getRate: () => rate,
    getVolume: () => volume,

    /* categories — the mute switches the ported queue already implements */
    enableCategory: (c) => queue.enableCategory(c),
    disableCategory: (c) => queue.disableCategory(c),
    isCategoryEnabled: (c) => queue.isEnabled(c),

    /* lifecycle */
    arm,
    isArmed: () => queue.isRunning(),
    isSpeaking: () => queue.isSpeaking(),
    dispose() { clearWatchdog(); queue.stop(); syncSpeaking(); },

    /* turns */
    /** Retire a turn without narrating — the "the user moved on" signal. */
    retireTurn(turnId) {
      retire(turnId);
      if (currentTurnId === turnId) currentTurnId = null;
    },
    getTurnId: () => currentTurnId,

    /* introspection */
    asSpeaker,
    queue,
    stats: () => ({
      watchdogFirings,
      droppedUtterances,
      staleDrops,
      queued: queue.queue.length,
      speaking: queue.isSpeaking(),
    }),
  };
}
