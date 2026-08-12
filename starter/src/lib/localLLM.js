/**
 * Client for the local llama.cpp router (see ~/.config/abtc/models.ini).
 *
 * The router serves every tier from ONE port and selects between them with the
 * OpenAI `model` field, so there is a single base URL here rather than the
 * three ports the original setup guide described. `l1` is EmbeddingGemma
 * (embeddings only — sending it a chat completion returns "the current context
 * does not logits computation"), `l3` is Gemma 4 E4B.
 *
 * Milestone 3 (the seam, plan §1.1): one interface, two backends. Everything
 * above this file — the tool loop, the dispatcher, speech — is written against
 * `LocalLLMClient`; only the `transport` underneath it changes. `HttpTransport`
 * is the backend that exists today; milestone 3w drops a wllama transport into
 * the same constructor slot with no HTTP at all. GBNF grammars are still open.
 */

export const TIER = { EMBED: 'l1', REASON: 'l3' };

/**
 * Carried over from `llm.py`'s `LOCAL_MAX_TOKENS` (`explore/simple_camio_llm`,
 * `src/llm/llm.py:28`). The local tier gets a *quarter* of the cloud budget:
 * 768 rather than 2000. Not arbitrary and not a memory limit — with reasoning
 * off (§8.0) a correct tool-calling round costs ~18 tokens, so anything running
 * past 768 is the model narrating itself in a circle, and at ~16 tok/s every
 * one of those tokens is ~60 ms of silence for a blind user waiting to be
 * spoken to. The cap is enforced here rather than trusted to callers: it is one
 * `max_tokens: 2000` copied from an OpenAI example away from being lost.
 */
export const LOCAL_MAX_TOKENS = 768;

function defaultBase() {
  // Vite dev/proxy path in the browser; overridable for Node scripts and tests.
  if (typeof process !== 'undefined' && process.env?.VITE_LLM_BASE) {
    return process.env.VITE_LLM_BASE;
  }
  if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_LLM_BASE) {
    return import.meta.env.VITE_LLM_BASE;
  }
  return '/llm/v1';
}

/**
 * EmbeddingGemma is trained with task-specific prefixes, and they are not
 * cosmetic. Measured on real POIs, query "the Korean place" against four
 * places, comparing bare strings with the documented prefixes:
 *
 *            top-1        top-2        margin   margin/top-1
 *   bare     0.640        0.461        0.179    28%
 *   prefixed 0.416        0.215        0.201    48%
 *
 * Prefixes nearly double the *relative* separation, which is what ranking
 * quality depends on. But note they also compress absolute scores: the design
 * doc's "top-1 similarity exceeds ~0.55" escalation rule was calibrated on bare
 * strings and would reject a correct 0.416 match. Use the scale-free margin
 * from resolvePlaces() for that decision instead of an absolute cutoff.
 */
const PREFIX = {
  query: (text) => `task: search result | query: ${text}`,
  document: (title, text) => `title: ${title || 'none'} | text: ${text}`,
};

/**
 * The OpenAI-compatible HTTP backend: llama-server, or anything speaking its
 * dialect. Two methods, and they are the whole transport contract (see
 * `LocalLLMClient` below for what a replacement must satisfy).
 */
export class HttpTransport {
  constructor({ baseUrl = defaultBase(), fetchImpl, timeoutMs = 120_000 } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetch = fetchImpl || globalThis.fetch.bind(globalThis);
    this.timeoutMs = timeoutMs;
  }

  /** @returns {Promise<Response>} */
  async #send(path, body, signal) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    // A caller-supplied signal (barge-in: the user starts talking over the
    // answer) has to compose with the timeout, not replace it.
    const onAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener?.('abort', onAbort, { once: true });
    try {
      return await this.fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    }
  }

  async post(path, body, { signal } = {}) {
    const res = await this.#send(path, body, signal);
    const json = await res.json();
    if (!res.ok || json.error) {
      throw new Error(json?.error?.message || `${path} failed: HTTP ${res.status}`);
    }
    return json;
  }

  embeddings(body, opts) {
    return this.post('/embeddings', body, opts);
  }

  /**
   * @param {object} body            already-final OpenAI request body
   * @param {(chunk: object) => void} [opts.onChunk]  set => stream, and the
   *        return value is undefined; the client assembles from the chunks.
   * @returns {Promise<object|undefined>} full completion when not streaming
   */
  async chat(body, { signal, onChunk } = {}) {
    if (!onChunk) return this.post('/chat/completions', body, { signal });
    const res = await this.#send('/chat/completions', body, signal);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`/chat/completions failed: HTTP ${res.status} ${text}`.trim());
    }
    for await (const chunk of parseSSE(res)) onChunk(chunk);
    return undefined;
  }
}

/**
 * `data:` lines out of an SSE body, parsed. Yields objects, skips `[DONE]`.
 *
 * Three body shapes are accepted because three exist in practice: a WHATWG
 * ReadableStream (browser and Node ≥18 `fetch`), a plain async iterable (Node
 * streams, and the scripted fakes in `test_tool_loop.mjs`), and nothing at all
 * (a fake that only implements `text()`). Bytes or strings either way.
 */
async function* parseSSE(res) {
  const decoder = new TextDecoder();
  const decode = (piece) => (typeof piece === 'string' ? piece : decoder.decode(piece, { stream: true }));

  let buffer = '';
  const flush = function* (final = false) {
    // Events are newline-delimited; the tail is held back until a newline
    // arrives, because llama-server splits JSON across TCP reads under load.
    const lines = buffer.split('\n');
    buffer = final ? '' : lines.pop();
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      yield JSON.parse(payload);
    }
  };

  const body = res.body;
  if (body?.getReader) {
    const reader = body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decode(value);
      yield* flush();
    }
  } else if (body?.[Symbol.asyncIterator]) {
    for await (const piece of body) {
      buffer += decode(piece);
      yield* flush();
    }
  } else {
    buffer += await res.text();
  }
  yield* flush(true);
}

/**
 * Folds streaming chunks back into one non-streaming completion, so callers see
 * the same shape whether or not they asked for tokens as they arrive.
 *
 * Tool calls are the fiddly half: they arrive as deltas keyed by `index`, with
 * `function.arguments` split across chunks at arbitrary boundaries — a partial
 * `{"place": "BCD Tof` is normal and must be concatenated, never parsed.
 */
export class ChatAssembler {
  constructor() {
    this.content = '';
    this.finishReason = null;
    this.usage = null;
    this.role = 'assistant';
    this.calls = new Map();
  }

  push(chunk) {
    if (chunk?.usage) this.usage = chunk.usage;
    const choice = chunk?.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) this.finishReason = choice.finish_reason;
    const delta = choice.delta || {};
    if (delta.role) this.role = delta.role;
    if (typeof delta.content === 'string') this.content += delta.content;
    for (const [i, call] of (delta.tool_calls || []).entries()) {
      const key = call.index ?? i;
      const acc = this.calls.get(key) || { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (call.id) acc.id = call.id;
      if (call.type) acc.type = call.type;
      if (call.function?.name) acc.function.name += call.function.name;
      if (call.function?.arguments) acc.function.arguments += call.function.arguments;
      this.calls.set(key, acc);
    }
  }

  /** The `choices[0]`-shaped result the non-streaming path also produces. */
  result() {
    const message = { role: this.role, content: this.content || null };
    if (this.calls.size) {
      message.tool_calls = [...this.calls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, call]) => call);
    }
    return { message, finishReason: this.finishReason, usage: this.usage };
  }
}

export class LocalLLMClient {
  /**
   * @param {object}   [opts]
   * @param {string}   [opts.baseUrl]    HTTP backend only
   * @param {Function} [opts.fetchImpl]  HTTP backend only; injected in tests
   * @param {object}   [opts.transport]  swap the backend wholesale (milestone
   *        3w). Must implement `embeddings(body, {signal})` and
   *        `chat(body, {signal, onChunk})`, both taking a final OpenAI-shaped
   *        request body and returning the OpenAI-shaped response — except when
   *        `onChunk` is given, where it emits chunk objects and returns
   *        nothing. Nothing above this line knows which backend it has.
   */
  constructor({ baseUrl = defaultBase(), fetchImpl, timeoutMs = 120_000, transport } = {}) {
    this.transport = transport || new HttpTransport({ baseUrl, fetchImpl, timeoutMs });
    // Kept as own properties: scripts read `client.baseUrl` today.
    this.baseUrl = this.transport.baseUrl ?? null;
    this.timeoutMs = timeoutMs;
  }

  /**
   * One chat round. Not a loop — see `toolLoop.js` for that.
   *
   * @param {object}   params
   * @param {object[]} params.messages   caller-ordered; NEVER reordered here.
   *        §6.1: stable prefix first, volatile last, and the client is not
   *        entitled to an opinion about it.
   * @param {object[]} [params.tools]    output of `filterTools()`, verbatim
   * @param {boolean}  [params.stream]
   * @param {(text: string) => void} [params.onToken]  per-token text delta
   * @param {object}   [params.extra]    passthrough fields; cannot override the
   *        cap or the thinking switch
   * @returns {Promise<{message: object, finishReason: string|null, usage: object|null, request: object}>}
   */
  async chatCompletion({
    messages,
    tools,
    toolChoice,
    model = TIER.REASON,
    // MapIO's DEFAULT_TEMPERATURE. Also the reason instructions do not need
    // re-injecting each round (design doc §1).
    temperature = 0,
    maxTokens = LOCAL_MAX_TOKENS,
    stream = false,
    onToken,
    signal,
    extra = {},
  } = {}) {
    if (!Array.isArray(messages) || !messages.length) {
      throw new Error('chatCompletion: `messages` is required');
    }

    const body = {
      ...extra,
      model,
      messages,
      temperature,
      // Clamped after the spread on purpose: `extra` must not be able to raise it.
      max_tokens: Math.max(1, Math.min(maxTokens ?? LOCAL_MAX_TOKENS, LOCAL_MAX_TOKENS)),
    };

    if (tools?.length) {
      body.tools = tools;
      body.tool_choice = toolChoice ?? 'auto';
      // Design doc §8.0, and this is not optional. Gemma 4 emits chain-of-thought
      // by default; with `tools` present that CoT eats the whole budget and NO
      // call is ever emitted. `reasoning_budget: 0` is silently ignored exactly
      // when tools are present — it works without them, which is how it fools
      // you. Measured: 256 tokens / finish_reason `length` / no call, versus 18
      // tokens and a correct call with this flag.
      body.chat_template_kwargs = { ...(extra.chat_template_kwargs || {}), enable_thinking: false };
    }

    if (stream) {
      body.stream = true;
      const assembler = new ChatAssembler();
      await this.transport.chat(body, {
        signal,
        onChunk: (chunk) => {
          assembler.push(chunk);
          const text = chunk?.choices?.[0]?.delta?.content;
          if (text && onToken) onToken(text);
        },
      });
      return { ...assembler.result(), request: body };
    }

    const json = await this.transport.chat(body, { signal });
    const choice = json?.choices?.[0];
    if (!choice) throw new Error('chatCompletion: response had no choices');
    const message = choice.message || { role: 'assistant', content: null };
    // Non-streaming callers still asked for tokens; give them the one block.
    if (onToken && message.content) onToken(message.content);
    return {
      message,
      finishReason: choice.finish_reason ?? null,
      usage: json.usage ?? null,
      request: body,
    };
  }

  /**
   * Embed raw strings with no prefixing. Prefer embedQueries/embedDocuments —
   * mixing prefixed and bare vectors in one index silently degrades ranking.
   *
   * @returns {Promise<Float32Array[]>} unit-normalised vectors
   */
  async embed(texts, { model = TIER.EMBED, signal } = {}) {
    if (!texts.length) return [];
    const json = await this.transport.embeddings({ model, input: texts }, { signal });
    // The server returns results with an `index` field; do not assume order.
    const out = new Array(texts.length);
    for (const row of json.data) {
      out[row.index ?? json.data.indexOf(row)] = normalise(Float32Array.from(row.embedding));
    }
    return out;
  }

  embedQueries(queries, opts) {
    return this.embed(queries.map(PREFIX.query), opts);
  }

  /** @param {{name: string, text: string}[]} docs */
  embedDocuments(docs, opts) {
    return this.embed(docs.map((d) => PREFIX.document(d.name, d.text)), opts);
  }
}

/**
 * Normalise in place so similarity is a plain dot product. EmbeddingGemma
 * output is close to unit length already, but "close" turns into drift once
 * vectors are quantised to Float32 and persisted across sessions.
 */
export function normalise(vec) {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}

/** Dot product of two unit vectors == cosine similarity. */
export function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}
