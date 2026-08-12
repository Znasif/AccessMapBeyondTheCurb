#!/usr/bin/env node
/**
 * Milestones 5b + 5c check: the Audiom side-effect channel and the minimal
 * speech path.
 *
 *   node starter/scripts/test_audiom_channel.mjs
 *
 * FULLY OFFLINE, and unlike `test_audiom_adapter.mjs` there is no live half —
 * there is nothing here a network could tell us. The channel's contract is a
 * message shape, an origin filter and a timeout, all of which a fake transport
 * exercises better than a real iframe would.
 *
 * The transport is a stand-in for the embed: it records what we send, and lets a
 * test push inbound events back with an arbitrary origin. Timers are injected so
 * the 1200 ms `getState` timeout is checked in microseconds rather than waited
 * out — the bounds probe issues ~90 of those per map, so the timeout is load
 * bearing and must be covered.
 */

import {
  createAudiomChannel,
  createFeatureTimingRecorder,
  featureNames,
  toPosition,
  whatsHere,
  LIVE_FEATURE_MAX_AGE_MS,
  OUTBOUND,
  INBOUND,
  FEATURE_EVENTS,
  DEFAULT_STATE_TIMEOUT_MS,
  NOTHING_HERE,
} from '../src/lib/audiomChannel.js';
import { createSpeaker, getSpeaker, setSpeaker, speak, cancelSpeech } from '../src/lib/speak.js';

let failures = 0;
function check(ok, label, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures += 1;
}
const section = (title) => console.log(`\n— ${title} ${'—'.repeat(Math.max(0, 62 - title.length))}`);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const ORIGIN = 'https://audiom-staging.herokuapp.com';
const OTHER_ORIGIN = 'https://evil.example.com';

/* ------------------------------------------------------------------ harness -- */

/**
 * A fake embed. `sent` is everything the channel posted; `emit` plays a message
 * back. `targets` records the origin each message was posted to, because
 * targeting the wrong origin is the one bug a shape assertion would miss.
 */
function makeTransport({ alive = true } = {}) {
  const sent = [];
  const targets = [];
  let handler = null;
  let subscribed = 0;
  let unsubscribed = 0;
  const t = {
    sent,
    targets,
    alive,
    get subscribed() { return subscribed; },
    get unsubscribed() { return unsubscribed; },
    post(message, origin) {
      if (!t.alive) return false;
      sent.push(message);
      targets.push(origin);
      return true;
    },
    subscribe(h) {
      handler = h;
      subscribed += 1;
      return () => { unsubscribed += 1; handler = null; };
    },
    emit(data, origin = ORIGIN) { handler?.({ origin, data }); },
    last() { return sent[sent.length - 1]; },
    clear() { sent.length = 0; targets.length = 0; },
  };
  return t;
}

/** Manual timers: nothing fires until `fire()` is called. */
function makeTimers() {
  const pending = new Map();
  let next = 1;
  return {
    pending,
    setTimer(fn, ms) { const id = next++; pending.set(id, { fn, ms }); return id; },
    clearTimer(id) { pending.delete(id); },
    fireAll() {
      const entries = [...pending.entries()];
      pending.clear();
      for (const [, { fn }] of entries) fn();
    },
  };
}

function makeChannel(opts = {}) {
  const transport = opts.transport ?? makeTransport();
  const timers = opts.timers ?? makeTimers();
  const channel = createAudiomChannel({
    origin: ORIGIN,
    post: transport.post,
    subscribe: transport.subscribe,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    now: opts.now ?? (() => 1_000_000),
    onHandlerError: opts.onHandlerError ?? (() => {}),
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
  });
  return { channel, transport, timers };
}

const featurePayload = (...names) => ({ features: names.map((name) => ({ name })) });

/* ------------------------------------------------------------------- purity -- */

section('platform-free (§4: it must import and run in Node)');

check(typeof createAudiomChannel === 'function', 'audiomChannel.js imports in Node with no globals');
check(typeof createSpeaker === 'function', 'speak.js imports in Node with no DOM at module scope');
check(globalThis.speechSynthesis === undefined, 'the Node environment genuinely has no speechSynthesis');
check(getSpeaker().isAvailable() === false, 'the default speaker reports unavailable rather than throwing');
check(speak('hello') === false, 'the module-level speak() is a safe no-op with no synth');
check(cancelSpeech() === false, 'cancelSpeech() is a safe no-op with no synth');

/* ------------------------------------------------------------ pure helpers -- */

section('toPosition / featureNames / whatsHere');

check(eq(toPosition({ lng: -73.9, lat: 40.7 }), [-73.9, 40.7]), 'toPosition accepts the coordRef shape');
check(eq(toPosition([-73.9, 40.7]), [-73.9, 40.7]), 'toPosition round-trips a stateChanged position');
check(toPosition(null) === null, 'toPosition(null) is null');
check(toPosition({ lng: 1 }) === null, 'toPosition rejects a missing lat');
check(toPosition([NaN, 40.7]) === null, 'toPosition rejects NaN');
check(eq(toPosition([0, 0]), [0, 0]), 'toPosition keeps a legitimate [0, 0]');

check(eq(featureNames(featurePayload('Main St', 'Plaza')), ['Main St', 'Plaza']), 'featureNames extracts names in order');
check(eq(featureNames({ features: [{ name: 'A' }, {}, { name: '' }, null] }), ['A']), 'featureNames drops unnamed and null features');
check(eq(featureNames(undefined), []), 'featureNames of undefined is empty');
check(eq(featureNames({}), []), 'featureNames of a payload with no features is empty');

check(whatsHere({ names: ['Main St'] }) === 'Main St', 'whatsHere is the bare name — no framing, no inference');
check(whatsHere({ names: ['A', 'B'] }) === 'A, B', 'whatsHere joins exactly like the status line');
check(whatsHere(null) === NOTHING_HERE, 'whatsHere(null) is the empty answer');
check(whatsHere({ names: [] }) === NOTHING_HERE, 'whatsHere with no names is the empty answer');
check(whatsHere(null, { empty: 'silence' }) === 'silence', 'the empty answer is overridable');
check(
  whatsHere({ names: ['Cafe China'], features: [{ name: 'Cafe China', adjacent: ['x'] }] }) === 'Cafe China',
  'whatsHere never reaches into the raw feature for adjacency (tier C nuance, §2.2)',
);

/* ------------------------------------------------------------ construction -- */

section('construction');

let threw = null;
try { createAudiomChannel({ origin: ORIGIN }); } catch (e) { threw = e; }
check(threw instanceof Error, 'createAudiomChannel without `post` throws');
threw = null;
try { createAudiomChannel({ post: () => {} }); } catch (e) { threw = e; }
check(threw instanceof Error, 'createAudiomChannel without `origin` throws');
check(DEFAULT_STATE_TIMEOUT_MS === 1200, 'the getState timeout still matches the probe-tuned 1200 ms');
check(eq([...FEATURE_EVENTS], ['featureEntered', 'featureSelected']), 'both feature messages are in the stream');

{
  const { transport } = makeChannel();
  check(transport.subscribed === 1, 'the transport is subscribed exactly once, at construction');
}

/* --------------------------------------------------------- outbound shapes -- */

section('outbound messages (§2.2 table)');

{
  const { channel, transport } = makeChannel();

  check(channel.moveAvatar({ lng: -73.9, lat: 40.7 }) === true, 'moveAvatar reports the send');
  check(
    eq(transport.last(), { type: OUTBOUND.MOVE_AVATAR, payload: { position: [-73.9, 40.7] } }),
    'moveAvatar sends { type, payload: { position: [lng, lat] } }',
  );
  check(transport.targets[transport.targets.length - 1] === ORIGIN, 'moveAvatar is targeted at AUDIOM_ORIGIN, not "*"');

  check(channel.moveAvatar([1, 2]) === true, 'moveAvatar accepts the array form the probe uses');
  check(eq(transport.last().payload.position, [1, 2]), 'the array form is sent unchanged');

  const before = transport.sent.length;
  check(channel.moveAvatar({ lng: NaN, lat: 40.7 }) === false, 'moveAvatar refuses a non-finite position');
  check(channel.moveAvatar(null) === false, 'moveAvatar refuses null');
  check(transport.sent.length === before, 'a refused moveAvatar sends nothing');

  check(channel.executeCommand('up') === true, 'executeCommand reports the send');
  check(
    eq(transport.last(), { type: OUTBOUND.EXECUTE_COMMAND, payload: { command: 'up' } }),
    'executeCommand sends { type, payload: { command } }',
  );
  check(channel.executeCommand('') === false, 'executeCommand refuses an empty command');
}

{
  const transport = makeTransport({ alive: false });
  const { channel } = makeChannel({ transport });
  check(channel.moveAvatar([1, 2]) === false, 'moveAvatar is false when the iframe has no contentWindow');
  check(channel.executeCommand('up') === false, 'executeCommand is false when there is no target');
}

/* ------------------------------------------------------------------ inbound -- */

section('inbound dispatch and the origin filter');

{
  const { channel, transport } = makeChannel();
  const seen = [];
  const off = channel.onMessage((type, payload) => seen.push([type, payload]));

  transport.emit({ type: INBOUND.READY });
  check(eq(seen, [[INBOUND.READY, undefined]]), 'a ready message reaches onMessage');

  transport.emit({ type: INBOUND.ERROR, payload: { code: 'BAD_KEY' } }, OTHER_ORIGIN);
  check(seen.length === 1, 'a message from another origin is dropped');

  transport.emit({ payload: { code: 'x' } });
  check(seen.length === 1, 'a message with no type is dropped');

  transport.emit({ type: INBOUND.ERROR, payload: { code: 'BAD_KEY' } });
  check(seen.length === 2 && seen[1][1].code === 'BAD_KEY', 'the error payload reaches onMessage intact');

  off();
  transport.emit({ type: INBOUND.READY });
  check(seen.length === 2, 'unsubscribing stops delivery');
}

{
  // The isolation the old code got for free from separate window listeners.
  const errors = [];
  const { channel, transport } = makeChannel({ onHandlerError: (e) => errors.push(e) });
  const seen = [];
  channel.onMessage(() => { throw new Error('boom'); });
  channel.onMessage((type) => seen.push(type));
  transport.emit({ type: INBOUND.READY });
  check(eq(seen, [INBOUND.READY]), 'a throwing subscriber does not stop the next one');
  check(errors.length === 1 && errors[0].message === 'boom', 'the throw is reported, not swallowed');
}

/* ------------------------------------------------------------------ getState -- */

section('getState');

{
  const { channel, transport, timers } = makeChannel();
  const p = channel.getState();
  check(eq(transport.last(), { type: OUTBOUND.GET_STATE }), 'getState sends { type: "getState" }');
  check(timers.pending.size === 1, 'getState arms exactly one timeout');
  check([...timers.pending.values()][0].ms === DEFAULT_STATE_TIMEOUT_MS, 'the default timeout is used');

  transport.emit({ type: INBOUND.STATE_CHANGED, payload: { position: [10, 20] } });
  const got = await p;
  check(eq(got, [10, 20]), 'getState resolves the position from stateChanged');
  check(timers.pending.size === 0, 'the timeout is cleared once it resolves');

  // Nothing must still be listening: a stray stateChanged after resolution used
  // to be exactly the bug the one-shot listener existed to prevent.
  const seen = [];
  channel.onMessage((type) => seen.push(type));
  transport.emit({ type: INBOUND.STATE_CHANGED, payload: { position: [99, 99] } });
  check(seen.length === 1, 'a later stateChanged does not re-resolve a settled getState');
}

{
  const { channel, transport, timers } = makeChannel();
  const p = channel.getState();
  transport.emit({ type: INBOUND.READY });
  transport.emit({ type: INBOUND.FEATURE_ENTERED, payload: featurePayload('Main St') });
  check(timers.pending.size === 1, 'getState ignores messages that are not stateChanged');
  timers.fireAll();
  check((await p) === null, 'getState resolves null on timeout instead of rejecting');
}

{
  const { channel, transport } = makeChannel();
  const p = channel.getState();
  transport.emit({ type: INBOUND.STATE_CHANGED, payload: {} });
  check((await p) === null, 'a stateChanged with no position resolves null');
}

{
  const { channel, timers } = makeChannel({ timeoutMs: 50 });
  channel.getState();
  check([...timers.pending.values()][0].ms === 50, 'the channel-wide timeout override is honoured');
  channel.getState({ timeoutMs: 3000 });
  check(
    [...timers.pending.values()].some((t) => t.ms === 3000),
    'the per-call timeout is honoured (the ready handler asks for 3000 ms)',
  );
}

{
  const transport = makeTransport({ alive: false });
  const { channel, timers } = makeChannel({ transport });
  check((await channel.getState()) === null, 'getState resolves null immediately when nothing can be sent');
  check(timers.pending.size === 0, 'and leaves no timer behind');
}

/* ------------------------------------------------- the live feature stream -- */

section('featureEntered / featureSelected — the L0 whats_here source');

{
  const { channel, transport } = makeChannel({ now: () => 42 });
  const records = [];
  const off = channel.onFeature((r) => records.push(r));

  check(channel.getLastFeature() === null, 'no feature before the first message');
  check(channel.whatsHere() === NOTHING_HERE, 'whats_here before any feature is the empty answer');

  transport.emit({ type: INBOUND.FEATURE_ENTERED, payload: featurePayload('Main St', 'Plaza') });
  check(records.length === 1, 'featureEntered reaches onFeature');
  check(eq(records[0].names, ['Main St', 'Plaza']), 'the record carries the names');
  check(records[0].text === 'Main St, Plaza', 'the record carries the status-line text');
  check(records[0].type === INBOUND.FEATURE_ENTERED, 'the record records which message produced it');
  check(records[0].at === 42, 'the record is stamped from the injected clock');
  check(records[0].features.length === 2, 'the raw features are preserved for tier-A enrichment later');

  check(channel.whatsHere() === 'Main St, Plaza', 'whats_here answers from the last payload, synchronously');
  check(channel.getLastFeature() === records[0], 'getLastFeature is the same record the subscriber saw');

  transport.emit({ type: INBOUND.FEATURE_SELECTED, payload: featurePayload('Cafe China') });
  check(records.length === 2 && records[1].type === INBOUND.FEATURE_SELECTED, 'featureSelected also feeds the stream');
  check(channel.whatsHere() === 'Cafe China', 'the newest feature wins');

  // Preserved from AudiomMap: `if (names.length) setLastFeature(...)`.
  transport.emit({ type: INBOUND.FEATURE_ENTERED, payload: { features: [{}, { name: '' }] } });
  check(records.length === 2, 'an unnamed payload emits nothing');
  check(channel.whatsHere() === 'Cafe China', 'an unnamed payload does not clear the previous answer');

  transport.emit({ type: INBOUND.FEATURE_ENTERED, payload: featurePayload('Elsewhere') }, OTHER_ORIGIN);
  check(channel.whatsHere() === 'Cafe China', 'a feature from another origin cannot poison the answer');

  off();
  transport.emit({ type: INBOUND.FEATURE_ENTERED, payload: featurePayload('Later') });
  check(records.length === 2, 'unsubscribing stops feature delivery');
  check(channel.whatsHere() === 'Later', 'but the channel keeps tracking for a synchronous read');
}

{
  // Ordering: the record must already be current when subscribers run, or a
  // dispatcher reading getLastFeature() from inside a handler sees the previous one.
  const { channel, transport } = makeChannel();
  let seenInside = null;
  channel.onFeature(() => { seenInside = channel.whatsHere(); });
  channel.onMessage(() => { if (seenInside === null) seenInside = 'message-handler-ran-first'; });
  transport.emit({ type: INBOUND.FEATURE_ENTERED, payload: featurePayload('Main St') });
  check(seenInside === 'Main St', 'lastFeature is updated before any handler runs');
}

/* --------------------------------------------------------------- the probe -- */

section('the tier-C bounds probe still works through the channel');

{
  /**
   * A fake Audiom: holds a position, and a movement command only moves the
   * avatar while it is inside the rectangle. That is the whole oracle the binary
   * search in AudiomMap reads, replayed here to prove the channel supports the
   * moveAvatar → getState → executeCommand → getState sequence unchanged.
   */
  const RECT = { w: -10, e: 10, s: -5, n: 5 };
  let pos = [0, 0];
  const inside = ([x, y]) => x >= RECT.w && x <= RECT.e && y >= RECT.s && y <= RECT.n;
  const transport = makeTransport();
  const timers = makeTimers();
  const world = {
    post(message, origin) {
      const ok = transport.post(message, origin);
      if (!ok) return false;
      if (message.type === OUTBOUND.MOVE_AVATAR) pos = message.payload.position;
      if (message.type === OUTBOUND.EXECUTE_COMMAND && inside(pos)) pos = [pos[0], pos[1] + 0.1];
      if (message.type === OUTBOUND.GET_STATE) {
        transport.emit({ type: INBOUND.STATE_CHANGED, payload: { position: [...pos] } });
      }
      return true;
    },
    subscribe: transport.subscribe,
  };
  const channel = createAudiomChannel({
    origin: ORIGIN, post: world.post, subscribe: world.subscribe,
    setTimer: timers.setTimer, clearTimer: timers.clearTimer,
  });

  const isInside = async (lng, lat, probe) => {
    channel.moveAvatar([lng, lat]);
    const before = await channel.getState();
    if (!before) return null;
    channel.executeCommand(probe);
    const after = await channel.getState();
    if (!after) return null;
    return Math.hypot(after[0] - before[0], after[1] - before[1]) > 1e-9;
  };

  check((await isInside(0, 0, 'up')) === true, 'the probe reads a point inside the map as inside');
  check((await isInside(50, 0, 'up')) === false, 'the probe reads a point outside the map as outside');
  check(timers.pending.size === 0, 'the probe leaves no timers pending');
  check(transport.sent.filter((m) => m.type === OUTBOUND.GET_STATE).length === 4, 'two getState calls per probe step');
}

/* ------------------------------------------------------- feature cadence -- */

section('feature cadence instrumentation (the LIVE_FEATURE_MAX_AGE_MS question)');

{
  check(
    createFeatureTimingRecorder().threshold === LIVE_FEATURE_MAX_AGE_MS,
    'the recorder defaults to the very threshold it exists to test',
    `${LIVE_FEATURE_MAX_AGE_MS} ms`,
  );

  const recorder = createFeatureTimingRecorder({ threshold: 3000, label: 'map 885' });
  check(recorder.summary().events === 0, 'a fresh recorder has no events');
  check(recorder.format().includes('no events recorded yet'), 'and formats as such rather than crashing');

  // 100, 200, 5000, 300 ms apart — one gap deliberately past the threshold.
  const at = [1000, 1100, 1300, 6300, 6600];
  recorder.record({ type: INBOUND.FEATURE_ENTERED, names: ['A'], at: at[0] });
  recorder.record({ type: INBOUND.FEATURE_ENTERED, names: ['B'], at: at[1] });
  recorder.record({ type: INBOUND.FEATURE_SELECTED, names: ['B'], at: at[2] });
  recorder.record({ type: INBOUND.FEATURE_ENTERED, names: [], at: at[3] });
  recorder.record({ type: INBOUND.FEATURE_ENTERED, names: ['C'], at: at[4] });

  const s = recorder.summary();
  check(s.events === 5, 'every feature event is recorded');
  check(s.named === 4, 'named and unnamed events are counted separately');
  check(eq(recorder.deltas(), [100, 200, 5000, 300]), 'inter-arrival times are the gaps between consecutive events');
  check(s.interArrival.min === 100 && s.interArrival.max === 5000, 'min and max come from those gaps');
  check(s.interArrival.p50 === 200, 'p50 of [100,200,300,5000] is 200');
  check(s.interArrival.mean === 1400, 'the mean is reported too');
  check(s.spanMs === 5600, 'the span is first to last');
  check(s.repeats === 1, 'a repeat of the same name is counted (B entered then selected)');

  check(s.byType[INBOUND.FEATURE_ENTERED].events === 4, 'per-type event counts');
  check(s.byType[INBOUND.FEATURE_SELECTED].events === 1, 'including the rarer type');
  check(s.byType[INBOUND.FEATURE_SELECTED].p50 === null, 'a single event of a type has no same-type interval');
  check(s.byType[INBOUND.FEATURE_ENTERED].p50 === 300, 'same-type intervals are tracked apart from any-type ones');

  check(s.overThreshold.count === 1, 'exactly one gap exceeded the 3000 ms threshold');
  check(Math.abs(s.overThreshold.fraction - 0.25) < 1e-9, 'and the fraction is reported for the M7 decision');

  const text = recorder.format();
  check(text.includes('map 885'), 'the label appears in the dump');
  check(text.includes('p50 200 ms'), 'the dump is readable without a debugger');
  check(text.includes('LIVE_FEATURE_MAX_AGE_MS=3000'), 'the dump names the threshold it is testing');
  check(text.split('\n').length >= 6, 'the dump is a short table, not a wall of text');

  recorder.reset();
  check(recorder.summary().events === 0, 'reset clears the samples');
}

{
  const recorder = createFeatureTimingRecorder({ capacity: 3 });
  for (let i = 0; i < 6; i += 1) recorder.record({ type: INBOUND.FEATURE_ENTERED, names: ['x'], at: i * 100 });
  const s = recorder.summary();
  check(s.events === 3, 'the ring buffer is bounded by `capacity`');
  check(s.dropped === 3, 'and reports how many samples it dropped');
}

{
  const { channel, transport } = makeChannel({ now: (() => { let t = 0; return () => { t += 250; return t; }; })() });

  check(channel.getFeatureTiming() === null, 'timing is OFF by default — zero allocation, zero cost');
  transport.emit({ type: INBOUND.FEATURE_ENTERED, payload: featurePayload('Ignored') });
  check(channel.getFeatureTiming() === null, 'events while off are not recorded and allocate no recorder');
  check(channel.dumpFeatureTiming().includes('not recording'), 'dumping while off explains how to turn it on');

  const recorder = channel.enableFeatureTiming({ label: 'test' });
  check(channel.getFeatureTiming() === recorder, 'enableFeatureTiming returns the live recorder');
  check(channel.enableFeatureTiming() === recorder, 'calling it twice does not discard the samples already collected');

  transport.emit({ type: INBOUND.FEATURE_ENTERED, payload: featurePayload('A') });
  transport.emit({ type: INBOUND.FEATURE_ENTERED, payload: { features: [{}] } });
  transport.emit({ type: INBOUND.FEATURE_SELECTED, payload: featurePayload('B') });
  transport.emit({ type: INBOUND.READY });

  const s = recorder.summary();
  check(s.events === 3, 'only feature messages are timed — ready is not a cadence sample');
  check(s.named === 2, 'the unnamed featureEntered is still timed (the avatar did move)');
  check(eq(recorder.deltas(), [250, 250]), 'deltas come from the channel clock');
  check(channel.whatsHere() === 'B', 'recording does not disturb the whats_here answer');

  channel.enableFeatureTiming({ reset: true });
  check(recorder.summary().events === 0, '{ reset: true } starts a fresh measurement');

  channel.disableFeatureTiming();
  check(channel.getFeatureTiming() === null, 'timing can be switched back off');
  transport.emit({ type: INBOUND.FEATURE_ENTERED, payload: featurePayload('C') });
  check(recorder.summary().events === 0, 'and stays off');
}

{
  const { channel, transport } = makeChannel();
  channel.enableFeatureTiming();
  channel.dispose();
  check(channel.getFeatureTiming() === null, 'dispose drops the recorder with everything else');
  transport.emit({ type: INBOUND.FEATURE_ENTERED, payload: featurePayload('A') });
  check(channel.getFeatureTiming() === null, 'and nothing is recorded after dispose');
}

/* --------------------------------------------------------------- disposal -- */

section('dispose');

{
  const { channel, transport } = makeChannel();
  const seen = [];
  channel.onMessage((t) => seen.push(t));
  channel.dispose();
  check(transport.unsubscribed === 1, 'dispose detaches the transport');
  check(channel.isDisposed() === true, 'dispose is observable');
  transport.emit({ type: INBOUND.READY });
  check(seen.length === 0, 'nothing is delivered after dispose');
  check(channel.moveAvatar([1, 2]) === false, 'sends after dispose are no-ops');
  channel.dispose();
  check(transport.unsubscribed === 1, 'dispose is idempotent');
}

/* ------------------------------------------------------------------- speak -- */

section('speak.js — the minimal path (M5c), swappable for the M-S queue');

function makeSynth() {
  const calls = [];
  return {
    calls,
    cancel() { calls.push(['cancel']); },
    speak(u) { calls.push(['speak', u.text]); },
  };
}
class FakeUtterance {
  constructor(text) { this.text = text; this.onend = null; this.onerror = null; }
}

{
  const synth = makeSynth();
  const speaker = createSpeaker({ synth, Utterance: FakeUtterance });

  check(speaker.isAvailable() === true, 'a speaker with an injected synth is available');
  check(speaker.speak('Main St') === true, 'speak reports that it started');
  check(
    eq(synth.calls, [['cancel'], ['speak', 'Main St']]),
    'cancel-then-speak, exactly the three lines lifted from TactileExplorerGeneric',
  );

  synth.calls.length = 0;
  check(speaker.speak('') === false, 'empty text says nothing');
  check(speaker.speak('   ') === false, 'whitespace-only text says nothing');
  check(speaker.speak(null) === false, 'null says nothing');
  check(synth.calls.length === 0, 'and none of those touched the synth');

  check(speaker.speak('  Cafe China  ') === true, 'text is trimmed, not rejected');
  check(synth.calls[1][1] === 'Cafe China', 'the trimmed text is what is spoken');

  synth.calls.length = 0;
  check(speaker.cancel() === true, 'cancel() reaches the synth');
  check(eq(synth.calls, [['cancel']]), 'cancel() sends exactly one cancel');
}

{
  // Queue compatibility (milestone S): Announcement-shaped input, no-interrupt
  // mode, and an onEnd hook where finishCurrent() will go.
  const synth = makeSynth();
  const speaker = createSpeaker({ synth, Utterance: FakeUtterance });

  check(speaker.speak({ text: 'From an Announcement' }) === true, 'speak accepts an { text } announcement');
  check(synth.calls[1][1] === 'From an Announcement', 'the announcement text is spoken');
  check(speaker.textOf({ text: ' x ' }) === 'x', 'textOf normalises both input shapes');
  check(speaker.textOf({ id: 'a1' }) === '', 'a text-less announcement yields no text');

  synth.calls.length = 0;
  speaker.speak('serialised', { interrupt: false });
  check(eq(synth.calls.map((c) => c[0]), ['speak']), 'interrupt:false skips the cancel, so a queue does not shoot itself down');
}

{
  let ended = 0;
  const spoken = [];
  const trackingSynth = { cancel() {}, speak(u) { spoken.push(u); } };
  const speaker = createSpeaker({ synth: trackingSynth, Utterance: FakeUtterance });

  speaker.speak('one', { onEnd: () => { ended += 1; } });
  spoken[0].onend();
  check(ended === 1, 'onEnd fires from onend — where finishCurrent() goes');
  speaker.speak('two', { onEnd: () => { ended += 1; } });
  spoken[1].onerror();
  check(ended === 2, 'onEnd also fires from onerror, so a dropped utterance cannot stall a queue');

  speaker.speak('three');
  check(spoken[2].onend === null, 'no onEnd means no handler is installed');
}

{
  const throwingSynth = { cancel() { throw new Error('nope'); }, speak() {} };
  const errors = [];
  const speaker = createSpeaker({ synth: throwingSynth, Utterance: FakeUtterance, onError: (e) => errors.push(e) });
  check(speaker.speak('x') === false, 'a throwing synth returns false instead of crashing the caller');
  check(errors.length === 1, 'the error is reported to onError');
  check(speaker.cancel() === false, 'a throwing cancel() returns false');
}

{
  const speaker = createSpeaker({ synth: null, Utterance: null });
  check(speaker.isAvailable() === false, 'an explicitly absent synth is unavailable');
  let ended = 0;
  check(speaker.speak('x', { onEnd: () => { ended += 1; } }) === false, 'speak is false when nothing can speak');
  check(ended === 0, 'onEnd does NOT fire when the utterance never started — the caller must read the boolean');
}

{
  // The seam milestone S swaps the queue in through.
  const synth = makeSynth();
  setSpeaker(createSpeaker({ synth, Utterance: FakeUtterance }));
  check(speak('via the module-level helper') === true, 'setSpeaker redirects the module-level speak()');
  check(synth.calls[1][1] === 'via the module-level helper', 'the injected speaker received it');
  check(cancelSpeech() === true, 'and cancelSpeech()');
  setSpeaker(null);
  check(getSpeaker().isAvailable() === false, 'setSpeaker(null) restores the default');
}

/* ----------------------------------------------------- 5b + 5c end to end -- */

section('5b + 5c end to end: featureEntered in, an utterance out');

{
  const { channel, transport } = makeChannel();
  const synth = makeSynth();
  const speaker = createSpeaker({ synth, Utterance: FakeUtterance });

  // Exactly what AudiomMap's button does: a synchronous ref read plus an utterance.
  const whatsHereAndSay = () => { const answer = channel.whatsHere(); speaker.speak(answer); return answer; };

  check(whatsHereAndSay() === NOTHING_HERE, 'before any feature the answer is the empty one');
  check(synth.calls[1][1] === NOTHING_HERE, 'and it is still spoken rather than silently dropped');

  synth.calls.length = 0;
  transport.emit({ type: INBOUND.FEATURE_ENTERED, payload: featurePayload('Cafe China') });
  check(whatsHereAndSay() === 'Cafe China', 'after featureEntered the answer is the name');
  check(eq(synth.calls, [['cancel'], ['speak', 'Cafe China']]), 'the name is spoken, interrupting whatever came before');
  check(transport.sent.length === 0, 'answering whats_here sent NOTHING to the embed — L0, zero round trips');
}

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
