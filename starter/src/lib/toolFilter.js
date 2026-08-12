/**
 * Capability-based tool filtering — milestone 2.
 *
 * §3.5: capability negotiation replaces semantic tool routing. The 12 tools in
 * `docs/llm-tools.schema.json` each carry two non-OpenAI keys — `requires`
 * (capabilities the world must have) and `frames` (where the tool is meaningful)
 * — plus `$note` fields that are instructions to *this* module. Filtering on
 * those keys shrinks the schema block deterministically, for free, and makes it
 * impossible to route to a tool that cannot run in the session.
 *
 * Then the non-standard keys must come off: llama-server passes `tools` to the
 * Jinja chat template, and `requires` / `frames` / `$note` would be serialised
 * into the prompt as noise the model has never seen in training.
 *
 *   filterTools(schema, { capabilities: new Set(['places', 'regions']), frame: 'image' })
 *     -> 7 clean OAI tools, route_to's mode enum narrowed to ['fly_me_there']
 *
 * Counts (schema `capabilityProfiles`, and the correction in
 * `browser-voice-exploration-plan.md` §3): full OSM 12, everything else 7. The
 * design doc's §3.5 figures of 4 and 3 are stale — `{places}` alone admits
 * `whats_here` + the five `places` tools + a narrowed `route_to` = 7. The schema
 * is authoritative.
 *
 * Platform-free: no fetch, no DOM. The caller supplies the parsed schema.
 */

import { placeTakingTools as placeTakingToolsFromSchema } from './candidateContext.js';
import { FRAME_LIST } from './worldAdapter.js';

/**
 * Keys the schema adds for us that must never reach the model. Anything starting
 * with `$` is stripped as well, so a future `$comment` needs no change here.
 */
const NON_OAI_KEYS = new Set(['requires', 'frames']);

/**
 * The two `$note`s that mandate serving-time enum narrowing.
 *
 * These are prose instructions to the implementer, so they cannot be executed
 * mechanically — this table is where they become code, and it is the *only*
 * place tool names are hardcoded. The schema forces that: it states the rule in
 * English on a specific tool rather than encoding it in a machine-readable field.
 * Each entry quotes the `$note` it implements; if the note changes, change this.
 *
 * Everything else here is generic and driven by `requires` / `frames`.
 */
const NARROWINGS = [
  {
    tool: 'route_to',
    param: 'mode',
    // $note: "NARROW the mode enum, do not drop the tool. Without the `routing`
    // capability, serve mode as enum [fly_me_there] only. A model that cannot
    // offer guidance at all is far worse than one offering the weaker mode."
    //
    // This is also where the design doc's `routing | places` requirement for
    // route_to lives. The schema does not encode an OR in `requires` — it tags
    // route_to with the *weaker* branch (`places`) and expresses the stronger
    // branch as this enum narrowing. So `requires` stays a plain AND everywhere.
    enum: ({ capabilities }) => (capabilities.has('routing') ? null : ['fly_me_there']),
  },
  {
    tool: 'get_distance_to',
    param: 'units',
    // $note: "The `units` enum MUST be narrowed per frame before serving:
    // geographic -> [minutes, metres, feet, blocks]; enu -> [metres];
    // image -> [material_mm]."
    //
    // ⚠️ The $note narrows by FRAME ONLY, and that is not sufficient — a
    // correction found in M7. `minutes` needs a walking-speed assumption and
    // `blocks` needs a street network: they are `routing` / `graph` properties,
    // not frame properties. An Audiom Tier A session declares `{places}` and is
    // geographic, so the note as written offers it `minutes` and `blocks`, and a
    // model that picks either gets a fabricated answer or an error.
    //
    // So the geographic row is split by capability. The other two rows are
    // unchanged: an `enu` or `image` world has no walking claim to make at all.
    // `getDistanceTo.js` re-checks the capability at dispatch time, which is the
    // backstop for a model that emits an out-of-enum value anyway; this is what
    // stops it being offered in the first place.
    enum: ({ frame, capabilities }) => {
      if (frame === 'enu') return ['metres'];
      if (frame === 'image') return ['material_mm'];
      if (frame !== 'geographic') return null;
      const units = ['metres', 'feet'];
      if (capabilities.has('routing')) units.unshift('minutes');
      if (capabilities.has('graph')) units.push('blocks');
      return units;
    },
  },
];

/**
 * Is `requires` satisfied by the session's capabilities?
 *
 * The encoding actually found in the schema is a flat array of capability names,
 * empty for `whats_here`, read as AND. Nested arrays are read as OR so that a
 * future `[["routing", "places"]]` works without a code change — no tool uses
 * that form today.
 *
 * @param {Array<string|string[]>} requires
 * @param {Set<string>} capabilities
 */
function requirementsMet(requires, capabilities) {
  if (!requires) return true;
  if (!Array.isArray(requires)) {
    throw new Error(`toolFilter: \`requires\` must be an array, got ${typeof requires}`);
  }
  return requires.every((clause) =>
    Array.isArray(clause) ? clause.some((cap) => capabilities.has(cap)) : capabilities.has(clause),
  );
}

/**
 * Deep clone, dropping our metadata keys at every level. Cloning rather than
 * deleting is what keeps the caller's schema object untouched — it is typically
 * a module-level import shared by the dispatcher, the eval harness and the
 * training-set builder, and mutating it would corrupt every later session.
 */
function cloneWithoutMeta(value) {
  if (Array.isArray(value)) return value.map(cloneWithoutMeta);
  if (value === null || typeof value !== 'object') return value;
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (NON_OAI_KEYS.has(key) || key.startsWith('$')) continue;
    out[key] = cloneWithoutMeta(val);
  }
  return out;
}

/**
 * Apply a NARROWINGS entry in place on an already-cloned tool.
 *
 * The narrowed list is intersected with the declared enum, so a typo in the table
 * cannot widen a tool's contract beyond what the schema (and the training set)
 * declares.
 */
function narrowEnums(tool, session) {
  const props = tool.function?.parameters?.properties;
  if (!props) return;
  for (const rule of NARROWINGS) {
    if (rule.tool !== tool.function.name) continue;
    const prop = props[rule.param];
    if (!prop) continue;
    const narrowed = rule.enum(session);
    if (!narrowed) continue;
    const declared = prop.enum;
    prop.enum = Array.isArray(declared) ? narrowed.filter((v) => declared.includes(v)) : narrowed;
    if (prop.enum.length === 0) {
      throw new Error(
        `toolFilter: narrowing ${rule.tool}.${rule.param} left an empty enum; ` +
          'the $note and the schema have drifted apart.',
      );
    }
  }
}

/**
 * Filter the 12 tools down to those this session can actually run, and clean them
 * for the OpenAI-compatible `tools` parameter.
 *
 * @param {object} schemaJson  Parsed `llm-tools.schema.json`. Never mutated.
 * @param {object} session
 * @param {Iterable<string>} session.capabilities
 * @param {string} session.frame  One of `geographic` | `enu` | `image`.
 * @returns {Array<{type: 'function', function: {name: string, description: string, parameters: object}}>}
 */
export function filterTools(schemaJson, { capabilities, frame } = {}) {
  if (!schemaJson || !Array.isArray(schemaJson.tools)) {
    throw new Error('toolFilter: expected a parsed schema with a `tools` array');
  }
  if (!FRAME_LIST.includes(frame)) {
    throw new Error(`toolFilter: unknown frame ${JSON.stringify(frame)}; expected one of ${FRAME_LIST.join(', ')}`);
  }
  const caps = capabilities instanceof Set ? capabilities : new Set(capabilities || []);
  const session = { capabilities: caps, frame };

  return schemaJson.tools
    .filter((tool) => {
      if (!requirementsMet(tool.requires, caps)) return false;
      // A missing `frames` means "everywhere"; no tool omits it today.
      return !tool.frames || tool.frames.includes(frame);
    })
    .map((tool) => {
      const clean = cloneWithoutMeta(tool);
      narrowEnums(clean, session);
      return clean;
    });
}

/**
 * Names of the tools that take a resolved place name (§4.3: derive, never
 * hand-list). Accepts either a filtered tool array or a whole schema object, so
 * the dispatcher can ask about the session's tools and the training-set builder
 * about all 12.
 *
 * Re-exported from `candidateContext.js` rather than reimplemented — the
 * candidate block and the filter must agree on this set or the injected
 * candidates stop lining up with the tools that can consume them.
 *
 * @param {Array|object} tools
 * @returns {Set<string>}
 */
export function placeTakingTools(tools) {
  return placeTakingToolsFromSchema(Array.isArray(tools) ? { tools } : tools);
}
