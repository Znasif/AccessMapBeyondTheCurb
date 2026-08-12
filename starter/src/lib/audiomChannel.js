/**
 * AudiomChannel — milestone 5b.
 *
 * Implements §2.2 of `docs/browser-voice-exploration-plan.md`: the *writes* half
 * of the Audiom integration. `adapters/audiomWorldAdapter.js` owns the reads
 * (`GET /map-definitions/:id/layers`); this module owns the side-effect channel,
 * which is reachable only through `postMessage` into the embed iframe.
 *
 *   → { type: 'getState' }                                        initial sync
 *   → { type: 'moveAvatar',      payload: { position: [lng,lat] } }
 *   → { type: 'executeCommand',  payload: { command } }
 *   ← ready | stateChanged | featureEntered | featureSelected | error
 *
 * The point of the channel, and the reason there is no path-narration code
 * anywhere near it: `route_to` mode `fly_me_there` DRIVES AUDIOM'S OWN AVATAR
 * and lets Audiom's own audio do the work. We do not compute a path and read it
 * out; we move the avatar and Audiom speaks. Same for `executeCommand` — those
 * are Audiom's built-in commands, invoked, not reimplemented.
 *
 * `featureEntered` is the `liveFeatureStream` capability. Per §3.2 of
 * `docs/local-llm-tooling-design.md`, `whats_here` on this route is answered from
 * the last `featureEntered` payload **at L0, with no inference at all** — the
 * channel keeps that payload so a dispatcher can read it synchronously, and
 * `whatsHere()` formats it. Tier C nuance (§2.2): the payload carries names and
 * nothing else, so the answer is name-only and must NOT escalate to L3 to invent
 * the adjacency half of the tool description. Under Tier A the adjacency comes
 * from the adapter's cached geometry instead, never from the model.
 *
 * PLATFORM-FREE ON PURPOSE, exactly like `worldAdapter.js` and the adapters, and
 * for the same reason — this module is exercised from Node in
 * `scripts/test_audiom_channel.mjs`. Nothing here reads `import.meta.env`,
 * `window` or `document`; the transport is injected:
 *
 *   - **`post(message, origin)`** sends one message. Return `false` to say "no
 *     target right now" (the iframe has no `contentWindow` mid-reload); anything
 *     else counts as sent.
 *   - **`subscribe(handler)`** delivers inbound `{ origin, data }` and returns an
 *     unsubscribe function. Called once, at construction.
 *   - **`origin`** is the expected sender AND the `postMessage` target — the same
 *     `AUDIOM_ORIGIN` value `audiom.js` derives. Origin filtering lives here so
 *     it is covered by the Node checks rather than by the component.
 *
 * ⚠️ Deliberately NOT imported: `../audiom.js`. It evaluates `import.meta.env` at
 * module scope, which makes it un-importable outside Vite (the known debt in
 * §5.1). The caller passes `AUDIOM_ORIGIN` in.
 */

/** Messages we send into the embed. */
export const OUTBOUND = Object.freeze({
  GET_STATE: 'getState',
  MOVE_AVATAR: 'moveAvatar',
  EXECUTE_COMMAND: 'executeCommand',
});

/** Messages the embed sends us. */
export const INBOUND = Object.freeze({
  READY: 'ready',
  STATE_CHANGED: 'stateChanged',
  FEATURE_ENTERED: 'featureEntered',
  FEATURE_SELECTED: 'featureSelected',
  ERROR: 'error',
});

/** The two inbound messages that make up the live feature-under-cursor stream. */
export const FEATURE_EVENTS = Object.freeze([INBOUND.FEATURE_ENTERED, INBOUND.FEATURE_SELECTED]);

/**
 * How long `getState()` waits for a `stateChanged` before giving up. 1200 ms is
 * the value the bounds probe in `AudiomMap` was tuned against — the probe issues
 * ~90 of these per map, so raising it raises discovery time linearly.
 */
export const DEFAULT_STATE_TIMEOUT_MS = 1200;

/** The L0 answer when the avatar has not entered any named feature yet. */
export const NOTHING_HERE = 'Nothing here yet.';

/**
 * Normalise an avatar position to the `[lng, lat]` pair the embed expects.
 * Accepts `{ lng, lat }` (what `coordRef` holds) or `[lng, lat]` (what
 * `stateChanged` returns, so a position can be round-tripped unchanged).
 *
 * @param {{lng: number, lat: number}|number[]|null|undefined} position
 * @returns {number[]|null} `[lng, lat]`, or null when either value is not finite.
 */
export function toPosition(position) {
  if (!position) return null;
  const lng = Array.isArray(position) ? position[0] : position.lng;
  const lat = Array.isArray(position) ? position[1] : position.lat;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return [lng, lat];
}

/**
 * The names carried by a `featureEntered` / `featureSelected` payload.
 * Lifted verbatim from `AudiomMap.jsx`'s handler — this one line is the whole
 * of what tier C gives us about the feature under the avatar.
 *
 * @param {{features?: Array<{name?: string}>}|null|undefined} payload
 * @returns {string[]}
 */
export function featureNames(payload) {
  return (payload?.features || []).map((f) => f?.name).filter(Boolean);
}

/**
 * The L0 `whats_here` answer for a feature record. NO INFERENCE: the names, in
 * the order the embed reported them, and nothing else. Sentence shaping,
 * category guesses and adjacency are L3's business and are not available at this
 * tier anyway.
 *
 * The join matches the status line's join so the spoken answer and the visible
 * one cannot drift apart.
 *
 * @param {{names?: string[]}|null|undefined} feature
 * @param {{empty?: string}} [options]
 * @returns {string}
 */
export function whatsHere(feature, options = {}) {
  const empty = options.empty ?? NOTHING_HERE;
  const names = feature?.names || [];
  return names.length ? names.join(', ') : empty;
}

/* ------------------------------------------------------- feature cadence -- */

/**
 * The staleness threshold M7's dispatcher uses to decide whether the last
 * `featureEntered` is still trustworthy enough for the L0 fast path.
 *
 * ⚠️ THIS NUMBER IS A GUESS. Nobody has measured Audiom's actual event cadence
 * under a moving avatar, and it is load bearing in both directions: too high and
 * the system confidently narrates a feature the finger has already left; too low
 * and it escalates to a 1-3 s L3 round trip for no reason. `createFeatureTimingRecorder`
 * below exists to replace it with a distribution — see `dumpFeatureTiming()`.
 * It lives here rather than in the dispatcher so the measurement and the
 * threshold it is measuring cannot drift apart.
 */
export const LIVE_FEATURE_MAX_AGE_MS = 3000;

/** Ring-buffer size for the recorder. ~500 events is several minutes of tracing. */
export const DEFAULT_TIMING_CAPACITY = 500;

const quantile = (sorted, q) => {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i];
};

const EMPTY_STATS = Object.freeze({
  count: 0, min: null, p50: null, p90: null, p95: null, max: null, mean: null,
});

const describe = (values) => {
  // Always the same shape, so a caller never has to distinguish "no samples"
  // from "field missing" — `format()` prints "—" either way.
  if (!values.length) return { ...EMPTY_STATS };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    min: sorted[0],
    p50: quantile(sorted, 0.5),
    p90: quantile(sorted, 0.9),
    p95: quantile(sorted, 0.95),
    max: sorted[sorted.length - 1],
    mean: Math.round(sum / sorted.length),
  };
};

const ms = (n) => (n === null || n === undefined ? '—' : `${Math.round(n)} ms`);

/**
 * Records inter-arrival times of the live feature stream, so the M7 staleness
 * threshold becomes a measurement instead of a guess.
 *
 * OFF BY DEFAULT and never constructed unless someone asks — the channel holds
 * `null` and pays one truthiness check per inbound feature event. It never logs
 * on its own; `format()` is called by a human.
 *
 * Two deltas are kept per sample because they answer different questions:
 *   - `delta`     — since the previous event of ANY type. This is what the
 *                   staleness threshold actually races against.
 *   - `typeDelta` — since the previous event of the SAME type, which is how you
 *                   see whether `featureSelected` interleaves on its own rhythm
 *                   or only ever arrives alongside a `featureEntered`.
 *
 * @param {object} [options]
 * @param {number} [options.capacity]
 * @param {number} [options.threshold] The candidate `LIVE_FEATURE_MAX_AGE_MS`.
 * @param {string} [options.label] Shown in `format()` — e.g. the map id.
 */
export function createFeatureTimingRecorder(options = {}) {
  const capacity = options.capacity ?? DEFAULT_TIMING_CAPACITY;
  const threshold = options.threshold ?? LIVE_FEATURE_MAX_AGE_MS;
  let label = options.label ?? '';

  /** @type {Array<{type: string, at: number, delta: number|null, typeDelta: number|null, names: string[], changed: boolean}>} */
  const samples = [];
  let previous = null;
  /** @type {Record<string, object>} */
  const previousByType = {};
  let dropped = 0;

  return {
    threshold,
    get label() { return label; },
    set label(value) { label = value; },

    /**
     * @param {{type: string, at: number, names?: string[]}} event Named AND
     *   unnamed feature messages are recorded — an unnamed one still proves the
     *   avatar moved, which is information the threshold cares about.
     */
    record(event) {
      const names = event.names || [];
      const sample = {
        type: event.type,
        at: event.at,
        delta: previous ? event.at - previous.at : null,
        typeDelta: previousByType[event.type] ? event.at - previousByType[event.type].at : null,
        names,
        changed: !previous || previous.names.join(' ') !== names.join(' '),
      };
      samples.push(sample);
      if (samples.length > capacity) { samples.shift(); dropped += 1; }
      previous = sample;
      previousByType[event.type] = sample;
      return sample;
    },

    /** @returns {Array<object>} The raw ring buffer, oldest first. */
    samples() { return [...samples]; },

    /** @returns {number[]} Just the any-type inter-arrival times. */
    deltas() { return samples.map((s) => s.delta).filter((d) => d !== null); },

    reset() {
      samples.length = 0;
      previous = null;
      for (const key of Object.keys(previousByType)) delete previousByType[key];
      dropped = 0;
    },

    /** @returns {object} Machine-readable stats. */
    summary() {
      const deltas = samples.map((s) => s.delta).filter((d) => d !== null);
      const byType = {};
      for (const type of FEATURE_EVENTS) {
        const own = samples.filter((s) => s.type === type);
        byType[type] = {
          ...describe(own.map((s) => s.typeDelta).filter((d) => d !== null)),
          events: own.length,
          named: own.filter((s) => s.names.length > 0).length,
        };
      }
      const stale = deltas.filter((d) => d > threshold);
      return {
        label,
        threshold,
        events: samples.length,
        dropped,
        named: samples.filter((s) => s.names.length > 0).length,
        repeats: samples.filter((s) => !s.changed).length,
        spanMs: samples.length > 1 ? samples[samples.length - 1].at - samples[0].at : 0,
        interArrival: describe(deltas),
        byType,
        overThreshold: {
          threshold,
          count: stale.length,
          fraction: deltas.length ? stale.length / deltas.length : 0,
        },
      };
    },

    /** @returns {string} The same thing, readable without a debugger. */
    format() {
      const s = this.summary();
      if (!s.events) return `feature cadence${label ? ` (${label})` : ''}: no events recorded yet`;
      const a = s.interArrival;
      const pct = (s.overThreshold.fraction * 100).toFixed(1);
      const lines = [
        `feature cadence${label ? ` (${label})` : ''}: ${s.events} events over ${(s.spanMs / 1000).toFixed(1)} s`
          + `${s.dropped ? ` (+${s.dropped} dropped from the ring buffer)` : ''}`,
        `  named ${s.named}/${s.events}   unchanged-name repeats ${s.repeats}`,
        `  inter-arrival  min ${ms(a.min)}  p50 ${ms(a.p50)}  p90 ${ms(a.p90)}`
          + `  p95 ${ms(a.p95)}  max ${ms(a.max)}  mean ${ms(a.mean)}   n=${a.count}`,
      ];
      for (const type of FEATURE_EVENTS) {
        const t = s.byType[type];
        lines.push(`  ${type.padEnd(15)} ${String(t.events).padStart(4)} events`
          + `  ${String(t.named).padStart(4)} named`
          + `  same-type p50 ${ms(t.p50)}  p90 ${ms(t.p90)}`);
      }
      lines.push(`  gaps over LIVE_FEATURE_MAX_AGE_MS=${s.threshold}: ${s.overThreshold.count} of ${a.count} (${pct}%)`
        + ` — the L0 fast path would have escalated that often`);
      lines.push(`  deltas: ${this.deltas().join(', ')}`);
      return lines.join('\n');
    },
  };
}

/**
 * @typedef {object} FeatureRecord
 * @property {string} type Which message produced it — `featureEntered` or
 *   `featureSelected`. Kept because a *selection* is a deliberate act and a
 *   dispatcher may want to weight it differently from a drive-by entry.
 * @property {string[]} names
 * @property {string} text `names` joined for display — what the status line shows.
 * @property {Array<object>} features The raw `payload.features`, untouched.
 * @property {number} at Milliseconds, from the injected clock.
 */

const defaultHandlerError = (error) => {
  if (typeof console !== 'undefined') console.error('[audiomChannel] listener threw', error);
};

/**
 * Create a channel over an injected transport.
 *
 * @param {object} options
 * @param {(message: object, origin: string) => unknown} options.post
 * @param {(handler: (event: {origin: string, data: any}) => void) => (() => void)} [options.subscribe]
 * @param {string} options.origin Expected sender and `postMessage` target.
 * @param {number} [options.timeoutMs] Default `getState` timeout.
 * @param {(fn: () => void, ms: number) => any} [options.setTimer]
 * @param {(id: any) => void} [options.clearTimer]
 * @param {() => number} [options.now]
 * @param {(error: unknown) => void} [options.onHandlerError]
 * @param {ReturnType<typeof createFeatureTimingRecorder>} [options.timing] Start
 *   with cadence recording already on. Normally left off and switched on from
 *   the console via `enableFeatureTiming()`.
 */
export function createAudiomChannel(options = {}) {
  const {
    post,
    subscribe,
    origin,
    timeoutMs = DEFAULT_STATE_TIMEOUT_MS,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (id) => clearTimeout(id),
    now = () => Date.now(),
    onHandlerError = defaultHandlerError,
  } = options;

  if (typeof post !== 'function') throw new Error('createAudiomChannel: `post` is required');
  if (!origin) throw new Error('createAudiomChannel: `origin` is required');

  /** @type {Set<Function>} */
  const messageHandlers = new Set();
  /** @type {Set<Function>} */
  const featureHandlers = new Set();
  /** @type {FeatureRecord|null} */
  let lastFeature = null;
  let disposed = false;
  /**
   * Null until someone calls `enableFeatureTiming()`. While it is null the
   * instrumentation costs exactly one truthiness check per feature event and
   * allocates nothing — see `LIVE_FEATURE_MAX_AGE_MS` for why it exists.
   * @type {ReturnType<typeof createFeatureTimingRecorder>|null}
   */
  let timing = options.timing ?? null;

  const fanOut = (handlers, ...args) => {
    // Iterate a copy, and isolate throws: one bad subscriber must not break the
    // bounds probe, which is what a single shared `window` listener would do.
    for (const handler of [...handlers]) {
      try { handler(...args); } catch (error) { onHandlerError(error); }
    }
  };

  function dispatch(event) {
    if (disposed) return;
    if (!event || event.origin !== origin) return;
    const { type, payload } = event.data || {};
    if (!type) return;

    if (FEATURE_EVENTS.includes(type)) {
      const names = featureNames(payload);
      // ONE clock read per event: the cadence sample and the record must carry
      // the same instant, or the measured inter-arrival times are the clock's
      // call pattern rather than the stream's.
      const at = now();
      // Timed BEFORE the named-only filter: an unnamed featureEntered still
      // proves the avatar crossed something, and the staleness threshold races
      // against the stream's real cadence, not against the filtered one.
      if (timing) timing.record({ type, names, at });
      // Only a NAMED feature updates the record. An empty payload means the
      // avatar is over something unnamed, which is not the same as "nowhere" —
      // `AudiomMap` has always kept the previous name on screen in that case.
      if (names.length) {
        lastFeature = {
          type,
          names,
          text: names.join(', '),
          features: payload?.features || [],
          at,
        };
        fanOut(featureHandlers, lastFeature);
      }
    }

    fanOut(messageHandlers, type, payload, event);
  }

  const unsubscribe = typeof subscribe === 'function' ? subscribe(dispatch) : null;

  /**
   * Send one message to the embed, targeted at `origin`.
   * @param {object} message
   * @returns {boolean} Whether the transport had somewhere to send it.
   */
  function send(message) {
    if (disposed) return false;
    return post(message, origin) !== false;
  }

  return {
    origin,
    send,

    /**
     * Move Audiom's avatar. This is `route_to` mode `fly_me_there` and the
     * fingertip stream both — the embed's own audio narrates the result.
     * @param {{lng: number, lat: number}|number[]} position
     * @returns {boolean} False when the position is not finite or nothing was sent.
     */
    moveAvatar(position) {
      const pos = toPosition(position);
      if (!pos) return false;
      return send({ type: OUTBOUND.MOVE_AVATAR, payload: { position: pos } });
    },

    /**
     * Invoke one of Audiom's built-in commands (`up`, `left`, …). Also the
     * movement half of the tier-C bounds probe: a command only moves the avatar
     * while it is INSIDE the map, which is the oracle the binary search reads.
     * @param {string} command
     * @returns {boolean}
     */
    executeCommand(command) {
      if (!command) return false;
      return send({ type: OUTBOUND.EXECUTE_COMMAND, payload: { command } });
    },

    /**
     * Ask for the avatar's position and resolve on the first `stateChanged`.
     * Resolves null on timeout rather than rejecting: every caller treats "no
     * answer" as "stop probing", and a rejection would have to be caught at each
     * of the ~90 probe steps.
     * @param {{timeoutMs?: number}} [opts]
     * @returns {Promise<number[]|null>} `[lng, lat]`.
     */
    getState(opts = {}) {
      const wait = opts.timeoutMs ?? timeoutMs;
      return new Promise((resolve) => {
        let done = false;
        let timer = null;
        const handler = (type, payload) => {
          if (type !== INBOUND.STATE_CHANGED) return;
          finish(payload?.position || null);
        };
        const finish = (value) => {
          if (done) return;
          done = true;
          if (timer !== null) clearTimer(timer);
          messageHandlers.delete(handler);
          resolve(value);
        };
        // Listen BEFORE asking, so a synchronous reply cannot be missed.
        messageHandlers.add(handler);
        timer = setTimer(() => finish(null), wait);
        if (!send({ type: OUTBOUND.GET_STATE })) finish(null);
      });
    },

    /**
     * Subscribe to every inbound message from the embed, already origin-filtered.
     * @param {(type: string, payload: any, event: object) => void} handler
     * @returns {() => void} Unsubscribe.
     */
    onMessage(handler) {
      messageHandlers.add(handler);
      return () => messageHandlers.delete(handler);
    },

    /**
     * Subscribe to the live feature stream. Fires only for payloads that carry
     * at least one name.
     * @param {(record: FeatureRecord) => void} handler
     * @returns {() => void} Unsubscribe.
     */
    onFeature(handler) {
      featureHandlers.add(handler);
      return () => featureHandlers.delete(handler);
    },

    /**
     * The last named feature the avatar entered, readable SYNCHRONOUSLY — this
     * is what makes `whats_here` cost zero inference and zero round trips.
     * @returns {FeatureRecord|null}
     */
    getLastFeature() {
      return lastFeature;
    },

    /**
     * The L0 `whats_here` answer. See `whatsHere()` — names only, no inference.
     * @param {{empty?: string}} [opts]
     * @returns {string}
     */
    whatsHere(opts) {
      return whatsHere(lastFeature, opts);
    },

    /* ------------------------------------------------ feature cadence -- */

    /**
     * Start timing the feature stream. Off until called; calling it twice keeps
     * the existing recorder so a second console call does not silently discard
     * the samples already collected (pass `{ reset: true }` to start over).
     *
     * @param {object} [opts] Forwarded to `createFeatureTimingRecorder`, plus
     *   `reset` to clear an existing recorder.
     * @returns {ReturnType<typeof createFeatureTimingRecorder>}
     */
    enableFeatureTiming(opts = {}) {
      if (!timing) timing = createFeatureTimingRecorder(opts);
      else if (opts.reset) timing.reset();
      return timing;
    },

    /** Stop timing and drop the samples. @returns {void} */
    disableFeatureTiming() {
      timing = null;
    },

    /** @returns {ReturnType<typeof createFeatureTimingRecorder>|null} */
    getFeatureTiming() {
      return timing;
    },

    /**
     * Print the cadence table and return it. The one call a human makes from the
     * browser console after moving the avatar around for a minute; the only
     * place this module ever writes to the console.
     * @returns {string}
     */
    dumpFeatureTiming() {
      const text = timing
        ? timing.format()
        : 'feature cadence: not recording — call enableFeatureTiming() first, '
          + 'then move the avatar, then call this again';
      if (typeof console !== 'undefined') console.log(text);
      return text;
    },

    /** @returns {boolean} */
    isDisposed() {
      return disposed;
    },

    /** Detach the transport. Sends after this are no-ops. */
    dispose() {
      if (disposed) return;
      disposed = true;
      messageHandlers.clear();
      featureHandlers.clear();
      timing = null;
      unsubscribe?.();
    },
  };
}
