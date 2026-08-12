/**
 * `am_i_at` — is the finger on, or immediately beside, this named thing?
 *
 * Three states, not two, because "no" is unhelpful when the answer is "not
 * quite":
 *
 *   on     — `at()` returned this very place. Certain: containment, not a radius.
 *   beside — within `adapter.touchTolerance()`, with the direction to close the gap.
 *   no     — further than that, with the distance and direction so the user can
 *            keep looking rather than start over.
 *
 * The tolerance is **adapter-owned** and deliberately so: 25 mm on a printed
 * sheet and a fraction of the window diagonal on a state-sized map are the same
 * idea in two frames, and the tool layer has no basis for picking either. On
 * audiom it is literally the `toleranceFraction` that `at()` already snaps with,
 * so `am_i_at` and `whats_here` agree by construction rather than by
 * coincidence.
 */

import { STATUS } from '../toolResult.js';
import { projectPlace, safeBearing, windowUv, round } from './shared.js';

export const NAME = 'am_i_at';

/**
 * @param {{place: string, $place?: object}} args
 * @param {object} ctx
 * @param {{adapter: object}} api
 */
export function amIAt(args, ctx, { adapter }) {
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

  const hit = adapter.at(uv.u, uv.v);
  const onIt = Boolean(
    (hit?.place && (hit.place.id === place.id || hit.place.name === place.name))
      || (hit?.region && hit.region.id === place.regionId),
  );

  const data = { place: projectPlace(place), answer: onIt ? 'on' : 'no' };

  if (onIt) {
    return { status: STATUS.OK, tool: NAME, data };
  }

  const distance = adapter.distanceTo?.(uv.u, uv.v, place);
  const tolerance = adapter.touchTolerance?.() || { value: 0 };
  if (distance && Number.isFinite(distance.value)) {
    data.distance = round(distance.value);
    if (distance.value <= tolerance.value) data.answer = 'beside';
  }
  const bearing = safeBearing(adapter, uv, place);
  if (bearing?.direction) data.direction = bearing.direction;

  return { status: STATUS.OK, tool: NAME, data };
}

export default amIAt;
