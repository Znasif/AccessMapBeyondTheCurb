/**
 * Direction vocabulary and heading — milestone 7.
 *
 * **This is a port, not a new convention.** MapIO
 * (`explore/simple_camio_llm`) speaks directions in exactly two registers and
 * never in a third:
 *
 *   1. **Eight cardinal directions relative to north.** `graph.py:738`
 *      `get_direction(versor)` → `get_turning_direction(versor, NORTH, (0,-1))`,
 *      which walks {@link DIRECTIONS} in 45° steps past a 22.5° threshold. The
 *      JS port is already in this repo, is pinned byte-for-byte by
 *      `scripts/test_logic_port.mjs`, and is imported here rather than
 *      re-derived — a second copy of the rosette is how spoken directions
 *      silently rotate.
 *   2. **Turn-relative continuation.** `graph.py:568` /
 *      `graph.js#processInstructions`: `"Continue straight" if same_direction
 *      else f"Head {direction}"`. A heading is what makes the first form
 *      available; without one there is only the second.
 *
 * There is **no clock face** anywhere in MapIO and there is none here. An
 * earlier design note proposed one on the grounds that a finger has no heading.
 * That is wrong: `position_handler.py:162` `get_edge_movement_direction` derives
 * a heading from finger movement — `current - last`, gated on
 * `movement_threshold`, dotted against the edge versor, `|dot| < 0.5` →
 * `MovementDirection.NONE`. So a heading is **intermittent, not absent**, and
 * the real design problem is the degraded case.
 *
 * ## What happens when the heading is NONE
 *
 * The absolute bearing needs no heading and is therefore the invariant answer:
 * every direction result carries one. The turn-relative layer
 * ({@link continuation}) is strictly *additive* enrichment, offered only when a
 * fresh heading exists. When the finger is still, or moving below the movement
 * threshold, or the last sample has aged out, the answer degrades from
 * *"continue straight"* to *"head north-east"* — which is precisely what
 * `processInstructions` does on its own first leg (`i === 0` →
 * `getDirection(versor)`, `sameDirection = false`). Nothing is fabricated and
 * nothing is withheld.
 *
 * ## The lexicon is frame-dependent; the geometry is not
 *
 * The schema's `$note` on `get_direction_to` is explicit that compass words are
 * valid only in the geographic frame — *"saying 'north' about a skeleton diagram
 * is a bug"*. So the same eight sectors are spoken with two different word sets,
 * and the envelope's `units.direction` names which one was used:
 *
 *   - `geographic` → `'compass'`  — north, north-east, … (MapIO's own words)
 *   - `enu` / `image` → `'material'` — top, top right, right, … on the sheet
 *
 * Platform-free.
 */

import { Coords, DIRECTIONS, CardinalDirection } from './logic/coords.js';
import { getDirection, getTurningDirection } from './logic/graph.js';
import { FRAMES } from './worldAdapter.js';

export { DIRECTIONS, CardinalDirection };

/** The two direction vocabularies. Reported as `units.direction` in every envelope. */
export const VOCABULARIES = Object.freeze({
  /** Geographic frame only. */
  COMPASS: 'compass',
  /** enu and image frames: positions on the printed sheet, not on the earth. */
  MATERIAL: 'material',
});

/**
 * The sheet-relative words, one per {@link DIRECTIONS} entry.
 *
 * Read as "toward the … of the sheet". Chosen over a clock face because a clock
 * face is heading-relative in MapIO (it is a navigation app walking a real
 * street) and would have to be re-based to "up" here anyway — at which point it
 * is the same eight sectors with a less legible label. `top left` is
 * unambiguous to a finger on a page; `10 o'clock` is not.
 */
export const MATERIAL_WORDS = Object.freeze({
  north: 'top',
  'north-east': 'top right',
  east: 'right',
  'south-east': 'bottom right',
  south: 'bottom',
  'south-west': 'bottom left',
  west: 'left',
  'north-west': 'top left',
});

/**
 * Which vocabulary a frame may speak.
 * @param {string} frame One of {@link FRAMES}.
 * @returns {'compass'|'material'}
 */
export function vocabularyFor(frame) {
  return frame === FRAMES.GEOGRAPHIC ? VOCABULARIES.COMPASS : VOCABULARIES.MATERIAL;
}

/**
 * Translate a cardinal direction into the frame's vocabulary.
 *
 * A frame that may not say "north" **structurally cannot**: the compass word
 * never reaches a caller outside the geographic frame, so a handler physically
 * cannot narrate one. That is the `$note` enforced in the data path rather than
 * in a policy someone has to remember.
 *
 * @param {string} cardinal One of {@link DIRECTIONS}.
 * @param {string} frame
 * @returns {string}
 */
export function wordFor(cardinal, frame) {
  if (vocabularyFor(frame) === VOCABULARIES.COMPASS) return cardinal;
  return MATERIAL_WORDS[cardinal] ?? cardinal;
}

/**
 * Absolute heading of a displacement, as a cardinal direction.
 *
 * `dx`/`dy` are in a **plane with y growing downward**, which is the convention
 * `lib/logic` is built on (`graph.js` defines north as the versor `(0, -1)`) and
 * the convention `(u, v)` already uses (`v = 0` is top). Callers working in a
 * y-up frame — east/north metres, latitude — must flip `dy` before calling; the
 * adapters do this in one place each.
 *
 * @param {number} dx @param {number} dy
 * @returns {string|null} One of {@link DIRECTIONS}, or null for no displacement.
 */
export function cardinalOf(dx, dy) {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  if (dx === 0 && dy === 0) return null;
  return getDirection(new Coords(dx, dy).normalized());
}

/**
 * Degrees clockwise from "up" (north in the geographic frame), in `[0, 360)`.
 *
 * Carried alongside the word so a caller that wants finer resolution than 45°
 * has it, and so a test can pin the word against the angle that produced it.
 *
 * @param {number} dx @param {number} dy  Same y-down plane as {@link cardinalOf}.
 * @returns {number|null}
 */
export function degreesOf(dx, dy) {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  if (dx === 0 && dy === 0) return null;
  return ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
}

/**
 * The one implementation of `WorldAdapter#bearingBetween`.
 *
 * Every adapter's override is `bearingBetweenPoints(this, u0, v0, u1, v1)`.
 * Given {@link WorldAdapter#metricPoint}'s isotropic y-down plane the rosette is
 * plain geometry, so there is no reason for a second copy — and a second copy is
 * how spoken directions silently rotate.
 *
 * @param {{metricPoint: Function, frame: string}} adapter
 * @param {number} u0 @param {number} v0 @param {number} u1 @param {number} v1
 * @returns {{cardinal: string, direction: string, vocabulary: string, degrees: number,
 *   frame: string, compass?: string}|null}
 */
export function bearingBetweenPoints(adapter, u0, v0, u1, v1) {
  const a = adapter.metricPoint(u0, v0);
  const b = adapter.metricPoint(u1, v1);
  if (!a || !b || !Number.isFinite(a.x) || !Number.isFinite(b.x)) return null;
  return bearingFromDelta(b.x - a.x, b.y - a.y, adapter.frame);
}

/**
 * Package a metric-plane displacement as a bearing in the frame's vocabulary.
 *
 * @param {number} dx @param {number} dy  y **down**.
 * @param {string} frame
 * @returns {{cardinal: string, direction: string, vocabulary: string, degrees: number,
 *   frame: string, compass?: string}|null}
 */
export function bearingFromDelta(dx, dy, frame) {
  const cardinal = cardinalOf(dx, dy);
  if (!cardinal) return null;
  const vocabulary = vocabularyFor(frame);
  const out = {
    cardinal,
    direction: wordFor(cardinal, frame),
    vocabulary,
    degrees: degreesOf(dx, dy),
    frame,
  };
  // Structurally absent outside `geographic`: a caller cannot narrate a compass
  // word the adapter never produced.
  if (vocabulary === VOCABULARIES.COMPASS) out.compass = cardinal;
  return out;
}

/**
 * The turn-relative half, ported from `graph.js#processInstructions:592-602`.
 *
 * @param {number} dx @param {number} dy   The new displacement, y-down plane.
 * @param {{cardinal: string, versor: {x: number, y: number}}|null} heading
 *   The current heading, or null when there is none (finger still, moved less
 *   than the threshold, or the sample aged out).
 * @param {string} frame
 * @returns {{cardinal: string, word: string, phrase: string, sameDirection: boolean,
 *   relative: boolean}|null}
 */
export function continuation(dx, dy, heading, frame) {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) return null;
  const versor = new Coords(dx, dy).normalized();

  // No heading: the `i === 0` branch. Absolute direction, `sameDirection = false`,
  // so the phrase is "Head <direction>" and no turn is claimed.
  if (!heading?.cardinal || !heading?.versor) {
    const cardinal = getDirection(versor);
    const word = wordFor(cardinal, frame);
    return { cardinal, word, phrase: `Head ${word}`, sameDirection: false, relative: false };
  }

  const old = new Coords(heading.versor.x, heading.versor.y);
  const cardinal = getTurningDirection(versor, heading.cardinal, old);
  const sameDirection = cardinal === heading.cardinal;
  const word = wordFor(cardinal, frame);
  return {
    cardinal,
    word,
    phrase: sameDirection ? 'Continue straight' : `Head ${word}`,
    sameDirection,
    relative: true,
  };
}

/**
 * How far a finger must travel before its movement counts as a heading, **in
 * inches of printed material**.
 *
 * Verbatim from MapIO: `PositionHandler.MOVEMENT_THRESHOLD = 0.125`
 * (`positionHandler.js:171`), multiplied there by `feetsPerInch` to reach map
 * units. Kept in inches for the same reason MapIO keeps it in inches — it is a
 * fact about fingers, not about maps — and converted per-world by
 * {@link movementThresholdFor}.
 */
export const MOVEMENT_THRESHOLD_INCHES = 0.125;

/**
 * The movement gate in a world's own metric units.
 *
 * @param {number} materialWidthMetric  Width of the window in the metric plane
 *   ({@link createHeadingTracker}'s units): metres for a geographic or enu
 *   world, millimetres for an image world.
 * @param {number} materialWidthInches  Width of the printed material.
 * @returns {number}
 */
export function movementThresholdFor(materialWidthMetric, materialWidthInches) {
  if (!(materialWidthMetric > 0) || !(materialWidthInches > 0)) return 0;
  return (MOVEMENT_THRESHOLD_INCHES / materialWidthInches) * materialWidthMetric;
}

/**
 * How long a heading stays usable. Beyond this the finger has been still (or
 * unobserved) long enough that "continue straight" would be a claim about the
 * past, so the tracker reports no heading and the answer degrades to absolute.
 */
export const DEFAULT_HEADING_MAX_AGE_MS = 2000;

/**
 * Tracks the heading of a moving finger.
 *
 * The port of `get_edge_movement_direction`'s first two gates. The third — the
 * `|dot| < 0.5` test against an edge versor — is deliberately **not** here: it
 * answers "am I walking along this edge, forwards or backwards", which is a
 * routing question and belongs to whoever holds the edge. This tracker answers
 * only "which way is the finger going", which is the input to that test and to
 * {@link continuation}.
 *
 * ⚠️ **Samples are METRIC PLANE points, not `(u, v)`.** A heading taken in
 * normalised coordinates is wrong by the window's aspect ratio and, in a
 * geographic world, by the Mercator scale factor as well — a 45° sweep across a
 * 297×210 mm sheet is 32° in `(u, v)`, which is most of a sector. Feed
 * `adapter.metricPoint(u, v)` and the heading shares one plane with every
 * bearing the adapters produce.
 *
 * Injectable clock; no timers, no listeners, no platform.
 *
 * @param {object} [options]
 * @param {number} [options.threshold]  Movement gate, in metric-plane units.
 *   Derive it with {@link movementThresholdFor}.
 * @param {number} [options.maxAgeMs]
 * @param {() => number} [options.now]
 */
export function createHeadingTracker({
  threshold = 0,
  maxAgeMs = DEFAULT_HEADING_MAX_AGE_MS,
  now = () => Date.now(),
} = {}) {
  /** @type {{x: number, y: number, at: number}|null} */
  let anchor = null;
  /** @type {{cardinal: string, versor: {x: number, y: number}, at: number}|null} */
  let heading = null;

  return {
    threshold,
    maxAgeMs,

    /**
     * Feed one position. Cheap enough for the camera loop; the anchor only moves
     * when the threshold is crossed, so a tremor never produces a heading and a
     * slow deliberate drag eventually does.
     *
     * @param {{x: number, y: number}|null} point  Metric plane, y **down**.
     * @param {number} [at]
     * @returns {{cardinal: string, versor: {x: number, y: number}, at: number}|null}
     */
    sample(point, at = now()) {
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        // A lost coordinate must not leave a stale heading behind it — the
        // homography can drop out mid-sweep and the finger may be anywhere.
        anchor = null;
        heading = null;
        return null;
      }
      if (!anchor) {
        anchor = { x: point.x, y: point.y, at };
        return heading;
      }
      const dx = point.x - anchor.x;
      const dy = point.y - anchor.y;
      if (Math.hypot(dx, dy) < threshold) return heading;

      const versor = new Coords(dx, dy).normalized();
      heading = { cardinal: getDirection(versor), versor: { x: versor.x, y: versor.y }, at };
      anchor = { x: point.x, y: point.y, at };
      return heading;
    },

    /**
     * The current heading, or null when there is none or it has aged out. This
     * is the value {@link continuation} treats as "no heading" — the degraded
     * case the module note is about.
     *
     * @param {number} [at]
     * @returns {{cardinal: string, versor: {x: number, y: number}, at: number, ageMs: number}|null}
     */
    heading(at = now()) {
      if (!heading) return null;
      const ageMs = at - heading.at;
      if (ageMs > maxAgeMs) return null;
      return { ...heading, ageMs };
    },

    /** Forget everything — a new map, or a lifted finger. */
    reset() {
      anchor = null;
      heading = null;
    },
  };
}
