/**
 * Navigator — the base class every guidance mode extends, ported from
 * `explore/simple_camio_llm/src/navigation/navigator.py`.
 *
 * Milestone P of `docs/browser-voice-exploration-plan.md` §4:
 *
 *   > `navigation/` — `street_by_street_navigator`, `fly_over_navigator`,
 *   > `navigation_controller` → `route_to` execution + the `route_failed()` chain
 *
 * Platform-free. `on_action(action, **kwargs)` becomes
 * `onAction(action, payload)` with a plain object payload.
 */

/** What a navigator is telling its owner. */
export const NavigationAction = Object.freeze({
  NEW_ROUTE: 'NEW_ROUTE',
  WAYPOINT_REACHED: 'WAYPOINT_REACHED',
  DESTINATION_REACHED: 'DESTINATION_REACHED',
  ANNOUNCE_DIRECTION: 'ANNOUNCE_DIRECTION',
  WRONG_DIRECTION: 'WRONG_DIRECTION',
});

/**
 * @typedef {(action: string, payload?: Record<string, any>) => void} ActionHandler
 */

/**
 * Abstract guidance driver. Subclasses implement `update()`.
 */
export class Navigator {
  /**
   * @param {import('../graph.js').Graph} graph
   * @param {ActionHandler} onAction
   * @param {() => number} [now] Clock in seconds.
   */
  constructor(graph, onAction, now = () => Date.now() / 1000) {
    this.graph = graph;
    this.onAction = onAction;
    this.now = now;

    this._running = false;
  }

  /**
   * @param {import('../positionHandler.js').PositionInfo} _position
   * @returns {void}
   */
  start(_position) {
    this._running = true;
  }

  /** @returns {boolean} */
  isRunning() {
    return this._running;
  }

  /**
   * @param {import('../positionHandler.js').PositionInfo} _position
   * @param {boolean} _ignoreNotMoving
   * @returns {void}
   * @abstract
   */
  update(_position, _ignoreNotMoving) {
    throw new Error('Navigator.update() is abstract');
  }

  /**
   * @param {import('../coords.js').Coords} start
   * @param {import('../coords.js').Coords} destination
   * @returns {void}
   * @protected
   */
  _newRouteNeeded(start, destination) {
    this.onAction(NavigationAction.NEW_ROUTE, { start, destination });
  }

  /**
   * A reroute this navigator asked for never arrived.
   *
   * Nothing to undo by default; subclasses that pause themselves while waiting
   * have to resume here, or they wait forever.
   *
   * @returns {void}
   */
  routeFailed() {}

  /**
   * @param {import('../graph.js').WayPoint} waypoint
   * @returns {void}
   * @protected
   */
  _waypointReached(waypoint) {
    this.onAction(NavigationAction.WAYPOINT_REACHED, { waypoint });
  }

  /**
   * @param {import('../graph.js').WayPoint} waypoint
   * @returns {void}
   * @protected
   */
  _destinationReached(waypoint) {
    this._running = false;
    this.onAction(NavigationAction.DESTINATION_REACHED, { waypoint });
  }

  /**
   * @returns {void}
   * @protected
   */
  _wrongDirection() {
    this.onAction(NavigationAction.WRONG_DIRECTION);
  }

  /**
   * @param {string} instructions
   * @returns {void}
   * @protected
   */
  _announceDirections(instructions) {
    this.onAction(NavigationAction.ANNOUNCE_DIRECTION, { instructions });
  }
}
