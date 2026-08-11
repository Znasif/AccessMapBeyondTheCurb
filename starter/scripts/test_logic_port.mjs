#!/usr/bin/env node
/**
 * Milestone P check: the `simple_camio_llm` logic port, in Node.
 *
 *   node starter/scripts/test_logic_port.mjs
 *
 * Nothing here needs a server, a browser or a camera — that is the point of the
 * port (plan §4: "plain ES modules with zero platform imports, so it runs in
 * Node under the existing benchmark harness before it runs in a tab").
 *
 * WHERE THE EXPECTATIONS COME FROM. Three independent sources, deliberately:
 *
 *  1. **Hand-derived.** The Floyd–Warshall matrix for the five-node synthetic
 *     graph is written out by hand below and compared cell by cell, so the port
 *     is checked against arithmetic and not only against itself.
 *  2. **The real Python, executed.** Every value tagged `PY` was produced by
 *     running `explore/simple_camio_llm/src/graph`, `position` and `utils`
 *     unmodified against the same inputs (`python3`, no pip installs) and
 *     pasted in. That covers the parts where "what does the reference actually
 *     do" is the question — the two-branch nearest-edge rule, the collinear
 *     threshold, the exact prose of the instructions.
 *  3. **Reasoned invariants.** The announcement queue and the navigators are
 *     driven through their state machines with a fake clock.
 *
 * The `new_york` section loads `explore/simple_camio_llm/models/new_york/`
 * read-only as an integration case and is skipped (not failed) if the tree is
 * absent.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { Coords, pyRound, DIRECTIONS, coordsToLatLng, latLngToCoords } from '../src/lib/logic/coords.js';
import { Node, spokenQuantity } from '../src/lib/logic/node.js';
import { Edge } from '../src/lib/logic/edge.js';
import { PoI } from '../src/lib/logic/poi.js';
import { Buffer as SampleBuffer, ArithmeticBuffer } from '../src/lib/logic/buffer.js';
import {
  Graph,
  WayPoint,
  RouteAction,
  COLLINEAR_COS,
  mergeCollinear,
  getDirection,
  getTurningDirection,
} from '../src/lib/logic/graph.js';
import { PositionHandler, PositionInfo, MovementDirection } from '../src/lib/logic/positionHandler.js';
import { NavigationAction } from '../src/lib/logic/navigation/navigator.js';
import { StreetByStreetNavigator } from '../src/lib/logic/navigation/streetByStreetNavigator.js';
import { FlyOverNavigator } from '../src/lib/logic/navigation/flyOverNavigator.js';
import { NavigationController } from '../src/lib/logic/navigation/navigationController.js';
import {
  AnnouncementQueue,
  Category,
  Priority,
  AnnouncementType,
} from '../src/lib/logic/announcementQueue.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
let skipped = 0;
let section = '';

const EPS = 1e-9;

function head(title) {
  section = title;
  console.log(`\n── ${title}`);
}

function ok(name) {
  passed += 1;
  console.log(`  ok   ${name}`);
}

function bad(name, detail) {
  failed += 1;
  console.log(`  FAIL ${name}\n       ${detail}`);
}

function skip(name, why) {
  skipped += 1;
  console.log(`  skip ${name} (${why})`);
}

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) ok(name);
  else bad(name, `expected ${e}\n       actual   ${a}`);
}

function close(name, actual, expected, tol = 1e-6) {
  if (typeof actual === 'number' && Math.abs(actual - expected) <= tol) ok(name);
  else bad(name, `expected ${expected} ±${tol}, actual ${actual}`);
}

function closeArray(name, actual, expected, tol = 1e-6) {
  const flatA = [actual].flat(Infinity);
  const flatE = [expected].flat(Infinity);
  if (flatA.length !== flatE.length) {
    bad(name, `length ${flatA.length} != ${flatE.length}`);
    return;
  }
  for (let i = 0; i < flatA.length; i += 1) {
    if (!(Math.abs(flatA[i] - flatE[i]) <= tol)) {
      bad(name, `[${i}] expected ${flatE[i]} ±${tol}, actual ${flatA[i]}`);
      return;
    }
  }
  ok(name);
}

function truthy(name, value, detail = '') {
  if (value) ok(name);
  else bad(name, detail || `expected truthy, got ${JSON.stringify(value)}`);
}

function throws(name, fn, fragment) {
  try {
    fn();
  } catch (e) {
    if (!fragment || String(e.message).includes(fragment)) {
      ok(name);
      return;
    }
    bad(name, `threw "${e.message}", expected it to contain "${fragment}"`);
    return;
  }
  bad(name, 'did not throw');
}

/** A clock the tests own outright. */
function fakeClock(start = 0) {
  let t = start;
  const now = () => t;
  now.set = (v) => {
    t = v;
  };
  now.advance = (d) => {
    t += d;
  };
  return now;
}

// ---------------------------------------------------------------------------
// The synthetic map. Five nodes, four edges, two POIs.
//
//        n3(100,100) ─────────────────── n4(300,100)      "Far Street"
//             │
//             │ "Cross Street"
//             │
//   n0(0,0) ─ n1(100,0) ─ n2(200,0)                       "Main Street"
//
// Small enough that every shortest path is obvious by inspection, and shaped so
// that the A→E walk has exactly one real turn plus one straight continuation —
// which is what `mergeCollinear` and `processInstructions` need to be exercised.
// ---------------------------------------------------------------------------

const FULL_EDGE_FEATURES = {
  roadwork: false,
  slope: 'flat',
  bike_lane: false,
  surface: 'concrete',
  traffic_direction: 'two_way',
  stairs: false,
};

const SYNTHETIC = {
  nodes: [
    [0, 0],
    [100, 0],
    [200, 0],
    [100, 100],
    [300, 100],
  ],
  nodes_features: [{ on_border: true }, {}, { on_border: true }, {}, { on_border: true }],
  edges: [
    [0, 1],
    [1, 2],
    [1, 3],
    [3, 4],
  ],
  edges_features: [
    { ...FULL_EDGE_FEATURES },
    { roadwork: true, slope: 'uphill', bike_lane: true, surface: 'asphalt', traffic_direction: 'one_way', stairs: true },
    { ...FULL_EDGE_FEATURES },
    { ...FULL_EDGE_FEATURES, surface: 'gravel', bike_lane: true },
  ],
  streets: {
    'Main Street': [0, 1],
    'Cross Street': [2],
    'Far Street': [3],
  },
  points_of_interest: [
    {
      name: 'Corner Cafe',
      edge: 0,
      coords: [40, 6],
      accessibility: {
        wheelchair_accessible: true,
        tactile_paving: false,
        tactile_map: false,
        reception: false,
        stairs: false,
        elevator: true,
      },
    },
    {
      name: 'North Bank',
      edge: 2,
      coords: [104, 70],
      accessibility: {
        wheelchair_accessible: false,
        tactile_paving: true,
        tactile_map: true,
        reception: true,
        stairs: true,
        elevator: false,
      },
    },
  ],
  reference_system: { north: [0, 1], south: [0, -1], east: [1, 0], west: [-1, 0] },
  latlng_reference: { coords: [0, 0], lat: 40.0, lng: -73.0 },
};

const routes = [];
const graph = new Graph(SYNTHETIC, {
  feetsPerInch: 1,
  onRoute: (action, start, streetByStreet, waypoints) =>
    routes.push({ action, start, streetByStreet, waypoints }),
});

// ---------------------------------------------------------------------------
head('1. coords.js — geometry and Python-compatible rounding');
// ---------------------------------------------------------------------------

close('distanceTo', new Coords(0, 0).distanceTo(new Coords(3, 4)), 5);
close('manhattanDistanceTo', new Coords(1, 1).manhattanDistanceTo(new Coords(-2, 5)), 7);
close('dot', new Coords(1, 2).dot(new Coords(3, 4)), 11);
close('cross2d', new Coords(1, 0).cross2d(new Coords(0, 1)), 1);
closeArray('normalized', new Coords(3, 4).normalized().coords, [0.6, 0.8]);
truthy('equals is by value', new Coords(1, 2).equals(new Coords(1, 2)));
truthy('equals rejects non-Coords', !new Coords(1, 2).equals({ x: 1, y: 2 }));

// A 45° line through the origin: y = x, so m = 1, q = 0.
const diagonal = { m: 1, q: 0 };
close('distanceToLine', new Coords(0, 2).distanceToLine(diagonal), Math.SQRT2);
closeArray('projectOn', new Coords(0, 2).projectOn(diagonal).coords, [1, 1]);

// Vertical lines carry the x-intercept in `q` — the Python's convention.
const vertical = { m: Infinity, q: 7 };
close('distanceToLine (vertical)', new Coords(2, 99).distanceToLine(vertical), 5);
closeArray('projectOn (vertical)', new Coords(2, 99).projectOn(vertical).coords, [7, 99]);

// PY: Python's round() is half-to-even; Math.round() is not.
eq('pyRound(0.5) is 0 (half-to-even)', pyRound(0.5), 0);
eq('pyRound(1.5) is 2', pyRound(1.5), 2);
eq('pyRound(2.5) is 2', pyRound(2.5), 2);
eq('pyRound(-0.5) is -0', pyRound(-0.5), -0);
eq('pyRound(-1.5) is -2', pyRound(-1.5), -2);
eq('pyRound(2.675, 2)', pyRound(2.675, 2), 2.67);
truthy('Math.round would disagree on 2.5', Math.round(2.5) !== pyRound(2.5));

// PY: coords_to_latlng / latlng_to_coords round-trip on the new_york reference.
{
  const ref = { coords: new Coords(738.4595758155126, 3033.55837110577), lat: 40.74605893499274, lng: -73.99053528624474 };
  const latlng = coordsToLatLng(ref, new Coords(1000, 2800));
  const back = latLngToCoords(ref, latlng);
  closeArray('latlng round-trip', back.coords, [1000, 2800], 1e-6);
}

// ---------------------------------------------------------------------------
head('2. buffer.js — expiry, capacity, average');
// ---------------------------------------------------------------------------

{
  const clock = fakeClock(0);
  const buf = new SampleBuffer(3, 2.0, clock);
  buf.add('a');
  clock.advance(1);
  buf.add('b');
  eq('buffer keeps live samples', buf.items(), ['a', 'b']);

  clock.advance(1.5); // 'a' is now 2.5s old, past maxLife 2.0
  eq('buffer expires by age', buf.items(), ['b']);

  buf.add('c');
  buf.add('d');
  buf.add('e');
  eq('buffer caps at maxSize', buf.items(), ['c', 'd', 'e']);
  eq('first()', buf.first(), 'c');
  eq('last()', buf.last(), 'e');

  buf.clear();
  eq('clear()', buf.items(), []);
  eq('mode() of empty is null', buf.mode(), null);
}

{
  const clock = fakeClock(0);
  const buf = new SampleBuffer(5, 10, clock);
  ['x', 'y', 'x', 'z'].forEach((v) => buf.add(v));
  eq('mode() picks the most common', buf.mode(), 'x');
}

{
  const clock = fakeClock(0);
  const buf = new ArithmeticBuffer(5, 10, clock);
  buf.add(new Coords(0, 0));
  buf.add(new Coords(10, 20));
  buf.add(new Coords(20, 10));
  closeArray('ArithmeticBuffer.average', buf.average().coords, [10, 10]);
  eq('average of empty is null', new ArithmeticBuffer(3, 10, clock).average(), null);
}

// ---------------------------------------------------------------------------
head('3. Construction — nodes, edges, streets, POIs');
// ---------------------------------------------------------------------------

eq('node ids', graph.nodes.map((n) => n.id), ['n0', 'n1', 'n2', 'n3', 'n4']);
// PY: streets are appended once per incident edge, so duplicates are real and
// `intersectionType` counts the list rather than the set.
eq(
  'adjacent streets per node',
  graph.nodes.map((n) => n.adjacentsStreets),
  [
    ['Main Street'],
    ['Main Street', 'Main Street', 'Cross Street'],
    ['Main Street'],
    ['Cross Street', 'Far Street'],
    ['Far Street'],
  ],
);
eq(
  'node short descriptions',
  graph.nodes.map((n) => n.getShortDescription()),
  [
    'Main Street, at the limit of the map',
    'Cross Street at Main Street',
    'Main Street, at the limit of the map',
    'Cross Street at Far Street',
    'Far Street, at the limit of the map',
  ],
);
eq(
  'node LLM descriptions',
  graph.nodes.map((n) => n.getLlmDescription()),
  [
    'Main Street, at the limit of the map',
    'T intersection of Main Street and Cross Street',
    'Main Street, at the limit of the map',
    'intersection of Cross Street and Far Street',
    'Far Street, at the limit of the map',
  ],
);
// PY: yes, "at the limit of the map" really is emitted twice — get_llm_description
// already added it and get_complete_description adds it again. Reported, not fixed.
eq(
  'node complete descriptions (duplicated border clause is faithful)',
  graph.nodes.map((n) => n.getCompleteDescription()),
  [
    'Main Street, at the limit of the map, at the limit of the map',
    'T intersection of Main Street and Cross Street',
    'Main Street, at the limit of the map, at the limit of the map',
    'intersection of Cross Street and Far Street',
    'Far Street, at the limit of the map, at the limit of the map',
  ],
);
eq('node intersection types', graph.nodes.map((n) => n.intersectionType), ['', 'T', '', '', '']);
eq('isDeadEnd', graph.nodes.map((n) => n.isDeadEnd()), [false, false, false, false, false]);

eq('edge ids', graph.edges.map((e) => e.id), ['n0 - n1', 'n1 - n2', 'n1 - n3', 'n3 - n4']);
closeArray('edge lengths', graph.edges.map((e) => e.length), [100, 100, 100, 200]);
eq(
  'betweenStreets (crossing streets at either end)',
  graph.edges.map((e) => [...e.betweenStreets].sort()),
  [['Cross Street'], ['Cross Street'], ['Far Street', 'Main Street'], ['Cross Street']],
);
eq(
  'edge complete descriptions',
  graph.edges.map((e) => e.getCompleteDescription()),
  [
    'Main Street, concrete',
    'Main Street, asphalt, one-way, sloped, with roadwork, stairs on the way and a bike lane',
    'Cross Street, concrete',
    'Far Street, gravel, with a bike lane',
  ],
);
eq('streets', [...graph.streets.keys()], ['Main Street', 'Cross Street', 'Far Street']);
truthy('vertical edge slope is Infinity', graph.edges[2].m === Infinity);
close('vertical edge q carries the x-intercept', graph.edges[2].q, 100);
eq('contains() is strict at both ends', graph.edges[0].contains(new Coords(0, 0)), false);
eq('contains() inside', graph.edges[0].contains(new Coords(50, 0)), true);
eq('getDistanceDescription thirds', graph.edges[3].getDistanceDescription(new Coords(150, 100)), 'one third a block');
eq('getDistanceDescription half', graph.edges[3].getDistanceDescription(new Coords(220, 100)), 'half a block');
eq('getDistanceDescription two thirds', graph.edges[3].getDistanceDescription(new Coords(290, 100)), 'two third a block');
throws('getDistanceDescription off the edge throws', () => graph.edges[3].getDistanceDescription(new Coords(999, 100)), 'not on the edge');

closeArray('bounds', [graph.bounds[0].coords, graph.bounds[1].coords], [0, 0, 300, 100]);

eq('POIs start disabled with the LLM in the loop', graph.pois.map((p) => p.enabled), [false, false]);
eq(
  'POI complete descriptions',
  graph.pois.map((p) => p.getCompleteDescription()),
  [
    'Corner Cafe on Main Street, wheelchair accessible, accessible via elevator',
    'North Bank on Cross Street, with tactile paving and tactile map, accessible via stairs, includes a reception area',
  ],
);
truthy('PoI does not mutate the model JSON it was handed', SYNTHETIC.points_of_interest[0].name === 'Corner Cafe');
eq('spokenQuantity attaches the data unit', spokenQuantity('45 s'), '45 seconds');
eq('spokenQuantity singular', spokenQuantity('1 m'), '1 meter');
eq('spokenQuantity leaves unknown units alone', spokenQuantity('unknown'), 'unknown');

// ---------------------------------------------------------------------------
head('4. Floyd–Warshall — against a hand-computed matrix');
// ---------------------------------------------------------------------------

// Derived by inspection of the picture above, not from any implementation.
const EXPECTED_DISTANCES = {
  n0: { n0: 0, n1: 100, n2: 200, n3: 200, n4: 400 },
  n1: { n0: 100, n1: 0, n2: 100, n3: 100, n4: 300 },
  n2: { n0: 200, n1: 100, n2: 0, n3: 200, n4: 400 },
  n3: { n0: 200, n1: 100, n2: 200, n3: 0, n4: 200 },
  n4: { n0: 400, n1: 300, n2: 400, n3: 200, n4: 0 },
};

{
  let allMatch = true;
  let detail = '';
  for (const a of Object.keys(EXPECTED_DISTANCES)) {
    for (const b of Object.keys(EXPECTED_DISTANCES[a])) {
      const got = graph.distances[a][b];
      if (Math.abs(got - EXPECTED_DISTANCES[a][b]) > EPS) {
        allMatch = false;
        detail = `${a}->${b}: expected ${EXPECTED_DISTANCES[a][b]}, got ${got}`;
      }
    }
  }
  truthy('every distance-matrix cell matches the hand-computed value', allMatch, detail);
  truthy('matrix is symmetric', Object.keys(EXPECTED_DISTANCES).every((a) =>
    Object.keys(EXPECTED_DISTANCES).every((b) => Math.abs(graph.distances[a][b] - graph.distances[b][a]) <= EPS)));
}

// PY
eq('getMinPath n0 -> n4', graph.getMinPath(graph.nodes[0], graph.nodes[4]).map((n) => n.id), ['n0', 'n1', 'n3', 'n4']);
eq('getMinPath n2 -> n3', graph.getMinPath(graph.nodes[2], graph.nodes[3]).map((n) => n.id), ['n2', 'n1', 'n3']);
eq('getMinPath to itself is a single node', graph.getMinPath(graph.nodes[0], graph.nodes[0]).map((n) => n.id), ['n0']);

// An isolated node is unreachable: prev is null, so the path is empty rather
// than an exception.
{
  const islandDict = {
    ...SYNTHETIC,
    nodes: [...SYNTHETIC.nodes, [900, 900], [950, 950]],
    nodes_features: [...SYNTHETIC.nodes_features, {}, {}],
    edges: [...SYNTHETIC.edges, [5, 6]],
    edges_features: [...SYNTHETIC.edges_features, { ...FULL_EDGE_FEATURES }],
    streets: { ...SYNTHETIC.streets, 'Island Road': [4] },
  };
  const island = new Graph(islandDict, { feetsPerInch: 1 });
  eq('unreachable pair yields an empty path', island.getMinPath(island.nodes[0], island.nodes[5]), []);
  close('unreachable pair keeps the INF sentinel', island.distances.n0.n5, Graph.INF + 1);
  throws('getDistance across components throws', () => island.getDistance(new Coords(0, 0), new Coords(920, 920)), 'not connected');
  // PY quirk, reported and verified against the Python: an unreachable pair
  // gives an empty path, min(INF, 0) is 0, and the "start is a node" adjustment
  // then makes the crossing count NEGATIVE.
  eq('unreachable pair reports -1 crossings (Python quirk)', island.getCrossings(island.nodes[0], island.nodes[5]), -1);
  eq('unreachable pair from an edge reports 0', island.getCrossings(island.edges[0], island.nodes[5]), 0);
}

// ---------------------------------------------------------------------------
head('5. Nearest node / edge / POI, and snapping');
// ---------------------------------------------------------------------------

// PY — each row produced by running graph.py's own get_nearest_* on the point.
const NEAREST_CASES = [
  { point: [50, 3], node: 'n0', nodeDistance: 50.08991914547278, edge: 'n0 - n1', edgeDistance: 3.0, snap: [50, 3], snapType: 'Coords', forced: [50, 0], forcedType: 'Edge' },
  { point: [100, 40], node: 'n1', nodeDistance: 40.0, edge: 'n1 - n3', edgeDistance: 0, snap: [100, 40], snapType: 'Edge', forced: [100, 40], forcedType: 'Edge' },
  { point: [250, 105], node: 'n4', nodeDistance: 50.24937810560445, edge: 'n3 - n4', edgeDistance: 5.0, snap: [250, 105], snapType: 'Coords', forced: [250, 100], forcedType: 'Edge' },
  { point: [-30, -30], node: 'n0', nodeDistance: 42.42640687119285, edge: 'n0 - n1', edgeDistance: 42.42640687119285, snap: [-30, -30], snapType: 'Coords', forced: [-30, 0], forcedType: 'Edge' },
  { point: [150, 60], node: 'n3', nodeDistance: 64.03124237432849, edge: 'n3 - n4', edgeDistance: 40.0, snap: [150, 60], snapType: 'Coords', forced: [150, 100], forcedType: 'Edge' },
];

const typeName = (v) => (v instanceof Node ? 'Node' : v instanceof Edge ? 'Edge' : v instanceof PoI ? 'PoI' : 'Coords');

for (const c of NEAREST_CASES) {
  const p = new Coords(c.point[0], c.point[1]);
  const [node, nodeDistance] = graph.getNearestNode(p);
  const [edge, edgeDistance] = graph.getNearestEdge(p);
  const [snap, snapElement] = graph.snapToGraph(p);
  const [forced, forcedElement] = graph.snapToGraph(p, true);

  const label = `(${c.point.join(', ')})`;
  eq(`nearest node at ${label}`, [node.id, typeName(snapElement)], [c.node, c.snapType]);
  close(`nearest node distance at ${label}`, nodeDistance, c.nodeDistance);
  eq(`nearest edge at ${label}`, edge.id, c.edge);
  close(`nearest edge distance at ${label}`, edgeDistance, c.edgeDistance);
  closeArray(`snapToGraph at ${label}`, snap.coords, c.snap);
  eq(`snapToGraph(force) type at ${label}`, typeName(forcedElement), c.forcedType);
  closeArray(`snapToGraph(force) at ${label}`, forced.coords, c.forced);
}

// PY: nothing is enabled until the model asks, so this is null.
eq('getNearestPoi with everything disabled', graph.getNearestPoi(new Coords(40, 10))[0], null);
graph.enablePois([0, 1]);
{
  const [poi, distance] = graph.getNearestPoi(new Coords(40, 10));
  eq('getNearestPoi after enable', poi.name, 'Corner Cafe');
  close('getNearestPoi distance', distance, 4.0);
}
eq('enablePois accepts a name (design rule 2)', (() => {
  graph.disablePois();
  graph.enablePois(['North Bank']);
  return graph.pois.map((p) => p.enabled);
})(), [false, true]);
graph.enablePois([0, 1]);
throws('resolvePoi rejects an out-of-range index', () => graph.getPoiDetails(99), 'Invalid POI index');
throws('resolvePoi rejects an unknown name', () => graph.getPoiDetails('Nowhere'), 'Unknown POI');

// ---------------------------------------------------------------------------
head('6. Distances through the graph');
// ---------------------------------------------------------------------------

// PY. The middle case is the interesting one: (200, 0) is node n2, but its
// projection onto "Far Street" lands *inside* that edge while its projection
// onto its own street lands exactly on an endpoint — and `contains()` is
// strict — so the candidate-edge branch picks the far edge and the answer is
// 400, not 200. This is the rule most likely to be lost in a port.
closeArray('getDistance', [
  graph.getDistance(new Coords(0, 0), new Coords(200, 0)),
  graph.getDistance(new Coords(0, 0), new Coords(300, 100)),
  graph.getDistance(new Coords(50, 5), new Coords(105, 95)),
], [400, 400, 160]);
close('getDistanceToPoi (unrounded, unlike getDistance)', graph.getDistanceToPoi(new Coords(300, 100), 0), 366.0);
eq('amIAt within threshold', graph.amIAt(new Coords(40, 6), 0), true);
eq('amIAt outside threshold', graph.amIAt(new Coords(90, 6), 0), false);
eq('getNearbyPois default radius', graph.getNearbyPois(new Coords(0, 0), null), ['Corner Cafe', 'North Bank']);
eq('getNearbyPois tight radius', graph.getNearbyPois(new Coords(0, 0), 200.0), ['Corner Cafe', 'North Bank']);
eq('getNearbyPois negative radius means everything', graph.getNearbyPois(new Coords(0, 0), -1.0), ['Corner Cafe', 'North Bank']);
eq('getNearbyPois radius 0', graph.getNearbyPois(new Coords(0, 0), 0), []);

// PY
eq('getCrossings n0 -> n4', graph.getCrossings(graph.nodes[0], graph.nodes[4]), 3);
eq('getCrossings n0 -> n2', graph.getCrossings(graph.nodes[0], graph.nodes[2]), 2);
eq('getCrossings from an edge (no -1 adjustment)', graph.getCrossings(graph.edges[0], graph.nodes[4]), 3);
eq('getCrossings to itself', graph.getCrossings(graph.nodes[1], graph.nodes[1]), 0);

// ---------------------------------------------------------------------------
head('7. mergeCollinear — both sides of COLLINEAR_COS = 0.985');
// ---------------------------------------------------------------------------

eq('COLLINEAR_COS is unchanged', COLLINEAR_COS, 0.985);

// PY: cos(9.93°) = 0.98502 ≥ 0.985 merges; cos(9.95°) = 0.98496 < 0.985 does not.
// The comparison is `>=`, so a heading difference of exactly the threshold merges.
const MERGE_CASES = [
  { degrees: 0.0, merged: 1 },
  { degrees: 9.0, merged: 1 },
  { degrees: 9.93, merged: 1 },
  { degrees: 9.95, merged: 2 },
  { degrees: 10.0, merged: 2 },
  { degrees: 20.0, merged: 2 },
  { degrees: 90.0, merged: 2 },
];

for (const { degrees, merged } of MERGE_CASES) {
  const r = (degrees * Math.PI) / 180;
  const legs = [
    [new Coords(0, 0), new Coords(100, 0)],
    [new Coords(100, 0), new Coords(100 + 100 * Math.cos(r), 100 * Math.sin(r))],
  ];
  eq(`mergeCollinear at ${degrees}° (cos ${Math.cos(r).toFixed(5)})`, mergeCollinear(legs).length, merged);
}

{
  // Exactly at the threshold: build the second leg from the cosine itself.
  const c = COLLINEAR_COS;
  const s = Math.sqrt(1 - c * c);
  const legs = [
    [new Coords(0, 0), new Coords(100, 0)],
    [new Coords(100, 0), new Coords(100 + 100 * c, 100 * s)],
  ];
  eq('mergeCollinear merges AT the threshold (>=)', mergeCollinear(legs).length, 1);
}

{
  // Three collinear legs collapse to one, and the merged leg spans end to end.
  const legs = [
    [new Coords(0, 0), new Coords(100, 0)],
    [new Coords(100, 0), new Coords(200, 0)],
    [new Coords(200, 0), new Coords(300, 0)],
  ];
  const merged = mergeCollinear(legs);
  eq('three collinear legs fold into one', merged.length, 1);
  closeArray('folded leg spans end to end', [merged[0][0].coords, merged[0][1].coords], [0, 0, 300, 0]);
}

eq('mergeCollinear of nothing', mergeCollinear([]), []);

// ---------------------------------------------------------------------------
head('8. Headings');
// ---------------------------------------------------------------------------

eq('DIRECTIONS order (load-bearing)', [...DIRECTIONS], [
  'south-west', 'west', 'north-west', 'north', 'north-east', 'east', 'south-east', 'south',
]);

// PY
const SQ = Math.SQRT1_2;
eq('getDirection (0,-1)', getDirection(new Coords(0, -1)), 'north');
eq('getDirection (1,0)', getDirection(new Coords(1, 0)), 'east');
eq('getDirection (0,1)', getDirection(new Coords(0, 1)), 'south');
eq('getDirection (-1,0)', getDirection(new Coords(-1, 0)), 'west');
eq('getDirection diagonal up-right', getDirection(new Coords(SQ, -SQ)), 'north-east');
eq('getDirection diagonal down-left', getDirection(new Coords(-SQ, SQ)), 'south-west');

eq('turning right from north', getTurningDirection(new Coords(1, 0), 'north', new Coords(0, -1)), 'east');
eq('turning left from north', getTurningDirection(new Coords(-1, 0), 'north', new Coords(0, -1)), 'west');
eq('turning right from east', getTurningDirection(new Coords(0, 1), 'east', new Coords(1, 0)), 'south');
eq('45° right from east', getTurningDirection(new Coords(SQ, SQ), 'east', new Coords(1, 0)), 'south-east');
eq('straight on keeps the heading', getTurningDirection(new Coords(0, 1), 'south', new Coords(0, 1)), 'south');

// ---------------------------------------------------------------------------
head('9. Route legs and instruction processing (3 legs, one real turn)');
// ---------------------------------------------------------------------------

{
  const legs = graph.localLegs(new Coords(0, 0), new Coords(300, 100));
  eq('localLegs produces 3 legs', legs.length, 3);
  closeArray('localLegs geometry', legs.map((l) => [l[0].coords, l[1].coords]), [
    0, 0, 100, 0,
    100, 0, 100, 100,
    100, 100, 300, 100,
  ]);

  const waypoints = graph.processInstructions(legs);
  // PY — the prose, verbatim from __process_instructions.
  eq('waypoint instructions', waypoints.map((w) => w.instructions), [
    'Head east until Cross Street at Main Street',
    'Head south until Cross Street at Far Street',
    'Head east until Far Street, at the limit of the map',
  ]);
  eq('waypoint directions', waypoints.map((w) => w.direction), ['east', 'south', 'east']);
  eq('waypoint names', waypoints.map((w) => w.name), [
    'Cross Street at Main Street',
    'Cross Street at Far Street',
    'Far Street, at the limit of the map',
  ]);
  closeArray('waypoint coords', waypoints.map((w) => w.coords.coords), [100, 0, 100, 100, 300, 100]);
  // PY bug, preserved: `distance` is a Coords, not a scalar.
  truthy('WayPoint.distance is a Coords (faithful to the Python)', waypoints[0].distance instanceof Coords);
  closeArray('WayPoint.distance vector', waypoints.map((w) => w.distance.coords), [100, 0, 0, 100, 200, 0]);
}

{
  routes.length = 0;
  graph.guideToDestination(new Coords(0, 0), new Coords(300, 100), true);
  eq('street-by-street emits CALCULATING then ON_ROUTE',
    routes.map((r) => r.action), [RouteAction.CALCULATING_ROUTE, RouteAction.ON_ROUTE]);
  eq('street-by-street waypoint count', routes[1].waypoints.length, 3);

  routes.length = 0;
  graph.guideToDestination(new Coords(0, 0), new Coords(300, 100), false);
  eq('fly-over emits a single ON_ROUTE', routes.map((r) => r.action), [RouteAction.ON_ROUTE]);
  eq('fly-over waypoint count', routes[0].waypoints.length, 1);
  eq('fly-over direction', routes[0].waypoints[0].direction, 'east');

  routes.length = 0;
  graph.guideToDestination(new Coords(0, 0), new Coords(0, 0), true);
  eq('start == destination is an ERROR, not a throw', routes.map((r) => r.action), [RouteAction.ERROR]);

  routes.length = 0;
  graph.guideToPoi(new Coords(0, 0), 'North Bank', true);
  truthy('guideToPoi resolves by name and routes', routes[routes.length - 1].action === RouteAction.ON_ROUTE);

  // A legs provider that fails must reach the callback as ERROR — the Python's
  // comment: an exception here would leave guidance permanently silent.
  const failing = new Graph(SYNTHETIC, {
    feetsPerInch: 1,
    onRoute: (action) => routes.push({ action }),
    legsProvider: () => {
      throw new Error('synthetic routing failure');
    },
  });
  routes.length = 0;
  failing.guideToDestination(new Coords(0, 0), new Coords(300, 100), true);
  eq('a failing legs provider surfaces as ERROR',
    routes.map((r) => r.action), [RouteAction.CALCULATING_ROUTE, RouteAction.ERROR]);
}

// ---------------------------------------------------------------------------
head('10. positionHandler — snapping, hysteresis, movement');
// ---------------------------------------------------------------------------

{
  const clock = fakeClock(100);
  // feetsPerInch 100 puts the inch-denominated thresholds on the same scale as
  // this 300x100 map: nodes 15, POIs 25, edges 30, gravity 20, movement 12.5.
  const handler = new PositionHandler(graph, { feetsPerInch: 100, feetsPerPixel: 1, now: clock });

  closeArray('bounds are padded by MAP_MARGIN', [handler.minCorner.coords, handler.maxCorner.coords], [-100, -100, 400, 200]);
  eq('a sample inside the padded bounds is accepted', handler.processPosition(new Coords(100, 10)), true);
  eq('a sample outside is rejected', handler.processPosition(new Coords(9999, 9999)), false);

  let info = handler.getPositionInfo();
  eq('snaps to the node it is standing on', info.isNode() && info.graphElement.id, 'n1');
  eq('node readings get double life', info.maxLife, PositionInfo.DEFAULT_MAX_LIFE * 2);

  // 30 units away: past the node radius (15) but inside radius + gravity (35).
  handler.positionsBuffer.clear();
  clock.advance(0.1);
  handler.processPosition(new Coords(100, 30));
  info = handler.getPositionInfo();
  eq('gravity holds the node past its own radius', info.isNode() && info.graphElement.id, 'n1');

  // 45 units away: past radius + gravity, so it falls through to the edge.
  handler.positionsBuffer.clear();
  clock.advance(0.1);
  handler.processPosition(new Coords(100, 45));
  info = handler.getPositionInfo();
  eq('beyond gravity it falls through to the edge', info.isEdge() && info.description, 'Cross Street');

  // POIs outrank nodes and edges.
  handler.clear();
  clock.advance(0.1);
  handler.processPosition(new Coords(104, 78));
  info = handler.getPositionInfo();
  eq('an enabled POI outranks the edge it sits on', info.isPoi() && info.description, 'North Bank');

  // Off the network entirely.
  handler.clear();
  clock.advance(0.1);
  handler.processPosition(new Coords(300, -80));
  info = handler.getPositionInfo();
  eq('off-network reading has no graph element', info.graphElement, null);
  eq('distance to a missing element is Infinity', info.distance, null); // JSON: Infinity -> null

  // Movement along an edge, measured from the oldest live sample to the average.
  handler.clear();
  handler.lastInfo = new PositionInfo(new Coords(100, 10), graph.edges[2], 'Cross Street', { timestamp: clock() });
  handler.processPosition(new Coords(100, 10));
  clock.advance(0.1);
  handler.processPosition(new Coords(100, 90));
  eq('movement along the edge is FORWARD',
    handler.getEdgeMovementDirection(handler.positionsBuffer.average(), graph.edges[2]),
    MovementDirection.FORWARD);

  handler.clear();
  handler.lastInfo = new PositionInfo(new Coords(100, 90), graph.edges[2], 'Cross Street', { timestamp: clock() });
  handler.processPosition(new Coords(100, 90));
  clock.advance(0.1);
  handler.processPosition(new Coords(100, 10));
  eq('movement against the edge is BACKWARD',
    handler.getEdgeMovementDirection(handler.positionsBuffer.average(), graph.edges[2]),
    MovementDirection.BACKWARD);

  handler.clear();
  handler.lastInfo = new PositionInfo(new Coords(100, 50), graph.edges[2], 'Cross Street', { timestamp: clock() });
  handler.processPosition(new Coords(100, 50));
  clock.advance(0.1);
  handler.processPosition(new Coords(100, 55));
  eq('a sub-threshold twitch is not movement',
    handler.getEdgeMovementDirection(handler.positionsBuffer.average(), graph.edges[2]),
    MovementDirection.NONE);

  handler.clear();
  handler.lastInfo = new PositionInfo(new Coords(60, 50), graph.edges[2], 'Cross Street', { timestamp: clock() });
  handler.processPosition(new Coords(60, 50));
  clock.advance(0.1);
  handler.processPosition(new Coords(140, 50));
  eq('movement across the edge (>60°) is not movement',
    handler.getEdgeMovementDirection(handler.positionsBuffer.average(), graph.edges[2]),
    MovementDirection.NONE);

  handler.clear();
  handler.lastInfo = new PositionInfo(new Coords(100, 10), graph.edges[2], 'Cross Street', { timestamp: clock() });
  clock.advance(1000); // lastInfo is now far past its maxLife
  handler.processPosition(new Coords(100, 10));
  handler.processPosition(new Coords(100, 90));
  eq('a stale last reading suppresses movement',
    handler.getEdgeMovementDirection(handler.positionsBuffer.average(), graph.edges[2]),
    MovementDirection.NONE);

  eq('snapToGraph() on a PositionInfo returns the element point',
    new PositionInfo(new Coords(100, 40), graph.nodes[1]).snapToGraph().coords, [100, 0]);
}

// ---------------------------------------------------------------------------
head('11. Navigation — street by street');
// ---------------------------------------------------------------------------

const routeWaypoints = graph.processInstructions(graph.localLegs(new Coords(0, 0), new Coords(300, 100)));

function positionAt(x, y, element, options = {}) {
  return new PositionInfo(new Coords(x, y), element, options.description ?? '', {
    movement: options.movement ?? MovementDirection.NONE,
    timestamp: options.timestamp ?? 0,
  });
}

{
  const clock = fakeClock(0);
  const actions = [];
  const nav = new StreetByStreetNavigator(
    graph, 10, 5,
    (action, payload) => actions.push({ action, payload }),
    routeWaypoints,
    clock,
  );

  eq('a navigator with waypoints is not running until started', nav.isRunning(), false);
  nav.start(positionAt(0, 0, graph.nodes[0]));
  eq('start announces the first leg', actions.map((a) => a.action), [NavigationAction.ANNOUNCE_DIRECTION]);
  eq('start announces the right text', actions[0].payload.instructions, routeWaypoints[0].instructions);
  eq('navigator is running', nav.isRunning(), true);

  actions.length = 0;
  clock.advance(0.5);
  nav.update(positionAt(100, 0, graph.nodes[1]), false);
  eq('arriving at a waypoint reports WAYPOINT_REACHED', actions.map((a) => a.action), [NavigationAction.WAYPOINT_REACHED]);

  // Sitting on the waypoint without moving: after NEXT_STEP_INTERVAL the
  // navigator advances to the next leg on its own.
  actions.length = 0;
  clock.advance(0.5);
  nav.update(positionAt(100, 0, graph.nodes[1]), false);
  eq('re-arriving before the interval says nothing', actions.length, 0);

  clock.advance(1.5);
  nav.update(positionAt(100, 0, graph.nodes[1]), false);
  eq('after NEXT_STEP_INTERVAL it announces the next leg',
    actions.map((a) => a.action), [NavigationAction.ANNOUNCE_DIRECTION]);
  eq('and the next leg is the second one', actions[0].payload.instructions, routeWaypoints[1].instructions);

  // Moving to a new graph element resets the stall timer, so the first update
  // away from the waypoint must NOT reroute...
  actions.length = 0;
  clock.advance(5);
  nav.update(positionAt(0, 0, graph.nodes[0]), false);
  eq('arriving somewhere new resets the stall timer',
    actions.filter((a) => a.action === NavigationAction.NEW_ROUTE).length, 0);

  // ...and staying put past NEXT_STEP_INTERVAL must.
  actions.length = 0;
  clock.advance(5);
  nav.update(positionAt(0, 0, graph.nodes[0]), false);
  eq('stalling off-waypoint requests a reroute', actions.map((a) => a.action), [NavigationAction.NEW_ROUTE]);

  actions.length = 0;
  clock.advance(5);
  nav.update(positionAt(0, 0, graph.nodes[0]), false);
  eq('while waiting for the reroute it stays silent', actions.length, 0);

  // The route_failed() chain — without it the navigator is frozen for good.
  nav.routeFailed();
  actions.length = 0;
  clock.advance(5);
  nav.update(positionAt(0, 0, graph.nodes[0]), false);
  eq('routeFailed() unfreezes the navigator', actions.map((a) => a.action), [NavigationAction.NEW_ROUTE]);
}

{
  const clock = fakeClock(0);
  const actions = [];
  const nav = new StreetByStreetNavigator(
    graph, 10, 5, (action, payload) => actions.push({ action, payload }),
    [routeWaypoints[2]], clock,
  );
  nav.start(positionAt(0, 0, graph.nodes[0]));
  actions.length = 0;
  nav.update(positionAt(300, 100, graph.nodes[4]), false);
  eq('the last waypoint reports DESTINATION_REACHED', actions.map((a) => a.action), [NavigationAction.DESTINATION_REACHED]);
  eq('and stops running', nav.isRunning(), false);
}

{
  const clock = fakeClock(0);
  const actions = [];
  const nav = new StreetByStreetNavigator(
    graph, 10, 5, (action) => actions.push(action), [routeWaypoints[0]], clock,
  );
  // Starting already on the only waypoint is an immediate arrival.
  nav.start(positionAt(100, 0, graph.nodes[1]));
  eq('starting on the destination arrives at once', actions, [NavigationAction.DESTINATION_REACHED]);
}

throws('an empty waypoint list is rejected',
  () => new StreetByStreetNavigator(graph, 10, 5, () => {}, []), 'cannot be empty');

// ---------------------------------------------------------------------------
head('12. Navigation — fly over, and the controller');
// ---------------------------------------------------------------------------

{
  const clock = fakeClock(0);
  const actions = [];
  const destination = new WayPoint(new Coords(300, 100), new Coords(300, 100), 0, 'east');
  const nav = new FlyOverNavigator(graph, 10, 150, (action, payload) => actions.push({ action, payload }), destination, clock);

  nav.update(positionAt(0, 0, null, { timestamp: 10 }), false);
  eq('a stopped fly-over navigator says nothing', actions.length, 0);

  nav.start(positionAt(0, 0, null, { timestamp: 10 }));
  clock.set(10);
  nav.update(positionAt(0, 0, null, { timestamp: 10 }), false);
  eq('x-dominant error far away announces "far east"',
    actions.map((a) => a.payload.instructions), ['far east']);

  actions.length = 0;
  clock.set(10.5);
  nav.update(positionAt(0, 0, null, { timestamp: 10.5 }), false);
  eq('inside ANNOUNCEMENTS_INTERVAL it stays quiet', actions.length, 0);

  clock.set(12);
  nav.update(positionAt(250, 100, null, { timestamp: 12 }), false);
  eq('close in, the "far" prefix drops', actions.map((a) => a.payload.instructions), ['east']);

  actions.length = 0;
  clock.set(14);
  nav.update(positionAt(300, 40, null, { timestamp: 14 }), false);
  eq('y-dominant error announces south', actions.map((a) => a.payload.instructions), ['south']);

  actions.length = 0;
  clock.set(16);
  nav.update(positionAt(300, 160, null, { timestamp: 16 }), false);
  eq('y-dominant error the other way announces north', actions.map((a) => a.payload.instructions), ['north']);

  actions.length = 0;
  nav.update(positionAt(298, 102, null, { timestamp: 18 }), false);
  eq('arriving reports DESTINATION_REACHED', actions.map((a) => a.action), [NavigationAction.DESTINATION_REACHED]);
}

{
  const clock = fakeClock(0);
  const actions = [];
  const controller = new NavigationController(graph, (action, payload) => actions.push({ action, payload }), {
    feetsPerInch: 100,
    now: clock,
  });

  eq('no navigation to begin with', controller.isNavigationRunning(), false);
  eq('an empty waypoint list is refused', controller.navigateStreetByStreet([]), false);

  controller.navigateStreetByStreet(routeWaypoints);
  eq('navigation is running', controller.isNavigationRunning(), true);

  // ignoreNotMoving keeps a not-yet-started navigator from starting — that is
  // how the Python holds guidance back while the LLM or the TTS is busy.
  controller.update(positionAt(0, 0, graph.nodes[0]), true);
  eq('ignoreNotMoving defers the start', actions.length, 0);

  controller.update(positionAt(0, 0, graph.nodes[0]), false);
  eq('the controller starts the navigator', actions.map((a) => a.action), [NavigationAction.ANNOUNCE_DIRECTION]);

  actions.length = 0;
  const flyDestination = new WayPoint(new Coords(300, 100), new Coords(300, 100), 0, 'east');
  controller.navigate(flyDestination);
  controller.update(positionAt(0, 0, null, { timestamp: 0 }), false); // starts it
  clock.set(5);
  controller.update(positionAt(299, 100, null, { timestamp: 5 }), false);
  eq('DESTINATION_REACHED reaches the owner', actions.map((a) => a.action), [NavigationAction.DESTINATION_REACHED]);
  eq('and the controller clears itself first', controller.isNavigationRunning(), false);

  controller.routeFailed(); // must not throw with no navigator
  ok('routeFailed() with no navigator is a no-op');
}

// ---------------------------------------------------------------------------
head('13. announcementQueue — categories, priorities, interrupts, timestamps');
// ---------------------------------------------------------------------------

/** A queue wired to a controllable "voice". */
function makeQueue(clock) {
  const spoken = [];
  const ended = [];
  const cancelled = [];
  const queue = new AnnouncementQueue({
    now: clock,
    speak: (a) => spoken.push(a.type === AnnouncementType.PAUSE ? `<pause ${a.duration}>` : a.text),
    cancel: (a) => cancelled.push(a.type === AnnouncementType.PAUSE ? '<pause>' : a.text),
    onAnnouncementEnded: (a, announced) =>
      ended.push([a.type === AnnouncementType.PAUSE ? '<pause>' : a.text, announced]),
  });
  queue.start();
  return { queue, spoken, ended, cancelled };
}

{
  const clock = fakeClock(0);
  const { queue, spoken, ended } = makeQueue(clock);

  queue.say('first', Category.SYSTEM, Priority.LOW);
  queue.say('second', Category.SYSTEM, Priority.LOW);
  eq('only the head speaks; the rest queue', spoken, ['first']);
  eq('the queue is speaking', queue.isSpeaking(), true);

  queue.finishCurrent();
  eq('finishing starts the next one', spoken, ['first', 'second']);
  eq('and reports the finished one as announced', ended, [['first', true]]);

  queue.finishCurrent();
  eq('the queue drains', queue.isSpeaking(), false);
  eq('lastAnnouncement is kept', queue.lastAnnouncement.text, 'second');
}

{
  const clock = fakeClock(0);
  const { queue, spoken } = makeQueue(clock);

  queue.disableCategory(Category.GRAPH);
  eq('a muted category is refused', queue.say('street name', Category.GRAPH), null);
  eq('a muted category queues nothing', spoken, []);
  eq('isEnabled reports the mute', queue.isEnabled(Category.GRAPH), false);
  eq('other categories are unaffected', queue.isEnabled(Category.LLM), true);

  queue.enableCategory(Category.GRAPH);
  truthy('re-enabling lets it through', queue.say('street name', Category.GRAPH) !== null);
  eq('and it speaks', spoken, ['street name']);

  queue.disableAllCategories();
  eq('disableAllCategories mutes everything', [...Object.values(Category)].map((c) => queue.isEnabled(c)), [false, false, false, false, false]);
  queue.enableAllCategories();
  eq('enableAllCategories restores everything', [...Object.values(Category)].map((c) => queue.isEnabled(c)), [true, true, true, true, true]);

  eq('empty text is refused', queue.say('   ', Category.SYSTEM), null);
  eq('null text is refused', queue.say(null, Category.SYSTEM), null);
}

{
  const clock = fakeClock(0);
  const { queue, spoken, ended, cancelled } = makeQueue(clock);

  queue.say('a long low-priority answer', Category.LLM, Priority.LOW);
  queue.say('another queued one', Category.LLM, Priority.LOW);

  const preempted = queue.stopAndSay('urgent error', Category.ERROR, Priority.HIGH);
  truthy('a higher priority preempts', preempted !== null);
  eq('the interrupted utterance is cancelled', cancelled, ['a long low-priority answer']);
  eq('the queued one is reported as NOT announced', ended, [
    ['another queued one', false],
    ['a long low-priority answer', true],
  ]);
  eq('the preempting text is now speaking', spoken, ['a long low-priority answer', 'urgent error']);

  const refused = queue.stopAndSay('a low-priority interruption', Category.SYSTEM, Priority.LOW);
  eq('a lower priority cannot preempt', refused, null);
  eq('and nothing new is spoken', spoken.length, 2);

  const equal = queue.stopAndSay('an equally urgent one', Category.ERROR, Priority.HIGH);
  truthy('an EQUAL priority does preempt (the test is `<`)', equal !== null);
  eq('the newest equal-priority message wins', spoken[spoken.length - 1], 'an equally urgent one');
}

{
  const clock = fakeClock(1000);
  const { queue } = makeQueue(clock);

  eq('an untouched category has timestamp 0', queue.getTimestamp(Category.ERROR), 0);
  queue.say('wrong direction', Category.ERROR, Priority.MEDIUM);
  eq('the timestamp is stamped when it starts speaking', queue.getTimestamp(Category.ERROR), 1000);
  eq('secondsSince is 0 right after', queue.secondsSince(Category.ERROR), 0);

  clock.advance(2.0);
  eq('secondsSince tracks the clock', queue.secondsSince(Category.ERROR), 2.0);
  // This is the gate MapIOTTS.wrong_direction applies: ERROR_INTERVAL = 3.5s.
  truthy('inside ERROR_INTERVAL a caller would suppress the repeat', queue.secondsSince(Category.ERROR) < 3.5);
  clock.advance(2.0);
  truthy('past ERROR_INTERVAL a caller would let it through', queue.secondsSince(Category.ERROR) >= 3.5);

  // Other categories keep their own clock.
  eq('a different category is untouched', queue.getTimestamp(Category.GRAPH), 0);
}

{
  const clock = fakeClock(0);
  const { queue, spoken } = makeQueue(clock);

  queue.say('the first half and the second half', Category.LLM, Priority.MEDIUM);
  queue.setSpokenIndex(14); // spoken up to "the first half"
  queue.togglePause();
  eq('pausing stops the utterance', queue.isSpeaking(), false);
  truthy('the unspoken tail is stashed', queue.pausedAnnouncement !== null);
  eq('the tail is what was not said', queue.pausedAnnouncement.text, ' and the second half');
  eq('resumed announcements are HIGH priority', queue.pausedAnnouncement.priority, Priority.HIGH);

  queue.togglePause();
  eq('resuming speaks the tail', spoken[spoken.length - 1], 'and the second half');
  eq('and the stash is cleared', queue.pausedAnnouncement, null);
}

{
  const clock = fakeClock(0);
  const { queue } = makeQueue(clock);
  queue.say('an error readout', Category.ERROR, Priority.HIGH);
  queue.setSpokenIndex(3);
  queue.togglePause();
  eq('ERROR announcements are not stashed for resume', queue.pausedAnnouncement, null);

  queue.say('a graph readout', Category.GRAPH, Priority.LOW);
  queue.setSpokenIndex(3);
  queue.togglePause();
  eq('GRAPH announcements are not stashed either', queue.pausedAnnouncement, null);
}

{
  const clock = fakeClock(0);
  const { queue, spoken } = makeQueue(clock);
  queue.say('before', Category.SYSTEM);
  queue.addPause(0.5);
  queue.say('after', Category.SYSTEM);
  queue.finishCurrent();
  eq('a pause is queued in order', spoken, ['before', '<pause 0.5>']);
  queue.finishCurrent();
  eq('and the next announcement follows it', spoken, ['before', '<pause 0.5>', 'after']);
}

{
  const clock = fakeClock(0);
  const spoken = [];
  const queue = new AnnouncementQueue({ now: clock, speak: (a) => spoken.push(a.text) });
  queue.say('before start', Category.SYSTEM);
  eq('a stopped queue holds everything', spoken, []);
  queue.start();
  eq('start() drains what was waiting', spoken, ['before start']);
  queue.say('next', Category.SYSTEM);
  queue.stop();
  eq('stop() drops the rest', queue.queue.length, 0);
  eq('stop() ends the current utterance', queue.isSpeaking(), false);
}

// ---------------------------------------------------------------------------
head('14. Integration — the real new_york model, read-only');
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const modelDir = join(here, '..', '..', 'explore', 'simple_camio_llm', 'models');

{
  const modelPath = join(modelDir, 'new_york', 'new_york.json');

  if (!existsSync(modelPath)) {
    skip('new_york integration', `no model at ${modelPath}`);
  } else {
    const model = JSON.parse(readFileSync(modelPath, 'utf8'));
    const nyRoutes = [];
    const ny = new Graph(model.graph, {
      feetsPerInch: model.feets_per_inch,
      onRoute: (action, start, streetByStreet, waypoints) => nyRoutes.push({ action, waypoints }),
    });

    // PY — every expectation below came out of the Python on this same file.
    eq('counts', [ny.nodes.length, ny.edges.length, ny.streets.size, ny.pois.length], [69, 98, 31, 50]);
    closeArray('bounds', [ny.bounds[0].coords, ny.bounds[1].coords],
      [566.4320609948534, 675.5226801494177, 3507.682985123685, 3360.8302285694635]);

    const NY_NEAREST = [
      { point: [700, 3000], node: 'n3', nodeDistance: 51.042171223232224, short: '6th Avenue at West 28th Street', edge: 'n2 - n3', edgeDistance: 9.53238202883377, street: 'West 28th Street' },
      { point: [2332.11, 3231.99], node: 'n13', nodeDistance: 106.66523923780493, short: 'East 30th Street at Madison Avenue', edge: 'n12 - n13', edgeDistance: 67.66913300845748, street: 'East 30th Street' },
      { point: [1500, 1500], node: 'n35', nodeDistance: 131.37750908466927, short: '6th Avenue at West 34th Street', edge: 'n34 - n35', edgeDistance: 86.80264925230794, street: 'West 34th Street' },
      { point: [3400, 800], node: 'n67', nodeDistance: 145.5334284537718, short: 'East 40th Street, at the limit of the map', edge: 'n66 - n67', edgeDistance: 33.64374042621948, street: 'East 40th Street' },
    ];
    for (const c of NY_NEAREST) {
      const p = new Coords(c.point[0], c.point[1]);
      const [node, dn] = ny.getNearestNode(p);
      const [edge, de] = ny.getNearestEdge(p);
      eq(`ny nearest at (${c.point.join(', ')})`, [node.id, node.getShortDescription(), edge.id, edge.street],
        [c.node, c.short, c.edge, c.street]);
      close(`ny nearest node distance at (${c.point.join(', ')})`, dn, c.nodeDistance);
      close(`ny nearest edge distance at (${c.point.join(', ')})`, de, c.edgeDistance);
    }

    close('ny distance matrix n0->n1', ny.distances.n0.n1, 210.29254463717697);
    close('ny distance matrix n0->n30', ny.distances.n0.n30, 3149.3204513763203);
    close('ny distance matrix n5->n60', ny.distances.n5.n60, 3784.6948441514755);
    close('ny distance matrix n12->n12', ny.distances.n12.n12, 0);

    close('ny getDistance A', ny.getDistance(new Coords(700, 3000), new Coords(2332.11, 3231.99)), 2150);
    close('ny getDistance B', ny.getDistance(new Coords(1500, 1500), new Coords(3400, 800)), 3030);

    ny.enablePois(ny.pois.map((_, i) => i));
    eq('ny getNearbyPois', ny.getNearbyPois(new Coords(700, 3000), 700.0),
      ['Cafe China', 'Joomak Banjum', 'Mulberry & Vine', 'Szechuan Gourmet']);
    close('ny getDistanceToPoi', ny.getDistanceToPoi(new Coords(700, 3000), 0), 2315.056462112568);
    eq('ny POI description', ny.pois[0].getCompleteDescription(),
      'American Academy of Dramatic Arts on Madison Avenue');
    eq('ny POI str_dict rendering', ny.pois[0].toString(),
      'index: 0\nname: American Academy of Dramatic Arts\ncoords: (2332.110376280122, 3231.9959522136196)\n' +
      'edge: n13 - n18\nstreet: Madison Avenue\ncategories: [ education.college ]\nname other: \n    short name: AADA\n');

    // The end-to-end case: a real route on a real map, merged, with crossings
    // counted and a mid-block finish.
    nyRoutes.length = 0;
    ny.guideToPoi(new Coords(700, 3000), 9, true);
    eq('ny route actions', nyRoutes.map((r) => r.action), [RouteAction.CALCULATING_ROUTE, RouteAction.ON_ROUTE]);
    const wps = nyRoutes[1].waypoints;
    eq('ny route instructions', wps.map((w) => w.instructions), [
      'Head north-east for 3 intersections until 6th Avenue at West 31st Street',
      'Head north-west for half a block',
    ]);
    eq('ny route directions', wps.map((w) => w.direction), ['north-east', 'north-west']);
    eq('ny route names', wps.map((w) => w.name), ['6th Avenue at West 31st Street', null]);
    closeArray('ny route coords', wps.map((w) => w.coords.coords),
      [1137.059915, 2332.860933, 882.140723, 2192.084662], 1e-5);

    // Same map through the whole stack: handler -> controller -> navigator.
    const clock = fakeClock(0);
    const handler = new PositionHandler(ny, {
      feetsPerInch: model.feets_per_inch,
      feetsPerPixel: model.feets_per_pixel,
      now: clock,
    });
    const actions = [];
    const controller = new NavigationController(ny, (action) => actions.push(action), {
      feetsPerInch: model.feets_per_inch,
      now: clock,
    });
    controller.navigateStreetByStreet(wps);
    // A pixel sample that lands on the route start once scaled to feet.
    handler.processPosition(new Coords(700 / model.feets_per_pixel, 3000 / model.feets_per_pixel));
    controller.update(handler.getPositionInfo(), false);
    eq('ny end-to-end: the first leg is announced', actions, [NavigationAction.ANNOUNCE_DIRECTION]);
  }
}

// ---------------------------------------------------------------------------
head('15. Integration — the detroit_conant model (a second real map)');
// ---------------------------------------------------------------------------

{
  const modelPath = join(modelDir, 'detroit_conant', 'detroit_conant.json');

  if (!existsSync(modelPath)) {
    skip('detroit_conant integration', `no model at ${modelPath}`);
  } else {
    const model = JSON.parse(readFileSync(modelPath, 'utf8'));
    const dcRoutes = [];
    const dc = new Graph(model.graph, {
      feetsPerInch: model.feets_per_inch,
      onRoute: (action, start, streetByStreet, waypoints) => dcRoutes.push({ action, waypoints }),
    });

    // PY — this is the map the COLLINEAR_COS comment was measured on.
    eq('dc counts', [dc.nodes.length, dc.edges.length, dc.streets.size, dc.pois.length], [87, 121, 22, 51]);
    eq('dc nearest', [dc.getNearestNode(new Coords(1200, 900))[0].id, dc.getNearestEdge(new Coords(1200, 900))[0].id],
      ['n66', 'n10 - n11']);
    close('dc getDistance', dc.getDistance(new Coords(1200, 900), new Coords(2000, 1800)), 1810);

    dc.enablePois(dc.pois.map((_, i) => i));
    eq('dc getNearbyPois', dc.getNearbyPois(new Coords(1200, 900), 700.0),
      ['New Merchant Food Center', 'The Plaza Cinema', 'Valley Bank']);

    dc.guideToPoi(new Coords(1200, 900), 3, true);
    eq('dc route instructions', dcRoutes[1].waypoints.map((w) => w.instructions), [
      'Head north until Brinker Avenue at East Seven Mile Road',
      'Head east until Conant Street at East Seven Mile Road',
      'Head south-east until Conant Street at East Brentwood Street and Joseph Campau Avenue',
      'Head south for 2 intersections until East Hildale Street at Joseph Campau Avenue',
    ]);
    eq('dc route directions', dcRoutes[1].waypoints.map((w) => w.direction),
      ['north', 'east', 'south-east', 'south']);
  }
}

// ---------------------------------------------------------------------------

console.log(
  `\n${passed} passed, ${failed} failed` + (skipped ? `, ${skipped} skipped` : '') + '\n',
);
process.exit(failed === 0 ? 0 : 1);
