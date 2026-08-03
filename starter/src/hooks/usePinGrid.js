import { useEffect, useRef, useState } from 'react';
import {
  computeScaleBBox,
  rasterizeRoads,
  pinGridToGeoJSON,
  queryRoadFeatures,
  MIN_ZOOM,
} from '../pinGrid';
import { EMPTY_GEOJSON, clipRoadsToBBox, shrinkBboxToGrid } from '../lib/geo';

const PIN_LAYERS = [
  'pin-grid-mask-fill',
  'tactile-box-roads-layer',
  'pin-grid-outline',
  'pin-grid-down',
  'pin-grid-up',
];

// Hidden while the camera explorer runs: the physical material is the display,
// and leaving the on-screen grid up encourages sighted debugging of the wrong
// artefact.
const EXPLORER_HIDDEN_LAYERS = [
  'pin-grid-up',
  'pin-grid-down',
  'pin-grid-mask-fill',
  'pin-grid-outline',
];

/**
 * Derive the tactile pin grid from whatever the map is currently showing, and
 * keep it in sync with pan/zoom.
 *
 * Extracted from App.jsx unchanged in behaviour. Returns `pinBbox` (the artwork
 * area, after applying calibrated corner fractions) and `pinGridRawRef`, both
 * of which TactileExplorer needs.
 */
export function usePinGrid({
  mapRef,
  mapLoadedRef,
  showTactile,
  showExplorer,
  pinScale,
  bboxPadding,
  cornerFractionsRef,
}) {
  const [pinBbox, setPinBbox] = useState(null);
  const pinGridRawRef = useRef(null);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return undefined;

    const clear = () => {
      if (!mapLoadedRef.current) return;
      map.getSource('pin-grid-pins')?.setData(EMPTY_GEOJSON);
      map.getSource('pin-grid-mask')?.setData(EMPTY_GEOJSON);
      map.getSource('tactile-box-roads')?.setData(EMPTY_GEOJSON);
    };

    if (!showTactile) {
      clear();
      return undefined;
    }

    const computeGrid = () => {
      if (!mapLoadedRef.current) return;

      // Below MIN_ZOOM the rendered road features are too generalised to
      // rasterise meaningfully.
      if (map.getZoom() < MIN_ZOOM) {
        map.getSource('pin-grid-pins')?.setData(EMPTY_GEOJSON);
        map.getSource('pin-grid-mask')?.setData(EMPTY_GEOJSON);
        return;
      }

      const fullBbox = computeScaleBBox(map, pinScale, bboxPadding);
      // The explorer warps to the artwork area only, not the sheet edge.
      const bbox = cornerFractionsRef?.current
        ? shrinkBboxToGrid(fullBbox, cornerFractionsRef.current)
        : fullBbox;
      setPinBbox(bbox);

      const roads = queryRoadFeatures(map, bbox);
      const grid = rasterizeRoads(roads, bbox);
      pinGridRawRef.current = grid;

      const { pinGeoJSON, maskGeoJSON } = pinGridToGeoJSON(grid, bbox);
      map.getSource('pin-grid-pins')?.setData(pinGeoJSON);
      map.getSource('pin-grid-mask')?.setData(maskGeoJSON);
      map.getSource('tactile-box-roads')?.setData(clipRoadsToBBox(roads, bbox));
    };

    map.on('moveend', computeGrid);
    computeGrid();
    return () => map.off('moveend', computeGrid);
  }, [mapRef, mapLoadedRef, showTactile, pinScale, bboxPadding, cornerFractionsRef]);

  // Show/hide the whole pin-grid stack with the tactile toggle.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoadedRef.current) return;
    for (const id of PIN_LAYERS) {
      if (map.getLayer(id)) {
        map.setLayoutProperty(id, 'visibility', showTactile ? 'visible' : 'none');
      }
    }
  }, [mapRef, mapLoadedRef, showTactile]);

  // Hide the on-screen pins while the camera explorer is driving.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoadedRef.current) return;
    const vis = showExplorer ? 'none' : 'visible';
    for (const id of EXPLORER_HIDDEN_LAYERS) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis);
    }
  }, [mapRef, mapLoadedRef, showExplorer]);

  return { pinBbox, pinGridRawRef };
}
