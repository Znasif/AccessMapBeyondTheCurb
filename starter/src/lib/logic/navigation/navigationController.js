/**
 * NavigationController — owns whichever navigator is currently running and is
 * the single place guidance is started, updated, failed and cleared. Ported
 * from `explore/simple_camio_llm/src/navigation/navigation_controller.py`.
 *
 * Milestone P of `docs/browser-voice-exploration-plan.md` §4. Two Python
 * details do not survive the port, both deliberately:
 *
 *   - **the `RLock`.** JavaScript has one thread per realm and no preemption
 *     between statements, so the lock guarded nothing that can race here. The
 *     Python needed it because `guide_to_*` runs on its own thread.
 *   - **`ModulesRepository`.** The graph is passed in directly rather than
 *     resolved from a service locator.
 */

import { FlyOverNavigator } from './flyOverNavigator.js';
import { NavigationAction } from './navigator.js';
import { StreetByStreetNavigator } from './streetByStreetNavigator.js';

/**
 * Starts, drives and tears down navigators, and converts DESTINATION_REACHED
 * into "no navigator any more" before the owner sees it.
 */
export class NavigationController {
  /** Arrival radius, in inches of printed material. */
  static ARRIVED_THRESHOLD = 0.3;
  /** Beyond this the fly-over mode says "far", in inches. */
  static FAR_THRESHOLD = 4.0;
  /** Slack before a growing distance counts as the wrong way, in inches. */
  static WRONG_DIRECTION_MARGIN = 0.2;

  /**
   * @param {import('../graph.js').Graph} graph
   * @param {import('./navigator.js').ActionHandler} onAction
   * @param {object} [options]
   * @param {number} [options.feetsPerInch=1]
   * @param {() => number} [options.now] Clock in seconds, handed to navigators.
   */
  constructor(graph, onAction, options = {}) {
    const { feetsPerInch = 1, now = undefined } = options;

    this.graph = graph;
    this.now = now;

    this.arrivedThreshold = NavigationController.ARRIVED_THRESHOLD * feetsPerInch;
    this.farThreshold = NavigationController.FAR_THRESHOLD * feetsPerInch;
    this.wrongDirectionMargin = NavigationController.WRONG_DIRECTION_MARGIN * feetsPerInch;

    this.onAction = onAction;
    /** @type {import('./navigator.js').Navigator|null} */
    this.navigator = null;
  }

  /**
   * @param {string} action
   * @param {Record<string, any>} [payload]
   * @returns {void}
   * @private
   */
  _onAction(action, payload = {}) {
    if (action === NavigationAction.DESTINATION_REACHED) this.clear();
    this.onAction(action, payload);
  }

  /** @returns {boolean} */
  isNavigationRunning() {
    return this.navigator !== null;
  }

  /**
   * @param {import('../graph.js').WayPoint[]} waypoints
   * @returns {boolean} False when there is nothing to navigate.
   */
  navigateStreetByStreet(waypoints) {
    if (waypoints.length === 0) return false;

    this.navigator = new StreetByStreetNavigator(
      this.graph,
      this.arrivedThreshold,
      this.wrongDirectionMargin,
      (action, payload) => this._onAction(action, payload),
      waypoints,
      this.now,
    );

    return true;
  }

  /**
   * @param {import('../graph.js').WayPoint} destination
   * @returns {boolean}
   */
  navigate(destination) {
    this.navigator = new FlyOverNavigator(
      this.graph,
      this.arrivedThreshold,
      this.farThreshold,
      (action, payload) => this._onAction(action, payload),
      destination,
      this.now,
    );

    return true;
  }

  /**
   * @param {import('../positionHandler.js').PositionInfo} position
   * @param {boolean} [ignoreNotMoving=false] True while the LLM or the speech
   *   queue is busy — it keeps a not-yet-started navigator from starting and
   *   keeps the stall timer from firing.
   * @returns {void}
   */
  update(position, ignoreNotMoving = false) {
    if (this.navigator === null) return;

    if (!this.navigator.isRunning()) {
      if (!ignoreNotMoving) this.navigator.start(position);
    } else {
      this.navigator.update(position, ignoreNotMoving);
    }
  }

  /**
   * Tell the current navigator its requested reroute is not coming.
   * @returns {void}
   */
  routeFailed() {
    if (this.navigator !== null) this.navigator.routeFailed();
  }

  /** @returns {void} */
  clear() {
    this.navigator = null;
  }
}
