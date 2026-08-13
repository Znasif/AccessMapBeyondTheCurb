# Deploying to GitHub Pages

Pages serves over HTTPS, which is a secure context, so `navigator.mediaDevices`
exists and the camera works on any device without certificates, flags or
tunnels. That solves the original problem.

It also costs you three things. Read §3 before deciding this is the right fix.

---

## 1. Cost

Free **on a public repository**: Pages is free, and Actions minutes are unmetered
for public repos.

On a **private** repository, Pages requires a paid plan (Pro / Team / Enterprise)
and Actions minutes come out of your monthly quota.

## 2. Setup

This is not a git repository yet, so:

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

Then:

1. **Settings → Pages → Build and deployment → Source = "GitHub Actions"**
2. **Settings → Secrets and variables → Actions**, add:
   `VITE_MAPBOX_TOKEN`, `VITE_MAPILLARY_TOKEN`, `VITE_ACCESSMAP_BASE_URL`,
   `VITE_AUDIOM_KEY`, `VITE_AUDIOM_FULL_ACCESS_KEY`, `VITE_AUDIOM_EMBED_URL`
3. Optionally add a repository **variable** `VITE_BUILDINGS_URL` (see §3.2)

Push to `main`, or run the workflow manually from the Actions tab.
`.github/workflows/deploy-pages.yml` sets `VITE_BASE` from
`actions/configure-pages`, so project-page asset paths resolve correctly.

## 3. What breaks, and why

### 3.1 Your API keys become public

Vite inlines every `import.meta.env.VITE_*` value into the emitted JavaScript at
build time. Repository secrets keep them out of the **repo**; they do not keep
them out of the **bundle**. On a public Pages site anyone can read them in
devtools.

Before deploying:

- **Mapbox** — restrict the token to your Pages origin at
  <https://account.mapbox.com/access-tokens/>. An unrestricted public token is
  billable by whoever finds it.
- **Mapillary** — same reasoning; scope it.
- **Audiom `FULL_ACCESS` key** — think hard about this one. If it grants more
  than read access to public maps, do not publish it. Deploy with only
  `VITE_AUDIOM_KEY` and accept that pre-configured embeds will not resolve.

### 3.2 The buildings layer cannot ship

`resources/ca.sanfrancisco.graph.polygons.geojson` is **200 MB**. GitHub rejects
any file over **100 MB** on push, and Pages will not serve one. It is gitignored.

`App.jsx` now reads `VITE_BUILDINGS_URL`:

- **unset** → falls back to the local path (correct for `npm run dev`)
- **empty** → the source and both `buildings-*` layers are skipped entirely, and
  `queryRenderedFeatures` against them short-circuits
- **a URL** → loads from there

For a real deploy this file wants to be vector tiles, not GeoJSON — 200 MB of
GeoJSON into Mapbox GL is punishing in a browser regardless of hosting. That is
the same tiling work already queued as milestone 10 in
`local-llm-tooling-design.md`.

The build prunes anything over 100 MB from `dist/` and lists what it dropped;
the workflow then hard-fails if an oversized file survives, so you find out in
CI rather than from a broken site.

### 3.3 Routing will probably fail — the dev proxy is gone

`vite.config.js` proxies `/accessmap-api` to `https://stage.accessmap.app` and
rewrites `Referer` and `Origin` to look like requests from AccessMap's own
frontend. That is a **dev-server** feature. A static build has no server.

Worse, it is not replaceable from the browser: `Referer` and `Origin` are
forbidden headers, so `fetch` cannot set them. Unless `stage.accessmap.app`
sends permissive CORS headers to your Pages origin, `fetchAccessibleRoute` will
fail there and work locally.

Options, in order of honesty:

1. Ask the AccessMap operators to allow your origin via CORS.
2. Put a small proxy in front (Cloudflare Worker, Netlify/Vercel function) and
   point `VITE_ACCESSMAP_BASE_URL` at it. Pages alone cannot do this.
3. Ship the local A* routing from the design doc and drop the dependency.

### 3.4 Entrance saving is disabled

`/api/save-entrance` is Vite middleware that writes to
`resources/entrances.geojson` on disk. There is no server on Pages, and a static
host would return the SPA's HTML with status 200 — so the old code would have
reported a successful save that never happened. `App.jsx` now refuses in
production builds unless `VITE_ENTRANCE_API` points somewhere real.

### 3.5 The in-tab model weights cannot ship either

Same shape as §3.2, one order of magnitude worse. The `wllama` backend loads
`gemma-4-E2B-it-qat-UD-Q4_K_XL` (**2.62 GB**) plus EmbeddingGemma (~330 MB).
In `npm run dev` the chat weights come off disk: `serveSpikeModels()` in
`vite.config.js` serves `/models/*` out of `../explore/wllama-spike/models/`,
and the profile's `url` points at the first of five shards. **A deployed build
has none of that** — there is no dev-server middleware, and
`pruneOversizedAssets()` deletes anything over 100 MB from `dist/` because Pages
will not serve it. Weights must come from an external CORS-enabled host.

`src/lib/llm/index.js#resolveModelSource` reads, per tier:

| variable | unset | `''` | a value |
|---|---|---|---|
| `VITE_MODEL_URL` / `VITE_EMBED_URL` | the profile's local path (dev) | no local path; go straight to Hugging Face | load from there — first shard, if split |
| `VITE_MODEL_HF_REPO` / `VITE_EMBED_HF_REPO` | the profile's pinned repo | HF fallback off entirely | that repo |
| `VITE_MODEL_HF_FILE` / `VITE_EMBED_HF_FILE` | the profile's pinned file | — | that file, **exact — a glob is refused** |

So the Pages configuration is `VITE_MODEL_URL=` (empty), which falls through to
the pinned Hugging Face file.

⚠️ Two things to know before relying on that:

- **Never glob `hf.filePath`.** It expands against the third-party repo's
  listing. `UD-Q4_K_XL/*.gguf` matched an auxiliary model, llama.cpp failed a
  `GGML_ASSERT`, and a failed assert aborts the whole WASM module — every later
  call in the tab dies with `RuntimeError: unreachable`, retry included.
- ✅ **The unsplit 2.62 GB file loads, and Pages needs no hosted weights.**
  Verified cold in Chrome incognito with OPFS at 0 MB: storage climbs to 2955 MB
  (2.62 GB E2B + ~318 MB EmbeddingGemma), both tiers open, questions answered.
  So `hf` pointing at unsloth is the whole deployment story — no mirror, no
  Release assets, no HF account.
- ⚠️ **Curl every `hf.filePath` before trusting it.** `UD-Q4_K_XL/<file>.gguf`
  404s; the GGUF is at the repo ROOT. A wrong path is not a harmless miss:
  wllama caches the 15-byte error body and llama.cpp aborts the entire WASM
  module with `Gemma4Assistant requires ctx_other to be set` →
  `GGML_ASSERT(ctx_tgt != nullptr)`. **That signature means "no usable model
  here", not "wrong model"** — two diagnoses were built on reading it the other
  way and both were wrong.

  ```
  curl -sSIL https://huggingface.co/<repo>/resolve/main/<path> | grep -E 'HTTP|content-length'
  ```

  A 200 whose `content-length` matches the profile's `weightsBytes` is the only
  green light. Also note `model-00001-of-00001.gguf` in the logs is wllama's
  cache name for *any* single-file model and identifies nothing.

### 3.6 ONNX runs single-threaded

`onnxruntime-web`'s threaded WASM needs `SharedArrayBuffer`, which requires
COOP/COEP response headers. **Pages cannot set custom headers.** ORT falls back
to single-threaded, so the YOLO entrance detector still works but is slower.
A `coi-serviceworker` shim can fake the headers if it matters.

---

## 4. Is Pages the right answer?

For **sharing a demo**, yes.

For **your original problem** — camera access while developing — a tunnel is
strictly better. `cloudflared tunnel --url http://localhost:5173` gives you an
HTTPS origin *in front of the running dev server*, so the AccessMap proxy, the
entrance-saving endpoint, the 200 MB local file and HMR all keep working. Pages
throws all four away to buy the same HTTPS. Your `vite.config.js` already has a
`VITE_TUNNEL` branch for the HMR socket, which suggests this path was in use
before.

Quick comparison:

| | localhost | Tunnel | GitHub Pages |
|---|---|---|---|
| Camera works | yes | yes | yes |
| Other devices | no | yes | yes |
| AccessMap routing | yes | yes | needs CORS or a proxy |
| Buildings layer | yes | yes | needs external hosting |
| Entrance saving | yes | yes | no |
| Keys stay private | yes | yes | **no** |
| Setup | none | one command | repo + secrets + workflow |

Use Pages for demos, tunnels for development.
