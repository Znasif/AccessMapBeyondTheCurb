/**
 * L0 — the rung an utterance can stop on before any model runs.
 *
 * ## The governing asymmetry
 *
 * A false L0 **hit** is unrecoverable: the user gets a wrong-shaped answer, in a
 * templated voice, with no model in the path to notice. A false L0 **miss**
 * costs 1–3 s. Therefore:
 *
 * > **L0 matching is precision-first. Whole-utterance match against a closed
 * > pattern set — never substring, never fuzzy. When in doubt, escalate.**
 *
 * *"what is this"* is L0. *"what is this compared to the museum"* is not, and a
 * substring matcher would have caught it.
 *
 * ## L0 speaks templates; it does not generate
 *
 * The design doc says "L3 is the only layer that speaks". That is one word off
 * and the word matters: **L3 is the only layer that *generates*.** L0 emits
 * strings assembled from world data —
 *
 *     "{name}."                              bare feature
 *     "{name}. {description}"                camio hotspot
 *     "{name}, next to {a} and {b}."         with adjacency
 *     "Nothing here."                        at() empty
 *
 * — which is MapIO's own confirmation-string convention applied to answers.
 * Templated speech is deterministic, auditable and cannot hallucinate. Without
 * it L0 either cannot answer at all or has to call L3 to phrase what it already
 * knows, which defeats the whole point of the rung.
 *
 * ## The lexicon is quoted from the schema
 *
 * The `whats_here` phrasings come straight from the tool's own `description`
 * string, which is frozen training data (`notes.descriptionsAreFrozen`), so the
 * lexicon and the tool cannot drift apart silently. Same pattern `toolFilter.js`
 * established for its `$note`-driven `NARROWINGS`.
 *
 * Platform-free.
 */

/**
 * Normalise for matching: NFC, lowercase, strip punctuation, collapse space.
 *
 * @param {string} utterance
 * @returns {string}
 */
export function normalize(utterance) {
  return String(utterance ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Speech-layer commands. No adapter, no model, no tool — they act on the
 * speaker, and a model in the path would make "stop" take 1–3 s to take effect.
 */
export const CONTROL_LEXICON = Object.freeze({
  stop: 'stop',
  'be quiet': 'stop',
  quiet: 'stop',
  cancel: 'stop',
  'never mind': 'stop',
  nevermind: 'stop',
  pause: 'pause',
  resume: 'resume',
  continue: 'resume',
  repeat: 'repeat',
  'say that again': 'repeat',
  'what did you say': 'repeat',
  again: 'repeat',
  slower: 'slower',
  'slow down': 'slower',
  faster: 'faster',
  'speed up': 'faster',
  quieter: 'quieter',
  louder: 'louder',
});

/**
 * `whats_here` phrasings.
 *
 * The first five are lifted verbatim from the tool description's own "such as"
 * list — *"what am I touching, what is this, where am I, what is under my
 * finger, what is this one"* — and the rest are the same questions with the
 * fillers a person actually says. Every entry is a **whole utterance**.
 */
export const WHATS_HERE_LEXICON = Object.freeze(new Set([
  // verbatim from the schema description
  'what am i touching',
  'what is this',
  'where am i',
  'what is under my finger',
  'what is this one',
  // the same five, as spoken
  'whats this',
  'what s this',
  'whats here',
  'what is here',
  'what am i on',
  'what am i over',
  'what is this thing',
  'what is that',
  'whats that',
  'where am i now',
  'what is beneath my finger',
  'what am i pointing at',
  'this one',
  'what is it',
]));

/** @typedef {{layer: 'L0', intent: string, command?: string}} L0Match */

/**
 * Which L0 rung, if any, this utterance lands on.
 *
 * @param {string} utterance
 * @returns {L0Match|null}
 */
export function matchL0(utterance) {
  const norm = normalize(utterance);
  if (!norm) return null;
  const command = CONTROL_LEXICON[norm];
  if (command) return { layer: 'L0', intent: 'control', command };
  if (WHATS_HERE_LEXICON.has(norm)) return { layer: 'L0', intent: 'whats_here' };
  return null;
}

/* ------------------------------------------------------------- narration -- */

/** The answer when the finger is on nothing at all. */
export const NOTHING_HERE = 'Nothing here.';

const list = (items) => {
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
};

/**
 * Turn a `whats_here` envelope into the sentence L0 speaks.
 *
 * Reads only the envelope, never the world — so the same function narrates the
 * L0 fast path and any future replay from the log, and cannot disagree with what
 * the tool actually returned.
 *
 * @param {object} envelope
 * @returns {string}
 */
export function narrateWhatsHere(envelope) {
  const data = envelope?.data;
  const here = data?.here;

  if (!here?.name) {
    // A `limits` entry is dispatcher-authored prose written for exactly this
    // moment — prefer it over the generic line, because "nothing here" and "I
    // cannot tell" are different claims and only one of them is true here.
    const reason = envelope?.limits?.find((l) => l.field === 'here');
    if (reason?.narration) return reason.narration;
    return NOTHING_HERE;
  }

  let text = here.name.replace(/\.?$/, '.');
  if (here.description) text += ` ${here.description.replace(/\.?$/, '.')}`;

  const adjacent = (data.adjacent || []).map((a) => a.name).filter(Boolean).slice(0, 2);
  if (adjacent.length) text = `${text.replace(/\.$/, '')}, next to ${list(adjacent)}.`;
  return text;
}
