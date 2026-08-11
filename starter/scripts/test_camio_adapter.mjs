#!/usr/bin/env node
/**
 * Milestone 6 check: `CamioWorldAdapter` over a synthetic colour map.
 *
 *   node starter/scripts/test_camio_adapter.mjs
 *
 * No network, no browser, no image decoder. The colour map is built in code as a
 * plain array behind the same `{ width, height, getPixel }` accessor a canvas
 * caller will supply, which is exactly the point of the adapter's platform-free
 * contract.
 *
 * The fixture — 60 × 40 pixels on a 120 × 80 mm sheet, so **2 mm per pixel on both
 * axes** and every expected distance below is hand-computable:
 *
 *      x  0    5   10   15   20   25   30   35   40   45   50   55
 *   y  5      ┌─────────┬─────────┐         ┌───┐
 *             │    A    │    B    │         │   │            A "North Gallery"  #ff0000
 *  14      └─────────┴─────────┘         │ C │            B "North Garden"   #00ff00
 *  20                                    │   ├───────┬─────┐  C "Storage Room"   #0000ff
 *  24                                    └───┴───────┴─────┘  E "Loading Dock"   #ff00ff
 *  30                    ┌─────┐
 *  34                    │  F  │                             F "Kiosk Annex"    #00ffff
 *  35       ┌─────┐      └─────┘
 *  39       │  D  │                                          D "Kiosk"          #ffff00
 *
 *   A|B share a vertical border (x = 14 | 15)          -> adjacent
 *   C is L-shaped: its bounding box covers (45, 10),   -> a bbox-only lookup would
 *     which is background                                 answer C there and be wrong
 *   C|E share a vertical border (x = 49 | 50)          -> adjacent
 *   D touches F only at a corner ((14,35) / (15,34))   -> NOT adjacent (4-neighbourhood)
 *   D borders nothing at all                           -> the isolated case
 *
 * A POI is bound to E by its pixel `coords`, in the `new_york.json` /
 * `placeIndex.js#fromCamioPoi` shape, so the region-to-place upgrade is exercised
 * on the record shape this repo actually carries.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  CamioWorldAdapter,
  DEFAULT_NEARBY_RADIUS_MM,
  colorKey,
  keyToHex,
} from '../src/lib/adapters/camioWorldAdapter.js';
import { filterTools } from '../src/lib/toolFilter.js';
import { isAmbiguous, isUnsupported } from '../src/lib/worldAdapter.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(HERE, '../docs/llm-tools.schema.json');

let failures = 0;
function check(ok, label, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures += 1;
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const json = (v) => JSON.stringify(v);

/* ------------------------------------------------------------- the fixture -- */

const W = 60;
const H = 40;
const WIDTH_MM = 120;
const HEIGHT_MM = 80;
const MM_PER_PX = WIDTH_MM / W; // 2 mm, on both axes

const BACKGROUND = 0xffffff;

const HOTSPOTS = [
  { color: '#ff0000', title: 'North Gallery', description: 'Paintings and the information desk.' },
  { color: '#00ff00', title: 'North Garden', description: 'Open courtyard with benches.' },
  { color: '#0000ff', title: 'Storage Room', description: 'Staff only.', sound: 'storage.mp3' },
  { color: '#ffff00', title: 'Kiosk', description: 'Tickets and maps.' },
  { color: '#ff00ff', title: 'Loading Dock', description: 'Deliveries at the rear.' },
  { color: '#00ffff', title: 'Kiosk Annex', description: 'Overflow seating by the kiosk.' },
];

const POIS = [
  {
    name: 'Dock Café',
    categories: ['catering.cafe'],
    location_description: 'at the rear of the building, beside the loading dock',
    name_other: { short_name: 'DC' },
    coords: [52, 22],
  },
];

/** Row-major packed-RGB grid. */
function buildGrid() {
  const px = new Int32Array(W * H).fill(BACKGROUND);
  const fill = (x0, y0, x1, y1, key) => {
    for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) px[y * W + x] = key;
  };
  fill(5, 5, 14, 14, colorKey('#ff0000')); // A
  fill(15, 5, 24, 14, colorKey('#00ff00')); // B
  fill(35, 5, 39, 24, colorKey('#0000ff')); // C, vertical bar
  fill(40, 20, 49, 24, colorKey('#0000ff')); // C, foot -> L
  fill(50, 20, 54, 24, colorKey('#ff00ff')); // E, against C's foot
  fill(10, 35, 14, 39, colorKey('#ffff00')); // D, isolated
  fill(15, 30, 19, 34, colorKey('#00ffff')); // F, corner-touching D only
  return px;
}

const GRID = buildGrid();

/** The platform boundary, as a plain array. `reads` proves nothing rescans. */
function makeAccessor({ packed = true } = {}) {
  const accessor = {
    width: W,
    height: H,
    reads: 0,
    getPixel(x, y) {
      accessor.reads += 1;
      const key = GRID[y * W + x];
      return packed ? key : [(key >> 16) & 0xff, (key >> 8) & 0xff, key & 0xff];
    },
  };
  return accessor;
}

/** Pixel centre -> (u, v), so every probe below names a pixel, not a fraction. */
const uvOf = (x, y) => ({ u: (x + 0.5) / W, v: (y + 0.5) / H });
const at = (adapter, x, y) => {
  const { u, v } = uvOf(x, y);
  return adapter.at(u, v);
};

const accessor = makeAccessor();
const adapter = new CamioWorldAdapter({
  colorMap: accessor,
  projectData: { name: 'Test Sheet', hotspots: HOTSPOTS, points_of_interest: POIS },
  widthMm: WIDTH_MM,
  heightMm: HEIGHT_MM,
});

console.log(`fixture: ${W}×${H} px on ${WIDTH_MM}×${HEIGHT_MM} mm (${MM_PER_PX} mm/px), ` +
  `${HOTSPOTS.length} hotspots\n`);

/* -- construction cost ------------------------------------------------------- */

check(
  accessor.reads === W * H + POIS.length,
  'construction is one full-grid pass, O(W·H), plus one lookup per POI coords',
  `${accessor.reads} reads for ${W * H} pixels and ${POIS.length} POI`,
);
check(adapter.frame === 'image', 'frame is image', adapter.frame);
check(
  json([...adapter.capabilities].sort()) === json(['places', 'regions']),
  'capabilities are exactly {places, regions}',
  json([...adapter.capabilities]),
);
check(adapter.worldId === 'camio:Test Sheet', 'worldId derives from the project', adapter.worldId);

/* -- at(u, v): one pixel read, no scanning ---------------------------------- */

const before = accessor.reads;
const inGallery = at(adapter, 9, 9);
check(accessor.reads - before === 1, 'at() is a single pixel read', `${accessor.reads - before}`);
check(inGallery.region?.name === 'North Gallery', 'at() inside A', inGallery.region?.name);
check(inGallery.place?.name === 'North Gallery', 'at() also yields the region place', inGallery.place?.name);

check(at(adapter, 19, 9).region?.name === 'North Garden', 'at() inside B');
check(at(adapter, 37, 10).region?.name === 'Storage Room', "at() inside C's vertical bar");
check(at(adapter, 45, 22).region?.name === 'Storage Room', "at() inside C's foot");

/* -- the L: bbox is not the region ------------------------------------------ */

const storage = adapter.regions().find((r) => r.name === 'Storage Room');
check(
  json(storage.bbox) === json({ minX: 35, minY: 5, maxX: 49, maxY: 24 }),
  "C's bbox spans the whole L",
  json(storage.bbox),
);
const concavity = at(adapter, 45, 10);
check(
  concavity.region === undefined && concavity.place === undefined,
  "the L's concavity (45,10) is background even though it is inside C's bbox",
  json(concavity),
);
check(
  near(storage.centroid.x, 40) && near(storage.centroid.y, 17.5),
  "C's centroid is (40, 17.5)",
  json(storage.centroid),
);
check(
  at(adapter, 40, 17).region === undefined,
  "C's own centroid pixel is outside C — why distances are measured to the boundary",
);

/* -- background -------------------------------------------------------------- */

for (const [x, y] of [[30, 30], [0, 0], [59, 39], [45, 10]]) {
  const hit = at(adapter, x, y);
  check(json(hit) === '{}', `background at (${x},${y}) yields nothing`, json(hit));
}

/* -- POI binding by pixel coords -------------------------------------------- */

const dock = at(adapter, 52, 22);
check(dock.region?.name === 'Loading Dock', 'at() inside E gives the region', dock.region?.name);
check(dock.place?.name === 'Dock Café', 'the bound POI upgrades the place name', dock.place?.name);
check(
  json(dock.place?.aliases) === json(['Loading Dock', 'DC']),
  'the hotspot title survives as an alias, with the POI short name',
  json(dock.place?.aliases),
);
check(dock.place?.category === 'catering.cafe', 'POI categories reach the place', dock.place?.category);
check(
  dock.region?.provenance?.source === 'camio:colormap' && dock.region?.provenance?.id === '#ff00ff',
  'provenance carries the colour key',
  json(dock.region?.provenance),
);
check(
  adapter.regions().find((r) => r.name === 'Storage Room').sound === 'storage.mp3',
  'hotspot sound is carried on the region',
);

/* -- adjacency: exactly the constructed shared borders ----------------------- */

const adjacency = adapter.regionAdjacency();
const byName = new Map(adapter.regions().map((r) => [r.id, r.name]));
/** Sorted by name, so the assertion does not depend on hotspot declaration order. */
const canonical = (pairs) =>
  json([...pairs].map(([name, ids]) => [name, [...ids].sort()]).sort((a, b) => a[0].localeCompare(b[0])));
const asNames = Object.fromEntries(
  [...adjacency].map(([id, ids]) => [byName.get(id), ids.map((n) => byName.get(n)).sort()]),
);
const EXPECTED_ADJACENCY = [
  ['North Gallery', ['North Garden']],
  ['North Garden', ['North Gallery']],
  ['Storage Room', ['Loading Dock']],
  ['Loading Dock', ['Storage Room']],
  ['Kiosk', []],
  ['Kiosk Annex', []],
];
check(
  canonical(Object.entries(asNames)) === canonical(EXPECTED_ADJACENCY),
  'adjacency is exactly the shared-border pairs',
  json(asNames),
);
check(asNames.Kiosk.length === 0, 'the isolated region borders nothing');
check(
  !asNames.Kiosk.includes('Kiosk Annex') && !asNames['Kiosk Annex'].includes('Kiosk'),
  'corner-touching regions are not adjacent (4-neighbourhood)',
);
check(
  json(adapter.regionNeighbours(storage.id).map((r) => r.name)) === json(['Loading Dock']),
  'regionNeighbours() returns Regions',
);
adjacency.get(storage.id).push('tampered');
const afterTamper = adapter.regionAdjacency().get(storage.id);
check(
  afterTamper.length === 1 && !afterTamper.includes('tampered'),
  'regionAdjacency() hands out copies — mutating the result does not corrupt the cache',
  json(afterTamper),
);

/* -- distance: material_mm, hand-computed ----------------------------------- */
//
// Probe P = pixel (19, 20), centre at (39, 41) mm.
//   -> B's nearest boundary pixel is (19, 14), centre (39, 29) mm  =>  12 mm exactly
//   -> A's nearest boundary pixel is (14, 14), centre (29, 29) mm  =>  hypot(10, 12)
//
const P = uvOf(19, 20);
const readsBeforeDistance = accessor.reads;
const dGarden = adapter.distanceTo(P.u, P.v, 'North Garden');
check(dGarden.units === 'material_mm', "distance carries units 'material_mm' (§5.4)", dGarden.units);
check(dGarden.frame === 'image', 'distance carries the frame', dGarden.frame);
check(dGarden.method === 'nearest_boundary', 'distance convention is nearest boundary', dGarden.method);
check(near(dGarden.value, 12), 'distance to B is 12 mm (6 px × 2 mm/px)', `${dGarden.value}`);
check(dGarden.place.name === 'North Garden', 'distance echoes the resolved place');
check(
  accessor.reads - readsBeforeDistance <= 2,
  'distance does not rescan the grid',
  `${accessor.reads - readsBeforeDistance} reads`,
);

const dGallery = adapter.distanceTo(P.u, P.v, 'North Gallery');
check(near(dGallery.value, Math.hypot(10, 12)), 'distance to A is hypot(10, 12) mm', `${dGallery.value}`);

const inC = uvOf(37, 10);
const inside = adapter.distanceTo(inC.u, inC.v, 'Storage Room');
check(near(inside.value, 0), 'distance from inside a region is 0', `${inside.value}`);

// From the L's concavity: the nearest C pixel is on the vertical bar's right edge
// (39, 10) at (79, 21) mm, 12 mm away — not the foot's top edge, 20 mm away, and
// not the centroid at (40, 17.5) px which is not even inside C.
const cav = uvOf(45, 10);
const dConcavity = adapter.distanceTo(cav.u, cav.v, 'Storage Room');
check(near(dConcavity.value, 12), "distance from the L's concavity is 12 mm, not via the centroid",
  `${dConcavity.value}`);

check(adapter.distanceTo(P.u, P.v, 'helipad') === null, 'distance to an unknown name is null');
check(isAmbiguous(adapter.distanceTo(P.u, P.v, 'north')), 'an ambiguous target passes Ambiguous through');
check(
  near(adapter.distanceTo(P.u, P.v, { id: storage.id }).value,
    adapter.distanceTo(P.u, P.v, 'Storage Room').value),
  'distanceTo() also accepts a Region/Place object',
);

/* -- nearby: radius is millimetres on the material -------------------------- */

const names = (places) => places.map((p) => p.name);

check(
  json(names(adapter.nearby(P.u, P.v, 13))) === json(['North Garden']),
  'radius 13 mm reaches B (12 mm) but not A (15.6 mm)',
  json(names(adapter.nearby(P.u, P.v, 13))),
);
check(
  json(names(adapter.nearby(P.u, P.v, 16))) === json(['North Garden', 'North Gallery']),
  'radius 16 mm reaches both, nearest first',
  json(names(adapter.nearby(P.u, P.v, 16))),
);
check(
  json(names(adapter.nearby(P.u, P.v, 11))) === json([]),
  'radius 11 mm reaches nothing',
  json(names(adapter.nearby(P.u, P.v, 11))),
);
const nearbyDist = adapter.nearby(P.u, P.v, 16)[0].distance;
check(
  nearbyDist.units === 'material_mm' && near(nearbyDist.value, 12),
  'nearby results carry { value, units }',
  json(nearbyDist),
);
const insideNearby = adapter.nearby(inC.u, inC.v, 5);
check(
  insideNearby[0]?.name === 'Storage Room' && near(insideNearby[0].distance.value, 0),
  'the region under the finger comes first, at 0 mm',
  json(names(insideNearby)),
);
const readsBeforeNearby = accessor.reads;
adapter.nearby(P.u, P.v, DEFAULT_NEARBY_RADIUS_MM);
check(
  accessor.reads - readsBeforeNearby <= 2,
  'nearby does not rescan the grid either',
  `${accessor.reads - readsBeforeNearby} reads for the default ${DEFAULT_NEARBY_RADIUS_MM} mm radius`,
);

// Same pixels, twice the sheet: mm answers must double. This is the check that
// the radius is material millimetres and not pixels wearing a mm label.
const bigger = new CamioWorldAdapter({
  colorMap: makeAccessor(),
  hotspots: HOTSPOTS,
  widthMm: WIDTH_MM * 2,
  heightMm: HEIGHT_MM * 2,
});
check(
  near(bigger.distanceTo(P.u, P.v, 'North Garden').value, 24),
  'on a 240×160 mm sheet the same pixels are 24 mm apart',
  `${bigger.distanceTo(P.u, P.v, 'North Garden').value}`,
);
check(
  json(names(bigger.nearby(P.u, P.v, 13))) === json([]),
  'and radius 13 mm now reaches nothing',
  json(names(bigger.nearby(P.u, P.v, 13))),
);

/* -- resolvePlace ------------------------------------------------------------ */

check(adapter.resolvePlace('North Gallery')?.name === 'North Gallery', 'exact match');
check(adapter.resolvePlace('  north gallery ')?.name === 'North Gallery', 'exact match is case/space insensitive');
check(adapter.resolvePlace('storage')?.name === 'Storage Room', 'unique substring match');
check(adapter.resolvePlace('Loading Dock')?.name === 'Dock Café', 'alias resolves to the POI-upgraded place');

const amb = adapter.resolvePlace('north');
check(isAmbiguous(amb), 'a substring matching two places is Ambiguous', amb?.constructor?.name);
check(
  json(names(amb.candidates).sort()) === json(['North Gallery', 'North Garden']),
  'both candidates come back for the dispatcher to ask about',
  json(names(amb.candidates)),
);
check(amb.query === 'north', 'Ambiguous carries the query');

const kiosk = adapter.resolvePlace('kiosk');
check(
  kiosk?.name === 'Kiosk',
  'exact beats substring: "kiosk" is Kiosk, not ambiguous with Kiosk Annex',
  isAmbiguous(kiosk) ? json(names(kiosk.candidates)) : kiosk?.name,
);
check(adapter.resolvePlace('kiosk annex')?.name === 'Kiosk Annex', 'the longer name still resolves');
check(adapter.resolvePlace('helipad') === null, 'a miss is null, not a throw');
check(adapter.resolvePlace('') === null, 'empty query is a miss');

/* -- what this world cannot do ---------------------------------------------- */

const route = adapter.route({ u: 0.1, v: 0.1 }, adapter.resolvePlace('Kiosk'));
check(isUnsupported(route), 'route() is Unsupported — fly_me_there is the dispatcher\'s job', json(route));
check(route.capability === 'routing', 'the Unsupported names the missing capability', route.capability);
const attrs = adapter.attributes({ id: 'whatever' });
check(isUnsupported(attrs), 'attributes() is Unsupported (inherited: no accessibilityAttrs)', json(attrs));
check(attrs.capability === 'accessibilityAttrs', 'and names accessibilityAttrs', attrs.capability);

/* -- toolFilter integration: the capability set is the tool set -------------- */

const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
const tools = filterTools(schema, adapter.session());
const toolNames = tools.map((t) => t.function.name);
const EXPECTED_SEVEN = [
  'whats_here', 'describe_surroundings', 'get_place_details', 'am_i_at',
  'get_distance_to', 'get_direction_to', 'route_to',
];
check(tools.length === 7, 'adapter.session() -> 7 tools (plan §3)', `${tools.length}: ${toolNames.join(', ')}`);
check(
  json([...toolNames].sort()) === json([...EXPECTED_SEVEN].sort()),
  'and they are the right 7',
  toolNames.join(', '),
);
const modeEnum = tools.find((t) => t.function.name === 'route_to').function.parameters.properties.mode.enum;
check(json(modeEnum) === json(['fly_me_there']), 'route_to mode narrowed to [fly_me_there]', json(modeEnum));
const unitsEnum = tools.find((t) => t.function.name === 'get_distance_to')
  .function.parameters.properties.units.enum;
check(json(unitsEnum) === json(['material_mm']), 'get_distance_to units narrowed to [material_mm]', json(unitsEnum));
check(
  unitsEnum[0] === dGarden.units,
  'the unit the schema offers is the unit the adapter returns',
  `${unitsEnum[0]} / ${dGarden.units}`,
);

/* -- accessor shapes and colour keys ---------------------------------------- */

const rgbAdapter = new CamioWorldAdapter({
  colorMap: makeAccessor({ packed: false }),
  hotspots: HOTSPOTS,
  widthMm: WIDTH_MM,
  heightMm: HEIGHT_MM,
});
check(
  at(rgbAdapter, 9, 9).region?.name === 'North Gallery',
  'an [r,g,b] accessor reads the same as a packed-int one',
);
check(keyToHex(colorKey({ r: 255, g: 0, b: 255 })) === '#ff00ff', 'colorKey accepts {r,g,b} (the Color shape)');
check(colorKey([0, 255, 0]) === colorKey('#00ff00'), 'colorKey accepts arrays and hex alike');
check(colorKey('0,255,0') === colorKey('#00ff00'), 'and the "r,g,b" string form');

/* -- construction guards ----------------------------------------------------- */

const throws = (fn, label, needle) => {
  try {
    fn();
    check(false, label, 'did not throw');
  } catch (err) {
    check(String(err.message).includes(needle), label, err.message.slice(0, 90));
  }
};

throws(
  () => new CamioWorldAdapter({ colorMap: makeAccessor(), hotspots: HOTSPOTS }),
  'a missing material size throws rather than guessing a sheet',
  'material size in mm is required',
);
throws(
  () => new CamioWorldAdapter({ hotspots: HOTSPOTS, widthMm: WIDTH_MM, heightMm: HEIGHT_MM }),
  'a missing colour map throws',
  'colorMap must be',
);
throws(
  () => new CamioWorldAdapter({
    colorMap: makeAccessor(),
    hotspots: [...HOTSPOTS, { color: '#ff0000', title: 'Impostor' }],
    widthMm: WIDTH_MM,
    heightMm: HEIGHT_MM,
  }),
  'two hotspots claiming one colour throws — the colour is the identifier',
  'is claimed by two hotspots',
);

// Project data wins over the constructor argument: the printed sheet is the authority.
const fromData = new CamioWorldAdapter({
  colorMap: makeAccessor(),
  projectData: { hotspots: HOTSPOTS, material: { widthMm: WIDTH_MM * 2, heightMm: HEIGHT_MM * 2 } },
  widthMm: WIDTH_MM,
  heightMm: HEIGHT_MM,
});
check(fromData.widthMm === WIDTH_MM * 2, 'a size on the project data wins over the constructor argument',
  `${fromData.widthMm} mm`);

/* -- real project data ------------------------------------------------------- */
//
// `explore/simple_camio_llm/models/new_york/` ships a model JSON and a template
// PNG but NO colour map, and the JSON is MapIO-shaped (graph + POIs), not
// hotspot-shaped. Decoding the PNG would need a dependency this test refuses to
// add, so the integration case that is actually available is the POI record
// shape: the same fields `placeIndex.js#fromCamioPoi` consumes are bound above
// through `points_of_interest`, with `coords` in colour-map pixels.
const NY = join(HERE, '../../explore/simple_camio_llm/models/new_york/new_york.json');
let nyPois = [];
try {
  nyPois = JSON.parse(readFileSync(NY, 'utf8')).graph?.points_of_interest || [];
} catch {
  /* optional fixture */
}
if (nyPois.length > 0) {
  const sample = nyPois[0];
  const shaped = ['name', 'categories', 'location_description', 'coords'].every((k) => k in sample);
  check(shaped, 'the bound POI shape matches new_york.json records', Object.keys(sample).join(', '));
  const real = new CamioWorldAdapter({
    colorMap: makeAccessor(),
    hotspots: [HOTSPOTS[0]],
    // Placed by hand onto region A, since the real sheet's colour map is not in the repo.
    pois: [{ ...sample, coords: [9, 9] }],
    widthMm: WIDTH_MM,
    heightMm: HEIGHT_MM,
  });
  check(
    at(real, 9, 9).place?.name === sample.name,
    'a real new_york.json POI record binds to a hotspot and names its place',
    at(real, 9, 9).place?.name,
  );
} else {
  console.log('note  new_york.json not readable; skipped the real-POI case');
}

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
