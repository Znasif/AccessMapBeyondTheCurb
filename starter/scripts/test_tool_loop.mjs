#!/usr/bin/env node
/**
 * Milestone 3 check: the LocalLLMClient chat seam and the caller-side tool loop.
 *
 *   node starter/scripts/test_tool_loop.mjs
 *
 * Offline by construction. Every round is a scripted fake `fetch`, which is the
 * only way to assert on the *request* — and the request is where the two
 * expensive lessons live: `chat_template_kwargs.enable_thinking` (design doc
 * §8.0, without which no tool call is ever emitted) and append-only message
 * history (§6.1, worth 2x latency). A live-server test can only see answers.
 *
 * If a router happens to be listening it also runs one real turn at the end,
 * but the suite passes with nothing running anywhere.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { LocalLLMClient, LOCAL_MAX_TOKENS } from '../src/lib/localLLM.js';
import { runToolLoop } from '../src/lib/toolLoop.js';
import { filterTools } from '../src/lib/toolFilter.js';
import { buildSystemPrompt, buildUserTurn } from '../src/lib/candidateContext.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = JSON.parse(readFileSync(join(HERE, '../docs/llm-tools.schema.json'), 'utf8'));
const TOOLS = filterTools(SCHEMA, { capabilities: ['places', 'regions'], frame: 'image' });

let failures = 0;
function check(ok, label, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures += 1;
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* -- scripted transport ------------------------------------------------------ */

/** Non-streaming completion carrying one tool call. */
const callResponse = (id, name, args, content = null) => ({
  choices: [{ index: 0, finish_reason: 'tool_calls', message: {
    role: 'assistant', content,
    tool_calls: [{ id, type: 'function', function: { name, arguments: args } }],
  } }],
});

const textResponse = (content) => ({
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
});

/**
 * A `fetch` that replays canned rounds and records what it was sent.
 *
 * A round is either a completion object (non-streaming) or `{ chunks: [...] }`,
 * which is served as SSE. The last round repeats if the loop asks for more, so
 * a runaway-model test needs one entry, not `maxRounds` of them.
 */
function scriptedFetch(rounds) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, body });
    const round = rounds[Math.min(requests.length - 1, rounds.length - 1)];
    // A round scripted as a whole completion is still served as SSE when the
    // request asked for it, the way a real server would.
    const chunks = round.chunks || (body.stream ? asChunks(round) : null);
    if (!chunks) return { ok: true, status: 200, json: async () => round };
    return { ok: true, status: 200, body: sseBody(chunks) };
  };
  return { fetchImpl, requests };
}

/** Whole completion -> the minimal chunk sequence that reproduces it. */
function asChunks(completion) {
  const choice = completion.choices[0];
  const delta = { role: 'assistant' };
  if (choice.message.content) delta.content = choice.message.content;
  if (choice.message.tool_calls) {
    delta.tool_calls = choice.message.tool_calls.map((call, index) => ({ index, ...call }));
  }
  return [
    { choices: [{ index: 0, delta }] },
    { choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }] },
  ];
}

/**
 * Serialise chunks as an SSE byte stream, splitting one event across two reads.
 * llama-server does this under load and a parser that assumes whole events per
 * read works fine in testing and drops tokens in production.
 */
async function* sseBody(chunks) {
  const encoder = new TextEncoder();
  for (const [i, chunk] of chunks.entries()) {
    const frame = `data: ${JSON.stringify(chunk)}\n\n`;
    if (i === 1 && frame.length > 20) {
      yield encoder.encode(frame.slice(0, 12));
      yield encoder.encode(frame.slice(12));
    } else {
      yield encoder.encode(frame);
    }
  }
  yield 'data: [DONE]\n\n';
}

const clientFor = (fetchImpl) => new LocalLLMClient({ baseUrl: 'http://fake.invalid/v1', fetchImpl });

/* -- 1. request contract: reasoning off, budget capped ----------------------- */

{
  const { fetchImpl, requests } = scriptedFetch([textResponse('Cafe China is to your left.')]);
  await runToolLoop({
    client: clientFor(fetchImpl),
    messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'where is cafe china' }],
    tools: TOOLS,
    executeTool: () => ({}),
    // A caller copying an OpenAI example. The cap is not theirs to raise.
    maxTokens: 4000,
  });

  const body = requests[0].body;
  check(body.chat_template_kwargs?.enable_thinking === false,
    'tools present -> chat_template_kwargs.enable_thinking is false (§8.0)',
    JSON.stringify(body.chat_template_kwargs));
  check(body.max_tokens === LOCAL_MAX_TOKENS && body.max_tokens <= 768,
    'max_tokens clamped to LOCAL_MAX_TOKENS despite maxTokens: 4000', `got ${body.max_tokens}`);
  check(body.model === 'l3' && body.temperature === 0, 'defaults: model l3, temperature 0',
    `${body.model} / ${body.temperature}`);
  check(eq(body.tools, TOOLS) && body.tool_choice === 'auto', 'tools passed through verbatim + tool_choice auto');
  check(!('stream' in body), 'no `stream` field on the non-streaming path');
  check(requests[0].url === 'http://fake.invalid/v1/chat/completions', 'posts to /chat/completions', requests[0].url);
}

{
  // `extra` is a passthrough, not a back door around either guarantee.
  const { fetchImpl, requests } = scriptedFetch([textResponse('hi')]);
  await clientFor(fetchImpl).chatCompletion({
    messages: [{ role: 'user', content: 'hi' }],
    tools: TOOLS,
    extra: { max_tokens: 4000, chat_template_kwargs: { enable_thinking: true }, cache_prompt: true },
  });
  const body = requests[0].body;
  check(body.max_tokens === LOCAL_MAX_TOKENS && body.chat_template_kwargs.enable_thinking === false,
    '`extra` cannot raise the cap or re-enable thinking',
    `${body.max_tokens} / ${body.chat_template_kwargs.enable_thinking}`);
  check(body.cache_prompt === true, '`extra` still passes unrelated fields through');
}

{
  const { fetchImpl, requests } = scriptedFetch([textResponse('hi')]);
  await clientFor(fetchImpl).chatCompletion({ messages: [{ role: 'user', content: 'hi' }] });
  check(!('chat_template_kwargs' in requests[0].body) && !('tools' in requests[0].body),
    'no tools -> no tools/chat_template_kwargs fields (the flag is a tool-turn concern)');
}

/* -- 2. a tool call reaches executeTool, its result reaches the next round ---- */

{
  const { fetchImpl, requests } = scriptedFetch([
    callResponse('call_1', 'get_place_details', '{"place": "BCD Tofu House"}'),
    textResponse('BCD Tofu House is a Korean restaurant.'),
  ]);
  const seen = [];
  const narrated = [];
  const out = await runToolLoop({
    client: clientFor(fetchImpl),
    messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'the korean place' }],
    tools: TOOLS,
    executeTool: (name, args) => { seen.push([name, args]); return { name: 'BCD Tofu House', category: 'restaurant' }; },
    onNarration: (t) => narrated.push(t),
  });

  check(seen.length === 1 && seen[0][0] === 'get_place_details', 'executeTool called once with the tool name',
    JSON.stringify(seen[0]?.[0]));
  check(eq(seen[0]?.[1], { place: 'BCD Tofu House' }), 'arguments arrive parsed, not as a string',
    JSON.stringify(seen[0]?.[1]));

  const second = requests[1].body.messages;
  const toolMsg = second.find((m) => m.role === 'tool');
  check(!!toolMsg && toolMsg.tool_call_id === 'call_1', 'round 2 carries role:tool with the matching tool_call_id',
    JSON.stringify(toolMsg?.tool_call_id));
  check(typeof toolMsg?.content === 'string' && JSON.parse(toolMsg.content).category === 'restaurant',
    'tool result serialised to a string body', toolMsg?.content);

  const assistant = second.find((m) => m.role === 'assistant');
  check(eq(Object.keys(assistant).sort(), ['content', 'role', 'tool_calls']),
    'assistant turn replayed in clean OpenAI shape', Object.keys(assistant).join(','));

  check(out.text === 'BCD Tofu House is a Korean restaurant.' && out.rounds === 2 && out.stopReason === 'answer',
    'loop stops on the prose answer and returns it', `${out.rounds} rounds / ${JSON.stringify(out.text)}`);
  check(eq(narrated, ['BCD Tofu House is a Korean restaurant.']), 'onNarration fired once');
  check(out.toolCalls.length === 1 && out.toolCalls[0].ok, 'the executed call is reported back');
}

/* -- 3. malformed arguments recover instead of throwing ---------------------- */

{
  const { fetchImpl, requests } = scriptedFetch([
    // Trailing comma + unquoted key: what a 4-bit 4B model actually emits.
    callResponse('call_bad', 'get_distance_to', '{place: "Cafe China",}'),
    callResponse('call_good', 'get_distance_to', '{"place": "Cafe China", "units": "material_mm"}'),
    textResponse('About 40 millimetres away.'),
  ]);
  const seen = [];
  let threw = null;
  let out = null;
  try {
    out = await runToolLoop({
      client: clientFor(fetchImpl),
      messages: [{ role: 'user', content: 'how far is cafe china' }],
      tools: TOOLS,
      executeTool: (name, args) => { seen.push(args); return { distance: 40 }; },
    });
  } catch (err) { threw = err; }

  check(threw === null, 'malformed arguments do not throw the loop down', String(threw?.message || ''));
  check(seen.length === 1, 'executeTool is not called for the unparseable round', `${seen.length} calls`);

  const errMsg = requests[1].body.messages.find((m) => m.tool_call_id === 'call_bad');
  const parsed = errMsg && JSON.parse(errMsg.content);
  check(parsed?.error === 'invalid_arguments' && parsed.received === '{place: "Cafe China",}',
    'the model sees an error-shaped tool result naming its own bad string', errMsg?.content);
  check(out?.rounds === 3 && out.text === 'About 40 millimetres away.',
    'the loop continues and the retried call succeeds', `${out?.rounds} rounds`);
  check(out?.toolCalls[0].ok === false && out.toolCalls[1].ok === true, 'both attempts reported, first flagged failed');
}

{
  // A dispatcher that throws is the same class of problem, one layer down.
  const { fetchImpl } = scriptedFetch([
    callResponse('c1', 'route_to', '{"place": "nowhere"}'),
    textResponse('I could not find that place.'),
  ]);
  const out = await runToolLoop({
    client: clientFor(fetchImpl),
    messages: [{ role: 'user', content: 'take me to nowhere' }],
    tools: TOOLS,
    executeTool: () => { throw new Error('no such place'); },
  });
  check(out.text === 'I could not find that place.' && out.toolCalls[0].ok === false,
    'a throwing executeTool becomes a tool result, not a dead turn');
}

/* -- 4. answer dedup (llm.py:296-305) ---------------------------------------- */

{
  // Gemma's actual double-speak: the whole answer on the tool round, then the
  // same sentence again plus a flourish after seeing the result.
  const { fetchImpl } = scriptedFetch([
    callResponse('c1', 'get_place_details', '{"place": "Cafe China"}', 'Cafe China is a Sichuan restaurant.'),
    textResponse('  Cafe China is a Sichuan restaurant.  '),
  ]);
  const narrated = [];
  const out = await runToolLoop({
    client: clientFor(fetchImpl),
    messages: [{ role: 'user', content: 'tell me about cafe china' }],
    tools: TOOLS,
    executeTool: () => ({ ok: true }),
    onNarration: (t) => narrated.push(t),
  });
  check(out.text === 'Cafe China is a Sichuan restaurant.', 'duplicate narration is spoken once', JSON.stringify(out.text));
  check(narrated.length === 1, 'onNarration is not fired for the duplicate', `${narrated.length} narrations`);
}

{
  // Containment, not equality: the second block is the first plus a flourish,
  // and the *first* is the one already spoken.
  const { fetchImpl } = scriptedFetch([
    callResponse('c1', 'am_i_at', '{"place": "Cafe China"}', 'Yes.'),
    textResponse('Yes. You are at the entrance.'),
  ]);
  const out = await runToolLoop({
    client: clientFor(fetchImpl),
    messages: [{ role: 'user', content: 'am i at cafe china' }],
    tools: TOOLS,
    executeTool: () => ({ at: true }),
  });
  check(out.text === 'Yes.\nYes. You are at the entrance.',
    'a superset block is still spoken (only contained blocks are dropped)', JSON.stringify(out.text));
}

{
  // The failure mode the "skip, do not keep-last" comment guards against: a
  // model that answers on the tool round and says nothing after must not go mute.
  const { fetchImpl } = scriptedFetch([
    callResponse('c1', 'whats_here', '{}', 'You are at Cafe China.'),
    textResponse(''),
  ]);
  const out = await runToolLoop({
    client: clientFor(fetchImpl),
    messages: [{ role: 'user', content: "what's here" }],
    tools: TOOLS,
    executeTool: () => ({ name: 'Cafe China' }),
  });
  check(out.text === 'You are at Cafe China.', 'tool-round narration survives an empty final round', JSON.stringify(out.text));
}

/* -- 5. maxRounds terminates a model that never stops calling ---------------- */

{
  const { fetchImpl, requests } = scriptedFetch([callResponse('c', 'whats_here', '{}', 'Looking.')]);
  let calls = 0;
  const out = await runToolLoop({
    client: clientFor(fetchImpl),
    messages: [{ role: 'user', content: 'loop forever' }],
    tools: TOOLS,
    executeTool: () => { calls += 1; return { ok: true }; },
    maxRounds: 3,
  });
  check(out.rounds === 3 && requests.length === 3, 'exactly maxRounds requests are made', `${requests.length}`);
  check(calls === 3, 'and exactly maxRounds tool executions');
  check(out.maxRoundsExceeded === true && out.stopReason === 'max_rounds', 'the cap is flagged, not silent');
  check(out.text === 'Looking.', 'whatever was narrated is still returned', JSON.stringify(out.text));
  check(await defaultRoundsIsFour(), 'default maxRounds is 4');
}

async function defaultRoundsIsFour() {
  const { fetchImpl, requests } = scriptedFetch([callResponse('c', 'whats_here', '{}')]);
  await runToolLoop({
    client: clientFor(fetchImpl),
    messages: [{ role: 'user', content: 'x' }],
    tools: TOOLS,
    executeTool: () => ({}),
  });
  return requests.length === 4;
}

/* -- 6. history is append-only (§6.1, the KV prefix) ------------------------- */

{
  const { fetchImpl, requests } = scriptedFetch([
    callResponse('c1', 'whats_here', '{}', 'One moment.'),
    callResponse('c2', 'get_place_details', '{"place": "Cafe China"}'),
    textResponse('Cafe China, Sichuan, on your right.'),
  ]);
  const original = [
    { role: 'system', content: 'stable system prompt' },
    { role: 'user', content: 'volatile candidate block + utterance' },
  ];
  const frozen = JSON.stringify(original);
  const out = await runToolLoop({
    client: clientFor(fetchImpl),
    messages: original,
    tools: TOOLS,
    executeTool: () => ({ ok: true }),
  });

  let appendOnly = true;
  let detail = '';
  for (let i = 1; i < requests.length; i++) {
    const prev = requests[i - 1].body.messages;
    const next = requests[i].body.messages;
    if (next.length <= prev.length) { appendOnly = false; detail = `round ${i + 1} did not grow`; break; }
    for (let j = 0; j < prev.length; j++) {
      if (!eq(prev[j], next[j])) { appendOnly = false; detail = `round ${i + 1} rewrote message ${j}`; break; }
    }
    if (!appendOnly) break;
  }
  check(appendOnly, 'each request is the previous one plus a suffix (KV prefix survives)', detail);
  check(eq(requests[0].body.messages, original), 'round 1 sends the caller ordering untouched');
  check(JSON.stringify(original) === frozen, 'the caller\'s messages array is not mutated');
  check(out.messages.length === requests.at(-1).body.messages.length + 1,
    'the returned history includes the final assistant turn');

  const roles = requests.at(-1).body.messages.map((m) => m.role).join(',');
  check(roles === 'system,user,assistant,tool,assistant,tool', 'history grows as assistant/tool pairs', roles);
  // The single instruction re-injection check: design doc §1 / llm.py's
  // `reinject_instructions`. Nothing but assistant and tool turns may be added.
  check(!requests.at(-1).body.messages.slice(2).some((m) => m.role === 'system' || m.role === 'user'),
    'no instruction re-injection: no system/user turn is ever appended');
}

/* -- 7. streaming assembles what non-streaming returns ----------------------- */

{
  // One canned chunk sequence, two paths. Content split mid-word and arguments
  // split mid-JSON, which is what the wire actually looks like.
  const CHUNKS = [
    { choices: [{ index: 0, delta: { role: 'assistant', content: 'Cafe Chi' } }] },
    { choices: [{ index: 0, delta: { content: 'na is to your right.' } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'get_place_', arguments: '{"place":' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'details', arguments: ' "Cafe China"}' } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ];

  /** Independent oracle: collapse the chunks without touching ChatAssembler. */
  function collapse(chunks) {
    let content = '';
    let finish = null;
    const calls = new Map();
    for (const chunk of chunks) {
      const choice = chunk.choices[0];
      if (choice.finish_reason) finish = choice.finish_reason;
      const delta = choice.delta || {};
      if (delta.content) content += delta.content;
      for (const call of delta.tool_calls || []) {
        const acc = calls.get(call.index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (call.id) acc.id = call.id;
        if (call.function?.name) acc.function.name += call.function.name;
        if (call.function?.arguments) acc.function.arguments += call.function.arguments;
        calls.set(call.index, acc);
      }
    }
    const message = { role: 'assistant', content: content || null };
    if (calls.size) message.tool_calls = [...calls.values()];
    return { choices: [{ index: 0, finish_reason: finish, message }] };
  }

  const FINAL = textResponse('Cafe China is to your right. It is Sichuan.');
  const args = { messages: [{ role: 'user', content: 'where is cafe china' }], tools: TOOLS };

  const plain = scriptedFetch([collapse(CHUNKS), FINAL]);
  const plainOut = await runToolLoop({ ...args, client: clientFor(plain.fetchImpl), executeTool: (n, a) => a });

  const streamed = scriptedFetch([{ chunks: CHUNKS }, FINAL]);
  const tokens = [];
  const streamOut = await runToolLoop({
    ...args, client: clientFor(streamed.fetchImpl), executeTool: (n, a) => a,
    stream: true, onToken: (t) => tokens.push(t),
  });

  check(streamOut.text === plainOut.text, 'streamed text == non-streamed text',
    `${JSON.stringify(streamOut.text)} vs ${JSON.stringify(plainOut.text)}`);
  check(eq(streamOut.toolCalls.map((c) => [c.name, c.args]), plainOut.toolCalls.map((c) => [c.name, c.args])),
    'streamed tool calls == non-streamed tool calls', JSON.stringify(streamOut.toolCalls.map((c) => c.args)));
  check(eq(streamOut.toolCalls[0].args, { place: 'Cafe China' }),
    'arguments split across chunks are concatenated before parsing, not parsed per chunk');
  check(eq(tokens, ['Cafe Chi', 'na is to your right.', 'Cafe China is to your right. It is Sichuan.']),
    'onToken fires per content delta, across both rounds', JSON.stringify(tokens));
  check(streamed.requests[0].body.stream === true && streamed.requests[0].body.chat_template_kwargs.enable_thinking === false,
    'the streaming request keeps the §8.0 flag');
}

/* -- optional: one real turn if a router is listening ------------------------ */

const BASE = process.env.VITE_LLM_BASE || 'http://127.0.0.1:8081/v1';
const live = await fetch(`${BASE}/models`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok)
  .catch(() => false);

if (!live) {
  console.log(`\nskip  live smoke turn — no router on ${BASE} (the suite above is offline by design)`);
} else {
  console.log(`\nlive router on ${BASE} — running one real turn`);
  const client = new LocalLLMClient({ baseUrl: BASE });
  const matches = [
    { name: 'Cafe China', category: 'restaurant' },
    { name: 'Empire State Building', category: 'tourism.attraction' },
  ];
  const executed = [];
  const t0 = Date.now();
  try {
    const out = await runToolLoop({
      client,
      tools: TOOLS,
      messages: [
        { role: 'system', content: buildSystemPrompt() },
        { role: 'user', content: buildUserTurn(matches, 'tell me about Cafe China') },
      ],
      executeTool: (name, a) => { executed.push([name, a]); return { name: 'Cafe China', category: 'restaurant' }; },
    });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`     ${out.rounds} rounds, ${secs}s, tools: ${executed.map(([n]) => n).join(', ') || '(none)'}`);
    console.log(`     text: ${JSON.stringify(out.text.slice(0, 160))}`);
    check(out.rounds >= 1 && (executed.length > 0 || out.text.length > 0),
      'live turn produced a tool call or an answer');
  } catch (err) {
    check(false, 'live turn completed', String(err?.message || err));
  }
}

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
