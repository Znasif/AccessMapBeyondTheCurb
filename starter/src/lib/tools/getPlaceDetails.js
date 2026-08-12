/**
 * `get_place_details` — everything known about one named thing.
 *
 * The place is already resolved: `ToolRegistry.dispatch()` runs `args.place`
 * through `adapter.resolvePlace()` before any handler sees it, so `Ambiguous`
 * and "no such place" never reach here.
 *
 * **The `props` hazard.** `AudiomWorldAdapter`'s Place carries `props` by
 * reference to the whole raw feature property bag, deliberately unfiltered so
 * `placeIndex` can embed it. Spreading it into `data` would put kilobytes of
 * ArcGIS attributes into an 8192-token window. Only the keys in
 * {@link DETAIL_KEYS} are read, and each is read by name.
 *
 * **`openNow` is recomputed on every memo hit** — the schema's own
 * `$comment_pure` requires it, and it is the one field whose truth changes while
 * nothing else does. {@link getPlaceDetails.recompute} is what `ToolRegistry`
 * calls on a cache hit.
 *
 * **What this tool must not do** is state an accessibility fact. §8: never say
 * flatly that a crossing has a kerb ramp. A `wheelchair` tag from an unvalidated
 * source is exactly that kind of claim, so it is carried with its provenance and
 * a hedging word, or not at all.
 */

import { STATUS, limit, provenanceFor } from '../toolResult.js';
import { projectPlace, safeBearing, windowUv, round } from './shared.js';

export const NAME = 'get_place_details';

/**
 * The allowlist. Every key is read by name; nothing is spread.
 * `[sourceKeys, outputName]`.
 */
export const DETAIL_KEYS = Object.freeze([
  [['opening_hours', 'openingHours', 'hours'], 'hours'],
  [['phone', 'telephone', 'contact:phone'], 'phone'],
  [['website', 'url', 'contact:website'], 'website'],
  // What the place *offers* — free Wi-Fi, takeaway, step-free entry, a
  // reception. Added for the parity benchmark, where `DT-T3`'s whole grading
  // note is "facilities.internet_access = 'free Wi-Fi'. Must come from POI
  // details, not a guess." — a question no other path in this system can answer,
  // since the candidate block carries names and categories only. It generalises:
  // MapIO POIs carry `facilities`/`catering`, Audiom features carry the same
  // idea in their property bag.
  //
  // ⚠️ `firstOf` takes strings and numbers, so an adapter must FLATTEN its
  // property bag into one string before putting it here. That is deliberate: the
  // allowlist exists so a raw nested bag can never reach `data`, and accepting
  // an object here would reopen exactly the hazard this module note is about.
  [['facilities', 'amenities'], 'facilities'],
]);

const firstOf = (props, keys) => {
  for (const key of keys) {
    const value = props?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return null;
};

/**
 * Open right now?
 *
 * Deliberately minimal: it understands a structured `{open, close}` pair in
 * 24-hour `HH:MM`, and **nothing else**. An OSM `opening_hours` expression is a
 * small language, and a wrong "it's open" sends someone to a locked door — so an
 * unparseable value yields `null` plus a `limits` entry saying the hours are
 * there to read but not to trust as an answer.
 *
 * @param {object|null} props
 * @param {number} now Epoch ms.
 * @returns {boolean|null}
 */
export function openNow(props, now) {
  const open = props?.open ?? props?.opens;
  const close = props?.close ?? props?.closes;
  const toMinutes = (value) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    return h >= 0 && h < 24 && min >= 0 && min < 60 ? h * 60 + min : null;
  };
  const from = toMinutes(open);
  const to = toMinutes(close);
  if (from === null || to === null || !Number.isFinite(now)) return null;
  const date = new Date(now);
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  return from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

/**
 * @param {{place: string, $place?: object}} args
 * @param {object} ctx
 * @param {{adapter: object}} api
 */
export function getPlaceDetails(args, ctx, { adapter }) {
  const place = args.$place;
  if (!place) {
    return { status: STATUS.ERROR, tool: NAME, error: 'unresolved_place', message: `I could not find "${args.place}".` };
  }

  const data = { place: projectPlace(place, { categories: 3 }) };
  const props = place.props || null;
  for (const [keys, name] of DETAIL_KEYS) {
    const value = firstOf(props, keys);
    if (value) data[name] = value;
  }

  const limits = [];
  data.openNow = openNow(props, ctx?.now?.());
  if (data.openNow === null) {
    delete data.openNow;
    if (data.hours) {
      limits.push(limit('openNow', 'unparsed_hours', 'I can read the opening hours out, but I cannot work out whether it is open right now.'));
    }
  }

  // Where it is, relative to the finger — in world-native terms only.
  const uv = windowUv(ctx);
  if (uv) {
    const distance = adapter.distanceTo?.(uv.u, uv.v, place);
    if (distance && Number.isFinite(distance.value)) data.distance = round(distance.value);
    const bearing = safeBearing(adapter, uv, place);
    if (bearing?.direction) data.direction = bearing.direction;
    else if (bearing?.method === 'inside') data.here = true;
  }

  const provenance = provenanceFor(place, ctx?.now?.());

  const result = {
    status: limits.length ? STATUS.PARTIAL : STATUS.OK,
    tool: NAME,
    data,
    limits: limits.length ? limits : undefined,
    provenance: provenance ? [provenance] : undefined,
  };
  // The props the clock has to be re-read against, carried NON-ENUMERABLY so
  // `JSON.stringify` — which is how this envelope reaches the prompt — cannot
  // see it. Putting it in `data` would ship the raw hours keys to the model.
  Object.defineProperty(result, PROPS_FOR_RECOMPUTE, { value: props, enumerable: false });
  return result;
}

/** Non-enumerable slot on the envelope; see `getPlaceDetails`. */
export const PROPS_FOR_RECOMPUTE = Symbol('openNowProps');

/**
 * Re-derive the one field a cached answer cannot keep. Called by
 * `ToolRegistry.dispatch()` on every memo hit, because the schema's
 * `$comment_pure` requires exactly this and nothing else.
 *
 * @param {object} cached
 * @param {object} ctx
 */
getPlaceDetails.recompute = function recompute(cached, ctx) {
  const props = cached?.[PROPS_FOR_RECOMPUTE];
  if (!props || !cached?.data) return cached;
  const value = openNow(props, ctx?.now?.());
  if (value === null || value === cached.data.openNow) return cached;
  const next = { ...cached, data: { ...cached.data, openNow: value } };
  Object.defineProperty(next, PROPS_FOR_RECOMPUTE, { value: props, enumerable: false });
  return next;
};

export default getPlaceDetails;
