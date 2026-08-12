import mapboxgl from 'mapbox-gl';

/**
 * Map marker lifecycle, extracted from App.jsx.
 *
 * Previously there were two markers, 'start' and 'end', labelled A and B for
 * routing. With routing gone there is a single "place" marker, so `kind` now
 * selects styling only.
 */

/**
 * Create, move, or remove a marker to match `point`.
 *
 * @param map        mapboxgl.Map or null
 * @param markerRef  a ref holding the current marker instance
 * @param point      { lng, lat } or null to remove
 * @param kind       CSS modifier, e.g. 'place'
 */
export function syncPointMarker(map, markerRef, point, kind = 'place') {
  if (!map) return;

  if (!point) {
    markerRef.current?.remove();
    markerRef.current = null;
    return;
  }

  if (!markerRef.current) {
    markerRef.current = new mapboxgl.Marker({
      element: createMarkerElement(kind),
      anchor: 'bottom',
    })
      .setLngLat([point.lng, point.lat])
      .addTo(map);
    return;
  }

  markerRef.current.setLngLat([point.lng, point.lat]);
}

export function createMarkerElement(kind = 'place') {
  const element = document.createElement('div');
  element.className = `point-marker ${kind}`;
  // Styled by .point-marker in styles.css; no glyph now that A/B is gone.
  element.innerHTML = '<span></span>';
  return element;
}
