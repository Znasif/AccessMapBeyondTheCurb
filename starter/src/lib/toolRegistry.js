/**
 * ToolRegistry — milestone 7.
 *
 * Two jobs, and keeping them apart from the dispatcher is most of the design:
 * **which tools a session may see**, and **running one of them safely**. The
 * registry does not know what an utterance is; the dispatcher does not know what
 * a polygon is. That boundary is what lets this file be tested against all five
 * capability profiles with no LLM and no speech in the room.
 *
 * ## Making the metadata strip un-bypassable
 *
 * The plan says M7's dispatcher must own the strip of `requires` / `frames` /
 * `$note` before tools reach the model. It does not: `toolFilter.js`'s
 * `cloneWithoutMeta` (M2) already strips all three, at every depth, by cloning
 * rather than deleting, and `test_tool_filter.mjs` asserts it recursively
 * against a deep-frozen input. M7's real obligation is to make **bypass
 * impossible**, which is three properties of this class:
 *
 *   1. `serve()` is the only source of a tools array. The dispatcher never sees
 *      the raw schema, so there is no code path that can hand `schema.tools` to
 *      `client.chatCompletion`.
 *   2. {@link assertServable} runs at the seam and throws on any surviving
 *      metadata key. wllama v3 embeds llama-server's own
 *      `oaicompat_chat_params_parse`, which rejects the unstripped form — so a
 *      bad array is a hard in-tab failure on one backend and silent prompt
 *      pollution on another. Assert once, fail the same way everywhere.
 *   3. The served set and the handler set derive from **one call**: `serve()`
 *      returns `{tools, names, withheld}` and `dispatch()` refuses any name not
 *      in `names`. A tool can never be served without a handler, and a handler
 *      can never fire for a tool the session did not offer.
 *
 * `serve()` is cached per `(capabilities, frame)` because the tool block sits
 * *ahead* of everything volatile in the prompt: recomputing it per turn is free
 * in CPU and catastrophic if it ever produced a different array, since that
 * invalidates the whole KV prefix. The cache key includes the frame, so
 * `loadMapDefinition()` correcting the frame recalculates it.
 *
 * ## The 7th tool
 *
 * `route_to` passes the filter in every profile but its execution is M13.
 * Serving it with no handler wastes a round on `unknown_tool` and, worse, trains
 * users to hear "I can't do that" for the app's most valuable intent. So
 * `serve()` **intersects the filtered set with the registered set** and returns
 * the difference as `withheld`, with a reason — the design rule "a tool absent
 * from the session never enters the prompt" applied to implementation state as
 * well as to world capability. The intersection is explicit and logged, never
 * silent, so it cannot quietly become permanent.
 *
 * Platform-free.
 */

import { filterTools, placeTakingTools } from './toolFilter.js';
import { isAmbiguous, isUnsupported } from './worldAdapter.js';
import {
  STATUS,
  ambiguousResult,
  errorResult,
  makeResult,
  unitsFor,
  unsupportedResult,
} from './toolResult.js';

/** Keys that must never survive into a served tool. Mirrors `toolFilter`'s strip. */
const META_KEY = (key) => key === 'requires' || key === 'frames' || key.startsWith('$');

/**
 * Throw if anything in `tools` is not exactly the OpenAI shape.
 *
 * O(tools) and run once per session. Cheap insurance against a future
 * contributor hand-assembling an array — see the module note for why that is a
 * two-backend, two-symptom failure.
 *
 * @param {object[]} tools
 */
export function assertServable(tools) {
  if (!Array.isArray(tools)) throw new Error('assertServable: expected an array of tools');
  const problems = [];

  const walk = (value, path) => {
    if (Array.isArray(value)) { value.forEach((v, i) => walk(v, `${path}[${i}]`)); return; }
    if (value === null || typeof value !== 'object') return;
    for (const [key, val] of Object.entries(value)) {
      if (META_KEY(key)) problems.push(`${path}.${key}`);
      else walk(val, `${path}.${key}`);
    }
  };

  for (const tool of tools) {
    const name = tool?.function?.name ?? '<unnamed>';
    const top = Object.keys(tool || {}).sort().join(',');
    if (top !== 'function,type') problems.push(`${name}: top-level keys {${top}}`);
    const fn = Object.keys(tool?.function || {}).sort().join(',');
    if (fn !== 'description,name,parameters') problems.push(`${name}: function keys {${fn}}`);
    walk(tool, name);
  }

  if (problems.length) {
    throw new Error(
      `assertServable: these tools are not servable to an OpenAI-compatible endpoint — ${problems.join(', ')}. `
        + 'Build the array with ToolRegistry.serve(); it is the only path that strips schema metadata.',
    );
  }
  return tools;
}

/**
 * Validate one call's arguments against the **served** (narrowed) schema.
 *
 * Every tool declares `additionalProperties: false` and nothing enforced it
 * before this. The check that matters most is **enum membership against the
 * narrowed enum**: a 4-bit model emits `units: "minutes"` in an image frame
 * often enough to be a design constraint, and llama.cpp's grammar constrains
 * emission only when the narrowed schema was passed *and* the grammar path is
 * active. This dispatch-time check is what makes `toolFilter`'s narrowing
 * actually binding, and it costs an `Array.includes`.
 *
 * @param {object} tool  A served tool.
 * @param {object} args
 * @returns {string[]} Problems, empty when valid.
 */
export function validateArgs(tool, args) {
  const schema = tool?.function?.parameters || {};
  const properties = schema.properties || {};
  const problems = [];
  const given = args && typeof args === 'object' && !Array.isArray(args) ? args : {};

  if (args !== undefined && args !== null && (typeof args !== 'object' || Array.isArray(args))) {
    return [`arguments must be an object, got ${Array.isArray(args) ? 'an array' : typeof args}`];
  }

  for (const key of Object.keys(given)) {
    if (!(key in properties)) problems.push(`unknown property "${key}"`);
  }
  for (const key of schema.required || []) {
    if (given[key] === undefined || given[key] === null) problems.push(`missing required property "${key}"`);
  }
  for (const [key, value] of Object.entries(given)) {
    const spec = properties[key];
    if (!spec || value === undefined || value === null) continue;
    if (spec.type === 'number' && typeof value !== 'number') {
      problems.push(`"${key}" must be a number, got ${typeof value}`);
      continue;
    }
    if (spec.type === 'string' && typeof value !== 'string') {
      problems.push(`"${key}" must be a string, got ${typeof value}`);
      continue;
    }
    if (spec.type === 'boolean' && typeof value !== 'boolean') {
      problems.push(`"${key}" must be a boolean, got ${typeof value}`);
      continue;
    }
    if (Array.isArray(spec.enum) && !spec.enum.includes(value)) {
      problems.push(`"${key}" must be one of ${spec.enum.map((v) => JSON.stringify(v)).join(', ')}, got ${JSON.stringify(value)}`);
    }
  }
  return problems;
}

/** Session identity for the `serve()` cache. */
const sessionKey = (session) =>
  `${session.frame}|${[...(session.capabilities || [])].sort().join(',')}`;

export class ToolRegistry {
  /**
   * @param {object} params
   * @param {object} params.schema Parsed `llm-tools.schema.json`. Never mutated.
   */
  constructor({ schema } = {}) {
    if (!schema || !Array.isArray(schema.tools)) {
      throw new Error('ToolRegistry: expected a parsed schema with a `tools` array');
    }
    this.schema = schema;
    /** @type {Map<string, Function>} */
    this.handlers = new Map();
    /** @type {Set<string>} Schema-declared pure tools; the only memoizable ones. */
    this.pure = new Set(schema.notes?.pure || []);
    /** @type {Map<string, object>} `serve()` results, keyed by capabilities+frame. */
    this._served = new Map();
    /** @type {Map<string, object>} Memoized results for `pure` tools. */
    this._memo = new Map();
    this._declared = new Set(schema.tools.map((t) => t.function?.name));
  }

  /**
   * Register a handler.
   *
   * Validated at **registration** time, so a mistake fails at import rather than
   * mid-turn in front of a blind user.
   *
   * Purity is **read from the schema** (`notes.pure` / `notes.sideEffecting`) and
   * never declared by the caller: two sources of truth for that would drift, and
   * memoizing a side-effecting tool is a correctness bug, not a performance one.
   *
   * @param {string} name
   * @param {(args: object, ctx: object, api: object) => any} handler
   */
  register(name, handler) {
    if (!this._declared.has(name)) {
      throw new Error(
        `ToolRegistry.register: "${name}" is not in the schema. A typo'd handler is dead code that silently never fires.`,
      );
    }
    if (typeof handler !== 'function') {
      throw new Error(`ToolRegistry.register: handler for "${name}" must be a function`);
    }
    this.handlers.set(name, handler);
    // A new handler can widen the served set, so the cache must go.
    this._served.clear();
    return this;
  }

  /** @param {string} name */
  has(name) { return this.handlers.has(name); }

  /** @returns {string[]} */
  names() { return [...this.handlers.keys()]; }

  /** Whether the schema calls this tool pure — the memoization gate. */
  isPure(name) { return this.pure.has(name); }

  /**
   * The tools this session may see, plus the ones it may not and why.
   *
   * @param {{capabilities: Iterable<string>, frame: string}} session
   *   Normally `adapter.session()`.
   * @returns {{tools: object[], names: Set<string>, withheld: object[], placeTools: Set<string>}}
   */
  serve(session) {
    const key = sessionKey(session);
    const cached = this._served.get(key);
    if (cached) return cached;

    const filtered = filterTools(this.schema, session);
    const tools = filtered.filter((tool) => this.handlers.has(tool.function.name));
    const withheld = filtered
      .filter((tool) => !this.handlers.has(tool.function.name))
      .map((tool) => ({
        name: tool.function.name,
        reason: 'no_handler',
        detail: 'passes capability filtering but has no registered handler in this build',
      }));

    assertServable(tools);

    const result = {
      tools,
      names: new Set(tools.map((t) => t.function.name)),
      withheld,
      // Derived from `'place' in parameters.properties`, never hand-listed, and
      // NOT a gate on candidate injection — measured inert over six no-place
      // utterances. This is the set whose `args.place` `dispatch()` resolves.
      placeTools: placeTakingTools(tools),
      byName: new Map(tools.map((t) => [t.function.name, t])),
    };
    this._served.set(key, result);
    return result;
  }

  /** Drop memoized results. A window change invalidates every position-keyed answer. */
  clearMemo() { this._memo.clear(); }

  /**
   * Run one tool. **Never throws.**
   *
   * The pipeline, in order:
   *   1. registered and served?      → else `unknown_tool`
   *   2. validate args               → `invalid_arguments`
   *   3. resolve `args.place`        → Place | Ambiguous | `unresolved_place`
   *   4. memo lookup                 → schema-`pure` tools only
   *   5. run the handler
   *   6. normalize to an envelope, sanitize `data`, stamp frame/units/worldId
   *   7. catch → `status: 'error'`, so the model sees one envelope shape
   *
   * @param {string} name
   * @param {object} args
   * @param {object} ctx TurnContext.
   * @param {object} params
   * @param {object} params.adapter
   * @param {object} [params.served] `serve()` output; recomputed if omitted.
   * @param {object} [params.extras] Passed through to the handler as `api`.
   * @returns {Promise<object>} An envelope.
   */
  async dispatch(name, args, ctx, { adapter, served, extras = {} } = {}) {
    const session = served || this.serve(adapter.session());
    const base = {
      frame: adapter.frame,
      worldId: adapter.worldId,
      units: unitsFor(adapter),
      acuityCell: ctx?.acuityCell ?? undefined,
    };

    if (!session.names.has(name)) {
      return errorResult(
        name,
        'unknown_tool',
        `There is no tool called "${name}" in this session. Available: ${[...session.names].join(', ')}.`,
        base,
      );
    }

    const tool = session.byName.get(name);
    const problems = validateArgs(tool, args);
    if (problems.length) {
      return errorResult(name, 'invalid_arguments', problems.join('; '), base);
    }

    const callArgs = { ...(args || {}) };

    // --- place resolution, for the tools that take one ------------------------
    if (session.placeTools.has(name) && typeof callArgs.place === 'string') {
      const resolved = adapter.resolvePlace(callArgs.place);
      if (isAmbiguous(resolved)) {
        return ambiguousResult(name, resolved.candidates, {
          ...base,
          message: `Several places match "${callArgs.place}". Which one?`,
        });
      }
      if (isUnsupported(resolved)) {
        return unsupportedResult(name, resolved.reason, base);
      }
      if (!resolved) {
        return errorResult(
          name,
          'unresolved_place',
          `I could not find "${callArgs.place}" on this map.`,
          base,
        );
      }
      callArgs.place = resolved.name;
      callArgs.$place = resolved;
    }

    // --- memoization ---------------------------------------------------------
    const memoKey = this.isPure(name) ? this.#memoKey(name, callArgs, ctx) : null;
    if (memoKey && this._memo.has(memoKey)) {
      const hit = this._memo.get(memoKey);
      // `get_place_details` must recompute open/closed against the clock even on
      // a hit — the schema's own `$comment_pure` says so. Handlers declare that
      // by exposing `recompute(result, ctx)`.
      const handler = this.handlers.get(name);
      return handler.recompute ? handler.recompute(hit, ctx) : hit;
    }

    try {
      const raw = await this.handlers.get(name)(callArgs, ctx, { adapter, registry: this, ...extras });
      const envelope = this.#normalize(name, raw, base);
      if (memoKey && envelope.status !== STATUS.ERROR) this._memo.set(memoKey, envelope);
      return envelope;
    } catch (error) {
      // Caught here rather than in `toolLoop`, so the model still gets
      // frame/units alongside the same `{error, message}` keys the loop emits.
      return errorResult(name, 'tool_failed', String(error?.message || error), base);
    }
  }

  /**
   * Memo key. `acuityCell` is what makes it device-independent (the same key
   * works on Braille Doodle and on printed A4), and `windowId` is what stops a
   * pan from serving the previous window's answer.
   *
   * ⚠️ **`memoTag` is not optional decoration.** The design doc's memo table
   * keys on position and arguments only, and that is not sufficient: a handler
   * may read *other* injected context, and anything it reads must be in the key
   * or the memo will serve an answer that context never produced. Two live
   * cases, both found by the harness:
   *
   *   - `whats_here` reads `ctx.liveFeature`. Without the tag, a finger that has
   *     not moved a whole acuity cell keeps being told the FIRST feature name
   *     the stream reported, forever — the exact staleness `LIVE_FEATURE_MAX_AGE_MS`
   *     exists to prevent, reintroduced by the cache.
   *   - `get_direction_to` reads `ctx.heading`, which decides "Continue
   *     straight" versus "Head north-east".
   *
   * A handler declares its own contribution; the registry never guesses.
   */
  #memoKey(name, args, ctx) {
    if (!ctx) return null;
    const argPart = Object.entries(args)
      .filter(([key]) => !key.startsWith('$'))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`)
      .join('&');
    const tag = this.handlers.get(name)?.memoTag?.(ctx) ?? '';
    return `${name}|${ctx.worldId}|${ctx.windowId}|${ctx.acuityCell}|${argPart}|${tag}`;
  }

  /**
   * A handler may return a finished envelope, an adapter sentinel, or a plain
   * value. Normalizing here means handlers stay short and the envelope contract
   * lives in exactly one place.
   */
  #normalize(name, raw, base) {
    if (isUnsupported(raw)) return unsupportedResult(name, raw.reason, base);
    if (isAmbiguous(raw)) return ambiguousResult(name, raw.candidates, base);
    if (raw && typeof raw === 'object' && typeof raw.status === 'string' && raw.tool) {
      // Already an envelope: stamp only what the handler left out, so a handler
      // that answered in different units keeps them.
      const envelope = makeResult({
        ...base,
        ...raw,
        units: { ...base.units, ...(raw.units || {}) },
      });
      // Carry across any non-enumerable/symbol slot the handler attached — the
      // `recompute` hook uses one to keep the clock's inputs out of the prompt,
      // and a plain spread would drop it and silently disable the recompute.
      for (const key of Object.getOwnPropertySymbols(raw)) {
        Object.defineProperty(envelope, key, Object.getOwnPropertyDescriptor(raw, key));
      }
      return envelope;
    }
    if (raw === undefined || raw === null) {
      return errorResult(name, 'tool_failed', 'The tool returned nothing.', base);
    }
    return makeResult({ status: STATUS.OK, tool: name, data: raw, ...base });
  }
}

export default ToolRegistry;
