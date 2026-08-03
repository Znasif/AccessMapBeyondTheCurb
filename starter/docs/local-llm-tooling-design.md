# Local LLM Tooling for AccessMap Beyond the Curb

**Goal:** bring MapIO's conversational tool-calling into `starter`, running entirely on a local
Gemma stack (llama.cpp on an 8 GB M1), with prompt and tool-call caching handled by
EmbeddingGemma and FunctionGemma.

**Status:** design, revision 2. No implementation yet.

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

An A4 sheet at 2.5 mm gives ~108 × 76 ≈ 8,200 cells. Braille Doodle's 6.4 mm pitch dominates and
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

A `.camio` skeleton session declares `{places, regions}` and is offered 4 tools. An Audiom tier-C
session declares `{places, liveFeatureStream}` and is offered 3. A full OSM session gets all 12. The
schema block shrinks by construction, with no embedding call, no similarity threshold, and no
possibility of routing to a tool that cannot run.

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

**Escalation rule.** L2 emits only when its top logit margin clears a threshold *and* L1's top-1
place similarity exceeds ~0.55. Otherwise fall through to L3 with the full capability-filtered
schema set. Log every escalation — that log is your next training batch (§7.4).

### 4.2 Place resolution is not a tool

MapIO's `enable_points_of_interests` is called on **every question** — its prompt says
*"Everytime I ask a question, you MUST call enable_points_of_interest."* That is retrieval wearing a
tool-call costume, and it is the most frequent call in the system.

```
on window change:
    places ← adapter.places(window)
    embed(f"{name}. {category}. {context}") → EmbeddingGemma
    persist to IndexedDB, key = worldId + windowId

on utterance:
    top-k ← cosine(embed(utterance), places), k = 5
    highlight top-k on the surface
    inject top-k names as candidate places
```

Zero LLM tokens, and the same index resolves `place: STRING` for every tool. Ties within 0.02
cosine trigger a clarifying question rather than a guess.

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
of a window.

```bash
llama-server -hf ggml-org/gemma-4-E4B-it-GGUF --port 8081 \
  -c 16384 -fa on -ctk q8_0 -ctv q8_0 -ngl 99 --jinja \
  --cache-reuse 256 --slot-save-path ~/.cache/abtc-kv --parallel 1
```

On first entry to a window: prime, then `POST /slots/0?action=save` keyed on
`worldId + windowId + hash(capabilities, prefs)`. On re-entry: `action=restore`. A ~3 s prefill
becomes a ~50 ms disk read, and users revisit windows constantly.

**Do not trim from the middle of the history** — that invalidates the prefix from the deletion point
on. Cap turns from the tail, or keep a rolling summary.

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

Per (world, window), persisted to IndexedDB. Rebuild on window change; evict LRU past ~20. Worth
precomputing at build time for demo areas.

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

```bash
# L3 — reasoning + narration (text/vision/audio via mmproj)
llama-server -hf ggml-org/gemma-4-E4B-it-GGUF --port 8081 \
  -c 16384 -fa on -ctk q8_0 -ctv q8_0 -ngl 99 --jinja \
  --cache-reuse 256 --slot-save-path ~/.cache/abtc-kv --parallel 1

# L1 — retrieval, place resolution, plan cache
llama-server -m embeddinggemma-308m.gguf --port 8082 --embedding -c 2048

# L2 — tool-call formatting
llama-server -m functiongemma-270m-abtc.gguf --port 8083 -c 4096 --jinja
```

8 GB budget: E4B Q4 + mmproj ≈ 4.5 GB, EmbeddingGemma ≈ 0.3 GB, FunctionGemma ≈ 0.2 GB, 16 K KV at
q8 ≈ 0.8 GB → ≈ 5.8 GB. Fits, with little room for macOS. `--no-mmproj-offload` on the small models
if you hit swap. Reach the Mac over the existing SSH tunnel; Vite proxies `/llm/*` to
`127.0.0.1:11434`, so no CORS and no key in the browser.

**Use grammars, not hope.** Send `response_format: {"type":"json_schema", …}` or a raw GBNF
`grammar` for every tool call. Worth being precise: **GBNF guarantees the call is *valid*;
FunctionGemma improves the odds it's the *right* call.** Different problems; you want both.

### 8.1 Audio

Gemma 4 E4B accepts audio through the same `--mmproj` path as images, so it can replace a separate
STT service. For `starter`, start with the browser's Web Speech API — `TactileExplorerGeneric.jsx:38`
already uses `speechSynthesis`, the recognition side is symmetric, and it costs zero VRAM on a
machine that has none spare. Fall back to `Qwen3-ASR-0.6B` with a biasing list of in-window street
names only if Web Speech proves inadequate on proper nouns, which it may.

---

## 9. Build order

| # | Milestone | Gates |
|---|---|---|
| 1 | `Surface` abstraction — (u,v), acuityCell, aspect negotiation (§2) | — |
| 2 | `WorldAdapter` interface + capability negotiation (§3.4–3.5) | — |
| 3 | `LocalLLMClient` — streaming, GBNF, no tools | — |
| 4 | `OsmWorldAdapter` (places only, from the polygons file) | 2 |
| 5 | `AudiomWorldAdapter` tier A/C + persistent bounds cache | 2 |
| 6 | `CamioWorldAdapter` — template/colorMap/hotspots | 2 |
| 7 | `ToolRegistry` + dispatcher, tools 1–6 | 3, 4 |
| 8 | `PlaceIndex` — EmbeddingGemma + IndexedDB | 3 |
| 9 | `SemanticPlanCache` (§6.2) | 1, 8 |
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

**Place resolution is the accuracy ceiling.** If L1 picks the wrong Walgreens, every downstream tool
is confidently wrong. Instrument top-1/top-3 recall on ~200 hand-labelled utterances *before*
investing in FunctionGemma. L1 errors dominate L2 errors.

**Stale accessibility data is a safety issue.** OpenSidewalks curb and crossing attributes can be
years old. `get_crossing_info` must return provenance and age, and narration must hedge. Never let
the model state flatly that a crossing has a curb ramp.

**Prompt injection.** `name` and `opening_hours` come from OSM; Audiom feature names come from
arbitrary user-authored maps. Treat every place-derived string as untrusted data inside a delimited
block, never as instructions.
