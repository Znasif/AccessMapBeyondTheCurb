#!/usr/bin/env node
/**
 * Offline checks for the parity harness — no model, no server, no browser.
 *
 * Two jobs, and the second is the one worth the file:
 *
 *  1. **The harness works.** Adapter geometry, position specs, the briefing, the
 *     three harness tools, the runner's history threading, and the emitted JSON
 *     and Markdown, all driven by a scripted fake client.
 *  2. **The port still agrees with the Python.** Several of the checks below are
 *     pinned against numbers and strings taken out of the *recorded Python run*
 *     `arm1_curated_stt/parity_20260805_194151.json` — the same recording the
 *     arms replay. `NY-R2` is the sharpest: MapIO answered "approximately 841.66
 *     feet" and this adapter must produce the same distance to the last decimal,
 *     because it is the same Floyd–Warshall matrix and the same
 *     `getDistanceToPoi`. If that number ever moves, the acceptance test for P
 *     has failed and no LLM was involved.
 *
 *     node scripts/test_parity.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Graph } from '../src/lib/logic/graph.js';
import { Coords } from '../src/lib/logic/coords.js';
import { describeNeighbour } from '../src/lib/tools/shared.js';
import { getPlaceDetails } from '../src/lib/tools/getPlaceDetails.js';
import { describeSurroundings } from '../src/lib/tools/describeSurroundings.js';
import { whatsHere } from '../src/lib/tools/whatsHere.js';
import { makeResult } from '../src/lib/toolResult.js';
import { MemoryStore } from '../src/lib/placeIndex.js';
import { assertServable } from '../src/lib/toolRegistry.js';
import { findPerceptionKeys } from '../src/lib/turnContext.js';
import {
  MapioWorldAdapter,
  feetToMetres,
  metresToFeet,
  createParityWorld,
  resolvePositionSpec,
  positionBlock,
  buildWorldBriefing,
  streetOrientation,
  loadRecordedTranscript,
  utteranceFor,
  spokenFor,
  wordErrorRate,
  runParityBenchmark,
  buildRunRecord,
  buildRunMarkdown,
  summarise,
  timestampOf,
  GRADES,
  GPT4O_BAR,
  HARNESS_TOOL_NAMES,
  INPUT,
} from '../src/lib/parity/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const STARTER = resolve(HERE, '..');
const CAMIO = resolve(STARTER, '../explore/simple_camio_llm');
const RECORDED = join(CAMIO, 'benchmark/results/arm1_curated_stt/parity_20260805_194151.json');

let failures = 0;
let checks = 0;
const check = (ok, label, detail = '') => {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
};
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

const loadJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

/**
 * Every position-shaped tool result over a 21×21 grid on each map, plus
 * `get_place_details` for every POI, measured against `MAX_RESULT_CHARS`.
 *
 * This is the check that caught the truncation bug, and it has to stay a sweep
 * rather than a spot check: the first version measured one position and passed
 * while 88 of 1,764 positions were silently answering with one neighbour out of
 * five, because `capSize` reports a truncation only in `limits`.
 */
function sweepEnvelopes(adapters) {
  let truncated = 0;
  let total = 0;
  let worst = 0;
  for (const adapter of adapters) {
    const units = { distance: 'metres', direction: 'compass', duration: 'minutes' };
    const measure = (raw) => {
      const envelope = makeResult({ ...raw, frame: adapter.frame, worldId: adapter.worldId, units });
      total += 1;
      worst = Math.max(worst, JSON.stringify(envelope).length);
      if ((envelope.limits || []).some((l) => l.reason === 'too_large')) truncated += 1;
    };
    for (let i = 0; i <= 20; i += 1) {
      for (let j = 0; j <= 20; j += 1) {
        const ctx = { windowUv: { u: i / 20, v: j / 20 }, now: () => Date.now() };
        measure(describeSurroundings({}, ctx, { adapter }));
        measure(whatsHere({}, ctx, { adapter }));
      }
    }
    const ctx = { windowUv: { u: 0.5, v: 0.5 }, now: () => Date.now() };
    for (const place of adapter.places()) {
      measure(getPlaceDetails({ place: place.name, $place: place }, ctx, { adapter }));
    }
  }
  return { truncated, total, worst };
}
const schema = loadJson(join(STARTER, 'docs/llm-tools.schema.json'));
const nyModel = loadJson(join(CAMIO, 'models/new_york/new_york.json'));
const dtModel = loadJson(join(CAMIO, 'models/detroit_conant/detroit_conant.json'));
const recorded = loadJson(RECORDED);
const benchmark = loadJson(join(CAMIO, 'benchmark/mapio_benchmark.json'));

const nyGraph = new Graph(nyModel.graph, { feetsPerInch: nyModel.feets_per_inch });
const ny = new MapioWorldAdapter({ graph: nyGraph, model: nyModel, mapName: 'new_york' });

/* == 1. the adapter is a WorldAdapter, and it is the right one ============= */
console.log('\n-- adapter --');

check(ny.frame === 'geographic', 'the MapIO world is geographic', ny.frame);
check(
  ['places', 'graph', 'routing', 'accessibilityAttrs'].every((c) => ny.has(c)),
  'declares places, graph, routing and accessibilityAttrs',
  [...ny.capabilities].join(', '),
);
check(!ny.has('regions') && !ny.has('entrances'), 'does not over-declare regions or entrances');
check(ny.worldId === 'mapio:new_york', 'worldId is stable', ny.worldId);

// Feet, y-down. The whole frame choice rests on this, so pin it numerically
// rather than trusting the comment.
const north = ny.latLngOf(ny.uvToCoords(0.5, 0));
const south = ny.latLngOf(ny.uvToCoords(0.5, 1));
check(north.lat > south.lat, 'v = 0 is north: y grows southward', `${north.lat.toFixed(4)} > ${south.lat.toFixed(4)}`);
check(
  near(metresToFeet(feetToMetres(123.456)), 123.456, 1e-9),
  'feet ↔ metres round-trips',
);

// (u,v) ↔ coords is a bijection over the window.
const probe = ny.uvToCoords(0.37, 0.81);
const back = ny.coordsToUv(probe);
check(near(back.u, 0.37, 1e-12) && near(back.v, 0.81, 1e-12), 'uv → coords → uv is exact');

// The metric plane is isotropic: 1000 feet east and 1000 feet south must be the
// same metric length, which is exactly what `(u, v)` alone would get wrong.
const centre = ny.uvToCoords(0.5, 0.5);
const p0 = ny.metricPoint(0.5, 0.5);
const east1000 = ny.coordsToUv(new Coords(centre.x + 1000, centre.y));
const south1000 = ny.coordsToUv(new Coords(centre.x, centre.y + 1000));
const pE = ny.metricPoint(east1000.u, east1000.v);
const pS = ny.metricPoint(south1000.u, south1000.v);
check(
  near(Math.hypot(pE.x - p0.x, pE.y - p0.y), Math.hypot(pS.x - p0.x, pS.y - p0.y), 1e-9),
  'the metric plane is isotropic — 1000 ft east == 1000 ft south',
);

/* == 2. position specs, against the Python's resolve_position ============== */
console.log('\n-- position specs --');

const specs = {
  poi: resolvePositionSpec(nyGraph, { poi: 'Empire State Building' }),
  street: resolvePositionSpec(nyGraph, { street: 'West 35th Street' }),
  intersection: resolvePositionSpec(nyGraph, { intersection: ['5th Avenue', 'West 35th Street'] }),
  node: resolvePositionSpec(nyGraph, { node_index: 4 }),
};
check(specs.poi.kind === 'poi' && specs.poi.element.name === 'Empire State Building', '{poi} resolves');
check(specs.street.kind === 'edge' && specs.street.element.street === 'West 35th Street', '{street} resolves to its middle edge');
check(specs.intersection.kind === 'node', '{intersection} resolves to the shared node');
check(specs.node.element.index === 4, '{node_index} resolves');
check(resolvePositionSpec(nyGraph, null) === null, 'a null position stays null');

// ⚠️ The sharpest cross-check in this file. The recorded Python run sent
// `x: 2580.4127223098876, y: 1892.302663027251` for NY-R2's position, computed
// by `resolve_position()` on the Python graph. Ours must be the same point.
const r2 = specs.intersection.coords;
check(
  near(r2.x, 2580.4127223098876, 1e-9) && near(r2.y, 1892.302663027251, 1e-9),
  'NY-R2 position matches the coordinates the Python sent',
  `(${r2.x}, ${r2.y})`,
);

/* == 3. the numbers agree with the recorded Python run ==================== */
console.log('\n-- parity with the recorded Python run --');

const r2uv = ny.coordsToUv(r2);
const solle = ny.distanceTo(r2uv.u, r2uv.v, 'Solle Spa');
const solleFeet = metresToFeet(solle.value);
// MapIO answered "The distance to Solle Spa is approximately 841.66 feet."
check(
  near(solleFeet, 841.66, 0.01),
  'NY-R2: distance to Solle Spa matches MapIO to the cent',
  `${solleFeet.toFixed(2)} ft`,
);
check(solle.method === 'street_network', 'the distance is a walk along the streets, and says so', solle.method);

// NY-A2 is at node 4 and MapIO answered "yes, there is a walk light".
const a2 = ny.at(...Object.values(ny.coordsToUv(specs.node.coords)));
check(a2.node?.attrs?.walk_light === true, 'NY-A2: node 4 has a walk light, as MapIO reported');

// The `route_to` path exercises `processInstructions`, which is the byte-identical
// half of the port. A route must come back with prose, not an empty list.
const esb = ny.resolvePlace('Empire State Building');
const route = ny.route({ u: r2uv.u, v: r2uv.v }, esb, { streetByStreet: true });
check(route.waypoints.length > 0, 'a street-by-street route produces waypoints', `${route.waypoints.length} steps`);
check(
  /^(Head|Continue)/.test(route.waypoints[0].instructions),
  'waypoint prose is the port\'s own',
  route.waypoints[0].instructions,
);
check(
  findPerceptionKeys(route.waypoints).length === 0,
  'no (u, v) escapes into the route',
);

/* == 4. place resolution ================================================== */
console.log('\n-- places --');

check(ny.resolvePlace('empire state building')?.name === 'Empire State Building', 'names resolve case-insensitively');
check(ny.resolvePlace('AADA')?.name === 'American Academy of Dramatic Arts', 'a short_name alias resolves');
check(ny.resolvePlace('Walmart') === null, 'NY-N1: there is no Walmart, and the adapter says so');
check(
  Boolean(ny.resolvePlace('Empire State Building')?.description?.includes('5th Avenue')),
  'a place carries the POI record MapIO would have dumped',
);
const dtGraph = new Graph(dtModel.graph, { feetsPerInch: dtModel.feets_per_inch });
const dt = new MapioWorldAdapter({ graph: dtGraph, model: dtModel, mapName: 'detroit_conant' });
const hotel = dt.resolvePlace('Sheraton Commander Grand Lake');
check(Boolean(hotel), 'DT-T2: the hotel resolves from a partial name', hotel?.name);
check(
  /Mitchell Street/.test(hotel?.description || ''),
  'a place\'s description says where it is — the fact a list entry would want',
  (hotel?.description || '').slice(0, 60),
);
// DT-T3's whole grading note is "facilities.internet_access = 'free Wi-Fi'. Must
// come from POI details, not a guess." Nothing else in this system carries it:
// the candidate block is names and categories, and the POI census is name plus
// one category. So the whole path — adapter flattens into `props.facilities`,
// `get_place_details` reads it through the allowlist — has to work end to end.
const hotelDetails = getPlaceDetails(
  { place: hotel.name, $place: hotel },
  { now: () => Date.UTC(2026, 7, 12, 22, 0, 0), windowUv: { u: 0.5, v: 0.5 } },
  { adapter: dt },
);
check(
  /free Wi-?Fi/i.test(hotelDetails.data.facilities || ''),
  'DT-T3: free Wi-Fi reaches the model through get_place_details',
  (hotelDetails.data.facilities || '').slice(0, 60),
);
check(
  hotelDetails.data.hours === 'Open 24 hours, 7 days a week',
  'DT-T6-style hours reach it too',
  hotelDetails.data.hours,
);
// The size discipline that made the two previous checks possible.
const neighbours = dt.nearby(0.5, 0.5).slice(0, 5).map((p) => describeNeighbour(dt, { u: 0.5, v: 0.5 }, p));
check(
  neighbours.every((n) => !('description' in n)),
  'and a NEIGHBOUR entry carries no description — the envelope has to fit five',
);
const sweep = sweepEnvelopes([ny, dt]);
check(sweep.truncated === 0, 'no tool result is truncated anywhere on either map', `${sweep.total} sampled`);
check(sweep.worst < 1200, 'worst envelope stays under MAX_RESULT_CHARS', `${sweep.worst} chars`);

/* == 5. the briefing ====================================================== */
console.log('\n-- briefing --');

const briefing = buildWorldBriefing({ graph: nyGraph, model: nyModel, now: Date.UTC(2026, 7, 12, 22, 0, 0) });
check(briefing.includes('31 streets'), 'the street census counts the streets');
check(briefing.includes('exactly these 50 points of interest'), 'the POI census claims completeness');
check(briefing.includes('Empire State Building'), 'every POI is named, so absence is deniable');
check(!briefing.includes('Walmart'), 'and nothing that is not on the map is');
check(/Streets with at least one segment with stairs:/.test(briefing), 'NY-S4: stairs are aggregated per street');
check(/intersections have a walklight/.test(briefing), 'NY-A2: walklight counts are present');
check(briefing.includes('Bryant Park'), 'NY-S1: the map context block survives');
check(briefing.includes('current time:'), 'the clock is stamped');

// ⚠️ The Python's census is inverted; ours must not be. On new_york the
// northernmost east-west street is the one with the smallest y.
const ew = [...nyGraph.streets.values()]
  .map((s) => ({ name: s.name, ...streetOrientation(s) }))
  .filter((s) => s.orientation === 'east-west')
  .sort((a, b) => a.cross - b.cross);
const listed = briefing.split('listed from north to south: ')[1].split(';')[0].trim();
check(listed === ew[0].name, 'the east-west census really does start in the north', `${listed} (y=${ew[0].cross.toFixed(0)})`);
const northmostLat = ny.latLngOf(nyGraph.streets.get(ew[0].name).edges[0].node1.coords).lat;
const southmostLat = ny.latLngOf(nyGraph.streets.get(ew[ew.length - 1].name).edges[0].node1.coords).lat;
check(
  northmostLat > southmostLat,
  'and "north" there means a larger latitude',
  `${ew[0].name} ${northmostLat.toFixed(4)} > ${ew[ew.length - 1].name} ${southmostLat.toFixed(4)}`,
);

/* == 6. the transcript loader ============================================= */
console.log('\n-- transcript --');

const transcript = loadRecordedTranscript(recorded, { benchmark });
check(transcript.cases.length === 18, '18 cases replayed', String(transcript.cases.length));
check(transcript.turnCount === 26, '26 turns replayed', String(transcript.turnCount));
const r2turn = transcript.cases.flatMap((c) => c.turns).find((t) => t.id === 'NY-R2');
check(r2turn.heard === 'How far is soul spa on foot', 'the heard pass keeps the STT error', r2turn.heard);
check(r2turn.clean === 'How far is Solle Spa on foot?', 'the clean pass uses the reference');
check(utteranceFor(r2turn, INPUT.HEARD) !== utteranceFor(r2turn, INPUT.CLEAN), 'the two passes differ on this turn');
check(spokenFor(r2turn, INPUT.HEARD).wer_errors === 1, 'the recorded WER rides along on the heard pass');
check(spokenFor(r2turn, INPUT.CLEAN).wer_errors === undefined, 'and is NOT claimed on the clean pass');
check(spokenFor(r2turn, INPUT.CLEAN).sent_as === 'reference_text', 'the clean pass is marked as such');
const session = transcript.cases.find((c) => c.id === 'DT-SESSION');
check(session.turns.length === 9, 'DT-SESSION is nine turns of one conversation', String(session.turns.length));
check(Boolean(session.turns[0].gradingNotes), 'grading notes are recovered');
// The Python scored this turn 1/7: `Solle` → `soul` is a substitution, `Spa` →
// `spa` is not (case is ignored) and the `?` is not a word.
const scored = wordErrorRate(r2turn.clean, r2turn.heard);
check(
  scored.errors === r2turn.spoken.wer_errors && scored.words === r2turn.spoken.wer_words,
  'the WER function reproduces the Python\'s score for NY-R2',
  `${scored.errors}/${scored.words}`,
);
check(wordErrorRate('café', 'caf').errors === 1, 'and does not split a diacritic into two errors');

/* == 7. the runner, end to end, with a scripted model ===================== */
console.log('\n-- runner --');

/**
 * A scripted client. Round 1 emits a tool call, round 2 answers in prose, and
 * embeddings are a deterministic bag-of-characters so ranking is reproducible.
 * The point is the plumbing — history threading, envelopes, roll-back, the
 * emitted record — not the model.
 */
function scriptedClient({ script = {}, fail = new Set() } = {}) {
  const calls = [];
  const embed = (texts) => texts.map((text) => {
    const vec = new Float32Array(64);
    for (let i = 0; i < text.length; i += 1) vec[text.charCodeAt(i) % 64] += 1;
    let n = 0;
    for (const v of vec) n += v * v;
    n = Math.sqrt(n) || 1;
    return vec.map((v) => v / n);
  });
  return {
    calls,
    baseUrl: 'scripted',
    async chatCompletion({ messages, tools }) {
      calls.push({ messages, tools });
      const user = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
      const turnKey = Object.keys(script).find((key) => user.includes(key));
      if (turnKey && fail.has(turnKey)) throw new Error(`scripted failure on ${turnKey}`);
      const alreadyCalled = messages.some((m) => m.role === 'tool');
      const usage = { prompt_tokens: 3500 + messages.length, completion_tokens: 20, prompt_tokens_details: { cached_tokens: alreadyCalled ? 3400 : 0 } };
      if (!alreadyCalled && turnKey && script[turnKey]) {
        return {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: `c${calls.length}`, type: 'function', function: script[turnKey] }],
          },
          finishReason: 'tool_calls',
          usage,
        };
      }
      return {
        message: { role: 'assistant', content: `answered ${turnKey || 'nothing'} over ${messages.length} messages` },
        finishReason: 'stop',
        usage,
      };
    },
    async embedQueries(q) { return embed(q); },
    async embedDocuments(d) { return embed(d.map((x) => `${x.name} ${x.text}`)); },
  };
}

const client = scriptedClient({
  script: {
    'How far is soul spa': { name: 'get_distance_to', arguments: '{"place":"Solle Spa","units":"feet"}' },
    'Guide me to Empire State Building': { name: 'route_to', arguments: '{"place":"Empire State Building","mode":"fly_me_there"}' },
    'Is there a walk light here': { name: 'get_crossing_info', arguments: '{}' },
    'Are there roadwork on the street': { name: 'get_segment_accessibility', arguments: '{}' },
    'Tell me about Cafe China': { name: 'get_place_details', arguments: '{"place":"Cafe China"}' },
    'What\'s the nearest restaurant': { name: 'describe_surroundings', arguments: 'not json at all' },
  },
});

const worldCache = new Map();
const getWorld = async (mapName) => {
  if (worldCache.has(mapName)) return worldCache.get(mapName);
  const world = await createParityWorld({
    mapName,
    model: mapName === 'new_york' ? nyModel : dtModel,
    schema,
    client,
    store: new MemoryStore(),
    now: Date.UTC(2026, 7, 12, 22, 0, 0),
  });
  worldCache.set(mapName, world);
  return world;
};

const wanted = new Set(['NY-R2', 'NY-R4', 'NY-A2', 'NY-A1', 'NY-L2', 'NY-L5', 'DT-SESSION']);
const selected = transcript.cases.filter((c) => wanted.has(c.id));
const { results, warmupSec, worlds } = await runParityBenchmark({
  cases: selected,
  getWorld,
  client,
  input: INPUT.HEARD,
  k: 8,
  model: 'l3',
});

const turns = results.flatMap((c) => c.turns);
const byId = new Map(turns.map((t) => [t.id, t]));

check(results.length === selected.length, 'every selected case ran', `${results.length}`);
check(typeof warmupSec === 'number', 'the prefix was warmed and timed', `${warmupSec}s`);
check(worlds[0].tools.length === 9, 'nine tools are served on this world', worlds[0].tools.join(', '));
check(
  worlds[0].withheld.join(',') === 'set_route_preferences,stop_navigation',
  'and the two with no handler are withheld, not silently dropped',
  worlds[0].withheld.join(', '),
);
check(
  HARNESS_TOOL_NAMES.every((n) => worlds[0].tools.includes(n)),
  'the three harness tools reach the prompt',
);

check(byId.get('NY-R2').js.tool_results[0].status === 'ok', 'NY-R2 got an ok get_distance_to envelope');
check(
  byId.get('NY-R2').transcript.some((m) => m.tool_calls?.[0]?.name === 'get_distance_to'),
  'and compare_arms.py can read the call out of the transcript',
);
check(byId.get('NY-R2').rounds.length === 2, 'two rounds: call, then answer', String(byId.get('NY-R2').rounds.length));
check(byId.get('NY-R2').rounds[1].cached_tokens === 3400, 'cached_tokens survives into the record');

check(byId.get('NY-R4').guide_calls.length === 1, 'NY-R4 recorded a guide call');
check(byId.get('NY-R4').guide_calls[0].street_by_street === false, '"Guide me" is fly-me-there, as the prompt convention says');
check(byId.get('NY-R4').routes[0]?.waypoints?.length > 0, 'and the waypoints navigation would have received were recorded');

check(byId.get('NY-A2').js.tool_results[0].status === 'ok', 'NY-A2 read the crossing');
check(byId.get('NY-A1').js.tool_results[0].status === 'ok', 'NY-A1 read the segment');
check(byId.get('NY-L2').js.tool_results[0].status !== 'error', 'NY-L2 got place details', byId.get('NY-L2').js.tool_results[0].status);

// Malformed arguments must reach the model as a retryable tool result, never as
// an exception that kills the turn.
const l5 = byId.get('NY-L5');
check(Boolean(l5.malformed_tool_call), 'a malformed tool call is recorded, not thrown', l5.malformed_tool_call?.error?.slice(0, 40));
check(l5.answer !== null, 'and the turn still produces an answer');

// The nine-turn case must thread one conversation.
const dtTurns = results.find((c) => c.id === 'DT-SESSION').turns;
check(dtTurns.length === 9, 'DT-SESSION ran all nine turns');
const growth = dtTurns.map((t) => t.transcript.length);
check(growth.every((n) => n >= 1), 'every turn appended to the history');
check(
  /over (\d+) messages/.test(dtTurns[8].answer)
    && Number(/over (\d+) messages/.exec(dtTurns[8].answer)[1]) > Number(/over (\d+) messages/.exec(dtTurns[0].answer)[1]),
  'and the conversation grew: turn 9 saw more history than turn 1',
  `${/over (\d+) messages/.exec(dtTurns[0].answer)[1]} → ${/over (\d+) messages/.exec(dtTurns[8].answer)[1]}`,
);

// A turn that throws is rolled out entirely.
const failing = scriptedClient({ script: { 'Is there free Wi-Fi': { name: 'get_place_details', arguments: '{}' } }, fail: new Set(['Is there free Wi-Fi']) });
const failWorlds = new Map();
const failRun = await runParityBenchmark({
  cases: [transcript.cases.find((c) => c.id === 'DT-SESSION')],
  getWorld: async (mapName) => {
    if (!failWorlds.has(mapName)) {
      failWorlds.set(mapName, await createParityWorld({
        mapName, model: dtModel, schema, client: failing, store: new MemoryStore(), now: Date.now(),
      }));
    }
    return failWorlds.get(mapName);
  },
  client: failing,
  warmup: false,
});
const failTurns = failRun.results[0].turns;
check(failTurns[1].answer === null, 'a throwing turn records a null answer');
check(Boolean(failTurns[1].js.error), 'with the reason', failTurns[1].js.error?.slice(0, 40));
check(failTurns[2].answer !== null, 'and the next turn of the case still runs');
const seenBefore = /over (\d+) messages/.exec(failTurns[2].answer)[1];
const seenAfterOk = /over (\d+) messages/.exec(failTurns[3].answer)[1];
check(
  Number(seenAfterOk) > Number(seenBefore),
  'the failed turn left no trace in the history it rolled back',
  `${seenBefore} → ${seenAfterOk}`,
);

/* == 8. the emitted files ================================================= */
console.log('\n-- output shape --');

const run = buildRunRecord({
  results,
  label: 'js_node_e4b',
  arm: 'js_node_e4b',
  model: 'l3',
  server: 'http://localhost:11434/v1',
  backend: 'http',
  k: 8,
  input: INPUT.HEARD,
  warmupSec,
  worlds,
  harnessTools: [...HARNESS_TOOL_NAMES],
  transcriptSource: transcript.source,
  timestamp: timestampOf(new Date(2026, 7, 12, 22, 30, 0)),
});

// Every key `run_parity_benchmark.py` writes, with the same name.
for (const key of ['timestamp', 'label', 'server', 'model', 'k', 'formatter', 'routing', 'input',
  'prompt', 'benchmark', 'warmup_sec', 'stt_hints', 'grades', 'gpt4o_bar', 'results']) {
  check(key in run, `the JSON carries \`${key}\``);
}
check(run.timestamp === '20260812_223000', 'the timestamp format matches strftime', run.timestamp);
check(run.grades.join(',') === GRADES.join(','), 'the six grade classes, in the Python\'s order');
check(run.gpt4o_bar === GPT4O_BAR, 'the GPT-4o bar string is verbatim');
check(turns.every((t) => t.grade === null), 'every grade is null — grading is post-hoc');
check(run.harness_tools.length === 3, 'the harness-supplied tools are declared in the JSON');
check(run.stt === 'replayed' && run.stt_input === 'heard', 'the STT provenance is declared');

// The keys `compare_arms.py` reaches for, on a real turn.
const cmp = byId.get('NY-R2');
check(typeof cmp.elapsed_sec === 'number', 'compare_arms: elapsed_sec');
check(typeof cmp.answer === 'string', 'compare_arms: answer');
check(typeof cmp.spoken.reference_utterance === 'string', 'compare_arms: spoken.reference_utterance');
check(cmp.spoken.sent_as === 'transcript', 'compare_arms: spoken.sent_as');
check(Number.isFinite(cmp.rounds[0].prompt_tokens), 'compare_arms: rounds[0].prompt_tokens');
check('cached_tokens' in cmp.rounds[0], 'compare_arms: rounds[0].cached_tokens');
check(
  cmp.transcript.flatMap((m) => m.tool_calls || []).every((c) => 'name' in c && 'arguments' in c),
  'compare_arms: transcript[].tool_calls[].{name,arguments}',
);

const md = buildRunMarkdown(run);
check(md.startsWith('# MapIO parity run '), 'the Markdown opens the way the grader expects');
check(md.includes('**Grade:** '), 'and leaves a blank grade slot per turn');
check((md.match(/\*\*Grade:\*\* /g) || []).length === turns.length, 'one slot per turn', String(turns.length));
check(md.includes('**Q:**') && md.includes('**A ('), 'question and answer sections are present');
check(md.includes('Harness-supplied tools:'), 'and the grader is told which tools were harness-supplied');
check(md.includes('**Route ('), 'routes are printed for grading');

check(typeof summarise(run) === 'string' && summarise(run).includes('POST-HOC'), 'the summary refuses to report accuracy');

/* == 9. nothing leaks ===================================================== */
console.log('\n-- containment --');

const allEnvelopes = turns.flatMap((t) => t.js.tool_results);
check(allEnvelopes.length > 0, 'tools actually ran', String(allEnvelopes.length));
check(findPerceptionKeys(turns.map((t) => t.js.tool_results)).length === 0, 'no u/v in any recorded tool result');
for (const world of worldCache.values()) assertServable(world.served.tools);
check(true, 'every served tool survives assertServable (no schema metadata reaches the model)');
check(
  !worldCache.get('new_york').systemPrompt.includes('$note'),
  'and no `$note` reaches the system prompt',
);

// ⚠️ The one containment rule this arm has that MapIO does not. MapIO's tools
// take `x`/`y` as MODEL-WRITTEN arguments — `get_distance_to_point_of_interest`
// declares `{x, y, poi_index}` — and this system's take none: the position is
// injected on every call. So a map coordinate reaching the prompt would invite
// arguments no tool here accepts. Nothing user-facing may carry one.
const coordLike = /\b\d{3,4}\.\d{3,}\b/;
const promptText = [
  worldCache.get('new_york').systemPrompt,
  ...turns.map((t) => t.transcript.map((m) => m.content || '').join('\n')),
].join('\n');
check(!coordLike.test(promptText), 'no map coordinate reaches the prompt or any user turn');
check(
  !/\bn\d+ - n\d+\b/.test(promptText) && !/###Position Update###/.test(promptText),
  'and no node/edge id or MapIO prompt scaffolding either',
);
// The position IS stated, just in words the model can only pass back as a name.
const positioned = turns.find((t) => t.position);
check(
  /Where I am:/.test(positioned.transcript[0].content),
  'the position is stated in prose instead',
  positioned.transcript[0].content.split('\n').find((l) => l.startsWith('Where I am:'))?.slice(0, 70),
);

console.log(`\n${failures === 0 ? `all ${checks} checks passed` : `${failures} of ${checks} checks failed`}`);
process.exit(failures === 0 ? 0 : 1);
