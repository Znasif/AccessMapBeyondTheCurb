# tmap_py — Architecture

Standalone Python CLI that produces tactile and print SVG maps in the
Lighthouse for the Blind TMAP format.  No web layer, no database, no paid
APIs.  Everything runs locally against OSM (Nominatim + Overpass).

---

## Directory layout

```
tmap_py/
├── pyproject.toml          # uv/hatchling package config, entry point
├── architecture.md         # this file
├── fonts/
│   ├── Arial.ttf           # embedded in SVG via base64
│   └── Braille29.ttf       # tactile font, embedded in SVG via base64
└── src/tmap/
    ├── __init__.py
    ├── main.py             # CLI argument parsing
    ├── pipeline.py         # orchestrates the full address → SVG pipeline
    ├── config.py           # all constants ported from the Ruby project
    ├── geocoder.py         # Nominatim geocoding (via osmnx)
    ├── osm_fetcher.py      # Overpass fetch — roads, POIs, railways, paths
    ├── features.py         # classifies raw OSM GeoDataFrame into typed structs
    ├── geometry.py         # BoundingBox + CoordTransformer (lat/lon ↔ pixels)
    ├── labeler.py          # abbreviation + margin-label placement (Ruby port)
    ├── svg_builder.py      # renders FeatureSet → SvgMap (Ruby port)
    └── legend.py           # renders Map Key page (separate SVG)
```

---

## Pipeline (`pipeline.py`)

```
address (str)
    │
    ▼
geocoder.py          → (lat, lon)          via Nominatim, free, no key
    │
    ▼
osm_fetcher.py       → OsmData             via Overpass, cached to disk
    │
    ▼
features.py          → FeatureSet          typed dataclasses per feature kind
    │
    ▼
geometry.py          → CoordTransformer    maps lat/lon ↔ SVG pixels
    │
    ├──▶ svg_builder.py  (tactile=False)  → (SvgMap, labels)
    ├──▶ svg_builder.py  (tactile=True)   → (SvgMap, _)
    ├──▶ legend.py       (tactile=False)  → svgwrite.Drawing
    └──▶ legend.py       (tactile=True)   → svgwrite.Drawing
                                                    │
                                                    ▼
                              4 SVG files saved to --output dir
```

The pipeline function signature:

```python
generate(
    address: str,
    scale: int  = 5000,      # 1500/2500/5000/12500/25000/50000
    paper: str  = "letter",  # see PAPER_CONFIGS in config.py
    units: str  = "feet",    # "feet" | "meters" (scale-bar label)
    output_dir  = ".",
    include_pois      = False,
    include_railways  = False,
    include_pathways  = False,
) -> dict[str, Path]
```

---

## CLI (`main.py`)

Options mirror the TMAP web UI dropdowns exactly:

| Flag | Choices | Default | Maps to |
|------|---------|---------|---------|
| `--scale` | `1500 2500 5000 12500 25000 50000` | `5000` | `SCALE_TO_ZOOM` → zoom → fetch radius |
| `--paper` | `8.5x11 11x8.5 11.5x11 17x11 11x17` | `8.5x11` | `PAPER_CONFIGS` key |
| `--units` | `feet meters` | `feet` | scale-bar label |
| `--pois` | flag | off | fetch buildings/parks/water |
| `--railways` | flag | off | fetch railways |
| `--pathways` | flag | off | fetch footways/paths |

```
uv run tmap "8 10th St, San Francisco, CA"
uv run tmap "address" --scale 2500 --paper 11.5x11 --units feet --output ./out
```

---

## Config (`config.py`)

Faithful port of the Ruby initializers and `lib/scale.rb` / `lib/map_drawer.rb`.

### Page geometry

Ruby uses `PAGE_PADDING x:230, y:240` and `Y_OFFSET=20`:

```
PAGE_MARGIN_LEFT   = 115   # page_padding.x / 2
PAGE_MARGIN_RIGHT  = 115
PAGE_MARGIN_TOP    = 100   # page_padding.y / 2 - Y_OFFSET  (120 - 20)
PAGE_MARGIN_BOTTOM = 140   # page_h - map_y0 - map_h
```

### Paper sizes (72 dpi, matching Ruby `lib/scale.rb`)

| CLI flag | Config key | page_w × page_h | map_w × map_h |
|----------|-----------|-----------------|----------------|
| `8.5x11` | `letter` | 612 × 792 | 382 × 552 |
| `11x8.5` | `letter_landscape` | 792 × 612 | 562 × 372 |
| `11.5x11` | `braille` | 828 × 792 | 598 × 552 |
| `17x11` | `tabloid_landscape` | 1224 × 792 | 994 × 552 |
| `11x17` | `tabloid_portrait` | 792 × 1224 | 562 × 984 |

### Scale mapping

```
SCALE_TO_ZOOM = {1500:18, 2500:17, 5000:16, 12500:15, 25000:14, 50000:13}
ZOOM_TO_DIST  = {18:200,  17:400,  16:900,  15:1800,  14:3600,  13:9000}  # meters
ZOOM_SCALE_FT = {18:50,   17:100,  16:250,  15:500,   14:1000,  13:2500}  # scale-bar ft
ZOOM_SCALE_M  = {18:15,   17:30,   16:75,   15:150,   14:300,   13:750}   # scale-bar m
```

---

## Coordinate system (`geometry.py`)

Two coordinate spaces are used throughout:

| Space | Origin | Axes | Used by |
|-------|--------|------|---------|
| **SVG space** | top-left of page | x→right, y→down (px) | `svgwrite`, decorations |
| **Map space** | top-left of map area | x in [0, map_w], y in [0, map_h] | labeler, intersection finding |

`CoordTransformer` bridges them:

```python
to_pixel(lat, lon)               → (svg_x, svg_y)   # for drawing roads/markers
to_map_pixel(lat, lon)           → (map_x, map_y)   # for labeler intersection check
linestring_to_pixels(geom)       → [(svg_x, svg_y)]
linestring_to_map_pixels(geom)   → [(map_x, map_y)]
meters_to_pixels(m)              → float             # for scale bar
```

SVG space = map space + (map_x0, map_y0) offset, where `map_x0 = PAGE_MARGIN_LEFT = 115`.

---

## Labeler (`labeler.py`)

Port of `lib/osm/road/abbreviator.rb`, `lib/labeler.rb`, `lib/labeler/label.rb`,
`lib/labeler/variance.rb`, and the positioning formulas from
`lib/map_drawer/label_drawer.rb`.

### Abbreviation pipeline (`Abbreviator.abbreviate`)

Processes road names **one at a time** (in priority order), maintaining a
`name → ABBR` dict that enforces uniqueness across all processed roads:

```
base_name = strip street-type suffix  ("Market Street" → "market")
then:
1. check ABBREVIATION_EXCEPTIONS table ("martin luther king jr way" → "MLK")
2. strip non-alphanumeric chars        ("st. mary's" → "stmarys")
3. numeric + directional               ("north14th"  → "n14")
4. pure numeric                        ("10th"       → "10")
5. abbreviate direction words          ("northgate"  → "ngate")
6. strip consecutive duplicate chars  ("llano"      → "lano")
7. strip vowels from position 1        ("market"     → "mrkt")
8. reduce to ≤3 chars (ideal) or 4    ("mrkt"       → "mrk")
9. make unique (increment last digit if collision)
```

Result is uppercased: `"Market St"` → `"MRK"`.

### Label placement

```python
place_labels(roads, transformer, zoom, abbreviator) → list[MarginLabel]
```

For each named road that crosses the map boundary:

1. **Find intersections** — where road polyline crosses the `[0,map_w]×[0,map_h]`
   rectangle boundary (via Shapely).  Each crossing point is a candidate
   label position.
2. **Build `_Label` objects** — one per road, with a list of intersection
   points and a `cursor` selecting which point to use.
3. **Odometer variance loop** — try all combinations of cursors across all
   labels.  For each combination, count how many labels *cannot* be placed
   without collision (a `_Variance`).  Keep the cursor combination that
   minimises the variance (fewest skips, then prefer skipping lower-priority
   roads).
4. **Collision resolution** — a second pass removes labels that still collide
   after the odometer, keeping the higher-priority / longer road.
5. **Return `MarginLabel` objects** — `pos_x / pos_y` in map space, `resolved`
   flag, `text` (abbreviation), `full_name`, `direction`.

Collision proximity constants (from Ruby):
```
X_PROXIMITY = 25 px   # left / right edge labels
Y_PROXIMITY = 75 px   # top  / bottom edge labels
```

### SVG label positions (from `lib/map_drawer/label_drawer.rb`)

```
left edge:   svg_x = map_x0 - 10,         svg_y = map_y0 + pos_y + 8,  anchor="end"
right edge:  svg_x = map_x0 + map_w + 10, svg_y = map_y0 + pos_y + 8,  anchor="start"
top edge:    svg_x = map_x0 + pos_x,      svg_y = map_y0 - 15,          anchor="middle"
bottom edge: svg_x = map_x0 + pos_x,      svg_y = map_y0 + map_h + 30,  anchor="middle"
```

---

## SVG builder (`svg_builder.py`)

Port of `lib/map_drawer/` subdirectory.  Renders one `SvgMap` at a time
(called twice — once for print, once for tactile).

### Layer order (painters algorithm)

```
1. white background rect
2. g#pois      — buildings / parks / water polygons
3. g#roads     — roads, railways, pathways (polylines)
4. g#marker    — address circle
5. g#labels    — margin labels (text only, no leader lines)
6. g#decorations — border rect, scale bar, north arrow, header, footer
```

### Address marker (`draw_poi_locator` port)

```
print:   circle r=10 stroke=#ffffff stroke-width=8px  (erase ring)
       + circle r=10 stroke=#231f20 stroke-width=6px  (dark ring)

tactile: circle r=16 fill=#ffffff                     (white erase disc)
       + circle r=10 stroke=#414042 stroke-width=2px  (dark ring)
```

### North arrow (`draw_orientation` port)

Y-shape at `(page_width − 47, 32)`:
```
vertical stem:  (cx, cy+36) → (cx, cy)
left arm:       (cx, cy)    → (cx−11, cy+18)
right arm:      (cx, cy)    → (cx+11, cy+18)
"N" text at:    (cx−8, 18)
```
For letter paper this lands at x = 565, well inside the right margin.

### Scale bar (`ScaleDrawer` port)

```
text at:  (page_width − 217, 18)
line at:  (page_width − 217, 32)  length = ZOOM_SCALE_FT[zoom] ft → pixels
```
Label is `"500 ft"` (or `"150 m"` when `--units meters`).

### Road styles

```
print:   stroke:#414042  stroke-width:1.5  stroke-linecap:round
tactile: stroke:#414042  stroke-width:2.5  stroke-linecap:round
```
All road types share the same colour; no width hierarchy (matches real TMAP).

---

## Legend (`legend.py`)

Renders a separate "Map Key" SVG page listing every labelled road:

```
Map Key

○  <full address>
—  Street

MRK    Market St -- E-W
MSN    Mission St -- NE-SW
...
```

Uses `MarginLabel.text`, `.full_name`, `.direction`.  Sorted alphabetically
by abbreviation, deduplicated.

---

## OSM data (`osm_fetcher.py`)

Uses `osmnx` (which wraps Nominatim + Overpass):

```python
G     = ox.graph_from_point(center, dist=dist, network_type="all", retain_all=True)
nodes, edges = ox.graph_to_gdfs(G)
# optional:
ox.features_from_point(center, tags={"building": True}, dist=dist)
ox.features_from_point(center, tags={"leisure": "park"}, dist=dist)
...
```

**Caching**: `ox.settings.use_cache = True` → requests cached in
`~/.cache/osmnx/`.  Re-running the same address+dist is instant.

**No API key required.**  Nominatim requires a valid `User-Agent` (set
automatically by osmnx).  Overpass is rate-limited but free.

---

## Data flow types

```
geocode(address) → (lat: float, lon: float)

fetch(lat, lon, dist) → OsmData
    .graph     MultiDiGraph
    .edges     GeoDataFrame   # road segments with highway/name tags
    .nodes     GeoDataFrame
    .buildings GeoDataFrame   # optional
    .parks     GeoDataFrame   # optional
    .water     GeoDataFrame   # optional
    .railways  GeoDataFrame   # optional
    .pathways  GeoDataFrame   # optional

classify(OsmData) → FeatureSet
    .roads     list[RoadFeature]      highway, name, geometry, priority, length
    .railways  list[RailwayFeature]   railway, name, geometry
    .pathways  list[PathwayFeature]   highway, geometry
    .pois      list[PoiFeature]       kind, geometry (Polygon|MultiPolygon)

place_labels(...) → list[MarginLabel]
    .text       str     abbreviation  e.g. "MRK"
    .full_name  str     e.g. "Market Street"
    .direction  str     "N-S" | "E-W" | "NE-SW" | "NW-SE"
    .pos_x      float   map-space x (0 = left edge, map_w = right edge)
    .pos_y      float   map-space y (0 = top edge,  map_h = bottom edge)
    .resolved   bool    False = collision loser, skip drawing

build_svg(...) → (SvgMap, list[MarginLabel])
SvgMap.save(path)        writes SVG file via svgwrite
```

---

## Dependencies

| Package | Role |
|---------|------|
| `osmnx` | Nominatim geocoding + Overpass graph fetch + caching |
| `geopandas` | GeoDataFrame for OSM feature queries |
| `shapely` | Geometry ops (intersection finding for labeler) |
| `svgwrite` | SVG generation |
| `numpy` | Required by geopandas/osmnx |

Python ≥ 3.11.  Managed with `uv`.

---

## Ruby source correspondence

| Python file | Ruby source(s) |
|-------------|----------------|
| `config.py` | `config/initializers/02-osm_way_config.rb`, `lib/scale.rb`, `lib/map_drawer.rb` |
| `geometry.py` | `lib/geometry/bounding_box.rb`, `lib/geometry/point.rb` |
| `osm_fetcher.py` | `lib/osm/way_creator.rb` (OSM fetch logic) |
| `features.py` | `lib/osm/road.rb`, `lib/osm/way.rb` |
| `labeler.py` | `lib/osm/road/abbreviator.rb`, `lib/labeler.rb`, `lib/labeler/label.rb`, `lib/labeler/variance.rb`, `lib/map_drawer/label_drawer.rb` |
| `svg_builder.py` | `lib/map_drawer/road_drawer.rb`, `lib/map_drawer/orientation_drawer.rb`, `lib/map_drawer/scale_drawer.rb`, `lib/map_drawer/label_drawer.rb` |
| `legend.py` | `lib/map_drawer/legend_creator.rb` |

The Ruby project requires Rails + PostgreSQL + Sidekiq + AWS S3.
`tmap_py` has none of those dependencies — it is the pure map-generation
core extracted and rewritten as a standalone CLI.
