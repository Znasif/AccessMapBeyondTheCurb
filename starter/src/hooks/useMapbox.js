import { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';
import { EMPTY_GEOJSON } from '../lib/geo';

export const GH_HQ = { lng: -122.391, lat: 37.7823, zoom: 15 };

/**
 * Mapbox map lifecycle and the layers the tactile pin grid draws into.
 *
 * Extracted from App.jsx. The buildings, route, imagery, heading-line and
 * origin/destination-building layers went with the routing and Mapillary
 * removal; what remains is the pin grid plus the road lines it rasterises from.
 *
 * Layer order matters — the mask fill is opaque white and would hide the roads
 * and pins if added after them.
 *
 * @returns refs the caller wires into MapCanvas and the pin-grid hook.
 */
export function useMapbox({ mapboxToken, onMapClick }) {
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const mapLoadedRef = useRef(false);
  const clickHandlerRef = useRef(onMapClick);

  // Keep the click handler current without re-creating the map.
  useEffect(() => { clickHandlerRef.current = onMapClick; }, [onMapClick]);

  useEffect(() => {
    if (!mapboxToken || mapRef.current) return undefined;

    mapboxgl.accessToken = mapboxToken;

    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: 'mapbox://styles/mapbox/streets-v12',
      center: [GH_HQ.lng, GH_HQ.lat],
      zoom: GH_HQ.zoom,
      attributionControl: true,
    });

    map.addControl(new mapboxgl.NavigationControl(), 'top-right');

    map.on('load', () => {
      mapLoadedRef.current = true;

      // ---- Pin grid mask (opaque backdrop for the tactile area) ----
      map.addSource('pin-grid-mask', { type: 'geojson', data: EMPTY_GEOJSON });
      map.addLayer({
        id: 'pin-grid-mask-fill',
        type: 'fill',
        source: 'pin-grid-mask',
        paint: { 'fill-color': '#ffffff', 'fill-opacity': 0.95 },
      });

      // ---- Roads inside the tactile box ----
      map.addSource('tactile-box-roads', { type: 'geojson', data: EMPTY_GEOJSON });
      map.addLayer({
        id: 'tactile-box-roads-layer',
        type: 'line',
        source: 'tactile-box-roads',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#334155', 'line-width': 3.5, 'line-opacity': 0.9 },
      });

      map.addLayer({
        id: 'pin-grid-outline',
        type: 'line',
        source: 'pin-grid-mask',
        paint: { 'line-color': '#0f172a', 'line-width': 2.5, 'line-opacity': 0.9 },
      });

      // ---- Pins, split into raised and lowered ----
      map.addSource('pin-grid-pins', { type: 'geojson', data: EMPTY_GEOJSON });
      map.addLayer({
        id: 'pin-grid-down',
        type: 'circle',
        source: 'pin-grid-pins',
        filter: ['==', ['get', 'up'], false],
        paint: {
          'circle-radius': 2.5,
          'circle-color': '#cbd5e1',
          'circle-stroke-width': 0.5,
          'circle-stroke-color': '#94a3b8',
          'circle-opacity': 0.4,
        },
      });
      map.addLayer({
        id: 'pin-grid-up',
        type: 'circle',
        source: 'pin-grid-pins',
        filter: ['==', ['get', 'up'], true],
        paint: {
          'circle-radius': 4,
          'circle-color': '#0f172a',
          'circle-stroke-width': 1,
          'circle-stroke-color': '#facc15',
          'circle-opacity': 0.95,
        },
      });
    });

    map.on('click', (event) => {
      clickHandlerRef.current?.({ lng: event.lngLat.lng, lat: event.lngLat.lat });
    });

    mapRef.current = map;

    return () => {
      mapLoadedRef.current = false;
      map.remove();
      mapRef.current = null;
    };
  }, [mapboxToken]);

  return { mapContainerRef, mapRef, mapLoadedRef };
}
