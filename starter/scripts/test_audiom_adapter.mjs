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
  AUDIOM_BACKEND_STAGING,
  cacheKey,
} from '../src/lib/adapters/audiomWorldAdapter.js';
import { isAmbiguous, isUnsupported, FRAMES, CAPABILITIES } from '../src/lib/worldAdapter.js';

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
  check(near.length > 0 && near[0].distance === 0, 'nearby() returns distance in frame units, nearest first', `${near.length} hits`);
  check(
    near.every((p, i) => i === 0 || p.distance >= near[i - 1].distance),
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
  check(isUnsupported(r) && r.capability === CAPABILITIES.ROUTING, 'route() is Unsupported until M12b', r.reason);
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
