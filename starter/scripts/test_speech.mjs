#!/usr/bin/env node
/**
 * Milestone S check: speech in and speech out.
 *
 *   node starter/scripts/test_speech.mjs
 *
 * FULLY OFFLINE, and it has to be: neither `SpeechRecognition` nor
 * `speechSynthesis` exists in Node, which is exactly why both modules take their
 * platform objects by injection. The fakes here are more useful than the real
 * APIs would be — a real synthesiser cannot be made to *silently drop* an
 * utterance on demand, and that is the failure the narrator's watchdog exists
 * for.
 *
 * Everything is deterministic: timers are a controllable clock, so the watchdog
 * is checked in microseconds rather than waited out.
 */

import {
  createNarrator, createRecognizer, linkBargeIn,
  splitSentences, createSentenceSplitter,
  readResult, buildPhrases,
  SttMode, Availability, NoticeCode, RecognizerState,
  ERROR_INTERVAL_S, RATE_MIN, RATE_MAX, RATE_STEP, watchdogMs,
} from '../src/lib/speech/index.js';
import { createSpeaker, setSpeaker, speak as moduleSpeak } from '../src/lib/speak.js';
import { Category, Priority } from '../src/lib/logic/announcementQueue.js';
import { matchL0, CONTROL_LEXICON } from '../src/lib/l0.js';

let failures = 0;
let total = 0;
function check(ok, label, detail = '') {
  total += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures += 1;
}
const head = (title) => console.log(`\n— ${title} ${'—'.repeat(Math.max(0, 62 - title.length))}`);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ================================================================ fakes == */

/** A clock plus a timer wheel. Nothing here ever really waits. */
function makeTimers() {
  let ms = 0;
  let seq = 0;
  const pending = new Map();
  return {
    setTimeout(fn, delay) {
      seq += 1;
      pending.set(seq, { at: ms + Math.max(0, delay || 0), fn });
      return seq;
    },
    clearTimeout(id) { pending.delete(id); },
    advance(by) {
      const target = ms + by;
      for (;;) {
        let pick = null;
        let at = Infinity;
        for (const [id, t] of pending) if (t.at <= target && t.at < at) { at = t.at; pick = id; }
        if (pick === null) break;
        const t = pending.get(pick);
        pending.delete(pick);
        ms = t.at;
        t.fn();
      }
      ms = target;
    },
    nowMs: () => ms,
    nowSeconds: () => ms / 1000,
    pendingCount: () => pending.size,
  };
}

class FakeUtterance {
  constructor(text) { this.text = text; }
}

/**
 * A synthesiser.
 *
 *  - `mode: 'manual'`  — utterances sit until `finish()` is called. The normal case.
 *  - `mode: 'drop'`    — `speak()` is accepted and then nothing ever happens.
 *                        This is a browser refusing audio outside a user gesture,
 *                        and it is the deadlock the watchdog covers.
 */
function makeSynth({ mode = 'manual' } = {}) {
  const calls = [];
  const live = [];
  return {
    calls,
    cancel() {
      calls.push(['cancel']);
      // A real engine fires `error` on everything it just threw away.
      for (const u of live.splice(0)) u.onerror?.();
    },
    speak(u) {
      calls.push(['speak', u.text]);
      if (mode !== 'drop') live.push(u);
    },
    /** End the oldest live utterance, as `onend` would. */
    finish() { const u = live.shift(); u?.onend?.(); return Boolean(u); },
    /** Report progress, as `onboundary` would. */
    boundary(charIndex) { live[0]?.onboundary?.({ charIndex }); },
    liveCount: () => live.length,
    spoken: () => calls.filter((c) => c[0] === 'speak').map((c) => c[1]),
    reset() { calls.length = 0; },
  };
}

/**
 * A `SpeechRecognition` constructor.
 *
 * `control` is mutable so a test can move the language pack from `downloadable`
 * to `available` under a live recogniser, which is what `install()` does.
 */
function makeSpeechRecognition(control = {}) {
  const state = {
    availability: Availability.AVAILABLE,
    hasStatics: true,
    installSucceeds: true,
    startThrows: null,
    ...control,
  };
  const instances = [];

  class FakeSR {
    constructor() {
      this.started = false;
      this.aborted = false;
      instances.push(this);
    }

    start() {
      if (state.startThrows) {
        const message = state.startThrows;
        state.startThrows = null;
        throw new Error(message);
      }
      this.started = true;
      this.onstart?.();
    }

    stop() { this.started = false; this.onend?.(); }

    abort() { this.aborted = true; this.started = false; }

    /* test drivers */
    emitResult(event) { this.onresult?.(event); }
    emitError(error, message) { this.onerror?.({ error, message }); }
    emitEnd() { this.onend?.(); }
    emitSpeechStart() { this.onspeechstart?.(); }
  }

  if (state.hasStatics) {
    FakeSR.available = async () => state.availability;
    FakeSR.install = async () => {
      if (!state.installSucceeds) return false;
      state.availability = Availability.AVAILABLE;
      return true;
    };
  }

  return { FakeSR, instances, state };
}

class FakePhrase {
  constructor(phrase, boost) { this.phrase = phrase; this.boost = boost; }
}

/** Build a `SpeechRecognitionEvent`-shaped object. */
function resultEvent(items, resultIndex = 0) {
  const results = items.map((item) => {
    const alternatives = [
      { transcript: item.transcript, confidence: item.confidence ?? 0.9 },
      ...(item.alts ?? []).map((t) => ({ transcript: t, confidence: 0.1 })),
    ];
    alternatives.isFinal = Boolean(item.isFinal);
    return alternatives;
  });
  return { results, resultIndex };
}

/* ============================================== 1. sentence segmentation == */

head('1. sentences.js — the "start on the first sentence" mitigation');

{
  check(eq(splitSentences('Hello there. How are you?'), ['Hello there.', 'How are you?']),
    'two sentences split on the terminator');

  check(eq(splitSentences('You are on Main St. and 5th Ave.'), ['You are on Main St. and 5th Ave.']),
    'street abbreviations do NOT split — the thing this app says most');

  check(eq(splitSentences('It is 3.5 metres away. Turn left.'), ['It is 3.5 metres away.', 'Turn left.']),
    'a decimal point is not a terminator');

  check(eq(splitSentences('Really?! Yes.'), ['Really?!', 'Yes.']),
    'a run of terminators is one boundary');

  check(eq(splitSentences('She said "go left." Then stop.'), ['She said "go left."', 'Then stop.']),
    'a closing quote rides with its sentence');

  check(eq(splitSentences('Ask J. Smith about it. Then go.'), ['Ask J. Smith about it.', 'Then go.']),
    'a single initial does not split');

  check(eq(splitSentences('First line\nSecond line'), ['First line', 'Second line']),
    'a newline is a boundary even without punctuation');

  check(splitSentences('').length === 0 && splitSentences(null).length === 0,
    'empty input yields nothing');

  const runOn = `${'word '.repeat(80)}`.trim();
  const chunks = splitSentences(runOn);
  check(chunks.length > 1 && chunks.every((c) => c.length <= 230),
    'a model that never punctuates is still broken into speakable runs',
    `${chunks.length} chunks`);
  check(chunks.join(' ') === runOn, 'and the forced break loses nothing');
}

{
  // Streaming: a terminator at the very end of the buffer is NOT yet a boundary,
  // because the next delta may turn "St." into "St. Mary".
  const s = createSentenceSplitter();
  check(eq(s.push('You are on Main St.'), []), 'a trailing terminator is held back');
  check(eq(s.push(' and 5th'), []), 'and the next delta proves it was an abbreviation');
  check(eq(s.push(' Ave. The park is north. '), ['You are on Main St. and 5th Ave. The park is north.']),
    '⚠️ an abbreviation at a REAL sentence end does not split either — the conservative rule '
    + 'buys an occasional long utterance and never a chopped address');
  check(eq(s.flush(), []), 'nothing left over');

  const s2 = createSentenceSplitter();
  check(eq(s2.push('The plaza is north. '), ['The plaza is north.']),
    'an ordinary boundary is released the moment a following character confirms it');
  check(eq(s2.push('It has'), []), 'and the next sentence is held until it is complete');
}

{
  const s = createSentenceSplitter();
  s.push('Half a sentence');
  check(eq(s.flush(), ['Half a sentence']), 'flush() releases an unterminated tail');
  check(s.pending() === '', 'and empties the buffer');
}

/* ================================================ 2. speak.js additions == */

head('2. speak.js — onBoundary and the voice settings, added by S');

{
  const synth = makeSynth();
  const speaker = createSpeaker({ synth, Utterance: FakeUtterance });

  let seen = null;
  speaker.speak('hello world', { onBoundary: (i) => { seen = i; } });
  synth.boundary(6);
  check(seen === 6, 'onBoundary forwards charIndex — the only progress signal a browser gives');

  synth.boundary(undefined);
  check(seen === 0, 'a missing charIndex reads as 0 rather than NaN');
}

{
  const captured = [];
  const synth = { cancel() {}, speak(u) { captured.push(u); } };
  const speaker = createSpeaker({ synth, Utterance: FakeUtterance });

  speaker.speak('a', { rate: 1.4, volume: 0.5, lang: 'en-GB' });
  check(captured[0].rate === 1.4 && captured[0].volume === 0.5 && captured[0].lang === 'en-GB',
    'rate / volume / lang pass through');
  check(!('pitch' in captured[0]),
    'an unset option is NOT written — assigning undefined would make rate NaN on a real utterance');
}

{
  // The pre-existing contract must not have moved.
  const synth = makeSynth();
  const speaker = createSpeaker({ synth, Utterance: FakeUtterance });
  check(speaker.speak('x') === true, 'speak() still returns true when it starts');
  check(eq(synth.calls, [['cancel'], ['speak', 'x']]), 'and still cancels first by default');
  synth.reset();
  speaker.speak('y', { interrupt: false });
  check(eq(synth.calls, [['speak', 'y']]), 'interrupt:false still skips the cancel');
  check(speaker.speak('') === false, 'empty text still returns false');
}

/* =============================================== 3. narrator — the queue == */

head('3. narrator — the ported queue, wired to a synthesiser');

{
  const timers = makeTimers();
  const synth = makeSynth();
  const n = createNarrator({
    synth, Utterance: FakeUtterance, autoStart: true,
    now: timers.nowSeconds, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });

  n.narrate('one', { layer: 'L3' });
  check(eq(synth.spoken(), ['one']), 'the first announcement speaks immediately');

  n.narrate('two', { layer: 'L3' });
  check(eq(synth.spoken(), ['one']), 'the second waits — the queue serialises, it does not stack');
  check(n.stats().queued === 1, 'and it is queued');

  synth.finish();
  check(eq(synth.spoken(), ['one', 'two']), 'onend drains the next one');
  check(synth.calls.filter((c) => c[0] === 'cancel').length === 0,
    'and the queue never cancelled its own predecessor');

  synth.finish();
  check(n.isSpeaking() === false, 'the queue goes idle when it empties');
}

{
  const timers = makeTimers();
  const synth = makeSynth();
  const n = createNarrator({
    synth, Utterance: FakeUtterance, autoStart: true,
    now: timers.nowSeconds, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });

  n.narrate('a long description of the park', { layer: 'L3' });
  n.error('Wrong direction.');
  check(synth.spoken().slice(-1)[0] === 'Wrong direction.',
    'an ERROR at HIGH preempts a description mid-utterance');

  const before = synth.spoken().length;
  n.narrate('another description', { layer: 'L3', interrupt: true });
  check(synth.spoken().length === before,
    'and a LOW description cannot preempt the error back');
}

{
  const timers = makeTimers();
  const synth = makeSynth();
  const n = createNarrator({
    synth, Utterance: FakeUtterance, autoStart: true,
    now: timers.nowSeconds, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });

  n.disableCategory(Category.LLM);
  check(n.narrate('model chatter', { layer: 'L3' }) === null, 'a muted category queues nothing');
  check(synth.spoken().length === 0, 'and says nothing');
  n.enableCategory(Category.LLM);
  check(n.narrate('model chatter', { layer: 'L3' }) !== null, 'un-muting restores it');
}

{
  const timers = makeTimers();
  const synth = makeSynth();
  const n = createNarrator({
    synth, Utterance: FakeUtterance, autoStart: true,
    now: timers.nowSeconds, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  n.narrate('before', { layer: 'L0' });
  n.addPause(2);
  n.narrate('after', { layer: 'L0' });
  synth.finish();
  check(eq(synth.spoken(), ['before']), 'a pause holds the queue — nothing speaks during it');
  timers.advance(1999);
  check(eq(synth.spoken(), ['before']), 'still holding at 1999 ms');
  timers.advance(2);
  check(eq(synth.spoken(), ['before', 'after']), 'and releases at the duration, ordering preserved');
}

/* ============================================= 4. narrator — the watchdog == */

head('4. narrator — the watchdog, because onend is not a guarantee');

{
  // The exact browser failure: `speak()` accepted, no `onend`, no `onerror`,
  // no exception. Without a watchdog the queue is mute forever from here on.
  const timers = makeTimers();
  const synth = makeSynth({ mode: 'drop' });
  const n = createNarrator({
    synth, Utterance: FakeUtterance, autoStart: true,
    now: timers.nowSeconds, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });

  n.narrate('the dropped one', { layer: 'L3' });
  n.narrate('the one stuck behind it', { layer: 'L3' });
  check(eq(synth.spoken(), ['the dropped one']), 'the engine accepted the first and said nothing');

  timers.advance(1000);
  check(eq(synth.spoken(), ['the dropped one']), 'the watchdog has not fired early');

  timers.advance(watchdogMs('the dropped one', 1) + 10);
  check(eq(synth.spoken(), ['the dropped one', 'the one stuck behind it']),
    'the watchdog recovered the queue instead of deadlocking it');
  check(n.stats().watchdogFirings === 1, 'and counted the firing');
}

{
  // A late `onend` after the watchdog already moved on must NOT end the next one.
  const timers = makeTimers();
  const synth = makeSynth();
  const n = createNarrator({
    synth, Utterance: FakeUtterance, autoStart: true,
    now: timers.nowSeconds, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });

  n.narrate('first', { layer: 'L3' });
  n.narrate('second', { layer: 'L3' });
  n.narrate('third', { layer: 'L3' });

  timers.advance(watchdogMs('first', 1) + 10);
  check(eq(synth.spoken(), ['first', 'second']), 'the watchdog advanced past a stalled "first"');

  synth.finish();  // the real onend for "first", arriving late
  check(eq(synth.spoken(), ['first', 'second']),
    'the late onend for a settled utterance is ignored — "second" was not cut short');

  synth.finish();  // the real onend for "second"
  check(eq(synth.spoken(), ['first', 'second', 'third']), 'and the queue still advances normally');
}

{
  // No synthesiser at all — the Node case, and also a browser that refuses.
  const timers = makeTimers();
  const n = createNarrator({
    autoStart: true,
    now: timers.nowSeconds, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  n.narrate('a', { layer: 'L3' });
  n.narrate('b', { layer: 'L3' });
  check(n.stats().queued === 0 && n.isSpeaking() === false,
    'with no synth the queue drains synchronously rather than wedging');
  check(n.stats().droppedUtterances === 2, 'and both are counted as dropped, not as spoken');
}

{
  let ended = [];
  const timers = makeTimers();
  const synth = makeSynth({ mode: 'drop' });
  const n = createNarrator({
    synth, Utterance: FakeUtterance, autoStart: true,
    now: timers.nowSeconds, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    onAnnouncementEnded: (a, info) => ended.push([a.text, info.announced, info.started]),
  });
  n.narrate('x', { layer: 'L3' });
  timers.advance(watchdogMs('x', 1) + 10);
  check(eq(ended, [['x', true, true]]),
    'the engine accepted it, so started is true even though the watchdog ended it');

  ended = [];
  const n2 = createNarrator({
    autoStart: true,
    now: timers.nowSeconds, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    onAnnouncementEnded: (a, info) => ended.push([a.text, info.announced, info.started]),
  });
  n2.narrate('y', { layer: 'L3' });
  check(eq(ended, [['y', true, false]]),
    '⚠️ the ported queue says announced:true for an utterance no engine took; started:false corrects it');
}

/* ============================================ 5. narrator — turn gating == */

head('5. narrator — turn gating, because stale narration is a safety issue');

{
  const timers = makeTimers();
  const synth = makeSynth();
  const dropped = [];
  const n = createNarrator({
    synth, Utterance: FakeUtterance, autoStart: true,
    now: timers.nowSeconds, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
    onDropped: (d) => dropped.push(d.reason),
  });

  n.narrate('answer to turn one', { layer: 'L3', turnId: 't1' });
  check(eq(synth.spoken(), ['answer to turn one']), 'turn 1 speaks');

  n.narrate('answer to turn two', { layer: 'L3', turnId: 't2' });
  check(synth.spoken().slice(-1)[0] === 'answer to turn two',
    'a NEW turn preempts — the finger has moved, turn 1 describes somewhere else now');

  // The late second half of turn 1, arriving after turn 2 started.
  const late = n.narrate('…and it has a ramp', { layer: 'L3', turnId: 't1' });
  check(late === null, 'a retired turn is dropped, not queued');
  check(dropped.includes('stale-turn'), 'and the drop is reported with a reason');
  check(n.stats().staleDrops === 1, 'and counted');

  n.narrate('second sentence of turn two', { layer: 'L3', turnId: 't2' });
  check(n.stats().queued === 1,
    'the SAME turn queues in order rather than interrupting itself — this is what makes streaming work');
}

{
  const timers = makeTimers();
  const synth = makeSynth();
  const n = createNarrator({
    synth, Utterance: FakeUtterance, autoStart: true,
    now: timers.nowSeconds, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  n.narrate('a', { layer: 'L3', turnId: 't1' });
  n.retireTurn('t1');
  check(n.narrate('b', { layer: 'L3', turnId: 't1' }) === null,
    'retireTurn() drops a turn the user abandoned without waiting for a replacement');
}

/* =========================================== 6. narrator — sentence stream == */

head('6. narrator — narrateStream: speech starts one sentence in, not one answer in');

{
  const timers = makeTimers();
  const synth = makeSynth();
  const n = createNarrator({
    synth, Utterance: FakeUtterance, autoStart: true,
    now: timers.nowSeconds, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });

  const stream = n.narrateStream({ turnId: 't9' });
  stream.push('You are at the north entrance');
  check(synth.spoken().length === 0, 'nothing spoken from a partial sentence');
  stream.push('. There is a ramp');
  check(eq(synth.spoken(), ['You are at the north entrance.']),
    'the first sentence speaks while the model is still generating');
  stream.push(' on the left.');
  stream.end();
  check(n.stats().queued === 1, 'the rest queues behind it rather than interrupting');
  synth.finish();
  check(eq(synth.spoken(), ['You are at the north entrance.', 'There is a ramp on the left.']),
    'and the whole answer is heard in order');
}

{
  const timers = makeTimers();
  const synth = makeSynth();
  const n = createNarrator({
    synth, Utterance: FakeUtterance, autoStart: true,
    now: timers.nowSeconds, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  const stale = n.narrateStream({ turnId: 't1' });
  stale.push('This is the old answer. ');
  n.narrate('new question answered', { layer: 'L3', turnId: 't2' });
  stale.push('And more of the old answer. ');
  check(synth.spoken().slice(-1)[0] === 'new question answered',
    'a stream whose turn was superseded stops being able to speak');
  check(n.stats().staleDrops === 1, 'its late sentence is dropped');
}

/* ================================================ 7. narrator — control == */

head('7. narrator — L0 control words act on the speaker, with no model in the path');

{
  const timers = makeTimers();
  const synth = makeSynth();
  const n = createNarrator({
    synth, Utterance: FakeUtterance, autoStart: true,
    now: timers.nowSeconds, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });

  n.narrate('a very long description indeed', { layer: 'L3' });
  n.narrate('and another', { layer: 'L3' });
  check(n.control('stop') === true, '"stop" is recognised');
  check(n.isSpeaking() === false && n.stats().queued === 0,
    'and it clears both the utterance and everything behind it');

  check(n.control('nonsense-command') === false, 'an unknown command is refused rather than swallowed');
}

{
  const timers = makeTimers();
  const synth = makeSynth();
  const n = createNarrator({
    synth, Utterance: FakeUtterance, autoStart: true,
    now: timers.nowSeconds, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });

  n.narrate('the north gate is closed today', { layer: 'L3' });
  synth.boundary(18); // "the north gate is " spoken; "closed today" remains
  check(n.pause() === true, 'pause() stashes the unspoken tail');
  check(n.isSpeaking() === false, 'and stops');
  check(n.pause() === false, 'pausing twice does not toggle back — "pause" is not "resume"');

  synth.reset();
  check(n.resume() === true, 'resume() replays only what was left');
  check(synth.spoken()[0] === 'closed today',
    'from the boundary index, not from the start', synth.spoken()[0]);
  check(n.resume() === false, 'and resuming twice is a no-op');
}

{
  const timers = makeTimers();
  const synth = makeSynth();
  const n = createNarrator({
    synth, Utterance: FakeUtterance, autoStart: true,
    now: timers.nowSeconds, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });

  n.narrate('the museum entrance', { layer: 'L0' });
  synth.finish();
  synth.reset();
  n.control('repeat');
  check(eq(synth.spoken(), ['the museum entrance']), '"repeat" says the last finished announcement again');

  synth.finish();
  synth.reset();
  n.narrate('a fresh one', { layer: 'L0' });
  n.control('repeat');
  check(synth.spoken().slice(-1)[0] === 'a fresh one',
    '"repeat" during an utterance repeats THAT one, not the previous');
}

{
  const captured = [];
  const timers = makeTimers();
  const synth = { cancel() {}, speak(u) { captured.push(u); } };
  const n = createNarrator({
    synth, Utterance: FakeUtterance, autoStart: true,
    now: timers.nowSeconds, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });

  check(n.getRate() === 1, 'the default rate is 1');
  n.control('slower');
  check(Math.abs(n.getRate() - (1 - RATE_STEP)) < 1e-9, '"slower" steps the rate down');
  n.control('faster'); n.control('faster');
  check(Math.abs(n.getRate() - (1 + RATE_STEP)) < 1e-9, '"faster" steps it back up');

  for (let i = 0; i < 40; i += 1) n.control('faster');
  check(n.getRate() === RATE_MAX, 'and it clamps at the maximum');
  for (let i = 0; i < 80; i += 1) n.control('slower');
  check(n.getRate() === RATE_MIN, 'and at the minimum');

  n.setRate(1);
  captured.length = 0;
  n.narrate('a description that is being read out', { layer: 'L3' });
  const startedAt = captured.length;
  n.control('slower');
  check(captured.length === startedAt + 1,
    '"slower" mid-utterance re-says the remaining text — Web Speech rate only applies to new utterances');
  check(captured[captured.length - 1].rate < 1, 'at the new, slower rate');

  n.control('louder'); n.control('louder');
  check(n.getVolume() === 1, 'volume clamps at 1');
  n.control('quieter');
  check(n.getVolume() < 1, '"quieter" steps it down');
}

{
  // Every control word L0 can produce must be one this narrator implements. If
  // someone adds a lexicon entry with no handler, this fails rather than the
  // command silently doing nothing.
  const timers = makeTimers();
  const n = createNarrator({
    synth: makeSynth(), Utterance: FakeUtterance, autoStart: true,
    now: timers.nowSeconds, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  const commands = [...new Set(Object.values(CONTROL_LEXICON))];
  const unhandled = commands.filter((c) => n.control(c) === false);
  check(unhandled.length === 0, 'every command in l0.js CONTROL_LEXICON is handled', unhandled.join(', '));
  check(matchL0('be quiet')?.command === 'stop' && n.control('stop') === true,
    'and the L0 match feeds straight in');
}

/* ========================================== 8. narrator — error interval == */

head('8. narrator — MapIO ERROR_INTERVAL repeat suppression (mapio_tts.py:15)');

{
  const timers = makeTimers();
  const synth = makeSynth();
  const n = createNarrator({
    synth, Utterance: FakeUtterance, autoStart: true,
    now: timers.nowSeconds, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });

  check(n.error('Wrong direction.') !== null, 'the first error speaks');
  check(n.error('Wrong direction.') === null, 'an immediate repeat is dropped');
  timers.advance(ERROR_INTERVAL_S * 1000 - 100);
  check(n.error('Wrong direction.') === null, `still dropped just inside ${ERROR_INTERVAL_S} s`);
  timers.advance(200);
  check(n.error('Wrong direction.') !== null, 'and speaks again once the interval has passed');
  check(n.error('Urgent.', { force: true }) !== null, 'force bypasses the interval');
}

/* ============================================ 9. narrator — the 5c seam == */

head('9. narrator — setSpeaker(asSpeaker()): the queue behind AudiomMap’s button');

{
  const timers = makeTimers();
  const synth = makeSynth();
  const n = createNarrator({
    synth, Utterance: FakeUtterance,       // NOT autoStart: a gesture must arm it
    now: timers.nowSeconds, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });

  check(n.isArmed() === false, 'a fresh narrator is unarmed — browsers gate speech on a user gesture');
  n.narrate('status chatter before any click', { layer: 'L1' });
  check(synth.spoken().length === 0, 'so a non-gesture announcement queues silently');

  check(n.arm() === true, 'arm() opens the queue');
  check(synth.spoken().length === 0,
    'and drops the pre-gesture backlog rather than playing it at the user');
  check(n.arm() === false, 'arming twice is a no-op');
}

{
  const timers = makeTimers();
  const synth = makeSynth();
  const n = createNarrator({
    synth, Utterance: FakeUtterance,
    now: timers.nowSeconds, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });

  setSpeaker(n.asSpeaker());
  // Exactly what `AudiomMap.whatsHere()` does, unchanged since 5c.
  check(moduleSpeak('Cafe China') === true, 'the module-level speak() still returns true');
  check(eq(synth.spoken(), ['Cafe China']),
    'and now goes through the queue — the button arms it in the same click');
  check(n.isArmed() === true, 'the gesture path self-arms');

  moduleSpeak('Wisconsin Geological Survey');
  check(synth.spoken().slice(-1)[0] === 'Wisconsin Geological Survey',
    'a second press interrupts the first answer, as 5c did');
  check(n.stats().queued === 0, 'without leaving the old answer queued behind it');

  check(moduleSpeak('') === false, 'empty text is still refused');
  setSpeaker(null);
}

/* ============================================= 10. recognizer — support == */

head('10. recognizer — feature detection, never user-agent sniffing');

{
  const r = createRecognizer({});   // Node: no SpeechRecognition anywhere
  check(r.isSupported() === false, 'no recogniser in this environment');
  check(r.start() === false, 'start() refuses rather than throwing');
  check(r.getState().state === RecognizerState.UNSUPPORTED, 'and says so');
  check(r.getNotice()?.code === NoticeCode.UNSUPPORTED, 'with a notice the UI can render');
}

{
  const { FakeSR } = makeSpeechRecognition();
  const r = createRecognizer({ SpeechRecognition: FakeSR });
  check(r.isSupported() === true, 'an injected constructor is detected');
  check(r.canGoLocal() === true, 'and the on-device statics are detected separately');
}

{
  const { FakeSR } = makeSpeechRecognition({ hasStatics: false });
  const r = createRecognizer({ SpeechRecognition: FakeSR });
  check(r.canGoLocal() === false,
    'an engine without available()/install() cannot go local — this is the Safari shape');
}

/* ============================================ 11. recognizer — the modes == */

head('11. recognizer — on-device vs cloud, and the notice that must be visible');

{
  const { FakeSR, instances } = makeSpeechRecognition({ availability: Availability.AVAILABLE });
  const notices = [];
  const r = createRecognizer({ SpeechRecognition: FakeSR, onNotice: (n) => notices.push(n.code) });

  const prepared = await r.prepare();
  check(prepared.mode === SttMode.LOCAL, 'an installed pack gives on-device recognition');
  check(prepared.notice.code === NoticeCode.LOCAL, 'with an informational notice');
  check(prepared.notice.severity === 'info', 'not a warning — nothing is wrong');

  r.start();
  check(instances[0].processLocally === true, 'processLocally: true is set on the engine');
  check(instances[0].lang === 'en-US', 'with the requested language');
  check(r.isCloud() === false, 'and no audio leaves the machine');
}

{
  const { FakeSR, instances } = makeSpeechRecognition({ availability: Availability.UNAVAILABLE });
  const r = createRecognizer({ SpeechRecognition: FakeSR });

  const prepared = await r.prepare();
  check(prepared.mode === SttMode.CLOUD, 'no pack degrades to cloud recognition');
  check(prepared.notice.code === NoticeCode.CLOUD, 'and the degradation is announced');
  check(prepared.notice.severity === 'warning', 'as a WARNING — the local-only premise just broke');
  check(/microphone is sent/.test(prepared.notice.text),
    'in words that say what actually happens to the audio');

  r.start();
  check(instances[0].processLocally === undefined,
    'processLocally is never set to false — cloud is what you get by not asking for local');
  check(r.isCloud() === true && r.getNotice()?.code === NoticeCode.CLOUD,
    'and the notice is STICKY: a UI that renders it once cannot lose it');
}

{
  const { FakeSR } = makeSpeechRecognition({ hasStatics: false });
  const r = createRecognizer({ SpeechRecognition: FakeSR });
  const prepared = await r.prepare();
  check(prepared.availability === Availability.UNKNOWN,
    'an engine with no available() reports UNKNOWN, not a guess');
  check(prepared.mode === SttMode.CLOUD && prepared.notice.severity === 'warning',
    'and UNKNOWN is treated as cloud — the conservative reading');
}

{
  // The strict posture: refuse the microphone rather than upload.
  const { FakeSR, instances } = makeSpeechRecognition({ availability: Availability.UNAVAILABLE });
  const r = createRecognizer({ SpeechRecognition: FakeSR, allowCloud: false });
  const prepared = await r.prepare();
  check(prepared.mode === SttMode.UNAVAILABLE, 'allowCloud:false makes "no pack" mean "no microphone"');
  check(prepared.notice.code === NoticeCode.BLOCKED, 'with a notice explaining the refusal');
  check(r.start() === false && instances.length === 0,
    'and nothing is constructed, so nothing can be uploaded');
}

{
  const { FakeSR } = makeSpeechRecognition({ availability: Availability.DOWNLOADABLE });
  const r = createRecognizer({ SpeechRecognition: FakeSR, allowCloud: false });
  await r.prepare();
  check(r.canInstall() === true, 'a downloadable pack is offered');
  check(r.getNotice()?.code === NoticeCode.DOWNLOADABLE, 'with the install prompt');
  const ok = await r.install();
  check(ok === true && r.getMode() === SttMode.LOCAL, 'installing it switches to on-device');
  check(r.getNotice()?.code === NoticeCode.LOCAL, 'and replaces the notice');
}

{
  // start() without prepare(): the gesture path. Must NOT guess cloud.
  const { FakeSR, instances } = makeSpeechRecognition({ availability: Availability.UNAVAILABLE });
  const r = createRecognizer({ SpeechRecognition: FakeSR });
  check(r.start() === true, 'start() works with no preparation — it has to, it runs inside a click');
  check(instances[0].processLocally === true,
    'and asks for on-device: a wrong guess toward local costs a retry, toward cloud costs the audio');
}

/* ======================================== 12. recognizer — the downgrade == */

head('12. recognizer — language-not-supported is where the premise breaks');

{
  const { FakeSR, instances } = makeSpeechRecognition({ availability: Availability.AVAILABLE });
  const notices = [];
  const r = createRecognizer({ SpeechRecognition: FakeSR, onNotice: (n) => notices.push(n.code) });
  await r.prepare();
  r.start();
  check(instances.length === 1 && instances[0].processLocally === true, 'started on-device');

  instances[0].emitError('language-not-supported');
  check(instances.length === 2, 'the engine refused, so a cloud session replaces it');
  check(instances[0].aborted === true, 'the local attempt was aborted first');
  check(instances[1].processLocally === undefined, 'the replacement does not ask for local');
  check(r.getNotice()?.code === NoticeCode.CLOUD,
    'and the user is told BEFORE the cloud session, not after');
  check(notices.indexOf(NoticeCode.CLOUD) > notices.indexOf(NoticeCode.LOCAL),
    'the notice sequence records the degradation');
}

{
  const { FakeSR, instances } = makeSpeechRecognition({ availability: Availability.AVAILABLE });
  const r = createRecognizer({ SpeechRecognition: FakeSR, allowCloud: false });
  await r.prepare();
  r.start();
  instances[0].emitError('language-not-supported');
  check(instances.length === 1, 'under allowCloud:false the refusal ends the session');
  check(r.getNotice()?.code === NoticeCode.BLOCKED, 'with the blocked notice');
  check(r.isListening() === false, 'and the microphone stays shut');
}

{
  // Chrome throws synchronously when processLocally is set with no pack.
  const { FakeSR, instances, state } = makeSpeechRecognition({ availability: Availability.AVAILABLE });
  state.startThrows = 'no on-device model';
  const r = createRecognizer({ SpeechRecognition: FakeSR });
  await r.prepare();
  const ok = r.start();
  check(ok === true && instances.length === 2,
    'a synchronous throw takes the same downgrade path as the async error');
  check(instances[1].processLocally === undefined, 'landing on cloud');
}

{
  // The pathological engine: refuses the cloud replacement too. There is nowhere
  // left to fall back to, and a retry-on-error rule would reopen the microphone
  // on every error event forever.
  const { FakeSR, instances } = makeSpeechRecognition({ availability: Availability.AVAILABLE });
  const r = createRecognizer({ SpeechRecognition: FakeSR });
  await r.prepare();
  r.start();
  instances[0].emitError('language-not-supported');
  instances[1].emitError('language-not-supported');
  check(instances.length === 2, 'a second refusal starts nothing new', `${instances.length} instances`);
  check(r.getState().state === RecognizerState.ERROR, 'it lands in ERROR instead of looping');
  check(r.isListening() === false, 'with the microphone shut');
}

/* ========================================= 13. recognizer — the mic errors == */

head('13. recognizer — permission, hardware and network');

{
  const { FakeSR, instances } = makeSpeechRecognition();
  const r = createRecognizer({ SpeechRecognition: FakeSR });
  r.start();
  instances[0].emitError('not-allowed');
  check(r.getState().state === RecognizerState.ERROR, 'a refused permission is fatal');
  check(r.getNotice()?.code === NoticeCode.MIC_DENIED, 'with a notice that names the cause');
  check(r.isListening() === false, 'and stops listening');
}

{
  const { FakeSR, instances } = makeSpeechRecognition();
  const r = createRecognizer({ SpeechRecognition: FakeSR });
  r.start();
  instances[0].emitError('audio-capture');
  check(r.getNotice()?.code === NoticeCode.NO_MIC, 'no microphone is reported distinctly from no permission');
}

{
  // ⚠️ A network error while claiming to be on-device means it was never on-device.
  const { FakeSR, instances } = makeSpeechRecognition({ availability: Availability.AVAILABLE });
  const r = createRecognizer({ SpeechRecognition: FakeSR });
  await r.prepare();
  r.start();
  check(r.getMode() === SttMode.LOCAL, 'the session claims to be local');
  instances[0].emitError('network');
  check(r.getMode() === SttMode.CLOUD && r.getNotice()?.code === NoticeCode.CLOUD,
    'a network error proves it was not, and the claim is corrected rather than retried silently');
}

{
  const timers = makeTimers();
  const { FakeSR, instances } = makeSpeechRecognition();
  const r = createRecognizer({
    SpeechRecognition: FakeSR,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  r.start();
  instances[0].emitError('no-speech');
  instances[0].emitEnd();
  check(instances.length === 1, 'no-speech is benign, and push-to-talk does not restart on its own');
  check(r.isListening() === false, 'the session just ends');
}

{
  const timers = makeTimers();
  const { FakeSR, instances } = makeSpeechRecognition();
  const r = createRecognizer({
    SpeechRecognition: FakeSR, autoRestart: true,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  r.start();
  instances[0].emitEnd();
  check(instances.length === 1, 'the restart is scheduled, not immediate');
  timers.advance(500);
  check(instances.length === 2, 'autoRestart reopens the microphone after the backoff');
  r.stop();
  timers.advance(2000);
  check(instances.length === 2, 'and an explicit stop() cancels any pending restart');
}

/* ============================================= 14. recognizer — results == */

head('14. recognizer — transcripts, and the resultIndex every tutorial gets wrong');

{
  check(readResult(resultEvent([{ transcript: 'what is this', isFinal: true }]))?.transcript === 'what is this',
    'a final result reads through');
  check(readResult(resultEvent([{ transcript: 'what is', isFinal: false }]))?.isFinal === false,
    'an interim result is marked interim');
  check(readResult({ results: [] }) === null, 'an empty list yields nothing');
  check(readResult(undefined) === null, 'and so does a malformed event');

  // Chrome re-sends the whole list every time; only results at or after
  // resultIndex are new. Reading results[0] duplicates finals in continuous mode.
  const event = resultEvent([
    { transcript: 'already delivered', isFinal: true },
    { transcript: 'the new part', isFinal: true },
  ], 1);
  check(readResult(event)?.transcript === 'the new part',
    'only results at or after resultIndex are read');

  const alts = readResult(resultEvent([{ transcript: 'main street', isFinal: true, alts: ['maine street'] }]));
  check(eq(alts.alternatives, ['maine street']), 'alternatives are kept — proper nouns need them');
  check(alts.confidence === 0.9, 'and confidence rides along');
}

{
  const { FakeSR, instances } = makeSpeechRecognition();
  const finals = [];
  const all = [];
  const r = createRecognizer({
    SpeechRecognition: FakeSR,
    onFinal: (t) => finals.push(t),
    onResult: (res) => all.push([res.transcript, res.isFinal]),
  });
  r.start();
  instances[0].emitResult(resultEvent([{ transcript: 'what is', isFinal: false }]));
  instances[0].emitResult(resultEvent([{ transcript: 'what is this', isFinal: true }]));
  check(eq(finals, ['what is this']), 'onFinal fires only for finals');
  check(all.length === 2, 'onResult fires for both');
  check(matchL0(finals[0])?.intent === 'whats_here',
    'and the transcript lands straight on an L0 lexicon entry — mic to answer with no model');
}

/* ========================================== 15. recognizer — phrase bias == */

head('15. recognizer — contextual biasing, the free half of the proper-noun problem');

{
  const built = buildPhrases(['Cafe China', 'Cafe China', ' ', 'Conant Street'], 2.0, FakePhrase);
  check(built.length === 2, 'duplicates and blanks are dropped');
  check(built[0].phrase === 'Cafe China' && built[0].boost === 2.0, 'and the boost is applied');
  check(buildPhrases(['x'], 2, null) === null, 'an engine with no phrase type gets null, not a crash');
  check(buildPhrases([], 2, FakePhrase) === null, 'and an empty list is null');
}

{
  const { FakeSR, instances } = makeSpeechRecognition();
  const r = createRecognizer({
    SpeechRecognition: FakeSR,
    SpeechRecognitionPhrase: FakePhrase,
    phrases: ['Conant Street', 'Joseph Campau Avenue'],
  });
  r.start();
  check(instances[0].phrases?.length === 2, 'in-window place names are handed to the engine');
  check(r.getState().biasingApplied === true, 'and recorded as applied');

  r.abort();
  r.setPhrases(['East Seven Mile Road']);
  r.start();
  check(instances[1].phrases?.length === 1, 'setPhrases() takes effect on the next start — the window moved');
}

{
  const { FakeSR } = makeSpeechRecognition();
  const r = createRecognizer({ SpeechRecognition: FakeSR, phrases: ['Conant Street'] });
  r.start();  // no SpeechRecognitionPhrase injected and none on globalThis
  check(r.getState().biasingApplied === false, 'an engine without biasing simply does not get it');
  check(r.getNotice()?.code === NoticeCode.PHRASES_UNSUPPORTED,
    'and the accuracy cost is disclosed rather than hidden');
  check(r.isListening() === true, 'the session still runs — biasing is a nicety, not a requirement');
}

/* ================================================= 16. the two halves == */

head('16. linkBargeIn — the one place speech in and speech out meet');

{
  const timers = makeTimers();
  const synth = makeSynth();
  const { FakeSR, instances } = makeSpeechRecognition();
  const n = createNarrator({
    synth, Utterance: FakeUtterance,
    now: timers.nowSeconds, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  const r = createRecognizer({ SpeechRecognition: FakeSR });
  const link = linkBargeIn(r, n);

  n.arm();
  n.narrate('a long answer the user has stopped caring about', { layer: 'L3' });
  check(n.isSpeaking() === true, 'the app is talking');

  link.start();
  check(n.isSpeaking() === false,
    'pressing the mic barges in: what was being said is stale by the user’s own judgement');
  check(instances.length === 1 && instances[0].started === true, 'and the microphone opened');
  check(n.isArmed() === true, 'the same gesture armed the narrator');
}

{
  // mode:'voice' wires acoustic barge-in. Off by default because with a
  // loudspeaker the recogniser hears our own synthesiser.
  const timers = makeTimers();
  const synth = makeSynth();
  const { FakeSR, instances } = makeSpeechRecognition();
  const n = createNarrator({
    synth, Utterance: FakeUtterance, autoStart: true,
    now: timers.nowSeconds, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  const r = createRecognizer({ SpeechRecognition: FakeSR, bargeInOnSpeech: true });
  linkBargeIn(r, n, { mode: 'voice' });

  r.start();
  n.narrate('describing the north wing at length', { layer: 'L3' });
  instances[0].emitSpeechStart();
  check(n.isSpeaking() === false, 'acoustic barge-in stops narration when enabled');

  const r2 = createRecognizer({ SpeechRecognition: FakeSR });
  const n2 = createNarrator({
    synth: makeSynth(), Utterance: FakeUtterance, autoStart: true,
    now: timers.nowSeconds, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  linkBargeIn(r2, n2, { mode: 'voice' });
  r2.start();
  n2.narrate('describing the south wing at length', { layer: 'L3' });
  instances[instances.length - 1].emitSpeechStart();
  check(n2.isSpeaking() === true,
    'but with bargeInOnSpeech off (the default) the app cannot silence itself by hearing itself');
}

/* ================================================= 17. dispatcher shape == */

head('17. narrator.speak() — the shape dispatcher.js already calls');

{
  const timers = makeTimers();
  const synth = makeSynth();
  const n = createNarrator({
    synth, Utterance: FakeUtterance, autoStart: true,
    now: timers.nowSeconds, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });

  // dispatcher.js:184 — `this.speak?.(text, { layer: 'L0', turnId: ctx.turnId })`
  n.speak('Cafe China.', { layer: 'L0', turnId: 'turn-1' });
  check(eq(synth.spoken(), ['Cafe China.']), 'the dispatcher seam narrates');
  check(n.queue.currentAnnouncement.category === Category.GRAPH,
    'L0 maps to the GRAPH category');
  check(n.queue.currentAnnouncement.priority === Priority.LOW,
    'at LOW, so it can never preempt a navigation warning');

  n.speak('The plaza is to your north. It has a ramp.', { layer: 'L3', turnId: 'turn-2' });
  check(n.stats().queued === 1,
    'an L3 answer is split into sentences, so it can be interrupted between them');
  check(n.queue.currentAnnouncement.category === Category.LLM, 'and lands in the LLM category');
}

/* --------------------------------------------------------------------- */

console.log(
  `\n${total} checks, ${failures === 0 ? 'all passed' : `${failures} failed`}\n`,
);
process.exit(failures === 0 ? 0 : 1);
