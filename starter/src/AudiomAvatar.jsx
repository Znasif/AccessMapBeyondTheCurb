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
// Mapbox/MapLibre treat the world as TILE_SIZE * 2^zoom pixels wide.
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
 * Movement thresholds are fractions of the bbox span so jitter suppression
 * stays proportional across zoom levels:
 * - `minMoveFrac`: deadband — ignore moves smaller than this fraction of the
 *   bbox span from the last position we sent.
 * - `settleFrac`: hold off announcements while the finger is still sweeping
 *   faster than this fraction per tick.
 */
export function AudiomAvatar({
  bbox,
  coordRef,
  throttleMs = 1000,
  minMoveFrac = 0.04,
}) {
  const iframeRef = useRef(null);
  const readyRef = useRef(false);
  const lastSentRef = useRef(null);
  const [status, setStatus] = useState('Loading…');

  const spanMeters = useMemo(() => {
    if (!bbox) return 0;
    const [minLng, minLat, maxLng, maxLat] = bbox;
    const centerLat = (minLat + maxLat) / 2;
    const widthM = Math.abs(maxLng - minLng) * 111320 * Math.cos((centerLat * Math.PI) / 180);
    const heightM = Math.abs(maxLat - minLat) * 111320;
    return Math.max(widthM, heightM);
  }, [bbox]);

  const view = useMemo(() => (bbox ? bboxToView(bbox) : null), [bbox]);

  const src = useMemo(() => {
    if (!EMBED_URL || !API_KEY || !view) return '';
    const lng = Number(view.centerLng);
    const lat = Number(view.centerLat);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return '';
    const clampedLat = Math.max(-85, Math.min(85, lat));
    const zoom = Math.max(1, Math.min(22, view.zoom));
    const query = [
      'sources=osm',
      `center=${lng.toFixed(6)},${clampedLat.toFixed(6)}`,
      `zoom=${zoom.toFixed(3)}`,
      'showVisualMap=true',
      'showHeading=false',
      `allowedOrigins=${encodeURIComponent(window.location.origin)}`,
    ].join('&');
    return `${EMBED_URL}${API_KEY}&${query}`;
  }, [view]);

  // Reset readiness whenever the iframe reloads and listen for events.
  useEffect(() => {
    if (!AUDIOM_ORIGIN) return undefined;
    readyRef.current = false;
    lastSentRef.current = null;
    setStatus('Loading…');

    function onMessage(event) {
      if (event.origin !== AUDIOM_ORIGIN) return;
      const { type, payload } = event.data || {};
      switch (type) {
        case 'ready':
          readyRef.current = true;
          setStatus('Ready');
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

  // Throttled avatar updates.
  useEffect(() => {
    const id = setInterval(() => {
      const iframe = iframeRef.current;
      const coord = coordRef?.current;
      if (!iframe || !readyRef.current || !coord
        || !Number.isFinite(coord.lng) || !Number.isFinite(coord.lat)) {
        prevTickRef.current = coord || null;
        return;
      }

      const minMoveMeters = minMoveFrac * spanMeters;
      const last = lastSentRef.current;
      if (last && metersBetween(last, coord) < minMoveMeters) return;

      iframe.contentWindow?.postMessage(
        { type: 'moveAvatar', payload: { position: [coord.lng, coord.lat] } },
        AUDIOM_ORIGIN,
      );
      lastSentRef.current = coord;
    }, throttleMs);

    return () => clearInterval(id);
  }, [throttleMs, coordRef, minMoveFrac, spanMeters]);

  if (!EMBED_URL || !API_KEY) {
    return (
      <div className="audiom-panel audiom-panel--error">
        Set <code>VITE_AUDIOM_EMBED_URL</code> and <code>VITE_AUDIOM_KEY</code> to enable audio.
      </div>
    );
  }

  if (!src) {
    return (
      <div className="audiom-panel audiom-panel--error">
        Adjust the tactile map to define an area for Audiom.
      </div>
    );
  }

  return (
    <div className="audiom-panel" style={{ width: view.width, height: 'auto' }}>
      <div className="audiom-panel-header">Audiom · {status}</div>
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
