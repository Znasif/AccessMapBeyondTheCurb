/**
 * TurnContext — milestone 7.
 *
 * The schema's `injectedContext`: everything the dispatcher supplies on every
 * tool call and the model never writes. One **frozen snapshot per turn**, taken
 * at turn open, never a live read.
 *
 * ## Why a snapshot
 *
 * A tool loop runs 2–4 rounds over 1–3 s. Reading the finger position live
 * inside each handler means two tool calls in one turn answer about two
 * different finger positions, and the narration that stitches them together is
 * internally inconsistent — *"the park is 20 mm to your left, and you are
 * standing in the museum"* — with no way for the model to detect it. Freezing at
 * turn open makes every answer in a turn describe one instant, and makes the
 * turn reproducible from the log, which is what the escalation-log-as-training-
 * batch idea depends on.
 *
 * It also makes memoization sound: memo keys are computed from the context at
 * turn open, and a mid-loop mutation would cache a result under a key that never
 * produced it. A handler that wants to change preferences writes to the **prefs
 * store**, and the change takes effect on the next turn.
 *
 * The cost is that a fast-moving finger gets a slightly stale answer. That is
 * the right trade: the L0 path (`l0.js`), which is what a sweeping finger
 * actually exercises, opens and closes inside a single sample.
 *
 * ## The two `(u, v)` spaces
 *
 * The codebase contains two, and conflating them is a silent geometric error:
 *
 *   - **material uv** — normalised over the physical sheet, from 4-corner
 *     registration. This is what `surface.acuityCell()` means: it quantizes in
 *     millimetres of material.
 *   - **window uv** — normalised over the depicted artwork, i.e. material uv
 *     with the letterbox margins removed. This is what `adapter.at()`,
 *     `nearby()`, `distanceTo()` and `bearingTo()` consume.
 *
 * They coincide whenever `materialAspect === bboxAspect`, which is the default
 * and is why nothing has broken. The context carries both, named apart, and each
 * consumer gets the one it means. ⚠️ **Never compute `acuityCell` from window
 * uv, and never hand material uv to an adapter.** `assertConversions()` below
 * exists to make a mistake here loud in the harnesses.
 *
 * `(u, v)` itself is a **perception artifact** and stops at the adapter
 * boundary: it addresses a point on a piece of material, and the adapters
 * convert it exactly once into world-native coordinates. Nothing a tool returns
 * carries a `u` or a `v`.
 *
 * Platform-free: nothing here touches `window`, `document`, `performance` or
 * `Date` except through `sources.now`.
 */

/** Decimal places for {@link windowIdOf}. Matches layerloader's own truncation (§0.3). */
export const WINDOW_ID_PRECISION = 5;

/**
 * Stable id for a window.
 *
 * The rounding is load-bearing rather than cosmetic: `subWindow` recomputes the
 * bbox from a floating-point centre and fraction, so returning to "the same"
 * window produces bit-different numbers. An unrounded id would miss the place
 * index cache on every return and re-embed 3,004 places.
 *
 * @param {number[]|null|undefined} window `[minX, minY, maxX, maxY]`.
 * @returns {string}
 */
export function windowIdOf(window) {
  if (!Array.isArray(window) || window.length !== 4 || !window.every(Number.isFinite)) {
    return 'w:none';
  }
  return `w:${window.map((n) => n.toFixed(WINDOW_ID_PRECISION)).join(',')}`;
}

let turnCounter = 0;

/** Reset the turn counter. Tests only — a session's ids must be monotonic. */
export function resetTurnIds() {
  turnCounter = 0;
}

/**
 * @typedef {object} TurnSources
 * @property {() => ({u: number, v: number, wu?: number, wv?: number}|null)} [uv]
 *   The finger. Browser: a `ref.current` read, the `coordRef` pattern. `u`/`v`
 *   are material; `wu`/`wv` window, defaulting to the material pair.
 * @property {() => (number[]|null)} [window] Current sub-window in frame units.
 * @property {() => (object|null)} [liveFeature] The last `featureEntered` record
 *   (`audiomChannel.getLastFeature()`), or null.
 * @property {() => number} [now] Epoch ms.
 * @property {() => (object|null)} [heading] `createHeadingTracker().heading()`.
 */

/**
 * Take the snapshot.
 *
 * @param {object} params
 * @param {object} params.adapter
 * @param {object} [params.surface] `createSurface()` result, for `acuityCell`.
 * @param {TurnSources} [params.sources]
 * @param {{get: Function}} [params.prefsStore]
 * @param {object} [params.session] `{tier}` and anything else the app knows.
 * @param {number} [params.liveFeatureMaxAgeMs]
 * @returns {object} Frozen.
 */
export function createTurnContext({
  adapter,
  surface,
  sources = {},
  prefsStore,
  session = {},
  liveFeatureMaxAgeMs = 3000,
} = {}) {
  if (!adapter) throw new Error('createTurnContext: an adapter is required');
  const now = typeof sources.now === 'function' ? sources.now : () => Date.now();
  const startedAt = now();

  const raw = sources.uv?.() ?? null;
  const uv = raw && Number.isFinite(raw.u) && Number.isFinite(raw.v) ? { u: raw.u, v: raw.v } : null;
  // Equal to the material pair unless the perception layer supplies a separate
  // letterboxed pair. Defaulting rather than throwing keeps every existing call
  // site working; `assertConversions` is where a genuine mismatch surfaces.
  const windowUv = uv
    ? {
      u: Number.isFinite(raw.wu) ? raw.wu : uv.u,
      v: Number.isFinite(raw.wv) ? raw.wv : uv.v,
    }
    : null;

  // ⚠️ MATERIAL uv, never window uv and never the device-snapped cell centre.
  // Quantizing an already-snapped coordinate inherits the device grid and undoes
  // the device-independence `acuityCell` exists for.
  const acuityCell = uv && surface?.acuityCell ? surface.acuityCell(uv.u, uv.v) : null;

  const window = sources.window?.() ?? adapter.bbox ?? null;

  const liveRecord = sources.liveFeature?.() ?? null;
  const liveFeature = liveRecord
    ? Object.freeze({
      names: [...(liveRecord.names || [])],
      type: liveRecord.type,
      at: liveRecord.at,
      ageMs: Number.isFinite(liveRecord.at) ? startedAt - liveRecord.at : Infinity,
      get fresh() { return this.ageMs <= liveFeatureMaxAgeMs; },
    })
    : null;

  const heading = sources.heading?.() ?? null;

  turnCounter += 1;
  const context = {
    turnId: `t-${String(turnCounter).padStart(6, '0')}`,
    startedAt,

    uv: uv ? Object.freeze(uv) : null,
    windowUv: windowUv ? Object.freeze(windowUv) : null,
    acuityCell,

    window: window ? Object.freeze([...window]) : null,
    windowId: windowIdOf(window),
    worldId: adapter.worldId,
    // Read at turn open, not cached at session start: `AudiomWorldAdapter`'s
    // constructor sets `geographic` provisionally and `loadMapDefinition()`
    // corrects it from `coordinateSystem`. A dispatcher that snapshotted the
    // frame in its constructor would narrate compass bearings about a skeleton.
    frame: adapter.frame,

    /** Label only. Every behavioural branch reads `adjacencyAvailable`. */
    tier: session.tier ?? adapter.tier ?? null,

    prefs: Object.freeze({ ...(prefsStore?.get?.() || {}) }),
    liveFeature,
    heading: heading ? Object.freeze({ ...heading }) : null,
    liveFeatureMaxAgeMs,

    now,
  };
  return Object.freeze(context);
}

/**
 * Assert that the two `(u, v)` spaces are being used for the right things.
 *
 * Dev/test only, and cheap: it re-derives what each consumer *would* get and
 * reports a disagreement rather than a value. The point is that a letterboxed
 * material is the one configuration where the mistake has a symptom, and nobody
 * runs one by default — so the harness runs one on purpose.
 *
 * @param {object} ctx
 * @param {object} [surface]
 * @returns {string[]} Problems, empty when clean.
 */
export function assertConversions(ctx, surface) {
  const problems = [];
  if (!ctx.uv) return problems;

  if (surface?.acuityCell && ctx.acuityCell !== null) {
    const fromMaterial = surface.acuityCell(ctx.uv.u, ctx.uv.v);
    if (ctx.acuityCell !== fromMaterial) {
      problems.push(
        `acuityCell ${ctx.acuityCell} was not computed from material uv (expected ${fromMaterial})`,
      );
    }
  }
  if (!ctx.windowUv) problems.push('windowUv is missing while uv is present');
  return problems;
}

/**
 * Every key a tool result is forbidden to carry, at any depth.
 *
 * `(u, v)` addresses a point on a piece of material; a tool result describes the
 * world. Letting one leak means a consumer downstream has to know the projection
 * to interpret it, which is the coupling the adapter boundary exists to prevent.
 * `route()` already holds this line — its checks assert waypoints carry no
 * `u`/`v` — and every M7 tool holds the same one.
 */
export const FORBIDDEN_RESULT_KEYS = Object.freeze(['u', 'v', 'uv', 'windowUv']);

/**
 * Find perception coordinates that escaped into a result.
 *
 * @param {*} value
 * @param {string} [path]
 * @returns {string[]} Paths of offending keys.
 */
export function findPerceptionKeys(value, path = '$') {
  if (Array.isArray(value)) return value.flatMap((v, i) => findPerceptionKeys(v, `${path}[${i}]`));
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, val]) =>
    FORBIDDEN_RESULT_KEYS.includes(key)
      ? [`${path}.${key}`]
      : findPerceptionKeys(val, `${path}.${key}`),
  );
}
