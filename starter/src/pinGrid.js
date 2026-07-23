/**
 * Braille pin-grid rasterization for the Mapbox tactile map.
 *
 * Ports the geometry-rasterization approach from tmap_py/brailledoodle.py
 * into the browser.  Road geometries from Mapbox vector tiles are drawn
 * onto a cols×rows pin grid using Bresenham's line algorithm.
 *
 * Reference: tmap_py/src/tmap/brailledoodle.py  rasterize_roads()
 */

// BrailleDoodle device dimensions
export const DEFAULT_COLS = 43;
export const DEFAULT_ROWS = 31;

// Physical pin spacing in mm (BrailleDoodle standard)
const PIN_SPACING_MM = 2.5;

// Minimum zoom for reliable vector-tile road data
export const MIN_ZOOM = 13;

// ---------------------------------------------------------------------------
// 1. Bounding box from route, aspect-ratio-locked to cols:rows
// ---------------------------------------------------------------------------

/**
 * Compute a bounding box from route geometry, padded and locked to the
 * cols:rows aspect ratio in Mercator-corrected visual space.
 *
 * @param {object} route          - Route with geometry.coordinates
 * @param {number} [cols=43]      - Grid columns
 * @param {number} [rows=31]      - Grid rows
 * @param {number} [padding=0.15] - Fractional padding (0.15 = 15%)
 * @returns {[number,number,number,number]|null} [minLng,minLat,maxLng,maxLat]
 */
export function computeRouteBBox(route, cols = DEFAULT_COLS, rows = DEFAULT_ROWS, padding = 0.15) {
  const coords = route?.geometry?.coordinates;
  if (!coords?.length) return null;

  let minLng = Infinity, maxLng = -Infinity;
  let minLat = Infinity, maxLat = -Infinity;

  for (const [lng, lat] of coords) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }

  // Ensure non-zero extent (single point or very short route)
  const MIN_EXTENT = 0.001; // ~111 m
  if (maxLng - minLng < MIN_EXTENT) {
    minLng -= MIN_EXTENT / 2;
    maxLng += MIN_EXTENT / 2;
  }
  if (maxLat - minLat < MIN_EXTENT) {
    minLat -= MIN_EXTENT / 2;
    maxLat += MIN_EXTENT / 2;
  }

  // Symmetric padding
  const padLng = (maxLng - minLng) * padding;
  const padLat = (maxLat - minLat) * padding;
  minLng -= padLng;
  maxLng += padLng;
  minLat -= padLat;
  maxLat += padLat;

  // Lock aspect ratio to cols:rows in visual (Mercator-corrected) space.
  // 1° lng is cos(lat) × 1° lat in visual width.
  const midLat = (minLat + maxLat) / 2;
  const cosLat = Math.cos((midLat * Math.PI) / 180);
  const targetRatio = cols / rows;

  const dLng = maxLng - minLng;
  const dLat = maxLat - minLat;
  const visualRatio = (dLng * cosLat) / dLat;

  if (visualRatio > targetRatio) {
    // Too wide — expand height to match
    const newDLat = (dLng * cosLat) / targetRatio;
    const expand = (newDLat - dLat) / 2;
    minLat -= expand;
    maxLat += expand;
  } else {
    // Too tall — expand width to match
    const newDLng = (dLat * targetRatio) / cosLat;
    const expand = (newDLng - dLng) / 2;
    minLng -= expand;
    maxLng += expand;
  }

  return [minLng, minLat, maxLng, maxLat];
}

/**
 * Compute a bounding box from the current map viewport, aspect-ratio-locked.
 * Used as fallback when no route is available.
 *
 * @param {mapboxgl.Map} map
 * @param {number} [cols=43]
 * @param {number} [rows=31]
 * @returns {[number,number,number,number]} [minLng,minLat,maxLng,maxLat]
 */
export function computeViewportBBox(map, cols = DEFAULT_COLS, rows = DEFAULT_ROWS) {
  const bounds = map.getBounds();
  let minLng = bounds.getWest();
  let maxLng = bounds.getEast();
  let minLat = bounds.getSouth();
  let maxLat = bounds.getNorth();
  

  // Lock aspect ratio to cols:rows in visual space
  const midLat = (minLat + maxLat) / 2;
  const cosLat = Math.cos((midLat * Math.PI) / 180);
  const targetRatio = cols / rows;

  const dLng = maxLng - minLng;
  const dLat = maxLat - minLat;
  const visualRatio = (dLng * cosLat) / dLat;

  if (visualRatio > targetRatio) {
    const newDLat = (dLng * cosLat) / targetRatio;
    const expand = (newDLat - dLat) / 2;
    minLat -= expand;
    maxLat += expand;
  } else {
    const newDLng = (dLat * targetRatio) / cosLat;
    const expand = (newDLng - dLng) / 2;
    minLng -= expand;
    maxLng += expand;
  }

  return [minLng, minLat, maxLng, maxLat];
}

/**
 * Compute a bounding box centred on the current map viewport,
 * sized to match the BrailleDoodle device at the given map scale.
 *
 * Matches the --scale parameter of tmap_py/src/tmap/brailledoodle.py.
 * Default scale=5000 → device covers ~525 m × 375 m at 1:5000.
 *
 * @param {mapboxgl.Map} map
 * @param {number}       scale       - Scale denominator (5000 = 1:5000)
 * @param {number}       [padding=0] - Fractional padding (0.15 = 15%)
 * @param {number}       [cols=43]
 * @param {number}       [rows=31]
 * @returns {[number,number,number,number]} [minLng,minLat,maxLng,maxLat]
 */
export function computeScaleBBox(map, scale, padding = 0, cols = DEFAULT_COLS, rows = DEFAULT_ROWS) {
  // Device physical extent (mm) → geographic metres at the given scale
  const widthM  = (cols - 1) * PIN_SPACING_MM * scale / 1000;
  const heightM = (rows - 1) * PIN_SPACING_MM * scale / 1000;

  const padW = widthM  * padding;
  const padH = heightM * padding;
  const totalW = widthM  + 2 * padW;
  const totalH = heightM + 2 * padH;

  const { lng, lat } = map.getCenter();
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const lngDelta = (totalW / 2) / (111320 * cosLat);
  const latDelta = (totalH / 2) / 111320;

  return [lng - lngDelta, lat - latDelta, lng + lngDelta, lat + latDelta];
}

// ---------------------------------------------------------------------------
// 2. Bresenham rasterization  (port of brailledoodle.py rasterize_roads)
// ---------------------------------------------------------------------------

/**
 * Rasterize road line geometries onto a cols×rows pin grid using
 * Bresenham's line algorithm at 1-pin line width.
 *
 * Duplicate features (from overlapping vector tiles) are harmless —
 * setting a cell to 1 twice is a no-op.
 *
 * @param {Array}  roadFeatures - GeoJSON features (LineString / MultiLineString)
 * @param {number[]} bbox       - [minLng, minLat, maxLng, maxLat]
 * @param {number} [cols=43]
 * @param {number} [rows=31]
 * @returns {Uint8Array} rows*cols flat grid: 1 = pin up, 0 = pin down
 */
export function rasterizeRoads(roadFeatures, bbox, cols = DEFAULT_COLS, rows = DEFAULT_ROWS) {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  const grid = new Uint8Array(rows * cols);

  /** Convert lng/lat to grid col/row. Returns null if invalid. */
  function toPin(lng, lat) {
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
    const col = Math.max(0, Math.min(cols - 1,
      Math.round(((lng - minLng) / (maxLng - minLng)) * (cols - 1))));
    const row = Math.max(0, Math.min(rows - 1,
      Math.round(((maxLat - lat) / (maxLat - minLat)) * (rows - 1))));
    return [col, row];
  }

  /** Bresenham's line: mark all grid cells between two endpoints. */
  const MAX_ITER = cols + rows; // theoretical max steps on this grid
  function bresenham(x0, y0, x1, y1) {
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;

    for (let n = 0; n <= MAX_ITER; n++) {
      if (x0 >= 0 && x0 < cols && y0 >= 0 && y0 < rows) {
        grid[y0 * cols + x0] = 1;
      }
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx)  { err += dx; y0 += sy; }
    }
  }

  for (const feature of roadFeatures) {
    const geom = feature.geometry;
    if (!geom) continue;

    const lines = geom.type === 'MultiLineString'
      ? geom.coordinates
      : [geom.coordinates];

    for (const coords of lines) {
      if (!coords || coords.length < 2) continue;
      for (let i = 0; i < coords.length - 1; i++) {
        // Quick-reject: skip segment if both endpoints are outside the bbox
        // on the same side (cheap AABB test before expensive Bresenham)
        const lng0 = coords[i][0],     lat0 = coords[i][1];
        const lng1 = coords[i + 1][0], lat1 = coords[i + 1][1];
        if ((lng0 < minLng && lng1 < minLng) || (lng0 > maxLng && lng1 > maxLng) ||
            (lat0 < minLat && lat1 < minLat) || (lat0 > maxLat && lat1 > maxLat)) {
          continue;
        }

        const p0 = toPin(lng0, lat0);
        const p1 = toPin(lng1, lat1);
        if (!p0 || !p1) continue;
        bresenham(p0[0], p0[1], p1[0], p1[1]);
      }
    }
  }

  return grid;
}

// ---------------------------------------------------------------------------
// 3. Pin grid → GeoJSON
// ---------------------------------------------------------------------------

/**
 * Convert pin grid to GeoJSON point features + bbox mask polygon.
 *
 * @param {Uint8Array} grid
 * @param {number[]}   bbox
 * @param {number}     [cols=43]
 * @param {number}     [rows=31]
 * @returns {{ pinGeoJSON: object, maskGeoJSON: object }}
 */
export function pinGridToGeoJSON(grid, bbox, cols = DEFAULT_COLS, rows = DEFAULT_ROWS) {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  const features = [];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const lng = minLng + (c / (cols - 1)) * (maxLng - minLng);
      const lat = maxLat - (r / (rows - 1)) * (maxLat - minLat);
      const up = grid[r * cols + c] > 0;
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lng, lat] },
        properties: { up },
      });
    }
  }

  const pinGeoJSON = { type: 'FeatureCollection', features };

  // Bbox mask polygon
  const maskGeoJSON = {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [[
          [minLng, minLat],
          [maxLng, minLat],
          [maxLng, maxLat],
          [minLng, maxLat],
          [minLng, minLat],
        ]],
      },
      properties: {},
    }],
  };

  return { pinGeoJSON, maskGeoJSON };
}

// ---------------------------------------------------------------------------
// 4. Query road features from Mapbox vector tiles
// ---------------------------------------------------------------------------

/**
 * Query road features from the map, clipped to a geographic bounding box.
/**
 * Query road features from Mapbox vector tiles, clipped to a geographic bounding box.
 * Uses queryRenderedFeatures with sourceLayer 'road' to work seamlessly across
 * standard Mapbox styles (e.g. streets-v12) as well as custom styles.
 *
 * @param {mapboxgl.Map} map
 * @param {number[]}     [bbox] - [minLng, minLat, maxLng, maxLat]
 * @returns {Array} Road GeoJSON features
 */
export function queryRoadFeatures(map, bbox) {
  const filter = [
    '!in', 'class',
    'path', 'pedestrian', 'track', 'golf',
    'major_rail', 'minor_rail', 'service_rail',
  ];

  // Convert geographic bbox to screen-space pixel coordinates
  if (bbox) {
    const [minLng, minLat, maxLng, maxLat] = bbox;
    const sw = map.project([minLng, minLat]);
    const ne = map.project([maxLng, maxLat]);
    const bboxScreen = [
      [Math.min(sw.x, ne.x), Math.min(sw.y, ne.y)],
      [Math.max(sw.x, ne.x), Math.max(sw.y, ne.y)],
    ];
    let features = map.queryRenderedFeatures(bboxScreen, { sourceLayer: 'road', filter });
    if (!features || !features.length) {
      features = map.queryRenderedFeatures(bboxScreen, { sourceLayer: 'road' });
    }
    return features || [];
  }

  return map.queryRenderedFeatures(undefined, { sourceLayer: 'road', filter });
}
