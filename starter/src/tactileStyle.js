/**
 * Tactile TMAP-style basemap for Mapbox GL JS.
 *
 * Matches tmap_py defaults: only roads are rendered.
 * Buildings, water, parks, footways, and railways are opt-in in tmap_py
 * (via --pois / --pathways / --railways) and are NOT included here.
 *
 * Buildings are loaded separately from a local GeoJSON in App.jsx and
 * toggled based on the tactile/standard map mode.
 *
 * Style reference:  tmap_py/src/tmap/svg_builder.py  (_TACTILE_* constants)
 *                   tmap_py/src/tmap/config.py        (ROAD_STYLES)
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

    // ── 2. Roads ─────────────────────────────────────────────────────
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
