import { useEffect, useMemo, useRef, useState } from 'react';
import { AUDIOM_ORIGIN, AUDIOM_KEY, buildEmbedSrc, bboxSpanMeters } from './audiom';

/** Approx ground distance (m) between two { lng, lat } points. */
function metersBetween(a, b) {
  const latRad = (a.lat * Math.PI) / 180;
  const dLat = (b.lat - a.lat) * 111320;
  const dLng = (b.lng - a.lng) * 111320 * Math.cos(latRad);
  return Math.hypot(dLat, dLng);
}

/**
 * Audiom embed (any map: /embed/d/<id>, /embed/<id>, or a dynamic source),
 * with the avatar driven by the tactile fingertip via the PostMessage API.
 *
 * The embed is loaded ONCE and never reloaded on scale changes — there is no
 * view-control command in the PostMessage API, so a zoom change would mean a
 * full re-load (10-30 s on a large map). The tactile window is our own math;
 * the rendered view is a debug aid. Use `syncKey` to force a reload when you
 * do want the display to match the current window.
 *
 * Props:
 *  - embedId / mapId / sources : what to load (see audiom.js).
 *  - view      : { centerLng, centerLat, zoom, width, height } — only used for
 *                the initial src and the iframe box.
 *  - bbox      : the current tactile window; sizes the movement deadband.
 *  - coordRef  : ref holding the latest fingertip { lng, lat } or null.
 *  - onStart   : called once with the avatar's start [lng,lat] — a point
 *                guaranteed to be inside the map, used to centre the window.
 */
export function AudiomMap({
  embedId, mapId, sources, view, bbox, coordRef,
  throttleMs = 500, stepMeters = 0, onEvent, onStart, onBounds,
  syncKey = 0, syncView = false, fill = false,
}) {
  const iframeRef = useRef(null);
  const readyRef = useRef(false);
  const lastSentRef = useRef(null);
  const discoveredRef = useRef(false);
  const [status, setStatus] = useState('Idle');
  const [lastFeature, setLastFeature] = useState('');

  // Only include center/zoom when explicitly syncing the display, so ordinary
  // scale changes don't churn the iframe.
  const src = useMemo(() => {
    const viewArgs = syncView && view
      ? { center: { lng: view.centerLng, lat: view.centerLat }, zoom: view.zoom }
      : {};
    if (mapId) return buildEmbedSrc({ mapId, ...viewArgs });
    if (embedId) return buildEmbedSrc({ embedId, ...viewArgs });
    if (sources) return buildEmbedSrc({ sources, ...viewArgs });
    return '';
    // syncKey is in the deps so "Sync view" can force a reload.
  }, [mapId, embedId, sources, syncView, view, syncKey]);

  // Deadband: emit only after the finger crosses a meaningful ground distance.
  // Derived from the ACTUAL tactile window (not a default view), so it scales
  // from a room-sized diagram to a whole state.
  const deadbandMeters = useMemo(() => {
    if (stepMeters > 0) return stepMeters * 0.6;
    if (!bbox) return 0;
    return 0.01 * bboxSpanMeters(bbox);
  }, [stepMeters, bbox]);

  useEffect(() => {
    if (!AUDIOM_ORIGIN || !src) return undefined;
    readyRef.current = false;
    lastSentRef.current = null;
    discoveredRef.current = false;
    setStatus('Loading…');

    const post = (m) => iframeRef.current?.contentWindow?.postMessage(m, AUDIOM_ORIGIN);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const getState = () => new Promise((resolve) => {
      let done = false;
      const h = (e) => {
        if (e.origin !== AUDIOM_ORIGIN || e.data?.type !== 'stateChanged') return;
        if (done) return; done = true;
        window.removeEventListener('message', h);
        resolve(e.data.payload?.position || null);
      };
      window.addEventListener('message', h);
      post({ type: 'getState' });
      setTimeout(() => { if (!done) { done = true; window.removeEventListener('message', h); resolve(null); } }, 1200);
    });

    // Oracle: a movement command only moves the avatar while it is INSIDE the
    // map. Verified on a geographic map, a spatial diagram and a heatmap, so it
    // needs no per-map knowledge.
    //
    // `probe` is deliberately PERPENDICULAR to the edge being searched: testing
    // the north edge with a vertical step would be blocked by the edge itself
    // and read as "outside", so vertical edges are tested with a horizontal step
    // and vice versa.
    const isInside = async (lng, lat, probe) => {
      post({ type: 'moveAvatar', payload: { position: [lng, lat] } });
      await sleep(200);
      const before = await getState();
      if (!before) return null;
      post({ type: 'executeCommand', payload: { command: probe } });
      await sleep(220);
      const after = await getState();
      if (!after) return null;
      return Math.hypot(after[0] - before[0], after[1] - before[1]) > 1e-9;
    };

    // Binary search one edge outward from a known-inside point.
    const findEdge = async (from, axis, dir, probe) => {
      const at = (d) => (axis === 'lng' ? [from[0] + d, from[1]] : [from[0], from[1] + d]);
      let inside = 0;
      let outside = null;
      for (let d = 0.5; d <= 200; d *= 2) {       // expand until we're outside
        const p = at(dir * d);
        const ok = await isInside(p[0], p[1], probe);
        if (ok === null) return null;
        if (ok) inside = dir * d; else { outside = dir * d; break; }
      }
      if (outside === null) return null;
      for (let i = 0; i < 10; i++) {               // then bisect
        const mid = (inside + outside) / 2;
        const p = at(mid);
        const ok = await isInside(p[0], p[1], probe);
        if (ok === null) break;
        if (ok) inside = mid; else outside = mid;
      }
      const edge = at((inside + outside) / 2);
      return axis === 'lng' ? edge[0] : edge[1];
    };

    async function discoverBounds(start) {
      const west  = (setStatus('Bounds… W'), await findEdge(start, 'lng', -1, 'up'));
      const east  = (setStatus('Bounds… E'), await findEdge(start, 'lng', +1, 'up'));
      const south = (setStatus('Bounds… S'), await findEdge(start, 'lat', -1, 'left'));
      const north = (setStatus('Bounds… N'), await findEdge(start, 'lat', +1, 'left'));
      post({ type: 'moveAvatar', payload: { position: start } }); // restore
      setStatus('Ready');
      if ([west, east, south, north].every((v) => Number.isFinite(v))
          && east > west && north > south) {
        onBounds?.([west, south, east, north]);
      }
    }

    function onMessage(event) {
      if (event.origin !== AUDIOM_ORIGIN) return;
      const { type, payload } = event.data || {};
      switch (type) {
        case 'ready': {
          readyRef.current = true;
          setStatus('Ready');
          // The avatar's start position is always inside the map, whatever the
          // map's coordinate system — the seed for both centring and discovery.
          const h = (e) => {
            if (e.origin !== AUDIOM_ORIGIN || e.data?.type !== 'stateChanged') return;
            window.removeEventListener('message', h);
            const p = e.data.payload?.position;
            if (p && Number.isFinite(p[0]) && Number.isFinite(p[1])) {
              onStart?.(p);
              if (onBounds && !discoveredRef.current) {
                discoveredRef.current = true;
                discoverBounds(p);
              }
            }
          };
          window.addEventListener('message', h);
          post({ type: 'getState' });
          setTimeout(() => window.removeEventListener('message', h), 3000);
          break;
        }
        case 'featureEntered':
        case 'featureSelected': {
          const names = (payload?.features || []).map((f) => f.name).filter(Boolean);
          if (names.length) setLastFeature(names.join(', '));
          break;
        }
        case 'error':
          setStatus(`Error: ${payload?.code || 'unknown'}`);
          break;
        default:
          break;
      }
      onEvent?.(type, payload);
    }

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [src, onEvent, onStart, onBounds]);

  // Throttled avatar updates from the shared fingertip ref.
  useEffect(() => {
    const id = setInterval(() => {
      const iframe = iframeRef.current;
      const coord = coordRef?.current;
      if (!iframe || !readyRef.current || !coord ||
          !Number.isFinite(coord.lng) || !Number.isFinite(coord.lat)) return;
      const last = lastSentRef.current;
      if (last && metersBetween(last, coord) < deadbandMeters) return;
      iframe.contentWindow?.postMessage(
        { type: 'moveAvatar', payload: { position: [coord.lng, coord.lat] } },
        AUDIOM_ORIGIN,
      );
      lastSentRef.current = coord;
    }, throttleMs);
    return () => clearInterval(id);
  }, [throttleMs, coordRef, deadbandMeters]);

  if (!AUDIOM_KEY) {
    return (
      <div className="audiom-panel audiom-panel--error">
        Set <code>VITE_AUDIOM_FULL_ACCESS_KEY</code> in <code>.env</code> to enable Audiom.
      </div>
    );
  }
  if (!src) {
    return (
      <div className="audiom-panel audiom-panel--error">
        Choose a map or source above to load it.
      </div>
    );
  }

  return (
    <div
      className={`audiom-panel${fill ? ' audiom-panel--fill' : ''}`}
      style={fill ? undefined : { width: view?.width }}
    >
      <div className="audiom-panel-header">
        Audiom · {status}{lastFeature ? ` · ${lastFeature}` : ''}
      </div>
      <iframe
        ref={iframeRef}
        title="Audiom map"
        src={src}
        allow="autoplay; fullscreen"
        allowFullScreen
        className="audiom-frame"
        style={fill ? undefined : { width: view?.width, height: view?.height }}
      />
    </div>
  );
}
