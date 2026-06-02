import { useEffect, useMemo, useRef, useState } from 'react';

const EMBED_URL = (import.meta.env.VITE_AUDIOM_EMBED_URL || '').trim();
const API_KEY = (import.meta.env.VITE_AUDIOM_KEY || '').trim();

const AUDIOM_ORIGIN = (() => {
  try {
    return new URL(EMBED_URL).origin;
  } catch {
    return '';
  }
})();

// Iframe pixel width used as the basis for the fit-zoom calculation. The height
// is derived from the bbox aspect ratio so the viewport matches the tactile map.
const BASE_WIDTH = 320;
// Mapbox/MapLibre treat the world as TILE_SIZE * 2^zoom pixels wide. If Audiom's
// visible extent doesn't line up during debugVisual verification, this is the
// constant to recalibrate (e.g. 256 vs 512).
const TILE_SIZE = 512;

/** Approximate ground distance in meters between two { lng, lat } points. */
function metersBetween(a, b) {
  const latRad = (a.lat * Math.PI) / 180;
  const dLat = (b.lat - a.lat) * 111320;
  const dLng = (b.lng - a.lng) * 111320 * Math.cos(latRad);
  return Math.hypot(dLat, dLng);
}

// Web-Mercator normalized coordinates (0..1).
const mercX = (lng) => (lng + 180) / 360;
const mercY = (lat) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};
const invMercY = (y) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;

/**
 * Derive the center, fit-zoom, and matching iframe pixel size for a tactile bbox.
 *
 * Audiom's embed `bbox` param is broken (returns "No features found" because the
 * corners reach Overpass in the wrong order), so we reproduce the same extent
 * with `center` + `zoom`. To make Audiom's viewport corners equal the tactile
 * bbox we (1) center on the mercator midpoint, (2) size the iframe to the bbox's
 * mercator aspect ratio, and (3) pick the zoom that fits that span exactly.
 * The avatar is still positioned with absolute [lng, lat] via `moveAvatar`, so
 * framing only affects what is shown and which OSM data loads.
 */
function bboxToView(bbox) {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  const x0 = mercX(minLng);
  const x1 = mercX(maxLng);
  const yTop = mercY(maxLat);
  const yBottom = mercY(minLat);
  const dx = Math.max(Math.abs(x1 - x0), 1e-9);
  const dy = Math.max(Math.abs(yBottom - yTop), 1e-9);

  const centerLng = (minLng + maxLng) / 2;
  const centerLat = invMercY((yTop + yBottom) / 2);

  const width = BASE_WIDTH;
  const height = Math.max(1, Math.round(BASE_WIDTH * (dy / dx)));

  // Aspect is matched, so fitting width also fits height.
  const zoom = Math.log2(width / (TILE_SIZE * dx));

  return {
    centerLng,
    centerLat,
    zoom: Math.round(Math.max(1, Math.min(22, zoom)) * 100) / 100,
    width,
    height,
  };
}

/**
 * Audio-only Audiom embed driven by the tactile finger position.
 *
 * - `bbox`: tactile pin-grid bbox [minLng, minLat, maxLng, maxLat]; sets center/zoom.
 * - `coordRef`: ref holding the latest finger coordinate { lng, lat } or null.
 * - The avatar is updated via the PostMessage API, throttled to `throttleMs`.
 *
 * Stability guards (so Audiom doesn't restart its narration every tick).
 * Thresholds are fractions of the current bbox span rather than absolute
 * meters, because fingertip/homography jitter is a roughly constant share of
 * the mapped area — so in meters it grows as the tactile map zooms out. Scaling
 * by the bbox keeps the guards consistent across zoom levels.
 * - `minMoveFrac`: deadband — ignore moves smaller than this fraction of the
 *   bbox span from the last position we sent (absorbs jitter).
 * - `settleFrac`: only send once the finger has paused; while it is still
 *   sweeping (moved more than this fraction since the previous tick) we hold
 *   off, so an announcement isn't cut short mid-sweep.
 */
export function AudiomAvatar({
  bbox,
  coordRef,
  throttleMs = 1000,
  minMoveFrac = 0.04,
  settleFrac = 0.03,
  debugVisual = false,
  overlay = false,
  mapRef = null,
  zoomOffset = 0,
  offsetX = 0,
  offsetY = 0,
}) {
  const iframeRef = useRef(null);
  const readyRef = useRef(false);
  const lastSentRef = useRef(null);
  const prevTickRef = useRef(null);
  const [status, setStatus] = useState('Loading…');
  // In overlay mode we mirror the live Mapbox camera so Audiom's visual map
  // lines up pixel-for-pixel with the background/tactile map for verification.
  const [mapView, setMapView] = useState(null);
  // Debug telemetry: what we last sent vs. what Audiom reports back.
  const [sent, setSent] = useState(null);
  const [reported, setReported] = useState(null);
  const [features, setFeatures] = useState([]);

  // Larger of the bbox's width/height in meters — the reference for the
  // zoom-aware movement thresholds below.
  const spanMeters = useMemo(() => {
    if (!bbox) return 0;
    const [minLng, minLat, maxLng, maxLat] = bbox;
    const centerLat = (minLat + maxLat) / 2;
    const widthM = Math.abs(maxLng - minLng) * 111320 * Math.cos((centerLat * Math.PI) / 180);
    const heightM = Math.abs(maxLat - minLat) * 111320;
    return Math.max(widthM, heightM);
  }, [bbox]);

  // Track the Mapbox camera (overlay mode only); reload on moveend so the
  // overlay re-aligns after a pan/zoom.
  useEffect(() => {
    if (!overlay) return undefined;
    const map = mapRef?.current;
    if (!map) return undefined;
    const update = () => {
      const c = map.getCenter();
      setMapView({ centerLng: c.lng, centerLat: c.lat, zoom: map.getZoom() });
    };
    update();
    map.on('moveend', update);
    return () => map.off('moveend', update);
  }, [overlay, mapRef]);

  const view = useMemo(() => {
    if (overlay) {
      if (!mapView) return null;
      // Use raw Mapbox zoom for the iframe src — zoomOffset is applied as a CSS
      // transform so the user can calibrate visually without triggering a reload.
      const zoom = Math.round(mapView.zoom * 1000) / 1000;
      return { centerLng: mapView.centerLng, centerLat: mapView.centerLat, zoom, width: null, height: null };
    }
    return bbox ? bboxToView(bbox) : null;
  }, [overlay, mapView, bbox]);

  const showVisual = debugVisual || overlay;

  const src = useMemo(() => {
    if (!EMBED_URL || !API_KEY || !view) return '';
    // Defensive: only ever feed Audiom finite, bounded, integer-zoom params.
    // (Audiom's internal feature-distance sort throws "Invalid input" on
    // malformed coordinates, so keep these clean.)
    const lng = Number(view.centerLng);
    const lat = Number(view.centerLat);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return '';
    const clampedLat = Math.max(-85, Math.min(85, lat));
    // Use the exact fractional zoom: rounding to an integer causes a scale
    // mismatch that diverges toward the viewport edges (e.g. the harbor).
    const zoom = Math.max(1, Math.min(22, view.zoom));
    const query = [
      'sources=osm',
      `center=${lng.toFixed(6)},${clampedLat.toFixed(6)}`,
      `zoom=${zoom.toFixed(3)}`,
      `showVisualMap=${showVisual ? 'true' : 'false'}`,
      'showHeading=false',
      `allowedOrigins=${encodeURIComponent(window.location.origin)}`,
    ].join('&');
    return `${EMBED_URL}${API_KEY}&${query}`;
  }, [view, showVisual]);

  useEffect(() => {
    if (src) console.log('[Audiom] embed src:', src);
  }, [src]);

  // Reset readiness whenever the iframe reloads (bbox changed) and listen for events.
  useEffect(() => {
    if (!AUDIOM_ORIGIN) return undefined;
    readyRef.current = false;
    lastSentRef.current = null;
    prevTickRef.current = null;
    setStatus('Loading…');

    function onMessage(event) {
      if (event.origin !== AUDIOM_ORIGIN) return;
      const { type, payload } = event.data || {};
      switch (type) {
        case 'ready':
          readyRef.current = true;
          setStatus('Ready');
          break;
        case 'positionChanged':
        case 'stateChanged':
          if (payload?.position) setReported(payload.position);
          break;
        case 'featureEntered':
        case 'featureSelected':
          setFeatures((payload?.features || []).map((f) => f.name || f.type || '?'));
          break;
        case 'featureExited':
          setFeatures([]);
          break;
        case 'error':
          setStatus(`Error: ${payload?.code || 'unknown'}`);
          break;
        default:
          break;
      }
    }

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [src]);

  // Throttled avatar updates: read the latest finger coordinate once per tick.
  useEffect(() => {
    const id = setInterval(() => {
      const iframe = iframeRef.current;
      const coord = coordRef?.current;
      if (!iframe || !readyRef.current || !coord
        || !Number.isFinite(coord.lng) || !Number.isFinite(coord.lat)) {
        prevTickRef.current = coord || null;
        return;
      }

      const prev = prevTickRef.current;
      prevTickRef.current = coord;

      // Zoom-aware thresholds derived from the current bbox span.
      const settleMeters = settleFrac * spanMeters;
      const minMoveMeters = minMoveFrac * spanMeters;

      // Settle: wait until the finger has roughly stopped before announcing,
      // so we don't interrupt narration while the user is still sweeping.
      if (!prev || metersBetween(prev, coord) > settleMeters) return;

      // Deadband: ignore jitter near the last position we actually sent.
      const last = lastSentRef.current;
      if (last && metersBetween(last, coord) < minMoveMeters) return;

      iframe.contentWindow?.postMessage(
        { type: 'moveAvatar', payload: { position: [coord.lng, coord.lat] } },
        AUDIOM_ORIGIN,
      );
      lastSentRef.current = coord;
      setSent([coord.lng, coord.lat]);
    }, throttleMs);

    return () => clearInterval(id);
  }, [throttleMs, coordRef, minMoveFrac, settleFrac, spanMeters]);

  if (!EMBED_URL || !API_KEY) {
    return (
      <div className="audiom-panel audiom-panel--error">
        Set <code>VITE_AUDIOM_EMBED_URL</code> and <code>VITE_AUDIOM_KEY</code> to enable audio.
      </div>
    );
  }

  if (!src) {
    return overlay ? null : (
      <div className="audiom-panel audiom-panel--error">
        Adjust the tactile map to define an area for Audiom.
      </div>
    );
  }

  // Verification overlay: fills the map panel, transparent, non-interactive.
  if (overlay) {
    const fmt = (p) => (p ? `${p[0].toFixed(6)}, ${p[1].toFixed(6)}` : '—');
    const drift = sent && reported
      ? metersBetween({ lng: sent[0], lat: sent[1] }, { lng: reported[0], lat: reported[1] })
      : null;
    // In Web Mercator, zoom+1 = 2× scale. Apply offset as CSS transform so the
    // user can drag the slider and see the alignment change instantly.
    const scaleFactor = Math.pow(2, zoomOffset);
    return (
      <>
        <iframe
          ref={iframeRef}
          title="Audiom overlay"
          src={src}
          allow="autoplay; fullscreen"
          allowFullScreen
          className="audiom-overlay"
          style={{
            transform: `scale(${scaleFactor}) translate(${offsetX}px, ${offsetY}px)`,
            transformOrigin: 'center center',
          }}
        />
        <div className="audiom-telemetry">
          <div>Audiom · {status}</div>
          <div>zoom: {view?.zoom ?? '—'} (scale: {scaleFactor.toFixed(2)}×) · offset: {offsetX}px, {offsetY}px</div>
          <div>sent: {fmt(sent)}</div>
          <div>reported: {fmt(reported)}</div>
          <div>drift: {drift == null ? '—' : `${drift.toFixed(1)} m`}</div>
          <div>features: {features.length ? features.join(', ') : 'empty'}</div>
        </div>
      </>
    );
  }

  return (
    <div className="audiom-panel" style={{ width: view.width, height: 'auto' }}>
      <div className="audiom-panel-header">
        Audiom · {status}
        {debugVisual && view ? ` · z${view.zoom} · ${view.width}×${view.height}` : ''}
      </div>
      <iframe
        ref={iframeRef}
        title="Audiom audio map"
        src={src}
        allow="autoplay; fullscreen"
        allowFullScreen
        className="audiom-frame"
        style={{ width: view.width, height: view.height }}
      />
    </div>
  );
}
