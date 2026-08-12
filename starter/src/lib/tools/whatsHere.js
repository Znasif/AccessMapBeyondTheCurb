/**
 * `whats_here` — the one tool every session serves, and the only one that also
 * answers at L0 with no model in the path.
 *
 * ## Tier A vs Tier C
 *
 * The dispatcher never branches on the tier *letter*. It branches on one derived
 * boolean, `adjacencyAvailable` — `places` is declared **and** `nearby()` does
 * not answer `Unsupported`. The letter is a label for the log and the UI.
 *
 * That choice survives M12b, which is the argument for it. The tempting test is
 * `capabilities.has('graph')`, because the plan's tier table discriminates A
 * from C by `graph`. It fails twice: it is `false` for *every* Tier A session
 * today (M5a declares only `{places}`), and when M12b attaches a graph it flips
 * for every Tier A session with no code change in M7 — a behaviour change that
 * gets debugged for a day. It also fails the partial case: a Tier A map whose
 * graph build failed still has full geometry and can absolutely answer
 * adjacency.
 *
 * ## Where the name comes from, and where the geometry comes from
 *
 * The plan suggests enriching the name-only `featureEntered` payload through
 * `resolvePlace(name)`. **That path is broken on real data**: map 885's 3,004
 * features share 314 names, one of them worn by 373 features, so
 * `resolvePlace(streamName)` returns `Ambiguous` as the *normal* case and
 * picking from it would attach the geometry of an arbitrary one of 373 polygons
 * to the feature under the avatar. So identity and geometry come from different
 * sources:
 *
 *   name      ← the live stream (Audiom's own ground truth about its avatar)
 *   geometry  ← `adapter.at(u, v)` (point-in-polygon, smallest containing area)
 *   adjacent  ← `adapter.nearby(u, v)` minus whatever `at()` returned
 *
 * When the two disagree — the tactile window and Audiom's view have drifted, or
 * the avatar lags the finger — **the stream wins for the name**: it is what
 * Audiom is currently sounding, and disagreeing with the user's own map is worse
 * than a slightly stale name. The disagreement is recorded in `limits` and the
 * adjacency is marked `derived`.
 *
 * ## What "nothing here" means, and what it must not mean
 *
 * `audiomChannel` only updates its record for a payload carrying at least one
 * name, because *an unnamed feature is not nowhere* — the avatar is over
 * something, it just has no label. That leaves a trap: the last named feature
 * persists while the finger sits on unnamed ground, so trusting the stream alone
 * would say "you are on X" after the finger has left X.
 *
 * The rule, therefore:
 *
 *   - **With geometry (Tier A)**, `at()` is the authority on *presence*. An
 *     empty `at()` is "Nothing here." even if a live record exists. The stream
 *     supplies the *name* when `at()` also found something.
 *   - **Without geometry (Tier C)**, the stream is all there is. Fresh → the
 *     name. Stale or absent → *"I am not sure what you are on right now"*, and
 *     explicitly **not** "nothing here", because unnamed ≠ nowhere and this
 *     world cannot tell the two apart.
 */

import { isUnsupported } from '../worldAdapter.js';
import { STATUS, limit, MAX_ADJACENT } from '../toolResult.js';
import { adjacentTo, projectPlace, windowUv } from './shared.js';

export const NAME = 'whats_here';

/**
 * Is adjacency answerable in this session? Computed once and cached on the
 * adapter, lazily rather than eagerly: on audiom it costs one `nearby()` over
 * 3,004 features (a few ms with the bbox reject) and most sessions ask.
 *
 * @param {object} adapter
 * @param {{u: number, v: number}|null} uv
 * @returns {boolean}
 */
export function adjacencyAvailable(adapter, uv) {
  if (adapter._adjacencyAvailable !== undefined) return adapter._adjacencyAvailable;
  if (!adapter.has('places')) return false;
  if (!uv) return false;
  let answer = false;
  try {
    answer = !isUnsupported(adapter.nearby(uv.u, uv.v));
  } catch {
    answer = false;
  }
  // Cached on the adapter, not in the tool, so `describe_surroundings` and the
  // L0 template see the same answer this turn and every later one.
  adapter._adjacencyAvailable = answer;
  return answer;
}

/**
 * @param {object} _args No parameters — the position is injected, never named.
 * @param {object} ctx TurnContext.
 * @param {{adapter: object}} api
 */
export function whatsHere(_args, ctx, { adapter }) {
  const uv = windowUv(ctx);
  const live = ctx?.liveFeature;
  const liveName = live?.fresh ? live.names?.[0] : null;
  const hasGeometry = adjacencyAvailable(adapter, uv);

  /* -- Tier C: names only ---------------------------------------------------- */
  if (!hasGeometry) {
    if (liveName) {
      return {
        status: STATUS.PARTIAL,
        tool: NAME,
        // `adjacent: null`, never `[]` — an empty array claims nothing is next
        // to it, which is a different and false statement.
        data: { here: { name: liveName }, adjacent: null },
        limits: [limit('adjacent', 'no_geometry', 'For this map I only know the name of what you are on.')],
        units: { distance: null, direction: null, duration: null },
        provenance: [{ source: 'audiom:featureEntered', ageMs: live.ageMs }],
        source: 'liveFeatureStream',
      };
    }
    return {
      status: STATUS.PARTIAL,
      tool: NAME,
      data: { here: null, adjacent: null },
      limits: [
        limit(
          'here',
          'no_named_feature',
          'I am not sure what you are on right now. This map only tells me about named features, '
            + 'so you may be on something it has no name for.',
        ),
      ],
      units: { distance: null, direction: null, duration: null },
      source: 'liveFeatureStream',
    };
  }

  /* -- Tier A: geometry decides presence ------------------------------------- */
  const hit = uv ? adapter.at(uv.u, uv.v) : {};
  const atPlace = hit?.place || null;
  const atRegion = hit?.region || null;

  if (!atPlace && !atRegion) {
    // A complete, correct answer — NOT a reason to escalate. Handing an empty
    // `at()` to L3 with a candidate block invites the model to name a nearby
    // place as though the finger were on it.
    return {
      status: STATUS.OK,
      tool: NAME,
      data: { here: null, adjacent: null },
      source: 'at',
    };
  }

  const geometryName = atPlace?.name || atRegion?.name || null;
  const name = liveName || geometryName;
  const disagreement = Boolean(liveName && geometryName && liveName !== geometryName);

  const here = projectPlace(atPlace || atRegion) || { name };
  here.name = name;
  if (atRegion?.description) here.description = atRegion.description;

  const adjacent = adjacentTo(adapter, ctx, {
    excludeId: atPlace?.id ?? atRegion?.id,
    limit: MAX_ADJACENT,
  });

  const limits = [];
  if (disagreement) {
    limits.push(limit(
      'here',
      'stream_geometry_disagree',
      'The map and the shape under your finger do not quite agree; I am going by what the map is announcing.',
    ));
  }

  const provenance = [];
  if (liveName) provenance.push({ source: 'audiom:featureEntered', ageMs: live.ageMs });
  const placeProvenance = (atPlace || atRegion)?.provenance;
  if (placeProvenance?.source) provenance.push({ source: placeProvenance.source, id: placeProvenance.id });

  return {
    status: limits.length ? STATUS.PARTIAL : STATUS.OK,
    tool: NAME,
    data: { here, adjacent },
    limits: limits.length ? limits : undefined,
    provenance: provenance.length ? provenance : undefined,
    source: liveName
      ? (disagreement ? 'liveFeatureStream+derived' : 'liveFeatureStream+geometry')
      : 'geometry',
  };
}

/**
 * The part of the TurnContext this handler reads that the memo key would
 * otherwise miss.
 *
 * `whats_here` is schema-`pure`, so the registry will memoize it on
 * (world, window, acuityCell) — and a finger resting inside one acuity cell
 * while the avatar crosses three features would then hear the first one
 * forever. That is `LIVE_FEATURE_MAX_AGE_MS`'s staleness, reintroduced by the
 * cache. The stream identity therefore belongs in the key.
 *
 * @param {object} ctx
 * @returns {string}
 */
whatsHere.memoTag = (ctx) => {
  const live = ctx?.liveFeature;
  if (!live?.fresh) return 'live:none';
  return `live:${live.names.join(' ')}`;
};

export default whatsHere;
