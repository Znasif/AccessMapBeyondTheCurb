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

/**
 * Derive a center + zoom that frames a tactile bbox.
 *
 * Audiom's embed `bbox` param is currently broken (returns "No features found"
 * because the corners reach Overpass in the wrong order), so we approximate the
 * same extent with `center` + `zoom`. The avatar is positioned with absolute
 * [lng, lat] via `moveAvatar`, so framing only affects which OSM data loads.
 */
function bboxToCenterZoom(bbox) {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  const centerLng = (minLng + maxLng) / 2;
  const centerLat = (minLat + maxLat) / 2;
  const lngSpan = Math.max(Math.abs(maxLng - minLng), 1e-6);
  const latSpan = Math.max(Math.abs(maxLat - minLat), 1e-6);
  // World-tile fit on each axis; take the tighter one and pad by one level.
  const zoom = Math.min(Math.log2(360 / lngSpan), Math.log2(180 / latSpan)) - 1;
  const clamped = Math.max(10, Math.min(18, zoom));
  return { centerLng, centerLat, zoom: Math.round(clamped * 10) / 10 };
}

/**
 * Audio-only Audiom embed driven by the tactile finger position.
 *
 * - `bbox`: tactile pin-grid bbox [minLng, minLat, maxLng, maxLat]; sets center/zoom.
 * - `coordRef`: ref holding the latest finger coordinate { lng, lat } or null.
 * - The avatar is updated via the PostMessage API, throttled to `throttleMs`.
 */
export function AudiomAvatar({ bbox, coordRef, throttleMs = 1000 }) {
  const iframeRef = useRef(null);
  const readyRef = useRef(false);
  const lastSentRef = useRef(null);
  const [status, setStatus] = useState('Loading…');

  const src = useMemo(() => {
    if (!EMBED_URL || !API_KEY || !bbox) return '';
    const { centerLng, centerLat, zoom } = bboxToCenterZoom(bbox);
    const query = [
      'sources=osm',
      `center=${centerLng},${centerLat}`,
      `zoom=${zoom}`,
      'showVisualMap=false',
      `allowedOrigins=${encodeURIComponent(window.location.origin)}`,
    ].join('&');
    return `${EMBED_URL}${API_KEY}&${query}`;
  }, [bbox]);

  // Reset readiness whenever the iframe reloads (bbox changed) and listen for events.
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

  // Throttled avatar updates: read the latest finger coordinate once per tick.
  useEffect(() => {
    const id = setInterval(() => {
      const iframe = iframeRef.current;
      const coord = coordRef?.current;
      if (!iframe || !readyRef.current || !coord) return;

      const last = lastSentRef.current;
      if (last && last[0] === coord.lng && last[1] === coord.lat) return;

      iframe.contentWindow?.postMessage(
        { type: 'moveAvatar', payload: { position: [coord.lng, coord.lat] } },
        AUDIOM_ORIGIN,
      );
      lastSentRef.current = [coord.lng, coord.lat];
    }, throttleMs);

    return () => clearInterval(id);
  }, [throttleMs, coordRef]);

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
    <div className="audiom-panel">
      <div className="audiom-panel-header">Audiom · {status}</div>
      <iframe
        ref={iframeRef}
        title="Audiom audio map"
        src={src}
        allow="autoplay; fullscreen"
        allowFullScreen
        className="audiom-frame"
      />
    </div>
  );
}
