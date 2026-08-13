/**
 * MapioWorldAdapter — the world the parity benchmark runs against, and the one
 * the in-tab dispatcher runs against too.
 *
 * ⚠️ It used to live in `lib/parity/`, which made `hooks/useMapioDispatcher.js`
 * import the test harness in order to get a shipped adapter. Same world, same
 * numbers, two callers: it belongs beside `camioWorldAdapter.js` and
 * `audiomWorldAdapter.js`. `parity/index.js` re-exports it, so the benchmark's
 * single import point is unchanged.
 *
 * `browser-voice-exploration-plan.md` §6 makes `run_parity_benchmark.py` the
 * acceptance test for milestone **P**, and P is `src/lib/logic/` — the port of
 * `graph.py`/`node.py`/`edge.py`/`poi.py`/`coords.py`. So the world under test
 * has to *be* that port: this adapter is a `WorldAdapter` face on a ported
 * `Graph`, and every number it returns comes out of the same Floyd–Warshall
 * matrix, the same `getNearestEdge`, the same `processInstructions` whose prose
 * `test_logic_port.mjs` pins byte-for-byte against the Python.
 *
 * ⚠️ **This is NOT `CamioWorldAdapter`, and the plan's §6 note that it is
 * ("camioWorldAdapter over models/new_york") does not survive contact with the
 * files.** `CamioWorldAdapter` is a colour-map adapter: it requires a
 * `PixelAccessor` and hotspots, builds one `Place` per *region*, and answers in
 * `material_mm` in the `image` frame. Neither bundled model ships a colour map
 * (`models/new_york/` is `new_york.json` + `template.png`, nothing else), both
 * are MapIO graph+POI documents, and `test_camio_adapter.mjs:489` only asserts
 * that the POI *record shape* is the one `fromCamioPoi` consumes — it binds a
 * single hand-placed POI to a synthetic hotspot over a fake 20×20 pixel grid.
 * Driving the benchmark through it would require inventing 50 colour regions
 * per map and would answer "how far is Solle Spa" in millimetres of paper.
 *
 * ## Frame: geographic, and why that is not a cheat
 *
 * MapIO coordinates are **feet, y growing south**. Three independent checks:
 * `graph.js#getDirection` defines north as the versor `(0, -1)`;
 * `coords.js#coordsToLatLng` reads `dn = -diff.y` against an earth radius
 * expressed in feet; and on `new_york.json` the node bbox spans 2941 × 2685
 * units, which is a thirteen-block slice of Midtown in feet and nothing at all
 * in pixels. The model also carries a `latlng_reference`, so every point has a
 * real lat/lng. That is the `geographic` frame's definition — a world with a
 * compass and a metric scale — and it is what lets the six tools answer in the
 * vocabulary MapIO itself uses (compass words, feet, minutes) instead of
 * narrating a printed sheet.
 *
 * ⚠️ One inconsistency inherited from the model files, reported not fixed: the
 * JSON's own `reference_system` says `north: [0, 1]`, which contradicts the
 * y-down convention every code path uses. `graph.py` ignores it for direction
 * (it hardcodes `(0,-1)`) and only `curated_formatter.py` reads it — where it
 * silently inverts the street census, see `briefing.js`.
 *
 * ## Capabilities
 *
 * `{places, graph, routing, accessibilityAttrs}` — declared because the data is
 * genuinely there: named POIs bound to edges, a connected street network, a
 * precomputed shortest-path matrix, and per-edge/per-node feature blocks
 * (`roadwork`, `stairs`, `surface`, `walk_light`, `tactile_paving`,
 * `street_width`). `entrances` and `regions` are not declared and their tools
 * never reach the prompt.
 *
 * Platform-free: no fetch, no DOM, no `fs`. The caller parses the model JSON and
 * hands over a constructed `Graph`.
 */

import {
  CAPABILITIES,
  FRAMES,
  WorldAdapter,
  ambiguous,
} from '../worldAdapter.js';
import { bearingBetweenPoints } from '../direction.js';
import { Coords, FEETS_PER_METER, coordsToLatLng } from '../logic/coords.js';
import { Graph, RouteAction } from '../logic/graph.js';
import { Node } from '../logic/node.js';
import { Edge } from '../logic/edge.js';
import { PoI } from '../logic/poi.js';

/** Feet per metre. Re-exported from the port so there is one constant, not two. */
export const FEET_PER_METRE = FEETS_PER_METER;

/** @param {number} feet */
export const feetToMetres = (feet) => feet / FEET_PER_METRE;
/** @param {number} metres */
export const metresToFeet = (metres) => metres * FEET_PER_METRE;

/**
 * Cap on `Place.description` — where the place is, in MapIO's own words.
 *
 * ⚠️ Sized against `MAX_RESULT_CHARS`, after getting it wrong once and measuring.
 * The first version put the whole POI record here (420 chars) and
 * `describe_surroundings` on `detroit_conant` measured 1,557 chars against a
 * 1,200-char envelope cap — at which point `capSize` trims the `nearby` array
 * **to its first element** and the answer to "what's around me" is one place out
 * of five, which is exactly the shape of `NY-L5` and `DT-T9`. Two changes fixed
 * it: the rest of the record moved to `props` (see {@link MAX_DETAIL_CHARS}),
 * and `describeNeighbour` now drops `description` from list entries entirely
 * (`tools/shared.js`, a latent bug this benchmark found).
 *
 * Swept over 1,865 tool results across both maps at this setting: zero
 * truncations, worst envelope 988 chars.
 */
export const MAX_DESCRIPTION_CHARS = 160;

/**
 * Cap on the flattened detail record in `props.facilities`.
 *
 * MapIO's own `get_point_of_interest_details` returns the whole `str_dict` POI
 * record, and several graded turns depend on a field no other path carries:
 * `DT-T3`'s entire grading note is *"facilities.internet_access = 'free Wi-Fi'.
 * Must come from POI details, not a guess."* `get_place_details`'s `DETAIL_KEYS`
 * allowlist reaches hours, phone and website, so this is flattened into one
 * string and read through the one added allowlist row.
 */
export const MAX_DETAIL_CHARS = 320;

/** POI sub-blocks worth spending the detail budget on, in this order. */
const DETAIL_BLOCKS = Object.freeze([
  'facilities',
  'catering',
  'commercial',
  'accessibility',
  'brand',
  'housenumber',
]);

/** `{a: {b: true, c: 'x'}}` → `a: b, c x`. One line, no JSON punctuation to tokenise. */
function flatten(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (Array.isArray(value)) return value.map(flatten).filter(Boolean).join(', ');
  if (typeof value === 'object') {
    return Object.entries(value)
      .map(([key, val]) => {
        const rendered = flatten(val);
        if (!rendered || rendered === 'no') return '';
        const label = key.replace(/_/g, ' ');
        return rendered === 'yes' ? label : `${label} ${rendered}`;
      })
      .filter(Boolean)
      .join(', ');
  }
  return String(value).replace(/_/g, ' ');
}

const truncate = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Where the place is, in MapIO's own words. Short: this rides in every list. */
function describePoi(poi) {
  return truncate(flatten(poi.info.location_description), MAX_DESCRIPTION_CHARS);
}

/** Everything else known about it, flattened for the `get_place_details` allowlist. */
function detailPoi(poi) {
  const info = poi.info;
  const parts = [];
  for (const key of DETAIL_BLOCKS) {
    const rendered = flatten(info[key]);
    if (rendered) parts.push(`${key.replace(/_/g, ' ')}: ${rendered}`);
  }
  return truncate(parts.join('. '), MAX_DETAIL_CHARS);
}

/** Case- and space-insensitive key for name matching. */
const norm = (text) => String(text ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * `resolvePlace` returns at most this many candidates before giving up on
 * disambiguating. Matches `AudiomWorldAdapter`'s `MAX_AMBIGUOUS`; the envelope
 * trims to 5 on the way out anyway (`toolResult.js#MAX_CANDIDATES`).
 */
export const MAX_AMBIGUOUS = 8;

export class MapioWorldAdapter extends WorldAdapter {
  /**
   * @param {object} opts
   * @param {Graph} opts.graph   A constructed `logic/graph.js` Graph.
   * @param {object} [opts.model] The parsed model JSON (`name`, `context`, …).
   * @param {string} [opts.mapName] `new_york` | `detroit_conant`.
   * @param {string} [opts.worldId] Defaults to `mapio:<mapName>`.
   */
  constructor({ graph, model = {}, mapName, worldId } = {}) {
    super({
      frame: FRAMES.GEOGRAPHIC,
      capabilities: [
        CAPABILITIES.PLACES,
        CAPABILITIES.GRAPH,
        CAPABILITIES.ROUTING,
        CAPABILITIES.ACCESSIBILITY_ATTRS,
      ],
      worldId: worldId || `mapio:${mapName || model.name || 'map'}`,
    });
    if (!graph || !Array.isArray(graph.nodes)) {
      throw new Error('MapioWorldAdapter: a constructed logic/graph.js Graph is required');
    }
    this.graph = graph;
    this.model = model;
    this.mapName = mapName || model.name || 'map';

    /**
     * The window, in map feet, as `[minX, minY, maxX, maxY]`.
     *
     * Taken over nodes **and** POIs rather than `graph.bounds` (nodes only):
     * a POI sitting just outside the node hull would otherwise map to `v > 1`
     * and quietly leave the window every `windowId`-keyed cache is built for.
     */
    this.bbox = boundsOf(graph);
    const [minX, minY, maxX, maxY] = this.bbox;
    this._spanX = maxX - minX || 1;
    this._spanY = maxY - minY || 1;

    /** @type {object[]} One Place per POI, built once. */
    this._places = graph.pois.map((poi) => this.#placeFor(poi));
    /** @type {Map<string, object[]>} normalised name/alias → places */
    this._byName = new Map();
    for (const place of this._places) {
      for (const key of [place.name, ...place.aliases]) {
        const k = norm(key);
        if (!k) continue;
        if (!this._byName.has(k)) this._byName.set(k, []);
        this._byName.get(k).push(place);
      }
    }
  }

  /* ------------------------------------------------------------ geometry -- */

  /** `(u, v)` → map coordinates in feet. The one place normalisation is undone. */
  uvToCoords(u, v) {
    return new Coords(this.bbox[0] + u * this._spanX, this.bbox[1] + v * this._spanY);
  }

  /** Map feet → `(u, v)`. Not clamped: a point outside the window must look outside. */
  coordsToUv(coords) {
    return {
      u: (coords.x - this.bbox[0]) / this._spanX,
      v: (coords.y - this.bbox[1]) / this._spanY,
    };
  }

  /** @param {Coords} coords @returns {{lat: number, lng: number}|null} */
  latLngOf(coords) {
    if (!this.graph.latlngReference) return null;
    const ll = coordsToLatLng(this.graph.latlngReference, coords);
    return { lat: ll.x, lng: ll.y };
  }

  /**
   * The metric plane: metres, y **down**, isotropic.
   *
   * Map feet are already a flat isotropic plane with y growing south, so this
   * is one division. Every bearing in the system is computed here (see
   * `direction.js#bearingBetweenPoints`), which is why it must not be `(u, v)`:
   * the window is 2941 × 2685 feet and a 45° sweep in `(u, v)` is 42°.
   */
  metricPoint(u, v) {
    const coords = this.uvToCoords(u, v);
    return { x: feetToMetres(coords.x), y: feetToMetres(coords.y), units: 'metres' };
  }

  bearingBetween(u0, v0, u1, v1) {
    return bearingBetweenPoints(this, u0, v0, u1, v1);
  }

  /**
   * "On or immediately beside", in metres.
   *
   * `Graph.AM_I_THRESHOLD` is 0.75 inches of printed material, which
   * `feets_per_inch` turns into 250 map feet on both bundled models. Taken from
   * the graph rather than restated so `am_i_at` here and `graph.amIAt()` in the
   * Python agree by construction.
   */
  touchTolerance() {
    return { value: feetToMetres(this.graph.amIThreshold), units: 'metres', frame: this.frame };
  }

  /* -------------------------------------------------------------- places -- */

  places() {
    return this._places.map((p) => ({ ...p }));
  }

  /**
   * Name → Place.
   *
   * Exact (case-insensitive) first, then aliases, then a containment pass so
   * "Shake Shack" resolves from "the Shake Shack" and "Empire State" from the
   * full name. Several containment hits with no exact match is `Ambiguous`, per
   * §4.2 — the model is handed the shortlist rather than a guess.
   */
  resolvePlace(text) {
    const key = norm(text);
    if (!key) return null;

    const exact = this._byName.get(key);
    if (exact?.length === 1) return { ...exact[0] };
    if (exact?.length > 1) return ambiguous(exact.slice(0, MAX_AMBIGUOUS).map((p) => ({ ...p })), text);

    const contained = this._places.filter((place) => {
      const names = [place.name, ...place.aliases].map(norm);
      return names.some((n) => n.includes(key) || key.includes(n));
    });
    if (contained.length === 1) return { ...contained[0] };
    if (contained.length > 1) {
      return ambiguous(contained.slice(0, MAX_AMBIGUOUS).map((p) => ({ ...p })), text);
    }
    return null;
  }

  /**
   * What the finger is on.
   *
   * Mirrors `position_handler.py`'s precedence — POI, then segment, then node —
   * and uses `Graph.AM_I_THRESHOLD` as the POI radius so `whats_here` and
   * `am_i_at` cannot disagree about whether the finger is on a place.
   *
   * ⚠️ Deliberately does *not* call `graph.getNearestPoi()`: that filters on
   * `poi.enabled`, which is MapIO's `enable_points_of_interests` gate, and with
   * the LLM in the loop nothing is enabled until the model asks. The whole point
   * of §4.2 is that this system replaced that call with retrieval, so every POI
   * is visible to geometry here.
   */
  at(u, v) {
    const coords = this.uvToCoords(u, v);
    /** @type {object} */
    const out = {};

    let bestPoi = null;
    let bestDistance = Infinity;
    for (const poi of this.graph.pois) {
      const d = poi.coords.distanceTo(coords);
      if (d < bestDistance) {
        bestDistance = d;
        bestPoi = poi;
      }
    }
    if (bestPoi && bestDistance <= this.graph.amIThreshold) {
      out.place = { ...this._places[bestPoi.index] };
    }

    const [edge, edgeDistance] = this.graph.getNearestEdge(coords);
    if (edge) {
      out.segment = {
        id: edge.id,
        fromNode: edge.node1.id,
        toNode: edge.node2.id,
        kind: 'street',
        name: edge.street,
        description: safely(() => edge.getCompleteDescription()),
        attrs: { ...edge.features },
        distance: { value: feetToMetres(edgeDistance), units: 'metres' },
      };
    }

    const [node, nodeDistance] = this.graph.getNearestNode(coords);
    if (node && nodeDistance <= this.graph.amIThreshold) {
      out.node = this.#nodeResult(node, nodeDistance);
    }

    return out;
  }

  /**
   * The nearest intersection at any distance, with how far it is.
   *
   * `at()` only reports a node the finger is actually *on* — within
   * `AM_I_THRESHOLD` — because "you are at this crossing" and "the nearest
   * crossing is over there" are different claims and §8 is explicit that
   * conflating them is the accessibility failure mode that matters. This is the
   * second claim, used by `get_crossing_info` mid-block, and its result carries
   * the distance so the handler can say which one it is answering.
   */
  nearestNode(u, v) {
    const coords = this.uvToCoords(u, v);
    const [node, distance] = this.graph.getNearestNode(coords);
    return node ? this.#nodeResult(node, distance) : null;
  }

  /** @param {Node} node @param {number} distanceFeet */
  #nodeResult(node, distanceFeet) {
    return {
      id: node.id,
      kind: 'junction',
      name: safely(() => node.getShortDescription()),
      description: safely(() => node.getCompleteDescription()),
      attrs: { ...node.features },
      distance: { value: feetToMetres(distanceFeet), units: 'metres' },
    };
  }

  /**
   * Named places within `radius` **metres** of walking distance, nearest first.
   *
   * Walking distance, not straight-line, because that is what
   * `graph.get_nearby_pois` measures and what "what's near me" means on a
   * street network. Unreachable POIs are skipped rather than failing the call —
   * faithful to the Python's `try/except: continue`.
   */
  nearby(u, v, radius) {
    const coords = this.uvToCoords(u, v);
    const limitFeet = Number.isFinite(radius) && radius > 0
      ? metresToFeet(radius)
      : Graph.NEARBY_THRESHOLD;

    const out = [];
    for (const poi of this.graph.pois) {
      let feet;
      try {
        feet = this.graph.getDistanceToPoi(coords, poi);
      } catch {
        continue;
      }
      if (!(feet <= limitFeet)) continue;
      out.push({
        ...this._places[poi.index],
        distance: { value: feetToMetres(feet), units: 'metres' },
      });
    }
    out.sort((a, b) => a.distance.value - b.distance.value);
    return out;
  }

  /**
   * Walking distance to a named target, in metres.
   *
   * `method: 'street_network'` is the honesty flag `get_distance_to` prints:
   * this is a path along the map's own streets, not a straight line, so it is
   * the number that converts sensibly into `minutes` and `blocks`.
   */
  distanceTo(u, v, target) {
    const resolved = this.#targetPoi(target);
    if (!resolved) return null;
    if (resolved.candidates) return resolved;
    const { poi, place } = resolved;
    const coords = this.uvToCoords(u, v);

    if (poi.coords.distanceTo(coords) === 0) {
      return { value: 0, units: 'metres', frame: this.frame, method: 'inside', place };
    }
    let feet;
    try {
      feet = this.graph.getDistanceToPoi(coords, poi);
    } catch {
      // "Points are not connected" — real on these maps for a POI hanging off a
      // component the finger cannot walk to. Straight line, labelled as such.
      return {
        value: feetToMetres(poi.coords.distanceTo(coords)),
        units: 'metres',
        frame: this.frame,
        method: 'straight_line_unconnected',
        place,
      };
    }
    return { value: feetToMetres(feet), units: 'metres', frame: this.frame, method: 'street_network', place };
  }

  /** Direction to a named target, in compass words (this frame may say them). */
  bearingTo(u, v, target) {
    const resolved = this.#targetPoi(target);
    if (!resolved) return null;
    if (resolved.candidates) return resolved;
    const { poi, place } = resolved;
    const here = this.coordsToUv(this.uvToCoords(u, v));
    const there = this.coordsToUv(poi.coords);
    const bearing = this.bearingBetween(here.u, here.v, there.u, there.v);
    if (!bearing) {
      return { ...zeroBearing(this.frame), method: 'inside', place };
    }
    return { ...bearing, method: 'nearest_vertex', place };
  }

  /* ------------------------------------------------------------- routing -- */

  /**
   * A route, through the ported router.
   *
   * `guideToDestination` delivers its answer to the Graph's `onRoute` callback
   * rather than returning it — that is the Python's shape and the port kept it,
   * because `NavigationController.routeFailed()` depends on errors arriving the
   * same way. So the callback is swapped for the duration of the call and the
   * waypoints are captured; this is the JS equivalent of
   * `run_parity_benchmark.py`'s `route_recorder()`.
   *
   * @param {object} from `{u, v}` or a Place
   * @param {object} to   `{u, v}` or a Place
   * @param {object} [prefs]
   * @returns {object}
   */
  route(from, to, prefs = {}) {
    const start = this.#coordsOf(from);
    const end = this.#coordsOf(to);
    if (!start || !end) {
      return { segments: [], waypoints: [], frame: this.frame, error: 'unroutable_endpoint' };
    }

    const captured = [];
    const previous = this.graph._onRoute;
    this.graph._onRoute = (action, origin, streetByStreet, waypoints) => {
      captured.push({ action, origin, streetByStreet, waypoints });
    };
    try {
      this.graph.guideToDestination(start, end, prefs.streetByStreet !== false, prefs.routeIndex || 0);
    } finally {
      this.graph._onRoute = previous;
    }

    const delivered = captured.find((c) => c.action === RouteAction.ON_ROUTE);
    if (!delivered) {
      return { segments: [], waypoints: [], frame: this.frame, error: 'no_route', actions: captured.map((c) => c.action) };
    }

    const waypoints = (delivered.waypoints || []).map((w) => ({
      instructions: w.instructions,
      direction: String(w.direction),
      name: w.name,
      coords: [round1(w.coords.x), round1(w.coords.y)],
    }));

    // Path length in feet, walked leg by leg from the start point — the same
    // quantity `get_distance` reports, without its 10-foot snap.
    let feet = 0;
    let cursor = delivered.origin;
    for (const w of delivered.waypoints || []) {
      feet += cursor.distanceTo(w.coords);
      cursor = w.coords;
    }
    const metres = feetToMetres(feet);

    return {
      segments: waypoints.map((w, i) => ({ id: `leg${i}`, fromNode: null, toNode: null, kind: 'street' })),
      waypoints,
      distance: metres,
      // 1.2 m/s, the same walking speed `getDistanceTo.js` and
      // `audiomWorldAdapter` use. Reconciled by a check in the harness.
      duration: metres / 1.2,
      frame: this.frame,
      streetByStreet: delivered.streetByStreet,
      actions: captured.map((c) => c.action),
    };
  }

  /**
   * Per-segment / per-node attributes, straight off the ported feature blocks.
   *
   * @param {object} segmentOrNode Either an `at()` result's `segment`/`node`, or
   *   a `logic` `Edge`/`Node`.
   */
  attributes(segmentOrNode) {
    if (segmentOrNode instanceof Edge || segmentOrNode instanceof Node) {
      return { ...segmentOrNode.features };
    }
    return { ...(segmentOrNode?.attrs || {}) };
  }

  /* ------------------------------------------------------------- private -- */

  /** @param {PoI} poi */
  #placeFor(poi) {
    const info = poi.info;
    const aliases = Object.values(info.name_other || {}).filter((v) => typeof v === 'string');
    const latLng = this.latLngOf(poi.coords);
    const contact = info.contact || {};
    return {
      id: `poi:${poi.index}`,
      // MapIO's tool contract is index-based and the design rule here is
      // names-only (§3 rule 2). Both are true at once: the index survives as
      // provenance, and nothing the model sees or writes carries it.
      poiIndex: poi.index,
      name: poi.name,
      aliases,
      category: (info.categories || []).join(', ') || undefined,
      description: describePoi(poi) || undefined,
      geometry: latLng ? { type: 'Point', coordinates: [latLng.lng, latLng.lat] } : undefined,
      props: {
        opening_hours: info.opening_hours,
        phone: contact.phone,
        website: contact.website,
        // Read by `get_place_details` through its `DETAIL_KEYS` allowlist — one
        // string, never an object, because `firstOf()` takes strings and numbers
        // and spreading a raw property bag is the hazard that file is about.
        facilities: detailPoi(poi) || undefined,
        street: poi.street,
      },
      provenance: { source: `mapio:${this.mapName}`, id: `poi:${poi.index}` },
    };
  }

  /**
   * A tool target (`Place`, or a name) → the ported `PoI` behind it.
   * Returns the `Ambiguous` sentinel unchanged so the registry can surface it.
   */
  #targetPoi(target) {
    if (target && typeof target === 'object' && Number.isInteger(target.poiIndex)) {
      return { poi: this.graph.pois[target.poiIndex], place: { ...this._places[target.poiIndex] } };
    }
    const name = typeof target === 'string' ? target : target?.name;
    if (!name) return null;
    const resolved = this.resolvePlace(name);
    if (!resolved) return null;
    if (resolved.candidates) return resolved;
    return { poi: this.graph.pois[resolved.poiIndex], place: resolved };
  }

  /** @returns {Coords|null} */
  #coordsOf(value) {
    if (value instanceof Coords) return value;
    if (value && Number.isFinite(value.u) && Number.isFinite(value.v)) return this.uvToCoords(value.u, value.v);
    const resolved = this.#targetPoi(value);
    if (!resolved || resolved.candidates) return null;
    return resolved.poi.coords;
  }
}

/* -------------------------------------------------------------- helpers -- */

/** Node hull ∪ POI hull, in map feet, as `[minX, minY, maxX, maxY]`. */
export function boundsOf(graph) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const consider = (c) => {
    if (c.x < minX) minX = c.x;
    if (c.x > maxX) maxX = c.x;
    if (c.y < minY) minY = c.y;
    if (c.y > maxY) maxY = c.y;
  };
  for (const node of graph.nodes) consider(node.coords);
  for (const poi of graph.pois) consider(poi.coords);
  return [minX, minY, maxX, maxY];
}

/** A bearing object for "no displacement", so `bearingTo` never returns a bare null shape. */
function zeroBearing(frame) {
  return { cardinal: null, direction: null, vocabulary: 'compass', degrees: 0, frame };
}

const round1 = (n) => Math.round(n * 10) / 10;

/**
 * `Edge.getCompleteDescription` reads feature keys that a partial model omits —
 * one of the seven reference-implementation bugs the port documents. Descriptions
 * are decoration here; a throw must not lose the position.
 */
function safely(fn) {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

export default MapioWorldAdapter;
