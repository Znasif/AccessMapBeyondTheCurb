/**
 * WorldAdapter — milestone 2.
 *
 * Implements §3.4 of the local-LLM design: one data model, three adapters. OSM,
 * Audiom and `.camio` are not the same world wearing different hats — they differ
 * in reference frame (WGS84 / ENU / template pixels) and in what they can answer
 * at all. A skeleton diagram has no north; a colour-map hotspot has no incline;
 * an opaque Audiom embed has names and bounds and nothing else.
 *
 * Rather than teach the model those differences in a prompt, each adapter
 * *declares* them as a capability set, and the tool schema is filtered by
 * construction before it ever reaches the prompt (§3.5, see `toolFilter.js`).
 * Capability negotiation is deterministic, free, and cannot route to a tool that
 * does not exist in the session — which is what a semantic router would do.
 *
 * This module is deliberately platform-free: no Mapbox, no iframe, no DOM, no
 * fetch. Concrete adapters (M4 OSM, M5a Audiom, M6 camio) bring their own I/O and
 * override only what their capabilities claim.
 */

/**
 * The seven capabilities of §3.4, verbatim from `docs/llm-tools.schema.json`.
 *
 * A capability is a promise about the *data*, not about the code: declaring
 * `routing` means a path can actually be computed, so every tool tagged
 * `requires: ["routing"]` will be offered to the model and must return an answer.
 * Over-declaring is the failure mode that matters — the model calls a tool that
 * cannot run and the turn dies.
 */
export const CAPABILITIES = Object.freeze({
  /** Named features can be enumerated and resolved by name. */
  PLACES: 'places',
  /** Connectivity between locations is known. */
  GRAPH: 'graph',
  /** A path can be computed between two locations. */
  ROUTING: 'routing',
  /** Kerb / incline / surface / crossing attributes are available. */
  ACCESSIBILITY_ATTRS: 'accessibilityAttrs',
  /** Building entrances can be located (YOLO + Mapillary). */
  ENTRANCES: 'entrances',
  /** Colour-map hotspot regions with descriptions (`.camio`). */
  REGIONS: 'regions',
  /** The surface pushes feature-under-cursor events (Audiom `featureEntered`). */
  LIVE_FEATURE_STREAM: 'liveFeatureStream',
});

/** Every capability name, for validation. */
export const CAPABILITY_LIST = Object.freeze(Object.values(CAPABILITIES));

/**
 * Reference frames (§5.4). The frame decides what a distance and a direction
 * *mean*, so it rides along in every tool result rather than being assumed by L3.
 *
 * Saying "north" about a human skeleton is a bug. So is answering "12 minutes'
 * walk" about a diagram.
 */
export const FRAMES = Object.freeze({
  /** WGS84 lat/lng. Compass bearings, minutes walking, real crossings. */
  GEOGRAPHIC: 'geographic',
  /** Local east/north metres. Clock-face only, no compass, distances in metres. */
  ENU: 'enu',
  /** Template pixels. Clock-face only, distances in millimetres on the material. */
  IMAGE: 'image',
});

/** Every frame name, for validation. */
export const FRAME_LIST = Object.freeze(Object.values(FRAMES));

/* ------------------------------------------------------------------ model -- */

/**
 * @typedef {object} Provenance
 * @property {string} source   Where this came from: `osm` | `audiom:layers` | `camio:colormap` | …
 * @property {string} [id]     Native identifier in that source (`ext:osm_id`, layer feature id, colour key).
 * @property {number} [fetchedAt] Epoch ms, for cache invalidation.
 */

/**
 * A named thing that can be resolved by name and talked about. §3.4.
 *
 * `geometry` is GeoJSON in whatever the adapter's frame is — lng/lat for
 * `geographic`, east/north metres for `enu`, template pixels for `image`. It is
 * never mixed within one adapter.
 *
 * @typedef {object} Place
 * @property {string} id
 * @property {string} name              Canonical name; the string tools receive as `place`.
 * @property {string[]} aliases         Other names users say for it.
 * @property {string} [category]        Comma-separated, OSM-style (`tourism.attraction, building.office`).
 * @property {object} [geometry]        GeoJSON geometry in this adapter's frame.
 * @property {Record<string, any>} [props] Hours, phone, wheelchair tags — whatever the source carries.
 * @property {Provenance} [provenance]
 */

/**
 * An edge of the pedestrian graph. Only meaningful with the `graph` capability.
 *
 * @typedef {object} Segment
 * @property {string} id
 * @property {string} fromNode
 * @property {string} toNode
 * @property {string} [kind]            `sidewalk` | `crossing` | `footway` | …
 * @property {SegmentAttrs} [attrs]
 * @property {Provenance} [provenance]
 */

/**
 * @typedef {object} SegmentAttrs
 * @property {number} [incline]         Grade as a percentage, signed in the from→to direction.
 * @property {string} [surface]         `asphalt` | `concrete` | `cobblestone` | …
 * @property {number} [width]           Metres.
 * @property {boolean} [steps]
 * @property {string[]} [obstacles]
 */

/**
 * A vertex of the pedestrian graph — typically a corner or a kerb.
 *
 * @typedef {object} Node
 * @property {string} id
 * @property {object} position          `{u, v}` plus frame-native coordinates.
 * @property {string} [kind]            `kerb` | `crossing` | `junction` | …
 * @property {NodeAttrs} [attrs]
 */

/**
 * @typedef {object} NodeAttrs
 * @property {string} [kerb]            `raised` | `lowered` | `flush` | `none`.
 * @property {boolean} [tactileWarning]
 * @property {object} [signals]         `{ pedestrian?: boolean, audible?: boolean }`.
 */

/**
 * A `.camio` colour-map hotspot. The colour is an identifier, not an appearance.
 *
 * @typedef {object} Region
 * @property {string} id
 * @property {string} name
 * @property {string} [description]
 * @property {object} [geometry]        Region outline in template pixels.
 * @property {string} [sound]           Hotspot audio, if the project ships one.
 * @property {Provenance} [provenance]
 */

/**
 * What is under the finger. Which fields are populated depends on the world:
 * `.camio` fills `region`, Audiom tier C fills `place`, full OSM fills all four.
 *
 * @typedef {object} AtResult
 * @property {Place}   [place]
 * @property {Segment} [segment]
 * @property {Node}    [node]
 * @property {Region}  [region]
 */

/**
 * @typedef {object} RoutePrefs
 * @property {number}  [streetAvoidance] 0 (no preference) to 2 (avoid strongly).
 * @property {number}  [maxUphill]       Percent grade.
 * @property {number}  [maxDownhill]     Percent grade.
 * @property {boolean} [avoidBarriers]
 */

/**
 * @typedef {object} Route
 * @property {Segment[]} segments
 * @property {number} [distance]        In the adapter's frame units (§5.4).
 * @property {number} [duration]        Seconds. `geographic` only — meaningless on a diagram.
 * @property {string} frame             Echoed so L3 narrates the units it was given.
 */

/* -------------------------------------------------------------- sentinels -- */

/**
 * Sentinels, not exceptions.
 *
 * `resolvePlace` returning `Ambiguous` and `route` returning `Unsupported` are
 * ordinary outcomes of a correct call, and the dispatcher turns both into speech
 * ("did you mean…", "I can help you find it on the map instead"). Throwing for
 * them would force try/catch around every tool body and lose the payload that
 * makes the spoken answer useful.
 *
 * Exceptions stay for programming errors — chiefly "this adapter declared a
 * capability and then failed to implement the method behind it", which is a bug
 * that must fail loudly at the first call rather than degrade into a shrug.
 */

/** Marker for "several places match and none dominates" (§4.2's tie case). */
export class Ambiguous {
  /**
   * @param {Place[]} candidates Ranked best-first; L3 chooses or asks.
   * @param {string} [query]     The text that was ambiguous.
   */
  constructor(candidates, query) {
    this.candidates = candidates;
    this.query = query;
  }
}

/** Marker for "this world cannot answer that", carrying a reason to narrate. */
export class Unsupported {
  /**
   * @param {string} reason      Human-readable, spoken to the user if it surfaces.
   * @param {string} [capability] The capability that would have been required.
   */
  constructor(reason, capability) {
    this.reason = reason;
    this.capability = capability;
  }
}

/** @param {Place[]} candidates @param {string} [query] */
export const ambiguous = (candidates, query) => new Ambiguous(candidates, query);

/** @param {string} reason @param {string} [capability] */
export const unsupported = (reason, capability) => new Unsupported(reason, capability);

/** @returns {value is Ambiguous} */
export const isAmbiguous = (value) => value instanceof Ambiguous;

/** @returns {value is Unsupported} */
export const isUnsupported = (value) => value instanceof Unsupported;

/* ---------------------------------------------------------------- adapter -- */

/**
 * Base class for every world. §3.4's surface, and nothing else.
 *
 * The contract between the two halves of each method is the point of this class:
 *
 *   capability NOT declared -> return `Unsupported`. Expected, narratable, and
 *                              the matching tool was never offered anyway.
 *   capability declared     -> `throw`. The adapter promised the data and did not
 *                              deliver a method; that is a bug in the adapter,
 *                              not a fact about the world, and it must be loud.
 *
 * So a subclass overrides exactly the methods its capability set claims, and the
 * base handles the rest correctly by construction.
 */
export class WorldAdapter {
  /**
   * @param {object} opts
   * @param {string} opts.frame                      One of FRAMES.
   * @param {Iterable<string>} [opts.capabilities]   Subset of CAPABILITY_LIST.
   * @param {string} [opts.worldId]                  `osm:<quadkey>` | `audiom:<embedId>` | `camio:<projectId>`.
   */
  constructor({ frame, capabilities = [], worldId } = {}) {
    if (!FRAME_LIST.includes(frame)) {
      throw new Error(`WorldAdapter: unknown frame ${JSON.stringify(frame)}; expected one of ${FRAME_LIST.join(', ')}`);
    }
    const caps = new Set(capabilities);
    for (const cap of caps) {
      if (!CAPABILITY_LIST.includes(cap)) {
        throw new Error(`WorldAdapter: unknown capability ${JSON.stringify(cap)}`);
      }
    }
    /** @type {string} */
    this.frame = frame;
    /** @type {Set<string>} */
    this.capabilities = caps;
    /** @type {string|undefined} */
    this.worldId = worldId;
  }

  /** @param {string} capability */
  has(capability) {
    return this.capabilities.has(capability);
  }

  /**
   * The two values `filterTools()` needs. Keeps the dispatcher from reaching into
   * adapter internals to assemble them.
   *
   * @returns {{ frame: string, capabilities: Set<string> }}
   */
  session() {
    return { frame: this.frame, capabilities: this.capabilities };
  }

  /**
   * Resolve a user's phrasing to a canonical place.
   *
   * Note this is *not* the L1 retrieval of §4.2 — `PlaceIndex` does the semantic
   * ranking. This is the adapter's own name lookup, the authority on what exists.
   *
   * @param {string} _text
   * @returns {Place|Ambiguous|Unsupported|null}
   */
  resolvePlace(_text) {
    return this.#requireOverride('resolvePlace', CAPABILITIES.PLACES);
  }

  /**
   * What is under (u,v). The one universal coordinate (§2.1) — every adapter must
   * implement this, because `whats_here` requires no capability at all.
   *
   * @param {number} _u @param {number} _v
   * @returns {AtResult}
   */
  at(_u, _v) {
    throw new Error(`${this.constructor.name}.at() must be implemented: whats_here is offered in every session`);
  }

  /**
   * Named places near (u,v), best/nearest first.
   *
   * @param {number} _u @param {number} _v
   * @param {number} [_radius] In frame units; adapter picks a scale-appropriate default.
   * @returns {Place[]|Unsupported}
   */
  nearby(_u, _v, _radius) {
    return this.#requireOverride('nearby', CAPABILITIES.PLACES, []);
  }

  /**
   * `(u, v)` → a point in this world's **metric plane**: a flat, isotropic,
   * y-**down** plane in the adapter's natural unit.
   *
   * This is the one conversion the tool layer is allowed to ask for, and it
   * exists because direction is not computable from `(u, v)`. Normalised
   * coordinates are anisotropic — a 45° sweep across a 297×210 mm sheet is 32°
   * in `(u, v)` — and in a geographic world they are Mercator-warped on top of
   * that. Every bearing and every heading in the system is computed in this
   * plane, so they are all in the same one by construction.
   *
   * y grows downward to match `lib/logic`'s convention (`graph.js` defines north
   * as the versor `(0, -1)`) and `(u, v)`'s own (`v = 0` is top). An adapter
   * whose native frame is y-up — east/north metres, latitude — flips here, once.
   *
   * ⚠️ This is a *perception→world* conversion and it happens exactly here. No
   * `u` or `v` may appear in anything a tool returns.
   *
   * @param {number} _u @param {number} _v
   * @returns {{x: number, y: number, units: string}|Unsupported}
   */
  metricPoint(_u, _v) {
    throw new Error(
      `${this.constructor.name}.metricPoint() must be implemented: every direction in the system is computed in this plane`,
    );
  }

  /**
   * Direction from one `(u, v)` to another, in this frame's vocabulary.
   *
   * There is **one** implementation of the rosette —
   * `direction.js#bearingBetweenPoints(adapter, …)` — and every adapter's
   * override is a one-line delegation to it. A second copy is how spoken
   * directions silently rotate. It is not implemented on the base class only
   * because `direction.js` imports {@link FRAMES} from here, and a cycle between
   * the two would be a fragile way to save two lines per adapter.
   *
   * `compass` is present **only** in the geographic frame — the schema's `$note`
   * made structural, so a handler physically cannot narrate "north" about a
   * skeleton diagram.
   *
   * @param {number} _u0 @param {number} _v0 @param {number} _u1 @param {number} _v1
   * @returns {{cardinal: string, direction: string, vocabulary: string, degrees: number,
   *   frame: string, compass?: string}|null} null when the two points coincide.
   */
  bearingBetween(_u0, _v0, _u1, _v1) {
    return this.#requireOverride('bearingBetween', CAPABILITIES.PLACES);
  }

  /**
   * Distance from `(u, v)` to a named target, in this adapter's **natural**
   * unit — never `minutes` and never `blocks`. Walking time needs a speed
   * assumption and blocks need a street graph; both are `routing`/`graph`
   * properties, not geometry, and converting is the tool's job (and only legal
   * when the capability is declared). An adapter that guessed a walking speed
   * would report a fabricated unit as though it had measured one.
   *
   * @param {number} _u @param {number} _v
   * @param {string|Place|Region} _target
   * @returns {{value: number, units: string, frame: string, method: string, place?: Place}
   *   |Ambiguous|Unsupported|null}  null = the target has no geometry.
   */
  distanceTo(_u, _v, _target) {
    return this.#requireOverride('distanceTo', CAPABILITIES.PLACES);
  }

  /**
   * Direction from `(u, v)` to a named target. Same vocabulary rules as
   * {@link bearingBetween}, measured to the nearest point of the target's
   * geometry rather than to its centroid — an L-shaped region's centroid can sit
   * outside the region entirely.
   *
   * @param {number} _u @param {number} _v
   * @param {string|Place|Region} _target
   * @returns {{cardinal: string, direction: string, vocabulary: string, degrees: number,
   *   frame: string, compass?: string, method: string, place?: Place}
   *   |Ambiguous|Unsupported|null}
   */
  bearingTo(_u, _v, _target) {
    return this.#requireOverride('bearingTo', CAPABILITIES.PLACES);
  }

  /**
   * How close counts as "on or immediately beside" for `am_i_at`.
   *
   * Frame-dependent and therefore adapter-owned: the tool layer has no basis for
   * choosing 25 mm on a sheet or 400 m on a state map. The only one of these
   * methods that never returns `Unsupported` — an adapter that can resolve
   * places can always say what "beside" means in its own units, and returning
   * `Unsupported` would make a tool that *was* offered unanswerable.
   *
   * @returns {{value: number, units: string, frame: string}}
   */
  touchTolerance() {
    return { value: 0, units: this.frame === FRAMES.IMAGE ? 'material_mm' : 'metres', frame: this.frame };
  }

  /**
   * @param {Place|Node|{u:number,v:number}} _from
   * @param {Place|Node|{u:number,v:number}} _to
   * @param {RoutePrefs} [_prefs]
   * @returns {Route|Unsupported}
   */
  route(_from, _to, _prefs) {
    return this.#requireOverride('route', CAPABILITIES.ROUTING);
  }

  /**
   * Kerb / incline / surface / signal attributes of a segment or node.
   *
   * @param {Segment|Node} _segmentOrNode
   * @returns {SegmentAttrs|NodeAttrs|Unsupported}
   */
  attributes(_segmentOrNode) {
    return this.#requireOverride('attributes', CAPABILITIES.ACCESSIBILITY_ATTRS);
  }

  /**
   * @param {string} method
   * @param {string} capability
   * @param {*} [emptyValue] Returned instead of Unsupported where a bare empty
   *   result is the honest answer — `nearby()` on a world with no places is [].
   */
  #requireOverride(method, capability, emptyValue) {
    if (this.has(capability)) {
      throw new Error(
        `${this.constructor.name} declares "${capability}" but does not implement ${method}(). ` +
          'Either implement it or drop the capability — over-declaring offers the model a tool that cannot run.',
      );
    }
    if (emptyValue !== undefined) return emptyValue;
    return unsupported(`This map does not support ${method} (requires "${capability}").`, capability);
  }
}
