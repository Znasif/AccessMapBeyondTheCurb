# Browser Voice-Driven Exploration — Build Plan

**Status:** proposal, rev 2
**Supersedes:** nothing. **Inherits from:** [`local-llm-tooling-design.md`](./local-llm-tooling-design.md) (rev 3) and [`llm-tools.schema.json`](./llm-tools.schema.json) (v0.2.0)

> **Rev 2.** Every code citation in rev 1 survived verification (line numbers exact); several
> numbers and two conclusions did not. Corrected in place, each marked ⚠️: the milestone count
> (1 done, not 3), the port size (~2,600 lines, not ~2,000), the E4B budget (~5 GB, not 4.2),
> the browser-STT recommendation (**inverted** — Chrome now has on-device recognition and
> Safari does not), and the wllama KV claim (configuration survives in v3, imperative control
> does not). One structural change: the LLM runtime is now a **seam with two backends**
> (§1.1) — the critical path no longer runs through the wllama migration, and 5c is ungated
> from the full speech milestone (§5).

This is an execution plan, not a redesign. The architecture, the tool set and the layer
model were settled in the tooling design doc; its §9 build order stands at ⚠️ **one of 15
milestones done and one partial** (M8 done; M3 embeddings only). What was missing was
three things this plan supplies:

1. a browser runtime that can actually serve L1/L3 with tool calls,
2. a decision about where the ⚠️ ~7,000 lines of working logic in
   `explore/simple_camio_llm` (excluding the vendored speech tree) go, and
3. a concrete data path from Audiom and `.camio` into the `WorldAdapter` interface.

The user-facing goal: **a voice-driven tactile exploration session in a browser tab, with
no installation, where the model calls Audiom's own functionality and reads Audiom or
`.camio` data directly.**

---

## 0. Three findings that shape the plan

### 0.1 llama.cpp is the browser runtime, not transformers.js

`ggml/src/ggml-webgpu/` is released and ⚠️ no longer experimental — a first-class backend
in llama.cpp's own table, though carried by 1–2 maintainers with open iOS issues, so
"released", not "production-hardened" — compiled through emscripten with Dawn's
`emdawnwebgpu` bindings. The [accompanying paper](https://arxiv.org/abs/2605.20706)
reports **54–69% higher decode throughput than WebLLM and transformers.js at 29–33% less
memory**, and — critically — streams weights from OPFS directly into WebGPU buffers in
four 1 MB chunks, **never materializing them in the WebAssembly heap**. The wasm32 4 GB
ceiling therefore does not apply to model weights. ⚠️ The same paper reports **prefill
significantly lags WebLLM and transformers.js** — which matters more here than decode,
because the curated prompt is 6.2–6.8k tokens: cold prefill, not tok/s, is the browser
number to fear (§6, §8).

`@wllama/wllama` v3 (latest 3.5.1) packages this with **WebGPU (shipped since v3.1), tool
calling, and embeddings**, running in a worker, plus `llama-gguf-split` handling for the
2 GB ArrayBuffer file cap. ⚠️ Its KV-cache support is **configuration, not control**:
`cache_type_k/v`, `n_cache_reuse` and `cache_idle_slots` survive in v3, but v2's
imperative `kvClear`/`kvRemove` are gone. Prefix reuse is available; slot save/restore
(M15) may have no browser equivalent at all.

Read that against what this system actually depends on:

| dependency | wllama v3 |
|---|---|
| the exact `l3` GGUF the parity benchmark measured | same file, no ONNX re-export |
| `l1` embeddings for `placeIndex.js` | same runtime, one stack for both tiers |
| grammar-constrained tool-call emission | llama.cpp's own path |
| KV prefix reuse for the 6.2–6.8k curated prompt | `n_cache_reuse` config — see caveat above |

This is the decision that makes the port cheap. Every other browser runtime would have
required hand-rolling tool-call parsing — the highest-risk item in the system, given the
malformed-args failures already observed *with* grammar enforcement.

Milestone 3 of the tooling design (`LocalLLMClient` — streaming, GBNF, tool loop) is
mostly satisfied by adopting wllama rather than by writing it — for the **in-tab
backend**. The client seam itself still gets written once, and it has a second backend
that already exists (§1.1).

### 0.2 The perception layer is already browser-native

`starter/` is a working browser build of everything `simple_camio_llm` does with a camera:

| `simple_camio_llm` | `starter/` | |
|---|---|---|
| `map_detector.py` — SIFT + FLANN + `findHomography` | `TactileExplorer.jsx:285` — AKAZE + BFMatcher + `findHomography`, every 6 frames, `@techstark/opencv-js` | done |
| `gesture_recognizer.py` — MediaPipe hands, pointing ratio | `gestureRecognizer.js` + `@mediapipe/tasks-vision` | done |
| `video_capture.py` — cv2/DSHOW enumeration | `cameraDevices.js` — `getUserMedia` | done |
| `place_retrieval.py` | `placeIndex.js` + `candidateContext.js` | done (the Python is the port) |
| `tts.py` — pyttsx3 | `speechSynthesis` (already used in `TactileExplorerGeneric.jsx:40`) | queue logic still to write |

No OpenCV-in-WASM risk, no MediaPipe risk. Both are already in production code here.

### 0.3 `audiom-backend` collapses the Tier C capability cliff

**This is the most consequential finding, and it revises the tooling design doc.**

§3.2 of that doc treats an opaque `/embed/d/<id>` as Tier C: "names and bounds and nothing
else… no geometry, no adjacency, no attributes", recovered by binary-searching the avatar
against `executeCommand` probes. §10 lists it as an open risk: *"Audiom tier C is a
capability cliff."*

That is true for a third-party embed. It is **not** true for any map that exists as a
`map_definitions` row in the backend, because the backend already resolves it:

```
GET /map-definitions/:mapDefinitionId/layers
  →  { id, slug, title, name, center, zoom, globalParams, organizationId,
       warnings,
       layers: [ { name, mapType, coordinateSystem, visible,
                   cachedAt, cacheTtl, expiresAt,
                   source } ] }          ← source = loaded GeoJSON + metadata
```

`map-definition-layers.class.js` flattens nested sources, resolves each through
`@coughlan-lab/layerloader`, applies the map's expanded ruleset, stamps `sourceName`
provenance onto every feature, derives feature names, truncates coordinates to 5dp, and
caches the result server-side with a TTL. The client receives real geometry with real
attributes.

And `map_definitions` carries `center`, `zoom`, `extent` and `anchors` — so the window
bbox is a field read, not ten bisections per edge. ⚠️ Partly walked back by
implementation: on 885, `extent` is `{mode: "hull", buffer: 360}` — a recipe, not a
bbox — so the adapter derives the extent from the loaded geometry instead. Still not
ten bisections.

**Consequence: for maps we host, Audiom is Tier A.** The oracle-probe path stays only as
the fallback for embeds we do not own. This converts the Audiom route from a describe-only
assistant into one that can do everything the geometry supports, which is the difference
between milestones 5 and 12 mattering and not mattering.

> ✅ **Verified against staging 2026-08-10.** `GET /map-definitions/885/layers` with
> `VITE_AUDIOM_FULL_ACCESS_KEY` returns **17 layers, 3004 features, `warnings: []`**, HTTP 200.
> The Tier A path works on a real map. Numbers and caveats in §7.

---

## 1. Architecture

```
 camera ──► getUserMedia ──► AKAZE homography ──► (u,v) ──► acuityCell
              (starter/, done)                              │
                                                            ▼
 mic ──► Web Speech / Gemma audio-in ──► utterance ──► ┌─────────────┐
                                                       │ Dispatcher  │
                                                       └──────┬──────┘
                                                              │ injects uv, window,
                                                              │ worldId, frame, prefs
  ┌───────────────────────────────────────────────────────────▼──────┐
  │ L0  deterministic — featureEntered passthrough, adapter.at()     │
  │ L1  EmbeddingGemma via wllama — place resolution, plan cache     │
  │ L3  Gemma 4 (E2B/E4B) via wllama — tool loop + narration         │
  └───────────────────────────────────┬──────────────────────────────┘
                                      │ capability-filtered tools
                    ┌─────────────────┼─────────────────┐
                    ▼                 ▼                 ▼
            OsmWorldAdapter   AudiomWorldAdapter   CamioWorldAdapter
              (geographic)    (geographic | enu)       (image)
                    │                 │                    │
                    │        ┌────────┴────────┐           │
              quadkey tiles  │                 │      ProjectLoader
                       /layers API      postMessage      colorMap
                       (Tier A)          (side effects)   hotspots
                                            │
                                      ┌─────▼─────┐
                                      │  Audiom   │
                                      │  iframe   │
                                      └───────────┘
                                      speechSynthesis
```

L2 (FunctionGemma) is deliberately deferred — see §5, M14.

The spine is `WorldAdapter` (§3.4 of the design doc). Every tool is written once against
that interface; each world implements it differently. Nothing in the tool layer knows what
a lat/lng is.

### 1.1 The LLM runtime is a seam, not a bet *(new in rev 2)*

`placeIndex.js` already talks to the LLM through `LocalLLMClient` (`src/lib/localLLM.js`),
which speaks OpenAI-compatible HTTP to the llama.cpp router on `:8081` — and **that server
is itself cross-OS**. The "macOS-only" property of today's pipeline is an artifact of
where the server happens to run, not of the architecture: the same single `llama-server`
binary runs on Windows and Linux with Vulkan/CUDA where Metal is not available.

So the runtime is one interface with two backends, and everything above it —
`WorldAdapter`s, `ToolRegistry`, dispatcher, speech — is written against the interface:

| backend | what it is | what it's for |
|---|---|---|
| **HTTP router** | exists today; any desktop OS; native speed; keeps M15 slot save/restore and the measured mmproj audio-in | the performance configuration, and the floor device (8 GB M1, where E4B fits natively but not in-tab) |
| **wllama in-tab** | milestone 3w; zero install; E2B on 8 GB machines | the reach configuration — "open a tab" on any WebGPU browser |

The consequence for sequencing: **the critical path runs through the seam with the
existing HTTP backend**, so the conversational stack (M7, M-S) is buildable and demoable
now, on every OS the server runs on. The wllama backend lands in parallel once the **W**
spike qualifies it, and flips "zero install" on as a deployment configuration rather than
holding the whole plan hostage to browser-runtime risk. Rev 1 had 3b (the in-tab swap) on
the critical path; that was the wrong place for it.

---

## 2. The Audiom data path

Audiom is two distinct channels, and conflating them is the main way this goes wrong.

### 2.1 Reads — the backend (data)

`AudiomWorldAdapter` builds its `Place`/`Segment`/`Node` model from
`GET /map-definitions/:id/layers`, once per map, cached in IndexedDB keyed on
⚠️ `(mapDefinitionId, cachedAt)` from the layer metadata the endpoint already returns —
not on ruleset `updatedAt`, because the healthy case verified in §7.1 has
`rulesetId: null`. Fold a ruleset id into the key when one is present.

After that fetch the session is **offline**. This matters: the LLM is local, the map data
is local-after-first-load, and only the initial layer fetch touches the network. A session
started on a laptop with no connection works if the map was loaded once before.

Feature properties arriving from layerloader — post-ruleset, with `sourceName` provenance —
are what feed `placeIndex.js`'s `document()`. The base-rate rule from §6.4 (drop attributes
held by more than ~a third of places) **must be re-derived for this world**; the existing
one was fitted to camio POIs.

### 2.2 Writes — the iframe (side effects)

Audiom's own functionality is reached only through `postMessage`, which
`AudiomMap.jsx` already wraps:

| message | use |
|---|---|
| `{ type: 'getState' }` | initial sync |
| `{ type: 'moveAvatar', payload: { position: [lng, lat] } }` | `route_to` mode `fly_me_there` |
| `{ type: 'executeCommand', payload: { command } }` | Audiom's built-in commands |
| ← `featureEntered` / `featureSelected` | live feature-under-cursor stream |

So `route_to` on the Audiom route is not "compute a path and speak it" — it is **drive
Audiom's avatar and let Audiom's own audio do the work**. That is exactly what the user
asked for: the model invoking functionality Audiom already has.

`featureEntered` is the `liveFeatureStream` capability. Per §3.2 of the design doc,
`whats_here` on this route must be answered from the last `featureEntered` payload at L0,
**with no inference at all**.

The subscription already exists. `AudiomMap.jsx:169` handles both `featureEntered` and
`featureSelected`, extracts `payload.features[].name`, and stores the joined result:

```js
const names = (payload?.features || []).map((f) => f.name).filter(Boolean);
if (names.length) setLastFeature(names.join(', '));
```

What is missing is the path from there to an answer, and it is two small changes:

1. **`lastFeature` is component-local `useState`, rendered as visual status text**
   (`Audiom · {status} · {lastFeature}`, line 227). A dispatcher needs it in a ref it can
   read synchronously, the way `AudiomMap` already reads `coordRef` for avatar updates.
   Promote it; keep the status line reading from the same source.
2. **Nothing speaks it.** `speak()` exists only in `TactileExplorerGeneric.jsx:39`, used
   for corner-registration prompts and hand warnings — a different component tree. Lift
   those three lines now; the M-S queue replaces them later. ⚠️ Rev 1 gated this on the
   full speech milestone, which pushed the system's cheapest win behind the entire
   critical path — corrected in the 5c row of §5.

So the cheapest win in the system is cheaper than a milestone: the stream is already
flowing and is already correct, and `whats_here` becomes a ref read plus an utterance.

One nuance for Tier C: `featureEntered` carries **names only**, so the L0 answer is
name-only, while the tool description promises the feature *and what is immediately
adjacent to it*. Under Tier A, enrich the adjacency half from the cached `/layers`
geometry; under Tier C, answer with the name and stop rather than escalating to L3 for
adjacency the world cannot supply.

### 2.3 Tier table, revised

| Tier | When | Capabilities |
|---|---|---|
| **A** | `sources` is a GeoJSON URL, **or the map is a `map_definitions` row we can read** | everything the geometry supports |
| **B** | `sources` is a predefined id (TDEI, IMDF, GoodMaps…) | varies by source |
| **C** | third-party opaque embed | `places` + `liveFeatureStream`; bounds by binary search |

Tier A is now the common case, not the lucky case.

---

## 3. The `.camio` data path

Frame: **image** (template pixels). `ProjectLoader` from `camio-explorer` yields `data`
(`ProjectData`), `templateBase64`, `colorMapBase64`, `soundFilesBase64s`.

- `Region` is the model type; hotspots are colour-keyed areas where the colour is an
  identifier, not an appearance.
- `at(u,v)` is a colour-map lookup — a single pixel read, no inference. L0.
- Adjacency = which regions share a border. Supports "what's next to this"; supports
  nothing turn-by-turn.
- Distances are **millimetres on the material**. `get_distance_to` must return
  `material_mm` and the result must carry the unit so L3 narrates what it was given.
- `route_to` is offered with the enum **narrowed to `fly_me_there`**, not dropped.
- Capability set `{places, regions}` → 7 tools reach the prompt. ⚠️ This corrects design
  doc §3.5, which says 4: per the schema's own capability tags, `{places}` alone admits
  `whats_here` + five `places` tools + `route_to` narrowed to `fly_me_there` = 7. The same
  recount makes an Audiom tier-C session 7, not 3.

`fromCamioPoi()` enrichment is already validated on this source; it is the one world where
§6.4's tuning transfers as-is.

---

## 4. What comes from `simple_camio_llm`, and what does not

The Python app is the reference implementation, not the thing being ported wholesale. It
was built against MapIO's model — one world, one frame, POI indices, Google-shaped legs.
The tooling design deliberately breaks with that. So:

**Port (pure logic, no platform imports, ⚠️ ~2,600 lines — graph.py is 766 alone, tts.py
356, navigation/ 378):**

| source | becomes |
|---|---|
| `graph.py` — Floyd–Warshall `precompute_distances`, `get_min_path`, `get_nearest_node/edge/poi`, `__local_legs`, `__merge_collinear` (COLLINEAR_COS 0.985), `__process_instructions` | the `graph`/`routing` half of any Tier-A adapter |
| `node.py`, `edge.py`, `poi.py`, `coords.py`, `buffer.py` | adapter-internal geometry |
| `navigation/` — `street_by_street_navigator`, `fly_over_navigator`, `navigation_controller` | `route_to` execution + the `route_failed()` chain |
| `position/position_handler.py` | (u,v) → snapped position, already partly in `usePinGrid.js` |
| `tts.py`'s priority/interrupt/category queue (**logic only** — pyttsx3 does not port) | a `speechSynthesis` queue |

**Do not port:**

- `llm.py`'s round loop — wllama's tool loop replaces it. The answer-dedup containment fix
  and `LOCAL_MAX_TOKENS` cap are the two behaviours worth carrying over as tests.
- `prompt_formatter.py` / `curated_formatter.py` — the tool set is different (12 tools,
  capability-filtered, no `enable_points_of_interests`). `candidateContext.js` already
  implements the V3t candidate block that measured 5/5.
- `map_detector.py`, `gesture_recognizer.py`, `video_capture.py`, `stt.py`,
  `audio_manager.py` — superseded by `starter/`.
- POI *indices*. The tool set is names-only by design rule 2.

Write the ported code as plain ES modules with **zero platform imports**, so it runs in
Node under the existing benchmark harness before it runs in a tab.

---

## 5. Milestones

Merged from §9 of the design doc, re-sequenced for the runtime decision and the Tier A
finding. Gates are hard dependencies.

| # | Milestone | Gates | Est. | Status |
|---|---|---|---|---|
| 1 | `Surface` — (u,v), acuityCell, aspect negotiation | — | 3 d | **done 2026-08-10** — `src/lib/surface.js`, 126 checks |
| 2 | `WorldAdapter` interface + capability negotiation | — | 3 d | **done 2026-08-10** — `worldAdapter.js` + `toolFilter.js`, 21 checks |
| W | wllama qualification spike — tool calls on 2 of the 12 schemas, **thinking-disable**, ~7k-token cold prefill, `n_cache_reuse` prefix reuse, split-GGUF E2B load | — | 1–2 d | **done 2026-08-12** — functional PASS 2026-08-10 (tool calls, thinking-off both ways, `role:tool` round trip, split-GGUF load); numbers closed 2026-08-12 on RTX 3080 + the 8 GB M1 floor, four runs in `explore/wllama-spike/results/`. See §5.2 |
| 3 | `LocalLLMClient` **seam** — one interface; HTTP-router backend exists, streaming + tool loop to write | — | 4 d | **done 2026-08-10** — `chatCompletion` + `toolLoop.js`, 41 offline checks; request contract frozen for 3w; thinking-disable + 768 cap enforced client-side |
| 8 | `PlaceIndex` — EmbeddingGemma + IndexedDB | 3 | — | **done** |
| 3w | wllama in-tab backend (`l1` + `l3`) behind the seam; subsumes rev 1's 3b placeIndex swap | W, 3 | 1 w | **done 2026-08-11** — `src/lib/llm/{index,modelProfiles,wllamaTransport}.js`, 77 checks; `createLLMClient({backend})` defaults to `http` |
| 5a | `AudiomWorldAdapter` **Tier A** via `/layers` + IndexedDB cache | 2 | 1 w | **done 2026-08-10** — `adapters/audiomWorldAdapter.js`; 60 offline checks + live pass on 885 (2,971 places, warm cache = 0 fetches); injectable store, IndexedDB wiring pending |
| 5b | Audiom side-effect channel — `moveAvatar`, `executeCommand` wrappers | 5a | 2 d | **done 2026-08-11** — `src/lib/audiomChannel.js`, 159 checks; `LIVE_FEATURE_MAX_AGE_MS` bounds the live stream |
| 5c | L0 `whats_here` — promote `lastFeature` to a ref, speak it | ⚠️ 5b only | 0.5 d | **done 2026-08-11** — `src/lib/speak.js` + a "What's here?" button, which is also the user gesture browsers require before `speechSynthesis` will utter. First spoken output |
| 6 | `CamioWorldAdapter` — template / colorMap / hotspots / region adjacency | 2 | 1 w | **done 2026-08-10** — `adapters/camioWorldAdapter.js`, 79 checks; nearest-boundary `material_mm` distances |
| 7 | `ToolRegistry` + dispatcher, tools 1–6, capability filtering | 3, 5a | 1 w | **done 2026-08-11** — `{direction,turnContext,untrusted,toolResult,toolRegistry,l0,dispatcher}.js` + `tools/`, 212 checks. See §5.2 |
| P | **Logic port** from `simple_camio_llm` (§4), validated in Node | — | 2 w | **done 2026-08-10** — `src/lib/logic/` (12 modules, 287 checks); route prose **byte-identical** to the Python on `new_york` and `detroit_conant`; 7 reference-implementation bugs documented in-file |
| 12b | Tier-A routing — Floyd–Warshall from the ported graph | P, 5a | 4 d | **done 2026-08-11** — `src/lib/geojsonGraph.js` + `route()`. ⚠️ NO real-data validation: map 885 correctly refuses to build a graph (geological map — its lines are contacts, not a walkable network). Needs a walkable Tier-A map id |
| 13 | Nav tools 10–12 against the Audiom avatar | 12b, 5b | 4 d | ready — both gates met. `fly_me_there` needs no new transport; `channel.moveAvatar` is the whole mechanism |
| S | Speech — Web Speech in, `speechSynthesis` queue out | 7 | 4 d | in progress 2026-08-12 |
| **P-eval** | **28-turn MapIO parity against the JS stack in Node** — replayed Apple-STT transcripts → l1 → l3 (E4B on the router). Discharges §6's acceptance test for **P**, which has never run | P, 7, 12b | 2 d | in progress 2026-08-12 |
| **3w-eval** | Same runner, wllama transport, E2B in-tab. Isolates the model swap | 3w, P-eval | 1 d | in progress 2026-08-12 |
| **S-bench** | Live-mic Web Speech WER, graded against `arm1_curated_stt_nohints` — see §6 for why the no-hints arm is the fair comparison | S, P-eval | 1 d | |
| 4 | `OsmWorldAdapter` (places only, polygons file) | 2 | 4 d | |
| 9 | `SemanticPlanCache` | 1, 8 | 3 d | |
| 10 | OpenSidewalks tiling pipeline — the 209 MB problem | — | own project | deferred |
| 11 | Accessibility tools 7–9 | 10 | — | blocked on 10 |
| 14 | FunctionGemma L2 fast path | 7, 8 | — | deferred |
| 15 | KV slot save/restore | 7 | — | deferred — ⚠️ HTTP-router backend only, **permanently**: wllama v3 has no imperative KV API, so this is not "not yet" in a tab, it is "never". Revisit only if v4 restores `kvClear`/`kvRemove` |

**Critical path to a working voice session on Audiom + `.camio`:**
1 → 2 → 3 → 5a → 5b → 7 → S. ⚠️ **As of 2026-08-12 only S remains**; everything before it
is done and committed. The 6–8 week estimate was wrong in the useful direction — six
milestones landed on 2026-08-10 and the rest of the path on 2026-08-11.

What that leaves is not "the session works" but "the session has never been graded". The
plan's three §6 harnesses have produced **no JS baseline number, any of them**, which is
why P-eval is now a milestone row rather than a line of prose.

M10 stays deferred. Nothing sidewalk-related works in-browser until it exists, and it is
its own project; the Audiom Tier A path now delivers real geometry without it, which is
what makes deferring it acceptable rather than merely convenient.

M14 is deferred deliberately: §10 of the design doc records that **L3 errors dominate L1
errors** on current evidence, so a faster L2 optimises the wrong layer. Revisit after the
eval set is reconciled.

### 5.1 Implementation log — what building it changed (2026-08-10)

Six milestones (1, 2, 3, P, 5a, 6) landed in one day as platform-free modules under
`starter/src/lib/` with ~600 Node checks. Everything existing was reused or extended in
place — `localLLM.js` extended (embeddings untouched), `toolFilter` re-exports
`candidateContext.placeTakingTools`, adapters follow `placeIndex`'s injectable-store
pattern.

One distinction worth stating because it looks like duplication and isn't: `starter`'s
existing camio **perception** pipeline (camera → homography → pointing → (u,v) in
`TactileExplorer*`, feeding the map and `AudiomAvatar`) is untouched and is the
adapters' *input*. What M6 added is the previously missing camio **data** half — colour
→ region identity, adjacency, material-mm distances. That half existed in this repo only
inside `explore/`'s browser-bound TS viewmodels (`cv.Mat`/DOM/audio — unimportable from
Node), and `starter/src` never reads `public/colorMap.png` at all today; only
`braille.png` is consumed. The adapter matches camio-explorer's conventions
(`ucharPtr(y,x)`, `compareColor`, `title`/`description`) so those assets plug in, and the
integration is the dispatcher handing the already-produced (u,v) to `adapter.at()` plus
a ~10-line canvas wrapper for the pixel accessor.

Deltas the docs didn't predict:

- **Design doc §3.5's tool counts were wrong** (4/3 → 7); fixed there, `toolFilter.js` is
  authoritative. The schema encodes `route_to`'s `routing|places` OR as
  `requires:["places"]` + a narrowing `$note`, so no filter special-case was needed.
- **§2.2's A4 figure only holds for the printed artwork area** (~270×190 mm), not the
  sheet; design doc corrected, `surface.js` ships both descriptors.
- **On real Audiom data, ambiguity is the norm, not the edge case**: 885's 3,004 features
  share 314 names (one name × 373 features). `resolvePlace` caps `Ambiguous` at 8.
- **`extent` is a recipe** (`{mode:"hull"}`), not a bbox (§0.3 caveat above); frame comes
  as `coordinateSystem:"standard"` + `metadata.crs`, not `geographic|enu` literals.
- **`/layers` for 885 is 27 MB** — the layer cache wants its own IndexedDB database, not
  a corner of `abtc-place-index`.
- **§6.4's base-rate rule inverts on Audiom** (near-universal `ruleName`/`briefing` are
  that world's only classification signal) — re-derive per world, as §10 warned.
- **The port found 7 real bugs in the Python reference** (documented in-file, preserved
  or safely deviated with comments — e.g. `get_crossings` can return −1, `Edge`
  descriptions KeyError on partial feature dicts). Route narration is byte-identical to
  the Python on both bundled models, which is most of what the parity benchmark grades.
- **Known debts:** `audiom.js` reads `import.meta.env` at module scope so it can't be
  imported from Node — `audiomWorldAdapter` re-derives `uvToLngLat`/`uvToEastNorth`
  (must stay numerically identical; refactor `audiom.js`, then delete the copies);
  `AudiomTactileApp`'s inline `aspectMismatch` should call `surface.js`; the IndexedDB
  layer-cache store is interface-ready but unwired.

### 5.2 Implementation log — the rest of the critical path (2026-08-11/12)

5b, 5c, 12b, 3w and 7 landed on 2026-08-11 and W's numbers closed on 2026-08-12. Ten Node
suites, ~1,150 checks. `test_logic_port`'s 287 never moved, which is the port's acceptance
bar working as intended.

**Two conventions the reference implementation settled, against a design agent's advice:**

- **A finger on a tactile map HAS a heading.** `position_handler.py:162` derives it from
  finger movement — thresholded, dotted against the edge versor, `MovementDirection.NONE`
  past 60°. It is *intermittent*, not absent. So `direction.js` imports the rosette from
  the ported `logic/graph.js` rather than reimplementing it: absolute direction is always
  available and needs no heading; the turn-relative phrase is additive and gated on a
  fresh one, reproducing `__process_instructions`' own `i === 0` branch.
- **The vocabulary is 8 cardinals relative to north plus turn-relative continuation —
  never a clock face**, despite §5.4 of the design doc. `graph.py:738` and
  `fly_over_navigator.py:51` agree. A test asserts no tool result ever says "o'clock".
- **Coordinates at the tool boundary are world-native** — lng/lat for Audiom and OSM,
  material mm for camio — not `(u,v)`. MapIO keeps one `ReferenceSystem` (`graph.py:22`)
  and every node, edge, POI and position lives in it. `(u,v)` is a perception-layer
  artifact, converted once at the perception→adapter boundary.

**⚠️ But heading cannot be sampled in `(u,v)`.** A 45° finger sweep across a 297×210 mm
sheet is 35° in `(u,v)`, and geographic frames add Mercator on top. Hence a new adapter
primitive, `metricPoint(u,v)` → an isotropic y-down plane, which is now the one place per
world where the projection lives.

**Two live bugs the harness caught that reading would not have:**

- **§6.3's memo key is under-specified, and it is an accessibility bug.** It keys on
  position and args, but `whats_here` reads `ctx.liveFeature` and `get_direction_to` reads
  `ctx.heading`. A finger resting inside one acuity cell while the avatar crosses three
  features would be told the first name forever — the cache silently reintroducing the
  staleness `LIVE_FEATURE_MAX_AGE_MS` exists to prevent. Fixed with a handler-declared
  `memoTag(ctx)`.
- **`Edge.getCompleteDescription()` opens with `features[SURFACE]`**, and `geojsonGraph.js`
  supplies no `edges_features`, so every edge would have announced itself as "concrete"
  from a placeholder — a §8 stale-attribute violation. `at()` uses pure topology instead.

**Runtime numbers (§7.2 Q1, and they close W).** Four runs in
`explore/wllama-spike/results/`, E2B QAT UD-Q4_K_XL, libllama b9640:

| | RTX 3080 / 32 GB | 8 GB M1 |
|---|---|---|
| load (cold OPFS / warm) | 14.9 s / — | 103.1 s / 6.5 s |
| peak memory | 6006 MB | 4976 MB |
| decode | 32.1 tok/s | 19.8 tok/s |
| prefill, divergent head, default | 38.52 s | **119.52 s** |
| prefill, divergent head, `swa_full` | **0.91 s** | **2.37 s** |

⚠️ **`swa_full: true` is now the default** (`modelProfiles.js`), pinned by a test. Gemma
4's interleaved SWA (`n_swa = 512`) does not defeat prefix reuse in general — append-only
continuation reuses 0.997 either way. What it defeats is reuse across a prompt that
diverges in a *stable head*, which is what every new user turn is: same system prompt,
freshly retrieved candidates. There the default reuses **zero** of 6363 tokens. `swa_full`
costs ~27% on genuinely-new tokens and, contrary to the predicted +84 MiB, nothing
measurable in peak memory.

Also measured: `navigator.deviceMemory` is **clamped at 8**, so §7.2's "E4B in-tab is a
16 GB configuration" is not observable from a tab — E4B must be opt-in via
`VITE_LLM_PROFILE`, never memory-detected. And 80 candidates → 1702 prompt tokens
(~21/candidate), putting the 6.2–6.8k curated band at ~300 candidates.

---

## 6. Verification

Three harnesses already exist. Use them; do not invent a fourth. ⚠️ **None of the three
has yet produced a number from the JavaScript stack** — that is the single largest gap in
this plan, and P-eval/3w-eval/S-bench in §5 exist to close it.

**Tool-selection correctness.** `docs/eval_dataset.json` (21 cases, tagged by
`capability_profile`) via `scripts/eval_tools.py`. ✅ **Reconciled 2026-08-11**: the script
now shells to Node and imports the real `candidateContext`/`toolFilter`, so the JS stays
single source of truth. ⚠️ Two consequences. The old harness ignored `frames` **entirely**
and left camio's `route_to.mode` un-narrowed, so **every eval number from before
2026-08-11 measured a different filter** and none is a baseline. And no replacement number
exists yet — the router was unreachable when it ran.

**End-to-end behaviour.** `explore/simple_camio_llm/run_parity_benchmark.py` — 26 recorded
turns over 18 cases, `--routing local`, graded post-hoc against a GPT-4o bar (94.74%
correct + 5.26% correct_not_optimal on `new_york`). It is the acceptance test for **P**,
and the reason the port is platform-free. ⚠️ It has never run against the JS, because
until M7 there was no dispatcher to run it against; **P-eval** in §5 is that run.

Note on inputs: `SpeechRecognition` cannot be fed a file — it captures the default input
device and accepts no `MediaStream` or `AudioBuffer` — so WAVs cannot be pushed through
browser STT without OS-level audio loopback. P-eval therefore **replays** the transcripts
Apple's on-device recognizer produced (`benchmark/results/arm1_curated_stt/*.json` stores
both the heard text and the reference per turn), and **S-bench** measures browser STT
live on a mic instead. ⚠️ An earlier draft of this paragraph said browser STT has no
equivalent of the Python arm's 50 POI `contextualStrings`, and therefore that
`arm1_curated_stt_nohints` was the only fair comparison. **That is wrong.** Web Speech
ships `SpeechRecognitionPhrase` / `recognition.phrases` — the same in-window biasing list,
at no memory cost — and M-S wires it from the place names we already hold, feature-detected.
So S-bench should grade against `arm1_curated_stt` (hints on), with the no-hints arm as the
control. This also retires §8.1 of the design doc's `Qwen3-ASR-0.6B` fallback, which was
proposed for exactly this job and rejected on memory grounds.

**Retrieval.** recall@**5**, not top-1, on ~200 hand-labelled utterances. Rev-3 measured
recall@1 at 1/5 and recall@5 at 5/5 on the same queries — several candidates are routinely
equally valid (five banks for "I need an ATM"). Instrument this per world; the Audiom
document shape is new and its base-rate cutoff is unfitted.

**Runtime.** ✅ **Closed 2026-08-12 — see §5.2 for the numbers.** E4B in a tab remains
unmeasured (`measured: false` in `modelProfiles.js`); everything else below is answered.
The **W** spike: load E2B and E4B in a tab on the 8 GB M1 and record peak
memory, ⚠️ **cold prefill time at ~7k prompt tokens**, and decode tok/s; confirm tool-call
emission on two of the 12 schemas **with thinking disabled** — §8.0 of the design doc
measured that with tools present, thinking-on is fatal, not slow, so the spike must find
wllama's equivalent of `chat_template_kwargs: {enable_thinking: false}` or the product
path fails while the happy-path demo passes; confirm KV prefix reuse across turns via
`n_cache_reuse`. One afternoon, and it decides §7's first question — and whether 3w is a
milestone or a rewrite.

---

## 7. What was measured, and what is still open

### 7.1 Verified against staging, 2026-08-10

All requests read-only against `https://audiom-backend-staging.herokuapp.com`. No
`?refresh=` was used.

**The Tier A path works.**

```
GET /map-definitions/885/layers        (Wisconsin Geological Survey Quaternary Map)
  → 200 · 17 layers · 3004 features · warnings: []
  → cold 6.4s · warm 11.0s (single samples — see §8)
GET /map-definitions/885
  → visibility: public · organizationId: 1 · rulesetId: null · allowedOrigins: null
  → 17 sources, first is an ArcGIS FeatureServer
```

So M5a is unblocked: these are `map_definitions` rows we can read, the full-access key
authorizes the endpoint, and geometry plus per-feature metadata arrives intact.

**The origin gate does not fire here.** `allowedOrigins: null` on 885. It remains a real
risk for *other* definitions — `enforceAllowedOriginForRecord` 403s when a public or
unlisted definition carries a non-empty list and our `Referer`/`Origin` hostname is not in
it (exact match or `.suffix`; `localhost` must be listed literally). That is a data change
on the row, needing write access we do not have. Check per map before relying on it.

**`rulesetId: null` is the healthy case, not a gap.** layerloader 2.2's built-in default
rules compile named, typed features without any ruleset — which is what `95d0d31`'s cache
bump existed to deliver. Wisconsin never touches the `esri` ruleset.

**Ruleset resolution depends on key *type*, not on slugs.** Same slug, three callers:

| caller | `?slug=osm&$limit=1` |
|---|---|
| anonymous | 1 row (id 9, org 1, `public`) |
| `VITE_AUDIOM_FULL_ACCESS_KEY` (secret, org 1) | 1 row |
| `VITE_AUDIOM_KEY` (publishable, other org) | **0 rows** |

`restrictAccessToOrganization` (`rulesets.hooks.js:102`) *replaces* the org filter rather
than widening it, so a publishable key pinned to another org loses the org-1 public seed
row. `is-secret-api-key.js` is explicit that publishable keys are the ones embedded in
public web pages — so an embed hits this and a server-side call with the secret key does
not. Fixed by `932ad5b`, reverted by `591e154`, whose replacement was reverted by
`c6c87ca` 98 minutes later; nothing replaced it.

**Implication for us: use the full-access key and slugs resolve fine.** Referencing
rulesets by numeric id is still the more robust choice, but it is belt-and-braces, not the
fix. ⚠️ A full-access key is inlined into the Vite bundle — acceptable for a local research
build, not for anything published.

**Do not trust `total` on these endpoints.** It echoes `$limit` (`1→1`, `8→8`, `50→50`).
Visibility cannot be inferred from it.

**Direct id addressing works where listing does not.** `/maps/885` 404s — no pointer row —
while `/map-definitions/885` returns the record, because `enforceGet` permits direct
addressing that `enforceFind` filters out. **The adapter must be handed map-definition ids
up front; it cannot discover them by listing.**

### 7.2 Still open

1. **E2B or E4B?** E4B is what the benchmark measured. ⚠️ Its q4 GGUF is **~4.8–5.2 GB**
   (Q4_0 4.84, Google's QAT q4_0 5.15 — rev 1's 4.2 GB was the older Gemma 3n E4B figure)
   of pinned WebGPU allocation, which on an 8 GB M1 alongside Chrome is not tight but
   over budget — llama.cpp's 29–33% saving does not close a 5 GB hole. **E2B is the
   in-tab configuration on 8 GB machines; E4B in-tab is a 16 GB configuration; E4B stays
   available on the HTTP-router backend either way (§1.1).** ✅ **Measured 2026-08-12
   (§5.2): E2B is viable in a tab on both machines** — 4976 MB peak and 19.8 tok/s decode
   on the 8 GB M1, with `swa_full` bringing per-turn prefill to 2.37 s. E4B in a tab is
   still unmeasured and stays opt-in, because `navigator.deviceMemory` is clamped at 8 and
   cannot detect the 16 GB machine it would need. The remaining open half is not memory
   but **accuracy**: E4B is what the parity benchmark graded, and whether E2B holds that
   bar is what 3w-eval answers.
2. **Speech in.** ⚠️ Rev 1 had this backwards on both browsers. Chrome 139 (Aug 2025)
   shipped **on-device** recognition — `SpeechRecognition` with `processLocally: true`
   and installable language packs — while Safari's Web Speech implementation sends audio
   to **Apple's servers** (its own permission modal says so; the on-device engine is the
   *native* Speech framework, which `explore/simple_camio_llm/tools/macos_stt` uses and a
   browser tab cannot reach). So the browser answer is **Chrome-first with
   `processLocally`, feature-detected**, degrading to a visible "cloud STT" notice where
   the language pack is unavailable. Gemma audio-in remains the eventual unification —
   measured natively, `l3` accepts audio at ~1.9× realtime with no KV eviction — but
   in-tab it costs the ~1 GB mmproj the 8 GB budget does not have; revisit with 3w.
3. **Which of our target maps carry a non-empty `allowedOrigins`?** One `GET
   /map-definitions/:id` per map answers it. Any that do are blocked until someone with
   write access to org 1 adds our origin.

### 7.3 Issues to file upstream (not ours to fix)

- **`/maps/d/885` is a front-end failure.** The backend serves 17 layers and 3004 features
  with no warnings. Whatever breaks the page is above the API.
- **The publishable key cannot resolve public seed rulesets** — the org-pin defect above,
  with the `932ad5b` → `591e154` → `c6c87ca` trail.
- **`total` echoes `$limit`** on paginated finds.
- **`/embed/dynamic` appears not to use the `apiKey` it is passed**, since the same slug
  resolves for that key directly.

---

## 8. Risks

Carried forward from §10 of the design doc and still live:

- **Latency.** L3 at 1–3 s is slow for a sweeping finger, and in-browser will be slower
  than native — expect low-teens tok/s decode for E4B against ⚠️ 16–25 native (design doc
  §8 measured 16 tok/s steady-state; the audio-in run measured 25 — reconcile which
  configuration each number belongs to before quoting either). And per the runtime's own
  paper, **prefill lags harder than decode**: at 6.2–6.8k prompt tokens, cold prefill is
  the dominant in-tab cost, which makes KV prefix reuse and §6.1's stable/volatile
  placement rule load-bearing, not optional. Mitigate with the existing non-LLM earcon
  and TTS that starts on the first sentence.
- **Prompt injection.** Audiom feature names come from arbitrary user-authored maps.
  Treat every place-derived string as untrusted data in a delimited block. This gets
  *worse* under Tier A, because we are now ingesting far more third-party text.
- **Stale accessibility data.** Provenance and age must ride in the tool result; narration
  must hedge. Never state flatly that a crossing has a curb ramp.
- **Aspect mismatch on refreshable surfaces** — silent geometric error. Fix before Monarch.
- **Everything measured in rev 3 rests on 5–11 cases.**

New with this plan:

- **wllama v3's tool calling: functional half verified 2026-08-10** against the shipped
  `@wllama/wllama@3.5.1` source. The load-bearing fact: v3 embeds **llama-server's own
  request path** in WASM (`oaicompat_chat_params_parse` / `params_from_json_cmpl`), so
  `tools`/`tool_choice`, per-request GBNF `grammar` and `json_schema` response_format,
  `chat_template_kwargs: {enable_thinking: false}` (plus load-time `reasoning: false`),
  and split-GGUF loading all exist with llama-server semantics. Emission-only — the
  caller runs the tool loop, same contract the harness already targets. Both spike
  schemas pass once the non-OAI wrapper keys (`requires`, `frames`, `$note`) are
  stripped — M7's dispatcher must own that strip step. Still open, and runnable via
  `explore/wllama-spike/` in any WebGPU Chrome: Gemma 4's actual thinking behavior under
  the pinned wasm llama.cpp revision, prefill/reuse/decode numbers, peak memory.
- **`l1` + `l3` in one page means two `Wllama` instances.** v3 is one model per instance
  (`n_parallel: 1`), so EmbeddingGemma rides in its own worker + WASM heap alongside the
  chat model — additive memory the §7.2 budget must count.
- **Multithread WASM needs COOP/COEP headers, and GitHub Pages cannot set them.** The
  repo's Pages deploy (`.github/workflows/deploy-pages.yml`) collides with this. ⚠️
  **Corrected 2026-08-11: do NOT ship the `coi-serviceworker` shim.** COEP `require-corp`
  blocks cross-origin iframes that lack their own CORP/COEP, and the Audiom iframe is the
  entire side-effect channel (§2.2) — the shim would trade every write capability for a
  WASM thread pool. Accept single-threaded WASM on Pages, or self-host, where the two
  headers are one line of config.
- **iOS browsers are out.** ⚠️ Not because of a flat 500 MB cap — jetsam kills land
  anywhere from ~0.3 to ~2 GB depending on device generation, and Safari's default WebGPU
  `maxBufferSize` is 256 MB — but the conclusion stands: multi-GB in-tab inference is not
  viable on iOS regardless of runtime. If iPad is a target form factor, that is a React
  Native + ExecuTorch build, not this one — and note the Gemma 4 ExecuTorch bundle is
  **E2B only**.
- **The `/layers` fetch is a network dependency at session start.** Acceptable — it is
  once per map and then cached — but it means "works with no installation" is not the same
  claim as "works with no network, ever".
- **`/layers` is slow even warm: 6.4s cold, 11.0s on the second call** for Wisconsin's
  3004 features (§7.1). ⚠️ One sample each, and warm-slower-than-cold says dyno noise —
  treat these as an existence proof of slowness, not a characterization. Server-side
  caching does not rescue it — the cost is serializing
  and shipping the payload off a Heroku dyno. This makes the client-side IndexedDB cache
  **required, not an optimisation**, and it must be populated before a session starts
  rather than on first question. Budget a visible "preparing map" step.
- **Auth posture is a fork in the road, not a setting.** The full-access key is what makes
  Tier A work, and it is inlined into the bundle by Vite. A local research build can live
  with that; a published build cannot, and the publishable key cannot read what we need
  until the org-pin defect is fixed upstream. Decide which build we are making before M5a
  hardens around the secret key.
