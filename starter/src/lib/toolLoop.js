/**
 * The caller-side agentic loop — milestone 3.
 *
 * llama.cpp emits tool calls; it does not run them. Everything between "the
 * model said `route_to`" and "the model has seen what happened" is this file.
 * It is the ES-module descendant of `LLM.ask` in
 * `explore/simple_camio_llm/src/llm/llm.py:247-330`, and the plan (§4) is
 * explicit that the round loop itself is *not* ported — only two behaviours
 * are, both of which are load-bearing and both of which have tests:
 *
 *   1. the `LOCAL_MAX_TOKENS` cap, which lives in `localLLM.js`, and
 *   2. the answer-dedup containment rule, which lives here.
 *
 * Three rules the Python version teaches by counter-example:
 *
 * NO INSTRUCTION RE-INJECTION. `LLM.ask` re-appends the instruction block after
 * every tool round to fight drift. Design doc §1: that invalidates the KV cache
 * every single round, and with `temperature: 0` the system prompt does not
 * drift enough to be worth ~1,690 tokens of re-prefill. Instructions are in the
 * system prompt, once, and this loop never adds any.
 *
 * APPEND-ONLY HISTORY. §6.1: llama.cpp reuses the KV prefix for exactly as long
 * as the token sequence is unchanged from position zero. Every round here
 * extends the array and touches nothing before the extension point — no
 * re-ordering, no mid-history injection, no rewriting an earlier tool result.
 * The `messages` array the caller passed is never mutated either.
 *
 * TOOL ARGS ARE UNTRUSTED. The model writes `arguments` as a *string*, and a
 * local 4B model at 4-bit writes malformed JSON often enough that it is a
 * design constraint, not an edge case. A parse failure must reach the model as
 * a tool result it can retry from, never as an exception that kills the turn
 * and leaves a blind user in silence.
 *
 * Platform-free: no fetch, no DOM. The client is injected.
 */

/** Round budget. Real turns finish in 2 (call, then answer); 4 leaves room for
 * a retry after a bad-arguments result without letting a confused model spin. */
export const DEFAULT_MAX_ROUNDS = 4;

/**
 * Shape returned to the model when its own tool call cannot be run.
 *
 * Deliberately an object with `error`: the model is far better at recovering
 * from `{"error": "invalid_arguments", ...}` than from prose, and MapIO's flat
 * "An error occurred while processing the tool call." string
 * (`prompt_formatter.py:216`) tells it nothing it can act on.
 */
function errorResult(kind, message, extra = {}) {
  return { error: kind, message, ...extra };
}

/** llama-server wants `content` as a string; objects get JSON. */
function toolContent(result) {
  if (typeof result === 'string') return result;
  if (result === undefined) return '';
  return JSON.stringify(result);
}

/**
 * Rebuild the assistant turn for the history in the exact OpenAI shape, dropping
 * anything the server added for us (`reasoning_content`, timings, `index`).
 * Feeding a response object straight back has bitten every implementation of
 * this loop at least once.
 */
function assistantMessage(message) {
  const out = { role: 'assistant', content: message.content ?? null };
  if (message.tool_calls?.length) {
    out.tool_calls = message.tool_calls.map((call) => ({
      id: call.id,
      type: call.type || 'function',
      function: { name: call.function?.name, arguments: call.function?.arguments ?? '' },
    }));
  }
  return out;
}

/**
 * Run rounds until the model answers in prose, runs out of rounds, or stops
 * calling tools.
 *
 * @param {object}   params
 * @param {object}   params.messages     system + user turns, already ordered by
 *        `candidateContext.js`. Not mutated; the returned `messages` is new.
 * @param {object}   params.client       `LocalLLMClient` (or anything with the
 *        same `chatCompletion`)
 * @param {object[]} [params.tools]      `filterTools()` output, passed verbatim
 * @param {(name: string, args: object, meta: object) => any} params.executeTool
 *        the dispatcher. May be async. May throw — that is caught and fed back.
 * @param {number}   [params.maxRounds]
 * @param {(text: string, meta: object) => void} [params.onNarration]  called
 *        once per *non-duplicate* block of model prose, in order. This is the
 *        speech hook: what it receives is what gets spoken.
 * @returns {Promise<{text: string, messages: object[], rounds: number,
 *   stopReason: 'answer'|'max_rounds', maxRoundsExceeded: boolean,
 *   toolCalls: object[], usage: object[]}>}
 */
export async function runToolLoop({
  client,
  messages,
  tools,
  executeTool,
  maxRounds = DEFAULT_MAX_ROUNDS,
  onNarration,
  model,
  temperature,
  maxTokens,
  stream = false,
  onToken,
  signal,
} = {}) {
  if (!client?.chatCompletion) throw new Error('runToolLoop: `client` must implement chatCompletion');
  if (!Array.isArray(messages) || !messages.length) throw new Error('runToolLoop: `messages` is required');
  if (tools?.length && typeof executeTool !== 'function') {
    throw new Error('runToolLoop: `executeTool` is required when tools are served');
  }

  const history = [...messages];
  const toolCalls = [];
  const usage = [];
  let output = '';
  let rounds = 0;

  const narrate = (content, meta) => {
    // §4 / llm.py:296-305. Gemma routinely emits its whole answer alongside the
    // tool call and then again after seeing the tool result, so the user hears
    // the same two sentences twice. Containment, not equality, because the
    // second copy is usually the first plus a trailing flourish. And *skip the
    // duplicate* rather than keeping only the last round: a model that says its
    // piece on the tool round and nothing after would otherwise be silent.
    const text = content?.trim();
    if (!text || output.includes(text)) return;
    output += `${content}\n`;
    onNarration?.(content, meta);
  };

  while (rounds < maxRounds) {
    rounds += 1;

    const res = await client.chatCompletion({
      messages: history,
      tools,
      model,
      temperature,
      maxTokens,
      stream,
      onToken,
      signal,
    });
    if (res.usage) usage.push(res.usage);

    const message = res.message || {};
    narrate(message.content, { round: rounds });
    history.push(assistantMessage(message));

    // Driven off the calls themselves, not off `finish_reason`. They agree in
    // practice (`tool_calls`), but a truncated round can report `length` while
    // still carrying a complete call, and honouring it costs nothing.
    const calls = message.tool_calls || [];
    if (!calls.length) {
      return finish('answer');
    }

    for (const call of calls) {
      const name = call.function?.name;
      const rawArgs = call.function?.arguments ?? '';

      let args;
      try {
        args = rawArgs.trim() ? JSON.parse(rawArgs) : {};
      } catch (err) {
        // Recoverable by construction: the model sees its own broken string and
        // usually re-emits the call correctly on the next round.
        push(call, errorResult('invalid_arguments', `Could not parse arguments as JSON: ${err.message}`, {
          received: rawArgs,
        }), { name, ok: false });
        continue;
      }

      try {
        push(call, await executeTool(name, args, { call, round: rounds }), { name, args, ok: true });
      } catch (err) {
        push(call, errorResult('tool_failed', String(err?.message || err)), { name, args, ok: false });
      }
    }
  }

  // Budget exhausted mid-conversation: the history ends on tool results the
  // model never got to read. Hand back whatever narration exists — often the
  // answer, since Gemma front-loads it — and let the caller decide.
  return finish('max_rounds');

  function push(call, result, meta) {
    toolCalls.push({ ...meta, id: call.id, result });
    history.push({
      role: 'tool',
      tool_call_id: call.id,
      // `name` is redundant under the OpenAI spec but several llama.cpp chat
      // templates render it, and it is free.
      name: call.function?.name,
      content: toolContent(result),
    });
  }

  function finish(stopReason) {
    return {
      text: output.replace(/\n$/, ''),
      messages: history,
      rounds,
      stopReason,
      maxRoundsExceeded: stopReason === 'max_rounds',
      toolCalls,
      usage,
    };
  }
}
