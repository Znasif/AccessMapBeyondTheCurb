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
 * M12b adds the second half: `buildLogicGraph()` turns the loaded geometry into
 * the node/edge network `lib/logic/graph.js` was ported to route over, and
 * `route()` answers through the `WorldAdapter` interface so tools are written
 * once. See `buildLogicGraph` for what the projection is and what it costs.
 *
 * ✅ `../../audiom.js` IS imported now — the §5.1 debt is discharged. It used to
 * dereference `import.meta.env` at module scope, so nothing outside Vite could
 * load it and the two coordinate helpers it owns (`uvToLngLat`,
 * `uvToEastNorth`) had to be re-derived here. The env read moved inside a
 * function; the copies are gone; `scripts/test_audiom_adapter.mjs` pins the
 * numbers. Only the pure Mercator half is used — nothing here calls
 * `buildEmbedSrc` or `parseAudiomView`, which still touch `window` when invoked.
 */

import { uvToLngLat, uvToEastNorth, mercY } from '../../audiom.js';
import { A4_LANDSCAPE_ARTWORK } from '../surface.js';
import { Coords } from '../logic/coords.js';
import { Edge as LogicEdge } from '../logic/edge.js';
import { Node as LogicNode } from '../logic/node.js';
import { Graph, RouteAction } from '../logic/graph.js';
import { buildGraphDict, DEFAULT_MAX_NODES } from '../geojsonGraph.js';
import { bearingBetweenPoints, bearingFromDelta } from '../direction.js';
import {
  WorldAdapter,
  CAPABILITIES,
  FRAMES,
  ambiguous,
  isAmbiguous,
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

/**
 * Comfortable walking pace, m/s, for the `duration` of a geographic route.
 * 1.2 m/s is the low end of the usual 1.2–1.4 range and is the honest one to
 * quote to someone reading a route by finger.
 */
export const WALK_SPEED_MPS = 1.2;

/* --------------------------------------------------------------- coordinates -- */

const DEG = Math.PI / 180;
/** Metres per degree, the flat approximation `audiom.js:bboxSpanMeters` uses. */
const M_PER_DEG = 111320;
const MM_PER_INCH = 25.4;

/**
 * Width in inches of the material the ported graph's thresholds are expressed
 * in — `Graph.SNAP_MIN_DISTANCE` is 0.25 *inches of print*, not 0.25 of
 * anything on the ground. §2.2's printable A4 artwork area is the honest
 * default for a real print (`surface.js`, 270 × 190 mm).
 */
export const DEFAULT_MATERIAL_WIDTH_INCHES = A4_LANDSCAPE_ARTWORK.widthMm / MM_PER_INCH;

/* -------------------------------------------------------------------- storage -- */

/**
 * Interface-compatible with `placeIndex.js`'s `MemoryStore` / `IndexedDBStore`
 * (`get` / `put` / `delete` / `entries`, all async, records carry `key`), so the
 * browser wiring is a constructor argument rather than a rewrite.
 *
 * Redefined here rather than imported because `placeIndex.js` pulls in
 * `LocalLLMClient`, and this adapter must stay free of the LLM runtime. Its
 * `IndexedDBStore` is also pinned to the `abtc-place-index` database, which holds
 * embeddings — layer payloads want their own database (§5.1: 885's `/layers` is
 * 27 MB), which is what `IndexedDBLayerStore` below is.
 */
export class MemoryStore {
  constructor() { this.map = new Map(); }
  async get(key) { return this.map.get(key) || null; }
  async put(key, value) { this.map.set(key, { ...value, key }); }
  async delete(key) { this.map.delete(key); }
  async entries() { return [...this.map.entries()].map(([key, value]) => ({ key, value })); }
}

/** Its own database, per §5.1 — not a corner of `abtc-place-index`. */
export const LAYER_DB_NAME = 'abtc-audiom-layers';
export const LAYER_DB_VERSION = 1;
export const LAYER_STORE = 'layers';

/**
 * The browser half of the same interface.
 *
 * §8 is explicit that this is **required, not an optimisation**: `/layers` for
 * 885 measured 6.4 s cold and 11.0 s warm, and server-side caching does not
 * rescue it because the cost is shipping 27 MB off a dyno. Records are stored
 * as the parsed payload and go through structured clone, which handles a nested
 * FeatureCollection natively — `JSON.stringify` on 27 MB would be the slow path,
 * not the safe one.
 *
 * Never constructed outside a browser: `defaultLayerStore()` is the only caller
 * and it checks for `indexedDB` first, exactly as `placeIndex.js` does. That is
 * what keeps this module importable from Node.
 */
export class IndexedDBLayerStore {
  #dbPromise = null;

  #db() {
    if (!this.#dbPromise) {
      this.#dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(LAYER_DB_NAME, LAYER_DB_VERSION);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(LAYER_STORE)) {
            req.result.createObjectStore(LAYER_STORE, { keyPath: 'key' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return this.#dbPromise;
  }

  async #tx(mode, fn) {
    const db = await this.#db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(LAYER_STORE, mode);
      const req = fn(tx.objectStore(LAYER_STORE));
      tx.onerror = () => reject(tx.error);
      if (req) req.onsuccess = () => resolve(req.result);
      else tx.oncomplete = () => resolve();
    });
  }

  async get(key) { return (await this.#tx('readonly', (s) => s.get(key))) || null; }
  async put(key, value) { return this.#tx('readwrite', (s) => s.put({ ...value, key })); }
  async delete(key) { return this.#tx('readwrite', (s) => s.delete(key)); }
  async entries() {
    const all = (await this.#tx('readonly', (s) => s.getAll())) || [];
    return all.map((value) => ({ key: value.key, value }));
  }
}

/** IndexedDB where there is one, memory where there is not (Node, tests). */
export function defaultLayerStore() {
  return typeof indexedDB !== 'undefined' ? new IndexedDBLayerStore() : new MemoryStore();
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
   * @param {object} [opts.store]          get/put/delete/entries; defaults to
   *   IndexedDB in a browser and memory everywhere else.
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
    store = defaultLayerStore(),
    bbox,
    includeHidden = false,
    timeoutMs = 15000,
    toleranceFraction = 0.02,
    radiusFraction = 0.1,
    now = () => Date.now(),
    worldId,
    graphOptions = {},
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

    /** Defaults for `buildLogicGraph()`; see there for what each one costs. */
    this.graphOptions = { ...graphOptions };
    /** @type {Graph|null} The ported network, once M12b has built one. */
    this.logicGraph = null;
    /** @type {object|null} Projection + scale the graph was built in. */
    this.plane = null;
    /** @type {{stats: object, notes: string[]}|null} */
    this.graphInfo = null;
    /** POI index -> Place id, so a route can name what it passes. */
    this._placeIdByPoi = [];
    /** Where `Graph`'s route callback deposits its result, synchronously. */
    this._routeSink = [];
  }

  /* ------------------------------------------------------- M12b · the graph -- */

  /**
   * Build the routing network from the geometry already loaded, and declare
   * `graph` + `routing` if — and only if — one came out.
   *
   * **The projection.** `lib/logic/*` is a plane-geometry engine: `Coords` does
   * Pythagoras, `Edge` is a straight line, and `graph.js` defines north as the
   * versor `(0, -1)`, i.e. **y grows downward**. So lng/lat cannot be fed to it
   * directly — a degree of longitude is not a degree of latitude, and latitude
   * increasing northward would mirror every spoken direction. The plane is
   * therefore local metres about the window: x east from `minLng`, y **south**
   * from `maxLat`, with the same flat `M_PER_DEG · cos(lat)` approximation
   * `#dist` already uses, taken at the window's centre latitude rather than
   * per-pair. Over a window that is a sub-percent error and it is being compared
   * against a fingertip. An `enu` world is already metric and only needs the y
   * flip.
   *
   * **The scale knob.** `Graph` expresses its thresholds in *inches of printed
   * material* and multiplies them by `feetsPerInch` to reach map units —
   * `SNAP_MIN_DISTANCE` is a 0.25-inch fingertip, `AM_I_THRESHOLD` 0.75 inches.
   * The name is the Python's; the quantity is "map units per print inch". Map
   * units here are metres, so it is metres-per-inch, derived from the window
   * width and the material width. Everything downstream stays coherent:
   * `getDistance` returns metres snapped to 10, `NEARBY_THRESHOLD` is 700 m, and
   * `WayPoint.distance` comes out in print inches to one decimal.
   *
   * **The cost.** `new Graph()` runs Floyd–Warshall once, O(V³). That is the
   * whole point — every later route is a matrix walk — but it is also why
   * `maxNodes` exists and why this is a separate call rather than a side effect
   * of `loadMapDefinition()`: 27 MB of layers is a "preparing map" step already
   * (§8), and whether a map is worth precomputing is the caller's decision.
   *
   * @param {object} [options]
   * @param {number} [options.snapTolerance] Two vertices this close are one
   *   junction, **in plane units** — metres in a geographic world. Defaults to a
   *   thousandth of the window width, capped at 1 m: 1 m is the quantum of the
   *   5-decimal-place truncation layerloader applies (§0.3), so nothing finer is
   *   signal, but a cap alone is wrong for an `enu` diagram whose whole extent
   *   may be a couple of units across — a fixed metre would weld it into one
   *   node and report "no linear features".
   * @param {number} [options.maxNodes=DEFAULT_MAX_NODES]
   * @param {number} [options.maxPois]
   * @param {boolean} [options.includePolygonBoundaries=false]
   * @param {number} [options.materialWidthInches]
   * @param {number} [options.unitsPerInch] Overrides the derivation entirely.
   * @returns {{ok: boolean, reason?: string, stats: object, notes: string[]}}
   */
  buildLogicGraph(options = {}) {
    const opts = { ...this.graphOptions, ...options };
    const {
      snapTolerance,
      maxNodes = DEFAULT_MAX_NODES,
      maxPois,
      includePolygonBoundaries = false,
      materialWidthInches = DEFAULT_MATERIAL_WIDTH_INCHES,
      unitsPerInch,
    } = opts;

    this.#detachLogicGraph();

    if (!this.places.length || !this.bbox) {
      return {
        ok: false,
        reason: 'Nothing is loaded yet — call loadMapDefinition() before building the graph.',
        stats: {},
        notes: [],
      };
    }

    const plane = this.#buildPlane(materialWidthInches, unitsPerInch);
    const snap = Number.isFinite(snapTolerance) && snapTolerance >= 0
      ? snapTolerance
      : Math.min(1, plane.widthUnits / 1000);
    const built = buildGraphDict(this.places, plane.toPlane, {
      snapTolerance: snap,
      maxNodes,
      ...(maxPois === undefined ? {} : { maxPois }),
      includePolygonBoundaries,
    });

    for (const note of built.notes) this.notes.push(`graph: ${note}`);
    if (!built.ok) {
      this.graphInfo = { stats: built.stats, notes: built.notes, reason: built.reason };
      return { ok: false, reason: built.reason, stats: built.stats, notes: built.notes };
    }

    const graph = new Graph(built.graphDict, {
      feetsPerInch: plane.unitsPerInch,
      // The adapter's own `resolvePlace` is the gate on what the model may talk
      // about, so `enablePois` is not also one: `llmEnabled: false` starts every
      // POI enabled, which is what `getNearbyPois`/`getNearestPoi` need to be
      // answerable at all.
      llmEnabled: false,
      onRoute: (action, start, streetByStreet, waypoints) =>
        this._routeSink.push({ action, start, streetByStreet, waypoints }),
    });

    this.attachLogicGraph(graph, { plane, placeIdByPoi: built.placeIdByPoi, stats: built.stats, notes: built.notes });
    return { ok: true, stats: built.stats, notes: built.notes };
  }

  /**
   * Adopt an already-built `Graph` and declare the capabilities it earns.
   *
   * `buildLogicGraph()` is the normal way in; this stays public because a caller
   * that already has a camio-model `Graph` for the same window (the parity
   * benchmark, a hand-authored network) should not have to go through GeoJSON to
   * use it. Declaring `graph`/`routing` any earlier than here would offer the
   * model a tool that cannot run — the failure mode `worldAdapter.js` names.
   *
   * @param {Graph} graph
   * @param {object} [meta]
   * @param {object} [meta.plane] Projection; required unless one is already set.
   * @param {string[]} [meta.placeIdByPoi]
   */
  attachLogicGraph(graph, meta = {}) {
    if (!(graph instanceof Graph)) {
      throw new Error('AudiomWorldAdapter.attachLogicGraph: expects a Graph from lib/logic/graph.js — build one with buildLogicGraph().');
    }
    const plane = meta.plane || this.plane;
    if (!plane) {
      throw new Error('AudiomWorldAdapter.attachLogicGraph: a graph needs the projection it was built in; pass meta.plane.');
    }

    this.logicGraph = graph;
    this.plane = plane;
    this._placeIdByPoi = meta.placeIdByPoi || [];
    this.graphInfo = { stats: meta.stats || {}, notes: meta.notes || [] };
    this.capabilities.add(CAPABILITIES.GRAPH);
    this.capabilities.add(CAPABILITIES.ROUTING);
    return this.graphInfo;
  }

  /** Drop the graph and the capabilities it earned. Idempotent. */
  #detachLogicGraph() {
    this.logicGraph = null;
    this.plane = null;
    this.graphInfo = null;
    this._placeIdByPoi = [];
    this._routeSink.length = 0;
    this.capabilities.delete(CAPABILITIES.GRAPH);
    this.capabilities.delete(CAPABILITIES.ROUTING);
  }

  /**
   * The window's local metric plane, plus the scale `Graph` measures print
   * inches in. See `buildLogicGraph` for why both exist.
   */
  #buildPlane(materialWidthInches, unitsPerInchOverride) {
    const [minX, minY, maxX, maxY] = this.bbox;
    const geographic = this.frame === FRAMES.GEOGRAPHIC;
    const kx = geographic ? M_PER_DEG * Math.cos(((minY + maxY) / 2) * DEG) : 1;
    const ky = geographic ? M_PER_DEG : 1;

    const widthUnits = Math.abs(maxX - minX) * kx;
    const inches = Number.isFinite(materialWidthInches) && materialWidthInches > 0
      ? materialWidthInches
      : DEFAULT_MATERIAL_WIDTH_INCHES;

    return {
      frame: this.frame,
      bbox: [minX, minY, maxX, maxY],
      kx,
      ky,
      widthUnits,
      // Never zero: a degenerate window would make every threshold zero and
      // `snapToGraph` would stop snapping at all.
      unitsPerInch:
        Number.isFinite(unitsPerInchOverride) && unitsPerInchOverride > 0
          ? unitsPerInchOverride
          : Math.max(widthUnits / inches, Number.MIN_VALUE),
      materialWidthInches: inches,
      /** Frame coords -> plane metres, y **down**. */
      toPlane: (x, y) => [(x - minX) * kx, (maxY - y) * ky],
      /** Plane metres -> frame coords. */
      fromPlane: (px, py) => [minX + px / kx, maxY - py / ky],
    };
  }

  /* ------------------------------------------------------------------ seams -- */

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
    // A graph is a projection of one window over one set of places. Both just
    // changed, so anything attached is stale — and a stale graph would keep
    // `routing` declared while routing the previous map.
    this.#detachLogicGraph();

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

  /**
   * Re-window without refetching. The place model is window-independent; the
   * logic graph is not — it is built in a plane anchored to the window's corner
   * — so it is dropped and must be rebuilt if routing is still wanted.
   */
  setWindow(bbox) {
    this.bbox = bbox ? [...bbox] : this.#deriveBbox();
    this.explicitBbox = Boolean(bbox);
    this.#detachLogicGraph();
    return this.bbox;
  }

  /* ---------------------------------------------------------- frame mapping -- */

  /**
   * `(u, v)` -> frame coordinates. u=0 left, u=1 right; **v=0 top**, v=1 bottom.
   *
   * Geographic interpolates longitude linearly and latitude in Web-Mercator Y,
   * because that is what Audiom renders and therefore what a print of it depicts.
   * ENU interpolates both linearly.
   *
   * These ARE `audiom.js`'s `uvToLngLat` and `uvToEastNorth` — imported, not
   * re-derived, which is the §5.1 debt discharged. It matters because a material
   * calibrated through one spelling and queried through another is wrong by the
   * Mercator error: metres at city scale, kilometres at 885's. The two copies
   * this replaces were *not* in fact bit-identical to the originals — they
   * spelled the degree conversion `lat * (π/180)` and `y / (π/180)` where
   * `audiom.js` writes `(lat * π) / 180` and `(y * 180) / π`, which disagree in
   * the last bit for about a quarter of all inputs. The disagreement was
   * ~4 × 10⁻¹⁴° (nanometres) on 885's window, so nothing was ever visibly wrong;
   * having one copy is how it stays that way.
   */
  #uvToXY(u, v) {
    if (!this.bbox) throw new Error('AudiomWorldAdapter: no window — call loadMapDefinition() or setWindow() first.');
    const [minX, minY, maxX, maxY] = this.bbox;
    if (this.frame !== FRAMES.GEOGRAPHIC) {
      const { e, n } = uvToEastNorth(u, v, { e0: minX, n0: minY, e1: maxX, n1: maxY });
      return [e, n];
    }
    const { lng, lat } = uvToLngLat(u, v, this.bbox);
    return [lng, lat];
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

  /**
   * `#distanceTo` plus the point that won, which is what a *direction* needs.
   *
   * Kept separate rather than folded into `#distanceTo` because that one runs
   * over 3,004 features per `nearby()` call and must not allocate a tuple per
   * feature; this one runs against a single already-resolved target.
   *
   * @returns {{distance: number, point: number[]|null, inside: boolean}}
   */
  #nearestPointOn(g, x, y) {
    if (g.polygons.some((rings) => pointInPolygon(x, y, rings))) {
      return { distance: 0, point: [x, y], inside: true };
    }
    let best = Infinity;
    let winner = null;
    for (const p of g.points) {
      const d = this.#dist(x, y, p[0], p[1]);
      if (d < best) { best = d; winner = p; }
    }
    return { distance: Number.isFinite(best) ? best : Infinity, point: winner, inside: false };
  }

  /** The `_index` entry for a Place, or null. */
  #indexOf(place) {
    return this._index.find((g) => g.place === place || g.place?.id === place?.id) || null;
  }

  /**
   * Resolve a `distanceTo` / `bearingTo` target to `{g, place}`.
   * @returns {{g: object, place: object}|import('../worldAdapter.js').Ambiguous|null}
   */
  #target(target) {
    if (!target) return null;
    if (typeof target === 'string') {
      const hit = this.resolvePlace(target);
      if (hit === null) return null;
      if (isAmbiguous(hit)) return hit;
      return this.#target(hit);
    }
    const g = this.#indexOf(target);
    if (!g || !g.points?.length) return null;
    return { g, place: g.place };
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
   * **`segment` / `node` (M7).** M12b built the topology and left this seam
   * open: once a graph is attached, the same point is snapped onto it and the
   * winning `Edge` / `Node` is reported alongside the place. `snapToGraph` is
   * used **unforced**, so nothing is reported unless the finger is genuinely
   * within `SNAP_MIN_DISTANCE` (a 0.25-inch fingertip, scaled to map units) —
   * forcing it would attach a segment to every touch anywhere on the sheet.
   *
   * The cost is `getNearestNode` + `getNearestEdge`, both O(network), so it is
   * gated on a graph existing and can be turned off per call. That is fine for
   * the dispatcher, which calls `at()` once per turn against a frozen context,
   * and would not be fine on a per-frame path.
   *
   * `node.position` / `segment` positions are frame-native (`{lng, lat}` or
   * `{e, n}`). No `u`/`v` leaves this method: `(u, v)` is a perception artifact
   * and is converted once, here, exactly as `route()` does.
   *
   * @param {number} u @param {number} v
   * @param {{tolerance?: number, includeGraph?: boolean}} [opts] `tolerance` in frame units.
   * @returns {import('../worldAdapter.js').AtResult}
   */
  at(u, v, { tolerance, includeGraph = true } = {}) {
    if (!this.places.length || !this.bbox) return {};
    const [x, y] = this.#uvToXY(u, v);
    const graphPart = includeGraph ? this.#graphAt(x, y) : {};

    let containing = null;
    for (const g of this._index) {
      if (!g.polygons.length || !g.bbox) continue;
      if (x < g.bbox[0] || x > g.bbox[2] || y < g.bbox[1] || y > g.bbox[3]) continue;
      if (!g.polygons.some((rings) => pointInPolygon(x, y, rings))) continue;
      if (!containing || g.area < containing.area) containing = g;
    }
    if (containing) return { place: containing.place, ...graphPart };

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
    const place = best && bestD <= limit ? { place: best.place } : {};
    return { ...place, ...graphPart };
  }

  /**
   * The `segment` / `node` half of `at()`. Empty object when no graph is
   * attached or nothing is within snapping distance — never a partial guess.
   *
   * @param {number} x @param {number} y  Frame coordinates.
   * @returns {{segment?: object, node?: object}}
   */
  #graphAt(x, y) {
    if (!this.logicGraph || !this.plane) return {};
    const point = this.#planeOf(x, y);
    const [, snapped] = this.logicGraph.snapToGraph(point);
    if (snapped instanceof LogicNode) {
      return {
        node: {
          id: snapped.id,
          position: this.#frameOfPlane(snapped.coords),
          // `kind` stays undefined on purpose: `kerb` / `crossing` / `junction`
          // are accessibility claims and §8 forbids stating one this map cannot
          // support. The topology is real; the classification is not.
          description: snapped.getShortDescription(),
          provenance: { source: 'audiom:layers', id: `node:${snapped.id}` },
        },
      };
    }
    if (snapped instanceof LogicEdge) {
      return {
        segment: {
          id: `edge:${snapped.id}`,
          fromNode: snapped.node1?.id,
          toNode: snapped.node2?.id,
          street: snapped.street,
          // `getLlmDescription()`, NOT `getCompleteDescription()`. The latter
          // opens with `this.features[SURFACE]`, and `geojsonGraph.js`
          // deliberately supplies no `edges_features`, so every edge would
          // announce itself as "concrete" — `defaultEdgeFeatures`' placeholder
          // stated as fact. §8: never state flatly what has not been surveyed.
          // `getLlmDescription()` is pure topology and is always true.
          description: snapped.getLlmDescription(),
          provenance: { source: 'audiom:layers', id: `edge:${snapped.id}` },
        },
      };
    }
    return {};
  }

  /**
   * Named places near (u,v), nearest first.
   *
   * Returns shallow copies carrying `distance: {value, units}`. `at()` hands
   * back the canonical object; `nearby()` is a ranking, and the rank is only
   * interpretable with the distance attached.
   *
   * ⚠️ The `{value, units}` shape is deliberate and was **changed** in M7: this
   * adapter used to return a bare number while `camioWorldAdapter` returned
   * `{value, units: 'material_mm'}`. Two shapes across two adapters means every
   * consumer needs a per-adapter branch, which is precisely the world-specific
   * knowledge the `WorldAdapter` abstraction exists to eliminate — and the unit
   * riding in the result is §5.4's own rule.
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
      if (d <= r) hits.push({ ...g.place, distance: { value: d, units: 'metres' } });
    }
    hits.sort((a, b) => a.distance.value - b.distance.value);
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

  /**
   * The isotropic metric plane every bearing and heading is computed in: metres
   * east of the window's west edge, metres **south** of its north edge.
   *
   * Identical in construction to `#buildPlane`'s `toPlane`, and deliberately so
   * — but available without a graph, because directions are a `places`-tier
   * answer and must not wait on a Floyd–Warshall. The longitude axis carries the
   * `cos(midLat)` factor for the same reason `#dist` does: without it a bearing
   * at Wisconsin's latitude is wrong by ~28 % on its east-west component, which
   * is more than a whole 45° sector near the diagonals.
   *
   * @param {number} u @param {number} v
   * @returns {{x: number, y: number, units: string}}
   */
  metricPoint(u, v) {
    const [x, y] = this.#uvToXY(u, v);
    const [minX, , , maxY] = this.bbox;
    const geographic = this.frame === FRAMES.GEOGRAPHIC;
    const { kx, ky } = this.#metricScale();
    return {
      x: geographic ? (x - minX) * kx : x - minX,
      y: geographic ? (maxY - y) * ky : maxY - y,
      units: 'metres',
    };
  }

  /** Degrees→metres factors at the window's centre latitude. 1 in an `enu` world. */
  #metricScale() {
    if (this.frame !== FRAMES.GEOGRAPHIC) return { kx: 1, ky: 1 };
    const [, minY, , maxY] = this.bbox;
    return { kx: M_PER_DEG * Math.cos(((minY + maxY) / 2) * DEG), ky: M_PER_DEG };
  }

  /** @see WorldAdapter#bearingBetween — one implementation, in `direction.js`. */
  bearingBetween(u0, v0, u1, v1) {
    if (!this.bbox) return null;
    return bearingBetweenPoints(this, u0, v0, u1, v1);
  }

  /**
   * How close counts as "on or immediately beside". Reuses the very
   * `toleranceFraction` that `at()` snaps with, so `am_i_at` and `whats_here`
   * agree by construction rather than by coincidence.
   */
  touchTolerance() {
    return { value: this.windowDiagonal() * this.toleranceFraction, units: 'metres', frame: this.frame };
  }

  /**
   * Distance from `(u, v)` to a named target, in metres — this world's natural
   * unit in both frames.
   *
   * The bbox reject is not an optimisation here so much as the difference
   * between a voice turn feeling immediate and feeling laggy: without it the
   * vertex walk is O(3,004 features × vertices) and the adapter's own
   * measurement puts that at ~106 ms.
   *
   * @param {number} u @param {number} v @param {string|object} target
   */
  distanceTo(u, v, target) {
    if (!this.places.length || !this.bbox) return null;
    const resolved = this.#target(target);
    if (resolved === null) return null;
    if (isAmbiguous(resolved)) return resolved;

    const [x, y] = this.#uvToXY(u, v);
    const { distance, inside } = this.#nearestPointOn(resolved.g, x, y);
    if (!Number.isFinite(distance)) return null;
    return {
      value: distance,
      units: 'metres',
      frame: this.frame,
      method: inside ? 'inside' : 'nearest_vertex',
      place: resolved.place,
    };
  }

  /**
   * Direction from `(u, v)` to a named target.
   *
   * `direction: null` when the finger is already inside the target — there is no
   * honest direction to a place you are standing in, and inventing one ("head
   * north") would send a finger off the feature it just found.
   *
   * @param {number} u @param {number} v @param {string|object} target
   */
  bearingTo(u, v, target) {
    if (!this.places.length || !this.bbox) return null;
    const resolved = this.#target(target);
    if (resolved === null) return null;
    if (isAmbiguous(resolved)) return resolved;

    const [x, y] = this.#uvToXY(u, v);
    const { distance, point, inside } = this.#nearestPointOn(resolved.g, x, y);
    if (!point) return null;
    if (inside || distance === 0) {
      return {
        cardinal: null, direction: null, vocabulary: null, degrees: null,
        frame: this.frame, method: 'inside', place: resolved.place,
      };
    }
    const { kx, ky } = this.#metricScale();
    // Metric-plane delta, y **down**: metric y is (maxY - lat) * ky, so a target
    // with a larger latitude has a smaller metric y.
    const bearing = bearingFromDelta((point[0] - x) * kx, (y - point[1]) * ky, this.frame);
    if (!bearing) return null;
    return { ...bearing, method: 'nearest_vertex', place: resolved.place };
  }

  /* ------------------------------------------------------------- M12b · route -- */

  /**
   * Resolve one endpoint of a route to a point in the graph plane.
   *
   * **World-native coordinates are the addressing primitive here**, and for this
   * world that is lng/lat. `(u, v)` is a perception artifact — where a finger
   * landed on a piece of material — and it is converted once, at this boundary,
   * and never travels back out: every position this method's callers emit is
   * frame-native. That is also why a bare `{u, v}` is accepted at all: the
   * dispatcher holds one and should not have to know the projection to spend it.
   *
   * @param {*} ref
   * @returns {{coords: Coords, place?: object, label: string}|import('../worldAdapter.js').Ambiguous|{error: string}}
   */
  #endpoint(ref) {
    if (ref === null || ref === undefined) return { error: 'no location given' };

    // Already in the plane: a Node or PoI handed back from a previous call.
    if (ref instanceof Coords) return { coords: ref, label: 'a point on the map' };
    if (ref instanceof LogicNode) return { coords: ref.coords, label: ref.getShortDescription() };
    if (ref?.coords instanceof Coords && typeof ref.name === 'string') {
      return { coords: ref.coords, label: ref.name };
    }

    if (typeof ref === 'string') {
      const hit = this.resolvePlace(ref);
      if (hit === null) return { error: `I could not find "${ref}" on this map` };
      if (isAmbiguous(hit)) return hit;
      return this.#endpoint(hit);
    }

    // A Place — ours or shaped like ours.
    if (ref.geometry || (ref.id && ref.name)) {
      const point = this.#representativePoint(ref);
      if (!point) return { error: `"${ref.name || ref.id}" has no geometry to route to` };
      return { coords: this.#planeOf(point[0], point[1]), place: ref, label: ref.name || String(ref.id) };
    }

    const geographic = this.frame === FRAMES.GEOGRAPHIC;
    if (Number.isFinite(ref.u) && Number.isFinite(ref.v)) {
      const [x, y] = this.#uvToXY(ref.u, ref.v);
      return { coords: this.#planeOf(x, y), label: 'where you are pointing' };
    }
    const x = geographic ? ref.lng ?? ref.x : ref.e ?? ref.x;
    const y = geographic ? ref.lat ?? ref.y : ref.n ?? ref.y;
    if (Number.isFinite(x) && Number.isFinite(y)) {
      return { coords: this.#planeOf(x, y), label: 'a point on the map' };
    }

    return { error: 'that location is not something this map can be addressed by' };
  }

  /** Frame coords -> plane `Coords`. */
  #planeOf(x, y) {
    const [px, py] = this.plane.toPlane(x, y);
    return new Coords(px, py);
  }

  /** Plane `Coords` -> frame-native position, the only shape that leaves here. */
  #frameOfPlane(coords) {
    const [x, y] = this.plane.fromPlane(coords.x, coords.y);
    return this.frame === FRAMES.GEOGRAPHIC ? { lng: x, lat: y } : { e: x, n: y };
  }

  /** Mean of a place's positions — the one point an area can be routed to. */
  #representativePoint(place) {
    const known = this._index.find((g) => g.place === place);
    if (known?.centroid) return known.centroid;
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (const [x, y] of positions(place.geometry)) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      sx += x; sy += y; n += 1;
    }
    return n ? [sx / n, sy / n] : null;
  }

  /**
   * A walking route across the graph built by `buildLogicGraph()`.
   *
   * The path itself is `lib/logic/graph.js`'s: `localLegs` reads the
   * Floyd–Warshall predecessor matrix precomputed at construction, folds
   * collinear legs at `COLLINEAR_COS`, and `processInstructions` turns the legs
   * into spoken waypoints. **None of that prose is re-derived here** — headings
   * are `getDirection` / `getTurningDirection`'s eight `CardinalDirection`s and
   * their turn-relative continuations ("Continue straight" / "Head north-east"),
   * which is MapIO's convention and the property `scripts/test_logic_port.mjs`
   * pins byte for byte. There is no clock face on this route and no bearing
   * invented at this layer; this method converts endpoints in and positions out,
   * and otherwise reports what the graph said.
   *
   * ⚠️ `RoutePrefs` are **not honoured**. The ported Floyd–Warshall is unweighted
   * — the Python has no preference model to port — so `streetAvoidance`,
   * `maxUphill`, `maxDownhill` and `avoidBarriers` cannot change the path. They
   * are echoed back in `ignoredPrefs` rather than silently dropped, because a
   * route that quietly ignores "avoid barriers" is worse than one that says it
   * did.
   *
   * @param {*} from @param {*} to
   * @param {import('../worldAdapter.js').RoutePrefs & {streetByStreet?: boolean}} [prefs]
   * @returns {import('../worldAdapter.js').Route|import('../worldAdapter.js').Ambiguous|import('../worldAdapter.js').Unsupported}
   */
  route(from, to, prefs = {}) {
    if (!this.logicGraph) {
      return unsupported(
        this.places.length
          ? 'This map has no routing network yet — build one with buildLogicGraph(). Audiom can still walk you there with its own avatar.'
          : 'Nothing is loaded yet, so there is nothing to route across.',
        CAPABILITIES.ROUTING,
      );
    }

    const a = this.#endpoint(from);
    if (isAmbiguous(a)) return a;
    if (a.error) return unsupported(`I could not work out where to start: ${a.error}.`, CAPABILITIES.ROUTING);

    const b = this.#endpoint(to);
    if (isAmbiguous(b)) return b;
    if (b.error) return unsupported(`I could not work out where to finish: ${b.error}.`, CAPABILITIES.ROUTING);

    const streetByStreet = prefs.streetByStreet !== false;
    const ignoredPrefs = ['streetAvoidance', 'maxUphill', 'maxDownhill', 'avoidBarriers']
      .filter((k) => prefs[k] !== undefined && prefs[k] !== null && prefs[k] !== false);

    this._routeSink.length = 0;
    try {
      this.logicGraph.guideToDestination(a.coords, b.coords, streetByStreet);
    } catch (err) {
      // `guideToDestination` guards its own leg computation but not
      // `processInstructions`, whose `getCrossings` walks the predecessor matrix
      // and throws "Points are not connected" on a partly-reachable pair. An
      // eighth reference-implementation fragility, contained here rather than
      // allowed to kill the turn.
      return unsupported(
        `I could not describe a route between those two places (${err?.message || err}).`,
        CAPABILITIES.ROUTING,
      );
    }

    const result = this._routeSink[this._routeSink.length - 1];
    this._routeSink.length = 0;

    if (!result || result.action === RouteAction.ERROR || !result.waypoints?.length) {
      return unsupported(
        `There is no path on this map between ${a.label} and ${b.label}.`,
        CAPABILITIES.ROUTING,
      );
    }

    // `guideToDestination` snapped the start onto the network before routing;
    // the legs begin there, not at the raw point, so the first leg is measured
    // from the same place the graph measured it from.
    const start = this.logicGraph.snapToGraph(a.coords, true)[0];

    /** @type {object[]} */
    const segments = [];
    /** @type {object[]} */
    const waypoints = [];
    let previous = start;
    let distance = 0;

    result.waypoints.forEach((wp, i) => {
      const legLength = previous.distanceTo(wp.coords);
      distance += legLength;

      const destination = wp.destination;
      const endsAtNode = destination instanceof LogicNode;
      const endsAtEdge = destination instanceof LogicEdge;

      segments.push({
        id: `leg:${i}`,
        fromNode: i === 0 ? 'start' : segments[i - 1].toNode,
        toNode: endsAtNode ? destination.id : i === result.waypoints.length - 1 ? 'destination' : `pt:${i}`,
        kind: endsAtNode ? 'junction-leg' : endsAtEdge ? 'block-leg' : 'final-leg',
        street: endsAtEdge ? destination.street : undefined,
        // Frame units, and metres in both frames — §5.4's rule that the unit
        // rides along with the number.
        distance: legLength,
        direction: wp.direction,
        instructions: wp.instructions,
        to: this.#frameOfPlane(wp.coords),
        provenance: { source: 'audiom:layers', id: `${this.definition?.id ?? ''}:leg:${i}` },
      });

      waypoints.push({
        instructions: wp.instructions,
        direction: wp.direction,
        name: wp.name,
        position: this.#frameOfPlane(wp.coords),
        distance: legLength,
      });

      previous = wp.coords;
    });

    const geographic = this.frame === FRAMES.GEOGRAPHIC;
    return {
      frame: this.frame,
      distance,
      // §5.4: a duration is a claim about walking, which a diagram cannot make.
      duration: geographic ? distance / WALK_SPEED_MPS : undefined,
      segments,
      waypoints,
      instructions: waypoints.map((w) => w.instructions),
      streetByStreet,
      from: { label: a.label, position: this.#frameOfPlane(start) },
      to: { label: b.label, position: this.#frameOfPlane(result.waypoints[result.waypoints.length - 1].coords) },
      ignoredPrefs,
      provenance: {
        source: 'audiom:layers',
        mapDefinitionId: this.definition?.id,
        cachedAt: this.places[0]?.provenance?.cachedAt,
      },
    };
  }

  /* ------------------------------------------------------------ not yet ours -- */

  /**
   * Kerbs, inclines, surfaces and crossings stay unavailable even now that a
   * graph exists, and that is the point: M12b built the *topology*, not the
   * attributes. `geojsonGraph.js` deliberately leaves `edges_features` empty
   * rather than mapping a source column called `surface` onto `Edge`'s
   * `surface`, because `Edge.getCompleteDescription()` would then state it
   * flatly. §8 is explicit — never say a crossing has a kerb ramp. Real
   * attributes arrive with a validated pedestrian source (M10/M11).
   */
  attributes(_segmentOrNode) {
    return unsupported(
      'This map has a routing network but no validated kerb, incline or surface data, so those are not available (M10/M11).',
      CAPABILITIES.ACCESSIBILITY_ATTRS,
    );
  }
}

export default AudiomWorldAdapter;
