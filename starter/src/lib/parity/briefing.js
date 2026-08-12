/**
 * The world briefing — the JS side of the curated prompt's skeleton.
 *
 * ## Why this exists when §4 says not to port the formatter
 *
 * §4 of `browser-voice-exploration-plan.md` says do not port
 * `prompt_formatter.py` / `curated_formatter.py`, and that is the right call for
 * the *tool* half: the tool set is different, capability-filtered, and
 * `candidateContext.js` already implements the candidate block that measured
 * 5/5. But the curated formatter's system prompt is two things bolted together,
 * and only one of them is a formatter:
 *
 *   1. the per-question candidate block  → `candidateContext.js` has it
 *   2. a **standing description of the world** — the street census, the complete
 *      POI census, the accessibility summary → nothing in `starter/` has it
 *
 * Without (2) the JS arm is not answering the same questions. Nine of the
 * benchmark's 26 turns are survey or existence questions — "give me an overall
 * description of the map", "what can I find on this map", "is there a Walmart on
 * this map", "tell me the roads parallel to this one" — and none of them is a
 * tool call in any tool set. MapIO answers them out of the system prompt. An arm
 * with no census cannot answer them at all, so the grade delta would measure a
 * missing prompt rather than the port, which is the one thing this benchmark
 * exists to isolate.
 *
 * So this is (2) and only (2), rebuilt from the **ported** graph objects, and it
 * goes in through `buildSystemPrompt({ extra })` — the seam that already exists
 * for exactly this (`dispatcher.js` passes `UNTRUSTED_PREAMBLE` through it).
 * Nothing here is per-utterance, so it rides the KV prefix.
 *
 * ## ⚠️ One reference bug not reproduced: the street census is inverted
 *
 * `curated_formatter.py#__street_census` sorts the east-west group with
 * `key=lambda t: -t[0]` where `t[0] = dot(midpoint, reference_system.north)`,
 * and labels the result "listed from north to south". On both bundled models
 * `reference_system.north` is `[0, 1]`, so that key is `+midpoint.y` and the
 * sort is descending — but map coordinates are **y-down** (`graph.py` defines
 * north as the versor `(0, -1)`, and `coordsToLatLng` reads `dn = -diff.y`;
 * checked numerically: on `new_york.json` the smallest y maps to the largest
 * latitude). So the Python lists east-west streets **south to north** under a
 * "north to south" heading, and north-south streets east to west under a "west
 * to east" heading.
 *
 * That is a factual error in the prompt, and reproducing it would mean grading
 * two arms against the same wrong ordering rather than against the map. Ordered
 * correctly here — ascending y is north to south, ascending x is west to east —
 * and flagged, because it is a live difference between the arms on `NY-P1`
 * ("tell me the roads parallel to this one") and anything else spatial.
 *
 * Platform-free.
 */

import { Coords } from '../logic/coords.js';
import { EdgeFeatures } from '../logic/edge.js';
import { NodeFeatures } from '../logic/node.js';

/** East, in map coordinates. From the code's convention, not the JSON's. */
const EAST = new Coords(1, 0);
/** North, in map coordinates: y grows south. `graph.js#getDirection` agrees. */
const NORTH = new Coords(0, -1);

/**
 * Categories shown per POI in the census. One, as in the Python — the census is
 * an existence list, not a description; the candidate block carries detail for
 * the places a question is actually about.
 */
const CENSUS_CATEGORIES = 1;

/**
 * Orientation and cross-axis position of a street.
 *
 * @param {object} street `logic/edge.js` Street
 * @returns {{orientation: 'east-west'|'north-south', cross: number}}
 */
export function streetOrientation(street) {
  const first = street.edges[0].node1.coords;
  const last = street.edges[street.edges.length - 1].node2.coords;
  const direction = last.sub(first);
  const mid = first.add(last).div(2);

  const alongEast = Math.abs(direction.dot(EAST));
  const alongNorth = Math.abs(direction.dot(NORTH));

  // An east-west street is ordered by how far north it is, and vice versa.
  // `cross` is in the *sorting* sense: ascending `cross` reads north→south for
  // the first group and west→east for the second, which is what the headings
  // below claim. See the module note.
  return alongEast >= alongNorth
    ? { orientation: 'east-west', cross: mid.y }
    : { orientation: 'north-south', cross: mid.x };
}

/** @param {object} graph */
export function streetCensus(graph) {
  const groups = { 'east-west': [], 'north-south': [] };
  for (const street of graph.streets.values()) {
    const { orientation, cross } = streetOrientation(street);
    groups[orientation].push({ cross, name: street.name });
  }

  const lines = [
    `The map shows a road network with ${graph.streets.size} streets, ${graph.nodes.length} `
      + `intersections and ${graph.edges.length} street segments. Details of the intersection or `
      + 'segment you are on come with your position; the rest come from the tools.',
  ];

  const ew = groups['east-west'].sort((a, b) => a.cross - b.cross).map((s) => s.name);
  const ns = groups['north-south'].sort((a, b) => a.cross - b.cross).map((s) => s.name);
  if (ew.length) lines.push(`Streets running east-west, listed from north to south: ${ew.join('; ')}.`);
  if (ns.length) lines.push(`Streets running north-south, listed from west to east: ${ns.join('; ')}.`);
  lines.push(
    'Streets in the same list are parallel to each other; streets in different lists cross each '
      + 'other where they share an intersection.',
  );
  return lines.join('\n');
}

/**
 * The complete POI list.
 *
 * Completeness is the load-bearing part and the reason it is not replaced by the
 * top-k candidate block: "is there a Walmart on this map" (`NY-N1`) is only
 * answerable — *deniably* answerable — against a list the model has been told is
 * exhaustive. Retrieval can rank five near-misses for a place that is not there.
 *
 * @param {object} graph
 */
export function poiCensus(graph) {
  const entries = graph.pois.map((poi) => {
    const categories = poi.info.categories || [];
    const shown = categories.slice(0, CENSUS_CATEGORIES).join(', ') || 'unknown';
    return `${poi.name} (${shown})`;
  });
  return (
    `The map contains exactly these ${graph.pois.length} points of interest, listed as name `
    + '(category). This list is complete: anything not on it is NOT on the map. Full details for '
    + 'the places most relevant to each question are ranked for you with the question itself; use '
    + 'get_place_details for anything beyond that.\n'
    + entries.join('; ')
  );
}

/**
 * Which streets carry which hazards, and how many crossings are equipped.
 *
 * Per-street aggregates rather than a per-edge dump: `NY-S4` ("tell me if there
 * are stairs at some point on the road") and `NY-A1` ("are there roadworks on
 * this street") are both answerable from the aggregate, and the per-segment
 * detail arrives with the position line for the segment the finger is on.
 *
 * @param {object} graph
 */
export function featureSummary(graph) {
  /** @type {Map<string, Set<string>>} */
  const byLabel = new Map();
  const add = (label, street) => {
    if (!byLabel.has(label)) byLabel.set(label, new Set());
    byLabel.get(label).add(street);
  };

  for (const edge of graph.edges) {
    const f = edge.features;
    if (f[EdgeFeatures.ROADWORK]) add('ongoing roadwork', edge.street);
    if (f[EdgeFeatures.STAIRS]) add('stairs', edge.street);
    if (f[EdgeFeatures.BIKE_LANE]) add('a bike lane', edge.street);
    const surface = f[EdgeFeatures.SURFACE];
    if (surface && surface !== 'concrete') add(`a ${surface} surface`, edge.street);
  }

  const lines = [
    'These are features of the road network. Include them when giving directions, so I can '
      + 'orient myself and avoid hazards.',
  ];
  for (const label of [...byLabel.keys()].sort()) {
    lines.push(
      `Streets with at least one segment with ${label}: ${[...byLabel.get(label)].sort().join(', ')}.`,
    );
  }

  const walkLights = graph.nodes.filter((n) => n.features[NodeFeatures.WALK_LIGHT]).length;
  const tactile = graph.nodes.filter((n) => n.features[NodeFeatures.TACTILE_PAVING]).length;
  lines.push(
    `${walkLights} of ${graph.nodes.length} intersections have a walklight and ${tactile} have `
      + 'tactile paving. Exact per-segment and per-intersection features come with your position '
      + 'when you are on that segment or intersection.',
  );
  return lines.join('\n');
}

/**
 * MapIO's `nodes_naming` block, reworded to obey `base_instructions` #1
 * ("answer without mentioning the underlying graph, its nodes and edges").
 * The rule it teaches is real and the benchmark grades it (`NY-L3`, "what is the
 * nearest intersection to the Empire State Building"); the vocabulary is not.
 */
export const INTERSECTION_NAMING =
  'Intersections are named after the streets that meet there — "the intersection of Webster '
  + 'Street and Washington Street". Streets with no intersection in common cannot cross. Where '
  + 'every street meeting at a point is the same street, the point is named after that street. '
  + 'Four streets meeting is a four-way intersection, three is a T intersection, and one marks '
  + 'the end of a street.';

/**
 * The map's own context block, verbatim from the model JSON's `context`.
 *
 * `NY-S1` ("give me an overall description of the map") is graded on this and
 * nothing else — the neighbourhood name, what lies beyond each edge of the
 * sheet. It exists only here.
 *
 * @param {object} model
 */
export function mapContext(model) {
  const context = model?.context;
  if (!context || typeof context !== 'object') return '';
  return Object.entries(context)
    .filter(([, value]) => value !== null && value !== undefined && String(value).trim())
    .map(([key, value]) => `${key.replace(/_/g, ' ')}: ${String(value).trim()}`)
    .join('\n');
}

/**
 * Assemble the briefing.
 *
 * @param {object} params
 * @param {object} params.graph   `logic/graph.js` Graph
 * @param {object} [params.model] parsed model JSON
 * @param {number} [params.now]   epoch ms, stamped ONCE per run — see below
 * @returns {string}
 */
export function buildWorldBriefing({ graph, model = {}, now } = {}) {
  const blocks = [];

  const context = mapContext(model);
  blocks.push(
    `### This map ###\n${model.name || 'A neighbourhood map'}.${context ? `\n${context}` : ''}`,
  );
  blocks.push(`### The road network ###\n${streetCensus(graph)}\n${INTERSECTION_NAMING}`);
  blocks.push(`### Road-network features ###\n${featureSummary(graph)}`);
  blocks.push(`### Points of interest ###\n${poiCensus(graph)}`);

  // ⚠️ Stamped once and never restamped. `LLM.freeze_system_prompt` exists in
  // the Python for the same reason: `datetime.now()` in the middle of the system
  // message changes the prefix every turn and the KV cache reuses nothing.
  // Two benchmark turns ask about 10 PM opening, so the clock has to be present.
  const clock = Number.isFinite(now) ? new Date(now) : null;
  blocks.push(
    '### Units and time ###\n'
      + 'Distances are in feet unless I ask for another unit. Directions are compass directions — '
      + 'north, north-east, east, and so on.'
      + (clock ? `\ncurrent time: ${formatClock(clock)}` : ''),
  );

  return blocks.join('\n\n');
}

/** MapIO's `%A %m-%d-%Y %H:%M:%S`, in UTC so a run is reproducible across machines. */
function formatClock(date) {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${days[date.getUTCDay()]} ${p(date.getUTCMonth() + 1)}-${p(date.getUTCDate())}-`
    + `${date.getUTCFullYear()} ${p(date.getUTCHours())}:${p(date.getUTCMinutes())}:${p(date.getUTCSeconds())}`
  );
}

export default buildWorldBriefing;
