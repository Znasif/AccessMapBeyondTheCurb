/**
 * geojsonGraph — GeoJSON features to the `graphDict` the ported `logic/graph.js`
 * eats. Milestone 12b of `docs/browser-voice-exploration-plan.md`.
 *
 * §4 of the plan gives the port ("`graph.py` … → the `graph`/`routing` half of
 * **any Tier-A adapter**") but not the join: `Graph` is constructed from the
 * `graph` object of a *camio model JSON*, which is a hand-authored, already
 * noded, already street-named network in template pixels. A Tier-A world hands
 * over something else entirely — a pile of GeoJSON features in lng/lat, with no
 * topology, no node ids, and names that repeat. This module is that join, and it
 * is deliberately world-agnostic (M4's OSM adapter wants the same thing) so the
 * Audiom adapter contributes only its projection.
 *
 * PLATFORM-FREE, per §4: plain ES modules, no DOM, no fetch, no bundler.
 *
 * WHAT IT PRODUCES — exactly the six keys `logic/graph.js` reads:
 *
 *   { nodes: [[x, y], …],            nodes_features: [{ on_border }, …],
 *     edges: [[i, j], …],            edges_features: [{}, …],
 *     streets: { name: [edgeIdx…] }, points_of_interest: [{ name, coords, edge }] }
 *
 * `reference_system` and `latlng_reference` are deliberately omitted; see
 * "Three things this does not do" below.
 *
 * THE MODEL IT TARGETS, and the three places real geometry does not fit it:
 *
 *  1. **Nodes are junctions, edges are straight chords between them.** The camio
 *     model has no interior vertices: an `Edge` is a straight line and its
 *     `length` is computed from its two endpoints, which this module cannot
 *     override without editing `logic/edge.js` (out of scope, and the
 *     byte-identical-prose property of the port depends on it). Interior
 *     vertices are therefore dropped and a curved way is measured by its chord.
 *     Keeping them is not the alternative it looks like: a degree-2 vertex in
 *     the middle of one street gives `adjacentsStreets = ['A', 'A']`, and
 *     `Node.getShortDescription()` renders that as `"A at  and A"` — an eighth
 *     reference-implementation bug, found here, listed with the seven of §5.1.
 *     So junction-only nodes are the shape the ported prose is correct for.
 *  2. **Topology is recovered by snapping, not by intersecting.** Two ways that
 *     share a vertex (to within `snapTolerance`) get a junction; two ways that
 *     *cross* without sharing one do not. Source data noded by its publisher —
 *     which is the normal case, and is what layerloader emits — is fine; data
 *     that is not would need a segment-intersection pass, which is a different
 *     and much larger piece of work.
 *  3. **A street is a name, not a way.** The camio model's `streets` maps one
 *     name to the edges that make it up, and `Node.getShortDescription()` speaks
 *     those names ("6th Avenue at West 28th Street"). Features are therefore
 *     grouped by name, which is right for a street split across three features
 *     and is also why an unnamed way gets a synthetic name rather than being
 *     dropped: an edge with no street is an edge that cannot be spoken.
 *
 * THREE THINGS THIS DOES NOT DO, on purpose:
 *
 *  - **No `edges_features` from source attributes.** `Edge.getCompleteDescription`
 *     will happily announce `surface`, `slope` and `traffic_direction`, and a
 *     raw source column named `surface` is not the same claim. Answering "is it
 *     steep" from an unvalidated attribute is the confident wrongness the
 *     capability system exists to prevent (§8, "Stale accessibility data"), so
 *     features are left empty and `defaultEdgeFeatures` applies. Callers that
 *     have *validated* attributes pass `edgeFeaturesFrom`.
 *  - **No `latlng_reference`.** `coords.js`'s `coordsToLatLng` measures in feet
 *     (`R = 6378137 * FEETS_PER_METER`). The plane here is whatever unit the
 *     caller's `project` produces — metres, for every current caller — so
 *     supplying the reference would invite a silent 3.28× error. Callers already
 *     hold the inverse projection.
 *  - **No connectivity repair.** A disconnected component stays disconnected and
 *     `Graph.getMinPath` reports it. `stats.components` says how many there are.
 */

/**
 * Floyd–Warshall is O(V³) and runs once per graph *at construction*, before any
 * question is asked. 400 nodes is ~64 M relaxations of a string-keyed matrix —
 * around a second in Node, which is a "preparing map" step (§8) rather than a
 * turn. Above that the build refuses instead of hanging the tab; callers that
 * know what they are doing raise it explicitly.
 * @type {number}
 */
export const DEFAULT_MAX_NODES = 400;

/** POIs cost O(P·E) at build and nothing afterwards. */
export const DEFAULT_MAX_POIS = 2000;

/** Name given to ways that have none, so their edges are still speakable. */
export const UNNAMED_STREET = 'an unnamed way';

/* --------------------------------------------------------------- geometry -- */

/**
 * Every linear ring/line in a geometry, whatever the nesting.
 * @param {object|null|undefined} geometry
 * @param {boolean} includePolygonBoundaries
 * @returns {Generator<number[][]>}
 */
function* lineStringsOf(geometry, includePolygonBoundaries) {
  if (!geometry) return;
  switch (geometry.type) {
    case 'LineString':
      if (Array.isArray(geometry.coordinates)) yield geometry.coordinates;
      break;
    case 'MultiLineString':
      for (const line of geometry.coordinates || []) yield line;
      break;
    case 'Polygon':
      if (includePolygonBoundaries) for (const ring of geometry.coordinates || []) yield ring;
      break;
    case 'MultiPolygon':
      if (includePolygonBoundaries) {
        for (const poly of geometry.coordinates || []) for (const ring of poly) yield ring;
      }
      break;
    case 'GeometryCollection':
      for (const g of geometry.geometries || []) yield* lineStringsOf(g, includePolygonBoundaries);
      break;
    default:
      break;
  }
}

/** @param {object|null|undefined} geometry @returns {Generator<number[]>} */
function* pointsOf(geometry) {
  if (!geometry) return;
  switch (geometry.type) {
    case 'Point':
      if (Array.isArray(geometry.coordinates)) yield geometry.coordinates;
      break;
    case 'MultiPoint':
      for (const p of geometry.coordinates || []) yield p;
      break;
    case 'GeometryCollection':
      for (const g of geometry.geometries || []) yield* pointsOf(g);
      break;
    default:
      break;
  }
}

/** Mean of every position in a geometry — the stand-in point for an area. */
function centroidOf(geometry) {
  let sx = 0;
  let sy = 0;
  let n = 0;
  const walk = (c) => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === 'number') {
      if (Number.isFinite(c[0]) && Number.isFinite(c[1])) { sx += c[0]; sy += c[1]; n += 1; }
      return;
    }
    for (const part of c) walk(part);
  };
  if (geometry?.type === 'GeometryCollection') {
    for (const g of geometry.geometries || []) {
      const c = centroidOf(g);
      if (c) { sx += c[0]; sy += c[1]; n += 1; }
    }
  } else {
    walk(geometry?.coordinates);
  }
  return n ? [sx / n, sy / n] : null;
}

/**
 * Vertex identity by proximity — a uniform hash grid, so the cost is linear in
 * the number of vertices rather than quadratic.
 *
 * Buckets are `snapTolerance` wide and the 3×3 neighbourhood is searched, which
 * is what makes this a true radius query and not a quantization: two vertices
 * either side of a cell boundary still merge. The first vertex to arrive at a
 * location owns the coordinate, so every way through a junction agrees on where
 * it is — a property `Graph`'s `equals()` (identity by index) needs.
 */
class VertexIndex {
  /** @param {number} tolerance In plane units; `0` means exact equality. */
  constructor(tolerance) {
    this.tolerance = tolerance > 0 ? tolerance : 0;
    this.cell = this.tolerance > 0 ? this.tolerance : 1;
    /** @type {Map<string, number[]>} */
    this.grid = new Map();
    /** @type {number[][]} */
    this.points = [];
  }

  /**
   * @param {number} x @param {number} y
   * @returns {number} Index of the vertex this point *is*, creating it if new.
   */
  add(x, y) {
    const ci = Math.floor(x / this.cell);
    const cj = Math.floor(y / this.cell);

    for (let di = -1; di <= 1; di += 1) {
      for (let dj = -1; dj <= 1; dj += 1) {
        const bucket = this.grid.get(`${ci + di},${cj + dj}`);
        if (!bucket) continue;
        for (const idx of bucket) {
          const p = this.points[idx];
          if (this.tolerance > 0) {
            if (Math.hypot(p[0] - x, p[1] - y) <= this.tolerance) return idx;
          } else if (p[0] === x && p[1] === y) return idx;
        }
      }
    }

    const idx = this.points.length;
    this.points.push([x, y]);
    const key = `${ci},${cj}`;
    const bucket = this.grid.get(key);
    if (bucket) bucket.push(idx);
    else this.grid.set(key, [idx]);
    return idx;
  }
}

/* ------------------------------------------------------------------ build -- */

/**
 * @typedef {object} GraphSourceFeature
 * @property {string} [name]      Becomes the street name, or the POI name.
 * @property {object} [geometry]  GeoJSON, in the caller's frame.
 * @property {string} [id]        Carried onto POIs as `placeId`.
 * @property {Record<string, any>} [props]
 */

/**
 * @typedef {object} BuildResult
 * @property {boolean} ok            False when there is nothing routable, or too much.
 * @property {string} [reason]       Why not, narratable.
 * @property {object} [graphDict]    Ready for `new Graph(graphDict, …)`.
 * @property {string[]} [placeIdByPoi] Place id per `points_of_interest` entry.
 * @property {object} stats          nodes / edges / streets / pois / components / vertices.
 * @property {string[]} notes        What was dropped or synthesised, never silent.
 */

/**
 * Build a `graphDict` from GeoJSON features.
 *
 * @param {Iterable<GraphSourceFeature>} features
 * @param {(x: number, y: number) => number[]} project Frame coords -> plane
 *   coords. The plane must be metric and **y-down**: `logic/graph.js` defines
 *   north as the versor `(0, -1)`, so a y-up plane silently mirrors every
 *   spoken direction.
 * @param {object} [options]
 * @param {number} [options.snapTolerance=0] Plane units within which two
 *   vertices are the same junction.
 * @param {number} [options.maxNodes=DEFAULT_MAX_NODES]
 * @param {number} [options.maxPois=DEFAULT_MAX_POIS]
 * @param {boolean} [options.includePolygonBoundaries=false] Treat polygon rings
 *   as ways. Off by default: a lake's shoreline is not somewhere to walk.
 * @param {boolean} [options.areaCentroidsAsPois=true] Give a named polygon a POI
 *   at its centroid, so `route_to("Old Town")` has a target.
 * @param {(f: GraphSourceFeature) => Record<string, unknown>} [options.edgeFeaturesFrom]
 * @returns {BuildResult}
 */
export function buildGraphDict(features, project, options = {}) {
  const {
    snapTolerance = 0,
    maxNodes = DEFAULT_MAX_NODES,
    maxPois = DEFAULT_MAX_POIS,
    includePolygonBoundaries = false,
    areaCentroidsAsPois = true,
    edgeFeaturesFrom = undefined,
  } = options;

  /** @type {string[]} */
  const notes = [];
  const vertices = new VertexIndex(snapTolerance);

  /** @type {{seq: number[], feature: GraphSourceFeature, street: string}[]} */
  const ways = [];
  /** @type {GraphSourceFeature[]} */
  const pointFeatures = [];
  let unnamedWays = 0;

  for (const feature of features) {
    const rawName = typeof feature?.name === 'string' ? feature.name.trim() : '';
    let isLinear = false;

    for (const line of lineStringsOf(feature?.geometry, includePolygonBoundaries)) {
      if (!Array.isArray(line) || line.length < 2) continue;
      /** @type {number[]} */
      const seq = [];
      for (const position of line) {
        if (!Array.isArray(position)) continue;
        const [px, py] = project(position[0], position[1]);
        if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
        const idx = vertices.add(px, py);
        // A repeat of the previous vertex is a zero-length step, not a junction.
        if (seq.length === 0 || seq[seq.length - 1] !== idx) seq.push(idx);
      }
      if (seq.length < 2) continue;
      isLinear = true;
      if (!rawName) unnamedWays += 1;
      ways.push({ seq, feature, street: rawName || UNNAMED_STREET });
    }

    if (!isLinear) pointFeatures.push(feature);
  }

  if (unnamedWays) notes.push(`${unnamedWays} unnamed way(s) grouped as "${UNNAMED_STREET}"`);

  if (ways.length === 0) {
    return {
      ok: false,
      reason: 'This map has no linear features, so there is no network to route over.',
      stats: { nodes: 0, edges: 0, streets: 0, pois: 0, components: 0, vertices: vertices.points.length },
      notes,
    };
  }

  // --- which vertices are junctions ---------------------------------------
  // A vertex earns a node when a way *ends* there, or when it is touched more
  // than once (by two ways, or twice by one that doubles back). Everything else
  // is shape, and shape is not spoken.
  const total = vertices.points.length;
  const appearances = new Int32Array(total);
  const terminal = new Uint8Array(total);
  for (const { seq } of ways) {
    for (const idx of seq) appearances[idx] += 1;
    terminal[seq[0]] = 1;
    terminal[seq[seq.length - 1]] = 1;
  }
  const isJunction = new Uint8Array(total);
  for (let i = 0; i < total; i += 1) {
    isJunction[i] = terminal[i] || appearances[i] > 1 ? 1 : 0;
  }

  // --- chords between consecutive junctions --------------------------------
  /** @type {Map<string, {a: number, b: number, street: string, feature: GraphSourceFeature}>} */
  const edgeByPair = new Map();
  /** @type {Map<string, {a: number, b: number, street: string, feature: GraphSourceFeature}[]>} */
  const byStreet = new Map();
  let duplicates = 0;

  for (const { seq, feature, street } of ways) {
    let runStart = 0;
    for (let i = 1; i < seq.length; i += 1) {
      if (!isJunction[seq[i]]) continue;
      const a = seq[runStart];
      const b = seq[i];
      runStart = i;
      if (a === b) continue; // a closed loop back to its own start: no chord.
      const pair = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (edgeByPair.has(pair)) { duplicates += 1; continue; }
      const edge = { a, b, street, feature };
      edgeByPair.set(pair, edge);
      const list = byStreet.get(street);
      if (list) list.push(edge);
      else byStreet.set(street, [edge]);
    }
  }

  if (duplicates) notes.push(`${duplicates} duplicate segment(s) collapsed (same pair of junctions)`);

  const allEdges = [...edgeByPair.values()];
  if (allEdges.length === 0) {
    return {
      ok: false,
      reason: 'Every way on this map collapses to a single point, so there is nothing to route along.',
      stats: { nodes: 0, edges: 0, streets: 0, pois: 0, components: 0, vertices: total },
      notes,
    };
  }

  // --- lay the edges out in the order `loadEdges()` will rebuild them -------
  // `logic/graph.js#loadEdges` walks `Object.entries(streets)` and concatenates,
  // so the index a POI stores must be an index into THAT order — not into the
  // order edges were discovered. `Object.keys` is read back rather than assumed
  // because a street named "12" is an integer-like key and JavaScript hoists
  // those to the front of the object regardless of insertion order. Node
  // numbering follows the same walk, so the whole dict is a deterministic
  // function of the input rather than of Map iteration luck.
  /** @type {Record<string, number[]>} */
  const streets = {};
  for (const name of byStreet.keys()) streets[name] = [];
  const streetOrder = Object.keys(streets);

  const nodeIndexOf = new Map();
  /** @type {number[][]} */
  const nodeCoords = [];
  const nodeFor = (vertexIdx) => {
    let n = nodeIndexOf.get(vertexIdx);
    if (n === undefined) {
      n = nodeCoords.length;
      nodeIndexOf.set(vertexIdx, n);
      nodeCoords.push(vertices.points[vertexIdx]);
    }
    return n;
  };
  for (const name of streetOrder) {
    for (const edge of byStreet.get(name) || []) { nodeFor(edge.a); nodeFor(edge.b); }
  }

  if (nodeCoords.length > maxNodes) {
    return {
      ok: false,
      reason:
        `This map's network has ${nodeCoords.length} junctions, past the ${maxNodes} that all-pairs ` +
        'shortest paths can be precomputed for without stalling the session.',
      stats: {
        nodes: nodeCoords.length,
        edges: allEdges.length,
        streets: byStreet.size,
        pois: 0,
        components: 0,
        vertices: total,
      },
      notes,
    };
  }

  /** @type {number[][]} */
  const edges = [];
  /** @type {Record<string, unknown>[]} */
  const edgesFeatures = [];

  for (const name of streetOrder) {
    const indexes = [];
    for (const edge of byStreet.get(name) || []) {
      indexes.push(edges.length);
      edges.push([nodeFor(edge.a), nodeFor(edge.b)]);
      edgesFeatures.push(edgeFeaturesFrom ? { ...edgeFeaturesFrom(edge.feature) } : {});
    }
    streets[name] = indexes;
  }

  // --- node features: which junctions sit on the edge of the map ------------
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of nodeCoords) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const borderSlack = snapTolerance > 0 ? snapTolerance : 0;
  const nodesFeatures = nodeCoords.map(([x, y]) => ({
    on_border:
      x - minX <= borderSlack ||
      maxX - x <= borderSlack ||
      y - minY <= borderSlack ||
      maxY - y <= borderSlack,
  }));

  // --- connected components, reported not repaired -------------------------
  const adjacency = nodeCoords.map(() => []);
  for (const [a, b] of edges) { adjacency[a].push(b); adjacency[b].push(a); }
  const seen = new Uint8Array(nodeCoords.length);
  let components = 0;
  for (let i = 0; i < nodeCoords.length; i += 1) {
    if (seen[i]) continue;
    components += 1;
    const stack = [i];
    seen[i] = 1;
    while (stack.length) {
      const n = stack.pop();
      for (const m of adjacency[n]) if (!seen[m]) { seen[m] = 1; stack.push(m); }
    }
  }
  if (components > 1) notes.push(`the network is in ${components} disconnected pieces`);

  // --- POIs ----------------------------------------------------------------
  /** @type {Record<string, unknown>[]} */
  const pois = [];
  /** @type {string[]} */
  const placeIdByPoi = [];
  let poiOverflow = 0;

  const nearestEdgeIndex = (x, y) => {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < edges.length; i += 1) {
      const [ax, ay] = nodeCoords[edges[i][0]];
      const [bx, by] = nodeCoords[edges[i][1]];
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
      const d = Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  };

  const addPoi = (feature, position) => {
    if (pois.length >= maxPois) { poiOverflow += 1; return; }
    const [px, py] = project(position[0], position[1]);
    if (!Number.isFinite(px) || !Number.isFinite(py)) return;
    const edge = nearestEdgeIndex(px, py);
    if (edge < 0) return;
    pois.push({ name: feature.name, coords: [px, py], edge });
    placeIdByPoi.push(feature.id ?? '');
  };

  for (const feature of pointFeatures) {
    const name = typeof feature?.name === 'string' ? feature.name.trim() : '';
    if (!name) continue;
    let placed = false;
    for (const position of pointsOf(feature.geometry)) { addPoi(feature, position); placed = true; }
    if (!placed && areaCentroidsAsPois) {
      const c = centroidOf(feature.geometry);
      if (c) addPoi(feature, c);
    }
  }

  if (poiOverflow) notes.push(`${poiOverflow} place(s) past the ${maxPois}-POI cap were not attached to the network`);

  return {
    ok: true,
    graphDict: {
      nodes: nodeCoords,
      nodes_features: nodesFeatures,
      edges,
      edges_features: edgesFeatures,
      streets,
      points_of_interest: pois,
    },
    placeIdByPoi,
    stats: {
      nodes: nodeCoords.length,
      edges: edges.length,
      streets: Object.keys(streets).length,
      pois: pois.length,
      components,
      vertices: total,
    },
    notes,
  };
}

export default buildGraphDict;
