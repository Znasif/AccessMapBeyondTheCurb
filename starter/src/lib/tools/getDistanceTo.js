/**
 * `get_distance_to` — how far to a named thing.
 *
 * ## Unit conversion is the tool's job, never the adapter's
 *
 * The adapter returns exactly one number in its **natural** unit — metres for a
 * geographic or enu world, millimetres on the material for an image world — and
 * never `minutes` or `blocks`. Walking time needs a speed assumption and blocks
 * need a street graph; both are `routing`/`graph` properties, not geometry.
 * Without that rule an adapter guesses a walking speed and the envelope reports
 * a fabricated unit as though it had been measured.
 *
 * So the conversion table lives here, in one place, exercised by one test — and
 * every entry that is not a pure ratio is **capability-gated**:
 *
 *   metres → feet     always      a ratio
 *   metres → minutes  `routing`   a speed assumption
 *   metres → blocks   `graph`     needs to know what a block is
 *
 * `toolFilter.js` already narrows the served enum so `minutes` and `blocks` are
 * not even offered to a session that cannot compute them. This is the backstop
 * for when the model emits one anyway, which a 4-bit model does often enough to
 * be a design constraint.
 */

import { STATUS, limit } from '../toolResult.js';
import { projectPlace, safeBearing, windowUv, round } from './shared.js';

export const NAME = 'get_distance_to';

/**
 * Metres per second. The same constant `audiomWorldAdapter` uses for
 * `route().duration`; duplicated rather than imported because a tool must not
 * depend on one world's adapter, and reconciled by a check in the harness.
 */
export const WALK_SPEED_MPS = 1.2;

/** A city block, in metres. A convention, and labelled as one in the result. */
export const BLOCK_METRES = 100;

const FEET_PER_METRE = 3.280839895;

/**
 * Convert a natural-unit distance into what the user asked for.
 *
 * @param {{value: number, units: string}} distance
 * @param {string|undefined} requested
 * @param {object} adapter
 * @returns {{value: number, units: string, limit?: object}}
 */
export function convert(distance, requested, adapter) {
  const { value, units } = distance;
  if (!requested || requested === units) return { value, units };

  if (units === 'metres' && requested === 'feet') {
    return { value: value * FEET_PER_METRE, units: 'feet' };
  }
  if (units === 'metres' && requested === 'minutes') {
    if (!adapter.has('routing')) {
      return {
        value,
        units,
        limit: limit('units', 'no_routing', 'I can give you the distance, but not how long it takes to walk — this map has no walking network.'),
      };
    }
    return { value: value / WALK_SPEED_MPS / 60, units: 'minutes' };
  }
  if (units === 'metres' && requested === 'blocks') {
    if (!adapter.has('graph')) {
      return {
        value,
        units,
        limit: limit('units', 'no_graph', 'I can give you the distance, but not in blocks — this map has no street network.'),
      };
    }
    return { value: value / BLOCK_METRES, units: 'blocks' };
  }
  return {
    value,
    units,
    limit: limit('units', 'unconvertible', 'I have given the distance in the unit this map measures in.'),
  };
}

/**
 * @param {{place: string, units?: string, $place?: object}} args
 * @param {object} ctx
 * @param {{adapter: object}} api
 */
export function getDistanceTo(args, ctx, { adapter }) {
  const place = args.$place;
  const uv = windowUv(ctx);
  if (!place || !uv) {
    return {
      status: STATUS.ERROR,
      tool: NAME,
      error: place ? 'no_position' : 'unresolved_place',
      message: place ? 'I do not know where your finger is.' : `I could not find "${args.place}".`,
    };
  }

  const measured = adapter.distanceTo(uv.u, uv.v, place);
  if (!measured || !Number.isFinite(measured.value)) {
    return {
      status: STATUS.PARTIAL,
      tool: NAME,
      data: { place: projectPlace(place), distance: null },
      limits: [limit('distance', 'no_geometry', 'I know that place by name but not where it is on this map.')],
    };
  }

  const converted = convert(measured, args.units, adapter);
  const data = {
    place: projectPlace(place),
    distance: round(converted.value, converted.units === 'minutes' ? 0 : 1),
    // `method` is honesty about precision, not decoration: `nearest_vertex` and
    // `nearest_boundary` are the nearest point of the shape, `inside` means the
    // finger is on it and the distance is zero by definition.
    method: measured.method,
  };

  // The direction rides along free of charge — "how far" is nearly always "which
  // way" too, and a second round trip to ask would cost 1–3 s.
  const bearing = safeBearing(adapter, uv, place);
  if (bearing?.direction) data.direction = bearing.direction;

  return {
    status: converted.limit ? STATUS.PARTIAL : STATUS.OK,
    tool: NAME,
    data,
    units: { distance: converted.units },
    limits: converted.limit ? [converted.limit] : undefined,
  };
}

export default getDistanceTo;
