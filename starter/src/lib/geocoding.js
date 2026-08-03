/**
 * Mapbox Search Box geocoding.
 *
 * Extracted verbatim from App.jsx during the removal of the routing stack.
 * The A/B start-end pair is gone; these now back a single "find a place"
 * search whose only job is to move the map to where the tactile pin grid
 * should be generated.
 */

const SEARCH_BASE = 'https://api.mapbox.com/search/searchbox/v1';

/** Format a point as a plain "lat, lng" string — the fallback label. */
export function formatCoords(point) {
  return `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`;
}

/**
 * Forward geocode. `signal` lets the caller abort in-flight lookups as the
 * user keeps typing.
 */
export async function forwardLookup(query, token, proximity, signal) {
  const url = new URL(`${SEARCH_BASE}/forward`);
  url.search = new URLSearchParams({
    q: query,
    access_token: token,
    language: 'en',
    limit: '5',
    proximity: `${proximity.lng},${proximity.lat}`,
  }).toString();

  const response = await fetch(url.toString(), { signal });
  if (!response.ok) {
    throw new Error(`Mapbox search failed with status ${response.status}.`);
  }

  const data = await response.json();
  return data.features || [];
}

/** Reverse geocode a point to a label, degrading to coordinates on any failure. */
export async function reverseLookup(point, token) {
  if (!token) return formatCoords(point);

  const url = new URL(`${SEARCH_BASE}/reverse`);
  url.search = new URLSearchParams({
    longitude: point.lng.toString(),
    latitude: point.lat.toString(),
    access_token: token,
    language: 'en',
    limit: '1',
  }).toString();

  try {
    const response = await fetch(url.toString());
    if (!response.ok) return formatCoords(point);

    const data = await response.json();
    return featureToLabel(data.features?.[0]) || formatCoords(point);
  } catch {
    return formatCoords(point);
  }
}

/**
 * Pull { lng, lat } out of a Search Box feature.
 *
 * The API is inconsistent about where coordinates live, hence the three
 * fallbacks: top-level geometry, properties.coordinates, then the first
 * routable point.
 */
export function featureToPoint(feature) {
  if (Array.isArray(feature?.geometry?.coordinates)) {
    return {
      lng: feature.geometry.coordinates[0],
      lat: feature.geometry.coordinates[1],
    };
  }

  const rawCoordinates = feature?.properties?.coordinates;
  if (rawCoordinates?.longitude != null && rawCoordinates?.latitude != null) {
    return { lng: rawCoordinates.longitude, lat: rawCoordinates.latitude };
  }

  const routablePoint = rawCoordinates?.routable_points?.[0];
  if (routablePoint?.longitude != null && routablePoint?.latitude != null) {
    return { lng: routablePoint.longitude, lat: routablePoint.latitude };
  }

  return null;
}

/** Best human-readable label for a Search Box feature. */
export function featureToLabel(feature) {
  if (!feature) return '';

  const properties = feature.properties || {};
  return (
    properties.full_address ||
    [properties.name, properties.place_formatted].filter(Boolean).join(', ') ||
    properties.name ||
    feature.place_name ||
    ''
  );
}
