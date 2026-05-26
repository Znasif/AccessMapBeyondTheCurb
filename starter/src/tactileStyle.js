/**
 * Tactile TMAP-style basemap for Mapbox GL JS.
 *
 * Replicates the Lighthouse for the Blind TMAP tactile rendering from tmap_py:
 *   - White background
 *   - Uniform dark strokes on roads (#414042, round cap)
 *   - Dashed railways and footways
 *   - High-contrast buildings/parks/water with no colour fill
 *   - No labels, icons, or satellite imagery
 *
 * Style reference:  tmap_py/src/tmap/svg_builder.py  (_TACTILE_* constants)
 *                   tmap_py/src/tmap/config.py        (POI_STYLES, ROAD_STYLES)
 *
 * Data source: Mapbox Streets v8 vector tiles (requires a Mapbox access token).
 */

const TACTILE_STYLE = {
  version: 8,
  name: 'Tactile TMAP',
  sources: {
    'mapbox-streets': {
      type: 'vector',
      url: 'mapbox://mapbox.mapbox-streets-v8',
    },
  },
  glyphs: 'mapbox://fonts/mapbox/{fontstack}/{range}.pbf',
  layers: [
    // ── 1. Background ────────────────────────────────────────────────
    {
      id: 'background',
      type: 'background',
      paint: {
        'background-color': '#ffffff',
      },
    },

    // ── 2. Water ─────────────────────────────────────────────────────
    // tmap_py tactile: fill:#000000; fill-opacity:0.1; stroke:#000000; stroke-width:1
    {
      id: 'water',
      type: 'fill',
      source: 'mapbox-streets',
      'source-layer': 'water',
      paint: {
        'fill-color': '#000000',
        'fill-opacity': 0.1,
      },
    },
    {
      id: 'water-outline',
      type: 'line',
      source: 'mapbox-streets',
      'source-layer': 'water',
      paint: {
        'line-color': '#000000',
        'line-width': 1,
      },
    },

    // ── 3. Waterways (rivers, streams) ───────────────────────────────
    {
      id: 'waterway',
      type: 'line',
      source: 'mapbox-streets',
      'source-layer': 'waterway',
      paint: {
        'line-color': '#000000',
        'line-width': 1,
        'line-opacity': 0.15,
      },
    },

    // ── 4. Land use — parks, cemeteries, pitches ─────────────────────
    // tmap_py tactile: fill:none; stroke:#000000; stroke-width:1.5; stroke-dasharray:3 3
    {
      id: 'landuse-park',
      type: 'line',
      source: 'mapbox-streets',
      'source-layer': 'landuse',
      filter: ['in', 'class', 'park', 'cemetery', 'pitch', 'sand'],
      paint: {
        'line-color': '#000000',
        'line-width': 1.5,
        'line-dasharray': [3, 3],
      },
    },

    // ── 5. Buildings ─────────────────────────────────────────────────
    // tmap_py tactile: fill:#000000; fill-opacity:0.2; stroke:#000000; stroke-width:1
    {
      id: 'building',
      type: 'fill',
      source: 'mapbox-streets',
      'source-layer': 'building',
      paint: {
        'fill-color': '#000000',
        'fill-opacity': 0.15,
      },
    },
    {
      id: 'building-outline',
      type: 'line',
      source: 'mapbox-streets',
      'source-layer': 'building',
      paint: {
        'line-color': '#000000',
        'line-width': 0.75,
      },
    },

    // ── 6. Paths / footways ──────────────────────────────────────────
    // tmap_py tactile: stroke:#231f20; stroke-width:1.5; stroke-dasharray:3 9
    // Mapbox dasharray is in line-width units, so [2, 6] × 1.5px ≈ 3px / 9px
    {
      id: 'road-path',
      type: 'line',
      source: 'mapbox-streets',
      'source-layer': 'road',
      filter: ['in', 'class', 'path', 'pedestrian', 'track', 'golf'],
      layout: {
        'line-cap': 'round',
        'line-join': 'round',
      },
      paint: {
        'line-color': '#231f20',
        'line-width': 1.5,
        'line-dasharray': [2, 6],
      },
    },

    // ── 7. Railways ──────────────────────────────────────────────────
    // tmap_py tactile: stroke:#414042; stroke-width:2.5; stroke-dasharray:10 15
    // Mapbox dasharray: [4, 6] × 2.5px = 10px / 15px
    {
      id: 'road-rail',
      type: 'line',
      source: 'mapbox-streets',
      'source-layer': 'road',
      filter: ['in', 'class', 'major_rail', 'minor_rail', 'service_rail'],
      layout: {
        'line-cap': 'round',
        'line-join': 'round',
      },
      paint: {
        'line-color': '#414042',
        'line-width': 2.5,
        'line-dasharray': [4, 6],
      },
    },

    // ── 8. Roads — all other types ───────────────────────────────────
    // tmap_py tactile: stroke:#414042; stroke-width:2.5; stroke-linecap:round
    {
      id: 'road',
      type: 'line',
      source: 'mapbox-streets',
      'source-layer': 'road',
      filter: [
        '!in', 'class',
        'path', 'pedestrian', 'track', 'golf',
        'major_rail', 'minor_rail', 'service_rail',
      ],
      layout: {
        'line-cap': 'round',
        'line-join': 'round',
      },
      paint: {
        'line-color': '#414042',
        'line-width': 2.5,
      },
    },
  ],
};

export default TACTILE_STYLE;
