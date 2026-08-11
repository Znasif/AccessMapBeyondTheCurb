/**
 * AudiomWorldAdapter — milestone 5a, Tier A.
 *
 * Implements §2.1 of `docs/browser-voice-exploration-plan.md`: the *reads* half of
 * the Audiom integration. The other half — `moveAvatar` / `executeCommand` over
 * `postMessage` (§2.2) — is a side-effect channel and does not belong here.
 *
 * The finding this milestone rests on (§0.3): for any map that exists as a
 * `map_definitions` row we can read, Audiom is **Tier A, not Tier C**. The
 * backend already resolves every source through layerloader, applies the map's
 * ruleset, stamps `sourceName` provenance on every feature and derives feature
 * names, so one request yields real geometry with real attributes:
 *
 *   GET /map-definitions/:id/layers
 *     -> { id, slug, title, name, center, zoom, globalParams, organizationId,
 *          refreshed, warnings,
 *          layers: [ { name, mapType, coordinateSystem, visible,
 *                      cachedAt, cacheTtl, expiresAt,
 *                      source: { type: 'FeatureCollection', features, metadata } } ] }
 *
 * After that one request the session is **offline**. That is the point: the LLM
 * is local, the map is local-after-first-load, and a laptop with no connection
 * still works if the map was loaded once before.
 *
 * Platform-free by construction, exactly like `worldAdapter.js` and for the same
 * reason — this module is exercised from Node in
 * `scripts/test_audiom_adapter.mjs`. Network arrives as `fetchImpl`, persistence
 * as `store`. Nothing here reads `import.meta.env`, `window`, `indexedDB` or
 * `fetch` off the global scope except as a *default* that Node also provides.
 *
 * ⚠️ Deliberately NOT imported: `../../audiom.js`. It evaluates
 * `import.meta.env` at module scope, which makes it un-importable outside Vite.
 * The two coordinate helpers it owns (`uvToLngLat`, `uvToEastNorth`) are
 * re-derived below and must stay numerically identical to it — see `#uvToXY`.
 */

import {
  WorldAdapter,
  CAPABILITIES,
  FRAMES,
  ambiguous,
  unsupported,
} from '../worldAdapter.js';

/** Staging, per §7.1. Every measurement in the plan was taken against this host. */
export const AUDIOM_BACKEND_STAGING = 'https://audiom-backend-staging.herokuapp.com';

/**
 * Bump when the cached record shape changes. Older records are refetched rather
 * than reinterpreted — same rule as `placeIndex.js`'s RECORD_VERSION, and for the
 * same reason: a store holding two shapes degrades quietly instead of failing.
 */
export const RECORD_VERSION = 1;

/** Ceiling on `Ambiguous.candidates`, so a 373-way tie does not become a prompt. */
export const MAX_AMBIGUOUS = 8;

/* --------------------------------------------------------------- coordinates -- */

const MAX_MERC_LAT = 85.05112878;
const DEG = Math.PI / 180;
/** Metres per degree, the flat approximation `audiom.js:bboxSpanMeters` uses. */
const M_PER_DEG = 111320;

const clampLat = (lat) => Math.min(MAX_MERC_LAT, Math.max(-MAX_MERC_LAT, lat));
const mercY = (lat) => {
  const s = Math.sin(clampLat(lat) * DEG);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};
const invMercY = (y) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) / DEG;

/* -------------------------------------------------------------------- storage -- */

/**
 * Interface-compatible with `placeIndex.js`'s `MemoryStore` / `IndexedDBStore`
 * (`get` / `put` / `delete` / `entries`, all async, records carry `key`), so the
 * browser wiring is a constructor argument rather than a rewrite.
 *
 * Redefined here rather than imported because `placeIndex.js` pulls in
 * `LocalLLMClient`, and this adapter must stay free of the LLM runtime. Its
 * `IndexedDBStore` is also pinned to the `abtc-place-index` database, which holds
 * embeddings — layer payloads want their own database, so the browser store lands
 * with the M5b wiring rather than being retrofitted onto that one.
 */
export class MemoryStore {
  constructor() { this.map = new Map(); }
  async get(key) { return this.map.get(key) || null; }
  async put(key, value) { this.map.set(key, { ...value, key }); }
  async delete(key) { this.map.delete(key); }
  async entries() { return [...this.map.entries()].map(([key, value]) => ({ key, value })); }
}

/** Store key. One record per map definition — see `cacheIdentity` for freshness. */
export const cacheKey = (mapDefinitionId) => `audiom:map-definition:${mapDefinitionId}`;

/**
 * §2.1's `(mapDefinitionId, cachedAt)` key, plus the ruleset id when the map has
 * one (`rulesetId: null` is the healthy case — §7.1).
 *
 * It is an *identity* field on the record, not the lookup key, because `cachedAt`
 * only exists once the response is in hand: you cannot look a record up by a
 * value the lookup is supposed to give you. The effect §2.1 asks for is the same
 * — a response with a different `cachedAt` is a different record and replaces the
 * one it found.
 */
export const cacheIdentity = ({ mapDefinitionId, cachedAt, rulesetId }) =>
  `${mapDefinitionId}::${cachedAt || 'unknown'}::${rulesetId ?? 'none'}`;

/* ------------------------------------------------------------------- payload -- */

/**
 * `coordinateSystem` -> frame (§5.4 of the design doc).
 *
 * ⚠️ The plan describes this field as "geographic vs enu". Real payloads do not
 * say either: map 885 reports `coordinateSystem: 'standard'` on all 17 layers,
 * alongside `source.metadata.crs = { epsg: 4326, crsName: 'WGS 84' }`. So
 * `standard` is the geographic case, the spatial-diagram vocabulary is accepted
 * on both spellings, and anything unrecognised falls back to `geographic` with a
 * warning rather than guessing a frame in which "north" would be a lie.
 */
export const COORDINATE_SYSTEM_FRAMES = Object.freeze({
  standard: FRAMES.GEOGRAPHIC,
  geographic: FRAMES.GEOGRAPHIC,
  geodetic: FRAMES.GEOGRAPHIC,
  wgs84: FRAMES.GEOGRAPHIC,
  latlng: FRAMES.GEOGRAPHIC,
  spatial: FRAMES.ENU,
  enu: FRAMES.ENU,
  local: FRAMES.ENU,
  relative: FRAMES.ENU,
  cartesian: FRAMES.ENU,
});

/**
 * Property keys tried, in order, for `Place.category`.
 *
 * `ruleType` and `ruleName` are layerloader's post-ruleset classification and are
 * present on 100% of 885's 3004 features; `briefing` (`poi` / `structural` / …)
 * on 99.4%. `Type` is deliberately absent from this list — on the direction-point
 * layer it duplicates the whole feature name verbatim.
 *
 * ⚠️ §2.1: the §6.4 base-rate rule ("drop attributes held by more than ~a third
 * of places") was fitted to camio POIs and **must be re-derived for this world**
 * before these feed `placeIndex.placeDocument()`. On 885, `sourceName`, `ruleName`
 * and `ruleType` are held by 100% of features, so under the camio rule all three
 * would be dropped — which would be wrong here, since they are the only
 * classification the map has. That re-derivation is M8's, not M5a's; `props`
 * carries everything so the decision can be made downstream.
 */
const CATEGORY_KEYS = ['category', 'ruleType', 'briefing'];

/** Property keys tried, in order, for `Place.name`. */
const NAME_KEYS = ['name', 'title', 'Name', 'label', 'Label'];

/** Property keys offered as `Place.aliases` when they differ from the name. */
const ALIAS_KEYS = ['ruleName', 'Label', 'Symbol'];

const firstString = (props, keys) => {
  for (const k of keys) {
    const v = props?.[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return '';
};

const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

/* ------------------------------------------------------------------ geometry -- */

/** Walk every position of a GeoJSON geometry, whatever its nesting depth. */
function* positions(geometry) {
  if (!geometry) return;
  if (geometry.type === 'GeometryCollection') {
    for (const g of geometry.geometries || []) yield* positions(g);
    return;
  }
  const walk = function* (c) {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === 'number') { yield c; return; }
    for (const part of c) yield* walk(part);
  };
  yield* walk(geometry.coordinates);
}

/** Outer-ring-first polygon list, so Polygon and MultiPolygon share one code path. */
function polygonsOf(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  if (geometry.type === 'GeometryCollection') {
    return (geometry.geometries || []).flatMap(polygonsOf);
  }
  return [];
}

/** Ray casting, on the half-open convention so a shared edge belongs to one side. */
function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Outer ring minus holes, per the GeoJSON ring order. */
const pointInPolygon = (x, y, rings) =>
  Boolean(rings.length) &&
  pointInRing(x, y, rings[0]) &&
  !rings.slice(1).some((hole) => pointInRing(x, y, hole));

/** Shoelace magnitude, in squared frame units. Used only to rank containment. */
function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  }
  return Math.abs(a / 2);
}

/* ------------------------------------------------------------------- adapter -- */

/**
 * @typedef {object} LoadResult
 * @property {string|number} mapDefinitionId
 * @property {string} title
 * @property {string} frame
 * @property {number} layers      Layers kept (hidden ones excluded unless asked for).
 * @property {number} places
 * @property {string[]} warnings  The endpoint's own `warnings`, verbatim.
 * @property {boolean} fromCache  False iff the network was touched.
 * @property {string} cacheIdentity
 */

export class AudiomWorldAdapter extends WorldAdapter {
  /**
   * @param {object} [opts]
   * @param {string} [opts.baseUrl]        Defaults to staging (§7.1).
   * @param {string} [opts.apiKey]         The **full-access** key. §7.1: a publishable
   *   key pinned to another org loses org-1 rows to `restrictAccessToOrganization`.
   * @param {Function} [opts.fetchImpl]    Defaults to `globalThis.fetch`.
   * @param {'header'|'query'|'both'} [opts.authMode]
   * @param {object} [opts.store]          get/put/delete/entries; defaults to memory.
   * @param {number[]} [opts.bbox]         Window `[minX, minY, maxX, maxY]` in frame
   *   units. Omit to derive the full extent from the loaded geometry.
   * @param {boolean} [opts.includeHidden] Keep `visible: false` layers (see `#flatten`).
   * @param {number} [opts.timeoutMs]
   * @param {number} [opts.toleranceFraction] `at()` snap radius, as a fraction of the
   *   window diagonal. 0.02 ~ a fingertip on a printed page.
   * @param {number} [opts.radiusFraction]  `nearby()` default radius, same units.
   * @param {() => number} [opts.now]       Injectable clock, for expiry tests.
   */
  constructor({
    baseUrl = AUDIOM_BACKEND_STAGING,
    apiKey = '',
    fetchImpl,
    authMode = 'header',
    store = new MemoryStore(),
    bbox,
    includeHidden = false,
    timeoutMs = 15000,
    toleranceFraction = 0.02,
    radiusFraction = 0.1,
    now = () => Date.now(),
    worldId,
  } = {}) {
    // The frame is a property of the payload, not of the constructor call, and
    // the payload has not arrived yet. `geographic` is the honest default —
    // every `map_definitions` row seen so far is geographic — and
    // `loadMapDefinition()` corrects it from `coordinateSystem` before any tool
    // can read `session()`. Capabilities are equally provisional: `places` is
    // what M5a delivers, and the two seams below say where the rest attaches.
    super({
      frame: FRAMES.GEOGRAPHIC,
      capabilities: [CAPABILITIES.PLACES],
      worldId,
    });

    this.baseUrl = String(baseUrl).replace(/\/$/, '');
    this.apiKey = apiKey;
    this.authMode = authMode;
    this.fetchImpl = fetchImpl || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
    this.store = store;
    this.includeHidden = includeHidden;
    this.timeoutMs = timeoutMs;
    this.toleranceFraction = toleranceFraction;
    this.radiusFraction = radiusFraction;
    this.now = now;

    /** @type {number[]|null} Explicit window, or null until derived from geometry. */
    this.bbox = bbox ? [...bbox] : null;
    this.explicitBbox = Boolean(bbox);

    /** @type {import('../worldAdapter.js').Place[]} */
    this.places = [];
    /** Per-place derived geometry (bbox, polygons, positions). Parallel to `places`. */
    this._index = [];
    /** The endpoint's own `warnings`. §7.1 expects `[]` on a healthy map. */
    this.warnings = [];
    /** Ours: frame ambiguity, dropped layers, missing names. Never the endpoint's. */
    this.notes = [];
    /** @type {object|null} Definition metadata: id, title, center, zoom, globalParams. */
    this.definition = null;
    /** @type {string|null} */
    this.cacheIdentity = null;
    /** In-flight loads, so a burst of calls does not fetch 27 MB twice. */
    this.pending = new Map();
  }

  /* ------------------------------------------------------------------ seams -- */

  /**
   * SEAM — M12b (logic graph / routing).
   *
   * M12b ports `simple_camio_llm`'s graph builder onto this world: it will consume
   * `this.places` plus the LineString layers, produce `Segment`/`Node` records, and
   * call this method to attach them. At that point — and only at that point — the
   * adapter adds `graph` and `routing` to `this.capabilities` and overrides
   * `route()`. Declaring either earlier would offer the model a tool that cannot
   * run, which `worldAdapter.js` calls out as the failure mode that matters.
   *
   * @param {{segments: object[], nodes: object[]}} _graph
   */
  attachLogicGraph(_graph) {
    throw new Error('AudiomWorldAdapter.attachLogicGraph: the logic graph arrives in M12b; until then this adapter declares only "places".');
  }

  /**
   * SEAM — M5b (`liveFeatureStream`).
   *
   * `AudiomMap.jsx` already receives `featureEntered` / `featureSelected` and
   * extracts `payload.features[].name`. M5b promotes that to a ref and routes it
   * here, at which point the adapter declares `liveFeatureStream` and `whats_here`
   * is answered at L0 from the last payload with no inference at all (§2.2).
   *
   * The Tier A enrichment §2.2 asks for is already possible without any of that
   * plumbing: `resolvePlace(name)` turns the stream's name-only payload into the
   * full record, and `nearby()` supplies the adjacency half that Tier C cannot.
   *
   * @param {{features?: {name?: string}[]}} _payload
   */
  noteFeatureEntered(_payload) {
    throw new Error('AudiomWorldAdapter.noteFeatureEntered: the featureEntered stream is wired in M5b; resolvePlace(name) already enriches a name from the stream today.');
  }

  /* ------------------------------------------------------------------- load -- */

  /**
   * Fetch (or reuse) `/map-definitions/:id/layers` and build the place model.
   *
   * ⚠️ §7.1: the adapter must be **handed** map-definition ids. `/maps/885` 404s
   * and `enforceFind` filters listings, so there is no discovery path — direct id
   * addressing is the only way in.
   *
   * @param {string|number} mapDefinitionId
   * @param {object} [opts]
   * @param {boolean} [opts.force] Ignore a warm record and refetch.
   * @param {boolean} [opts.includeHidden] Overrides the constructor for this load.
   * @returns {Promise<LoadResult>}
   */
  async loadMapDefinition(mapDefinitionId, { force = false, includeHidden } = {}) {
    if (mapDefinitionId === undefined || mapDefinitionId === null || mapDefinitionId === '') {
      throw new Error('AudiomWorldAdapter.loadMapDefinition: a map-definition id is required — §7.1, ids cannot be discovered by listing.');
    }
    const key = cacheKey(mapDefinitionId);
    const hidden = includeHidden === undefined ? this.includeHidden : includeHidden;

    if (!force) {
      const record = await this.store.get(key);
      if (record && this.#usable(record)) {
        return this.#adopt(mapDefinitionId, record, hidden, true);
      }
      const inflight = this.pending.get(key);
      if (inflight) {
        await inflight;
        const warm = await this.store.get(key);
        if (warm) return this.#adopt(mapDefinitionId, warm, hidden, true);
      }
    }

    const job = (async () => {
      const payload = await this.#get(`/map-definitions/${mapDefinitionId}/layers`);
      const layers = Array.isArray(payload?.layers) ? payload.layers : [];
      const stamps = layers.map((l) => l.cachedAt).filter(Boolean).sort();
      const expiries = layers.map((l) => l.expiresAt).filter(Boolean).sort();
      const record = {
        key,
        version: RECORD_VERSION,
        mapDefinitionId: String(mapDefinitionId),
        // Newest stamp across layers: a record is only as fresh as its freshest
        // layer, and any refresh of any layer must invalidate the whole record.
        cachedAt: stamps.length ? stamps[stamps.length - 1] : null,
        // Oldest expiry: the record dies with its first layer, not its last.
        expiresAt: expiries.length ? expiries[0] : null,
        rulesetId: payload?.rulesetId ?? null,
        fetchedAt: this.now(),
        payload,
      };
      record.identity = cacheIdentity(record);
      await this.store.put(key, record);
      return record;
    })();

    this.pending.set(key, job);
    let record;
    try { record = await job; } finally { this.pending.delete(key); }
    return this.#adopt(mapDefinitionId, record, hidden, false);
  }

  /** Fresh enough to serve without touching the network? */
  #usable(record) {
    if (record.version !== RECORD_VERSION || !record.payload) return false;
    if (!record.expiresAt) return true; // No TTL announced -> the fetch stands.
    const expires = Date.parse(record.expiresAt);
    return !Number.isFinite(expires) || this.now() < expires;
  }

  async #get(path) {
    if (!this.fetchImpl) {
      throw new Error('AudiomWorldAdapter: no fetch available — pass `fetchImpl`.');
    }
    const url = new URL(this.baseUrl + path);
    const headers = { accept: 'application/json' };
    // Both work (verified against staging: 200 either way). The header is the
    // default because a key in a query string ends up in access logs, referrers
    // and browser history; `audiom.js` uses `?apiKey=` only because an iframe src
    // has nowhere else to put it.
    if (this.apiKey) {
      if (this.authMode === 'header' || this.authMode === 'both') headers['x-api-key'] = this.apiKey;
      if (this.authMode === 'query' || this.authMode === 'both') url.searchParams.set('apiKey', this.apiKey);
    }

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller && this.timeoutMs
      ? setTimeout(() => controller.abort(), this.timeoutMs)
      : null;
    let res;
    try {
      res = await this.fetchImpl(url.toString(), { headers, signal: controller?.signal });
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!res?.ok) {
      // 403 here is almost certainly `enforceAllowedOriginForRecord` (§7.1): a
      // public or unlisted definition carrying a non-empty `allowedOrigins` that
      // our hostname is not in. It is a data change on the row, not a code fix.
      const hint = res?.status === 403
        ? ' — check the definition\'s allowedOrigins (§7.1); localhost must be listed literally'
        : '';
      throw new Error(`AudiomWorldAdapter: GET ${path} -> ${res?.status ?? 'no response'}${hint}`);
    }
    return res.json();
  }

  /** Adopt a cached or freshly fetched record as this adapter's world. */
  #adopt(mapDefinitionId, record, includeHidden, fromCache) {
    const payload = record.payload;
    // Cleared before #flatten, not after — #flatten and #frameOf both record
    // notes, and resetting afterwards would silently eat them.
    this.notes = [];
    const layers = this.#flatten(payload, includeHidden);

    this.definition = {
      id: payload?.id ?? mapDefinitionId,
      slug: payload?.slug,
      title: payload?.title || payload?.name || String(mapDefinitionId),
      center: payload?.center,
      zoom: payload?.zoom,
      globalParams: payload?.globalParams,
      organizationId: payload?.organizationId,
    };
    // §7.1 warns against trusting `total` on these endpoints; `warnings` is a
    // different field and is the one the plan asserts on. Passed through verbatim.
    this.warnings = Array.isArray(payload?.warnings) ? payload.warnings : [];
    this.worldId = this.worldId || `audiom:${mapDefinitionId}`;
    this.cacheIdentity = record.identity || cacheIdentity(record);
    this.frame = this.#frameOf(layers);

    this.places = [];
    this._index = [];
    for (const layer of layers) this.#ingest(layer, record.cachedAt);
    if (!this.explicitBbox) this.bbox = this.#deriveBbox();

    return {
      mapDefinitionId: String(mapDefinitionId),
      title: this.definition.title,
      frame: this.frame,
      layers: layers.length,
      places: this.places.length,
      warnings: this.warnings,
      notes: this.notes,
      fromCache,
      cacheIdentity: this.cacheIdentity,
      bbox: this.bbox,
    };
  }

  /**
   * Layer list, hidden layers dropped.
   *
   * `visible: false` is dropped by default. On 885 those four layers are "A2: Map
   * Overview", "C2: Author Responsibility", "C3: Map Sources" and "A6: Glacial
   * Lobes" — 33 of 3004 features, and the first three are cartographic apparatus
   * rather than places on the map. A user's finger cannot land on a layer Audiom
   * does not draw, so resolving a name to one would answer about something that
   * is not there. `includeHidden: true` keeps them for callers that want the
   * credits (A6 is a real geographic layer and is the reason this is an option
   * and not a hard rule).
   */
  #flatten(payload, includeHidden) {
    const all = Array.isArray(payload?.layers) ? payload.layers : [];
    const kept = includeHidden ? all : all.filter((l) => l?.visible !== false);
    const dropped = all.length - kept.length;
    if (dropped > 0) this.notes.push(`${dropped} hidden layer(s) skipped (visible: false)`);
    return kept;
  }

  /**
   * One frame for the whole adapter — `worldAdapter.js` is explicit that frames are
   * "never mixed within one adapter". If layers disagree, the majority wins and
   * the disagreement is recorded, because silently narrating ENU metres as compass
   * bearings is the exact bug the frame concept exists to prevent.
   */
  #frameOf(layers) {
    const votes = new Map();
    for (const l of layers) {
      const raw = String(l?.coordinateSystem ?? '').trim().toLowerCase();
      const frame = COORDINATE_SYSTEM_FRAMES[raw];
      if (!frame) {
        // metadata.crs.epsg 4326 is the strongest signal available when the
        // vocabulary is unfamiliar; anything else stays geographic + a note.
        const epsg = l?.source?.metadata?.crs?.epsg;
        this.notes.push(`unknown coordinateSystem ${JSON.stringify(l?.coordinateSystem)} on layer ${JSON.stringify(l?.name)}; assuming geographic${epsg ? ` (crs epsg ${epsg})` : ''}`);
      }
      const chosen = frame || FRAMES.GEOGRAPHIC;
      votes.set(chosen, (votes.get(chosen) || 0) + 1);
    }
    if (votes.size > 1) {
      this.notes.push(`layers disagree on frame (${[...votes].map(([f, n]) => `${f}:${n}`).join(', ')}); using the majority`);
    }
    let best = FRAMES.GEOGRAPHIC;
    let bestN = -1;
    for (const [frame, n] of votes) if (n > bestN) { best = frame; bestN = n; }
    return best;
  }

  /**
   * Turn one layer's FeatureCollection into `Place` records.
   *
   * ⚠️ `layer.source` **is** the FeatureCollection (`{ type, features, metadata }`),
   * not a wrapper around one. The plan's sketch reads as though `source` were a
   * source descriptor; verified against 885, it is the resolved data itself.
   */
  #ingest(layer, cachedAt) {
    const features = Array.isArray(layer?.source?.features) ? layer.source.features : [];
    const sourceName = layer?.source?.features?.[0]?.properties?.sourceName || layer?.name || 'layer';
    let unnamed = 0;

    features.forEach((feature, i) => {
      const props = feature?.properties || {};
      const name = firstString(props, NAME_KEYS) || firstString(props, ALIAS_KEYS);
      if (!name) { unnamed += 1; return; }

      // Place ids: `sourceName#nativeId`.
      //
      // Feature `id` is unique WITHIN a layer but not across layers — 885 has an
      // `id: 1` in "A4: Direction Points" and another in every other layer — so the
      // layer's stamped `sourceName` is a required part of the key, not decoration.
      // Falling back to the array index keeps ids stable for layers whose features
      // carry no id, at the cost of stability across a re-fetch that reorders them;
      // 885 stamps ids on 3004 of 3004 features, so that path is a safety net.
      const nativeId = feature?.id ?? props.OBJECTID ?? props.id ?? `idx:${i}`;
      const category = CATEGORY_KEYS
        .map((k) => (typeof props[k] === 'string' ? props[k].trim() : ''))
        .filter(Boolean);
      const aliases = ALIAS_KEYS
        .map((k) => (typeof props[k] === 'string' ? props[k].trim() : ''))
        .filter((v) => v && norm(v) !== norm(name));

      const place = {
        id: `${sourceName}#${nativeId}`,
        name,
        aliases: [...new Set(aliases)],
        category: [...new Set(category)].join(', '),
        geometry: feature?.geometry || null,
        // Post-ruleset properties, as they arrived — `sourceName`, `ruleName`,
        // `ruleType`, `briefing` and every source attribute. §2.1: this object is
        // what feeds `placeIndex.placeDocument()`, so nothing is filtered here.
        // Kept by reference: 3004 shallow copies buy nothing, and the record is a
        // cache entry nobody mutates.
        props,
        provenance: {
          source: 'audiom:layers',
          id: String(nativeId),
          sourceName,
          layer: layer?.name,
          mapDefinitionId: this.definition?.id,
          cachedAt,
          fetchedAt: cachedAt ? Date.parse(cachedAt) || undefined : undefined,
        },
      };

      this.places.push(place);
      this._index.push(this.#derive(place));
    });

    if (unnamed) this.notes.push(`${unnamed} unnamed feature(s) skipped in ${sourceName}`);
  }

  /** Precomputed geometry, so `at()` and `nearby()` do not re-walk 3004 features. */
  #derive(place) {
    const pts = [...positions(place.geometry)];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let sx = 0, sy = 0;
    for (const [x, y] of pts) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      sx += x; sy += y;
    }
    const polygons = polygonsOf(place.geometry);
    return {
      place,
      points: pts,
      bbox: pts.length ? [minX, minY, maxX, maxY] : null,
      centroid: pts.length ? [sx / pts.length, sy / pts.length] : null,
      polygons,
      // Outer ring only: holes never enlarge a polygon, and this value is used
      // solely to prefer the tightest containing shape.
      area: polygons.reduce((sum, rings) => sum + (rings[0] ? ringArea(rings[0]) : 0), 0),
    };
  }

  /**
   * Full extent of everything loaded, when no window was supplied.
   *
   * ⚠️ `/map-definitions/885` does carry an `extent`, but it is
   * `{ mode: 'hull', buffer: 360 }` — a *recipe* for computing one, not a bbox. So
   * the geometry is the only bbox actually on offer, which is also what the
   * tactile material depicts when it is printed from the whole map.
   */
  #deriveBbox() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const g of this._index) {
      if (!g.bbox) continue;
      if (g.bbox[0] < minX) minX = g.bbox[0];
      if (g.bbox[1] < minY) minY = g.bbox[1];
      if (g.bbox[2] > maxX) maxX = g.bbox[2];
      if (g.bbox[3] > maxY) maxY = g.bbox[3];
    }
    return Number.isFinite(minX) ? [minX, minY, maxX, maxY] : null;
  }

  /** Re-window without refetching. The place model is window-independent. */
  setWindow(bbox) {
    this.bbox = bbox ? [...bbox] : this.#deriveBbox();
    this.explicitBbox = Boolean(bbox);
    return this.bbox;
  }

  /* ---------------------------------------------------------- frame mapping -- */

  /**
   * `(u, v)` -> frame coordinates. u=0 left, u=1 right; **v=0 top**, v=1 bottom.
   *
   * Geographic interpolates longitude linearly and latitude in Web-Mercator Y,
   * because that is what Audiom renders and therefore what a print of it depicts.
   * ENU interpolates both linearly. These are `audiom.js`'s `uvToLngLat` and
   * `uvToEastNorth` respectively, and must stay numerically identical to them —
   * a tactile material calibrated against one and queried through the other would
   * be wrong by the Mercator error, which is metres at city scale and kilometres
   * at 885's.
   */
  #uvToXY(u, v) {
    if (!this.bbox) throw new Error('AudiomWorldAdapter: no window — call loadMapDefinition() or setWindow() first.');
    const [minX, minY, maxX, maxY] = this.bbox;
    const x = minX + u * (maxX - minX);
    if (this.frame !== FRAMES.GEOGRAPHIC) return [x, maxY - v * (maxY - minY)];
    const yTop = mercY(maxY);
    const yBot = mercY(minY);
    return [x, invMercY(yTop + v * (yBot - yTop))];
  }

  /** Inverse of `#uvToXY`. Not clamped: off-window points report u/v outside 0..1. */
  #xyToUV(x, y) {
    const [minX, minY, maxX, maxY] = this.bbox;
    const u = maxX === minX ? 0 : (x - minX) / (maxX - minX);
    if (this.frame !== FRAMES.GEOGRAPHIC) {
      return [u, maxY === minY ? 0 : (maxY - y) / (maxY - minY)];
    }
    const yTop = mercY(maxY);
    const yBot = mercY(minY);
    return [u, yBot === yTop ? 0 : (mercY(y) - yTop) / (yBot - yTop)];
  }

  /**
   * Distance in frame units — metres in both frames.
   *
   * Geographic uses the flat degrees-to-metres approximation `audiom.js` already
   * uses for `bboxSpanMeters`, which is accurate to well under a percent over a
   * window and is being compared against a fingertip.
   */
  #dist(ax, ay, bx, by) {
    if (this.frame !== FRAMES.GEOGRAPHIC) return Math.hypot(bx - ax, by - ay);
    const midLat = ((ay + by) / 2) * DEG;
    return Math.hypot((bx - ax) * M_PER_DEG * Math.cos(midLat), (by - ay) * M_PER_DEG);
  }

  /** Window diagonal in frame units; the scale every default radius is a fraction of. */
  windowDiagonal() {
    if (!this.bbox) return 0;
    const [minX, minY, maxX, maxY] = this.bbox;
    return this.#dist(minX, minY, maxX, maxY);
  }

  /**
   * Lower bound on the distance from (x,y) to a place, from its bbox alone.
   *
   * A lower bound is all a reject test needs, and this one is O(1) against a
   * geometry that can carry hundreds of vertices. On map 885 it takes `nearby()`
   * from ~106 ms to a few ms per call, which is the difference between a voice
   * turn feeling immediate and feeling laggy.
   */
  #bboxDistance(g, x, y) {
    const [minX, minY, maxX, maxY] = g.bbox;
    const dx = Math.max(minX - x, 0, x - maxX);
    const dy = Math.max(minY - y, 0, y - maxY);
    if (dx === 0 && dy === 0) return 0;
    return this.#dist(x, y, x + dx, y + dy);
  }

  /** Shortest distance from (x,y) to a place's geometry — 0 if inside a polygon. */
  #distanceTo(g, x, y) {
    if (g.polygons.some((rings) => pointInPolygon(x, y, rings))) return 0;
    let best = Infinity;
    // Vertex distance, not segment distance: at map scale the vertices of these
    // features are far denser than the tolerance being tested against, and the
    // exact-segment version costs a projection per edge over 3004 features.
    for (const [px, py] of g.points) {
      const d = this.#dist(x, y, px, py);
      if (d < best) best = d;
    }
    return best;
  }

  /* -------------------------------------------------------------- resolution -- */

  /**
   * Name lookup, exact -> case-insensitive (name or alias) -> substring.
   *
   * Not the semantic retrieval of §4.2 — `PlaceIndex` does that. This is the
   * adapter's authority on what exists, and the source `PlaceIndex` indexes.
   *
   * Ambiguity is the normal outcome here, not the edge case: 885's 2971 visible
   * features share only 314 distinct names, and one of them ("ice flow direction
   * indicated by drumlins…") is worn by 373 features. A map unit is genuinely a
   * repeated class rather than a unique landmark, so `Ambiguous` with the first
   * few candidates is the honest answer and L3 asks or picks. Exactness still
   * wins: a tier is only consulted when the one above it found nothing.
   *
   * @param {string} text
   * @returns {import('../worldAdapter.js').Place|import('../worldAdapter.js').Ambiguous|null}
   */
  resolvePlace(text) {
    const raw = String(text ?? '').trim();
    if (!raw) return null;
    const q = norm(raw);

    const exact = this.places.filter((p) => p.name === raw);
    const ci = exact.length ? [] : this.places.filter((p) => norm(p.name) === q);
    const alias = exact.length || ci.length
      ? []
      : this.places.filter((p) => (p.aliases || []).some((a) => norm(a) === q));
    let hits = exact.length ? exact : ci.length ? ci : alias;

    if (!hits.length) {
      hits = this.places.filter((p) => {
        const n = norm(p.name);
        return n.includes(q) || q.includes(n) || (p.aliases || []).some((a) => norm(a).includes(q));
      });
      // Closest-length first: "meltwater" should surface "Meltwater-stream
      // sediment" ahead of a sentence that happens to contain the word.
      hits = [...hits].sort((a, b) => Math.abs(a.name.length - raw.length) - Math.abs(b.name.length - raw.length));
    }

    if (!hits.length) return null;
    if (hits.length === 1) return hits[0];
    return ambiguous(hits.slice(0, MAX_AMBIGUOUS), raw);
  }

  /**
   * What is under (u,v).
   *
   * Containment first, smallest area wins — a county polygon covers every map unit
   * inside it, and "you are in Wisconsin" is not the answer to a finger on a
   * moraine. Only if nothing contains the point does it fall back to the nearest
   * feature within `toleranceFraction` of the window diagonal, which is what makes
   * a point or a line answerable at all.
   *
   * @param {number} u @param {number} v
   * @param {{tolerance?: number}} [opts] `tolerance` in frame units.
   * @returns {import('../worldAdapter.js').AtResult}
   */
  at(u, v, { tolerance } = {}) {
    if (!this.places.length || !this.bbox) return {};
    const [x, y] = this.#uvToXY(u, v);

    let containing = null;
    for (const g of this._index) {
      if (!g.polygons.length || !g.bbox) continue;
      if (x < g.bbox[0] || x > g.bbox[2] || y < g.bbox[1] || y > g.bbox[3]) continue;
      if (!g.polygons.some((rings) => pointInPolygon(x, y, rings))) continue;
      if (!containing || g.area < containing.area) containing = g;
    }
    if (containing) return { place: containing.place };

    const limit = Number.isFinite(tolerance)
      ? tolerance
      : this.windowDiagonal() * this.toleranceFraction;
    let best = null;
    let bestD = Infinity;
    for (const g of this._index) {
      if (!g.points.length || !g.bbox) continue;
      // Two rejects before the vertex walk: outside the tolerance entirely, or
      // provably farther than the best candidate so far.
      const lower = this.#bboxDistance(g, x, y);
      if (lower > limit || lower >= bestD) continue;
      const d = this.#distanceTo(g, x, y);
      if (d < bestD) { bestD = d; best = g; }
    }
    return best && bestD <= limit ? { place: best.place } : {};
  }

  /**
   * Named places near (u,v), nearest first.
   *
   * Returns shallow copies carrying `distance` in frame units (metres). `at()`
   * hands back the canonical object; `nearby()` is a ranking, and the rank is
   * only interpretable with the distance attached.
   *
   * @param {number} u @param {number} v
   * @param {number} [radius] Frame units. Defaults to `radiusFraction` of the diagonal.
   * @param {{limit?: number}} [opts]
   */
  nearby(u, v, radius, { limit = 10 } = {}) {
    if (!this.places.length || !this.bbox) return [];
    const [x, y] = this.#uvToXY(u, v);
    const r = Number.isFinite(radius) && radius > 0
      ? radius
      : this.windowDiagonal() * this.radiusFraction;

    const hits = [];
    for (const g of this._index) {
      if (!g.points.length || !g.bbox) continue;
      if (this.#bboxDistance(g, x, y) > r) continue;
      const d = this.#distanceTo(g, x, y);
      if (d <= r) hits.push({ ...g.place, distance: d });
    }
    hits.sort((a, b) => a.distance - b.distance);
    return hits.slice(0, limit);
  }

  /** Frame coordinates -> `{u, v}` in the current window. Exposed for the dispatcher. */
  toUV(x, y) {
    if (!this.bbox) return null;
    const [u, v] = this.#xyToUV(x, y);
    return { u, v };
  }

  /** `{u,v}` -> frame coordinates, e.g. to feed `moveAvatar` (§2.2). */
  toFrame(u, v) {
    const [x, y] = this.#uvToXY(u, v);
    return this.frame === FRAMES.GEOGRAPHIC ? { lng: x, lat: y } : { e: x, n: y };
  }

  /* ------------------------------------------------------------ not yet ours -- */

  /**
   * The base class would already return `Unsupported` here, since `routing` is not
   * declared. Overridden only to name the milestone and the alternative: on this
   * route `route_to` is not "compute a path and speak it" but "drive Audiom's own
   * avatar and let Audiom's audio do the work" (§2.2).
   */
  route(_from, _to, _prefs) {
    return unsupported(
      'Routing on this map arrives with the logic graph (M12b). Audiom can still walk you there with its own avatar.',
      CAPABILITIES.ROUTING,
    );
  }

  /**
   * Kerbs, inclines and surfaces are a property of a pedestrian graph, and this
   * world has features rather than edges until M12b builds one. The raw source
   * attributes are not silently substituted: `props` may well hold a `surface`
   * key, but answering "is it steep" from an unvalidated source column is exactly
   * the kind of confident wrongness the capability system exists to prevent.
   */
  attributes(_segmentOrNode) {
    return unsupported(
      'This map has no pedestrian graph yet, so kerb, incline and surface are not available (M12b).',
      CAPABILITIES.ACCESSIBILITY_ATTRS,
    );
  }
}

export default AudiomWorldAdapter;
