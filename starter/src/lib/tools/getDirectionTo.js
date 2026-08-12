/**
 * `get_direction_to` — which way to move the finger.
 *
 * ## The vocabulary is MapIO's, and it is not a clock face
 *
 * Eight cardinal directions in 45° steps past a 22.5° threshold
 * (`graph.py:738` / `direction.js`), plus turn-relative continuation
 * (`graph.py:568`: `"Continue straight" if same_direction else f"Head
 * {direction}"`). There is no clock face in MapIO and there is none here. In the
 * geographic frame the eight words are compass words; in `enu` and `image` they
 * are sheet-relative — `top`, `top right`, `right`, … — because the schema's
 * `$note` is explicit that saying "north" about a skeleton diagram is a bug.
 * `bearingFromDelta` cannot produce a compass word outside the geographic frame,
 * so that is structural rather than remembered.
 *
 * ## When the heading is NONE
 *
 * A finger's heading is **intermittent, not absent**: MapIO derives one from
 * `current - last` gated on a movement threshold, so a still finger, a finger
 * moving less than 0.125 inches, and a heading that has aged out all report
 * nothing. That is the normal case, not the edge case, and it is designed for
 * rather than worked around:
 *
 *   - the **absolute** direction needs no heading and is always present;
 *   - the **turn-relative** phrase is additive, offered only when the heading is
 *     fresh, and marked as such (`relative: true`).
 *
 * So the degraded answer is *"head north-east"* rather than *"continue
 * straight"* — which is exactly what `processInstructions` emits for its own
 * first leg, where there is no previous versor either. Nothing is fabricated,
 * nothing is withheld, and a caller can tell the two apart.
 */

import { STATUS, limit } from '../toolResult.js';
import { continuation } from '../direction.js';
import { projectPlace, safeBearing, windowUv, round } from './shared.js';

export const NAME = 'get_direction_to';

/**
 * @param {{place: string, $place?: object}} args
 * @param {object} ctx
 * @param {{adapter: object}} api
 */
export function getDirectionTo(args, ctx, { adapter }) {
  const place = args.$place;
  const uv = windowUv(ctx);
  if (!place || !uv) {
    return {
      status: STATUS.ERROR,
      tool: NAME,
      error: place ? 'no_position' : 'unresolved_place',
      message: place ? 'I do not know where your finger is.' : `I could not find "${args.place}".`,
    };
  }

  const bearing = safeBearing(adapter, uv, place);
  if (!bearing) {
    return {
      status: STATUS.PARTIAL,
      tool: NAME,
      data: { place: projectPlace(place), direction: null },
      limits: [limit('direction', 'no_geometry', 'I know that place by name but not where it is on this map.')],
      units: { direction: null },
    };
  }

  if (bearing.method === 'inside' || !bearing.direction) {
    // No honest direction to a place you are already on. Inventing one would
    // send a finger off the feature it just found.
    return {
      status: STATUS.OK,
      tool: NAME,
      data: { place: projectPlace(place), direction: null, here: true },
      units: { direction: null },
    };
  }

  const data = {
    place: projectPlace(place),
    direction: bearing.direction,
    degrees: round(bearing.degrees, 0),
  };

  // The turn-relative layer, when and only when a heading exists.
  const step = continuation(...deltaFor(adapter, uv, bearing), ctx?.heading, adapter.frame);
  if (step) {
    data.phrase = step.phrase;
    data.relative = step.relative;
  }

  const distance = adapter.distanceTo?.(uv.u, uv.v, place);
  if (distance && Number.isFinite(distance.value)) data.distance = round(distance.value);

  return {
    status: STATUS.OK,
    tool: NAME,
    data,
    units: { direction: bearing.vocabulary },
  };
}

/**
 * Recover a metric-plane displacement from a bearing's `degrees`.
 *
 * `continuation()` needs a vector, and `degrees` is the vector's whole content
 * once normalised — going back to the adapter for the nearest geometry point a
 * second time would double the cost of the tool for no extra information.
 *
 * @returns {[number, number]} `[dx, dy]`, y **down**.
 */
function deltaFor(_adapter, _uv, bearing) {
  const radians = (bearing.degrees * Math.PI) / 180;
  return [Math.sin(radians), -Math.cos(radians)];
}

/**
 * The heading decides "Continue straight" versus "Head north-east", so it must
 * be in the memo key — see `ToolRegistry#memoKey`. The absolute direction does
 * not depend on it, which is exactly why only the phrase changes on a hit.
 */
getDirectionTo.memoTag = (ctx) => `heading:${ctx?.heading?.cardinal ?? 'none'}`;

export default getDirectionTo;
