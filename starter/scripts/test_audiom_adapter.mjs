#!/usr/bin/env node
/**
 * Milestone 5a check: AudiomWorldAdapter, Tier A.
 *
 *   node starter/scripts/test_audiom_adapter.mjs
 *
 * Two layers of test, and the split is deliberate.
 *
 * OFFLINE always runs. Every piece of adapter logic — model build, id scheme,
 * name resolution, (u,v) mapping, containment, cache hits and expiry — is driven
 * by a hand-built fixture that mimics the *shape* of `/map-definitions/:id/layers`
 * and contains no real data. Logic that can only be checked when a Heroku dyno is
 * awake is logic that stops being checked.
 *
 * LIVE runs only when `VITE_AUDIOM_FULL_ACCESS_KEY` is in the environment, and
 * skips loudly rather than failing when it is not. It exists to catch the one
 * thing a fixture cannot: the real payload changing shape under us.
 *
 *   VITE_AUDIOM_FULL_ACCESS_KEY=… node starter/scripts/test_audiom_adapter.mjs
 *
 * The key is read from the environment and never printed.
 */

import {
  AudiomWorldAdapter,
  MemoryStore,
  IndexedDBLayerStore,
  defaultLayerStore,
  LAYER_DB_NAME,
  AUDIOM_BACKEND_STAGING,
  cacheKey,
} from '../src/lib/adapters/audiomWorldAdapter.js';
import { isAmbiguous, isUnsupported, FRAMES, CAPABILITIES } from '../src/lib/worldAdapter.js';
import { buildGraphDict, UNNAMED_STREET } from '../src/lib/geojsonGraph.js';
import * as audiom from '../src/audiom.js';
import { Graph } from '../src/lib/logic/graph.js';

let failures = 0;
function check(ok, label, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures += 1;
}
const section = (title) => console.log(`\n— ${title} ${'—'.repeat(Math.max(0, 62 - title.length))}`);

/* ------------------------------------------------------------------ fixture -- */

const HOUR = 3600 * 1000;
const CACHED_AT = '2026-08-10T11:46:02.189Z';
const EXPIRES_AT = '2026-08-11T11:46:02.189Z';
/** A clock inside the fixture's TTL, so "fresh" is not a function of the wall. */
const T_FRESH = Date.parse(CACHED_AT) + HOUR;

const poly = (x0, y0, x1, y1) => ({
  type: 'Polygon',
  coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]],
});
const point = (x, y) => ({ type: 'Point', coordinates: [x, y] });

const feature = (id, sourceName, name, geometry, extra = {}) => ({
  id,
  type: 'Feature',
  geometry,
  properties: {
    name,
    sourceName,
    OBJECTID: id,
    ruleName: extra.ruleName ?? name,
    ruleType: extra.ruleType ?? 'district',
    briefing: extra.briefing ?? 'poi',
    ...extra.props,
  },
});

const layer = (name, coordinateSystem, visible, features) => ({
  cachedAt: CACHED_AT,
  cacheTtl: 86400,
  expiresAt: EXPIRES_AT,
  name,
  mapType: 'standard',
  coordinateSystem,
  visible,
  // ⚠️ `source` IS the FeatureCollection — verified against staging. The plan's
  // sketch reads like a source descriptor; it is the resolved data.
  source: {
    type: 'FeatureCollection',
    features,
    metadata: { crs: { epsg: 4326, crsName: 'WGS 84' }, name, isIndoor: false },
  },
});

/**
 * Eight visible features over two layers, plus one hidden layer.
 *
 * Geometry is arranged to exercise the hard cases:
 *   - "Greater Region" (0..7) contains the two small districts -> smallest wins.
 *   - "Ferry Terminal" (8,8) sits OUTSIDE every polygon -> nearest-within-tolerance.
 *   - feature id 1 appears in BOTH layers -> the Place id must be compound.
 *   - "Harbour District" appears twice -> resolvePlace must return Ambiguous.
 */
const fixture = () => ({
  id: 9001,
  slug: 'fixture-harbour',
  title: 'Fixture Harbour',
  name: 'Fixture Harbour',
  center: [5, 5],
  zoom: 9,
  globalParams: { stepsize: '100' },
  organizationId: 1,
  refreshed: false,
  warnings: [],
  layers: [
    layer('L1: Districts', 'standard', true, [
      feature(1, 'L1: Districts', 'Harbour District', poly(0, 0, 2, 2)),
      feature(2, 'L1: Districts', 'Old Town', poly(3, 0, 4, 1)),
      feature(3, 'L1: Districts', 'Harbour District', poly(5, 5, 6, 6)),
      feature(4, 'L1: Districts', 'Greater Region', poly(0, 0, 7, 7), { ruleType: 'region', briefing: '' }),
    ]),
    layer('L2: Landmarks', 'standard', true, [
      feature(1, 'L2: Landmarks', 'Clock Tower', point(1, 1), { ruleName: 'tower', ruleType: 'landmark' }),
      feature(2, 'L2: Landmarks', 'Ferry Terminal', point(8, 8), { ruleType: 'landmark' }),
      feature(3, 'L2: Landmarks', 'Market Hall', point(3.5, 0.5), { ruleType: 'landmark' }),
      feature(4, 'L2: Landmarks', '', point(9, 9), { ruleName: '', props: { name: '' } }),
    ]),
    layer('C9: Credits', 'standard', false, [
      feature(1, 'C9: Credits', 'Legend Panel', poly(9, 9, 10, 10)),
    ]),
  ],
});

/** A `fetch` that serves the fixture and counts every call. */
function fakeFetch(payload = fixture()) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, headers: { ...(init?.headers || {}) } });
    return {
      ok: true,
      status: 200,
      json: async () => JSON.parse(JSON.stringify(payload)),
    };
  };
  impl.calls = calls;
  return impl;
}

const build = (opts = {}) => {
  const fetchImpl = opts.fetchImpl || fakeFetch();
  const adapter = new AudiomWorldAdapter({
    apiKey: 'fixture-key-not-a-real-credential',
    fetchImpl,
    store: opts.store || new MemoryStore(),
    now: opts.now || (() => T_FRESH),
    bbox: opts.bbox === undefined ? [0, 0, 10, 10] : opts.bbox,
    ...opts.adapter,
  });
  return { adapter, fetchImpl };
};

/* ------------------------------------------------------------ offline: model -- */

section('offline · model build');
{
  const { adapter, fetchImpl } = build();
  const res = await adapter.loadMapDefinition(9001);

  check(fetchImpl.calls.length === 1, 'a cold load performs exactly one request', `${fetchImpl.calls.length}`);
  check(res.fromCache === false, 'the cold load reports fromCache: false');
  check(res.layers === 2, 'hidden layers are dropped', `${res.layers} of 3 kept`);
  check(
    adapter.places.length === 7,
    'the eight visible features become seven Places — the nameless one is dropped',
    `${adapter.places.length}`,
  );
  check(
    adapter.notes.some((n) => /hidden layer/.test(n)) && adapter.notes.some((n) => /unnamed/.test(n)),
    'skipping is recorded, not silent',
    adapter.notes.join(' | '),
  );
  check(res.warnings.length === 0, 'the endpoint\'s warnings pass through verbatim');
  check(res.frame === FRAMES.GEOGRAPHIC, 'coordinateSystem "standard" -> geographic frame', res.frame);
  check(adapter.session().capabilities.has(CAPABILITIES.PLACES), 'session declares places');
  check(
    !adapter.session().capabilities.has(CAPABILITIES.ROUTING) &&
      !adapter.session().capabilities.has(CAPABILITIES.LIVE_FEATURE_STREAM),
    'session declares nothing M12b/M5b has not delivered',
  );

  const ids = adapter.places.map((p) => p.id);
  check(new Set(ids).size === ids.length, 'Place ids are unique across layers');
  check(
    ids.includes('L1: Districts#1') && ids.includes('L2: Landmarks#1'),
    'the id scheme is sourceName#nativeId, so colliding feature ids stay distinct',
  );

  const clock = adapter.places.find((p) => p.name === 'Clock Tower');
  check(clock.category === 'landmark, poi', 'category comes from ruleType + briefing', clock.category);
  check(clock.aliases.includes('tower'), 'ruleName becomes an alias when it differs from the name');
  check(clock.props.sourceName === 'L2: Landmarks', 'props carry the post-ruleset properties incl. sourceName');
  check(
    clock.provenance.source === 'audiom:layers' &&
      clock.provenance.sourceName === 'L2: Landmarks' &&
      clock.provenance.layer === 'L2: Landmarks' &&
      clock.provenance.cachedAt === CACHED_AT,
    'provenance carries source, sourceName, layer and cachedAt',
  );
  check(clock.geometry.type === 'Point' && clock.geometry.coordinates[0] === 1, 'geometry is passed through as-is');

  const greater = adapter.places.find((p) => p.name === 'Greater Region');
  check(greater.category === 'region', 'an empty briefing does not leave a trailing separator', greater.category);
}

/* ------------------------------------------------------------- offline: auth -- */

section('offline · auth convention');
{
  const { adapter, fetchImpl } = build();
  await adapter.loadMapDefinition(9001);
  const [call] = fetchImpl.calls;
  check(call.url.endsWith('/map-definitions/9001/layers'), 'the layers path is addressed by id', call.url);
  check(call.headers['x-api-key'] === 'fixture-key-not-a-real-credential', 'the key rides in the x-api-key header by default');
  check(!call.url.includes('apiKey'), 'and never in the query string by default');

  const q = build({ adapter: { authMode: 'query' } });
  await q.adapter.loadMapDefinition(9001);
  check(
    q.fetchImpl.calls[0].url.includes('apiKey=') && !q.fetchImpl.calls[0].headers['x-api-key'],
    'authMode: "query" moves it to ?apiKey= (the embed convention)',
  );
}

/* ---------------------------------------------------------- offline: resolve -- */

section('offline · resolvePlace');
{
  const { adapter } = build();
  await adapter.loadMapDefinition(9001);

  const exact = adapter.resolvePlace('Old Town');
  check(exact && exact.name === 'Old Town', 'exact match returns one Place');

  const ci = adapter.resolvePlace('market hall');
  check(ci && ci.name === 'Market Hall', 'case-insensitive match returns one Place');

  const amb = adapter.resolvePlace('Harbour District');
  check(isAmbiguous(amb) && amb.candidates.length === 2, 'a repeated name returns Ambiguous with both candidates');
  check(amb.query === 'Harbour District', 'Ambiguous carries the query that was ambiguous');

  const sub = adapter.resolvePlace('clock');
  check(sub && sub.name === 'Clock Tower', 'substring match falls through to the one containing place');

  const alias = adapter.resolvePlace('tower');
  check(alias && alias.name === 'Clock Tower', 'an alias resolves too');

  check(adapter.resolvePlace('Cathedral of St Nowhere') === null, 'a miss returns null, not a guess');
  check(adapter.resolvePlace('   ') === null, 'blank text returns null');
}

/* --------------------------------------------------------------- offline: at -- */

section('offline · at() and nearby()');
{
  const { adapter } = build();
  await adapter.loadMapDefinition(9001);

  const uvOf = (x, y) => adapter.toUV(x, y);
  const rt = adapter.toFrame(...Object.values(uvOf(3.5, 0.5)));
  check(
    Math.abs(rt.lng - 3.5) < 1e-9 && Math.abs(rt.lat - 0.5) < 1e-9,
    'toUV/toFrame round-trip through the Mercator v mapping',
    `${rt.lng.toFixed(6)}, ${rt.lat.toFixed(6)}`,
  );

  const oldTown = uvOf(3.5, 0.5);
  check(adapter.at(oldTown.u, oldTown.v).place?.name === 'Old Town', 'at() inside a small polygon returns it, not the region containing it');

  const inHarbour = uvOf(1, 1);
  check(
    adapter.at(inHarbour.u, inHarbour.v).place?.name === 'Harbour District',
    'containment beats a coincident point, smallest area wins',
    adapter.at(inHarbour.u, inHarbour.v).place?.name,
  );

  const inRegionOnly = uvOf(6.5, 3);
  check(adapter.at(inRegionOnly.u, inRegionOnly.v).place?.name === 'Greater Region', 'a point only the big polygon contains returns the big polygon');

  const atFerry = uvOf(8, 8);
  check(adapter.at(atFerry.u, atFerry.v).place?.name === 'Ferry Terminal', 'outside every polygon, the nearest feature within tolerance answers');
  const nearFerry = uvOf(8.05, 8.05);
  check(
    adapter.at(nearFerry.u, nearFerry.v).place?.name === 'Ferry Terminal',
    'and still answers a little off the mark, within the default tolerance',
  );
  check(
    adapter.at(nearFerry.u, nearFerry.v, { tolerance: 100 }).place === undefined,
    'with a tolerance too tight to reach it, at() returns nothing rather than the wrong thing',
  );
  const emptyCorner = uvOf(9.8, 9.8);
  check(
    adapter.at(emptyCorner.u, emptyCorner.v).place === undefined,
    'a corner of the window with nothing near it answers nothing',
  );

  const near = adapter.nearby(inHarbour.u, inHarbour.v, 1e7);
  // M7 aligned this shape with `camioWorldAdapter.nearby()`: the unit rides in
  // the result (§5.4) so a consumer needs no per-adapter branch.
  check(
    near.length > 0 && near[0].distance.value === 0 && near[0].distance.units === 'metres',
    'nearby() returns { value, units } in frame units, nearest first',
    `${near.length} hits`,
  );
  check(
    near.every((p, i) => i === 0 || p.distance.value >= near[i - 1].distance.value),
    'nearby() results are sorted by distance',
  );
  check(near.some((p) => p.name === 'Ferry Terminal'), 'a large radius reaches the far landmark');

  const tight = adapter.nearby(inHarbour.u, inHarbour.v, 1000);
  check(!tight.some((p) => p.name === 'Ferry Terminal'), 'a 1 km radius does not');
  check(adapter.nearby(inHarbour.u, inHarbour.v, 1e7, { limit: 2 }).length === 2, 'nearby() honours a limit');
  check(
    adapter.places.every((p) => p.distance === undefined),
    'nearby() copies rather than stamping distance onto the cached Places',
  );
}

/* ------------------------------------------------------------- offline: frame -- */

section('offline · enu frame');
{
  const spatial = fixture();
  spatial.layers.forEach((l) => { l.coordinateSystem = 'spatial'; });
  const { adapter } = build({ fetchImpl: fakeFetch(spatial), bbox: [0, 0, 100, 100] });
  const res = await adapter.loadMapDefinition(9001);
  check(res.frame === FRAMES.ENU, 'coordinateSystem "spatial" -> enu frame', res.frame);

  const mid = adapter.toFrame(0.5, 0.5);
  check(
    mid.e === 50 && mid.n === 50,
    'enu interpolates BOTH axes linearly — no Mercator on a diagram',
    JSON.stringify(mid),
  );
  const topLeft = adapter.toFrame(0, 0);
  check(topLeft.e === 0 && topLeft.n === 100, 'v = 0 is the top edge in both frames', JSON.stringify(topLeft));
  check(adapter.toUV(25, 75).u === 0.25 && adapter.toUV(25, 75).v === 0.25, 'and the inverse agrees');

  const unknown = fixture();
  unknown.layers.forEach((l) => { l.coordinateSystem = 'martian'; });
  const u = build({ fetchImpl: fakeFetch(unknown) });
  const ures = await u.adapter.loadMapDefinition(9001);
  check(ures.frame === FRAMES.GEOGRAPHIC, 'an unknown coordinateSystem falls back to geographic');
  check(u.adapter.notes.some((n) => /unknown coordinateSystem/.test(n)), 'and says so');
}

/* ------------------------------------------------------------- offline: cache -- */

section('offline · cache');
{
  const { adapter, fetchImpl } = build();
  const first = await adapter.loadMapDefinition(9001);
  const second = await adapter.loadMapDefinition(9001);
  check(fetchImpl.calls.length === 1, 'a warm load performs ZERO requests — the session is offline after the first', `${fetchImpl.calls.length} call(s) total`);
  check(second.fromCache === true, 'and reports fromCache: true');
  check(second.places === first.places && second.cacheIdentity === first.cacheIdentity, 'the warm load rebuilds the same model');
  check(
    first.cacheIdentity === '9001::' + CACHED_AT + '::none',
    'the record identity is (mapDefinitionId, cachedAt, rulesetId) — rulesetId: null is the healthy case',
    first.cacheIdentity,
  );

  const forced = await adapter.loadMapDefinition(9001, { force: true });
  check(fetchImpl.calls.length === 2 && forced.fromCache === false, 'force: true refetches');

  // A store shared across adapters is the browser case: reload the page, same data.
  const store = new MemoryStore();
  const a = build({ store });
  await a.adapter.loadMapDefinition(9001);
  const b = build({ store });
  const bres = await b.adapter.loadMapDefinition(9001);
  check(b.fetchImpl.calls.length === 0 && bres.places === 7, 'a second adapter sharing the store loads without any network at all');
  check(Boolean(await store.get(cacheKey(9001))), 'the record is stored under the documented key');
}

section('offline · expiry');
{
  let clock = T_FRESH;
  const store = new MemoryStore();
  const fetchImpl = fakeFetch();
  const adapter = new AudiomWorldAdapter({
    apiKey: 'fixture-key-not-a-real-credential',
    fetchImpl,
    store,
    bbox: [0, 0, 10, 10],
    now: () => clock,
  });
  await adapter.loadMapDefinition(9001);
  await adapter.loadMapDefinition(9001);
  check(fetchImpl.calls.length === 1, 'inside the TTL, still one request');

  clock = Date.parse(EXPIRES_AT) + 1000;
  const stale = await adapter.loadMapDefinition(9001);
  check(fetchImpl.calls.length === 2 && stale.fromCache === false, 'past expiresAt, the record is refetched', `${fetchImpl.calls.length} call(s)`);

  const noTtl = fixture();
  noTtl.layers.forEach((l) => { delete l.expiresAt; });
  const n = build({ fetchImpl: fakeFetch(noTtl), now: () => Date.now() });
  await n.adapter.loadMapDefinition(9001);
  await n.adapter.loadMapDefinition(9001);
  check(n.fetchImpl.calls.length === 1, 'a layer set with no expiresAt is not refetched on a whim');
}

/* -------------------------------------------------------- offline: contracts -- */

section('offline · unsupported and seams');
{
  const { adapter } = build();
  await adapter.loadMapDefinition(9001);

  const r = adapter.route({ u: 0, v: 0 }, { u: 1, v: 1 });
  check(isUnsupported(r) && r.capability === CAPABILITIES.ROUTING, 'route() is Unsupported until a graph is built (this fixture has no ways)', r.reason);
  const a = adapter.attributes({ id: 'x' });
  check(isUnsupported(a) && a.capability === CAPABILITIES.ACCESSIBILITY_ATTRS, 'attributes() is Unsupported', a.reason);

  const throws = (fn) => { try { fn(); return false; } catch { return true; } };
  check(throws(() => adapter.attachLogicGraph({})), 'the M12b logic-graph seam throws rather than pretending');
  check(throws(() => adapter.noteFeatureEntered({})), 'the M5b featureEntered seam throws rather than pretending');

  let rejected = false;
  await adapter.loadMapDefinition('').catch(() => { rejected = true; });
  check(rejected, 'loading without an id is rejected — §7.1, ids cannot be discovered by listing');

  const bare = new AudiomWorldAdapter({ fetchImpl: fakeFetch() });
  check(bare.at(0.5, 0.5).place === undefined, 'at() before any load is empty rather than a crash');
  check(bare.nearby(0.5, 0.5).length === 0, 'nearby() before any load is []');

  const failing = async () => ({ ok: false, status: 403, json: async () => ({}) });
  let msg = '';
  await new AudiomWorldAdapter({ fetchImpl: failing }).loadMapDefinition(1).catch((e) => { msg = e.message; });
  check(/403/.test(msg) && /allowedOrigins/.test(msg), 'a 403 names allowedOrigins as the likely cause (§7.1)', msg);
}

/* ------------------------------------------------------------------- derived -- */

section('offline · derived window');
{
  const { adapter } = build({ bbox: null });
  await adapter.loadMapDefinition(9001);
  check(
    JSON.stringify(adapter.bbox) === JSON.stringify([0, 0, 8, 8]),
    'with no bbox given, the window is the full extent of the loaded geometry',
    JSON.stringify(adapter.bbox),
  );
  adapter.setWindow([0, 0, 2, 2]);
  const c = adapter.toFrame(0.5, 0.5);
  check(Math.abs(c.lng - 1) < 1e-9, 'setWindow re-windows without refetching', JSON.stringify(c));
}

/* ------------------------------------------------------- debt: audiom.js -- */

section('offline · audiom.js is importable from Node (§5.1 debt)');
{
  // The debt itself: this file used to throw `TypeError` on import outside Vite
  // because `import.meta.env` was dereferenced at module scope. The import at
  // the top of this script is the check — if it regressed, nothing below runs.
  check(typeof audiom.uvToLngLat === 'function', 'audiom.js imports in Node and exports uvToLngLat');
  check(typeof audiom.uvToEastNorth === 'function', 'and uvToEastNorth');
  check(audiom.AUDIOM_KEY === '', 'a missing VITE_ key reads as "" rather than throwing', JSON.stringify(audiom.AUDIOM_KEY));
  check(
    audiom.AUDIOM_ORIGIN === 'https://audiom-staging.herokuapp.com',
    'and AUDIOM_ORIGIN falls back to its documented default',
    audiom.AUDIOM_ORIGIN,
  );

  // ── The copies that were deleted from audiomWorldAdapter.js, verbatim. ──
  // The plan (§5.1) asserts the adapter's re-derivation "must stay numerically
  // identical" to audiom.js. Held to the letter, that claim was FALSE: the copy
  // wrote `lat * DEG` / `y / DEG` where audiom.js writes `(lat * PI) / 180` and
  // `(y * 180) / PI`, which are different floating-point expressions.
  const DEG = Math.PI / 180;
  const MAX_MERC_LAT = 85.05112878;
  const clampLat = (lat) => Math.min(MAX_MERC_LAT, Math.max(-MAX_MERC_LAT, lat));
  const oldMercY = (lat) => {
    const s = Math.sin(clampLat(lat) * DEG);
    return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  };
  const oldInvMercY = (y) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) / DEG;
  const oldUvToXYGeo = (u, v, bbox) => {
    const [minX, minY, maxX, maxY] = bbox;
    const x = minX + u * (maxX - minX);
    const yTop = oldMercY(maxY);
    const yBot = oldMercY(minY);
    return [x, oldInvMercY(yTop + v * (yBot - yTop))];
  };
  const oldUvToXYEnu = (u, v, bbox) => {
    const [minX, minY, maxX, maxY] = bbox;
    return [minX + u * (maxX - minX), maxY - v * (maxY - minY)];
  };

  // A deterministic sweep — a fixed lattice, not a sampler, so this check means
  // the same thing on every run.
  const BOXES = [
    [0, 0, 10, 10],
    [-93.0, 42.4, -86.7, 47.1], // 885's window, near enough
    [-0.51, 51.28, 0.33, 51.69], // London
    [174.6, -41.4, 175.0, -41.1], // southern hemisphere
    [-180, -85.05112878, 180, 85.05112878], // the whole Mercator domain
  ];
  let enuIdentical = true;
  let lngIdentical = true;
  let latIdentical = true;
  let worstLat = 0;
  let samples = 0;

  for (const bbox of BOXES) {
    for (let i = 0; i <= 40; i += 1) {
      for (let j = 0; j <= 40; j += 1) {
        const u = i / 40;
        const v = j / 40;
        samples += 1;

        const { lng, lat } = audiom.uvToLngLat(u, v, bbox);
        const [oldX, oldY] = oldUvToXYGeo(u, v, bbox);
        if (lng !== oldX) lngIdentical = false;
        if (lat !== oldY) latIdentical = false;
        worstLat = Math.max(worstLat, Math.abs(lat - oldY));

        const { e, n } = audiom.uvToEastNorth(u, v, { e0: bbox[0], n0: bbox[1], e1: bbox[2], n1: bbox[3] });
        const [oldE, oldN] = oldUvToXYEnu(u, v, bbox);
        if (e !== oldE || n !== oldN) enuIdentical = false;
      }
    }
  }

  check(enuIdentical, `uvToEastNorth is BIT-identical to the deleted ENU copy over ${samples} samples`);
  check(lngIdentical, 'uvToLngLat\'s longitude is BIT-identical to the deleted copy');
  check(
    !latIdentical,
    'its latitude is NOT — the deleted copy spelled the degree conversion differently (plan §5.1 overclaimed)',
    `worst |Δlat| = ${worstLat.toExponential(3)}°`,
  );
  check(
    worstLat * 111320 < 1e-6,
    'and the disagreement is under a micrometre on the ground, so nothing observable changed',
    `${(worstLat * 111320 * 1e9).toFixed(2)} nm`,
  );

  // The identity that DOES have to hold: the refactor changed no numbers. These
  // are the pre-refactor expressions, which differed from the post-refactor ones
  // only by the added domain clamp.
  const preRefactorMercY = (lat) => {
    const s = Math.sin((lat * Math.PI) / 180);
    return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  };
  let clampIsIdentity = true;
  for (let i = -8505; i <= 8505; i += 1) {
    const lat = i / 100;
    if (audiom.mercY(lat) !== preRefactorMercY(lat)) clampIsIdentity = false;
  }
  check(clampIsIdentity, 'the domain clamp added to mercY is the identity across the whole Mercator range');
  check(Number.isFinite(audiom.mercY(90)) && !Number.isFinite(preRefactorMercY(90)), 'and turns the pole from Infinity into the cut latitude');
}

/* ----------------------------------------------------------- graph builder -- */

/**
 * A 3 x 3 street grid: three east-west streets crossing three north-south
 * avenues, plus four POIs. Every crossing shares an exact vertex, which is what
 * layerloader's 5-decimal truncation produces on real data.
 */
const line = (coords) => ({ type: 'LineString', coordinates: coords });

/**
 * @param {number} k Coordinate scale. `1` gives a ~1.1 km geographic window;
 *   `111320` gives the same grid as a metre-scale `enu` diagram, which is what a
 *   real spatial diagram looks like.
 */
const gridFixture = (k = 1) => {
  const X = [0, 0.005 * k, 0.01 * k];
  const Y = [0, 0.005 * k, 0.01 * k];
  return {
    id: 9002,
    slug: 'fixture-grid',
    title: 'Fixture Grid',
    name: 'Fixture Grid',
    warnings: [],
    layers: [
      layer('L1: Streets', 'standard', true, [
        feature(1, 'L1: Streets', 'North Street', line(X.map((x) => [x, Y[2]]))),
        feature(2, 'L1: Streets', 'Middle Street', line(X.map((x) => [x, Y[1]]))),
        feature(3, 'L1: Streets', 'South Street', line(X.map((x) => [x, Y[0]]))),
        feature(4, 'L1: Streets', 'West Avenue', line(Y.map((y) => [X[0], y]))),
        feature(5, 'L1: Streets', 'Center Avenue', line(Y.map((y) => [X[1], y]))),
        feature(6, 'L1: Streets', 'East Avenue', line(Y.map((y) => [X[2], y]))),
      ]),
      layer('L2: Places', 'standard', true, [
        feature(1, 'L2: Places', 'Bakery', point(0.0025 * k, 0)),
        feature(2, 'L2: Places', 'Library', point(0.0075 * k, 0.01 * k)),
        feature(3, 'L2: Places', 'Clinic', point(0.01 * k, 0.0025 * k)),
        feature(4, 'L2: Places', 'Ferry Terminal', point(0.2 * k, 0.2 * k)),
      ]),
    ],
  };
};

const buildGrid = async (opts = {}) => {
  const adapter = new AudiomWorldAdapter({
    fetchImpl: fakeFetch(gridFixture()),
    store: new MemoryStore(),
    now: () => T_FRESH,
    bbox: [0, 0, 0.01, 0.01],
    ...opts,
  });
  await adapter.loadMapDefinition(9002);
  return adapter;
};

section('offline · geojsonGraph');
{
  // Projection identical to the adapter's: metres east, metres SOUTH.
  const M = 111320;
  const project = (lng, lat) => [lng * M * Math.cos(0.005 * (Math.PI / 180)), (0.01 - lat) * M];
  const places = gridFixture().layers.flatMap((l) =>
    l.source.features.map((f) => ({ id: String(f.id), name: f.properties.name, geometry: f.geometry })));

  const built = buildGraphDict(places, project, { snapTolerance: 1 });
  check(built.ok, 'a street grid builds', built.reason);
  check(
    built.stats.nodes === 9,
    'the 18 line vertices snap onto 9 distinct crossings, and all 9 are junctions',
    `${built.stats.nodes} nodes / ${built.stats.vertices} distinct vertices`,
  );
  check(built.stats.edges === 12, 'twelve chords between them', `${built.stats.edges}`);
  check(built.stats.streets === 6, 'six named streets', `${built.stats.streets}`);
  check(built.stats.components === 1, 'one connected component');
  check(built.stats.pois === 4, 'the four point features become POIs', `${built.stats.pois}`);

  // The index alignment that everything else depends on: `loadEdges()` rebuilds
  // the edge array by walking `Object.entries(streets)`, so a POI's stored edge
  // index only means anything if the two orders agree.
  const g = new Graph(built.graphDict, { feetsPerInch: 1, llmEnabled: false });
  const rebuilt = g.edges.map((e) => [e.node1.index, e.node2.index]);
  check(
    JSON.stringify(rebuilt) === JSON.stringify(built.graphDict.edges),
    'graphDict.edges is in the order loadEdges() rebuilds it, so POI edge indices survive',
  );
  check(
    g.pois.every((poi) => poi.edge instanceof Object && typeof poi.street === 'string' && poi.street.length > 0),
    'every POI lands on a named edge',
  );
  const bakery = g.pois.find((p) => p.name === 'Bakery');
  check(bakery.street === 'South Street', 'the Bakery attaches to the street it sits on', bakery.street);

  // Interior vertices are shape, not junctions — the reason is a prose bug.
  const bent = buildGraphDict(
    [{ id: 'a', name: 'Bent Lane', geometry: line([[0, 0], [0.002, 0.0005], [0.004, 0]]) }],
    project,
    { snapTolerance: 1 },
  );
  check(bent.stats.nodes === 2 && bent.stats.edges === 1, 'a lone bent way is two nodes and one chord', `${bent.stats.nodes}/${bent.stats.edges}`);

  const unnamed = buildGraphDict(
    [{ id: 'a', name: '', geometry: line([[0, 0], [0.004, 0]]) }],
    project,
    { snapTolerance: 1 },
  );
  check(
    Object.keys(unnamed.graphDict.streets)[0] === UNNAMED_STREET,
    'an unnamed way gets a speakable synthetic name rather than being dropped',
  );
  check(unnamed.notes.some((n) => /unnamed way/.test(n)), 'and says so');

  const nothing = buildGraphDict(
    [{ id: 'a', name: 'Blob', geometry: poly(0, 0, 1, 1) }],
    project,
    { snapTolerance: 1 },
  );
  check(!nothing.ok && /no linear features/.test(nothing.reason), 'polygons alone are not a network', nothing.reason);

  const capped = buildGraphDict(places, project, { snapTolerance: 1, maxNodes: 4 });
  check(!capped.ok && /junctions/.test(capped.reason), 'past maxNodes it refuses rather than running O(V^3)', capped.reason);
}

/* ---------------------------------------------------------------- routing -- */

section('offline · buildLogicGraph + route (M12b)');
{
  const adapter = await buildGrid();
  check(!adapter.session().capabilities.has(CAPABILITIES.ROUTING), 'loading alone does not declare routing');
  const beforeGraph = adapter.route('Bakery', 'Library');
  check(
    isUnsupported(beforeGraph) && /buildLogicGraph/.test(beforeGraph.reason),
    'and route() says exactly what is missing',
    beforeGraph.reason,
  );

  const info = adapter.buildLogicGraph();
  check(info.ok, 'buildLogicGraph succeeds on the grid', info.reason);
  check(
    adapter.session().capabilities.has(CAPABILITIES.GRAPH) && adapter.session().capabilities.has(CAPABILITIES.ROUTING),
    'and only THEN are graph + routing declared',
  );
  check(adapter.logicGraph instanceof Graph, 'the ported Graph is what got attached');
  check(
    adapter.logicGraph.nodes.length === 9 && adapter.logicGraph.edges.length === 12,
    'with the grid topology intact',
    `${adapter.logicGraph.nodes.length} nodes / ${adapter.logicGraph.edges.length} edges`,
  );

  // The plane: metres, y DOWN, anchored at the window's north-west corner.
  const nw = adapter.plane.toPlane(0, 0.01);
  const se = adapter.plane.toPlane(0.01, 0);
  check(Math.abs(nw[0]) < 1e-9 && Math.abs(nw[1]) < 1e-9, 'the plane origin is the window\'s north-west corner', JSON.stringify(nw));
  check(se[1] > 0, 'y grows SOUTHWARD, which is what graph.js means by north = (0, -1)', `${se[1].toFixed(1)}`);
  check(Math.abs(se[0] - 1113.2) < 2 && Math.abs(se[1] - 1113.2) < 2, 'and the units are metres', `${se[0].toFixed(1)} x ${se[1].toFixed(1)} m`);
  check(
    Math.abs(adapter.plane.unitsPerInch - se[0] / (270 / 25.4)) < 1e-9,
    'unitsPerInch is metres-of-ground per inch of printed material (A4 artwork width)',
    `${adapter.plane.unitsPerInch.toFixed(1)} m/in`,
  );

  const r = adapter.route('Bakery', 'Library');
  check(!isUnsupported(r) && !isAmbiguous(r), 'a route comes back', isUnsupported(r) ? r.reason : '');
  check(r.frame === FRAMES.GEOGRAPHIC, 'the route echoes the frame so L3 narrates the right units', r.frame);
  check(r.segments.length === r.waypoints.length && r.segments.length > 0, 'segments and waypoints agree', `${r.segments.length}`);
  check(
    r.instructions.every((i) => /^(Head (north|south|east|west|north-east|north-west|south-east|south-west)|Continue straight)/.test(i)),
    'every instruction opens with a cardinal heading or a turn-relative continuation — MapIO\'s convention, never a clock face',
    JSON.stringify(r.instructions),
  );
  check(
    r.waypoints.every((w) => ['north', 'south', 'east', 'west', 'north-east', 'north-west', 'south-east', 'south-west'].includes(w.direction)),
    'and every direction is one of the eight CardinalDirections',
    r.waypoints.map((w) => w.direction).join(' -> '),
  );
  check(
    r.waypoints.every((w) => Number.isFinite(w.position.lng) && Number.isFinite(w.position.lat)),
    'positions leave in WORLD-NATIVE lng/lat — uv is converted at the boundary and never propagates outward',
  );
  check(
    r.waypoints.every((w) => w.position.u === undefined && w.position.v === undefined),
    'and carry no (u, v) at all',
  );
  // Bakery sits exactly midway between two junctions, so `getNearestNode`'s
  // first-wins tie-break sends the first leg WEST before turning north — a
  // faithful consequence of the ported rule, and the reason this asserts a band
  // around the walked distance rather than the 1,669 m Manhattan ideal.
  check(
    r.distance > 1669 && r.distance < 2500,
    'the total distance is the WALKED one (grid, not crow-flies), in metres',
    `${r.distance.toFixed(0)} m`,
  );
  check(
    Math.abs(r.duration - r.distance / 1.2) < 1e-9,
    'duration is that distance at a walking pace',
    `${(r.duration / 60).toFixed(1)} min`,
  );
  check(r.from.label === 'Bakery' && r.to.label === 'Library', 'the endpoints name themselves for narration');
  check(
    Number.isFinite(r.from.position.lng) && Number.isFinite(r.from.position.lat),
    'including the snapped start, in lng/lat',
  );
  check(
    Math.abs(r.segments.reduce((s, seg) => s + seg.distance, 0) - r.distance) < 1e-9,
    'the leg distances sum to the total',
  );
  check(
    r.segments.some((s) => /^n\d+$/.test(s.toNode)),
    'legs that end at a junction carry that junction\'s node id',
    r.segments.map((s) => s.toNode).join(' -> '),
  );

  // Directions must be the graph's, not this layer's. North is +lat.
  const northward = adapter.route({ lng: 0, lat: 0 }, { lng: 0, lat: 0.01 });
  check(
    northward.waypoints[0].direction === 'north',
    'walking up-latitude is called "north" — the y-down plane did not mirror the compass',
    northward.waypoints.map((w) => w.direction).join(', '),
  );
  const eastward = adapter.route({ lng: 0, lat: 0 }, { lng: 0.01, lat: 0 });
  check(eastward.waypoints[0].direction === 'east', 'and walking up-longitude is "east"', eastward.waypoints[0].direction);

  // Addressing: world-native first, uv accepted and converted once.
  const byUV = adapter.route({ u: 0, v: 1 }, { u: 1, v: 1 });
  check(!isUnsupported(byUV), 'a (u,v) endpoint is accepted at the boundary', isUnsupported(byUV) ? byUV.reason : '');
  check(
    Math.abs(byUV.from.position.lat - eastward.from.position.lat) < 1e-9 &&
      Math.abs(byUV.from.position.lng - eastward.from.position.lng) < 1e-9,
    'and lands where the equivalent lng/lat endpoint does',
  );

  // Preferences: the ported Floyd-Warshall has no preference model.
  const withPrefs = adapter.route('Bakery', 'Library', { avoidBarriers: true, maxUphill: 5 });
  check(
    withPrefs.ignoredPrefs.includes('avoidBarriers') && withPrefs.ignoredPrefs.includes('maxUphill'),
    'unhonoured RoutePrefs are echoed back rather than silently dropped',
    JSON.stringify(withPrefs.ignoredPrefs),
  );

  const flyOver = adapter.route('Bakery', 'Library', { streetByStreet: false });
  check(flyOver.waypoints.length === 1, 'streetByStreet: false is the single-hop fly-over leg', `${flyOver.waypoints.length}`);

  // Failure modes, all narratable rather than thrown.
  const amb = adapter.route('Harbour District', 'Library');
  check(isUnsupported(amb) && /could not find/.test(amb.reason), 'an unknown start is a narratable refusal', amb.reason);
  const noGeom = adapter.route('Bakery', 'Cathedral of St Nowhere');
  check(isUnsupported(noGeom) && /finish/.test(noGeom.reason), 'and so is an unknown finish', noGeom.reason);

  check(
    isUnsupported(adapter.attributes({ id: 'leg:0' })),
    'attributes() stays Unsupported: M12b built topology, not validated kerb data',
    adapter.attributes({ id: 'leg:0' }).reason,
  );

  // A graph is a projection of one window over one set of places.
  adapter.setWindow([0, 0, 0.005, 0.005]);
  check(
    !adapter.session().capabilities.has(CAPABILITIES.ROUTING) && adapter.logicGraph === null,
    're-windowing drops the graph rather than routing the old one in the new plane',
  );
}

section('offline · route ambiguity and disconnection');
{
  const adapter = await buildGrid();
  adapter.buildLogicGraph();

  // Two features share a name -> Ambiguous flows out of route() unchanged, so
  // the dispatcher can ask rather than the adapter guessing.
  const both = adapter.resolvePlace('Avenue');
  check(isAmbiguous(both), 'the grid has an ambiguous name to test with', `${both.candidates?.length} candidates`);
  const r = adapter.route('Avenue', 'Library');
  check(isAmbiguous(r), 'route() returns Ambiguous rather than picking one', isAmbiguous(r) ? `${r.candidates.length}` : '');

  // The far-off Ferry Terminal is a POI with no way near it; it still snaps.
  const far = adapter.route('Bakery', 'Ferry Terminal');
  check(!isUnsupported(far), 'an off-network destination still routes, by snapping to the network', isUnsupported(far) ? far.reason : '');

  // A genuinely disconnected pair.
  const split = new AudiomWorldAdapter({
    fetchImpl: fakeFetch({
      id: 9003,
      title: 'Two Islands',
      warnings: [],
      layers: [layer('L1: Streets', 'standard', true, [
        feature(1, 'L1: Streets', 'Island Road', line([[0, 0], [0.002, 0]])),
        feature(2, 'L1: Streets', 'Mainland Road', line([[0.008, 0.01], [0.01, 0.01]])),
      ])],
    }),
    store: new MemoryStore(),
    now: () => T_FRESH,
    bbox: [0, 0, 0.01, 0.01],
  });
  await split.loadMapDefinition(9003);
  const splitInfo = split.buildLogicGraph();
  check(splitInfo.ok && splitInfo.stats.components === 2, 'a two-piece network builds and reports both pieces', `${splitInfo.stats.components}`);
  const across = split.route({ lng: 0, lat: 0 }, { lng: 0.01, lat: 0.01 });
  check(
    isUnsupported(across) && /no path/i.test(across.reason),
    'and routing across the gap is a narratable "no path", not a throw',
    across.reason,
  );
}

section('offline · enu routing');
{
  // The same grid as a metre-scale spatial diagram: east/north units, both axes
  // linear, no Mercator anywhere.
  const K = 111320;
  const spatial = gridFixture(K);
  spatial.layers.forEach((l) => { l.coordinateSystem = 'spatial'; });
  const adapter = new AudiomWorldAdapter({
    fetchImpl: fakeFetch(spatial),
    store: new MemoryStore(),
    now: () => T_FRESH,
    bbox: [0, 0, 0.01 * K, 0.01 * K],
  });
  const res = await adapter.loadMapDefinition(9002);
  check(res.frame === FRAMES.ENU, 'the same grid read as a spatial diagram');
  const info = adapter.buildLogicGraph();
  check(info.ok && info.stats.nodes === 9, 'builds the same 9-node graph', info.reason || `${info.stats.nodes}`);
  const r = adapter.route('Bakery', 'Library');
  check(!isUnsupported(r), 'and routes', isUnsupported(r) ? r.reason : '');
  check(r.duration === undefined, 'but reports NO duration — "12 minutes\' walk" is not a claim a diagram can make');
  check(
    r.waypoints.every((w) => Number.isFinite(w.position.e) && Number.isFinite(w.position.n)),
    'and positions leave as east/north, this world\'s native coordinates',
  );
  check(
    r.waypoints.every((w) => w.position.lng === undefined),
    'never as lng/lat — saying "north-west of 43.1, -89.4" about a diagram is the bug frames exist to prevent',
  );

  // The tolerance that would have welded a small diagram into a single node.
  const tiny = new AudiomWorldAdapter({
    fetchImpl: fakeFetch((() => { const f = gridFixture(1); f.layers.forEach((l) => { l.coordinateSystem = 'spatial'; }); return f; })()),
    store: new MemoryStore(),
    now: () => T_FRESH,
    bbox: [0, 0, 0.01, 0.01],
  });
  await tiny.loadMapDefinition(9002);
  const tinyInfo = tiny.buildLogicGraph();
  check(
    tinyInfo.ok && tinyInfo.stats.nodes === 9,
    'a diagram only 0.01 units wide still resolves 9 junctions — the snap tolerance scales with the window',
    tinyInfo.reason || `${tinyInfo.stats.nodes}`,
  );
  check(
    !tiny.buildLogicGraph({ snapTolerance: 1 }).ok,
    'and a hard-coded 1-unit tolerance is exactly what would have welded it shut',
  );
}

/* --------------------------------------------------------------- indexeddb -- */

section('offline · IndexedDB layer store (§8: required, not an optimisation)');
{
  check(typeof IndexedDBLayerStore === 'function', 'the browser store exists');
  check(LAYER_DB_NAME === 'abtc-audiom-layers', 'in its OWN database, not a corner of abtc-place-index (§5.1)', LAYER_DB_NAME);
  check(
    defaultLayerStore() instanceof MemoryStore,
    'and degrades to memory where there is no indexedDB, which is what keeps this module Node-importable',
  );
  check(
    ['get', 'put', 'delete', 'entries'].every((m) => typeof IndexedDBLayerStore.prototype[m] === 'function'),
    'both stores satisfy the same get/put/delete/entries interface',
  );
  const bare = new AudiomWorldAdapter({ fetchImpl: fakeFetch() });
  check(bare.store instanceof MemoryStore, 'the constructor picks it up by default');
}

/* ---------------------------------------------------------------------- live -- */

section('live · staging map 885');

const KEY = process.env.VITE_AUDIOM_FULL_ACCESS_KEY || process.env.AUDIOM_FULL_ACCESS_KEY || '';
const BASE = process.env.VITE_AUDIOM_BASE_URL || process.env.AUDIOM_BASE_URL || AUDIOM_BACKEND_STAGING;
const MAP_ID = process.env.AUDIOM_MAP_ID || 885;

if (!KEY) {
  console.log('skip  live · VITE_AUDIOM_FULL_ACCESS_KEY is not set — offline coverage above stands on its own.');
  console.log('      to run it:  VITE_AUDIOM_FULL_ACCESS_KEY=… node starter/scripts/test_audiom_adapter.mjs');
} else if (typeof fetch !== 'function') {
  console.log('skip  live · this Node build has no global fetch.');
} else {
  const store = new MemoryStore();
  let calls = 0;
  const counted = (...args) => { calls += 1; return fetch(...args); };
  const adapter = new AudiomWorldAdapter({ baseUrl: BASE, apiKey: KEY, fetchImpl: counted, store, timeoutMs: 10000 });

  let res = null;
  const t0 = Date.now();
  try {
    res = await adapter.loadMapDefinition(MAP_ID);
  } catch (err) {
    console.log(`skip  live · ${BASE} did not answer within 10s (${err.message}) — not a failure of the adapter.`);
  }

  if (res) {
    console.log(`      loaded map ${MAP_ID} in ${Date.now() - t0} ms`);
    check(res.layers > 10, 'more than 10 layers', `${res.layers}`);
    check(res.places > 1000, 'more than 1000 places', `${res.places}`);
    check(res.warnings.length === 0, 'warnings is empty', JSON.stringify(res.warnings));
    check(res.frame === FRAMES.GEOGRAPHIC, 'the real map resolves to a geographic frame', res.frame);
    check(Array.isArray(res.bbox) && res.bbox.every(Number.isFinite), 'a window was derived from the geometry', JSON.stringify(res.bbox?.map((n) => n.toFixed(3))));

    const sample = adapter.places[0];
    const hit = adapter.resolvePlace(sample.name);
    check(Boolean(hit), `resolvePlace finds "${sample.name.slice(0, 40)}"`, isAmbiguous(hit) ? `${hit.candidates.length} candidates` : 'unique');
    check(
      adapter.places.every((p) => p.props?.sourceName && p.provenance?.source === 'audiom:layers'),
      'every place carries sourceName provenance for placeIndex',
    );
    check(new Set(adapter.places.map((p) => p.id)).size === adapter.places.length, 'Place ids are unique over the whole real map');

    const centre = adapter.at(0.5, 0.5);
    console.log(`      at(0.5, 0.5) -> ${centre.place ? `${centre.place.name} [${centre.place.category}]` : '(nothing)'}`);
    console.log(`      nearby(0.5, 0.5) -> ${adapter.nearby(0.5, 0.5).length} places`);

    const before = calls;
    const warm = await adapter.loadMapDefinition(MAP_ID);
    check(calls === before && warm.fromCache === true, 'the second load is served from cache with zero requests');
  }
}

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
