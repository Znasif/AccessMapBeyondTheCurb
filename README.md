# Audiom Tactile Integration

This branch connects [Audiom](https://audiom.net) audio maps to a **physical tactile map** and a **camera**. You point at a printed/embossed material with your finger; MediaPipe tracks the fingertip, OpenCV rectifies the camera view onto the map's coordinates, and the Audiom avatar moves to match — so touching a place on the material makes Audiom speak what is there.

There are two pages:

| Page | What it maps | Audiom's role |
|---|---|---|
| `index.html` | OSM routing (AccessMap + Mapillary), pin grid generated from the viewport | Audio layer synced to the generated tactile grid |
| `audiom.html` | **Any Audiom map** — saved maps, pre-configured embeds, or any data source | The map itself; drives everything |

---

## Setup

```bash
cd starter
npm install
npm run dev
```

`.env`:

```env
VITE_AUDIOM_FULL_ACCESS_KEY=   # required for saved maps and embeds
VITE_AUDIOM_KEY=               # fallback; only works for dynamic sources
VITE_AUDIOM_ORIGIN=https://audiom-staging.herokuapp.com

VITE_MAPBOX_TOKEN=             # index.html only
VITE_MAPILLARY_TOKEN=          # index.html only
VITE_ACCESSMAP_BASE_URL=/accessmap-api
```

Then open:

- `http://localhost:5173/index.html` — OSM door-to-door
- `http://localhost:5173/audiom.html` — Audiom tactile explorer

Each page links to the other in its sidebar.

> Serving behind an HTTPS tunnel? Start with `VITE_TUNNEL=1 npm run dev`. On plain localhost, leave it unset or HMR will fail.

---

## `audiom.html` — any Audiom map

### 1. Load a map

The input accepts four things:

| Input | Route used | Example |
|---|---|---|
| Map link or id | `/embed/d/<id>` | `/maps/d/885` (Wisconsin geology) |
| Pre-configured embed id | `/embed/<id>` | `570` (human skeleton) |
| Predefined source | `/embed/dynamic?sources=…` | `osm`, `TDEI`, `covid_daily` |
| GeoJSON URL | `/embed/dynamic?sources=<url>` | `https://…/data.geojson` |

`/embed/<id>` and `/embed/d/<id>` are **different id namespaces** — `570` is not valid under `/embed/d/`, and `885` is not valid under `/embed/`. Both require the full-access key. Large maps can take ~30 s to load.

### 2. Print the material

On load, the app discovers the map's bounds and shows the aspect ratio to print at. **Print the material at that aspect.** The four corners you touch then correspond to the four corners of the map's bounds, so no stretching or letterboxing is needed.

### 3. Register the material

Hold the camera steady over the material and press **Register material** (or `r`). You'll be prompted to point at each corner in turn — top-left, top-right, bottom-right, bottom-left — holding ~1.5 s each, with a beep on each capture. The frame captured at the fourth corner becomes the tracking reference.

### 4. Align and explore

The camera view is rectified into a green box on screen. **Pan and zoom the Audiom map underneath it** until the map lines up inside the box — the overlay ignores the cursor, so the map stays draggable. Then move your finger on the material and the avatar follows.

- `;` — fix/unfix the homography (freeze tracking; useful if the material has little texture)
- `r` — re-register

Audiom's own feature card shows what's under the avatar, which doubles as a correctness check.

---

## `index.html` — OSM door-to-door

The original routing explorer, with Audiom added as an audio layer. Enable **Tactile map**, then **Audiom audio (sync to tactile)** in the sidebar. The pin grid is generated from the Mapbox viewport at a chosen scale, and Audiom is loaded via `/embed/dynamic?sources=osm` centred on the same extent, so the audio matches the tactile grid.

---

## How it works

```
camera frame
  └─ MediaPipe hand landmarker ──> fingertip (x, y) + One Euro filter
  └─ AKAZE match vs registered snapshot ──> homography
        └─ fingertip ──> snapshot ──> (u, v) in the material
              └─ quantised to a cell grid (hysteresis)
                    └─ (u, v) ──> lat/lng within the map bounds
                          └─ postMessage moveAvatar → Audiom speaks
```

**Bounds discovery.** Audiom's postMessage API doesn't report map bounds, so the app finds them by binary search: a movement command only moves the avatar while it is inside the map, which gives a clean inside/outside test. Each edge is probed perpendicular to itself, so an edge can't block its own probe. Works on geographic maps, spatial diagrams and heatmaps alike.

**Quantisation.** The fingertip snaps to a grid of finger-sized cells with hysteresis, and a move is only sent when the cell changes. Without this, camera jitter on a large map crosses many features per frame and Audiom announces constantly — at whole-Wisconsin scale one camera pixel is ~390 m.

**Coordinate systems.** Geographic maps use lat/lng, and `moveAvatar` takes `[lng, lat]`. Non-geographic spatial diagrams (e.g. the skeleton) have **no lat/lng** — `c` and `Alt+c` both return local East/North metres. They render and register fine, but driving the avatar to an absolute position on a pure diagram needs Audiom to accept E/N coordinates.

### Known limits

- **No viewport API.** The embed never reports its centre/zoom and emits nothing when panned, so the overlay is aligned by moving the map rather than computed. A `viewportChanged` event plus a `setView` command would make this automatic and allow sub-region windows that stay in sync.
- **Bounds are ~1% approximate.** The discovered movement bound differs slightly from the published image extent (~7 km on Wisconsin) — well under one tactile cell at whole-map scale.
- **Whole map only.** The window is the full map. Sub-region windowing was prototyped but is parked until the viewport API lands.

---

## Key files

```
starter/
  audiom.html                     entry for the tactile explorer
  index.html                      entry for the OSM explorer
  src/
    audiom.js                     embed URLs, id parsing, mercator/window math
    AudiomTactileApp.jsx          audiom.html page
    AudiomMap.jsx                 embed + bounds discovery + avatar driving
    TactileExplorerGeneric.jsx    camera, registration, rectification, quantisation
    App.jsx                       index.html page
    AudiomAvatar.jsx              Audiom audio layer for the OSM page
    pinGrid.js                    pin-grid rasterisation for the OSM page
```
