/**
 * `describe_surroundings` — what is around the finger.
 *
 * A thin wrapper over `adapter.nearby()`, which is the point: the adapter owns
 * the radius default (a fraction of the window diagonal on audiom, 25 mm on
 * camio), because a scale-appropriate radius is world knowledge and the tool
 * layer has no basis for choosing one.
 *
 * `radius` arrives from the model "in the units this map uses", per the tool
 * description, so it is passed through untouched — the envelope reports which
 * unit that was.
 */

import { STATUS, limit, MAX_ADJACENT } from '../toolResult.js';
import { adjacentTo, windowUv } from './shared.js';
import { adjacencyAvailable } from './whatsHere.js';

export const NAME = 'describe_surroundings';

/** How many neighbours a listener can hold before it stops being an answer. */
export const MAX_NEARBY = 5;

/**
 * @param {{radius?: number, category?: string}} args
 * @param {object} ctx
 * @param {{adapter: object}} api
 */
export function describeSurroundings(args, ctx, { adapter }) {
  const uv = windowUv(ctx);
  if (!uv) {
    return {
      status: STATUS.PARTIAL,
      tool: NAME,
      data: { nearby: null },
      limits: [limit('nearby', 'no_position', 'I do not know where your finger is at the moment.')],
    };
  }

  if (!adjacencyAvailable(adapter, uv)) {
    return {
      status: STATUS.PARTIAL,
      tool: NAME,
      data: { nearby: null },
      limits: [limit('nearby', 'no_geometry', 'This map gives me names only, so I cannot tell what is around you.')],
      units: { distance: null, direction: null, duration: null },
    };
  }

  const nearby = adjacentTo(adapter, ctx, {
    radius: args?.radius,
    limit: MAX_NEARBY,
    category: args?.category,
  });

  // `null` from the helper means the world could not answer; an empty array here
  // means it answered and there is genuinely nothing in range. Two different
  // statements, kept apart.
  if (nearby === null) {
    return {
      status: STATUS.PARTIAL,
      tool: NAME,
      data: { nearby: null },
      limits: [limit('nearby', 'no_geometry', 'This map cannot tell me what is around you.')],
    };
  }

  const result = {
    status: STATUS.OK,
    tool: NAME,
    data: { nearby },
  };
  if (args?.category && nearby.length === 0) {
    result.status = STATUS.PARTIAL;
    result.limits = [limit('nearby', 'no_match_in_radius', 'I found nothing of that kind close by.')];
  }
  return result;
}

export { MAX_ADJACENT };
export default describeSurroundings;
