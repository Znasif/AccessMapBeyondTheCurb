/**
 * Small geometry helpers used by the pin-grid pipeline.
 * Extracted from App.jsx during the removal of the routing stack.
 */

export const EMPTY_GEOJSON = { type: 'FeatureCollection', features: [] };

/**
 * Clip road LineStrings to a bbox, for rasterising onto the pin grid.
 *
 * Note this filters vertices rather than intersecting segments with the bbox
 * edge, so a segment crossing the boundary is truncated at its last inside
 * vertex instead of at the edge. Good enough at pin-grid resolution, where a
 * cell spans many metres.
 */
export function clipRoadsToBBox(roads, bbox) {
  if (!roads || !bbox) return { type: 'FeatureCollection', features: [] };
  const [minLng, minLat, maxLng, maxLat] = bbox;
  const features = [];

  for (const f of roads) {
    if (!f.geometry) continue;
    const gType = f.geometry.type;
    const coordsList =
      gType === 'LineString' ? [f.geometry.coordinates]
      : gType === 'MultiLineString' ? f.geometry.coordinates
      : [];

    for (const coords of coordsList) {
      if (!coords || coords.length < 2) continue;
      const clipped = coords.filter(
        ([lng, lat]) => lng >= minLng && lng <= maxLng && lat >= minLat && lat <= maxLat,
      );
      if (clipped.length >= 2) {
        features.push({
          type: 'Feature',
          geometry: { type: 'LineString', coordinates: clipped },
          properties: {},
        });
      }
    }
  }
  return { type: 'FeatureCollection', features };
}

/**
 * Shrink a bbox to the artwork area implied by calibrated corner fractions.
 *
 * Image y=0 is north (maxLat) and y=1 is south (minLat), so the latitude terms
 * are inverted relative to longitude.
 */
export function shrinkBboxToGrid(bbox, fractions) {
  const [minLng, minLat, maxLng, maxLat] = bbox;

  // Guard: the caller derives these from calibrated corner PIXELS divided by
  // the template's dimensions. Handing over the raw pixel array instead makes
  // every side undefined, and the arithmetic below silently yields a bbox of
  // NaN — which propagates into rasterizeRoads and TactileExplorer with no
  // error, just an empty grid. Fail loudly and fall back to the full bbox.
  const { left, right, top, bottom } = fractions ?? {};
  const sides = [left, right, top, bottom];
  if (!sides.every((v) => Number.isFinite(v))) {
    console.warn(
      '[shrinkBboxToGrid] expected {left,right,top,bottom} as 0..1 fractions, got',
      fractions,
      '— using the full bbox instead.',
    );
    return bbox;
  }

  const dLng = maxLng - minLng;
  const dLat = maxLat - minLat;
  return [
    minLng + left * dLng,
    maxLat - bottom * dLat,
    minLng + right * dLng,
    maxLat - top * dLat,
  ];
}
