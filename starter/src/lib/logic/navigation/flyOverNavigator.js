/**
 * FlyOverNavigator — "fly me there" guidance: no route, just a heading toward
 * the destination, repeated on an interval. Ported from
 * `explore/simple_camio_llm/src/navigation/fly_over_navigator.py`.
 *
 * Milestone P of `docs/browser-voice-exploration-plan.md` §4. This is the mode
 * the plan keeps for worlds with no routable geometry (§3: `route_to` on a
 * `.camio` map is offered with the enum narrowed to `fly_me_there`).
 */

import { DIRECTIONS, CardinalDirection } from '../coords.js';
import { Navigator } from './navigator.js';

const NORTH_INDEX = DIRECTIONS.indexOf(CardinalDirection.NORTH);

/**
 * Announces the dominant axis of the error vector as a cardinal direction.
 *
 * The direction is deliberately coarse — only N/S/E/W can come out of it, since
 * the index arithmetic steps by 2 through the 8-entry `DIRECTIONS` list — and
 * gains a "far " prefix beyond `farThreshold`.
 */
export class FlyOverNavigator extends Navigator {
  /** Minimum seconds between two spoken headings. */
  static ANNOUNCEMENTS_INTERVAL = 1.25;

  /**
   * @param {import('../graph.js').Graph} graph
   * @param {number} arrivedThreshold Feet.
   * @param {number} farThreshold Feet.
   * @param {import('./navigator.js').ActionHandler} onAction
   * @param {import('../graph.js').WayPoint} destination
   * @param {() => number} [now]
   */
  constructor(graph, arrivedThreshold, farThreshold, onAction, destination, now = undefined) {
    super(graph, onAction, now);

    this.arrivedThreshold = arrivedThreshold;
    this.farThreshold = farThreshold;

    this.destination = destination;
    this.lastAnnouncementTimestamp = 0.0;
  }

  /**
   * @param {import('../positionHandler.js').PositionInfo} position
   * @param {boolean} _ignoreNotMoving
   * @returns {void}
   */
  update(position, _ignoreNotMoving) {
    if (!this.isRunning()) return;

    const distance = position.realPos.distanceTo(this.destination.coords);
    if (distance < this.arrivedThreshold) {
      this._destinationReached(this.destination);
      return;
    }

    // Faithful to the Python, and worth flagging: the interval is measured
    // against `position.timestamp` (when the *sample* was taken) while
    // `_announceDirections` stamps `now()`. With the two clocks in agreement
    // this is just an interval; with a replayed or stale position stream the
    // gate opens on sample time and closes on wall time. Reported, not fixed.
    const currentTime = position.timestamp;
    if (currentTime - this.lastAnnouncementTimestamp < FlyOverNavigator.ANNOUNCEMENTS_INTERVAL) {
      return;
    }

    const error = this.destination.coords.sub(position.realPos);
    const maxIndex = Math.abs(error.get(0)) >= Math.abs(error.get(1)) ? 0 : 1;

    let direction =
      DIRECTIONS[
        (NORTH_INDEX + (maxIndex + 1) * 2 + (error.get(maxIndex) < 0 ? 4 : 0)) % DIRECTIONS.length
      ];

    if (distance > this.farThreshold) direction = `far ${direction}`;

    this._announceDirections(direction);
  }

  /**
   * @param {string} instructions
   * @returns {void}
   * @protected
   */
  _announceDirections(instructions) {
    this.lastAnnouncementTimestamp = this.now();
    super._announceDirections(instructions);
  }
}
