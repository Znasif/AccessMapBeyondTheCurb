/**
 * AnnouncementQueue — the category / priority / interrupt logic of
 * `explore/simple_camio_llm/src/view/audio/tts.py`, with pyttsx3 removed.
 *
 * Milestone P of `docs/browser-voice-exploration-plan.md` §4:
 *
 *   > `tts.py`'s priority/interrupt/category queue (**logic only** — pyttsx3
 *   > does not port) → a `speechSynthesis` queue
 *
 * What was ported: the FIFO queue, per-category enable/disable, priority
 * preemption in `stopAndSay()`, the per-category "last spoken at" timestamps
 * every caller gates on (`MapIOTTS.wrong_direction` and friends suppress
 * repeats inside `ERROR_INTERVAL`), pause insertion, and pause/resume of a
 * partially spoken announcement.
 *
 * What did not: the engine, the loop thread, the two condition variables, and
 * `_start_one_msg_loop` (a `time.sleep` reminder loop — a caller-side
 * `setInterval` in a browser, not queue logic).
 *
 * PLATFORM-FREE ON PURPOSE — no `speechSynthesis`, no timers, no clock:
 *
 *   - **`speak(announcement)`** is injected. It starts the utterance and the
 *     caller reports completion with `finishCurrent()`. That is exactly the
 *     shape of `SpeechSynthesisUtterance`'s `onend`.
 *   - **`cancel(announcement)`** is injected and called before an interrupt
 *     (`speechSynthesis.cancel()`).
 *   - **`now()`** returns seconds. Python read `time.time()` directly.
 *   - **`generateId()`** returns a unique string. Python used `uuid4()`.
 *
 * The queue is driven synchronously: `say()` and `finishCurrent()` both drain
 * it, so an announcement starts speaking inside the call that made it possible.
 */

/** Which subsystem an announcement came from. Each can be muted separately. */
export const Category = Object.freeze({
  SYSTEM: 'system',
  GRAPH: 'graph',
  NAVIGATION: 'navigation',
  LLM: 'llm',
  ERROR: 'error',
});

/** All categories, for iteration. @type {readonly string[]} */
export const CATEGORIES = Object.freeze(Object.values(Category));

/** Interrupt strength. Higher wins; `stopAndSay` refuses to preempt a higher one. */
export const Priority = Object.freeze({
  NONE: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
});

/** Discriminator for the two announcement shapes. */
export const AnnouncementType = Object.freeze({
  TEXT: 'text',
  PAUSE: 'pause',
});

/**
 * A queued utterance.
 *
 * Identity is the `id` alone — Python's dataclass marks every other field
 * `compare=False`, so two announcements with the same text are different
 * announcements and the one you hold a reference to is the one you can match.
 */
export class Announcement {
  /** @type {Announcement} The empty announcement; priority NONE. */
  static NONE;

  /**
   * @param {object} [options]
   * @param {string} [options.id]
   * @param {string} [options.category]
   * @param {number} [options.priority]
   * @param {string} [options.type]
   */
  constructor(options = {}) {
    this.id = options.id ?? 'none';
    this.category = options.category ?? Category.SYSTEM;
    this.priority = options.priority ?? Priority.LOW;
    this.type = options.type ?? AnnouncementType.TEXT;
  }

  /** @returns {boolean} */
  isError() {
    return this.category === Category.ERROR;
  }

  /** @returns {boolean} */
  isSystem() {
    return this.category === Category.SYSTEM;
  }

  /** @returns {boolean} */
  isGraph() {
    return this.category === Category.GRAPH;
  }

  /** @returns {boolean} */
  isLlm() {
    return this.category === Category.LLM;
  }

  /** @returns {boolean} */
  isNavigation() {
    return this.category === Category.NAVIGATION;
  }

  /**
   * @param {unknown} other
   * @returns {boolean}
   */
  equals(other) {
    return other instanceof Announcement && this.id === other.id;
  }
}

Announcement.NONE = new Announcement({ id: 'none', priority: Priority.NONE });

/** Something to say. */
export class TextAnnouncement extends Announcement {
  /**
   * @param {object} options
   * @param {string} options.text
   * @param {string} [options.id]
   * @param {string} [options.category]
   * @param {number} [options.priority]
   */
  constructor(options) {
    super({ ...options, type: AnnouncementType.TEXT });
    this.text = options.text ?? '';
  }
}

/** A silent gap, queued like anything else so ordering is preserved. */
export class PauseAnnouncement extends Announcement {
  /**
   * @param {object} options
   * @param {number} options.duration Seconds.
   * @param {string} [options.id]
   * @param {string} [options.category]
   * @param {number} [options.priority]
   */
  constructor(options) {
    super({ ...options, type: AnnouncementType.PAUSE });
    this.duration = options.duration ?? 1.0;
  }
}

let idCounter = 0;

/**
 * Default id source: monotonic and dependency-free. Callers that want UUIDs
 * inject `generateId`.
 * @returns {string}
 */
function defaultGenerateId() {
  idCounter += 1;
  return `a${idCounter}`;
}

/**
 * A speech queue with categories, priorities and interrupts.
 */
export class AnnouncementQueue {
  /**
   * @param {object} [options]
   * @param {(announcement: Announcement) => void} [options.speak] Start
   *   speaking (or start waiting out a pause). Must eventually lead to
   *   `finishCurrent()`.
   * @param {(announcement: Announcement) => void} [options.cancel] Stop the
   *   utterance in progress.
   * @param {() => number} [options.now] Clock in seconds.
   * @param {() => string} [options.generateId]
   * @param {(announcement: Announcement, announced: boolean) => void} [options.onAnnouncementEnded]
   */
  constructor(options = {}) {
    this.speak = options.speak ?? (() => {});
    this.cancel = options.cancel ?? (() => {});
    this.now = options.now ?? (() => Date.now() / 1000);
    this.generateId = options.generateId ?? defaultGenerateId;
    this.onAnnouncementEnded = options.onAnnouncementEnded ?? null;

    /** @type {Announcement[]} */
    this.queue = [];

    this.currentAnnouncement = Announcement.NONE;
    this.lastAnnouncement = Announcement.NONE;
    /** @type {TextAnnouncement|null} */
    this.pausedAnnouncement = null;

    /** Character offset reached in the current utterance. */
    this.currentAnnouncementIndex = 0;

    this._running = false;
    this._isSpeaking = false;

    /** @type {Record<string, number>} */
    this._timestamps = {};
    /** @type {Record<string, boolean>} */
    this._enabled = {};
    for (const category of CATEGORIES) {
      this._timestamps[category] = 0.0;
      this._enabled[category] = true;
    }
  }

  /** @returns {boolean} */
  isSpeaking() {
    return this._isSpeaking;
  }

  /** @returns {boolean} */
  isRunning() {
    return this._running;
  }

  /**
   * Open the queue and start draining it.
   * @returns {void}
   */
  start() {
    if (this._running) return;
    this._running = true;
    this._drain();
  }

  /**
   * Close the queue. Anything still queued is reported as not announced; a
   * current utterance is cancelled.
   * @returns {void}
   */
  stop() {
    if (!this._running) return;
    this._running = false;
    this.stopSpeaking();
  }

  /**
   * @param {string} category
   * @returns {void}
   */
  disableCategory(category) {
    this._enabled[category] = false;
  }

  /** @returns {void} */
  disableAllCategories() {
    for (const category of Object.keys(this._enabled)) this._enabled[category] = false;
  }

  /**
   * @param {string} category
   * @returns {void}
   */
  enableCategory(category) {
    this._enabled[category] = true;
  }

  /** @returns {void} */
  enableAllCategories() {
    for (const category of Object.keys(this._enabled)) this._enabled[category] = true;
  }

  /**
   * @param {string} category
   * @returns {boolean}
   */
  isEnabled(category) {
    return Boolean(this._enabled[category]);
  }

  /**
   * When this category last *started* being announced, in `now()` seconds.
   * Callers gate repeats on it — `MapIOTTS.wrong_direction` drops the
   * announcement entirely if the ERROR category spoke less than 3.5 s ago.
   * @param {string} category
   * @returns {number}
   */
  getTimestamp(category) {
    return this._timestamps[category] ?? 0;
  }

  /**
   * @param {string} category
   * @returns {number} Seconds since that category last started speaking.
   */
  secondsSince(category) {
    return this.now() - this.getTimestamp(category);
  }

  /**
   * Queue something to say. Returns `null` — and queues nothing — when the
   * category is muted or the text is empty.
   * @param {string|null|undefined} text
   * @param {string} category
   * @param {number} [priority=Priority.LOW]
   * @returns {Announcement|null}
   */
  say(text, category, priority = Priority.LOW) {
    if (text === null || text === undefined || !this._enabled[category]) return null;

    const trimmed = String(text).trim();
    if (trimmed.length === 0) return null;

    const announcement = new TextAnnouncement({
      id: this.generateId(),
      text: trimmed,
      priority,
      category,
    });

    this.queue.push(announcement);
    this._drain();

    return announcement;
  }

  /**
   * Interrupt and say this instead — unless something at least as important is
   * already speaking or waiting, in which case nothing happens and `null` comes
   * back.
   *
   * The comparison is `priority < maxPriority`, so an equal priority *does*
   * preempt: the newest MEDIUM navigation instruction replaces the previous
   * one rather than queueing behind it.
   *
   * @param {string|null|undefined} text
   * @param {string} category
   * @param {number} [priority=Priority.LOW]
   * @returns {Announcement|null}
   */
  stopAndSay(text, category, priority = Priority.LOW) {
    let maxPriority = Priority.NONE;
    for (const announcement of this.queue) {
      if (announcement.priority > maxPriority) maxPriority = announcement.priority;
    }

    const currentPriority = this.currentAnnouncement.priority;
    if (currentPriority > maxPriority) maxPriority = currentPriority;

    if (priority < maxPriority) return null;

    this.stopSpeaking();

    return this.say(text, category, priority);
  }

  /**
   * Drop everything queued and cancel whatever is speaking.
   *
   * Faithful asymmetry: queued announcements are reported with
   * `announced = false`, the interrupted one with `announced = true` — in the
   * Python the engine's stop still runs it out through the normal end-of-loop
   * path.
   *
   * @returns {void}
   */
  stopSpeaking() {
    const dropped = this.queue;
    this.queue = [];
    for (const announcement of dropped) this._onAnnouncementEnded(announcement, false);

    if (this._isSpeaking) {
      this.cancel(this.currentAnnouncement);
      this._endCurrent();
    }
  }

  /**
   * Queue a silent gap.
   * @param {number} duration Seconds.
   * @returns {PauseAnnouncement}
   */
  addPause(duration) {
    const announcement = new PauseAnnouncement({ id: this.generateId(), duration });
    this.queue.push(announcement);
    this._drain();
    return announcement;
  }

  /**
   * Pause the current announcement, or resume the one paused earlier.
   * @returns {void}
   */
  togglePause() {
    if (this.pausedAnnouncement !== null) this._resumePaused();
    else this._pauseCurrent();
  }

  /**
   * Report speech progress, so a pause can resume mid-sentence. In a browser
   * this is the `boundary` event's `charIndex`.
   * @param {number} index
   * @returns {void}
   */
  setSpokenIndex(index) {
    this.currentAnnouncementIndex = index;
  }

  /**
   * The current announcement finished (or was cut short by the engine).
   * @returns {void}
   */
  finishCurrent() {
    if (!this._isSpeaking) return;
    this._endCurrent();
  }

  /**
   * Close out the current announcement and start the next one.
   * @returns {void}
   * @private
   */
  _endCurrent() {
    this.currentAnnouncementIndex = 0;
    this._isSpeaking = false;

    this.lastAnnouncement = this.currentAnnouncement;
    this.currentAnnouncement = Announcement.NONE;

    this._onAnnouncementEnded(this.lastAnnouncement, true);

    this._drain();
  }

  /**
   * Start the next announcement if nothing is speaking.
   * @returns {void}
   * @private
   */
  _drain() {
    if (!this._running || this._isSpeaking) return;
    if (this.queue.length === 0) return;

    const announcement = /** @type {Announcement} */ (this.queue.shift());

    this.currentAnnouncement = announcement;
    this.currentAnnouncementIndex = 0;
    this._isSpeaking = true;
    this._timestamps[announcement.category] = this.now();

    this.speak(announcement);
  }

  /**
   * @param {Announcement} announcement
   * @param {boolean} announced
   * @returns {void}
   * @private
   */
  _onAnnouncementEnded(announcement, announced) {
    if (this.onAnnouncementEnded !== null) this.onAnnouncementEnded(announcement, announced);
  }

  /** @returns {void} @private */
  _resumePaused() {
    const paused = this.pausedAnnouncement;
    if (paused === null) return;

    this.stopAndSay(paused.text, paused.category, paused.priority);

    this.pausedAnnouncement = null;
  }

  /**
   * Stash the unspoken tail of the current announcement so `togglePause()` can
   * resume it at HIGH priority.
   *
   * Errors and graph readouts are not stashed: they are momentary, and
   * resuming half of one later would be wrong rather than helpful.
   *
   * @returns {void}
   * @private
   */
  _pauseCurrent() {
    const current = this.currentAnnouncement;
    if (current.type !== AnnouncementType.TEXT) return;
    if (!this._isSpeaking) return;

    const text = /** @type {TextAnnouncement} */ (current).text;
    if (this.currentAnnouncementIndex >= text.length) return;

    if (!current.isError() && !current.isGraph()) {
      this.pausedAnnouncement = new TextAnnouncement({
        id: this.generateId(),
        text: text.slice(this.currentAnnouncementIndex),
        priority: Priority.HIGH,
        category: current.category,
      });
    }

    this.stopSpeaking();
  }
}
