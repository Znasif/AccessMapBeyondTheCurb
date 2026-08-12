# Local LLM Tooling for AccessMap Beyond the Curb

**Goal:** bring MapIO's conversational tool-calling into `starter`, running entirely on a local
Gemma stack (llama.cpp on an 8 GB M1), with prompt and tool-call caching handled by
EmbeddingGemma and FunctionGemma.

**Status:** revision 4. Milestones 1, 2, 3, 6, 8 implemented and tested; 5 partial (Tier A
reads done and live-verified, side-effect channel pending); the `simple_camio_llm` logic
port (plan milestone P) done. Live milestone table:
[`browser-voice-exploration-plan.md`](./browser-voice-exploration-plan.md) §5.

> **Revision 4 (2026-08-10) is an implementation update, not a redesign.** Six milestones
> landed as platform-free modules under `starter/src/lib/` with Node test suites
> (`starter/scripts/test_*.mjs`, ~600 checks total). Corrections forced by implementation,
> each fixed in place and marked ⚠️: the §3.5 tool counts (4 and 3 → **7**; the schema's
> capability tags are authoritative), §2.2's A4 figure (artwork area, not sheet), and a
> concrete confirmation that §6.4's base-rate rule must be re-derived per world — it
> **inverts** on the first real Audiom map. §8.0's thinking-disable rule is now enforced
> mechanically by the client rather than by discipline.

> **Revision 3 is the first one with measurements in it.** The stack now runs, and several rev-2
> numbers did not survive contact with it. Corrected in place, each marked ⚠️ with what was measured:
> the L1 escalation threshold (§4), candidate injection into L3 (§4.3), where the volatile prompt
> block may sit (§6.1), what a place document contains (§6.4), how the servers are actually launched
> (§8), and that the Web Speech recognition side is **not** local (§8.1). §11 is new: how to
> reproduce every number here.
>
> **Revision 2 changed the foundations.** Rev 1 assumed one route (Mapbox → 43×31 pin grid → WGS84
> → OpenSidewalks). That is one of at least three routes, and the pin grid is one of at least three
> surfaces. Sections 2 and 3 are new; §5 (tools) and §6 (caching) were rewritten to sit on top of
> them. If you read rev 1, reread from §2.

---

## 0. Reference points

| Source | What we take |
|---|---|
| `Coughlan-Lab/simple_camio@llm` (MapIO) | The tool-calling *concept*: 8 graph tools, an agentic loop, a prompt that turns a road network into text |
| `camio-explorer` | MediaPipe/homography refinements and `.camio` project compatibility |
| `starter` (this repo) | Everything else |

MapIO's tool layer: `src/llm/tool_calls.py` (schemas), `src/llm/prompt_formatter.py` (dispatch +
prompt assembly), `src/llm/llm.py` (the loop), `res/prompt_en.yaml` (instructions, few-shot).

---

## 1. Why this is a redesign, not a port

MapIO's tool signatures encode assumptions that are all false here.

**Coordinates.** MapIO works on a fixed cartesian plane in feet, and every tool takes explicit
`x`/`y` — `get_distance_to_point_of_interest(x, y, poi_index)`. Making a 270 M model copy
coordinates out of a prompt into a tool call is the highest-error-rate operation available. Every
tool in §5 takes **zero positional arguments**; the dispatcher injects position. This also merges
MapIO's two distance tools into one.

**Place identity.** `poi_index` is an integer into a hand-authored list that MapIO stuffs into the
system prompt. Here there is no fixed list, and in the Audiom route there may be no list we can
enumerate at all (§3.2). Tools take `place: STRING`, resolved by the adapter before dispatch.

**Prompt size.** MapIO serialises the *entire* road network into the system prompt
(`__nodes_prompt`, `__edges_prompt`, `__poi_prompt`, `__road_features_prompt`). For a real
neighbourhood that is tens of thousands of tokens. On 16 K context with 8 GB unified memory **this
is the actual bottleneck**, not tool schemas. Here the prompt carries a skeleton only; detail is
retrieved through tools.

**Instruction re-injection.** `LLM.ask` re-appends `get_instructions_prompt()` after every tool
round to fight instruction drift. With prefix caching (§6.1) that invalidates the KV cache every
round. Put instructions in the system prompt once and rely on `temperature = 0.0`, which MapIO
already sets.

---

## 2. Surfaces: the tactile output is not one thing

Three surface classes are live in this codebase or explicitly targeted, and they differ on every
axis that matters.

| Surface | Resolution | Aspect | Refreshable | Registration |
|---|---|---|---|---|
| Braille Doodle pin grid | 43 × 31 = 1,333 | 1.387 | Yes (redrawn) | Corner fractions from `brailledoodle_corners.json` |
| **APH Monarch** | **96 × 40 = 3,840** | **2.4** | Yes | Device-native |
| Pre-printed material | **none** — continuous | Arbitrary, whatever was printed | No | 4-corner dwell + AKAZE (`TactileExplorerGeneric`) |

`DEFAULT_COLS`/`DEFAULT_ROWS` in `pinGrid.js` are defaults, not constants — `AudiomTactileApp`
already passes `cols={cellsAcross} rows={rows}`. Rev 1's use of a pin cell index as a cache key was
wrong: it is device-dependent and simply absent for pre-printed material.

### 2.1 The universal coordinate is (u,v), not the pin

Every route already funnels through normalized `(u, v) ∈ [0,1]²` over the material — that is what
the 4-corner registration produces and what `uvToLngLat` / `uvToEastNorth` consume. Build everything
on `(u, v)` and the surface differences stop mattering.

### 2.2 Quantization: acuity, not hardware

Quantize `(u, v)` by **what a fingertip can distinguish**, not by what the device can render.
Two-point discrimination at the fingertip is roughly 2–3 mm. So:

```
cellSizeMm  = max(devicePinPitchMm ?? 0, 2.5)
acuityCols  = floor(materialWidthMm  / cellSizeMm)
acuityRows  = floor(materialHeightMm / cellSizeMm)
acuityCell  = floor(v * acuityRows) * acuityCols + floor(u * acuityCols)
```

An A4 sheet's printed artwork area (~270 × 190 mm — the four calibrated corners bound the
artwork, not the sheet edge, per `lib/geo.js#shrinkBboxToGrid`) at 2.5 mm gives
~108 × 76 ≈ 8,200 cells. Braille Doodle's 6.4 mm pitch dominates and
gives back its 1,333. Monarch's ~3.2 mm pitch gives 3,840. Pre-printed paper gets the acuity floor.
One formula, correct for all three, and it degrades to the device grid exactly when the device is
coarser than the finger — which is the behaviour you want.

### 2.3 Aspect ratio inverts for refreshable devices

`audiom.js` states the model plainly:

> *"The material is printed at the aspect ratio of the FULL map bbox, so every window keeps that
> same aspect and the four touched corners always map to the four bbox corners."*

That holds for paper, where you choose the print. It **fails for a refreshable display**, whose
aspect is fixed in hardware — Monarch is 2.4:1 and will never be anything else. There the causality
runs the other way: the *window* must be derived from the device aspect.

```
paper:       window aspect  → material aspect      (subWindow inherits from bboxFull)
refreshable: device aspect  → window aspect        (subWindow must letterbox or crop)
```

`AudiomTactileApp` already computes `aspectMismatch = materialAspect / aspect - 1` and displays it.
For refreshable surfaces that value must be **driven to zero by changing the window**, not reported.
Concretely, `subWindow` needs a variant that takes a target aspect and crops or pads the bbox to
match. Without it, a Monarch rendering of a 1.39:1 window is geometrically wrong everywhere, and
every `get_direction_to` answer is skewed.

This is a correctness bug waiting to happen, not a nicety.

---

## 3. Worlds: the data source is not one thing either

Three data regimes, with genuinely different capabilities.

### 3.1 OSM / OpenSidewalks route (`App.jsx`)

Frame: **geographic** (WGS84). Places from `resources/ca.sanfrancisco.graph.polygons.geojson`
(161,593 building polygons; 3,214 named, 366 with `opening_hours`, all with `ext:osm_id`), road
features from `queryRoadFeatures`, routing from AccessMap `shortest_path/custom.json` with
`uphill`/`downhill`/`avoidCurbs`/`streetAvoidance`.

Full capabilities. This is the only route that can support real street-by-street guidance.

> **Prerequisite.** The bundled GeoJSON is `graph.polygons` — buildings only. A local A* needs the
> OpenSidewalks *transportation* LineStrings (`footway=sidewalk|crossing`, `kerb`, `incline`,
> `surface`, `crossing:marked`, `tactile_warning`), which is not in `resources/`. And 209 MB of
> GeoJSON cannot be parsed in a browser tab — you need an offline step emitting per-quadkey graph
> chunks. Budget it as its own milestone; it gates the accessibility and navigation tools.

### 3.2 Audiom route (`AudiomTactileApp` / `AudiomMap` / `audiom.js`)

Frame: **geographic or ENU**. `audiom.js` is explicit that this route is "not beholden to OSM" —
`PREDEFINED_SOURCES` includes TDEI, IMDF, goodmaps, covid_daily, presidential_election, plus
arbitrary GeoJSON URLs, plus saved maps like embed 570 (a human skeleton, which has no lat/lng
meaning at all and needs `uvToEastNorth`).

The data lives **inside an iframe**. That is the central constraint, and it admits three acquisition
tiers with sharply different capabilities:

| Tier | When | How | Capabilities |
|---|---|---|---|
| **A. Direct fetch** | `sources` is a GeoJSON URL | Fetch the same URL the embed loads; build a real graph | Everything the geometry supports |
| **B. Known endpoint** | `sources` is a predefined id | Fetch TDEI / IMDF / GoodMaps directly | Varies by source |
| **C. Oracle probe** | opaque `/embed/d/<id>` or `/embed/<id>` | Black-box probing (below) | Describe-only. No graph, no routing |

Tier C already exists in `AudiomMap.jsx` and is cleverer than it looks. Bounds are found by binary
search: move the avatar, issue a perpendicular `executeCommand` probe, and see whether it moved —
because movement commands only work *inside* the map. Ten bisections per edge, four edges. The
comment notes it was verified on a geographic map, a spatial diagram and a heatmap, so it needs no
per-map knowledge.

And `featureEntered` / `featureSelected` stream `payload.features[].name` as the avatar moves. **That
is a free, continuous "what's here" feed** — on the Audiom route, `whats_here` should read the last
`featureEntered` payload and cost zero inference. Do not send that question to the LLM.

But tier C gives names and bounds and nothing else: no geometry, no adjacency, no attributes. You
cannot build a graph by crawling it in any reasonable time. **Prefer tier A wherever the source
permits it** — this is the single highest-leverage decision in the Audiom route, because it is the
difference between a describe-only assistant and a navigating one.

### 3.3 `.camio` route (`ProjectLoader` from `camio-explorer`)

Frame: **image** (template pixels). Assets are `data` (`ProjectData` from `@camio/common/project`),
`templateBase64`, `colorMapBase64`, `soundFilesBase64s`. Hotspots are colour-keyed regions in the
colour map; the colour is an identifier, not an appearance.

There is no network graph, so "routing" is meaningless. Adjacency, if needed, comes from colour-map
region adjacency (which regions share a border), which supports "what's next to this" but not
turn-by-turn anything. Distances are in millimetres on the material, not metres on the ground.

### 3.4 One model, three adapters

```
Place    { id, name, aliases[], category, geometry, props, provenance }
Segment  { id, fromNode, toNode, kind, attrs{incline,surface,width,…}, provenance }
Node     { id, position, kind, attrs{kerb, tactileWarning, signals} }
Region   { id, name, description, geometry, sound? }     ← .camio hotspots
```

```
interface WorldAdapter {
  frame: 'geographic' | 'enu' | 'image'
  capabilities: Set<Capability>
  resolvePlace(text): Place | Ambiguous | null
  at(u, v): { place?, segment?, node?, region? }
  nearby(u, v, radius): Place[]
  route(from, to, prefs): Route | Unsupported
  attributes(segmentOrNode): Attrs
}
```

Capabilities: `places`, `graph`, `routing`, `accessibilityAttrs`, `entrances`, `regions`,
`liveFeatureStream`.

### 3.5 Capability negotiation replaces semantic tool routing

The architecture review proposed EmbeddingGemma as a semantic router to shrink the tool schema
block. **Capability negotiation does that job better, deterministically, and for free.**

A `.camio` skeleton session declares `{places, regions}` and is offered ⚠️ **7** tools; an
Audiom tier-C session declares `{places, liveFeatureStream}` and is also offered **7** (rev 3
said 4 and 3 — wrong: per the schema's own capability tags, `{places}` alone admits
`whats_here` + five `places` tools + `route_to` narrowed to `fly_me_there`; implemented and
tested in `src/lib/toolFilter.js`). A full OSM session gets all 12. The schema block shrinks
by construction, with no embedding call, no similarity threshold, and no possibility of
routing to a tool that cannot run.

Semantic routing would have selected among tools that don't exist in the session. Capability
filtering is strictly better here. Keep EmbeddingGemma for place resolution and the plan cache
(§4.2, §6.2), which are jobs it is actually good at.

---

## 4. Architecture: four layers

Route each utterance down the cheapest layer that can handle it.

```
 utterance (Web Speech API, or Gemma 4 audio-in)
        │
 ┌──────▼──────────────────────────────────────────────┐
 │ L0  Deterministic            ~0 ms, no model        │
 │  wake/sleep/interrupt, "pause"/"resume",            │
 │  (u,v) → acuityCell → adapter.at(),                 │
 │  Audiom featureEntered passthrough                  │
 └──────┬──────────────────────────────────────────────┘
        │ miss
 ┌──────▼──────────────────────────────────────────────┐
 │ L1  EmbeddingGemma 308M      ~15 ms, ~200 MB        │
 │  semantic plan cache · place resolution · context   │
 └──────┬──────────────────────────────────────────────┘
        │ cache miss
 ┌──────▼──────────────────────────────────────────────┐
 │ L2  FunctionGemma 270M       ~80 ms, ~200 MB        │
 │  one tool call, from the capability-filtered set    │
 └──────┬──────────────────────────────────────────────┘
        │ declined / chain / narration needed
 ┌──────▼──────────────────────────────────────────────┐
 │ L3  Gemma 4 E4B              ~1–3 s                 │
 │  orchestration + natural-language answer            │
 └─────────────────────────────────────────────────────┘
        │
   speechSynthesis (browser, offline, 0 VRAM)
```

L1 never generates text. L2 never chains — FunctionGemma is documented as trained only on
single-turn and parallel calls. L3 is the only layer that speaks, and the only one that runs
MapIO's tool loop.

**Escalation rule.** L2 emits only when its top logit margin clears a threshold *and* L1's result is
unambiguous. Otherwise fall through to L3 with the full capability-filtered schema set. Log every
escalation — that log is your next training batch (§7.4).

> ⚠️ **Corrected in rev 3.** This rule originally read *"L1's top-1 place similarity exceeds ~0.55"*.
> That constant does not survive EmbeddingGemma's task prefixes, which improve ranking but compress
> absolute scores — correct matches land at **0.36–0.53**, so a 0.55 cutoff rejects nearly all of
> them. Use a scale-free **relative** margin instead:
>
> ```
> confident  ⇔  (top1 − top2) / top1  ≥  0.15
> ```
>
> Implemented as `MIN_RELATIVE_MARGIN` in `src/lib/placeIndex.js`. A low margin is **not** a
> retrieval failure — it usually means several candidates are equally valid, which is precisely the
> case that should reach L3 with all of them.

### 4.2 Place resolution is not a tool

MapIO's `enable_points_of_interests` is called on **every question** — its prompt says
*"Everytime I ask a question, you MUST call enable_points_of_interest."* That is retrieval wearing a
tool-call costume, and it is the most frequent call in the system.

```
on window change:
    places ← adapter.places(window)
    embed(document(place)) → EmbeddingGemma      # see §6.4 for what document() includes
    persist to IndexedDB, key = worldId + windowId

on utterance:
    top-k ← cosine(embed(utterance), places), k = 5
    highlight top-k on the surface
    inject top-k as ranked candidates            # names AND categories — see §4.3
```

Zero LLM tokens, and the same index resolves `place: STRING` for every tool.

**Measured (rev 3), 50 POIs of the `new_york` camio model:**

| | |
|---|---|
| full graph context, if sent to L3 | ~11,073 tokens — **exceeds the 8192 window** |
| full POI list | ~9,852 tokens |
| L1 top-5 candidates | **~27 tokens**, 12–120 ms |

MapIO's approach does not merely waste tokens on this hardware; it does not fit.

**Score this on recall@k, not top-1.** Measured recall@1 is 1/5 while recall@5 is 5/5, and that gap
is not a defect. For *"the Korean place"* the top five are BCD Tofu House, Gammeeok, Barn Joo 35,
Woorijip — all Korean. For *"I need an ATM"* they are five banks. Which of several equally-valid
candidates lands at rank 1 is arbitrary, so top-1 accuracy measures nothing useful here. **L1's job
is to cut context, not to decide.** L3 decides, from the whole top-k.

> ⚠️ The rev-2 line *"ties within 0.02 cosine trigger a clarifying question rather than a guess"* is
> retained as `TIE_EPSILON` but is **not** the primary signal, and 0.02 is too tight: two genuinely
> ambiguous queries measured at 0.018 (two Korean restaurants) and 0.032 (two banks), so it catches
> one and misses the other. 0.04 catches both. Left at 0.02 pending a decision — but note that
> asking a clarifying question is L3's call to make with the candidates in hand, not L1's to make
> from a scalar.

### 4.3 Injecting candidates into L3

The seam between L1 and L3 is worth more than it looks. Same model, same tools, same retrieval —
only the prompt text differs. Measured over five place-referring utterances (camio profile):

| variant | correct | mean |
|---|---|---|
| flat list: *"candidate places in the current window: [...]"* | 2/5 | 3.0 s |
| ranked, framed as the resolution of what the user just said | 3/5 | 2.0 s |
| \+ explicit `describe_surroundings` boundary | 4/5 | 2.1 s |
| \+ full category strings | 5/5 | 7.6 s |
| \+ at most 3 categories, deduped by namespace | **5/5** | **2.9 s** |

Three distinct failures, three distinct fixes:

1. **Framing.** A flat "places in the window" list reads as ambient scenery, which invites
   `describe_surroundings`. Presenting the same names as the *already-computed resolution of what
   the user just said* moved "the Korean place with tofu soup" from
   `describe_surroundings{restaurant}` to `get_place_details{BCD Tofu House}`.
2. **Tool boundary.** `describe_surroundings` is a strong attractor for anything vague. Naming when
   *not* to use it fixed "how far is the Irish pub".
3. **Evidence.** Bare names discard *why* L1 ranked something first. L3 cannot connect "the
   observation deck" to "Empire State Building" from the name alone, and correctly refuses to guess.
   Passing the category makes the link visible.

**Dedupe categories by namespace, do not take the first N.** The Empire State Building is tagged
`building.office, building.historic, heritage, tourism.attraction, office, building.tourism`. A naive
`slice(0,2)` spends the whole budget on `building.*` and drops `tourism.attraction`, the only tag
that links it to "the observation deck".

**Inject unconditionally; do not gate.** Six of the twelve tools take a `place` argument
(`get_place_details`, `am_i_at`, `get_distance_to`, `get_direction_to`, `find_accessible_entrance`,
`route_to`) and six do not. Measured over six utterances whose correct tool takes no place —
`whats_here`, `get_segment_accessibility`, `get_crossing_info`, `stop_navigation`,
`set_route_preferences`, and a bare greeting — the candidate block is **inert**: 6/6 correct and
**zero** place-tool false positives both with and without it. A semantic gate would save ~80 tokens
and add a branch that can be wrong. The set of place-taking tools is derivable from the schema
(`'place' in parameters.properties`) — see `placeTakingTools()`, never hand-list it.

Implemented in `src/lib/candidateContext.js`.

---

## 5. The tool set

Twelve tools, each tagged with the capability that must be present for it to be offered.

### 5.1 Design rules

1. **No coordinate arguments.** Dispatcher injects `(u,v)`, window, and prefs.
2. **Names, not indices.**
3. **Window-scoped.** Nothing outside the active window is addressable.
4. **Capability-gated.** A tool absent from the session never enters the prompt.
5. **Frame-aware results.** Distance and direction mean different things per frame (§5.4).
6. **Side-effecting tools return a confirmation string** to narrate, per MapIO's
   `"Navigation mode is now enabled."` convention.
7. **Enriched descriptions.** At 270 M, semantic keywords in the description carry most of the
   routing signal, so every description deliberately contains the qualitative words users say.

### 5.2 The tools

| Tool | Requires | MapIO ancestor |
|---|---|---|
| `whats_here` | — | *(position prompt)* |
| `describe_surroundings` | `places` | `get_nearby_points_of_interest` |
| `get_place_details` | `places` | `get_point_of_interest_details` |
| `am_i_at` | `places` | `am_i_at_point_of_interest` |
| `get_distance_to` | `places` | `get_distance` + `get_distance_to_point_of_interest` |
| `get_direction_to` | `places` | *(new)* |
| `get_crossing_info` | `accessibilityAttrs` | *("is there a walklight here")* |
| `get_segment_accessibility` | `accessibilityAttrs` | *("are there roadworks")* |
| `find_accessible_entrance` | `entrances` | *(new)* |
| `route_to` | `routing` \| `places` | `guide_to_*`, merged |
| `set_route_preferences` | `routing` | *(new)* |
| `stop_navigation` | `routing` | keyboard-only in MapIO |

`route_to` is the interesting case: `mode: "fly_me_there"` needs only `places` (guide the finger to
a point), while `mode: "street_by_street"` needs `routing`. In a `.camio` or Audiom tier-C session
the tool is still offered with the enum narrowed to `fly_me_there`. **Narrow the enum, don't drop
the tool** — a model that can't offer guidance at all is much worse than one that offers the
weaker mode.

MapIO's guide/navigate distinction is worth preserving verbatim because it is a real accessibility
affordance. Its prompt teaches that *"guide me"* → fly-me-there and *"navigate me"* →
street-by-street. Don't teach that in a prompt; put it in the training set (§7.2).

`set_route_preferences` is new and probably the highest-value tool here: *"I can't do steep hills"*
becomes `maxUphill: 5` and changes every subsequent route. MapIO has no analogue because MapIO
isn't wheelchair-aware.

### 5.3 Deliberately excluded

- **`focus_map`.** Silently changing what is under a blind user's fingers mid-exploration is
  disorienting. If added, gate behind spoken confirmation and an audio cue. Note this is *more*
  dangerous on refreshable surfaces, where the change is instantaneous and silent.
- **`enable_points_of_interests`.** Replaced by §4.2.
- **`get_distance` with two arbitrary endpoints.** Nobody asks the distance between two points that
  are both not them.

### 5.4 Frame-dependent semantics

The same tool must answer differently per frame. This lives in the adapter, not the prompt.

| | `geographic` | `enu` | `image` |
|---|---|---|---|
| `get_distance_to` | metres / feet / **minutes walking** (default) | metres | **millimetres on the material** |
| `get_direction_to` | compass + clock-face | clock-face only | clock-face only |
| `get_crossing_info` | real | absent | absent |
| `route_to` | both modes | `fly_me_there` | `fly_me_there` |

Saying "north" about a human skeleton is a bug. So is answering "12 minutes' walk" about a diagram.
Units and reference frame must ride along in the tool *result*, so L3 narrates what it was given
rather than what it assumes.

Full machine-readable schemas: [`llm-tools.schema.json`](./llm-tools.schema.json).

### 5.5 FunctionGemma control-token form

llama.cpp's `tools` parameter (with `--jinja`) takes the JSON Schema directly for L3. L2 needs the
control-token form:

```
<start_of_turn>developer
You are a model that can do function calling with the following functions<start_function_declaration>declaration:route_to{description:<escape>Start guiding the user to a place. Use for any request to go, walk, get to, head to, find the way to, take me to, or navigate to somewhere.<escape>,parameters:{properties:{place:{description:<escape>Name of the destination<escape>,type:<escape>STRING<escape>},mode:{description:<escape>street_by_street for turn-by-turn walking directions; fly_me_there to help locate the place on the tactile material with a finger<escape>,enum:[<escape>street_by_street<escape>,<escape>fly_me_there<escape>],type:<escape>STRING<escape>}},required:[<escape>place<escape>,<escape>mode<escape>],type:<escape>OBJECT<escape>}}<end_function_declaration><end_of_turn>
<start_of_turn>user
navigate me to the pharmacy on divisadero<end_of_turn>
<start_function_call>call:route_to{place:<escape>Walgreens Divisadero Street<escape>,mode:<escape>street_by_street<escape>}<end_function_call>
```

`place` is the **resolved** name from L1, not the user's phrasing — L1 matches, L2 only formats.
`mode` is inferred from the verb, which is exactly what must come from data rather than a prompt.

---

## 6. Caching

Three tiers. Only the first is llama.cpp's job.

### 6.1 KV prefix cache — llama.cpp native

System prompt + capability-filtered tool schemas + window place skeleton are static for the lifetime
of a window. Together that is ~1,690 tokens on the camio profile — the prefix worth protecting.

Serving flags: see §8 (the three-process form this section used to show is obsolete).

On first entry to a window: prime, then `POST /slots/0?action=save` keyed on
`worldId + windowId + hash(capabilities, prefs)`. On re-entry: `action=restore`. A ~3 s prefill
becomes a ~50 ms disk read, and users revisit windows constantly.

**Do not trim from the middle of the history** — that invalidates the prefix from the deletion point
on. Cap turns from the tail, or keep a rolling summary.

**Anything that varies per utterance goes AFTER everything that does not.** This is the single
highest-leverage rule in the document and it is easy to violate by accident. The §4.3 candidate block
changes every turn; putting it in the system message invalidates the system prompt *and* all twelve
tool schemas behind it. Measured over five utterances:

| candidate block placement | KV cache reuse | mean latency |
|---|---|---|
| inside the system message | **0%** | 11.8 s |
| in the user turn | **95%** | **5.7 s** |

Identical tokens, identical tools, identical accuracy. **2× latency purely from message placement.**

The catch: moving it out of the system message initially cost accuracy (5/5 → 3/5), because in the
user turn the list reads as if the *user* supplied it and loses instructional authority. Two changes
recovered it — state in the system prompt that the ranking is authoritative and pre-computed, and
tell the model not to ask which place was meant when a candidate plausibly matches. See
`buildSystemPrompt` / `buildUserTurn` in `src/lib/candidateContext.js`; the split between them is
exactly this stable/volatile boundary.

### 6.2 Semantic plan cache — EmbeddingGemma

Cache the *plan*, not the answer.

```
key   = (int8(embed(utterance)), acuityCell, worldId, windowId)
hit   = cosine ≥ 0.93  AND  same acuityCell  AND  same world+window
value = [{ tool, args }, …]
```

`acuityCell` (§2.2) is what makes this device-independent — the same key works on Braille Doodle,
Monarch, and paper, and it correctly misses when the finger moves far enough for a human to notice.
`windowId` must be in the key because `subWindow` changes what every question means.

A hit skips both L2 and L3's planning pass. Exploration is extremely repetitive — sweeping a finger
while asking "what's this" over and over — so this is where most of the latency win lives.

Cache plans only, never narration. Stale narration is an accessibility hazard.

### 6.3 Tool result memoization

| Tool | Key | TTL |
|---|---|---|
| `get_place_details` | place id | session; recompute open/closed against the clock |
| `get_crossing_info`, `get_segment_accessibility` | segment id | session |
| `get_distance_to`, `get_direction_to` | (acuityCell, place id, windowId) | session |
| `describe_surroundings` | (acuityCell, radius, windowId) | session |
| `route_to` | (acuityCell, place id, prefs hash) | session |
| `find_accessible_entrance` | `ext:osm_id` | persistent — YOLO is expensive |
| Audiom tier-C bounds | embed/map id | **persistent** — ~40 probes at ~400 ms each |

That last row matters: bounds discovery is ~15–20 s of probing per map. Cache it forever.

### 6.4 Place embedding index

**Implemented** — `src/lib/placeIndex.js` (milestone 8).

Per (world, window), persisted to IndexedDB. Rebuild on window change; evict LRU past ~20. Worth
precomputing at build time for demo areas.

Implementation notes worth keeping:

- Vectors persist as **one flat `Float32Array`**, not N small arrays. Structured-clone handles typed
  arrays natively and one 768×N buffer is far cheaper to store and reload.
- `RECORD_VERSION` gates reuse. Change the embedded document text and you **must** bump it: a store
  holding two encodings ranks badly rather than failing loudly, which is far worse than a rebuild.
- In-flight builds are deduped, so a burst of window changes embeds once.
- The storage layer is injectable (`MemoryStore` / `IndexedDBStore`) so retrieval is testable in
  Node, which has no IndexedDB.

**Use EmbeddingGemma's task prefixes.** They are not cosmetic. Query
`task: search result | query: {text}`, document `title: {name} | text: {text}`. Measured on
"the Korean place" against four POIs:

| | top-1 | top-2 | margin | margin/top-1 |
|---|---|---|---|---|
| bare strings | 0.640 | 0.461 | 0.179 | 28% |
| prefixed | 0.416 | 0.215 | 0.201 | **48%** |

Nearly double the relative separation — but note the absolute compression, which is what invalidated
the §4 threshold.

#### What goes in a place document

⚠️ **Rev 2 said `f"{name}. {category}. {context}"`. That throws away most of the data.** Every POI in
the camio `new_york` model also carries `location_description` (50/50), `accessibility` (50/50),
`opening_hours`, `building`, `coords` and `edge`. Measured precision@5 against the structured fields
with the richer document:

| query | correct | base rate | lift |
|---|---|---|---|
| "somewhere with tactile paving" | 2/5 | 4% | **10.0×** |
| "a place with an elevator" | 3/5 | 6% | **10.0×** |
| "what is on 5th Avenue" | 5/5 | 12% | 8.3× |
| "somewhere wheelchair accessible" | 5/5 | 46% | 2.2× |

The first two rows are the proof that this is retrieval and not recall of a prior: only **two** POIs
in the model have tactile paving and only **three** have an elevator, and the queries surface all of
them at the top. That fact exists nowhere except the document text.

The last row is the counter-lesson: **do not embed near-universal attributes.** `wheelchair_accessible`
is true for 24/50 POIs, so the query barely beats chance while costing tokens and diluting the vector.
Roughly a third base rate is the point where an attribute stops earning its place.

Include `accessibility` on principle as well as measurement — this is a tactile map for blind users,
and the Empire State Building's record literally reads *"tactile map: near the entrance, following
the tactile paving"*. That is exactly what someone needs to be able to ask for.

#### The embedding does not override the map data

A reasonable worry is that EmbeddingGemma's world knowledge dominates the local tags. Tested
adversarially by mislabelling two POIs — Starbucks tagged `financial.bank, atm`, and Cooper Electric
(an electrical supplier) tagged `cafe.coffee`:

```
"where can I get coffee"  → Cooper Electric 0.451 | Blank Slate 0.379 | Starbucks 0.332
"I need an ATM"           → Starbucks 0.331 | Cooper Electric 0.056 | Blank Slate -0.003
```

The tags win in both directions. The consequence cuts the other way too: **bad tags produce
confidently wrong retrieval with no sanity check.** Data quality flows straight through.

#### `coords` and `edge` are deliberately excluded — do not add them

Geometry is not this layer's job, and cosine similarity cannot represent distance:

```
L1          resolves the NAME       "the Korean place" → BCD Tofu House
dispatcher  supplies the POSITION   injectedContext.uv — never from the model
tool        computes the GEOMETRY   get_distance_to, get_direction_to,
                                    describe_surroundings, whats_here
```

`describe_surroundings` takes only `radius` and `category` and is answered from `uv` against the
graph. `whats_here` takes no arguments at all and is answered at L0 from the last `featureEntered`
payload. Re-ranking this index by proximity would duplicate the adapter inside a structure that
cannot express what it needs.

One caveat on the enriched document: `location_description` is spatial **prose** (*"between the
intersection with West 33rd Street and ..."*), which makes queries like "between 33rd and 34th" rank
well. That is legitimate as *name resolution* — the user is describing which place they mean. It must
never be the source of an actual distance or bearing.

---

## 7. FunctionGemma training data

### 7.1 Composition

Target **~3,000 examples**.

| Slice | Share | Why |
|---|---|---|
| Positive, single-call | 45% | ~110 per tool |
| **Negative — no call** | **35%** | The dominant failure mode |
| Parallel (2 calls) | 10% | Natively supported |
| Chains | 10% | Not supported out of the box — §7.3 |

**Negatives matter more than positives.** A 270 M model with tools in context fires on almost
anything. Include chit-chat, meta-questions ("what can you do"), conversational follow-ups ("say
that again", "slower"), and questions that *sound* spatial but are answerable from context already
in the prompt ("was that north or south?"). Label: empty call block.

### 7.2 Axes of variation

1. **Verb → mode.** *guide / show / help me find / where is* → `fly_me_there`.
   *navigate / take me / walk me / directions to / how do I get* → `street_by_street`. Include
   genuinely ambiguous cases whose label is a clarifying no-call.
2. **Place phrasing.** "the Walgreens", "that pharmacy", "the drug store on the corner". The label
   is always the canonical name from L1 — you are training a formatter, not a search engine.
3. **ASR noise.** Input is a transcript. Inject Web Speech API errors: dropped articles, no
   punctuation, homophones ("Divisadero" → "divisidero", "diva sedaro"), all lowercase.
4. **Disfluency.** "what— what is this here", "and, uh, this one?". Hand-write ~20 seeds per tool,
   paraphrase ×25 with Gemma 4 locally.
5. **Preference utterances.** "I can't do steep hills" → `max_uphill: 5`; "avoid curbs" →
   `avoid_curbs: true`; "stay off busy streets" → `street_avoidance: 1.0`.
6. **Accessibility vocabulary.** "is it safe to cross", "does this corner have a ramp", "is there a
   beeping signal" must all reach `get_crossing_info`.
7. **Frame-neutral phrasing.** Include diagram and `.camio` sessions: "what's this bone", "what's
   next to it", "how far across is it". The same tools must fire with different capability sets in
   context — train with the filtered schema block, not the full one, or L2 learns to expect tools
   that won't be there.

### 7.3 Chains

FunctionGemma is documented as untrained on multi-step.

- **Recommended:** L2 never chains; escalate to L3. Simpler, and L3 is already loaded.
- **Optional:** fine-tune on the closed set that actually occurs — realistically about six:
  nearest-X-then-route, details-then-route, surroundings-then-details, crossing-then-route,
  distance-then-direction, preferences-then-reroute.

### 7.4 Evaluation and the loop

Hold out **whole paraphrase clusters**, not random rows — random splits leak the seed and inflate
accuracy 10–15 points. Report three numbers separately:

- Tool-selection accuracy on positives
- **False-positive rate on negatives** ← the one that matters
- Argument exact-match on correctly-selected tools

Then close the loop: every L2 → L3 escalation is logged with the utterance and the call L3 made.
That log is the next training batch, from real usage. Retrain monthly.

### 7.5 Mechanics

LoRA on a free Colab T4, ~30 min at 270 M, then llama.cpp's own `convert_hf_to_gguf.py` and
`llama-quantize` — no new tooling.

**Easy to get wrong:** tool `description` strings in training must be **byte-identical** to those
served at inference. Enriched descriptions carry most of the semantic lift at this size; editing one
after training silently degrades routing.

---

## 8. Serving

⚠️ **Rev 2 showed three `llama-server` processes on ports 8081–8083. That is obsolete.** Current
llama.cpp has a **router mode**: one process, one port, tiers selected by the OpenAI `model` field,
loaded on demand and slept when idle. That is what makes the budget work on 8 GB.

Config lives in `~/.config/abtc/models.ini` (INI keys are llama.cpp long options minus the `--`):

```ini
[l3]
hf-repo           = unsloth/gemma-4-e4b-it-qat-GGUF:UD-Q4_K_XL
ctx-size          = 8192
flash-attn        = on
cache-type-k      = q8_0
cache-type-v      = q8_0
gpu-layers        = 99
parallel          = 1
cache-reuse       = 256
slot-save-path    = /Users/<you>/.cache/abtc-kv
no-mmproj-offload = true

[l1]
hf-repo   = ggml-org/embeddinggemma-300M-GGUF   # capital M; lowercase 307-redirects
ctx-size  = 2048
embedding = true
```

Launched by `~/.local/bin/start-ai`, which router-mounts both tiers:

```bash
llama serve --models-preset ~/.config/abtc/models.ini \
  --models-max 2 --models-autoload --sleep-idle-seconds 600 \
  --host 127.0.0.1 --port 8081
```

**Budget, measured on an 8 GB M1 (6144 MiB Metal working set):**

| | |
|---|---|
| E4B QAT Q4_K_XL | 3.93 GiB |
| mmproj BF16 | 0.92 GiB — kept off the GPU by `no-mmproj-offload` |
| KV, 8192 @ q8 | ~0.40 GiB |
| cold load → first token | 10.8 s |
| steady-state generation | **16 tok/s** |

**`ctx-size = 8192` is a ceiling, not a tuning choice — do not raise it to fit a bigger prompt.**
The full MapIO-style prompt for the `new_york` model is ~11,073 tokens (§4.2), and the tempting
fix — a 16 K window, which the old three-process setup guide actually shipped — does not work on
this machine. The whole machine has 8 GB unified memory, of which macOS keeps ~2 GB and Metal
grants a ~6 GiB working set. The model alone is 3.93 GiB, and q8 KV scales linearly with context:
~0.40 GiB at 8192 becomes ~0.8 GiB at 16384, and compute buffers grow with it — past the working
set and into swap, alongside the L1 tier that must stay resident for retrieval. Even if it fit, an
~11 K-token prefill at M1 speeds costs tens of seconds before the first token on every cold window.
This constraint is not an inconvenience to engineer around; it is **why the L1 → L3 architecture
exists**: EmbeddingGemma curates ~27 tokens of ranked candidates (§4.2) precisely because the full
context can never be sent. Any experiment that "temporarily" serializes the whole graph into the
prompt — including MapIO parity testing — is measuring a configuration this hardware cannot run.

`--models-max 2` caps residency; `--sleep-idle-seconds` releases it. L2 is deliberately absent from
the INI until milestone 14 — the router pages it in on demand rather than holding it resident.

**Bind loopback, tunnel in.** The server sets CORS `*` and has no API key, and says so on startup.
`ssh -L 8081:127.0.0.1:8081 <mac>`; Vite proxies `/llm` → `127.0.0.1:8081` (one target, not three).

**Use grammars, not hope.** Send `response_format: {"type":"json_schema", …}` or a raw GBNF
`grammar` for every tool call. Worth being precise: **GBNF guarantees the call is *valid*;
FunctionGemma improves the odds it's the *right* call.** Different problems; you want both.

### 8.0 Reasoning must be disabled, and `reasoning_budget` will not do it

Gemma 4 emits chain-of-thought by default. With `tools` in the payload this is **fatal, not merely
slow** — the CoT consumes the whole token budget and no call is ever emitted. Measured on "Tell me
about Cafe China" with the full 12-tool schema:

| request field | tokens | finish_reason | tool call |
|---|---|---|---|
| `reasoning_budget: 0` | 256 | `length` | **none** |
| `chat_template_kwargs: {"enable_thinking": false}` | **18** | `tool_calls` | correct |
| (reasoning on, 768 max) | 495 | `tool_calls` | correct |

**`reasoning_budget` is silently ignored once `tools` is present.** It works fine without tools,
which is exactly how you get fooled. Always send `chat_template_kwargs: {"enable_thinking": false}`
for tool-calling turns. Leaving reasoning on costs ~27× the tokens — at 16 tok/s that is ~31 s
against a 1–3 s target. *(Rev 4: `src/lib/localLLM.js#chatCompletion` now injects this
automatically whenever `tools` is present, and callers cannot override it — enforced by
`test_tool_loop.mjs`.)*

### 8.1 Audio

⚠️ **Rev 2 said to start with the browser's Web Speech API because "the recognition side is
symmetric" with `speechSynthesis`. That is wrong and it breaks the local-only premise.**
`speechSynthesis` (TTS) runs on-device; `SpeechRecognition` (STT) ships audio to Google's or Apple's
servers. They are not symmetric.

Use the mmproj instead — it is already downloaded and it carries **both** encoders:

```
clip.has_audio_encoder     clip.has_vision_encoder
clip.audio.num_mel_bins    clip.vision.image_size
```

So audio-in costs no extra model, only the 0.92 GiB projector already budgeted in §8, and it stays
local. Verified loading: llama.cpp reports `init_audio: audio input is in experimental stage and may
may have reduced quality` — so **validate transcription on street names before committing**; proper
nouns are exactly the weakness. `Qwen3-ASR-0.6B` with an in-window biasing list remains the fallback,
but it costs memory this machine does not have spare.

---

## 9. Build order

| # | Milestone | Gates | Status |
|---|---|---|---|
| 1 | `Surface` abstraction — (u,v), acuityCell, aspect negotiation (§2) | — | **done** rev 4 — `src/lib/surface.js` (126 checks) |
| 2 | `WorldAdapter` interface + capability negotiation (§3.4–3.5) | — | **done** rev 4 — `src/lib/worldAdapter.js` + `src/lib/toolFilter.js` |
| 3 | `LocalLLMClient` — streaming, GBNF, no tools | — | **done** rev 4 — `chatCompletion` + `src/lib/toolLoop.js`; GBNF rides llama.cpp's own tools path; transport injectable for the wllama backend |
| 4 | `OsmWorldAdapter` (places only, from the polygons file) | 2 | |
| 5 | `AudiomWorldAdapter` tier A/C + persistent bounds cache | 2 | **partial** rev 4 — Tier A done (`src/lib/adapters/audiomWorldAdapter.js`, live-verified on map 885); side-effect channel + tier-C probe migration pending |
| 6 | `CamioWorldAdapter` — template/colorMap/hotspots | 2 | **done** rev 4 — `src/lib/adapters/camioWorldAdapter.js` (79 checks) |
| 7 | `ToolRegistry` + dispatcher, tools 1–6 | 3, 4 | |
| 8 | `PlaceIndex` — EmbeddingGemma + IndexedDB | 3 | **done** — `src/lib/placeIndex.js`, `src/lib/candidateContext.js` |
| 9 | `SemanticPlanCache` (§6.2) | 1, 8 | |
| 10 | OpenSidewalks tiling pipeline | — |
| 11 | Accessibility tools 7–9 | 10 |
| 12 | `RouteProvider` — AccessMap impl (exists), then local A* | 10 |
| 13 | Nav tools 10–12 | 12 |
| 14 | FunctionGemma dataset + LoRA + L2 fast path | 7, 8 |
| 15 | KV slot save/restore | 7 |

Milestones 1–9 give a working conversational explorer across **all three worlds** on data you
already have. Everything after that is the sidewalk graph.

Note the reordering from rev 1: the surface and world abstractions now come first. Building tools
against Mapbox and retrofitting Audiom and `.camio` later would bake WGS84 and pin grids into
signatures that then have to be unpicked.

---

## 10. Open risks

**Latency.** L3 at ~1–3 s is slow for a finger sweeping a map. The plan cache hides repeats but not
first-ask. Mitigate with an immediate non-LLM earcon (already in `TactileExplorerGeneric.jsx`) and
streamed TTS that starts on the first sentence.

**Aspect mismatch on refreshable surfaces** (§2.3) is a silent geometric error, not a warning. Fix
before Monarch support, not after.

**The 209 MB problem.** Nothing sidewalk-related works in-browser until the tiling pipeline exists.
Start it early despite being unglamorous.

**Audiom tier C is a capability cliff.** An opaque saved map yields names and bounds and nothing
else. Be explicit in the UI about which tier a session is in — a user who gets routing on one map
and not another, with no explanation, will reasonably conclude the app is broken.

**Place resolution is the accuracy ceiling — but measure it as recall@k.** If L1 drops the right
Walgreens out of the top-k entirely, every downstream tool is confidently wrong. Instrument
**recall@5** on ~200 hand-labelled utterances *before* investing in FunctionGemma. Do **not**
instrument top-1: rev-3 measurements put recall@1 at 1/5 and recall@5 at 5/5 on the same queries,
because several candidates are routinely equally valid (five banks for "I need an ATM").

⚠️ **Revised: on current evidence L3 errors dominate L1 errors, not the reverse.** End-to-end, L1
returned a correct candidate set every time; the failures were all L3 mishandling it — see §4.3. The
rev-2 claim that "L1 errors dominate L2 errors" is untested and should not be relied on.

**Everything measured in rev 3 rests on 5–11 cases.** Enough to establish direction and to kill the
gating idea; nowhere near enough to call any constant settled. The 21-case `eval_dataset.json` has
not yet been run through the §4.3 prompt path — `eval_tools.py` still uses its own flat system
prompt, so the two harnesses currently measure different things. Reconcile them before trusting any
number here as a baseline.

**Enrichment is validated on camio only.** `fromCamioPoi()` is shaped to that source. The OSM and
Audiom adapters expose different fields, and the base-rate rule from §6.4 (drop attributes held by
more than roughly a third of places) must be re-derived per world, not copied. *(Rev 4 confirmed
this in the extreme: on Audiom map 885 the only classification props — `ruleName`, `briefing` —
sit on ~100% of features, so the camio cutoff would discard that world's entire signal. The rule
doesn't just need retuning there; it inverts.)*

**Stale accessibility data is a safety issue.** OpenSidewalks curb and crossing attributes can be
years old. `get_crossing_info` must return provenance and age, and narration must hedge. Never let
the model state flatly that a crossing has a curb ramp.

**Prompt injection.** `name` and `opening_hours` come from OSM; Audiom feature names come from
arbitrary user-authored maps. Treat every place-derived string as untrusted data inside a delimited
block, never as instructions.

---

## 11. How to reproduce every number in this document

Everything below runs against the local stack with no API keys, no camera, and no cloud.

### 11.1 Prerequisites

```bash
start-ai                       # router on 127.0.0.1:8081 (or the LaunchDaemon is already serving)
curl -s http://127.0.0.1:8081/v1/models | python3 -m json.tool
```

Expect `l1` and `l3`, plus one auto-discovered entry per cached HuggingFace repo — four rows in
total is normal, not a misconfiguration.

**Never send a chat completion to `l1`.** It is embeddings-only and returns `the current context
does not logits computation. skipping`. That error — including when it appears in llama.cpp's own
WebUI, whose model picker defaults to the alphabetically first entry — always means the wrong tier
was selected, never a broken server. For the same reason, any harness that auto-selects
`models[0]` will pick `l1` and fail every case; `eval_tools.py` defaults to `l3` and refuses an
embeddings tier outright.

From another machine, forward first and point the tools at the tunnel:

```bash
ssh -L 8081:127.0.0.1:8081 <mac>
```

### 11.2 The checks

| what it proves | command |
|---|---|
| §6.4 index build, recall@k, LRU eviction | `node starter/scripts/test_place_index.mjs` |
| §4.3 end-to-end L1 → candidates → L3 tool call | `node starter/scripts/test_candidate_prompt.mjs` |
| §5 tool selection over the full dataset | `python3 starter/scripts/eval_tools.py --simulate-loop` |

Both `.mjs` scripts exit non-zero on regression and take `VITE_LLM_BASE` to retarget the server.
`test_candidate_prompt.mjs` marks one case `HARD` and excludes it from the gate — "am I at the
observation deck", where the linking tag is absent from the record and E4B declines rather than
guesses. It passes only with the candidate block in the system message, at 5.6× the latency (§6.1).

### 11.3 Checking the serving assumptions

```bash
# §8 memory: what Metal will actually give you
llama serve --list-devices
llama fit-params -hf unsloth/gemma-4-e4b-it-qat-GGUF:UD-Q4_K_XL -c 8192

# §8.1 the mmproj really does carry an audio encoder
head -c 3000000 ~/.cache/huggingface/hub/models--unsloth--gemma-4-e4b-it-qat-GGUF/snapshots/*/mmproj-BF16.gguf \
  | strings | grep -iE 'clip.has_(audio|vision)_encoder'
```

### 11.4 Re-deriving the tuning constants

These are the numbers most likely to be wrong on a different model, quantisation, or world. Each is
a small script against `/v1/embeddings` and `/v1/chat/completions`:

- **§4 relative-margin threshold** — embed a labelled query set, histogram `(top1−top2)/top1` for
  correct vs incorrect top-1, pick the separating value. Do not reuse 0.15 blindly.
- **§6.4 base-rate cutoff** — for each candidate attribute, compute its prevalence and its
  precision@5 lift. Drop anything whose lift approaches 1.0; on the camio model that was everything
  above roughly a third prevalence.
- **§6.1 placement** — send the same five utterances with the volatile block in the system message
  and then in the user turn, and read `usage.prompt_tokens_details.cached_tokens` from each response.
  0% versus ~95% is unmissable.
- **§4.3 prompt variants** — A/B the system prompt across a fixed case set, reporting both accuracy
  and mean latency. A variant that wins on accuracy and loses 3× on latency is not a win.

### 11.5 Cross-checking against MapIO

MapIO's real tool schemas can be extracted **without** installing `openai`, without `.env`, and
without a camera — they are literal expression trees in `simple_camio@llm:src/llm/tool_calls.py`.
Parse them with `ast`, resolving the `ToolCall` StrEnum members and the `Graph.NEARBY_THRESHOLD`
f-string interpolation from `src/graph/graph.py`. Serving those 8 schemas to `l3` scored 4/4 on
name→index resolution, which is a useful sanity check that the local model is not the weak link.

Note that MapIO's tools take `poi_index` and raw `x`/`y`, where this design passes resolved names
(§4.2). The local model handles both, so that is a free design choice rather than a constraint.
