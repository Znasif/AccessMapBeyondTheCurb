#!/usr/bin/env node
/**
 * Milestone 3w check: the wllama in-tab backend, behind the milestone-3 seam.
 *
 *   node starter/scripts/test_wllama_backend.mjs
 *
 * Offline by construction, exactly like `test_tool_loop.mjs` — and for the same
 * reason. What matters about a backend is not that it produced an answer; it is
 * that it produced the SAME REQUEST the frozen contract promises, and that the
 * §8.0 thinking-disable survived the trip. A live model can only show you an
 * answer. A scripted `Wllama` shows you the options object llama.cpp's parser
 * would have received, which is where every expensive mistake in this system
 * has lived so far.
 *
 * The load-bearing section is §2: the same scripted rounds are replayed through
 * the HTTP transport and the wllama transport, and the tool loop must not be
 * able to tell them apart. That is what "a second backend behind the existing
 * interface" has to mean to be worth anything.
 *
 * No `@wllama/wllama` import anywhere here: the class is injected. The suite
 * runs with no model, no GPU, no network and no dependency installed.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { LocalLLMClient, LOCAL_MAX_TOKENS, TIER } from '../src/lib/localLLM.js';
import { runToolLoop } from '../src/lib/toolLoop.js';
import { filterTools } from '../src/lib/toolFilter.js';
import { WllamaTransport, WllamaEngine } from '../src/lib/llm/wllamaTransport.js';
import {
  resolveBackend, createLLMClient, createWllamaTransport, describeBudget, BACKEND,
} from '../src/lib/llm/index.js';
import {
  PROFILES, chooseChatProfile, planFootprint, kvUpperBoundBytes, weightBounds,
  N_CACHE_REUSE, DEFAULT_N_CTX,
} from '../src/lib/llm/modelProfiles.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = JSON.parse(readFileSync(join(HERE, '../docs/llm-tools.schema.json'), 'utf8'));
const TOOLS = filterTools(SCHEMA, { capabilities: ['places', 'regions'], frame: 'image' });

let failures = 0;
function check(ok, label, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures += 1;
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* -- scripted Wllama --------------------------------------------------------- */

/** Non-streaming completion carrying one tool call — same shape as the HTTP fake. */
const callResponse = (id, name, args, content = null) => ({
  choices: [{ index: 0, finish_reason: 'tool_calls', message: {
    role: 'assistant', content,
    tool_calls: [{ id, type: 'function', function: { name, arguments: args } }],
  } }],
});

const textResponse = (content) => ({
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
});

/** Whole completion -> the chunk sequence wllama's `onData` would emit. */
function asChunks(completion) {
  const choice = completion.choices[0];
  const delta = { role: 'assistant' };
  if (choice.message.content) delta.content = choice.message.content;
  if (choice.message.tool_calls) {
    delta.tool_calls = choice.message.tool_calls.map((call, index) => ({ index, ...call }));
  }
  return [
    { object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] },
    { object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }] },
  ];
}

/**
 * Stands in for one `Wllama`. Records every options object it is handed, which
 * is the entire point of the suite.
 */
class FakeWllama {
  constructor({ rounds = [], embedding, log } = {}) {
    this.rounds = rounds;
    this.embedding = embedding;
    this.log = log;
    this.loaded = null;
    this.loads = 0;
    /** Live options objects — for identity assertions (`abortSignal`, `onData`). */
    this.chatCalls = [];
    /** What llama.cpp's parser would actually have seen. See `#wire`. */
    this.chatBodies = [];
    this.embedCalls = [];
    this.exits = 0;
  }

  /**
   * wllama does `data_json: JSON.stringify(options)` SYNCHRONOUSLY inside
   * `createCompletionImpl`, so the request is snapshotted the moment it is
   * made. That detail matters: `runToolLoop` passes its live `history` array as
   * `messages` and keeps appending to it, so a fake that stored the options
   * object by reference would show every round holding the FINAL history — and
   * would report a contract violation that does not exist. Snapshot the same
   * way the real thing does.
   */
  #wire(options) {
    const { stream, onData, abortSignal, progressCallback, ...rest } = options;
    return JSON.parse(JSON.stringify(rest));
  }

  async loadModelFromUrl(url, params) {
    this.loads += 1;
    // A real load takes seconds; the yield is what makes the dedup test mean
    // something (two callers must land inside the same in-flight promise).
    await new Promise((r) => setTimeout(r, 5));
    params?.progressCallback?.({ loaded: 1, total: 1 });
    this.loaded = { source: url, params };
    this.log?.push({ kind: 'load', url, params });
  }

  async loadModelFromHF(hf, params) {
    return this.loadModelFromUrl(`hf:${hf.repo}/${hf.filePath}`, params);
  }

  getLoadedContextInfo() {
    return { n_layer: 30, n_embd: 2048, n_ctx: this.loaded?.params?.n_ctx ?? 0, n_vocab: 262144 };
  }

  async createChatCompletion(options) {
    this.chatCalls.push(options);
    this.chatBodies.push(this.#wire(options));
    const round = this.rounds[Math.min(this.chatCalls.length - 1, this.rounds.length - 1)];
    if (options.abortSignal?.aborted) throw new Error('aborted');
    if (options.stream && options.onData) {
      for (const chunk of round.chunks || asChunks(round)) options.onData(chunk);
      return undefined;
    }
    return round.chunks ? { choices: [] } : round;
  }

  async createEmbedding(options) {
    this.embedCalls.push(options);
    const inputs = Array.isArray(options.input) ? options.input : [options.input];
    // Deliberately returned OUT OF ORDER with explicit `index` fields: the HTTP
    // server does this and `LocalLLMClient.embed` is written to re-sort. A fake
    // that returns them in order would let a regression through.
    const data = inputs.map((text, index) => ({
      object: 'embedding', index, embedding: this.embedding ? this.embedding(text, index) : [index + 1, 1, 0],
    }));
    return { object: 'list', model: 'l1', data: data.slice().reverse(), usage: { prompt_tokens: 1, total_tokens: 1 } };
  }

  async exit() { this.exits += 1; }
}

/** Build a transport wired to fakes, and hand back the fakes for inspection. */
function fakeTransport({ chatRounds = [], embedding, chat = {}, embed = {}, ...rest } = {}) {
  const fakes = {};
  const transport = new WllamaTransport({
    chat: { profile: 'gemma-4-e2b-q4', url: '/models/e2b-00001-of-00005.gguf', ...chat },
    embed: embed === null ? undefined : { profile: 'embeddinggemma-q8', url: '/models/embed.gguf', ...embed },
    createInstance: async ({ profile }) => {
      const fake = new FakeWllama(
        profile.tier === TIER.REASON ? { rounds: chatRounds } : { embedding },
      );
      fakes[profile.tier] = fake;
      return fake;
    },
    ...rest,
  });
  return { transport, fakes };
}

const clientFor = (transport) => new LocalLLMClient({ transport });

/* -- 1. the frozen request contract survives the backend --------------------- */

{
  const { transport, fakes } = fakeTransport({ chatRounds: [textResponse('Cafe China is to your left.')] });
  await runToolLoop({
    client: clientFor(transport),
    messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'where is cafe china' }],
    tools: TOOLS,
    executeTool: () => ({}),
    maxTokens: 4000,
  });

  const opts = fakes[TIER.REASON].chatCalls[0];
  check(opts.chat_template_kwargs?.enable_thinking === false,
    'tools present -> chat_template_kwargs.enable_thinking is false reaches wllama (§8.0)',
    JSON.stringify(opts.chat_template_kwargs));
  check(opts.max_tokens === LOCAL_MAX_TOKENS && opts.max_tokens <= 768,
    'max_tokens still clamped to LOCAL_MAX_TOKENS on the in-tab path', `got ${opts.max_tokens}`);
  check(opts.model === 'l3' && opts.temperature === 0, 'defaults preserved: model l3, temperature 0',
    `${opts.model} / ${opts.temperature}`);
  check(eq(opts.tools, TOOLS) && opts.tool_choice === 'auto', 'tools passed through verbatim + tool_choice auto');
  check(opts.stream === false, 'non-streaming call sets stream:false explicitly (never leaves it undefined)',
    String(opts.stream));
  check(!('onData' in opts), 'no onData on the non-streaming path (it selects wllama\'s iterator overload)');
}

{
  // The load-time half of §8.0: both switches, on the profile, before any turn.
  const { transport, fakes } = fakeTransport({ chatRounds: [textResponse('hi')] });
  await transport.preload([TIER.REASON]);
  const params = fakes[TIER.REASON].loaded.params;
  check(params.reasoning === false, 'load-time `reasoning: false` (§8.0, half one)', String(params.reasoning));
  check(params.default_template_kwargs?.enable_thinking === false,
    'load-time default_template_kwargs.enable_thinking covers tool-less narration turns',
    JSON.stringify(params.default_template_kwargs));
  check(params.jinja === true, 'jinja on — the template path that renders tool calls at all');
  check(params.n_cache_reuse === N_CACHE_REUSE && params.n_ctx === DEFAULT_N_CTX,
    'KV config, not KV control: n_cache_reuse + n_ctx set at load (§8)',
    `${params.n_cache_reuse} / ${params.n_ctx}`);
  check(params.cache_idle_slots === true, 'cache_idle_slots keeps the warm slot the prefix lives in');
  // MEASURED 2026-08-12 on two machines (results/ in explore/wllama-spike, the
  // flag as the only difference): on a prompt that diverges in a stable head —
  // every new user turn — the default reuses 0 of 6363 tokens and `swa_full`
  // reuses 6345, taking the M1 from 119.52 s to 2.37 s at no measurable memory
  // cost. This check was the reverse until that ran; it now pins the flag ON so
  // that dropping it is likewise a conscious act with a number behind it.
  check(params.swa_full === true, 'swa_full ON — measured to carry divergent-head prefix reuse',
    String(params.swa_full));
}

{
  // A hand-built body is the realistic way the flag gets lost. It must not be
  // possible to reach llama.cpp with tools and thinking on.
  const { transport, fakes } = fakeTransport({ chatRounds: [textResponse('x')] });
  let threw = null;
  try {
    await transport.chat({ model: 'l3', messages: [{ role: 'user', content: 'hi' }], tools: TOOLS });
  } catch (err) { threw = err; }
  check(/enable_thinking/.test(String(threw?.message)),
    'a hand-built tools body without the flag is refused at the backend boundary',
    String(threw?.message).slice(0, 80));
  check(fakes[TIER.REASON] === undefined, 'and it is refused BEFORE the model is loaded');
}

{
  // ...but a tool-less turn is fine without it: the load-time default covers it.
  const { transport, fakes } = fakeTransport({ chatRounds: [textResponse('ok')] });
  await transport.chat({ model: 'l3', messages: [{ role: 'user', content: 'hi' }] });
  check(fakes[TIER.REASON].chatCalls.length === 1, 'a tool-less body passes without per-request kwargs');
}

{
  // The `extra` passthrough must still reach llama.cpp's own parser: this is
  // what makes per-request `grammar` / `response_format` / `cache_prompt`
  // available on this backend at all (plan §8).
  const { transport, fakes } = fakeTransport({ chatRounds: [textResponse('hi')] });
  await clientFor(transport).chatCompletion({
    messages: [{ role: 'user', content: 'hi' }],
    tools: TOOLS,
    extra: {
      max_tokens: 4000,
      chat_template_kwargs: { enable_thinking: true },
      cache_prompt: true,
      grammar: 'root ::= "yes"',
      response_format: { type: 'json_schema', json_schema: { name: 'x', schema: {} } },
    },
  });
  const opts = fakes[TIER.REASON].chatCalls[0];
  check(opts.max_tokens === LOCAL_MAX_TOKENS && opts.chat_template_kwargs.enable_thinking === false,
    '`extra` cannot raise the cap or re-enable thinking through this backend either',
    `${opts.max_tokens} / ${opts.chat_template_kwargs.enable_thinking}`);
  check(opts.cache_prompt === true && opts.grammar === 'root ::= "yes"' && opts.response_format?.type === 'json_schema',
    'cache_prompt, GBNF grammar and json_schema reach the embedded llama-server parser');
}

/* -- 2. the tool loop cannot tell the backends apart -------------------------- */

{
  const ROUNDS = [
    callResponse('call_1', 'get_place_details', '{"place": "BCD Tofu House"}', 'One moment.'),
    callResponse('call_2', 'get_distance_to', '{place: "BCD Tofu House",}'),
    textResponse('BCD Tofu House is a Korean restaurant, about 40 metres away.'),
  ];
  const messages = [{ role: 'system', content: 'S' }, { role: 'user', content: 'the korean place' }];

  /** The HTTP backend replaying the same rounds, as the milestone-3 suite does. */
  const httpRequests = [];
  const httpClient = new LocalLLMClient({
    baseUrl: 'http://fake.invalid/v1',
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      httpRequests.push(body);
      return { ok: true, status: 200, json: async () => ROUNDS[Math.min(httpRequests.length - 1, ROUNDS.length - 1)] };
    },
  });

  const { transport, fakes } = fakeTransport({ chatRounds: ROUNDS });
  const wllamaClient = clientFor(transport);

  const run = (client) => runToolLoop({
    client, messages, tools: TOOLS,
    executeTool: (name, args) => ({ name, args, distance: 40 }),
  });

  const httpOut = await run(httpClient);
  const wllamaOut = await run(wllamaClient);

  check(httpOut.text === wllamaOut.text, 'identical narration from both backends', JSON.stringify(wllamaOut.text));
  check(httpOut.rounds === wllamaOut.rounds && httpOut.stopReason === wllamaOut.stopReason,
    'identical round count and stop reason', `${wllamaOut.rounds} / ${wllamaOut.stopReason}`);
  check(eq(httpOut.toolCalls, wllamaOut.toolCalls), 'identical tool-call ledger, including the malformed-args failure');
  check(eq(httpOut.messages, wllamaOut.messages), 'identical resulting history');

  // And the requests themselves, which is the frozen contract stated as a diff.
  check(eq(httpRequests, fakes[TIER.REASON].chatBodies),
    'every request body is byte-identical across backends (contract frozen, §5 milestone 3)',
    `${httpRequests.length} rounds compared`);
}

{
  // Streaming: wllama hands back the same `chat.completion.chunk` objects, so
  // ChatAssembler needs no backend-specific branch.
  const CHUNKS = [
    { choices: [{ index: 0, delta: { role: 'assistant', content: 'Cafe Chi' } }] },
    { choices: [{ index: 0, delta: { content: 'na is to your right.' } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'get_place_', arguments: '{"place":' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'details', arguments: ' "Cafe China"}' } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ];
  const { transport, fakes } = fakeTransport({
    chatRounds: [{ chunks: CHUNKS }, textResponse('Cafe China is to your right. It is Sichuan.')],
  });
  const tokens = [];
  const out = await runToolLoop({
    client: clientFor(transport),
    messages: [{ role: 'user', content: 'where is cafe china' }],
    tools: TOOLS,
    executeTool: (n, a) => a,
    stream: true,
    onToken: (t) => tokens.push(t),
  });

  const first = fakes[TIER.REASON].chatCalls[0];
  check(first.stream === true && typeof first.onData === 'function',
    'onChunk becomes wllama\'s {stream:true, onData} callback, not SSE');
  check(first.chat_template_kwargs.enable_thinking === false, 'the streaming request keeps the §8.0 flag');
  check(eq(out.toolCalls[0].args, { place: 'Cafe China' }),
    'arguments split across chunks are concatenated before parsing');
  check(eq(tokens, ['Cafe Chi', 'na is to your right.', 'Cafe China is to your right. It is Sichuan.']),
    'onToken fires per content delta across both rounds', JSON.stringify(tokens));
}

{
  // Barge-in. `signal` is the seam's name; `abortSignal`, inside the options
  // object, is wllama's. Getting this wrong means a user talks over the answer
  // and the model keeps going.
  const { transport, fakes } = fakeTransport({ chatRounds: [textResponse('hi')] });
  const controller = new AbortController();
  await clientFor(transport).chatCompletion({
    messages: [{ role: 'user', content: 'hi' }], signal: controller.signal,
  });
  check(fakes[TIER.REASON].chatCalls[0].abortSignal === controller.signal,
    'signal is forwarded as options.abortSignal');
  check(!('signal' in fakes[TIER.REASON].chatCalls[0]), 'and not also as `signal`, which llama.cpp would ignore');
}

/* -- 3. two tiers means two instances (plan §8) ------------------------------ */

{
  const { transport, fakes } = fakeTransport({ embedding: (text, i) => [i + 1, 2, 2] });
  const client = clientFor(transport);
  const vectors = await client.embedDocuments([
    { name: 'Cafe China', text: 'restaurant' },
    { name: 'Wells Fargo', text: 'bank' },
  ]);

  check(!!fakes[TIER.EMBED] && fakes[TIER.EMBED] !== fakes[TIER.REASON],
    'l1 runs in its own Wllama instance, not a mode of the chat model');
  check(fakes[TIER.REASON] === undefined, 'and asking for embeddings does not load the 2.6 GB chat model');
  const inputs = fakes[TIER.EMBED].embedCalls[0].input;
  check(inputs[0].startsWith('title: Cafe China | text: '),
    'EmbeddingGemma document prefixes survive the backend swap', inputs[0]);
  check(!('model' in fakes[TIER.EMBED].embedCalls[0]),
    '`model` is consumed as tier routing, not forwarded (wllama is one model per instance)');
  const len = Math.hypot(...vectors[0]);
  check(Math.abs(len - 1) < 1e-6, 'vectors come back unit-normalised', `|v| = ${len}`);
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  check(near(vectors[0][0], 1 / 3) && near(vectors[1][0], 2 / Math.hypot(2, 2, 2)),
    're-sorted by `index` despite the fake returning them reversed',
    `${vectors[0][0]} / ${vectors[1][0]}`);

  const queries = await client.embedQueries(['the korean place']);
  check(fakes[TIER.EMBED].embedCalls[1].input[0].startsWith('task: search result | query: '),
    'query prefixes too', fakes[TIER.EMBED].embedCalls[1].input[0]);
  check(queries.length === 1 && fakes[TIER.EMBED].loads === 1,
    'the embed instance is loaded exactly once across calls', `${fakes[TIER.EMBED].loads} loads`);

  const embedParams = fakes[TIER.EMBED].loaded.params;
  check(embedParams.embeddings === true && embedParams.pooling_type === 'mean',
    'l1 loads with embeddings:true and mean pooling (wrong pooling degrades ranking silently)',
    `${embedParams.embeddings} / ${embedParams.pooling_type}`);

  const stats = transport.stats();
  check(stats[TIER.EMBED].status === 'ready' && stats[TIER.REASON].status === 'idle',
    'stats() reports per-instance status, so the memory picture is observable',
    `${stats[TIER.REASON].status} / ${stats[TIER.EMBED].status}`);

  await transport.unload();
  check(fakes[TIER.EMBED].exits === 1 && transport.stats()[TIER.EMBED].status === 'idle',
    'unload() exits every worker');
}

{
  // The whole point of wiring l1: `PlaceIndex` — milestone 8, written against
  // the seam — must run on this backend unchanged. `test_place_index.mjs` can
  // only prove that against a live router on :8081; this proves the l1 half of
  // 3w with no server at all. The embedder is a deterministic bag-of-words
  // encoder, so the expected ranking is arithmetic rather than semantic.
  const { PlaceIndex, MemoryStore } = await import('../src/lib/placeIndex.js');
  const VOCAB = ['korean', 'tofu', 'bank', 'atm', 'coffee', 'sichuan'];
  const bagOfWords = (text) => {
    const lower = text.toLowerCase();
    const vec = VOCAB.map((word) => (lower.includes(word) ? 1 : 0));
    // A non-zero floor so a document sharing nothing with the query still
    // normalises instead of producing NaN.
    return vec.some(Boolean) ? vec : VOCAB.map(() => 0.01);
  };

  const { transport, fakes } = fakeTransport({ embedding: (text) => bagOfWords(text) });
  const index = new PlaceIndex({ client: clientFor(transport), store: new MemoryStore() });
  const ctx = { worldId: 'camio:new_york', windowId: 'full' };
  const record = await index.build({
    ...ctx,
    places: [
      { id: 0, name: 'BCD Tofu House', category: 'restaurant.korean', context: 'tofu soup' },
      { id: 1, name: 'Bank of America', category: 'financial.bank', context: 'ATM' },
      { id: 2, name: 'Blank Slate Coffee', category: 'cafe.coffee', context: 'coffee' },
    ],
  });
  check(record.count === 3 && record.dim === VOCAB.length,
    'PlaceIndex builds over the wllama l1 instance with no router running',
    `count=${record.count} dim=${record.dim}`);

  const { matches } = await index.resolve('the korean place', ctx);
  check(matches[0]?.name === 'BCD Tofu House',
    'and resolve() ranks through it end to end', matches.map((m) => m.name).join(' | '));
  check(fakes[TIER.EMBED].embedCalls.length === 2 && fakes[TIER.REASON] === undefined,
    'one batched document call plus one query call, and l3 was never loaded',
    `${fakes[TIER.EMBED].embedCalls.length} embed calls`);
}

{
  const { transport } = fakeTransport({ embed: null });
  let threw = null;
  try { await transport.embeddings({ model: 'l1', input: ['x'] }); } catch (err) { threw = err; }
  check(/no engine for tier "l1"/.test(String(threw?.message)) && /PlaceIndex/.test(String(threw?.message)),
    'a chat-only page fails loudly and usefully when placeIndex asks for l1',
    String(threw?.message).slice(0, 90));
}

/* -- 4. loading is idempotent, deduped, and optionally explicit -------------- */

{
  const { transport, fakes } = fakeTransport({ chatRounds: [textResponse('a'), textResponse('b')] });
  const client = clientFor(transport);
  // Two turns fired before the first load resolves: the classic double-download.
  await Promise.all([
    client.chatCompletion({ messages: [{ role: 'user', content: 'a' }] }),
    client.chatCompletion({ messages: [{ role: 'user', content: 'b' }] }),
  ]);
  check(fakes[TIER.REASON].loads === 1, 'concurrent first turns share ONE load', `${fakes[TIER.REASON].loads} loads`);
  await client.chatCompletion({ messages: [{ role: 'user', content: 'c' }] });
  check(fakes[TIER.REASON].loads === 1, 'and a later turn does not reload');
}

{
  const { transport } = fakeTransport({ autoLoad: false });
  let threw = null;
  try { await transport.chat({ model: 'l3', messages: [{ role: 'user', content: 'hi' }] }); } catch (err) { threw = err; }
  check(/autoLoad is off/.test(String(threw?.message)) && /preload/.test(String(threw?.message)),
    'autoLoad:false turns a surprise multi-GB download into a named error');
}

{
  // A failed load must not poison the engine — the user retries after fixing
  // their connection, and a stuck `loading` promise would deny them forever.
  let attempt = 0;
  const engine = new WllamaEngine({
    profile: PROFILES['gemma-4-e2b-q4'],
    url: '/models/x.gguf',
    createInstance: async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('network down');
      return new FakeWllama({ rounds: [textResponse('hi')] });
    },
  });
  let threw = null;
  try { await engine.load(); } catch (err) { threw = err; }
  check(String(threw?.message) === 'network down' && engine.status === 'failed', 'a failed load is reported and flagged');
  await engine.load();
  check(engine.status === 'ready' && attempt === 2, 'and retrying after a failure works');
}

{
  const progress = [];
  const { transport } = fakeTransport({ onProgress: (p) => progress.push(p) });
  await transport.preload();
  check(progress.length === 2 && progress.every((p) => p.profile),
    'progressCallback is wired per engine, so a "preparing" UI can show which model',
    progress.map((p) => p.profile).join(', '));
}

{
  // A profile with neither `url` nor `hf`: model hosting is a deployment
  // decision, so this is the shape of a half-configured app, not a typo.
  const engine = new WllamaEngine({
    profile: { ...PROFILES['gemma-4-e2b-q4'], hf: undefined },
    createInstance: async () => new FakeWllama(),
  });
  let threw = null;
  try { await engine.load(); } catch (err) { threw = err; }
  check(/no model source/.test(String(threw?.message)), 'a profile with no url and no hf says so',
    String(threw?.message).slice(0, 70));
}

/* -- 5. the memory picture (plan §7.2 / §8) ---------------------------------- */

{
  const single = planFootprint({ chat: 'gemma-4-e2b-q4', embed: null });
  const both = planFootprint({ chat: 'gemma-4-e2b-q4', embed: 'embeddinggemma-q8' });
  check(both.instances.length === 2 && both.totalBytes[1] > single.totalBytes[1],
    'l1 + l3 is additive, not shared (§8: two workers, two WASM heaps)',
    `${(single.totalBytes[1] / 2 ** 30).toFixed(2)} GB -> ${(both.totalBytes[1] / 2 ** 30).toFixed(2)} GB`);
  check(both.notes.some((n) => /two Wllama instances/.test(n)), 'and the plan says so in words too');

  const [e2bLo, e2bHi] = weightBounds(PROFILES['gemma-4-e2b-q4']);
  check(e2bLo === e2bHi && e2bLo === 2_620_370_976,
    'the E2B weight figure is an exact file size, not an estimate', `${e2bLo} bytes`);
  const [, e4bHi] = weightBounds(PROFILES['gemma-4-e4b-q4']);
  check(e4bHi > 5 * 2 ** 30 && PROFILES['gemma-4-e4b-q4'].measured === false,
    'the E4B figure is an unmeasured RANGE and is flagged as such (§7.2)',
    `${(e4bHi / 2 ** 30).toFixed(2)} GB, measured=${PROFILES['gemma-4-e4b-q4'].measured}`);

  const e4bPlan = planFootprint({ chat: 'gemma-4-e4b-q4', embed: 'embeddinggemma-q8' });
  check(e4bPlan.notes.some((n) => /unmeasured/.test(n)), 'an E4B budget warns that it rests on unmeasured numbers');
  check(e4bPlan.totalBytes[1] > 5.5 * 2 ** 30,
    'E4B + l1 + overhead clears 5.5 GB — the §7.2 hole on an 8 GB machine',
    `${(e4bPlan.totalBytes[1] / 2 ** 30).toFixed(2)} GB`);

  const kv = kvUpperBoundBytes({ n_layer: 30, n_embd: 2048, n_ctx: 8192 }, {});
  check(kv === 30 * 2048 * 8192 * 4, 'kvUpperBoundBytes is the documented f16 K+V upper bound', `${kv}`);
  check(kvUpperBoundBytes({ n_layer: 30, n_embd: 2048, n_ctx: 8192 }, { cache_type_k: 'q8_0', cache_type_v: 'q8_0' }) < kv,
    'and quantised KV lowers it');
  check(kvUpperBoundBytes(null) === null, 'no context info -> null, never a made-up number');
}

{
  // The E2B/E4B call, as code. `navigator.deviceMemory` is CLAMPED AT 8 by
  // spec, so "16 GB or more" is not observable from a tab and E4B must be
  // opt-in. This test exists so nobody later "fixes" it into a >= 16 check.
  check(chooseChatProfile({ deviceMemory: 8 }).id === 'gemma-4-e2b-q4',
    'deviceMemory 8 (which means "8 or more") still picks E2B');
  check(/clamped at 8/.test(chooseChatProfile({ deviceMemory: 8 }).reason),
    'and the reason names the clamp, so the decision is auditable');
  check(chooseChatProfile({ deviceMemory: 4 }).id === 'gemma-4-e2b-q4', 'a 4 GB machine picks E2B');
  check(chooseChatProfile({ declaredMemoryGB: 16 }).id === 'gemma-4-e4b-q4',
    'E4B in-tab requires a human declaring real memory (§7.2: a 16 GB configuration)');
  check(chooseChatProfile({ profile: 'gemma-4-e4b-q4', deviceMemory: 4 }).id === 'gemma-4-e4b-q4',
    'an explicit profile wins over everything');
  let threw = null;
  try { chooseChatProfile({ profile: 'embeddinggemma-q8' }); } catch (err) { threw = err; }
  check(/not a l3 profile/.test(String(threw?.message)), 'an embedding profile cannot be selected as the chat model');
}

/* -- 6. backend selection ---------------------------------------------------- */

{
  check(resolveBackend({ backend: 'http', env: {} }).name === BACKEND.HTTP, 'resolveBackend: explicit http');
  check(resolveBackend({ backend: 'wllama', env: {} }).name === BACKEND.WLLAMA, 'resolveBackend: explicit wllama');
  check(resolveBackend({ env: {} }).name === BACKEND.HTTP,
    'resolveBackend: auto defaults to http (§1.1 — the critical path is the router backend)');
  check(resolveBackend({ env: { VITE_LLM_BACKEND: 'wllama' } }).name === BACKEND.WLLAMA,
    'resolveBackend: VITE_LLM_BACKEND flips it without a code change');
  let threw = null;
  try { resolveBackend({ backend: 'webllm' }); } catch (err) { threw = err; }
  check(/expected auto\|http\|wllama/.test(String(threw?.message)), 'an unknown backend name is refused');

  const httpClient = await createLLMClient({ backend: 'http', env: {}, http: { baseUrl: 'http://x/v1' } });
  check(httpClient.backend === 'http' && httpClient.baseUrl === 'http://x/v1',
    'createLLMClient builds the HTTP backend unchanged', httpClient.baseUrl);
  check(typeof httpClient.chatCompletion === 'function' && typeof httpClient.embedQueries === 'function',
    'and it is a plain LocalLLMClient either way');
}

{
  const transport = createWllamaTransport({
    createInstance: async ({ profile }) => new FakeWllama({ rounds: [textResponse('hi')] }),
  });
  check(transport.profileChoice.id === 'gemma-4-e2b-q4', 'createWllamaTransport defaults to E2B',
    transport.profileChoice.reason);
  check(!!transport.engines[TIER.REASON] && !!transport.engines[TIER.EMBED],
    'and wires both tiers by default, because placeIndex needs l1');
  const chatOnly = createWllamaTransport({ embed: null, createInstance: async () => new FakeWllama() });
  check(!chatOnly.engines[TIER.EMBED], 'embed:null drops the second instance for a chat-only page');
  check(createWllamaTransport({ env: { VITE_LLM_PROFILE: 'gemma-4-e4b-q4' }, createInstance: async () => new FakeWllama() })
    .profileChoice.id === 'gemma-4-e4b-q4', 'VITE_LLM_PROFILE selects E4B without a code change');

  const budget = describeBudget({});
  check(/gemma-4-e2b-q4/.test(budget.text) && /two Wllama instances/.test(budget.text),
    'describeBudget prints the two-instance §7.2 arithmetic');
}

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
