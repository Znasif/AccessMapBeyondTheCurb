import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';

import Sidebar from './components/Sidebar';
import MapCanvas from './components/MapCanvas';
import LocationSearch from './components/LocationSearch';
import TactilePanel from './components/TactilePanel';
import { useMapbox, GH_HQ } from './hooks/useMapbox';
import { usePinGrid } from './hooks/usePinGrid';
import { featureToPoint, featureToLabel, reverseLookup } from './lib/geocoding';
import { syncPointMarker } from './lib/mapMarkers';
import { TactileExplorer } from './TactileExplorer';
import { AudiomAvatar } from './AudiomAvatar';

/**
 * Tactile Map Explorer.
 *
 * Composition root only — map lifecycle lives in useMapbox, grid derivation in
 * usePinGrid, and the panels are presentational components.
 *
 * The AccessMap routing stack, Mapillary frontage imagery and the YOLO entrance
 * detector were removed from this branch; they remain on `main` and `streetui`.
 */
export default function App() {
  const mapboxToken = (import.meta.env.VITE_MAPBOX_TOKEN || '').trim();

  // Location
  const [query, setQuery] = useState('');
  const [point, setPoint] = useState(null);

  // Tactile grid
  const [showTactile, setShowTactile] = useState(true);
  const [pinScale, setPinScale] = useState(5000);
  const [bboxPadding, setBboxPadding] = useState(0.15);
  const [showExplorer, setShowExplorer] = useState(false);
  const [showAudiom, setShowAudiom] = useState(false);
  const [groundTruthProbe, setGroundTruthProbe] = useState(null);

  const placeMarkerRef = useRef(null);
  const probeMarkerRef = useRef(null);
  const fingerCoordRef = useRef(null);
  const cornerFractionsRef = useRef(null);

  // Bias geocoder results toward what the user is looking at.
  const proximity = useMemo(
    () => (point ? { lng: point.lng, lat: point.lat } : { lng: GH_HQ.lng, lat: GH_HQ.lat }),
    [point],
  );

  // While the explorer runs, a map click drops a ground-truth reference marker
  // to check registration against; otherwise it sets the location.
  const explorerActive = showExplorer && showTactile;
  const handleMapClick = useCallback(
    async (clicked) => {
      if (explorerActive) {
        setGroundTruthProbe(clicked);
        return;
      }
      setPoint(clicked);
      setQuery(await reverseLookup(clicked, mapboxToken));
    },
    [explorerActive, mapboxToken],
  );

  const { mapContainerRef, mapRef, mapLoadedRef } = useMapbox({
    mapboxToken,
    onMapClick: handleMapClick,
  });

  const { pinBbox, pinGridRawRef } = usePinGrid({
    mapRef,
    mapLoadedRef,
    showTactile,
    showExplorer,
    pinScale,
    bboxPadding,
    cornerFractionsRef,
  });

  // Corner fractions shrink the full-device bbox down to just the pin area.
  //
  // brailledoodle_corners.json stores the four calibrated corners as PIXEL
  // coordinates in braille.png, so they only become fractions once divided by
  // that image's natural dimensions — hence loading the template alongside it.
  // Assigning the raw array here yields undefined for every side in
  // shrinkBboxToGrid, which turns the whole bbox into NaN.
  useEffect(() => {
    let cancelled = false;

    Promise.all([
      fetch('/brailledoodle_corners.json').then((r) => r.json()),
      new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
        img.onerror = () => resolve(null);
        img.src = '/braille.png';
      }),
    ])
      .then(([cornersData, dims]) => {
        if (cancelled || !cornersData || !dims) return;
        const corners = Object.values(cornersData)[0];
        if (!corners || corners.length < 4) return;

        const [tl, tr, br, bl] = corners;
        cornerFractionsRef.current = {
          left: Math.min(tl[0], bl[0]) / dims.w,
          right: Math.max(tr[0], br[0]) / dims.w,
          top: Math.min(tl[1], tr[1]) / dims.h,
          bottom: Math.max(bl[1], br[1]) / dims.h,
        };
      })
      .catch(() => { /* uncalibrated: usePinGrid falls back to the full bbox */ });

    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    syncPointMarker(mapRef.current, placeMarkerRef, point, 'place');
  }, [mapRef, point]);

  // Fly to a newly chosen location.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !point) return;
    map.easeTo({ center: [point.lng, point.lat], duration: 600 });
  }, [mapRef, point]);

  // Clear any stale probe when the explorer is switched off.
  useEffect(() => {
    if (!explorerActive) setGroundTruthProbe(null);
  }, [explorerActive]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (!groundTruthProbe) {
      probeMarkerRef.current?.remove();
      probeMarkerRef.current = null;
      return;
    }

    if (!probeMarkerRef.current) {
      const el = document.createElement('div');
      el.className = 'probe-marker';
      el.innerHTML = '✛';
      probeMarkerRef.current = new mapboxgl.Marker({ element: el, anchor: 'center' })
        .setLngLat([groundTruthProbe.lng, groundTruthProbe.lat])
        .addTo(map);
    } else {
      probeMarkerRef.current.setLngLat([groundTruthProbe.lng, groundTruthProbe.lat]);
    }
  }, [mapRef, groundTruthProbe]);

  const handleSelectFeature = useCallback((feature) => {
    const selected = featureToPoint(feature);
    if (!selected) return;
    const label = featureToLabel(feature);
    setPoint({ ...selected, label });
    setQuery(label);
  }, []);

  return (
    <div className="app-shell">
      <Sidebar>
        <LocationSearch
          query={query}
          onQueryChange={setQuery}
          point={point}
          onSelectFeature={handleSelectFeature}
          accessToken={mapboxToken}
          proximity={proximity}
        />
        <TactilePanel
          showTactile={showTactile}
          onShowTactileChange={setShowTactile}
          pinScale={pinScale}
          onPinScaleChange={setPinScale}
          bboxPadding={bboxPadding}
          onBboxPaddingChange={setBboxPadding}
          showExplorer={showExplorer}
          onShowExplorerChange={setShowExplorer}
          showAudiom={showAudiom}
          onShowAudiomChange={setShowAudiom}
          hasMapboxToken={Boolean(mapboxToken)}
        />
      </Sidebar>

      <MapCanvas containerRef={mapContainerRef} hasToken={Boolean(mapboxToken)}>
        {showExplorer && showTactile && (
          <TactileExplorer
            bbox={pinBbox}
            mapRef={mapRef}
            mapLoadedRef={mapLoadedRef}
            templateUrl="/braille.png"
            pinGridRef={pinGridRawRef}
            onCoord={(coord) => { fingerCoordRef.current = coord; }}
            groundTruthProbe={groundTruthProbe}
          />
        )}

        {showAudiom && showTactile && (
          <AudiomAvatar bbox={pinBbox} coordRef={fingerCoordRef} throttleMs={1000} />
        )}
      </MapCanvas>
    </div>
  );
}
