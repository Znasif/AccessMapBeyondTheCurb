/**
 * The six M7 tools, and the one call that registers them.
 *
 * A useful fact about this set: per the schema's `requires`, `whats_here`
 * requires nothing and the other five require `places`, and all six declare all
 * three frames — so **these six are exactly the intersection of every profile**
 * in `capabilityProfiles` (`osm_full`, `osm_places_only`, `audiom_tier_a`,
 * `audiom_tier_c`, `camio`). The registry therefore has *no* capability-conditional
 * handlers at all: every capability difference lands inside the adapters as
 * `Unsupported` or as a `partial` result with `limits`, and one handler table is
 * testable against all five profiles.
 *
 * `route_to` is the seventh tool that passes the filter everywhere. It is not
 * registered here, so `serve()` withholds it with a reason rather than offering
 * a tool that would waste a round on `unknown_tool`. See `toolRegistry.js`.
 */

import { whatsHere, NAME as WHATS_HERE } from './whatsHere.js';
import { describeSurroundings, NAME as DESCRIBE_SURROUNDINGS } from './describeSurroundings.js';
import { getPlaceDetails, NAME as GET_PLACE_DETAILS } from './getPlaceDetails.js';
import { amIAt, NAME as AM_I_AT } from './amIAt.js';
import { getDistanceTo, NAME as GET_DISTANCE_TO } from './getDistanceTo.js';
import { getDirectionTo, NAME as GET_DIRECTION_TO } from './getDirectionTo.js';

export const CORE_TOOLS = Object.freeze([
  [WHATS_HERE, whatsHere],
  [DESCRIBE_SURROUNDINGS, describeSurroundings],
  [GET_PLACE_DETAILS, getPlaceDetails],
  [AM_I_AT, amIAt],
  [GET_DISTANCE_TO, getDistanceTo],
  [GET_DIRECTION_TO, getDirectionTo],
]);

/**
 * @param {import('../toolRegistry.js').ToolRegistry} registry
 * @returns {import('../toolRegistry.js').ToolRegistry}
 */
export function registerCoreTools(registry) {
  for (const [name, handler] of CORE_TOOLS) registry.register(name, handler);
  return registry;
}

export {
  whatsHere,
  describeSurroundings,
  getPlaceDetails,
  amIAt,
  getDistanceTo,
  getDirectionTo,
};
