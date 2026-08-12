/**
 * Speech in — milestone S, half one.
 *
 * `SpeechRecognition`, Chrome-first with `processLocally: true`, feature
 * detected. Per §7.2 item 2 of `docs/browser-voice-exploration-plan.md`:
 *
 *   > Chrome 139 (Aug 2025) shipped **on-device** recognition —
 *   > `SpeechRecognition` with `processLocally: true` and installable language
 *   > packs — while Safari's Web Speech implementation sends audio to **Apple's
 *   > servers**. […] So the browser answer is **Chrome-first with
 *   > `processLocally`, feature-detected**, degrading to a visible "cloud STT"
 *   > notice where the language pack is unavailable.
 *
 * That correction is the whole design of this module. Rev 2 of the design doc
 * (§8.1) claimed recognition was "symmetric" with `speechSynthesis`; it is not.
 * TTS runs on-device unconditionally. STT runs on-device only when Chrome says
 * it does, and everywhere else it is a network service that ships microphone
 * audio to a third party. A local-only system cannot let that happen silently.
 *
 * ## Three rules that follow, and are enforced here
 *
 * 1. **The mode is decided before the microphone opens, never after.** A notice
 *    rendered after `start()` is an apology, not a disclosure — the audio has
 *    already left. `prepare()` does the async probing with no microphone access
 *    at all; `start()` is synchronous and cheap, because it has to run inside
 *    the click that granted the gesture.
 * 2. **Local is the default even when we do not know.** If we were never
 *    prepared and the browser exposes the on-device API surface at all, we set
 *    `processLocally = true` and let it fail. A failure costs a retry; a wrong
 *    guess in the other direction costs the user's audio.
 * 3. **Degradation is a state, not an event.** `getState().notice` stays set for
 *    as long as the cloud path is in use, so a UI cannot show the warning once
 *    and lose it. `onNotice` exists for announcing the change, not for storing it.
 *
 * ## Feature detection, never user-agent sniffing
 *
 * Everything branches on the presence of `SpeechRecognition.available`,
 * `SpeechRecognition.install` and `SpeechRecognitionPhrase` — Chrome ships them,
 * other engines do not, and a future engine that ships them gets the local path
 * for free.
 *
 * ## Contextual biasing is available in the browser
 *
 * ⚠️ Design doc §8.1 assigns in-window proper-noun biasing to a hypothetical
 * `Qwen3-ASR-0.6B` with "an in-window biasing list […] but it costs memory this
 * machine does not have spare". It does not have to: Web Speech's `phrases` /
 * `SpeechRecognitionPhrase` is exactly that biasing list, it costs nothing, and
 * the in-window place names we already hold (`placeIndex`, `adapter.places()`)
 * are exactly what belongs in it. Street names and POI names are the documented
 * weakness of every recogniser in this stack; this is the free half of the fix.
 * Feature-detected — `phrases-not-supported` is a real error code and is handled
 * as a downgrade, not a failure.
 *
 * PLATFORM-FREE AT MODULE SCOPE, like `speak.js` and `placeIndex.js`: every
 * platform global is injectable and is otherwise resolved off `globalThis` when
 * a recogniser is *used*, never when this file is loaded. It imports in Node,
 * where none of these APIs exist, and `scripts/test_speech.mjs` drives it
 * against a fake.
 */

/* --------------------------------------------------------------- constants -- */

/** What the recogniser is doing. */
export const RecognizerState = Object.freeze({
  IDLE: 'idle',
  PREPARING: 'preparing',
  STARTING: 'starting',
  LISTENING: 'listening',
  STOPPING: 'stopping',
  ERROR: 'error',
  UNSUPPORTED: 'unsupported',
});

/** Where the audio is processed. The only distinction that matters to us. */
export const SttMode = Object.freeze({
  /** On-device. `processLocally: true` accepted by the engine. */
  LOCAL: 'local',
  /** ⚠️ Audio leaves the machine. Requires a visible notice. */
  CLOUD: 'cloud',
  /** No recogniser at all. */
  UNAVAILABLE: 'unavailable',
  /** Not decided yet. */
  UNKNOWN: 'unknown',
});

/**
 * The four values Chrome's `SpeechRecognition.available()` resolves to, plus
 * `UNKNOWN` for engines that do not implement the static at all.
 */
export const Availability = Object.freeze({
  AVAILABLE: 'available',
  DOWNLOADABLE: 'downloadable',
  DOWNLOADING: 'downloading',
  UNAVAILABLE: 'unavailable',
  UNKNOWN: 'unknown',
});

/**
 * Notice codes. A UI is expected to render `notice.text` verbatim; the code is
 * for styling and for tests.
 */
export const NoticeCode = Object.freeze({
  LOCAL: 'stt-local',
  CLOUD: 'stt-cloud',
  DOWNLOADABLE: 'stt-pack-downloadable',
  DOWNLOADING: 'stt-pack-downloading',
  BLOCKED: 'stt-blocked',
  MIC_DENIED: 'stt-mic-denied',
  NO_MIC: 'stt-no-mic',
  UNSUPPORTED: 'stt-unsupported',
  PHRASES_UNSUPPORTED: 'stt-phrases-unsupported',
  NETWORK: 'stt-network',
});

/**
 * The exact sentence a user is owed when their audio is about to be uploaded.
 * Written to be spoken as well as read — it goes through the narrator too.
 */
const CLOUD_TEXT =
  'Cloud speech recognition. This browser has no on-device speech pack for this '
  + 'language, so audio from your microphone is sent to the browser vendor’s servers '
  + 'to be transcribed. Everything else in this app stays on your machine.';

const NOTICE_TEXT = Object.freeze({
  [NoticeCode.LOCAL]: 'On-device speech recognition. Audio stays on this machine.',
  [NoticeCode.CLOUD]: CLOUD_TEXT,
  [NoticeCode.DOWNLOADABLE]:
    'An on-device speech pack is available for download. Install it to keep audio on this machine.',
  [NoticeCode.DOWNLOADING]: 'Downloading the on-device speech pack.',
  [NoticeCode.BLOCKED]:
    'On-device speech recognition is unavailable and cloud recognition is switched off, '
    + 'so the microphone will not be used. Install the language pack, or allow cloud recognition.',
  [NoticeCode.MIC_DENIED]: 'Microphone permission was refused, so speech input is off.',
  [NoticeCode.NO_MIC]: 'No microphone is available, so speech input is off.',
  [NoticeCode.UNSUPPORTED]: 'This browser has no speech recognition, so speech input is off.',
  [NoticeCode.PHRASES_UNSUPPORTED]:
    'This browser ignores contextual phrases, so place names may be transcribed less accurately.',
  [NoticeCode.NETWORK]: 'Speech recognition lost its network connection.',
});

/** Which notices are warnings the UI must keep on screen. */
const WARNING_CODES = new Set([
  NoticeCode.CLOUD, NoticeCode.BLOCKED, NoticeCode.MIC_DENIED,
  NoticeCode.NO_MIC, NoticeCode.UNSUPPORTED, NoticeCode.NETWORK,
]);

/**
 * `SpeechRecognitionErrorEvent.error` values, mapped to what we do about them.
 *
 *   fatal    — stop; the session cannot continue without user action.
 *   retry    — transient; restart if we are meant to keep listening.
 *   benign   — expected end-of-utterance noise; not an error to the user.
 *   downgrade— the local path is not actually available; fall back or block.
 */
export const ERROR_DISPOSITION = Object.freeze({
  'no-speech': 'benign',
  aborted: 'benign',
  'audio-capture': 'fatal',
  'not-allowed': 'fatal',
  'service-not-allowed': 'fatal',
  network: 'retry',
  'language-not-supported': 'downgrade',
  'phrases-not-supported': 'downgrade',
  'bad-grammar': 'benign',
});

/** Default backoff between automatic restarts, ms. */
export const RESTART_DELAY_MS = 250;

/* ----------------------------------------------------------------- helpers -- */

/**
 * @param {string} code
 * @param {string} [detail]
 * @returns {{code: string, severity: 'info'|'warning', text: string, detail?: string}}
 */
function notice(code, detail) {
  return {
    code,
    severity: WARNING_CODES.has(code) ? 'warning' : 'info',
    text: NOTICE_TEXT[code] ?? code,
    ...(detail ? { detail } : {}),
  };
}

/**
 * Flatten a `SpeechRecognitionEvent` into plain data.
 *
 * Only results at or after `resultIndex` are new; everything before it has
 * already been delivered. Chrome re-sends the whole list every time, so reading
 * `results[0]` unconditionally — which every tutorial does — duplicates finals
 * in continuous mode.
 *
 * @param {object} event
 * @returns {{transcript: string, isFinal: boolean, confidence: number, alternatives: string[]}|null}
 */
export function readResult(event) {
  const results = event?.results;
  if (!results || typeof results.length !== 'number') return null;
  const from = Number.isInteger(event.resultIndex) ? event.resultIndex : 0;

  let transcript = '';
  let isFinal = false;
  let confidence = 0;
  let alternatives = [];

  for (let i = from; i < results.length; i += 1) {
    const result = results[i];
    if (!result || typeof result.length !== 'number' || result.length === 0) continue;
    const best = result[0];
    if (!best || typeof best.transcript !== 'string') continue;
    transcript += (transcript ? ' ' : '') + best.transcript.trim();
    if (result.isFinal) {
      isFinal = true;
      confidence = typeof best.confidence === 'number' ? best.confidence : 0;
      alternatives = [];
      for (let a = 1; a < result.length; a += 1) {
        const alt = result[a];
        if (alt && typeof alt.transcript === 'string') alternatives.push(alt.transcript.trim());
      }
    }
  }

  transcript = transcript.trim();
  if (!transcript) return null;
  return { transcript, isFinal, confidence, alternatives };
}

/**
 * Build the engine's phrase-biasing list, if the engine has one.
 *
 * @param {string[]} phrases
 * @param {number} boost
 * @param {Function|null} Phrase `SpeechRecognitionPhrase`, or null.
 * @returns {object[]|null} null when the engine cannot bias.
 */
export function buildPhrases(phrases, boost, Phrase) {
  if (!Phrase || !Array.isArray(phrases) || phrases.length === 0) return null;
  const seen = new Set();
  const out = [];
  for (const raw of phrases) {
    const text = String(raw ?? '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    try { out.push(new Phrase(text, boost)); } catch { /* engine refused this one */ }
  }
  return out.length ? out : null;
}

/* -------------------------------------------------------------- recognizer -- */

/**
 * @param {object} [options]
 * @param {Function} [options.SpeechRecognition] Defaults to
 *   `globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition`,
 *   resolved per call so this module is importable in Node.
 * @param {Function} [options.SpeechRecognitionPhrase] Defaults to the global.
 * @param {string} [options.lang='en-US']
 * @param {boolean} [options.allowCloud=true] Whether a cloud recogniser may be
 *   used when no on-device pack exists. `false` refuses to open the microphone
 *   at all rather than uploading audio — the strict local-only posture.
 * @param {boolean} [options.continuous=false] Push-to-talk by default; see the
 *   echo note on `bargeInOnSpeech`.
 * @param {boolean} [options.interimResults=true]
 * @param {number} [options.maxAlternatives=1]
 * @param {string[]} [options.phrases] In-window place names for contextual biasing.
 * @param {number} [options.phraseBoost=2.0]
 * @param {boolean} [options.autoRestart=false] Restart after a benign end.
 * @param {(result: {transcript: string, isFinal: boolean, confidence: number, alternatives: string[]}) => void} [options.onResult]
 * @param {(transcript: string) => void} [options.onFinal] Convenience: final transcripts only.
 * @param {(state: object) => void} [options.onStateChange]
 * @param {(notice: object) => void} [options.onNotice]
 * @param {(error: {code: string, disposition: string, message?: string}) => void} [options.onError]
 * @param {() => void} [options.onSpeechStart] Barge-in hook. ⚠️ See below.
 * @param {boolean} [options.bargeInOnSpeech=false] ⚠️ Off by default and that is
 *   deliberate: with the microphone open and a speaker audible, the recogniser
 *   hears our own `speechSynthesis` output and fires `speechstart` at it, so a
 *   narration-cancelling barge-in wired to this event silences the app the
 *   moment it starts talking. Push-to-talk (`continuous: false`, the mic button
 *   is the barge-in) has no echo path and is the default. Turn this on only
 *   behind a headset.
 * @param {(fn: Function, ms: number) => any} [options.setTimeout]
 * @param {(handle: any) => void} [options.clearTimeout]
 */
export function createRecognizer(options = {}) {
  const {
    SpeechRecognition,
    SpeechRecognitionPhrase,
    lang = 'en-US',
    allowCloud = true,
    continuous = false,
    interimResults = true,
    maxAlternatives = 1,
    phrases = [],
    phraseBoost = 2.0,
    autoRestart = false,
    onResult,
    onFinal,
    onStateChange,
    onNotice,
    onError,
    onSpeechStart,
    bargeInOnSpeech = false,
    setTimeout: setTimer = globalThis.setTimeout,
    clearTimeout: clearTimer = globalThis.clearTimeout,
  } = options;

  const getCtor = () => SpeechRecognition
    ?? globalThis.SpeechRecognition
    ?? globalThis.webkitSpeechRecognition
    ?? null;
  const getPhrase = () => SpeechRecognitionPhrase ?? globalThis.SpeechRecognitionPhrase ?? null;

  /** Mutable handler slots, so `setHandlers` can rewire after construction. */
  const handlers = {
    onResult, onFinal, onStateChange, onNotice, onError, onSpeechStart,
  };

  let currentLang = lang;
  let currentPhrases = Array.isArray(phrases) ? [...phrases] : [];
  let cloudAllowed = allowCloud;
  let keepListening = continuous || autoRestart;

  let state = RecognizerState.IDLE;
  let mode = SttMode.UNKNOWN;
  let availability = Availability.UNKNOWN;
  /** @type {object|null} The sticky notice — a state, not an event. */
  let currentNotice = null;
  let prepared = false;
  /** Set once we have proof the local path does not work for this language. */
  let localRefused = false;
  let biasingApplied = false;

  /** @type {object|null} The live engine instance; one per session. */
  let engine = null;
  let restartHandle = null;
  /** Session token: a late event from a disposed engine must not be believed. */
  let session = 0;
  let disposed = false;
  /**
   * Re-entry guard for the downgrade path. Without it, an engine that refuses
   * every `start()` with `language-not-supported` — cloud attempt included —
   * recurses `start → handleFailure → start` until the stack gives out.
   */
  let downgrading = false;

  /* -------------------------------------------------------------- plumbing -- */

  function snapshot() {
    return {
      state,
      mode,
      availability,
      lang: currentLang,
      listening: state === RecognizerState.LISTENING || state === RecognizerState.STARTING,
      notice: currentNotice,
      prepared,
      biasingApplied,
      supported: Boolean(getCtor()),
      canGoLocal: Boolean(getCtor()?.available),
    };
  }

  function setState(next) {
    if (state === next) return;
    state = next;
    handlers.onStateChange?.(snapshot());
  }

  /**
   * Set the sticky notice. Re-announcing the identical notice is suppressed so a
   * restart loop does not spam the UI, but the value stays readable in `getState()`.
   * @param {string|null} code
   * @param {string} [detail]
   */
  function setNotice(code, detail) {
    if (code === null) {
      if (currentNotice === null) return;
      currentNotice = null;
      handlers.onStateChange?.(snapshot());
      return;
    }
    if (currentNotice?.code === code && currentNotice?.detail === detail) return;
    currentNotice = notice(code, detail);
    handlers.onNotice?.(currentNotice);
    handlers.onStateChange?.(snapshot());
  }

  /* ------------------------------------------------------------- readiness -- */

  /**
   * Ask the engine whether an on-device pack exists. No microphone, no gesture,
   * no audio — safe to call at mount, which is the point: `start()` has to be
   * synchronous inside a click, so all the asynchronous work happens here.
   *
   * @param {{lang?: string}} [opts]
   * @returns {Promise<string>} an `Availability` value.
   */
  async function probe(opts = {}) {
    const Ctor = getCtor();
    if (!Ctor) return Availability.UNAVAILABLE;
    if (typeof Ctor.available !== 'function') return Availability.UNKNOWN;
    const langs = [opts.lang ?? currentLang];
    try {
      const result = await Ctor.available({ langs, processLocally: true });
      const value = String(result ?? '');
      return Object.values(Availability).includes(value) ? value : Availability.UNKNOWN;
    } catch (error) {
      handlers.onError?.({ code: 'available-threw', disposition: 'benign', message: String(error) });
      return Availability.UNKNOWN;
    }
  }

  /**
   * Decide the mode and publish the notice, *before* any microphone opens.
   *
   * @param {{lang?: string}} [opts]
   * @returns {Promise<{mode: string, availability: string, notice: object|null}>}
   */
  async function prepare(opts = {}) {
    if (opts.lang) currentLang = opts.lang;
    const Ctor = getCtor();
    if (!Ctor) {
      mode = SttMode.UNAVAILABLE;
      availability = Availability.UNAVAILABLE;
      prepared = true;
      setState(RecognizerState.UNSUPPORTED);
      setNotice(NoticeCode.UNSUPPORTED);
      return { mode, availability, notice: currentNotice };
    }

    setState(RecognizerState.PREPARING);
    availability = await probe();
    prepared = true;
    applyAvailability();
    setState(mode === SttMode.UNAVAILABLE ? RecognizerState.UNSUPPORTED : RecognizerState.IDLE);
    return { mode, availability, notice: currentNotice };
  }

  /**
   * Turn an availability verdict into a mode plus the notice that verdict owes
   * the user. Split out because the error path re-runs it after a downgrade.
   */
  function applyAvailability() {
    if (availability === Availability.AVAILABLE && !localRefused) {
      mode = SttMode.LOCAL;
      setNotice(NoticeCode.LOCAL);
      return;
    }
    // UNKNOWN means the engine has no `available()` static — i.e. it is not the
    // Chrome on-device implementation, so the audio goes somewhere.
    if (availability === Availability.UNKNOWN || localRefused) {
      mode = cloudAllowed ? SttMode.CLOUD : SttMode.UNAVAILABLE;
      setNotice(cloudAllowed ? NoticeCode.CLOUD : NoticeCode.BLOCKED);
      return;
    }
    if (availability === Availability.DOWNLOADING) {
      mode = cloudAllowed ? SttMode.CLOUD : SttMode.UNAVAILABLE;
      setNotice(NoticeCode.DOWNLOADING);
      return;
    }
    if (availability === Availability.DOWNLOADABLE) {
      // The honest state: local is *possible* but not installed. Offer the
      // install, and say plainly what happens until it is taken.
      mode = cloudAllowed ? SttMode.CLOUD : SttMode.UNAVAILABLE;
      setNotice(cloudAllowed ? NoticeCode.CLOUD : NoticeCode.DOWNLOADABLE);
      return;
    }
    mode = cloudAllowed ? SttMode.CLOUD : SttMode.UNAVAILABLE;
    setNotice(cloudAllowed ? NoticeCode.CLOUD : NoticeCode.BLOCKED);
  }

  /** @returns {boolean} Whether an on-device pack can be installed right now. */
  function canInstall() {
    return typeof getCtor()?.install === 'function'
      && (availability === Availability.DOWNLOADABLE || availability === Availability.DOWNLOADING);
  }

  /**
   * Download the on-device pack. Must be called from a user gesture — Chrome
   * gates the download on transient activation, same as any other user-visible
   * fetch of that size.
   *
   * @param {{lang?: string}} [opts]
   * @returns {Promise<boolean>}
   */
  async function install(opts = {}) {
    const Ctor = getCtor();
    if (typeof Ctor?.install !== 'function') return false;
    const langs = [opts.lang ?? currentLang];
    setNotice(NoticeCode.DOWNLOADING);
    try {
      const ok = await Ctor.install({ langs, processLocally: true });
      availability = await probe();
      localRefused = false;
      applyAvailability();
      return Boolean(ok) && mode === SttMode.LOCAL;
    } catch (error) {
      handlers.onError?.({ code: 'install-failed', disposition: 'benign', message: String(error) });
      availability = await probe();
      applyAvailability();
      return false;
    }
  }

  /* ------------------------------------------------------------------ mic -- */

  /**
   * The mode `start()` will use, decided synchronously.
   *
   * When `prepare()` never ran we do NOT guess cloud: if the engine exposes the
   * on-device statics at all we ask for `processLocally` and let the engine
   * refuse with `language-not-supported`, which the error path then downgrades.
   * A wrong guess toward local costs one failed start; a wrong guess toward
   * cloud costs the user's audio, and that is not recoverable by retrying.
   *
   * @returns {string} an `SttMode`.
   */
  function plannedMode() {
    if (prepared) return mode;
    const Ctor = getCtor();
    if (!Ctor) return SttMode.UNAVAILABLE;
    if (localRefused) return cloudAllowed ? SttMode.CLOUD : SttMode.UNAVAILABLE;
    if (typeof Ctor.available === 'function') return SttMode.LOCAL;
    return cloudAllowed ? SttMode.CLOUD : SttMode.UNAVAILABLE;
  }

  /**
   * Open the microphone. **Synchronous, and must be called from a user
   * gesture** — both the microphone permission and, on several engines,
   * `speechSynthesis` itself are gated on one. Nothing here awaits, so the
   * gesture is still live when `engine.start()` runs.
   *
   * @returns {boolean} Whether a session was started.
   */
  function start() {
    if (disposed) return false;
    if (state === RecognizerState.LISTENING || state === RecognizerState.STARTING) return true;

    const Ctor = getCtor();
    if (!Ctor) {
      mode = SttMode.UNAVAILABLE;
      setState(RecognizerState.UNSUPPORTED);
      setNotice(NoticeCode.UNSUPPORTED);
      return false;
    }

    const planned = plannedMode();
    if (planned === SttMode.UNAVAILABLE) {
      // Strict local-only with no pack: refuse rather than upload. The notice is
      // already the explanation; this is the enforcement.
      setNotice(cloudAllowed ? NoticeCode.UNSUPPORTED : NoticeCode.BLOCKED);
      setState(RecognizerState.IDLE);
      return false;
    }
    mode = planned;
    if (!prepared) applyPlannedNotice(planned);

    session += 1;
    const token = session;

    let instance;
    try {
      instance = new Ctor();
    } catch (error) {
      handlers.onError?.({ code: 'construct-failed', disposition: 'fatal', message: String(error) });
      setState(RecognizerState.ERROR);
      return false;
    }

    instance.lang = currentLang;
    instance.continuous = continuous;
    instance.interimResults = interimResults;
    instance.maxAlternatives = maxAlternatives;
    // Only ever assigned true. Assigning `false` on an engine that has the
    // property is a request to use the network, and we never request that
    // explicitly — cloud is what you get by not asking for local.
    if (planned === SttMode.LOCAL) instance.processLocally = true;

    const built = buildPhrases(currentPhrases, phraseBoost, getPhrase());
    biasingApplied = false;
    if (built) {
      try {
        instance.phrases = built;
        biasingApplied = true;
      } catch { /* engine has the constructor but not the property */ }
    } else if (currentPhrases.length > 0 && !getPhrase()) {
      setNotice(NoticeCode.PHRASES_UNSUPPORTED);
    }

    wire(instance, token);
    engine = instance;
    setState(RecognizerState.STARTING);

    try {
      instance.start();
      return true;
    } catch (error) {
      // Chrome throws synchronously when `processLocally` is set and the pack is
      // missing — the same condition the async `language-not-supported` error
      // reports, so it takes the same downgrade path.
      engine = null;
      setState(RecognizerState.IDLE);
      return handleFailure('language-not-supported', String(error), token);
    }
  }

  /** Publish the notice implied by an unprepared start. */
  function applyPlannedNotice(planned) {
    if (planned === SttMode.LOCAL) setNotice(NoticeCode.LOCAL);
    else setNotice(NoticeCode.CLOUD);
  }

  /**
   * @param {object} instance
   * @param {number} token
   */
  function wire(instance, token) {
    const live = () => !disposed && token === session;

    instance.onstart = () => { if (live()) setState(RecognizerState.LISTENING); };

    instance.onspeechstart = () => {
      if (!live()) return;
      if (bargeInOnSpeech) handlers.onSpeechStart?.();
    };

    instance.onresult = (event) => {
      if (!live()) return;
      const result = readResult(event);
      if (!result) return;
      handlers.onResult?.(result);
      if (result.isFinal) handlers.onFinal?.(result.transcript);
    };

    instance.onerror = (event) => {
      if (!live()) return;
      handleFailure(event?.error ?? 'unknown', event?.message, token);
    };

    instance.onend = () => {
      if (!live()) return;
      engine = null;
      setState(RecognizerState.IDLE);
      if (keepListening && !localRefusedBlocks()) scheduleRestart();
    };
  }

  function localRefusedBlocks() {
    return mode === SttMode.UNAVAILABLE;
  }

  /**
   * @param {string} code
   * @param {string} [message]
   * @param {number} [token]
   * @returns {boolean} Whether a replacement session was started.
   */
  function handleFailure(code, message, token) {
    const disposition = ERROR_DISPOSITION[code] ?? 'fatal';
    handlers.onError?.({ code, disposition, message });

    if (disposition === 'downgrade') {
      if (downgrading) { stopEngine(); setState(RecognizerState.ERROR); return false; }
      if (code === 'phrases-not-supported') {
        // Biasing is a nicety; losing it must not lose the session.
        currentPhrases = [];
        biasingApplied = false;
        setNotice(NoticeCode.PHRASES_UNSUPPORTED);
        stopEngine();
        downgrading = true;
        try { return start(); } finally { downgrading = false; }
      }
      if (localRefused) {
        // We are already on the cloud path and it refuses the language too.
        // There is nowhere left to fall back to, and retrying would restart the
        // engine on every error event forever.
        stopEngine();
        setState(RecognizerState.ERROR);
        return false;
      }
      // `language-not-supported` under `processLocally` is the load-bearing case:
      // the on-device pack is not there. This is the moment the local-only
      // premise breaks, so it is the moment the user has to be told — before any
      // cloud session opens, not after.
      localRefused = true;
      availability = Availability.UNAVAILABLE;
      stopEngine();
      applyAvailability();
      if (mode === SttMode.CLOUD) {
        downgrading = true;
        try { return start(); } finally { downgrading = false; }
      }
      setState(RecognizerState.IDLE);
      return false;
    }

    if (disposition === 'fatal') {
      keepListening = false;
      stopEngine();
      setState(RecognizerState.ERROR);
      if (code === 'not-allowed' || code === 'service-not-allowed') setNotice(NoticeCode.MIC_DENIED);
      else if (code === 'audio-capture') setNotice(NoticeCode.NO_MIC);
      return false;
    }

    if (disposition === 'retry') {
      // ⚠️ A `network` error in LOCAL mode means the session was never local.
      // Say so rather than silently retrying against a server.
      if (mode === SttMode.LOCAL) {
        localRefused = true;
        stopEngine();
        applyAvailability();
        return false;
      }
      setNotice(NoticeCode.NETWORK);
      return false;
    }

    // benign: `no-speech` and `aborted`. `onend` follows and handles restarting.
    if (token !== undefined && token !== session) return false;
    return false;
  }

  function scheduleRestart() {
    if (restartHandle !== null) return;
    restartHandle = setTimer(() => {
      restartHandle = null;
      if (!disposed && keepListening) start();
    }, RESTART_DELAY_MS);
  }

  function stopEngine() {
    if (restartHandle !== null) { clearTimer(restartHandle); restartHandle = null; }
    const instance = engine;
    engine = null;
    session += 1; // invalidate every handler still attached to the old instance
    if (instance) {
      try { instance.abort?.(); } catch { /* already gone */ }
    }
    // The state must fall back to IDLE here, not in the callers: the downgrade
    // path calls `start()` immediately afterwards, and `start()` short-circuits
    // on a LISTENING state. Leaving it set is what makes a downgrade silently
    // do nothing.
    setState(RecognizerState.IDLE);
  }

  /**
   * Finish the current utterance and stop. Unlike `abort()`, a result that has
   * been heard but not finalised still arrives.
   * @returns {boolean}
   */
  function stop() {
    keepListening = false;
    if (restartHandle !== null) { clearTimer(restartHandle); restartHandle = null; }
    if (!engine) { setState(RecognizerState.IDLE); return false; }
    setState(RecognizerState.STOPPING);
    try { engine.stop(); return true; } catch { stopEngine(); setState(RecognizerState.IDLE); return false; }
  }

  /**
   * Drop everything immediately, including a part-heard utterance.
   * @returns {boolean}
   */
  function abort() {
    keepListening = false;
    const had = Boolean(engine);
    stopEngine();
    setState(RecognizerState.IDLE);
    return had;
  }

  /* ------------------------------------------------------------------ misc -- */

  return {
    /* readiness — none of these touch the microphone */
    probe,
    prepare,
    install,
    canInstall,
    /** @returns {boolean} Whether this environment has a recogniser at all. */
    isSupported: () => Boolean(getCtor()),
    /** @returns {boolean} Whether on-device recognition is reachable here. */
    canGoLocal: () => typeof getCtor()?.available === 'function',

    /* the microphone */
    start,
    stop,
    abort,

    /* state */
    getState: snapshot,
    /** @returns {string} an `SttMode`. */
    getMode: () => mode,
    /** @returns {object|null} The sticky notice. */
    getNotice: () => currentNotice,
    /** @returns {boolean} ⚠️ True when audio is leaving this machine. */
    isCloud: () => mode === SttMode.CLOUD,
    isListening: () => state === RecognizerState.LISTENING || state === RecognizerState.STARTING,

    /* configuration */
    /**
     * Replace the contextual biasing list — the in-window place names. Takes
     * effect on the next `start()`, because the engine reads `phrases` once.
     * @param {string[]} next
     */
    setPhrases(next) { currentPhrases = Array.isArray(next) ? [...next] : []; },
    getPhrases: () => [...currentPhrases],
    /** @param {string} next */
    setLang(next) {
      if (!next || next === currentLang) return;
      currentLang = next;
      prepared = false;
      localRefused = false;
      availability = Availability.UNKNOWN;
      mode = SttMode.UNKNOWN;
    },
    getLang: () => currentLang,
    /**
     * Turn the cloud fallback on or off at runtime — the user-facing
     * "never upload my audio" switch.
     * @param {boolean} allowed
     */
    setAllowCloud(allowed) {
      cloudAllowed = Boolean(allowed);
      if (prepared || localRefused) applyAvailability();
    },
    isCloudAllowed: () => cloudAllowed,
    /** @param {Partial<typeof handlers>} next */
    setHandlers(next) { Object.assign(handlers, next); },

    dispose() {
      disposed = true;
      keepListening = false;
      stopEngine();
      state = RecognizerState.IDLE;
    },
  };
}
