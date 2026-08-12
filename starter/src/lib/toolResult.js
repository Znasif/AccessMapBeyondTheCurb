/**
 * The tool-result envelope — milestone 7.
 *
 * One shape for every outcome of every tool, in every world. `toolLoop.js`
 * JSON-stringifies whatever a handler returns straight into the prompt, so this
 * file is the whole of what L3 gets to reason over, against an 8192-token
 * ceiling where the curated prompt already occupies 6.2–6.8k.
 *
 * ```js
 * {
 *   status:  'ok' | 'partial' | 'ambiguous' | 'unsupported' | 'confirmed' | 'error',
 *   tool:    'get_distance_to',
 *
 *   data:        {…},                     // ok | partial      — UNTRUSTED, sanitized
 *   candidates:  [{name, category}],      // ambiguous | unresolved_place — ≤ 5
 *   message:     'Navigation mode is on', // confirmed | unsupported | error
 *   error:       'unresolved_place',      // error only
 *
 *   units:   { distance: 'metres', direction: 'compass', duration: null },
 *   frame:   'geographic',
 *   worldId: 'audiom:885',
 *   limits:  [{field, reason, narration}],
 *   provenance: [{source, id?, observedAt?, ageDays?, ageMs?, confidence?}],
 * }
 * ```
 *
 * The decisions inside it, and why each is not the obvious alternative:
 *
 * **`units` is an object, not a string.** One answer can carry a distance *and*
 * a direction — `describe_surroundings` and Tier A `whats_here` both do — and a
 * scalar would force one of them to be omitted or to lie. `duration: null` is
 * written **explicitly, never omitted**, so the model is told walking time is
 * unavailable rather than left to guess: that null is what stops "12 minutes'
 * walk" being said about a diagram (§5.4).
 *
 * **`units.direction` names a vocabulary, not a magnitude.** `'compass'` in the
 * geographic frame, `'material'` everywhere else, read off what the adapter
 * actually produced rather than applied as a policy here — so an adapter's
 * frame-awareness propagates into the narration contract with no second place to
 * keep in sync. Emitting degrees and hoping the model picks the right word set
 * is exactly the failure the schema's `$note` describes.
 *
 * **`status: 'confirmed'` is separate from `'ok'`.** The schema's
 * `notes.sideEffecting` asks for a confirmation string to narrate near-verbatim,
 * per MapIO's "Navigation mode is now enabled." — not data. Making it a status
 * also keeps it out of the memo table for free, since only schema-`pure` tools
 * are memoized and a confirmation must never be replayed.
 *
 * **`Ambiguous` and `Unsupported` are statuses, not exceptions.**
 * `worldAdapter.js` is explicit that both are ordinary outcomes of a correct
 * call. `candidates` is capped at 5 — `placeIndex`'s `k`, not the adapter's
 * internal `MAX_AMBIGUOUS` of 8 — so the number reaching the prompt matches the
 * number the candidate block already trains the model to reason over.
 *
 * **Age is computed, not just stamped.** §8 wants provenance *and age* in
 * accessibility results, and a raw ISO string makes a 4-bit 4B model do date
 * arithmetic it will get wrong. `ageDays` is an integer computed here from
 * `ctx.now()`, carried alongside the raw `observedAt`. M7 ships no accessibility
 * tools; the slot exists now so M11 does not have to re-cut the contract.
 *
 * Platform-free.
 */

import { sanitizeDeep } from './untrusted.js';
import { FRAMES } from './worldAdapter.js';
import { VOCABULARIES } from './direction.js';

/** Every legal `status`. */
export const STATUS = Object.freeze({
  OK: 'ok',
  PARTIAL: 'partial',
  AMBIGUOUS: 'ambiguous',
  UNSUPPORTED: 'unsupported',
  CONFIRMED: 'confirmed',
  ERROR: 'error',
});

/** Matches `placeIndex`'s `k`, not the adapter's `MAX_AMBIGUOUS`. See the module note. */
export const MAX_CANDIDATES = 5;

/** `data.adjacent` and friends. Three is what a listener can hold. */
export const MAX_ADJACENT = 3;

/** Provenance entries per envelope. */
export const MAX_PROVENANCE = 3;

/**
 * Serialized size ceiling for one result.
 *
 * Nothing else in the stack bounds this, and there is a live hazard behind it:
 * `AudiomWorldAdapter`'s Place carries `props` **by reference to the entire raw
 * feature property bag** (deliberately unfiltered, so `placeIndex` can consume
 * it). One handler spreading `place.props` into `data` would put kilobytes of
 * ArcGIS attributes into an 8192-token window. The allowlist in each handler is
 * the real defence; this is the backstop that makes a breach loud instead of
 * silent.
 */
export const MAX_RESULT_CHARS = 1200;

const MS_PER_DAY = 86_400_000;

/**
 * `units.duration`. A duration is a claim about walking, which needs a speed
 * assumption; only a `routing` world may make it.
 *
 * @param {{has: Function}} adapter
 * @returns {string|null}
 */
export function durationUnitFor(adapter) {
  return adapter?.has?.('routing') ? 'minutes' : null;
}

/**
 * The default `units` object for a session. Handlers overwrite the fields they
 * actually answered in; the rest stay as written here, including the nulls.
 *
 * @param {{frame: string, has?: Function}} adapter
 * @returns {{distance: string|null, direction: string|null, duration: string|null}}
 */
export function unitsFor(adapter) {
  const frame = adapter?.frame;
  return {
    distance: frame === FRAMES.IMAGE ? 'material_mm' : 'metres',
    direction: frame === FRAMES.GEOGRAPHIC ? VOCABULARIES.COMPASS : VOCABULARIES.MATERIAL,
    duration: durationUnitFor(adapter),
  };
}

/**
 * Provenance for a Place, with age computed against the turn's clock.
 *
 * @param {object} place
 * @param {number} now Epoch ms.
 * @returns {object|null}
 */
export function provenanceFor(place, now) {
  const p = place?.provenance;
  if (!p) return null;
  const out = { source: p.source };
  if (p.id !== undefined) out.id = p.id;
  const observedAt = p.observedAt ?? p.cachedAt;
  if (observedAt) {
    out.observedAt = observedAt;
    const parsed = Date.parse(observedAt);
    if (Number.isFinite(parsed) && Number.isFinite(now)) {
      out.ageDays = Math.max(0, Math.floor((now - parsed) / MS_PER_DAY));
    }
  }
  // A word, not a date: narration can hedge with "reported" far more reliably
  // than by comparing two timestamps.
  if (p.confidence) out.confidence = p.confidence;
  return out;
}

/** Drop null/undefined keys. `units.duration: null` is added back deliberately. */
function compact(object) {
  const out = {};
  for (const [key, value] of Object.entries(object)) {
    if (value === undefined || value === null) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Assemble one envelope.
 *
 * Every field except `data` and `candidates[].name` is dispatcher-authored and
 * therefore trusted; `data` is by definition the **untrusted subtree** and is
 * sanitised here, once, on the way out. That structural rule is what makes
 * containment checkable instead of a per-field convention someone forgets.
 *
 * @param {object} spec
 * @param {string} spec.status
 * @param {string} spec.tool
 * @param {object} [spec.data]
 * @param {object[]} [spec.candidates]
 * @param {string} [spec.message]
 * @param {string} [spec.error]
 * @param {object} [spec.units]
 * @param {string} [spec.frame]
 * @param {string} [spec.worldId]
 * @param {object[]} [spec.limits]
 * @param {object[]} [spec.provenance]
 * @param {number} [spec.acuityCell]
 * @param {string} [spec.source]
 * @returns {object}
 */
export function makeResult({
  status,
  tool,
  data,
  candidates,
  message,
  error,
  units,
  frame,
  worldId,
  limits,
  provenance,
  acuityCell,
  source,
}) {
  const envelope = compact({
    status,
    tool,
    error,
    message,
    frame,
    worldId,
    source,
    acuityCell,
  });

  if (data !== undefined && data !== null) envelope.data = sanitizeDeep(data);
  if (candidates?.length) {
    envelope.candidates = sanitizeDeep(candidates.slice(0, MAX_CANDIDATES));
  }
  if (units) {
    // `duration: null` survives `compact` because it is written after it — the
    // one null the model must see.
    envelope.units = { ...units };
  }
  if (limits?.length) envelope.limits = limits;
  if (provenance?.length) envelope.provenance = provenance.slice(0, MAX_PROVENANCE);

  return capSize(envelope);
}

/**
 * Truncate an over-large envelope rather than blowing the context window
 * silently. `data` is what gets cut, because it is the only unbounded part, and
 * the cut is *announced* in `limits` so the model knows it is reasoning over a
 * fragment.
 *
 * @param {object} envelope
 * @returns {object}
 */
export function capSize(envelope) {
  let json = JSON.stringify(envelope);
  if (json.length <= MAX_RESULT_CHARS) return envelope;

  const out = { ...envelope };
  // Arrays first: a long `adjacent` or `nearby` list is the usual cause and
  // dropping its tail keeps the answer's shape.
  for (const key of Object.keys(out.data || {})) {
    if (!Array.isArray(out.data[key]) || out.data[key].length <= 1) continue;
    out.data = { ...out.data, [key]: out.data[key].slice(0, 1) };
    json = JSON.stringify(out);
    if (json.length <= MAX_RESULT_CHARS) break;
  }
  if (json.length > MAX_RESULT_CHARS) {
    out.data = { truncated: true };
  }
  out.limits = [
    ...(out.limits || []),
    {
      field: 'data',
      reason: 'too_large',
      narration: 'There was more here than I can hold at once, so I have only part of it.',
    },
  ];
  return out;
}

/* ------------------------------------------------------------- constructors -- */

/** @returns {object} */
export const okResult = (tool, data, extra = {}) =>
  makeResult({ status: STATUS.OK, tool, data, ...extra });

/**
 * An answer that is correct as far as it goes, with `limits[]` saying how far.
 *
 * `partial` + `limits` is the mechanism that makes rules like "Tier C answers
 * with the name and stops" *enforceable* rather than aspirational: when L3 calls
 * the tool itself it must be told what is missing and why, or it invents the
 * missing half out of the candidate block.
 */
export const partialResult = (tool, data, limits, extra = {}) =>
  makeResult({ status: STATUS.PARTIAL, tool, data, limits, ...extra });

/** @returns {object} */
export const ambiguousResult = (tool, candidates, extra = {}) =>
  makeResult({
    status: STATUS.AMBIGUOUS,
    tool,
    candidates: (candidates || []).map((c) => compact({ name: c.name, category: c.category })),
    ...extra,
  });

/** @returns {object} */
export const unsupportedResult = (tool, message, extra = {}) =>
  makeResult({ status: STATUS.UNSUPPORTED, tool, message, ...extra });

/** @returns {object} */
export const confirmedResult = (tool, message, extra = {}) =>
  makeResult({ status: STATUS.CONFIRMED, tool, message, ...extra });

/**
 * The error shape.
 *
 * Deliberately the **same keys** `toolLoop.js` already emits for a parse failure
 * or a thrown handler (`{error, message}`), so the model never has to recognise
 * two error dialects — it just gets `frame`/`units` alongside them when the
 * dispatcher caught it rather than the loop.
 */
export const errorResult = (tool, error, message, extra = {}) =>
  makeResult({ status: STATUS.ERROR, tool, error, message, ...extra });

/** A limits entry. `narration` is dispatcher-authored and must never interpolate a place name. */
export const limit = (field, reason, narration) => ({ field, reason, narration });
