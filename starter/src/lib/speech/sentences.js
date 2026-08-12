/**
 * Sentence segmentation for streamed narration.
 *
 * Both risk registers name the same mitigation and neither implements it:
 *
 *   plan §8      — "Mitigate with the existing non-LLM earcon and TTS that
 *                   starts on the first sentence."
 *   design §10   — "streamed TTS that starts on the first sentence."
 *
 * L3 takes 1–3 s to finish an answer and the finger has already moved. Speaking
 * the first sentence the moment it is complete converts most of that wait into
 * speech the user is already listening to. That only works if something can say
 * *"this prefix is a whole sentence"* over a token stream, which is this file.
 *
 * ## What makes this hard is the domain, not the punctuation
 *
 * Street names are full of terminal-looking dots — "Main St. and 5th Ave." is
 * one clause with three of them — and this system narrates street names more
 * than anything else. So the abbreviation list is not decoration; without it the
 * splitter chops an address into four utterances with a pause in each gap, which
 * is both wrong and unpleasant to listen to. When in doubt it does NOT split:
 * an over-long utterance is a latency cost, an over-split one is a comprehension
 * cost, and only the second is unrecoverable.
 *
 * ## Streaming discipline
 *
 * A terminator at the very end of the buffer is never a confirmed boundary — the
 * next delta may turn `"St."` into `"St. Mary"`. Boundaries are emitted only
 * once a following character has arrived; `flush()` releases the tail.
 *
 * Platform-free: no timers, no DOM, no clock.
 */

/**
 * Tokens that end in a period without ending a sentence.
 *
 * Heavy on the street-type and direction abbreviations because those are what
 * this app says. `no` and `m` are in here at some cost — "there is no." is not a
 * sentence anyone says, and "500 m." runs on — which is the trade this file
 * deliberately takes.
 */
export const ABBREVIATIONS = Object.freeze(new Set([
  // titles
  'mr', 'mrs', 'ms', 'dr', 'prof', 'jr', 'sr', 'st',
  // street types
  'ave', 'blvd', 'rd', 'ln', 'ct', 'dr', 'hwy', 'pkwy', 'pl', 'sq', 'ter', 'trl',
  'cir', 'expy', 'fwy', 'rte', 'ste', 'apt', 'bldg', 'fl', 'rm',
  // directions
  'n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw',
  // units and editorial
  'ft', 'in', 'mi', 'km', 'm', 'cm', 'mm', 'no', 'nos', 'vs', 'etc', 'approx',
  'fig', 'dept', 'est', 'min', 'max', 'sec', 'hr', 'mt', 'ft',
  // latin
  'e.g', 'i.e', 'cf', 'al',
]));

/** Sentence terminators. */
const TERMINATORS = new Set(['.', '!', '?', '…']);

/** Characters that may trail a terminator and still belong to the sentence. */
const TRAILERS = new Set(['"', "'", ')', ']', '}', '”', '’', '»']);

/**
 * The word immediately before position `i` (which points at a terminator),
 * lowercased and stripped of internal punctuation-only noise.
 *
 * @param {string} text
 * @param {number} i
 * @returns {string}
 */
function precedingToken(text, i) {
  let start = i;
  while (start > 0 && /[^\s]/.test(text[start - 1])) start -= 1;
  return text.slice(start, i).toLowerCase().replace(/^[^\p{L}\p{N}.]+/u, '');
}

/**
 * Is the terminator at `i` a real sentence end, given everything up to `end`?
 *
 * @param {string} text
 * @param {number} i Index of the terminator.
 * @param {number} end Exclusive end of the confirmed text.
 * @returns {boolean}
 */
function isBoundary(text, i, end) {
  const ch = text[i];
  if (!TERMINATORS.has(ch)) return false;

  // Walk past a run of terminators and any closing punctuation: `?!"` is one
  // boundary, not three.
  let j = i;
  while (j + 1 < end && TERMINATORS.has(text[j + 1])) j += 1;
  while (j + 1 < end && TRAILERS.has(text[j + 1])) j += 1;

  // Unconfirmed: nothing has arrived after it yet, so we cannot know.
  if (j + 1 >= end) return false;
  if (!/\s/.test(text[j + 1])) {
    // `3.5`, `google.com`, `a.m.` mid-token — not a boundary.
    return false;
  }

  if (ch === '.') {
    const token = precedingToken(text, i);
    // A digit before the dot: "500." at the end of "it is 500." is a boundary,
    // but "3.5" was already rejected above by the no-space rule, so what reaches
    // here is safe to accept.
    const bare = token.replace(/\.+$/, '');
    if (ABBREVIATIONS.has(bare)) return false;
    // A single initial: "J. Smith".
    if (/^\p{L}$/u.test(bare)) return false;
  }
  return true;
}

/**
 * The furthest index `<= limit` at which a long run can be broken without
 * mangling a word. Prefers clause punctuation, then whitespace.
 *
 * @param {string} text
 * @param {number} limit
 * @returns {number} An exclusive end index, or -1.
 */
function softBreak(text, limit) {
  for (let i = Math.min(limit, text.length) - 1; i > 0; i -= 1) {
    const ch = text[i];
    if (ch === ',' || ch === ';' || ch === ':' || ch === '—') return i + 1;
  }
  for (let i = Math.min(limit, text.length) - 1; i > 0; i -= 1) {
    if (/\s/.test(text[i])) return i;
  }
  return -1;
}

/**
 * Split a complete string into sentences. Not the streaming path — this is what
 * `narrator.narrate()` uses when it already holds the whole answer.
 *
 * @param {string} text
 * @param {{maxChars?: number, minChars?: number}} [options]
 * @returns {string[]}
 */
export function splitSentences(text, options = {}) {
  const { maxChars = 220, minChars = 2 } = options;
  const source = String(text ?? '');
  const out = [];
  let start = 0;

  const push = (end) => {
    const piece = source.slice(start, end).trim();
    if (piece) out.push(piece);
    start = end;
  };

  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '\n') {
      if (source.slice(start, i).trim().length >= minChars) push(i);
      continue;
    }
    // `isBoundary` needs a character after the terminator; at the true end of a
    // complete string there is none, so the tail is handled below.
    if (isBoundary(source, i, source.length)) {
      let j = i;
      while (j + 1 < source.length && TERMINATORS.has(source[j + 1])) j += 1;
      while (j + 1 < source.length && TRAILERS.has(source[j + 1])) j += 1;
      if (source.slice(start, j + 1).trim().length >= minChars) { push(j + 1); i = j; }
    } else if (i - start >= maxChars) {
      const cut = softBreak(source.slice(start), maxChars);
      if (cut > 0) { push(start + cut); i = start - 1; }
    }
  }
  push(source.length);
  return out;
}

/**
 * A streaming splitter. Feed it deltas; it returns the sentences that are now
 * complete. Nothing is emitted twice, and nothing is emitted before a following
 * character proves the terminator was one.
 *
 * @param {{maxChars?: number, minChars?: number}} [options]
 */
export function createSentenceSplitter(options = {}) {
  const { maxChars = 220, minChars = 2 } = options;
  let buffer = '';

  /**
   * @param {string} delta
   * @returns {string[]} Sentences completed by this delta.
   */
  function push(delta) {
    buffer += String(delta ?? '');
    const out = [];
    let cut = 0;

    for (let i = 0; i < buffer.length; i += 1) {
      if (buffer[i] === '\n') {
        const piece = buffer.slice(cut, i).trim();
        if (piece.length >= minChars) { out.push(piece); cut = i + 1; }
        continue;
      }
      if (isBoundary(buffer, i, buffer.length)) {
        let j = i;
        while (j + 1 < buffer.length && TERMINATORS.has(buffer[j + 1])) j += 1;
        while (j + 1 < buffer.length && TRAILERS.has(buffer[j + 1])) j += 1;
        const piece = buffer.slice(cut, j + 1).trim();
        if (piece.length >= minChars) { out.push(piece); cut = j + 1; i = j; }
      }
    }

    buffer = buffer.slice(cut);

    // A model that never punctuates must still be heard. Break the run rather
    // than hold the whole answer back.
    while (buffer.length > maxChars) {
      const at = softBreak(buffer, maxChars);
      if (at <= 0) break;
      const piece = buffer.slice(0, at).trim();
      if (piece) out.push(piece);
      buffer = buffer.slice(at);
    }

    return out;
  }

  /**
   * Release the tail — call when the stream ends.
   * @returns {string[]}
   */
  function flush() {
    const tail = buffer.trim();
    buffer = '';
    return tail ? splitSentences(tail, { maxChars, minChars }) : [];
  }

  return {
    push,
    flush,
    /** Drop everything unspoken — used when a turn is superseded. */
    reset() { buffer = ''; },
    pending: () => buffer,
  };
}
