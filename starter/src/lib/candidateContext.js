/**
 * Builds the candidate block injected into the L3 system prompt.
 *
 * This is the seam between L1 and L3, and it is worth more than it looks. Same
 * model, same tools, same L1 retrieval — only this text differs. Measured over
 * five utterances against the camio profile:
 *
 *   V0  bare name list                         2/5   3.0s
 *   V1  ranked, framed as a resolution         3/5   2.0s
 *   V2  V1 + explicit describe_surroundings    4/5   2.1s
 *       boundary
 *   V3  V2 + full category strings             5/5   7.6s
 *   V3t V2 + at most two categories            5/5   2.9s   <- implemented here
 *
 * Three things each fixed a distinct failure:
 *
 * 1. FRAMING. A flat "candidate places in the current window" list reads as
 *    ambient scenery, which invites describe_surroundings. Presenting it as the
 *    already-computed resolution of what the user just said moved
 *    "the Korean place with tofu soup" from describe_surroundings{restaurant}
 *    to get_place_details{BCD Tofu House}.
 *
 * 2. TOOL BOUNDARY. describe_surroundings is a strong attractor for anything
 *    vague. Naming when NOT to use it fixed "how far is the Irish pub".
 *
 * 3. EVIDENCE. Bare names discard why L1 ranked something first. L3 cannot
 *    connect "the observation deck" to "Empire State Building" from the name
 *    alone, and correctly refuses to guess:
 *      "I do not have a location named 'observation deck'... Are you
 *       referring to one of those?"
 *    Adding the category makes the link visible and the call fires.
 *
 * Categories are truncated because they are the whole latency story: the
 * Empire State Building carries six (~22 tokens), and passing them all for five
 * candidates tripled mean latency to 7.6s for no additional accuracy.
 */

export const MAX_CATEGORIES_PER_CANDIDATE = 3;

/**
 * Pick the most *distinguishing* categories, not the first N.
 *
 * OSM-style category lists repeat one facet before reaching another. The Empire
 * State Building is tagged:
 *   building.office, building.historic, heritage, tourism.attraction, office,
 *   building.tourism
 * The first two are both "building.", so a naive slice(0,2) spends the whole
 * budget on one facet and drops tourism.attraction — which is the only tag that
 * links it to "the observation deck". Deduping by namespace surfaces
 * building.office, heritage, tourism.attraction in the same three slots.
 */
function distinguishingCategories(raw, limit) {
  const seen = new Set();
  const out = [];
  for (const cat of raw.split(',').map((c) => c.trim()).filter(Boolean)) {
    const ns = cat.split('.')[0];
    if (seen.has(ns)) continue;
    seen.add(ns);
    out.push(cat);
    if (out.length === limit) break;
  }
  return out;
}

/**
 * @param {{name: string, category?: string}[]} matches - PlaceIndex.resolve() output, best first
 */
export function buildCandidateBlock(matches, { maxCategories = MAX_CATEGORIES_PER_CANDIDATE } = {}) {
  return matches
    .map((m, i) => {
      const cats = distinguishingCategories(m.category || '', maxCategories).join(', ');
      return `  ${i + 1}. ${m.name}${cats ? ` — ${cats}` : ''}`;
    })
    .join('\n');
}

/**
 * The invariant half of the prompt. MUST stay byte-identical across turns.
 *
 * Together with the tool schema this is ~1,690 tokens, and it is the prefix the
 * KV cache reuses (§6.1, --cache-reuse 256). Putting the per-utterance
 * candidate block in here instead destroys that:
 *
 *   candidates in system message   0% cached    11.8s mean
 *   candidates in user turn       95% cached     5.7s mean
 *
 * Same tokens, same tools, same accuracy — 2x latency, purely from placement.
 * Anything that varies per utterance goes after everything that does not.
 */
export function buildSystemPrompt({ extra = '' } = {}) {
  return `You control a tactile map for a blind user exploring by touch.

Every user turn begins with the places in view, already ranked by how well they match that turn's phrasing. This ranking is authoritative and was computed for you — treat it as the resolution of whatever the user just referred to.

Users name places by what they are, not what they are called: "the observation deck", "the Korean place", "the Irish pub". Match those descriptions against the candidates and their categories, then take candidate 1 unless the wording clearly points at another. Pass the name verbatim; never invent one.

Do not ask the user which place they meant when a candidate plausibly matches — choose candidate 1 and act. Ask only when no candidate fits at all.

Use describe_surroundings ONLY when the user asks what is nearby in general. If the user refers to a specific place, use a place-specific tool instead.${extra ? `\n\n${extra}` : ''}`;
}

/**
 * The volatile half: candidates plus the utterance, as one user turn.
 *
 * Injected unconditionally. Measured over six utterances whose correct tool
 * takes no `place` argument (whats_here, get_segment_accessibility,
 * get_crossing_info, stop_navigation, set_route_preferences, and a plain
 * greeting), the block is inert — 6/6 correct and zero place-tool false
 * positives both with and without it. So there is nothing to gate on for
 * correctness, and gating would save only these ~80 tokens while adding a
 * branch that can be wrong. Six of the twelve tools take a `place`; the other
 * six simply ignore this.
 */
export function buildUserTurn(matches, utterance) {
  if (!matches?.length) return utterance;
  return `Places in view, ranked best first:\n${buildCandidateBlock(matches)}\n\n${utterance}`;
}

/** Tools whose arguments include a resolved place name. Derived, not hand-listed. */
export function placeTakingTools(schema) {
  return new Set(
    schema.tools
      .filter((t) => 'place' in (t.function?.parameters?.properties || {}))
      .map((t) => t.function.name),
  );
}
