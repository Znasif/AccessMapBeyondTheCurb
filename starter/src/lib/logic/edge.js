/**
 * Edge / Street — a block of a street between two nodes, ported from
 * `explore/simple_camio_llm/src/graph/edge.py`.
 *
 * Milestone P of `docs/browser-voice-exploration-plan.md` §4. Platform-free.
 */

import { Coords } from './coords.js';
import { Node } from './node.js';

/** Feature keys carried on an edge in the map JSON. */
export const EdgeFeatures = Object.freeze({
  ROADWORK: 'roadwork',
  SLOPE: 'slope',
  BIKE_LANE: 'bike_lane',
  SURFACE: 'surface',
  TRAFFIC_DIRECTION: 'traffic_direction',
  STAIRS: 'stairs',
});

/** Defaults applied when an edge carries no features at all. */
export const defaultEdgeFeatures = Object.freeze({
  roadwork: false,
  slope: 'flat',
  bike_lane: false,
  surface: 'concrete',
  traffic_direction: 'two_way',
  stairs: false,
});

/**
 * A straight segment between two nodes, belonging to exactly one street.
 *
 * Doubles as a `StraightLine` (`m`, `q`) and as a `Position`
 * (`distanceTo`, `closestPoint`, `getCompleteDescription`).
 */
export class Edge {
  /**
   * @param {Node} node1
   * @param {Node} node2
   * @param {string} streetName
   * @param {Record<string, unknown>} [features]
   */
  constructor(node1, node2, streetName, features = undefined) {
    this.node1 = node1;
    this.node2 = node2;
    this.street = streetName;

    // Deviation, documented, and the one place this port is deliberately more
    // forgiving than the Python: `Edge.get_complete_description` reads its
    // features with `[]` where `Node` uses `.get(key, default)`, so an edge
    // whose JSON omits a key raises `KeyError: surface` instead of describing
    // itself. Merging the defaults is what `default_features` was written for;
    // leaving the key absent in JS would be worse than the Python rather than
    // equal to it, because `undefined !== 'two_way'` would silently announce a
    // two-way street as one-way. Reported, and handled.
    this.features = { ...defaultEdgeFeatures, ...(features ?? {}) };

    /**
     * Streets that cross this block at either end. Filled by `loadEdges()`.
     * @type {Set<string>}
     */
    this.betweenStreets = new Set();
    this.length = this.node1.distanceTo(this.node2);
  }

  /** @returns {string} */
  get id() {
    return `${this.node1.id} - ${this.node2.id}`;
  }

  /** @returns {number} Slope, `Infinity` when vertical. */
  get m() {
    if (this.node1.get(0) === this.node2.get(0)) return Infinity;
    return (this.node1.get(1) - this.node2.get(1)) / (this.node1.get(0) - this.node2.get(0));
  }

  /**
   * y-intercept — except for a vertical edge, where the Python returns the
   * x-intercept instead and `Coords.distanceToLine`/`projectOn` read it that
   * way. Preserved.
   * @returns {number}
   */
  get q() {
    if (this.node1.get(0) === this.node2.get(0)) return this.node1.get(0);

    return (
      (this.node1.get(0) * this.node2.get(1) - this.node2.get(0) * this.node1.get(1)) /
      (this.node1.get(0) - this.node2.get(0))
    );
  }

  /** @returns {Coords} Unit vector from node1 to node2. */
  get versor() {
    return this.node2.coords.sub(this.node1.coords).normalized();
  }

  /**
   * Whether a point's along-edge coordinate falls strictly inside the segment.
   * Strict at both ends: a point exactly on `node1` or `node2` is NOT contained.
   * @param {Coords} coords
   * @returns {boolean}
   */
  contains(coords) {
    const t = this.versor.dot(coords.sub(this.node1.coords));
    return t > 0 && t < this.length;
  }

  /**
   * @param {Edge} other
   * @returns {boolean}
   */
  isAdjacent(other) {
    return (
      this.node1.equals(other.node1) ||
      this.node1.equals(other.node2) ||
      this.node2.equals(other.node1) ||
      this.node2.equals(other.node2)
    );
  }

  /**
   * Distance from a point to the segment (perpendicular where the projection
   * lands inside, endpoint distance otherwise).
   * @param {Coords} coords
   * @returns {number}
   */
  distanceTo(coords) {
    if (this.contains(coords.projectOn(this))) return coords.distanceToLine(this);

    return Math.min(this.node1.distanceTo(coords), this.node2.distanceTo(coords));
  }

  /**
   * @param {Coords} coords
   * @returns {Coords}
   */
  closestPoint(coords) {
    const projection = coords.projectOn(this);
    if (this.contains(projection)) return projection;

    return this.node1.distanceTo(coords) <= this.node2.distanceTo(coords)
      ? this.node1.coords
      : this.node2.coords;
  }

  /**
   * `edge[0]` / `edge[1]`, as the Python indexes it.
   * @param {number} index
   * @returns {Node}
   */
  get(index) {
    return index === 0 ? this.node1 : this.node2;
  }

  /** @returns {Node[]} The two endpoints, for iteration. */
  get nodes() {
    return [this.node1, this.node2];
  }

  /**
   * Identity is the ordered node pair, matching Python's `__eq__` — the reverse
   * edge is a different object and does not compare equal.
   * @param {unknown} other
   * @returns {boolean}
   */
  equals(other) {
    return other instanceof Edge && this.node1.equals(other.node1) && this.node2.equals(other.node2);
  }

  /** @returns {string} */
  toString() {
    return this.id;
  }

  /**
   * Deviation, documented: Python iterates `list(self.between_streets)`, a set,
   * so the order of the streets in the "between A and B" clause is hash order.
   * This uses insertion order (a JS `Set` preserves it), which is deterministic.
   * @returns {string}
   */
  getLlmDescription() {
    if (this.betweenStreets.size === 0) return `at the end of ${this.street}.`;

    if (this.betweenStreets.size === 1) {
      const [only] = this.betweenStreets;
      return `on ${this.street}, at the intersection with ${only}`;
    }

    const streets = [...this.betweenStreets];
    return `on ${this.street}, between ${streets.slice(0, -1).join(', ')} and ${streets[streets.length - 1]}`;
  }

  /** @returns {string} */
  getCompleteDescription() {
    let description = this.street;

    description += `, ${this.features[EdgeFeatures.SURFACE]}`;

    if (this.node1.isDeadEnd() || this.node2.isDeadEnd()) description += ', dead end';

    if (this.features[EdgeFeatures.TRAFFIC_DIRECTION] !== 'two_way') description += ', one-way';

    if (this.features[EdgeFeatures.SLOPE] !== 'flat') description += ', sloped';

    /** @type {string[]} */
    const hazards = [];
    if (this.features[EdgeFeatures.ROADWORK]) hazards.push('roadwork');
    if (this.features[EdgeFeatures.STAIRS]) hazards.push('stairs on the way');
    if (this.features[EdgeFeatures.BIKE_LANE]) hazards.push('a bike lane');

    if (hazards.length === 1) description += `, with ${hazards[0]}`;
    else if (hazards.length > 1) {
      description += `, with ${hazards.slice(0, -1).join(', ')} and ${hazards[hazards.length - 1]}`;
    }

    return description;
  }

  /**
   * How far along the block a point is, in thirds — the phrase a waypoint uses
   * when the route ends mid-block.
   * @param {Coords} coords Must lie on the edge (`contains()`).
   * @returns {string}
   * @throws {Error} when the point is not on the edge.
   */
  getDistanceDescription(coords) {
    if (!this.contains(coords)) throw new Error('Coords are not on the edge');

    const distance = this.node1.distanceTo(coords);
    const length = this.length;

    if (distance < 0.33 * length) return 'one third a block';
    if (distance < 0.66 * length) return 'half a block';
    return 'two third a block';
  }
}

/** A named street: an ordered list of the edges that make it up. */
export class Street {
  /**
   * @param {number} index
   * @param {string} name
   * @param {Edge[]} edges
   */
  constructor(index, name, edges) {
    this.index = index;
    this.name = name;
    this.edges = edges;
  }

  /** @returns {string} */
  get id() {
    return `s${this.index}`;
  }

  /**
   * @param {Street} other
   * @returns {boolean}
   */
  equals(other) {
    return Boolean(other) && this.index === other.index;
  }

  /** @returns {string} */
  toString() {
    return this.id;
  }
}
