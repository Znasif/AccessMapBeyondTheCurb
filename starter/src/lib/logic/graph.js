/**
 * Graph — the road network, its shortest paths, and the prose that describes
 * them. Ported from `explore/simple_camio_llm/src/graph/graph.py` (766 lines,
 * the single largest file in milestone P).
 *
 * Milestone P of `docs/browser-voice-exploration-plan.md` §4:
 *
 *   > `graph.py` — Floyd–Warshall `precompute_distances`, `get_min_path`,
 *   > `get_nearest_node/edge/poi`, `__local_legs`, `__merge_collinear`
 *   > (COLLINEAR_COS 0.985), `__process_instructions`
 *   >   → the `graph`/`routing` half of any Tier-A adapter
 *
 * PLATFORM-FREE ON PURPOSE: no DOM, no React, no IndexedDB, no fetch. Two
 * things in the Python are platform-bound and therefore replaced by seams
 * rather than ported:
 *
 *   - **Google routing.** `__google_legs` POSTs to the Routes API. The comment
 *     at the top of the Python explains that the request "was asking a remote
 *     service to solve a problem this object had already solved" — every field
 *     but the leg endpoints is commented out and `__process_instructions`
 *     re-snaps them onto this graph anyway. Local routing is the default there
 *     and the only one here; an alternative source of legs can still be injected
 *     as `options.legsProvider`, and `processInstructions()` remains shared by
 *     both, as it was.
 *   - **`config.feets_per_inch`.** A process-global singleton in Python; an
 *     explicit `options.feetsPerInch` here.
 *
 * Method names stay recognisably parallel (`get_min_path` → `getMinPath`).
 * Python's two name-mangled privates (`__local_legs`, `__process_instructions`)
 * are public here so the port can be tested directly; `__merge_collinear` was
 * already a `@staticmethod` and becomes a module-level function.
 */

import { Coords, DIRECTIONS, CardinalDirection, pyRound } from './coords.js';
import { Node } from './node.js';
import { Edge, Street } from './edge.js';
import { PoI } from './poi.js';

/**
 * Two consecutive legs are folded into one when their headings agree to within
 * this cosine (~10 degrees).
 *
 * From the Python, preserved verbatim because the number was measured, not
 * chosen: on detroit_conant, hotel -> The Italian Table, 0.996 leaves 11
 * waypoints including two consecutive "east ... until Revere Avenue" for one
 * straight walk, 0.985 gives 10, 0.95 gives 9, and 0.90 also gives 9. Real
 * turns on these maps are ~90°, so nothing near this threshold is a turn — the
 * flat stretch from 0.95 to 0.90 is that headroom. 0.985 takes the duplicate
 * without reaching toward the turns.
 *
 * @type {number}
 */
export const COLLINEAR_COS = 0.985;

/** What a route callback is being told. */
export const RouteAction = Object.freeze({
  ERROR: 'ERROR',
  CALCULATING_ROUTE: 'CALCULATING_ROUTE',
  ON_ROUTE: 'ON_ROUTE',
});

/** The four map-edge reference directions, straight out of the model JSON. */
export class ReferenceSystem {
  /**
   * @param {Coords} north
   * @param {Coords} south
   * @param {Coords} west
   * @param {Coords} east
   */
  constructor(north, south, west, east) {
    this.north = north;
    this.south = south;
    this.west = west;
    this.east = east;
  }
}

/**
 * One spoken step of a route.
 *
 * `distance` is a **`Coords`, not a scalar** — and that is faithful. The Python
 * writes `round(Coords(dx, dy) * 10 / feets_per_inch) / 10`, where `round()`
 * dispatches to `Coords.__round__` and returns a `Coords`; the declared type is
 * `Union[float, Coords]`, so the vector case is at least acknowledged, but a
 * per-leg *length* is almost certainly what was meant. Reported, not fixed —
 * nothing downstream reads it (the navigators use `waypoint.coords` and
 * `instructions`, and the benchmark's route recorder reads instructions,
 * direction, name and coords).
 */
export class WayPoint {
  /** @type {WayPoint} */
  static NONE;

  /**
   * @param {Coords} coords Where this step ends, in map coordinates.
   * @param {Coords|Node|Edge|PoI} destination What is at that end.
   * @param {number|Coords} distance See the class note.
   * @param {string} direction One of `CardinalDirection`.
   * @param {string} [instructions='']
   */
  constructor(coords, destination, distance, direction, instructions = '') {
    this.coords = coords;
    this.destination = destination;
    this.distance = distance;
    this.direction = direction;
    this.instructions = instructions;
  }

  /** @returns {string|null} Spoken name of the step's endpoint. */
  get name() {
    if (this.destination instanceof Node) return this.destination.getShortDescription();
    if (this.destination instanceof PoI) return this.destination.name;
    return null;
  }

  /**
   * Python's dataclass compares waypoints on `destination` alone; every other
   * field is `compare=False`.
   * @param {unknown} other
   * @returns {boolean}
   */
  equals(other) {
    if (!(other instanceof WayPoint)) return false;
    const a = this.destination;
    const b = other.destination;
    return typeof (/** @type {any} */ (a).equals) === 'function' ? /** @type {any} */ (a).equals(b) : a === b;
  }
}

WayPoint.NONE = new WayPoint(Coords.ZERO, Coords.ZERO, 0, CardinalDirection.NORTH);

/** @typedef {Coords|Node|Edge|PoI} Position */
/** @typedef {[Coords, Coords]} Leg */
/** @typedef {(action: string, start: Coords, streetByStreet: boolean, waypoints: WayPoint[]|null) => void} RouteCallback */

/** Default `onRoute`: the Python's `on_route_placeholder`. */
export function onRoutePlaceholder() {}

/**
 * The road network of one map.
 */
export class Graph {
  /** Distances reported to the LLM are snapped to this many feet. */
  static DISTANCE_STEP = 10;

  /** "Am I at X?" tolerance, in inches. */
  static AM_I_THRESHOLD = 0.75;
  /** Snap radius for `snapToGraph`, in inches. */
  static SNAP_MIN_DISTANCE = 0.25;
  /** Default radius for `getNearbyPois`, in feet. */
  static NEARBY_THRESHOLD = 700.0;

  /** Sentinel "unreachable" cost in the distance matrix. */
  static INF = 999999;

  /**
   * @param {Record<string, any>} graphDict The `graph` object of a camio model
   *   JSON: `nodes`, `nodes_features`, `edges`, `edges_features`, `streets`,
   *   `points_of_interest`, `reference_system`, `latlng_reference`.
   * @param {object} [options]
   * @param {RouteCallback} [options.onRoute] Where routing results are delivered.
   * @param {number} [options.feetsPerInch=1] `config.feets_per_inch` for this map.
   * @param {boolean} [options.llmEnabled=true] When false every POI starts
   *   enabled, matching `load_pois`'s `if not config.llm_enabled`.
   * @param {(start: Coords, destination: Coords, routeIndex: number) => Leg[]} [options.legsProvider]
   *   Alternative source of route legs (the seam where `__google_legs` lived).
   */
  constructor(graphDict, options = {}) {
    const {
      onRoute = onRoutePlaceholder,
      feetsPerInch = 1,
      llmEnabled = true,
      legsProvider = undefined,
    } = options;

    this.feetsPerInch = feetsPerInch;
    this.amIThreshold = Graph.AM_I_THRESHOLD * feetsPerInch;
    this.snapMinDistance = Graph.SNAP_MIN_DISTANCE * feetsPerInch;

    this.nodes = loadNodes(graphDict);
    const { edges, streets } = loadEdges(this.nodes, graphDict);
    this.edges = edges;
    /** @type {Map<string, Street>} */
    this.streets = streets;
    this.pois = loadPois(this.edges, graphDict, llmEnabled);

    const { dist, prev } = precomputeDistances(this);
    this.distances = dist;
    this.prevDistances = prev;

    const rs = graphDict.reference_system;
    this.referenceSystem = rs
      ? new ReferenceSystem(
          new Coords(rs.north[0], rs.north[1]),
          new Coords(rs.south[0], rs.south[1]),
          new Coords(rs.west[0], rs.west[1]),
          new Coords(rs.east[0], rs.east[1]),
        )
      : null;

    const ll = graphDict.latlng_reference;
    this.latlngReference = ll
      ? { coords: new Coords(ll.coords[0], ll.coords[1]), lat: ll.lat, lng: ll.lng }
      : null;

    this._onRoute = onRoute;
    this._legsProvider = legsProvider;
  }

  /**
   * Axis-aligned bounding box of the nodes.
   * @returns {[Coords, Coords]} `[minCorner, maxCorner]`.
   */
  get bounds() {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;

    for (const node of this.nodes) {
      if (node.coords.x < minX) minX = node.coords.x;
      if (node.coords.x > maxX) maxX = node.coords.x;
      if (node.coords.y < minY) minY = node.coords.y;
      if (node.coords.y > maxY) maxY = node.coords.y;
    }

    return [new Coords(minX, minY), new Coords(maxX, maxY)];
  }

  /**
   * @param {Coords} coords
   * @returns {[Node, number]} Nearest node and its distance.
   */
  getNearestNode(coords) {
    let best = this.nodes[0];
    let bestDistance = best.distanceTo(coords);

    for (const node of this.nodes) {
      const d = node.distanceTo(coords);
      if (d < bestDistance) {
        best = node;
        bestDistance = d;
      }
    }

    return [best, bestDistance];
  }

  /**
   * Nearest edge, preferring edges the point projects *onto*.
   *
   * Faithful to the Python's two-branch shape: when at least one edge contains
   * the projection, the winner is chosen by perpendicular distance to the
   * infinite line; only when none does are endpoint distances used.
   *
   * @param {Coords} coords
   * @returns {[Edge, number]}
   */
  getNearestEdge(coords) {
    /** @type {Edge[]} */
    const candidates = this.edges.filter((edge) => edge.contains(coords.projectOn(edge)));

    if (candidates.length > 0) {
      let best = candidates[0];
      let bestDistance = coords.distanceToLine(best);
      for (const edge of candidates) {
        const d = coords.distanceToLine(edge);
        if (d < bestDistance) {
          best = edge;
          bestDistance = d;
        }
      }
      return [best, bestDistance];
    }

    const endpointDistance = (/** @type {Edge} */ edge) =>
      Math.min(coords.distanceTo(edge.get(0).coords), coords.distanceTo(edge.get(1).coords));

    let best = this.edges[0];
    let bestDistance = endpointDistance(best);
    for (const edge of this.edges) {
      const d = endpointDistance(edge);
      if (d < bestDistance) {
        best = edge;
        bestDistance = d;
      }
    }

    return [best, bestDistance];
  }

  /**
   * Nearest **enabled** POI. With the LLM in the loop nothing is enabled until
   * the model asks for it, so this legitimately returns `null` early on.
   * @param {Coords} coords
   * @returns {[PoI|null, number]}
   */
  getNearestPoi(coords) {
    const pois = this.pois.filter((p) => p.enabled);
    if (pois.length === 0) return [null, Infinity];

    let best = pois[0];
    let bestDistance = best.coords.distanceTo(coords);
    for (const poi of pois) {
      const d = poi.coords.distanceTo(coords);
      if (d < bestDistance) {
        best = poi;
        bestDistance = d;
      }
    }

    return [best, bestDistance];
  }

  /**
   * Walking distance between two free points, in feet, snapped to
   * {@link Graph.DISTANCE_STEP}.
   *
   * Both points are attached to their nearest edge, the graph distance between
   * those edges is read out of the precomputed matrix, and the two
   * off-network hops are added.
   *
   * @param {Coords} p1
   * @param {Coords} p2
   * @returns {number}
   * @throws {Error} "Points are not connected".
   */
  getDistance(p1, p2) {
    const [e1, distToE1] = this.getNearestEdge(p1);
    const [e2, distToE2] = this.getNearestEdge(p2);

    const d =
      this._getEdgeDistance(
        e1,
        e2,
        p1.projectOn(e1).distanceTo(e1.get(0).coords),
        p2.projectOn(e2).distanceTo(e2.get(0).coords),
      ) +
      distToE1 +
      distToE2;

    return pyRound(d / Graph.DISTANCE_STEP) * Graph.DISTANCE_STEP;
  }

  /**
   * Walking distance to a POI, in feet. **Not** snapped to `DISTANCE_STEP` —
   * `get_distance` rounds and this one does not, which is the Python's
   * behaviour, not an oversight of the port.
   * @param {Coords} p1
   * @param {number|string|PoI} poiRef Index, name, or the POI itself.
   * @returns {number}
   * @throws {Error} "Points are not connected".
   */
  getDistanceToPoi(p1, poiRef) {
    const poi = this.resolvePoi(poiRef);

    const [e1, distToE1] = this.getNearestEdge(p1);
    const e2 = poi.edge;

    return (
      this._getEdgeDistance(
        e1,
        e2,
        p1.projectOn(e1).distanceTo(e1.get(0).coords),
        poi.coords.projectOn(e2).distanceTo(e2.get(0).coords),
      ) +
      distToE1 +
      poi.coords.distanceToLine(e2)
    );
  }

  /**
   * Straight-line "am I standing at this place?" test.
   * @param {Coords} p1
   * @param {number|string|PoI} poiRef
   * @returns {boolean}
   */
  amIAt(p1, poiRef) {
    const p2 = this.resolvePoi(poiRef).coords;
    return p1.distanceTo(p2) < this.amIThreshold;
  }

  /**
   * @param {number|string|PoI} poiRef
   * @returns {PoI}
   * @throws {Error} "Invalid POI index".
   */
  getPoiDetails(poiRef) {
    return this.resolvePoi(poiRef);
  }

  /**
   * POIs within `threshold` feet of walking distance.
   *
   * A negative threshold means "every POI on the map", which the tool layer
   * uses to enumerate. Unreachable POIs are skipped rather than failing the
   * whole call.
   *
   * @param {Coords} coords
   * @param {number|null} [threshold] Feet; `null`/undefined uses
   *   {@link Graph.NEARBY_THRESHOLD}.
   * @returns {string[]} Names, in map order.
   */
  getNearbyPois(coords, threshold = null) {
    let limit = threshold === null || threshold === undefined ? Graph.NEARBY_THRESHOLD : threshold;

    if (limit < 0) return this.pois.map((poi) => poi.name);

    /** @type {string[]} */
    const res = [];
    const [e1, distToE1] = this.getNearestEdge(coords);

    const projectionDistance = coords.projectOn(e1).distanceTo(e1.get(0).coords);
    limit -= distToE1;

    for (const poi of this.pois) {
      const e2 = poi.edge;
      let d;
      try {
        d =
          this._getEdgeDistance(
            e1,
            e2,
            projectionDistance,
            poi.coords.projectOn(e2).distanceTo(e2.get(0).coords),
          ) + poi.coords.distanceToLine(e2);
      } catch {
        continue;
      }

      if (d <= limit) res.push(poi.name);
    }

    return res;
  }

  /**
   * Attach a free point to the network.
   *
   * Nodes win over edges; `force` accepts an edge projection at any distance,
   * which is what routing endpoints need so a route always starts and ends on
   * the network.
   *
   * @param {Coords} coords
   * @param {boolean} [force=false]
   * @returns {[Coords, Position]} Snapped point and what it snapped to. Falls
   *   back to `[coords, coords]` when nothing is close enough.
   */
  snapToGraph(coords, force = false) {
    const [node, nodeDistance] = this.getNearestNode(coords);
    if (nodeDistance < this.snapMinDistance) return [node.coords, node];

    const [edge, edgeDistance] = this.getNearestEdge(coords);
    if (force || edgeDistance < this.snapMinDistance) return [coords.projectOn(edge), edge];

    return [coords, coords];
  }

  /**
   * @param {Coords} start
   * @param {number|string|PoI} poiRef
   * @param {boolean} [streetByStreet=true]
   * @param {number} [routeIndex=0]
   * @returns {void}
   */
  guideToPoi(start, poiRef, streetByStreet = true, routeIndex = 0) {
    const poi = this.resolvePoi(poiRef);
    this.guideToDestination(start, poi.coords, streetByStreet, routeIndex);
  }

  /**
   * Compute a route and hand it to the route callback.
   *
   * Errors reach the callback rather than throwing. From the Python: `guide_to_*`
   * runs on its own thread there, so an exception dies unlogged and the
   * navigator that requested the route stays frozen — leaving guidance
   * permanently silent after a single failure. See
   * `NavigationController.routeFailed()`.
   *
   * @param {Coords} start
   * @param {Coords} destination
   * @param {boolean} [streetByStreet=true]
   * @param {number} [routeIndex=0]
   * @returns {void}
   */
  guideToDestination(start, destination, streetByStreet = true, routeIndex = 0) {
    const from = this.snapToGraph(start, true)[0];
    const to = this.snapToGraph(destination, true)[0];

    if (from.equals(to)) {
      this._onRoute(RouteAction.ERROR, from, streetByStreet, null);
      return;
    }

    if (!streetByStreet) {
      this._onRoute(RouteAction.ON_ROUTE, from, streetByStreet, [
        new WayPoint(to, to, from.distanceTo(to), getDirection(to.sub(from).normalized())),
      ]);
      return;
    }

    this._onRoute(RouteAction.CALCULATING_ROUTE, from, streetByStreet, null);

    /** @type {Leg[]} */
    let legs;
    try {
      legs = this._legsProvider
        ? this._legsProvider(from, to, routeIndex)
        : this.localLegs(from, to);
    } catch (e) {
      // Same as the Python's `print(f"Routing failed: {e}")`: a routing failure
      // must be visible but must not escape, or the navigator that asked for
      // the route never hears back.
      console.log(`Routing failed: ${e && e.message ? e.message : e}`);
      legs = [];
    }

    if (legs.length === 0) {
      this._onRoute(RouteAction.ERROR, from, streetByStreet, null);
      return;
    }

    this._onRoute(RouteAction.ON_ROUTE, from, streetByStreet, this.processInstructions(legs));
  }

  /**
   * Shortest path over this graph, as consecutive `(from, to)` legs.
   *
   * `getMinPath` walks the predecessor matrix `precomputeDistances()` filled at
   * construction, so this is a lookup, not a search. Coverage differs from the
   * Routes API on purpose: this stays on the streets that are in the map, which
   * for a tactile map is the surface the finger is on.
   *
   * (`__local_legs` in Python; public here for testability.)
   *
   * @param {Coords} start
   * @param {Coords} destination
   * @returns {Leg[]}
   */
  localLegs(start, destination) {
    const [startNode] = this.getNearestNode(start);
    const [destinationNode] = this.getNearestNode(destination);

    const path = this.getMinPath(startNode, destinationNode);
    if (path.length === 0) return [];

    // start and destination are the real endpoints; the node path only covers
    // the intersections between them.
    const points = [start, ...path.map((node) => node.coords), destination];

    /** @type {Leg[]} */
    const legs = [];
    for (let i = 0; i + 1 < points.length; i += 1) {
      if (!points[i].equals(points[i + 1])) legs.push([points[i], points[i + 1]]);
    }

    return mergeCollinear(legs);
  }

  /**
   * Turn `(from, to)` legs in map coordinates into spoken waypoints.
   *
   * Shared by both routing modes: the prose, the headings, the crossing counts
   * and the distances have always been generated here, from this graph,
   * whichever source supplied the legs.
   *
   * (`__process_instructions` in Python; public here for testability.)
   *
   * @param {Leg[]} legs
   * @returns {WayPoint[]}
   */
  processInstructions(legs) {
    /** @type {WayPoint[]} */
    const waypoints = [];

    let previousVersor = Coords.ZERO;

    for (let i = 0; i < legs.length; i += 1) {
      const [rawFrom, rawTo] = legs[i];
      const versor = rawTo.sub(rawFrom).normalized();

      const [fromCoords, start] = this.snapToGraph(rawFrom, true);
      const [toCoords, destination] = this.snapToGraph(rawTo);

      // See WayPoint's class note: this is a vector, faithfully.
      const distance = new Coords(toCoords.x - fromCoords.x, toCoords.y - fromCoords.y)
        .mul(10)
        .div(this.feetsPerInch)
        .round()
        .div(10);

      let direction;
      let sameDirection;
      if (i === 0) {
        direction = getDirection(versor);
        sameDirection = false;
      } else {
        direction = getTurningDirection(versor, waypoints[waypoints.length - 1].direction, previousVersor);
        sameDirection = direction === waypoints[waypoints.length - 1].direction;
      }

      let description = sameDirection ? 'Continue straight' : `Head ${direction}`;

      const crossings = this.getCrossings(start, destination);
      if (crossings === 1 && !(destination instanceof Node)) {
        description += ', pass the first intersection';
      } else if (crossings > 1) {
        description += ` for ${crossings} intersections`;
      }

      if (destination instanceof Node) {
        description += ` until ${destination.getShortDescription()}`;
      } else if (destination instanceof Edge) {
        if (crossings > 0) description += ', and then continue';
        description += ` for ${destination.getDistanceDescription(toCoords)}`;
      } else {
        if (crossings === 1) description += ', and then continue';
        description += ' until your final destination';
      }

      waypoints.push(new WayPoint(toCoords, destination, distance, direction, description));
      previousVersor = versor;
    }

    return waypoints;
  }

  /**
   * The node path between two nodes, endpoints included, read out of the
   * predecessor matrix.
   * @param {Node} start
   * @param {Node} destination
   * @returns {Node[]} Empty when the pair was never connected.
   * @throws {Error} "Points are not connected" when the walk runs out of
   *   predecessors partway — see the note in `precomputeDistances`.
   */
  getMinPath(start, destination) {
    if (this.prevDistances[start.id][destination.id] === null) return [];

    /** @type {Node[]} */
    const path = [destination];

    /** @type {Node|null} */
    let current = destination;
    while (current !== null && !start.equals(current)) {
      current = this.prevDistances[start.id][current.id];
      if (current !== null) path.push(current);
    }

    if (current === null) throw new Error('Points are not connected');

    return path.reverse();
  }

  /**
   * How many intersections a leg passes through.
   *
   * Two quirks, both faithful and both worth knowing:
   *  - an *unreachable* pair yields 0 — or **-1** when the start is a node —
   *    because `getMinPath` returns an empty path and `min(INF, 0)` is 0, which
   *    the node adjustment below then decrements. A negative crossing count is
   *    nonsense; reported, not fixed;
   *  - starting exactly on a node subtracts one, so a leg from a node to its
   *    neighbour counts 1 rather than 2.
   *
   * @param {Position} start
   * @param {Position} destination
   * @returns {number}
   */
  getCrossings(start, destination) {
    /** @type {Node[]} */
    const startNodes = [];
    /** @type {Node[]} */
    const destinationNodes = [];

    if (start instanceof Node) startNodes.push(start);
    else if (start instanceof PoI) startNodes.push(...start.edge.nodes);
    else if (start instanceof Edge) startNodes.push(start.node1, start.node2);
    else if (start instanceof Coords) startNodes.push(this.getNearestNode(start)[0]);

    if (destination instanceof Node) destinationNodes.push(destination);
    else if (destination instanceof PoI) destinationNodes.push(...destination.edge.nodes);
    else if (destination instanceof Edge) destinationNodes.push(destination.node1, destination.node2);
    else if (destination instanceof Coords) destinationNodes.push(this.getNearestNode(destination)[0]);

    let minCrossings = Graph.INF;
    for (const startNode of startNodes) {
      for (const destinationNode of destinationNodes) {
        if (startNode.equals(destinationNode)) return 0;

        const path = this.getMinPath(startNode, destinationNode);
        minCrossings = Math.min(minCrossings, path.length);
      }
    }

    if (start instanceof Node) minCrossings -= 1;

    return minCrossings;
  }

  /**
   * @param {Array<number|string|PoI>} refs
   * @returns {void}
   */
  enablePois(refs) {
    for (const ref of refs) this.resolvePoi(ref).enable();
  }

  /** @returns {void} */
  disablePois() {
    for (const poi of this.pois) poi.disable();
  }

  /**
   * Resolve a POI reference to the POI.
   *
   * The Python tool contract is index-only; design rule 2 of the tooling doc is
   * names-only. This accepts either (plus the object itself) so the ported
   * graph can serve the parity benchmark and the new tool layer without two
   * APIs. Name lookup is exact and case-insensitive on the second pass.
   *
   * @param {number|string|PoI} ref
   * @returns {PoI}
   * @throws {Error} "Invalid POI index" / "Unknown POI".
   */
  resolvePoi(ref) {
    if (ref instanceof PoI) return ref;

    if (typeof ref === 'number') {
      if (!Number.isInteger(ref) || ref < 0 || ref >= this.pois.length) {
        throw new Error('Invalid POI index');
      }
      return this.pois[ref];
    }

    if (typeof ref === 'string') {
      const exact = this.pois.find((poi) => poi.name === ref);
      if (exact) return exact;

      const lowered = ref.toLowerCase();
      const insensitive = this.pois.find((poi) => poi.name.toLowerCase() === lowered);
      if (insensitive) return insensitive;

      throw new Error(`Unknown POI: ${ref}`);
    }

    throw new Error('Invalid POI reference');
  }

  /**
   * Graph distance between two points already attached to edges, measured
   * through whichever pair of endpoints is cheapest.
   * @param {Edge} e1
   * @param {Edge} e2
   * @param {number} [distanceToE1N1=0]
   * @param {number} [distanceFromE2N1=0]
   * @returns {number}
   * @throws {Error} "Points are not connected".
   * @private
   */
  _getEdgeDistance(e1, e2, distanceToE1N1 = 0.0, distanceFromE2N1 = 0.0) {
    const toDistances = [distanceToE1N1, e1.length - distanceToE1N1];
    const fromDistances = [distanceFromE2N1, e2.length - distanceFromE2N1];

    let d = Infinity;
    for (let i = 0; i < 2; i += 1) {
      for (let j = 0; j < 2; j += 1) {
        const candidate =
          this.distances[e1.get(i).id][e2.get(j).id] + toDistances[i] + fromDistances[j];
        if (candidate < d) d = candidate;
      }
    }

    if (d >= Graph.INF) throw new Error('Points are not connected');
    return d;
  }
}

/**
 * Fold consecutive legs that keep going the same way into one leg.
 *
 * Crossing counts survive: `processInstructions` derives them with
 * `getCrossings` over the merged leg's endpoints, so a folded run of three
 * blocks describes itself as "for 3 intersections" instead of announcing three
 * times.
 *
 * The comparison is `>= COLLINEAR_COS` — a heading difference of exactly the
 * threshold merges.
 *
 * @param {Leg[]} legs
 * @returns {Leg[]}
 */
export function mergeCollinear(legs) {
  /** @type {Leg[]} */
  const merged = [];

  for (const leg of legs) {
    if (merged.length > 0) {
      const previous = merged[merged.length - 1];
      const v1 = previous[1].sub(previous[0]).normalized();
      const v2 = leg[1].sub(leg[0]).normalized();
      if (v1.x * v2.x + v1.y * v2.y >= COLLINEAR_COS) {
        merged[merged.length - 1] = [previous[0], leg[1]];
        continue;
      }
    }
    merged.push(leg);
  }

  return merged;
}

/**
 * @param {Record<string, any>} graphDict
 * @returns {Node[]}
 */
export function loadNodes(graphDict) {
  /** @type {Node[]} */
  const nodes = [];

  const coordsList = graphDict.nodes ?? [];
  const featuresList = graphDict.nodes_features ?? [];
  // Python zips the two lists, so the shorter one ends the loop.
  const count = Math.min(coordsList.length, featuresList.length);

  for (let i = 0; i < count; i += 1) {
    nodes.push(new Node(nodes.length, new Coords(coordsList[i][0], coordsList[i][1]), featuresList[i]));
  }

  return nodes;
}

/**
 * Build the edges street by street, then discover which streets cross which.
 * @param {Node[]} nodes
 * @param {Record<string, any>} graphDict
 * @returns {{edges: Edge[], streets: Map<string, Street>}}
 */
export function loadEdges(nodes, graphDict) {
  /** @type {Edge[]} */
  const edges = [];
  /** @type {Map<string, Street>} */
  const streets = new Map();

  const edgesData = graphDict.edges ?? [];
  const edgesFeatures = graphDict.edges_features ?? [];

  for (const [streetName, edgeIndexes] of Object.entries(graphDict.streets ?? {})) {
    /** @type {Edge[]} */
    const streetEdges = [];

    for (const edgeIndex of /** @type {number[]} */ (edgeIndexes)) {
      const edgeData = edgesData[edgeIndex];

      const node1 = nodes[edgeData[0]];
      node1.adjacentsStreets.push(streetName);
      const node2 = nodes[edgeData[1]];
      node2.adjacentsStreets.push(streetName);

      streetEdges.push(new Edge(node1, node2, streetName, edgesFeatures[edgeIndex]));
    }

    edges.push(...streetEdges);
    streets.set(streetName, new Street(streets.size, streetName, streetEdges));
  }

  for (let i = 0; i < edges.length; i += 1) {
    const e1 = edges[i];
    for (let j = i + 1; j < edges.length; j += 1) {
      const e2 = edges[j];

      if (e1.street === e2.street) continue;

      if (e1.isAdjacent(e2)) {
        e1.betweenStreets.add(e2.street);
        e2.betweenStreets.add(e1.street);
      }
    }
  }

  return { edges, streets };
}

/**
 * @param {Edge[]} edges
 * @param {Record<string, any>} graphDict
 * @param {boolean} [llmEnabled=true] When false, every POI starts enabled.
 * @returns {PoI[]}
 */
export function loadPois(edges, graphDict, llmEnabled = true) {
  const poisData = graphDict.points_of_interest ?? [];

  /** @type {PoI[]} */
  const pois = [];

  for (let i = 0; i < poisData.length; i += 1) {
    const poiData = poisData[i];
    const edge = edges[poiData.edge];
    const coords = new Coords(poiData.coords[0], poiData.coords[1]);

    pois.push(new PoI(i, poiData.name, coords, edge, poiData));
  }

  if (!llmEnabled) for (const poi of pois) poi.enable();

  return pois;
}

/**
 * Floyd–Warshall over every node, run once at construction.
 *
 * O(V³), and that is the point: `getMinPath` afterwards is a matrix walk, not a
 * search, which is what lets `StreetByStreetNavigator` ask for a fresh route
 * every time a finger pauses.
 *
 * The predecessor convention is `prev[i][j] = ` the node *before* `j` on the
 * path from `i`, seeded to `edge.node1` / `edge.node2` for direct edges and
 * relaxed as `prev[i][j] = prev[k][j]`.
 *
 * @param {Graph} graph
 * @returns {{dist: Record<string, Record<string, number>>, prev: Record<string, Record<string, Node|null>>}}
 */
export function precomputeDistances(graph) {
  /** @type {Record<string, Record<string, number>>} */
  const dist = Object.create(null);
  /** @type {Record<string, Record<string, Node|null>>} */
  const prev = Object.create(null);

  for (const n1 of graph.nodes) {
    dist[n1.id] = Object.create(null);
    prev[n1.id] = Object.create(null);
    for (const n2 of graph.nodes) {
      dist[n1.id][n2.id] = Graph.INF + 1.0;
      prev[n1.id][n2.id] = null;
    }
  }

  for (const edge of graph.edges) {
    dist[edge.node1.id][edge.node2.id] = edge.length;
    dist[edge.node2.id][edge.node1.id] = edge.length;
    prev[edge.node1.id][edge.node2.id] = edge.node1;
    prev[edge.node2.id][edge.node1.id] = edge.node2;
  }

  for (const node of graph.nodes) {
    dist[node.id][node.id] = 0.0;
    prev[node.id][node.id] = node;
  }

  for (const k of graph.nodes) {
    for (const i of graph.nodes) {
      for (const j of graph.nodes) {
        if (dist[i.id][j.id] > dist[i.id][k.id] + dist[k.id][j.id]) {
          dist[i.id][j.id] = dist[i.id][k.id] + dist[k.id][j.id];
          prev[i.id][j.id] = prev[k.id][j.id];
        }
      }
    }
  }

  return { dist, prev };
}

/**
 * Absolute heading of a unit vector, as a cardinal direction.
 *
 * Defined as "turning from north, whose versor is `(0, -1)`" — y grows
 * downward in map coordinates.
 *
 * @param {Coords} versor
 * @returns {string}
 */
export function getDirection(versor) {
  return getTurningDirection(versor, CardinalDirection.NORTH, new Coords(0, -1));
}

/**
 * New heading after turning from `oldDirection` (whose versor is `oldVersor`)
 * onto `newVersor`.
 *
 * The dot product is clamped because `Math.acos` is defined on `[-1, 1]` and
 * the dot product of two unit vectors lands outside it through rounding alone —
 * `1.0000000000000002` was enough to raise "math domain error" in Python, which
 * surfaced as a failed guide_to_point_of_interest with no indication of the
 * cause. Two versors pointing the same way is the common case here (a route
 * continuing straight through a node), so this is on the hot path.
 *
 * @param {Coords} newVersor
 * @param {string} oldDirection One of {@link DIRECTIONS}.
 * @param {Coords} oldVersor
 * @returns {string}
 */
export function getTurningDirection(newVersor, oldDirection, oldVersor) {
  const dot = Math.max(-1.0, Math.min(1.0, newVersor.dot(oldVersor)));
  let angle = (Math.acos(dot) * 180) / Math.PI; // between 0 and 180

  let directionIndex = 0;
  const side = oldVersor.cross2d(newVersor) > 0 ? 1 : -1; // 1 down the list, -1 up

  const threshold = 22.5;
  while (angle > threshold) {
    directionIndex += 1;
    angle -= 45;
  }

  const base = DIRECTIONS.indexOf(oldDirection);
  const n = DIRECTIONS.length;

  return DIRECTIONS[(((base + side * directionIndex) % n) + n) % n];
}
