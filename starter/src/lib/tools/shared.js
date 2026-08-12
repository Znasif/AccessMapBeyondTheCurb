/**
 * Helpers shared by the six M7 tool handlers.
 *
 * The one rule this file exists to enforce: **`data` is built by an explicit
 * allowlist, and an adapter object is never spread into it.**
 * `AudiomWorldAdapter`'s Place carries `props` by reference to the entire raw
 * feature property bag — deliberately unfiltered, so `placeIndex` can embed it —
 * so `{...place}` in a handler is kilobytes of ArcGIS attributes in an
 * 8192-token window. `projectPlace()` below is the only way a Place becomes
 * `data`.
 *
 * Platform-free.
 */

import { isUnsupported } from '../worldAdapter.js';
import { MAX_ADJACENT } from '../toolResult.js';

/**
 * A Place, reduced to what can be spoken.
 *
 * ⚠️ `description` is opt-**out** for a reason found by the parity benchmark. This
 * projector is used in two very different positions: once for the single place a
 * question is about, and once **per entry of a list** —
 * `describe_surroundings` returns five, `whats_here` three. `MAX_RESULT_CHARS`
 * is 1200 and `capSize` answers an over-large `data` by trimming arrays *to
 * their first element*, so a world whose places carry descriptive prose silently
 * answers "what is around me" with one place out of five, marked only by a
 * `limits` entry. Measured on `explore/simple_camio_llm/models/detroit_conant`:
 * 88 of 1,764 sampled positions truncated that way.
 *
 * Neither shipped adapter sets a top-level `description` today (camio keeps
 * its POI prose in `props`), so this is defensive rather than a behaviour
 * change — but the next adapter that does would not have found out.
 *
 * @param {object} place
 * @param {{categories?: number, description?: boolean}} [options]
 * @returns {object}
 */
export function projectPlace(place, { categories = 2, description = true } = {}) {
  if (!place) return null;
  const out = { name: place.name };
  if (place.category) {
    out.category = String(place.category).split(',').map((c) => c.trim()).filter(Boolean)
      .slice(0, categories).join(', ');
  }
  if (description && place.description) out.description = place.description;
  return out;
}

/**
 * The `(u, v)` an adapter should be given.
 *
 * Window uv, not material uv: every adapter's `at()` / `nearby()` /
 * `distanceTo()` / `bearingTo()` interpolates across the *window*, while
 * `surface.acuityCell()` quantizes over the *material*. The two coincide unless
 * the material is letterboxed, which is exactly why the mistake is silent.
 *
 * @param {object} ctx TurnContext.
 * @returns {{u: number, v: number}|null}
 */
export function windowUv(ctx) {
  return ctx?.windowUv || ctx?.uv || null;
}

/**
 * Named things beside a point, with a direction and a distance each.
 *
 * `null` — never `[]` — when the world cannot answer: an empty array reads as
 * "nothing is adjacent", which is a different and false claim.
 *
 * @param {object} adapter
 * @param {object} ctx
 * @param {object} [options]
 * @param {string} [options.excludeId] Usually the place under the finger.
 * @param {number} [options.radius]
 * @param {number} [options.limit]
 * @param {string} [options.category] Substring filter over the category string.
 * @returns {Array<object>|null}
 */
export function adjacentTo(adapter, ctx, {
  excludeId,
  radius,
  limit = MAX_ADJACENT,
  category,
} = {}) {
  const uv = windowUv(ctx);
  if (!uv) return null;
  const near = adapter.nearby(uv.u, uv.v, radius);
  if (isUnsupported(near) || !Array.isArray(near)) return null;

  const wanted = category ? String(category).trim().toLowerCase() : null;
  const out = [];
  for (const place of near) {
    if (out.length >= limit) break;
    if (excludeId !== undefined && place.id === excludeId) continue;
    if (wanted && !String(place.category || '').toLowerCase().includes(wanted)) continue;
    out.push(describeNeighbour(adapter, uv, place));
  }
  return out;
}

/**
 * One neighbour: name, how far, and which way — in world-native terms only.
 *
 * @param {object} adapter
 * @param {{u: number, v: number}} uv
 * @param {object} place
 */
export function describeNeighbour(adapter, uv, place) {
  // A list entry is a name, a distance and a direction. The prose belongs to
  // `get_place_details`, which asks about one place at a time — see the
  // truncation note on `projectPlace`.
  const entry = projectPlace(place, { description: false });
  // `nearby()` returns `{value, units}` in both adapters as of M7; the unit is
  // reported once on the envelope, so only the number travels here.
  if (place.distance && Number.isFinite(place.distance.value)) {
    entry.distance = round(place.distance.value);
  }
  const bearing = safeBearing(adapter, uv, place);
  if (bearing?.direction) entry.direction = bearing.direction;
  return entry;
}

/** `bearingTo` that never throws and never returns a sentinel to a caller. */
export function safeBearing(adapter, uv, target) {
  try {
    const bearing = adapter.bearingTo(uv.u, uv.v, target);
    if (!bearing || isUnsupported(bearing) || bearing.candidates) return null;
    return bearing;
  } catch {
    return null;
  }
}

/** Two decimals is more precision than a fingertip has, and it costs tokens. */
export function round(value, places = 1) {
  if (!Number.isFinite(value)) return value;
  const f = 10 ** places;
  return Math.round(value * f) / f;
}
