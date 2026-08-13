/**
 * One benchmark world, assembled from the shipped modules.
 *
 * Everything the runner needs for one map, built once and reused across every
 * case on that map — which is not an optimisation but a correctness
 * requirement in two places:
 *
 *   - **the L1 index.** `placeIndex.build()` embeds every POI. Rebuilding it per
 *     case would be 50 embeddings × 18 cases, and `dispatcher.js` is explicit
 *     that index build is a session-start job, never a turn-time one.
 *   - **the served tool block.** `ToolRegistry.serve()` is cached per
 *     `(capabilities, frame)` because the tool schema sits *ahead* of everything
 *     volatile in the prompt; a tool array that differed run to run would
 *     invalidate the whole KV prefix (§6.1).
 *
 * The one part not shipped is the position spec, which is a benchmark concept:
 * `mapio_benchmark.json`'s `$position_spec` says "position is null, or one of
 * `{poi}`, `{street}`, `{intersection}`, `{node_index}`", and
 * {@link resolvePositionSpec} is the JS twin of `run_parity_benchmark.py`'s
 * `resolve_position()`, resolved against the ported `Graph` rather than the
 * Python one.
 *
 * Platform-free: the model JSON is handed in already parsed, and the LLM client
 * and the index store are injected.
 */

import { ToolRegistry } from '../toolRegistry.js';
import { registerCoreTools } from '../tools/index.js';
import { PlaceIndex, MemoryStore, fromCamioPoi } from '../placeIndex.js';
import { buildSystemPrompt } from '../candidateContext.js';
import { UNTRUSTED_PREAMBLE } from '../untrusted.js';
import { createSurface } from '../surface.js';
import { windowIdOf } from '../turnContext.js';
import { Graph } from '../logic/graph.js';
import { Coords } from '../logic/coords.js';
import { MapioWorldAdapter } from '../adapters/mapioWorldAdapter.js';
import { buildWorldBriefing } from './briefing.js';
import { registerHarnessTools, HARNESS_TOOL_NAMES } from './harnessTools.js';

/** Millimetres per inch, for turning `feets_per_inch` into a printed sheet size. */
const MM_PER_INCH = 25.4;

/**
 * Build the world for one map.
 *
 * @param {object} params
 * @param {string} params.mapName          `new_york` | `detroit_conant`
 * @param {object} params.model            parsed `<map>.json`
 * @param {object} params.schema           parsed `llm-tools.schema.json`
 * @param {object} params.client           `LocalLLMClient` — used for L1 embeddings
 * @param {object} [params.store]          `placeIndex` store; defaults to memory
 * @param {number} [params.now]            epoch ms, stamped into the briefing once
 * @param {boolean} [params.harnessTools=true] register `route_to` and the two
 *        accessibility readers; see `harnessTools.js` for why they are not shipped
 * @param {(e: object) => void} [params.onEvent]
 * @returns {Promise<object>} the world handle the runner drives
 */
export async function createParityWorld({
  mapName,
  model,
  schema,
  client,
  store,
  now = Date.now(),
  harnessTools = true,
  onEvent,
} = {}) {
  if (!model?.graph) throw new Error(`createParityWorld: ${mapName} has no \`graph\` block`);

  /** Every `route_to` call and the waypoints it produced. Cleared per turn. */
  const routeLog = [];

  const graph = new Graph(model.graph, { feetsPerInch: model.feets_per_inch ?? 1 });
  const adapter = new MapioWorldAdapter({ graph, model, mapName });

  const registry = new ToolRegistry({ schema });
  registerCoreTools(registry);
  if (harnessTools) registerHarnessTools(registry, { onRoute: (entry) => routeLog.push(entry) });
  const served = registry.serve(adapter.session());

  // The printed sheet this map actually is: the window is `spanX` feet wide and
  // `feets_per_inch` says how many feet go in an inch of paper.
  //
  // ⚠️ Not decoration. `ToolRegistry` memoizes every schema-`pure` tool on
  // `(worldId, windowId, acuityCell, args)`. With no surface `acuityCell` is
  // `null` on every turn, and since `whats_here`, `describe_surroundings` and
  // `get_crossing_info` take no positional argument their memo keys collapse —
  // the answer computed at Broadway and 32nd would be served again at the Empire
  // State Building. With a real surface the memo behaves the way it does in a
  // session. The runner clears the memo per turn as well: relying on either
  // alone is a silent correctness bug the moment the other changes.
  const [minX, minY, maxX, maxY] = adapter.bbox;
  const perInch = model.feets_per_inch || 1;
  const surface = createSurface({
    id: `mapio:${mapName}`,
    label: `${mapName} printed sheet`,
    // `continuous`: MapIO's maps are printed material, and their aspect was
    // fixed at print time. The acuity grid then falls back to `ACUITY_FLOOR_MM`,
    // which is the fingertip's own resolution and the right cell size for paper.
    kind: 'continuous',
    widthMm: ((maxX - minX) / perInch) * MM_PER_INCH,
    heightMm: ((maxY - minY) / perInch) * MM_PER_INCH,
  });

  const windowId = windowIdOf(adapter.bbox);
  const placeIndex = new PlaceIndex({ client, store: store || new MemoryStore() });
  // `fromCamioPoi` is the shipped normaliser and these are camio-shaped POI
  // records — literally the shape its doc comment names. Read off the raw JSON
  // rather than `graph.pois`, because `PoI` rewrites `edge` from an index into
  // an `Edge` object, and `fromCamioPoi` is documented as ignoring `edge` and
  // `coords` on purpose: L1 resolves the NAME, the tools compute the geometry.
  const places = model.graph.points_of_interest.map((record, i) => fromCamioPoi(record, i));
  onEvent?.({ type: 'index-build', map: mapName, places: places.length });
  const started = Date.now();
  await placeIndex.build({ worldId: adapter.worldId, windowId, places });
  onEvent?.({ type: 'index-built', map: mapName, ms: Date.now() - started });

  const briefing = buildWorldBriefing({ graph, model, now });
  const systemPrompt = buildSystemPrompt({ extra: `${UNTRUSTED_PREAMBLE}\n\n${briefing}` });

  return {
    mapName,
    model,
    graph,
    adapter,
    registry,
    served,
    surface,
    placeIndex,
    windowId,
    briefing,
    systemPrompt,
    routeLog,
    harnessTools: harnessTools ? [...HARNESS_TOOL_NAMES] : [],
    withheld: served.withheld.map((w) => w.name),
  };
}

/**
 * `$position_spec` → a position on the ported graph.
 *
 * The JS twin of `run_parity_benchmark.py#resolve_position`, clause for clause,
 * including the `street` clause's "midpoint of the middle edge" and the
 * `intersection` clause's subset test over `adjacents_streets`.
 *
 * @param {Graph} graph
 * @param {object|null} spec
 * @returns {{coords: Coords, element: object, kind: string}|null}
 */
export function resolvePositionSpec(graph, spec) {
  if (!spec) return null;

  if ('poi' in spec) {
    const poi = graph.pois.find((p) => p.name === spec.poi);
    if (!poi) throw new Error(`position: no POI named ${JSON.stringify(spec.poi)}`);
    return { coords: poi.coords, element: poi, kind: 'poi' };
  }

  if ('street' in spec) {
    const street = graph.streets.get(spec.street);
    if (!street) throw new Error(`position: no street named ${JSON.stringify(spec.street)}`);
    const edge = street.edges[Math.floor(street.edges.length / 2)];
    const mid = edge.node1.coords.add(edge.node2.coords).div(2);
    return { coords: mid, element: edge, kind: 'edge' };
  }

  if ('intersection' in spec) {
    const wanted = new Set(spec.intersection);
    const node = graph.nodes.find((n) => {
      const streets = new Set(n.adjacentsStreets);
      return [...wanted].every((s) => streets.has(s));
    });
    if (!node) throw new Error(`position: no intersection of ${spec.intersection.join(' and ')}`);
    return { coords: node.coords, element: node, kind: 'node' };
  }

  if ('node_index' in spec) {
    const node = graph.nodes[spec.node_index];
    if (!node) throw new Error(`position: no node at index ${spec.node_index}`);
    return { coords: node.coords, element: node, kind: 'node' };
  }

  throw new Error(`position: unknown spec ${JSON.stringify(spec)}`);
}

/**
 * The spoken position block prepended to the user turn.
 *
 * MapIO puts a `###Position Update###` section in every user message
 * (`prompt_formatter.py:88-131`) carrying the raw coordinates, the edge id, and
 * both node ids. This says the same thing **without the coordinates or the
 * ids**, for a structural reason rather than a stylistic one: MapIO's tools take
 * `x`/`y` as model-written arguments, and this system's do not — the position is
 * injected on every call and the model never names one. Putting map coordinates
 * in the prompt would invite arguments no tool accepts, and
 * `base_instructions` #1 forbids the graph vocabulary in the answer anyway.
 *
 * The prose itself is the port's: `Edge.getCompleteDescription()` and
 * `Node.getCompleteDescription()`, the same strings the Python renders.
 *
 * @param {object} world
 * @param {{coords: Coords, element: object, kind: string}|null} position
 * @returns {string}
 */
export function positionBlock(_world, position) {
  if (!position) return '';
  const { coords, element, kind } = position;

  if (kind === 'node') {
    return `Where I am: ${describe(element)}.\n\n`;
  }

  const edge = kind === 'poi' ? element.edge : element;
  const d1 = Math.floor(edge.node1.distanceTo(coords));
  const d2 = Math.floor(edge.node2.distanceTo(coords));
  const on = kind === 'poi' ? `at ${element.name}, on ` : 'on ';
  const segment = describe(edge);

  return (
    `Where I am: ${on}${segment}. `
    + `I am ${d1} feet from ${edge.node1.getLlmDescription()} and `
    + `${d2} feet from ${edge.node2.getLlmDescription()}.\n\n`
  );

  function describe(el) {
    try {
      return el.getCompleteDescription();
    } catch {
      // `Edge.getCompleteDescription` reads feature keys a partial model omits —
      // one of the seven reference bugs the port documents. Fall back rather
      // than lose the position.
      return el.getLlmDescription ? el.getLlmDescription() : String(el);
    }
  }
}

export default createParityWorld;
