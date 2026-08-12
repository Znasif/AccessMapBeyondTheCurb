/**
 * P-eval + 3w-eval — the MapIO parity benchmark, run against the JavaScript stack.
 *
 * `browser-voice-exploration-plan.md` §6 nominates
 * `explore/simple_camio_llm/run_parity_benchmark.py` as the **end-to-end**
 * harness and says: *"If the ported logic keeps the tool contract, this runs
 * against the JS in Node. It is the acceptance test for P, and the reason the
 * port should be platform-free."* This module is that run. It is not a fourth
 * harness — it writes the same JSON and the same gradable Markdown into the same
 * `benchmark/results/<arm>/` tree, so `compare_arms.py` and the grading flow work
 * unchanged.
 *
 * ## The arms
 *
 * One variable each, following `benchmark/run_arms.py`'s methodology:
 *
 *   `js_node_e4b`     HTTP router, `l3` (Gemma 4 E4B). **The baseline** — same
 *                     model and same words as `arm1_curated_stt`, so any grade
 *                     delta is the JS port and nothing else.
 *   `js_browser_e2b`  wllama in-tab, E2B. Isolates the model swap.
 *   `js_node_e2b`     optional; separates "E2B is weaker" from "in-tab differs
 *                     from llama-server". Needs a second tier mounted on the
 *                     router.
 *
 * Each arm runs **two passes**, because the recorded transcript carries both
 * strings: `heard` (what Apple's recogniser produced, real errors intact) lands
 * in `<arm>/` and compares against `arm1_curated_stt`; `clean` (the written
 * reference) lands in `<arm>_text/` and compares against `arm1_curated_stt_text`.
 * See `transcript.js` for why STT is replayed rather than re-executed.
 *
 * ## The pieces
 *
 *   `transcript.js`    the recorded run → cases and turns, both utterances
 *   `world.js`         one map: ported Graph + adapter + registry + L1 index
 *   `mapioAdapter.js`  the ported graph as a `WorldAdapter` (⚠️ NOT camio — see the file)
 *   `briefing.js`      the standing world description the survey turns need
 *   `harnessTools.js`  `route_to` + the two accessibility readers M7 did not ship
 *   `runner.js`        the platform-free loop
 *   `report.js`        the Python's JSON and Markdown, byte-shape
 *
 * Nothing here imports a platform. `scripts/parity_js.mjs` supplies Node's IO and
 * an HTTP client; `explore/wllama-spike/parity.html` supplies the browser's and a
 * wllama client. Same runner.
 */

export * from './mapioAdapter.js';
export * from './briefing.js';
export * from './harnessTools.js';
export * from './world.js';
export * from './transcript.js';
export * from './runner.js';
export * from './report.js';
