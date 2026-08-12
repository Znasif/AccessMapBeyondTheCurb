/**
 * The three tools the benchmark needs that milestone 7 did not ship.
 *
 * `tools/index.js` registers six handlers; `route_to`,
 * `get_segment_accessibility` and `get_crossing_info` pass capability filtering
 * on this world and have no handler, so `ToolRegistry.serve()` withholds them
 * with `reason: 'no_handler'` and they never reach the prompt. That is the right
 * default for the product — a tool that answers `unknown_tool` is worse than a
 * tool that is absent — but it makes the parity benchmark measure the wrong
 * thing twice over:
 *
 *   - **`route_to` withheld ⇒ P is not under test.** Six of the 26 turns are
 *     guidance requests, and `browser-voice-exploration-plan.md` §6 nominates
 *     this benchmark as the acceptance test for **P** precisely because P's
 *     route narration is byte-identical to the Python. With no `route_to`,
 *     `processInstructions` is never called and the acceptance test grades
 *     everything except the thing it accepts.
 *   - **the two accessibility readers withheld ⇒ three more turns are
 *     unanswerable.** `NY-A1` (roadworks on this street), `NY-A2` (walk light
 *     here) and `NY-S4` (stairs on the road) are per-segment and per-node
 *     feature reads. The data is in the model files and in the ported `Edge`
 *     and `Node`; only the handler is missing.
 *
 * So they are supplied **here, in the harness**, not added to `src/lib/tools/`:
 * M13 (nav tools against the Audiom avatar) and M11 (accessibility tools) are
 * real milestones with real scope, and quietly landing a third of each inside a
 * benchmark would be worse than the gap. Every run records
 * `harness_tools: [...]` in its JSON so a grader can see which answers came
 * through shipped handlers and which through these.
 *
 * `route_to` is the direct analogue of `run_parity_benchmark.py --routing local`:
 * it actually routes and records the waypoints navigation would have received,
 * rather than stubbing the call and grading only whether the model asked.
 *
 * Platform-free.
 */

import { STATUS, limit } from '../toolResult.js';
import { projectPlace, windowUv, round } from '../tools/shared.js';

export const ROUTE_TO = 'route_to';
export const GET_SEGMENT_ACCESSIBILITY = 'get_segment_accessibility';
export const GET_CROSSING_INFO = 'get_crossing_info';

/** The names this module registers. Recorded in every run's JSON. */
export const HARNESS_TOOL_NAMES = Object.freeze([
  ROUTE_TO,
  GET_SEGMENT_ACCESSIBILITY,
  GET_CROSSING_INFO,
]);

/**
 * Waypoints, trimmed to what a listener can hold and what the envelope can
 * carry. `MAX_RESULT_CHARS` is 1200 and a `detroit_conant` hotel→restaurant
 * route is ten waypoints of prose, so the whole route cannot travel; the first
 * few steps plus the count is what a spoken confirmation actually needs.
 */
export const MAX_SPOKEN_WAYPOINTS = 3;

/**
 * `route_to` — start guidance, and record what navigation would have received.
 *
 * The confirmation string is MapIO's, near-verbatim ("Navigation mode is now
 * enabled."), because `notes.sideEffecting` in the schema asks for exactly that
 * and because every graded Python run so far was graded against it.
 *
 * @param {{place: string, mode: string, alternative_index?: number, $place?: object}} args
 * @param {object} ctx
 * @param {{adapter: object, onRoute?: Function}} api
 */
export function routeTo(args, ctx, { adapter, onRoute } = {}) {
  const place = args.$place;
  const uv = windowUv(ctx);
  if (!place) {
    return {
      status: STATUS.ERROR,
      tool: ROUTE_TO,
      error: 'unresolved_place',
      message: `I could not find "${args.place}" on this map.`,
    };
  }

  const streetByStreet = args.mode !== 'fly_me_there';
  const record = {
    call: streetByStreet ? 'guide_to_destination' : 'guide_to_poi',
    place: place.name,
    poi_index: Number.isInteger(place.poiIndex) ? place.poiIndex : null,
    street_by_street: streetByStreet,
    mode: args.mode,
    alternative_index: args.alternative_index ?? null,
  };

  if (!uv) {
    onRoute?.({ guide: record, route: null, reason: 'no_position' });
    return {
      status: STATUS.ERROR,
      tool: ROUTE_TO,
      error: 'no_position',
      message: 'I do not know where you are on the map, so I cannot start guidance.',
    };
  }

  const route = adapter.route(
    { u: uv.u, v: uv.v },
    place,
    { streetByStreet, routeIndex: Math.max(0, (args.alternative_index ?? 1) - 1) },
  );
  onRoute?.({ guide: record, route });

  if (!route || route.error || !route.waypoints?.length) {
    return {
      status: STATUS.UNSUPPORTED,
      tool: ROUTE_TO,
      message: `I could not work out a route to ${place.name} from where you are.`,
    };
  }

  const steps = route.waypoints.slice(0, MAX_SPOKEN_WAYPOINTS).map((w) => w.instructions);
  const data = {
    place: projectPlace(place),
    mode: streetByStreet ? 'street_by_street' : 'fly_me_there',
    steps,
    step_count: route.waypoints.length,
    distance: round(route.distance),
  };

  return {
    // `confirmed`, not `ok`: the schema's `notes.sideEffecting` wants a string
    // to narrate near-verbatim, and a confirmation must never be memoized.
    status: STATUS.CONFIRMED,
    tool: ROUTE_TO,
    message: streetByStreet
      ? 'Street-by-street navigation mode is now enabled.'
      : 'Fly-me-there guidance mode is now enabled.',
    data,
    units: { distance: 'metres', duration: 'minutes' },
  };
}

/**
 * `get_segment_accessibility` — the street segment under the finger.
 *
 * Reads the ported `Edge.features` block: `slope`, `surface`, `roadwork`,
 * `stairs`, `bike_lane`, `traffic_direction`. §8's rule holds — nothing here
 * states an accessibility fact flatly; the values are carried with the segment
 * they were recorded for and the model narrates them as recorded.
 */
export function getSegmentAccessibility(_args, ctx, { adapter }) {
  const uv = windowUv(ctx);
  if (!uv) {
    return {
      status: STATUS.PARTIAL,
      tool: GET_SEGMENT_ACCESSIBILITY,
      data: { segment: null },
      limits: [limit('segment', 'no_position', 'I do not know where your finger is at the moment.')],
    };
  }
  const hit = adapter.at(uv.u, uv.v);
  if (!hit?.segment) {
    return {
      status: STATUS.PARTIAL,
      tool: GET_SEGMENT_ACCESSIBILITY,
      data: { segment: null },
      limits: [limit('segment', 'no_segment', 'You are not on a street segment I have details for.')],
    };
  }
  const attrs = adapter.attributes(hit.segment) || {};
  return {
    status: STATUS.OK,
    tool: GET_SEGMENT_ACCESSIBILITY,
    data: {
      street: hit.segment.name,
      slope: attrs.slope ?? null,
      surface: attrs.surface ?? null,
      steps: Boolean(attrs.stairs),
      roadwork: Boolean(attrs.roadwork),
      bike_lane: Boolean(attrs.bike_lane),
      traffic_direction: attrs.traffic_direction ?? null,
    },
    provenance: [{ source: adapter.worldId }],
  };
}

/**
 * `get_crossing_info` — the intersection at or nearest the finger.
 *
 * Reads the ported `Node.features` block: `crosswalk`, `walk_light`,
 * `walk_light_duration`, `tactile_paving`, `street_width`, `on_border`. Falls
 * back to the nearest node when the finger is mid-block, and says so — "the
 * nearest crossing" is a different claim from "the crossing you are on", and
 * conflating them is the failure mode §8 warns about.
 */
export function getCrossingInfo(_args, ctx, { adapter }) {
  const uv = windowUv(ctx);
  if (!uv) {
    return {
      status: STATUS.PARTIAL,
      tool: GET_CROSSING_INFO,
      data: { crossing: null },
      limits: [limit('crossing', 'no_position', 'I do not know where your finger is at the moment.')],
    };
  }

  const hit = adapter.at(uv.u, uv.v);
  const node = hit?.node || adapter.nearestNode?.(uv.u, uv.v) || null;
  if (!node) {
    return {
      status: STATUS.PARTIAL,
      tool: GET_CROSSING_INFO,
      data: { crossing: null },
      limits: [limit('crossing', 'no_crossing', 'There is no intersection close enough to describe.')],
    };
  }

  const attrs = adapter.attributes(node) || {};
  const data = {
    crossing: node.name || null,
    at_finger: Boolean(hit?.node),
    marked: Boolean(attrs.crosswalk),
    pedestrian_signal: Boolean(attrs.walk_light),
    signal_duration: attrs.walk_light ? (attrs.walk_light_duration ?? null) : null,
    tactile_paving: Boolean(attrs.tactile_paving),
    street_width: attrs.street_width && attrs.street_width !== 'unknown' ? attrs.street_width : null,
  };

  return {
    status: hit?.node ? STATUS.OK : STATUS.PARTIAL,
    tool: GET_CROSSING_INFO,
    data,
    limits: hit?.node
      ? undefined
      : [limit('crossing', 'nearest_not_at', 'You are not standing at a crossing, so this is the nearest one.')],
    provenance: [{ source: adapter.worldId }],
  };
}

/**
 * Register all three on a `ToolRegistry`.
 *
 * `onRoute` receives `{guide, route}` per `route_to` call — the runner's
 * equivalent of `stub_guides()` + `route_recorder()` in the Python.
 *
 * @param {import('../toolRegistry.js').ToolRegistry} registry
 * @param {{onRoute?: Function}} [options]
 */
export function registerHarnessTools(registry, { onRoute } = {}) {
  registry.register(ROUTE_TO, (args, ctx, api) => routeTo(args, ctx, { ...api, onRoute }));
  registry.register(GET_SEGMENT_ACCESSIBILITY, getSegmentAccessibility);
  registry.register(GET_CROSSING_INFO, getCrossingInfo);
  return registry;
}

export default registerHarnessTools;
