/**
 * StreetByStreetNavigator — turn-by-turn guidance along a waypoint list, ported
 * from `explore/simple_camio_llm/src/navigation/street_by_street_navigator.py`.
 *
 * Milestone P of `docs/browser-voice-exploration-plan.md` §4. Platform-free;
 * the clock is injected (`now()` in seconds) instead of `time.time()`.
 */

import { Coords } from '../coords.js';
import { ArithmeticBuffer } from '../buffer.js';
import { MovementDirection, PositionInfo } from '../positionHandler.js';
import { Navigator } from './navigator.js';

/**
 * Walks a route one waypoint at a time, announcing each leg, watching for
 * arrival, wrong turns and stalls.
 */
export class StreetByStreetNavigator extends Navigator {
  /**
   * How long the pointer may fail to progress before a reroute is requested.
   *
   * One second, and a finger on a tactile map pauses constantly — which is why
   * the Python's top-of-file comment argues the Routes API had no business on
   * this path.
   */
  static NEXT_STEP_INTERVAL = 1.0;

  /**
   * @param {import('../graph.js').Graph} graph
   * @param {number} arrivedThreshold Feet.
   * @param {number} wrongDirectionMargin Feet.
   * @param {import('./navigator.js').ActionHandler} onAction
   * @param {import('../graph.js').WayPoint[]} waypoints
   * @param {() => number} [now]
   */
  constructor(graph, arrivedThreshold, wrongDirectionMargin, onAction, waypoints, now = undefined) {
    super(graph, onAction, now);

    if (waypoints.length === 0) throw new Error('Waypoints list cannot be empty');

    this.arrivedThreshold = arrivedThreshold;
    this.wrongDirectionMargin = wrongDirectionMargin;

    /** @type {import('../graph.js').WayPoint[]} */
    this._waypoints = [...waypoints];

    /** @type {ArithmeticBuffer<Coords>} */
    this.positionsBuffer = new ArithmeticBuffer(10, 2.0, this.now);
    this.lastPositionInfo = PositionInfo.NONE;
    this._stopTimestamp = 0.0;

    this._onWaypoint = false;
    this._waitingNewRoute = false;
  }

  /** @returns {boolean} */
  isRunning() {
    return super.isRunning() && this._waypoints.length > 0;
  }

  /**
   * @param {PositionInfo} position
   * @returns {void}
   */
  start(position) {
    if (this.isRunning()) return;

    const firstWaypoint = this._waypoints[0];
    if (firstWaypoint.coords.distanceTo(position.realPos) < this.arrivedThreshold) {
      this._waypoints.shift();
    }

    if (this._waypoints.length === 0) {
      this._destinationReached(firstWaypoint);
      return;
    }

    super.start(position);
    this._announceDirections(this._waypoints[0].instructions);
    this._stopTimestamp = this.now();
  }

  /** @returns {Coords} */
  get averagePosition() {
    return this.positionsBuffer.average() ?? Coords.ZERO;
  }

  /**
   * @param {PositionInfo} position
   * @param {boolean} ignoreNotMoving
   * @returns {void}
   */
  update(position, ignoreNotMoving) {
    if (!this.isRunning()) return;

    const currentTime = this.now();
    if (ignoreNotMoving || this._hasChangedPosition(position)) this._stopTimestamp = currentTime;

    if (this._waitingNewRoute || position.graphElement === null) return;

    const distance = position.realPos.distanceTo(this._waypoints[0].coords);

    const currentWaypoint = this._waypoints[0];
    if (distance < this.arrivedThreshold) {
      if (this._waypoints.length === 1) {
        this._waypoints.shift();
        this._destinationReached(currentWaypoint);
      } else if (!this._onWaypoint) {
        this._onWaypoint = true;
        this._waypointReached(currentWaypoint);
      } else if (currentTime - this._stopTimestamp > StreetByStreetNavigator.NEXT_STEP_INTERVAL) {
        this._waypoints.shift();
        this._stopTimestamp = currentTime;
        this._onWaypoint = false;
        this._announceDirections(this._waypoints[0].instructions);
      }
    } else if (currentTime - this._stopTimestamp > StreetByStreetNavigator.NEXT_STEP_INTERVAL) {
      this._stopTimestamp = currentTime;
      this._newRouteNeeded(position.realPos, this._waypoints[this._waypoints.length - 1].coords);
    } else if (this._movingInWrongDirection(position)) {
      this._onWaypoint = false;
      this._wrongDirection();
    } else {
      this._onWaypoint = false;
    }

    this.lastPositionInfo = position;
    this.positionsBuffer.add(position.realPos);
  }

  /**
   * @param {PositionInfo} position
   * @returns {boolean}
   * @private
   */
  _hasChangedPosition(position) {
    const previous = this.lastPositionInfo.graphElement;
    const current = position.graphElement;

    // Every graph element type's `equals()` starts with an `instanceof` guard,
    // so a cross-type comparison is safely false — matching Python's `!=`.
    const sameElement =
      current === previous || (current !== null && previous !== null && current.equals(previous));

    return !sameElement || position.movement !== MovementDirection.NONE;
  }

  /**
   * Walking distance to the next waypoint has grown by more than the margin
   * since the buffered average position. Uses graph distance, not straight
   * line, so walking around a block does not read as a wrong turn.
   * @param {PositionInfo} position
   * @returns {boolean}
   * @private
   */
  _movingInWrongDirection(position) {
    const averagePosition = this.averagePosition;
    if (averagePosition.equals(Coords.ZERO)) return false;

    const currentDistance = this.graph.getDistance(position.realPos, this._waypoints[0].coords);
    const lastDistance = this.graph.getDistance(averagePosition, this._waypoints[0].coords);

    return currentDistance > lastDistance + this.wrongDirectionMargin;
  }

  /**
   * @param {Coords} start
   * @param {Coords} destination
   * @returns {void}
   * @protected
   */
  _newRouteNeeded(start, destination) {
    this._waitingNewRoute = true;
    super._newRouteNeeded(start, destination);
  }

  /**
   * A requested reroute failed.
   *
   * `update()` returns early while `_waitingNewRoute` is set, and the flag was
   * only ever cleared by being replaced: a successful reroute builds a whole
   * new navigator and drops this one. When the reroute fails instead, nothing
   * replaces it, so without this the object stays frozen — no announcements, no
   * further reroute attempts, silence for the rest of the session. Resuming
   * keeps the old waypoints live and lets the stall timer ask again.
   *
   * @returns {void}
   */
  routeFailed() {
    this._waitingNewRoute = false;
  }
}
