/**
 * PositionHandler + PositionInfo — turning a stream of raw pointer samples into
 * "you are on X". Ported from
 * `explore/simple_camio_llm/src/position/position_handler.py` and
 * `position_info.py`.
 *
 * Milestone P of `docs/browser-voice-exploration-plan.md` §4:
 *
 *   > `position/position_handler.py` → (u,v) → snapped position, already partly
 *   > in `usePinGrid.js`
 *
 * Platform-free. Two Python globals become explicit inputs:
 *   - `config.feets_per_pixel` / `config.feets_per_inch` → constructor options;
 *   - `time.time()` → an injected `now()` in seconds, so the hysteresis and
 *     expiry rules are testable without sleeping.
 *
 * The units, unchanged from the Python: incoming samples are in **template
 * pixels** and are multiplied by `feetsPerPixel` on the way in; the graph's own
 * coordinates are already in feet; the thresholds below are in inches of
 * *printed material* and are multiplied by `feetsPerInch` (the map's scale) at
 * construction.
 */

import { Coords } from './coords.js';
import { Node } from './node.js';
import { Edge } from './edge.js';
import { PoI } from './poi.js';
import { ArithmeticBuffer } from './buffer.js';

/** Which way the finger is travelling along the edge it is on. */
export const MovementDirection = Object.freeze({
  NONE: 'NONE',
  FORWARD: 'FORWARD',
  BACKWARD: 'BACKWARD',
});

/**
 * One resolved reading: where the pointer is, what graph element it belongs to,
 * and how to say it.
 *
 * Immutable, like the Python's frozen dataclass.
 */
export class PositionInfo {
  /** Seconds a reading stays "still valid". */
  static DEFAULT_MAX_LIFE = 6.0;

  /** @type {PositionInfo} The empty reading. */
  static NONE;

  /**
   * @param {Coords} realPos
   * @param {Coords|Node|Edge|PoI|null} [graphElement=null]
   * @param {string} [description='']
   * @param {object} [options]
   * @param {string} [options.movement] One of {@link MovementDirection}.
   * @param {number} [options.maxLife]
   * @param {number} [options.timestamp] Seconds. Callers pass their own clock.
   */
  constructor(realPos, graphElement = null, description = '', options = {}) {
    this.realPos = realPos;
    this.graphElement = graphElement;
    this.description = description;
    this.movement = options.movement ?? MovementDirection.NONE;
    this.maxLife = options.maxLife ?? PositionInfo.DEFAULT_MAX_LIFE;
    this.timestamp = options.timestamp ?? 0;

    Object.freeze(this);
  }

  /** @returns {number} Distance from the reading to its own graph element. */
  get distance() {
    return this.getDistanceToGraphElement(this.realPos);
  }

  /**
   * @param {Coords} pos
   * @returns {number} `Infinity` when there is no element.
   */
  getDistanceToGraphElement(pos) {
    if (this.graphElement === null) return Infinity;
    return this.graphElement.distanceTo(pos);
  }

  /**
   * @param {number} now Current time in seconds.
   * @returns {boolean}
   */
  isStillValid(now) {
    return now - this.timestamp < this.maxLife;
  }

  /** @returns {Coords} The reading snapped onto its graph element. */
  snapToGraph() {
    if (this.graphElement === null) return this.realPos;
    return this.graphElement.closestPoint(this.realPos);
  }

  /** @returns {string} */
  get completeDescription() {
    if (this.graphElement === null) return '';
    return this.graphElement.getCompleteDescription();
  }

  /** @returns {boolean} */
  isNode() {
    return this.graphElement instanceof Node;
  }

  /** @returns {boolean} */
  isEdge() {
    return this.graphElement instanceof Edge;
  }

  /** @returns {boolean} */
  isPoi() {
    return this.graphElement instanceof PoI;
  }

  /** @returns {string} */
  toString() {
    return this.description;
  }

  /**
   * Same element and wording, new position and a fresh timestamp.
   * @param {PositionInfo} info
   * @param {Coords} pos
   * @param {number} [timestamp=0]
   * @returns {PositionInfo}
   */
  static copy(info, pos, timestamp = 0) {
    return new PositionInfo(pos, info.graphElement, info.description, {
      maxLife: info.maxLife,
      timestamp,
    });
  }
}

// Deviation, documented: Python builds `PositionInfo.NONE` at import time with
// `default_factory=time.time`, so `NONE.is_still_valid()` is accidentally true
// for the first six seconds of the *process*, whenever that happened to be.
// Timestamp 0 replaces that accident with the caller's own epoch: with a
// wall-clock `now()` NONE is always stale (which is what "no reading yet"
// means), and with a test clock starting at 0 it reproduces the Python's
// startup window exactly.
PositionInfo.NONE = new PositionInfo(Coords.ZERO, null, '', { timestamp: 0 });

/**
 * Resolves averaged pointer samples against the graph.
 *
 * The order of the tests in `getPositionInfo()` is the whole design: POIs beat
 * nodes beat edges, and a node or POI you are already on keeps winning until
 * you are `GRAVITY_EFFECT` beyond its own radius. Without that hysteresis the
 * announcement flickers between an intersection and the street it is on while
 * the finger sits still.
 */
export class PositionHandler {
  /** Extra tolerance outside the map bounds, in inches. */
  static MAP_MARGIN = 1.0;

  /** Snap radius for edges, in inches. */
  static EDGES_MIN_DISTANCE = 0.3;
  /** Snap radius for nodes, in inches. */
  static NODES_MIN_DISTANCE = 0.15;
  /** Snap radius for POIs, in inches. */
  static POIS_MIN_DISTANCE = 0.25;

  /** Hysteresis added to the radius of the element already held, in inches. */
  static GRAVITY_EFFECT = 0.2;
  /** Minimum travel before a sample counts as movement, in inches. */
  static MOVEMENT_THRESHOLD = 0.125;

  /**
   * @param {import('./graph.js').Graph} graph
   * @param {object} [options]
   * @param {number} [options.feetsPerInch=1]
   * @param {number} [options.feetsPerPixel=1]
   * @param {() => number} [options.now] Clock in seconds.
   */
  constructor(graph, options = {}) {
    const { feetsPerInch = 1, feetsPerPixel = 1, now = () => Date.now() / 1000 } = options;

    this.graph = graph;
    this.feetsPerPixel = feetsPerPixel;
    this.now = now;

    const mapMargin = PositionHandler.MAP_MARGIN * feetsPerInch;
    this.edgesMinDistance = PositionHandler.EDGES_MIN_DISTANCE * feetsPerInch;
    this.nodesMinDistance = PositionHandler.NODES_MIN_DISTANCE * feetsPerInch;
    this.poisMinDistance = PositionHandler.POIS_MIN_DISTANCE * feetsPerInch;
    this.pointsGravity = PositionHandler.GRAVITY_EFFECT * feetsPerInch;
    this.movementThreshold = PositionHandler.MOVEMENT_THRESHOLD * feetsPerInch;

    const [minCorner, maxCorner] = graph.bounds;
    this.minCorner = minCorner.sub(mapMargin);
    this.maxCorner = maxCorner.add(mapMargin);

    /** @type {ArithmeticBuffer<Coords>} */
    this.positionsBuffer = new ArithmeticBuffer(20, 2.0, now);

    this.lastInfo = PositionInfo.NONE;
  }

  /** @returns {void} */
  clear() {
    this.positionsBuffer.clear();
    this.lastInfo = PositionInfo.NONE;
  }

  /** @returns {Coords|null} Oldest live sample. */
  get lastPosition() {
    return this.positionsBuffer.first();
  }

  /** @returns {Coords} Position of the most recent reading. */
  get currentPosition() {
    return this.lastInfo.realPos;
  }

  /**
   * @param {Coords} pos In feet.
   * @returns {boolean}
   */
  isValidPosition(pos) {
    return (
      this.minCorner.get(0) <= pos.x &&
      pos.x < this.maxCorner.get(0) &&
      this.minCorner.get(1) <= pos.y &&
      pos.y < this.maxCorner.get(1)
    );
  }

  /**
   * Feed one raw sample, **in template pixels**.
   * @param {Coords} pos
   * @returns {boolean} Whether it landed inside the map.
   */
  processPosition(pos) {
    const scaled = pos.mul(this.feetsPerPixel);

    if (this.isValidPosition(scaled)) {
      this.positionsBuffer.add(scaled);
      return true;
    }

    return false;
  }

  /**
   * Resolve the buffered samples to a reading, and remember it.
   * @returns {PositionInfo}
   */
  getPositionInfo() {
    const positionInfo = this._resolve();
    this.lastInfo = positionInfo;
    return positionInfo;
  }

  /**
   * @returns {PositionInfo}
   * @private
   */
  _resolve() {
    const pos = this.positionsBuffer.average();
    if (pos === null) return PositionInfo.NONE;

    if (this._shouldStickToLast(pos)) return PositionInfo.copy(this.lastInfo, pos, this.now());

    const nearestPoiInfo = this.getNearestPoiInfo(pos);
    if (nearestPoiInfo.distance <= this.poisMinDistance) return nearestPoiInfo;

    const nearestNodeInfo = this.getNearestNodeInfo(pos);
    if (nearestNodeInfo.distance <= this.nodesMinDistance) return nearestNodeInfo;

    const nearestEdgeInfo = this.getNearestEdgeInfo(pos);
    if (nearestEdgeInfo.distance <= this.edgesMinDistance) return nearestEdgeInfo;

    return new PositionInfo(pos, null, '', { timestamp: this.now() });
  }

  /**
   * Hysteresis: a node or POI already held keeps the reading until the pointer
   * is its own radius **plus** `GRAVITY_EFFECT` away. Edges get no gravity.
   * @param {Coords} pos
   * @returns {boolean}
   * @private
   */
  _shouldStickToLast(pos) {
    if (!this.lastInfo.isNode() && !this.lastInfo.isPoi()) return false;

    const baseDistance = this.lastInfo.isNode() ? this.nodesMinDistance : this.poisMinDistance;

    return this.lastInfo.getDistanceToGraphElement(pos) <= baseDistance + this.pointsGravity;
  }

  /**
   * @param {Coords} pos
   * @returns {PositionInfo}
   */
  getNearestNodeInfo(pos) {
    const [nearestNode, distance] = this.graph.getNearestNode(pos);

    if (distance > this.nodesMinDistance) return PositionInfo.NONE;

    // Nodes are not immediately announced, hence the doubled life.
    return new PositionInfo(pos, nearestNode, '', {
      maxLife: PositionInfo.DEFAULT_MAX_LIFE * 2,
      timestamp: this.now(),
    });
  }

  /**
   * @param {Coords} pos
   * @returns {PositionInfo}
   */
  getNearestPoiInfo(pos) {
    const [nearestPoi, distance] = this.graph.getNearestPoi(pos);

    if (nearestPoi === null || distance > this.poisMinDistance) return PositionInfo.NONE;

    return new PositionInfo(pos, nearestPoi, nearestPoi.name, {
      maxLife: PositionInfo.DEFAULT_MAX_LIFE * 2,
      timestamp: this.now(),
    });
  }

  /**
   * @param {Coords} pos
   * @returns {PositionInfo}
   */
  getNearestEdgeInfo(pos) {
    const [nearestEdge, distanceEdge] = this.graph.getNearestEdge(pos);
    if (distanceEdge > this.edgesMinDistance) return PositionInfo.NONE;

    const movementDir = this.getEdgeMovementDirection(pos, nearestEdge);
    if (
      this.lastInfo.graphElement instanceof Edge &&
      this.lastInfo.graphElement.equals(nearestEdge) &&
      movementDir === MovementDirection.NONE
    ) {
      // No movement and still on the same edge -> same announcement. This is
      // what stops the street name being re-announced the moment you stop.
      return PositionInfo.copy(this.lastInfo, pos, this.now());
    }

    return new PositionInfo(pos, nearestEdge, nearestEdge.street, {
      movement: movementDir,
      timestamp: this.now(),
    });
  }

  /**
   * Direction of travel projected onto the edge, or NONE when the pointer is
   * barely moving or moving across the edge rather than along it (>60°).
   * @param {Coords} currentPosition
   * @param {Edge} edge
   * @returns {string} One of {@link MovementDirection}.
   */
  getEdgeMovementDirection(currentPosition, edge) {
    if (!this.lastInfo.isStillValid(this.now())) return MovementDirection.NONE;

    const lastPosition = this.lastPosition;
    if (lastPosition === null) return MovementDirection.NONE;

    const movementVector = currentPosition.sub(lastPosition);
    if (movementVector.length() < this.movementThreshold) return MovementDirection.NONE;

    const edgeVersor = edge.get(1).coords.sub(edge.get(0).coords).normalized();
    const dot = edgeVersor.dot(movementVector.normalized());

    if (Math.abs(dot) < 0.5) return MovementDirection.NONE; // angle greater than 60 degrees
    return dot > 0 ? MovementDirection.FORWARD : MovementDirection.BACKWARD;
  }
}
