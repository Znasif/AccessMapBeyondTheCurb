import { useEffect, useMemo, useRef, useState } from 'react';
import { AUDIOM_ORIGIN, AUDIOM_KEY, buildEmbedSrc, viewToBbox, bboxSpanMeters } from './audiom';

/** Approx ground distance (m) between two { lng, lat } points. */
function metersBetween(a, b) {
  const latRad = (a.lat * Math.PI) / 180;
  const dLat = (b.lat - a.lat) * 111320;
  const dLng = (b.lng - a.lng) * 111320 * Math.cos(latRad);
  return Math.hypot(dLat, dLng);
}

/**
 * Static Audiom embed (any saved map id, any data source — no `sources=osm`),
 * with the avatar driven by the tactile fingertip via the PostMessage API.
 *
 * Props:
 *  - mapId      : numeric Audiom map id (string).
 *  - view       : { centerLng, centerLat, zoom, width, height } — pins the extent.
 *  - coordRef   : ref holding the latest fingertip { lng, lat } or null.
 *  - stepMeters : the map's announced step size (deadband is matched to it).
 *  - onEvent    : optional (type, payload) callback for ready/feature events.
 */
export function AudiomMap({ embedId, mapId, sources, view, coordRef, throttleMs = 700, stepMeters = 0, onEvent, onBounds }) {
  const iframeRef = useRef(null);
  const readyRef = useRef(false);
  const lastSentRef = useRef(null);
  const calibratedRef = useRef(false);
  const [status, setStatus] = useState('Idle');
  const [lastFeature, setLastFeature] = useState('');

  const src = useMemo(() => {
    if (mapId) return buildEmbedSrc({ mapId });      // saved map-editor map (/embed/d/<id>)
    if (embedId) return buildEmbedSrc({ embedId });  // pre-configured embed (/embed/<id>)
    if (sources && view) return buildEmbedSrc({
      sources,
      center: { lng: view.centerLng, lat: view.centerLat },
      zoom: view.zoom,
    });
    return '';
  }, [mapId, embedId, sources, view]);

  // Deadband: only send once the finger crosses ~one map step (falls back to a
  // fraction of the extent when the step size isn't known).
  const deadbandMeters = useMemo(() => {
    if (stepMeters > 0) return stepMeters * 0.6;
    if (!view) return 0;
    return 0.02 * bboxSpanMeters(viewToBbox(view));
  }, [stepMeters, view]);

  useEffect(() => {
    if (!AUDIOM_ORIGIN || !src) return undefined;
    readyRef.current = false;
    lastSentRef.current = null;
    calibratedRef.current = false;
    setStatus('Loading…');

    const post = (m) => iframeRef.current?.contentWindow?.postMessage(m, AUDIOM_ORIGIN);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const dist = (a, b) => (a && b ? Math.hypot(a[0] - b[0], a[1] - b[1]) : Infinity);

    // Ask the embed for the avatar's current [lng,lat]; resolves on stateChanged.
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
      setTimeout(() => { if (!done) { done = true; window.removeEventListener('message', h); resolve(null); } }, 1500);
    });

    // One step in a direction; resolves with the new [lng,lat], or null if it didn't move.
    const stepOnce = (command) => new Promise((resolve) => {
      let done = false;
      const h = (e) => {
        if (e.origin !== AUDIOM_ORIGIN || e.data?.type !== 'positionChanged') return;
        if (done) return; done = true;
        window.removeEventListener('message', h);
        resolve(e.data.payload?.position || null);
      };
      window.addEventListener('message', h);
      post({ type: 'executeCommand', payload: { command } });
      setTimeout(() => { if (!done) { done = true; window.removeEventListener('message', h); resolve(null); } }, 300);
    });

    // Walk to the map edge ONE step at a time. Bursts of commands get throttled and
    // stall well short of the edge (breaks state-sized maps); single steps are
    // reliable and won't flood the embed. Stop once two steps in a row don't move.
    const walk = async (command, cap = 260) => {
      let cur = await getState();
      if (!cur) return null;
      let stalls = 0;
      for (let i = 0; i < cap; i++) {
        const next = await stepOnce(command);
        if (!next || dist(cur, next) < 1e-9) { if (++stalls >= 2) return cur; continue; }
        stalls = 0; cur = next;
      }
      return cur;
    };

    // A self-contained embed carries its own extent that the API doesn't expose, so
    // we discover it by walking to each of the four edges, then restore the avatar.
    async function calibrate() {
      if (calibratedRef.current) return;
      calibratedRef.current = true;
      const start = await getState();
      if (!start) { setStatus('Ready'); return; }
      const toStart = async () => { post({ type: 'moveAvatar', payload: { position: start } }); await sleep(250); };
      const edge = {};
      for (const [cmd, label] of [['up', 'N'], ['down', 'S'], ['left', 'W'], ['right', 'E']]) {
        setStatus(`Calibrating bounds… ${label}`);
        await toStart();
        edge[cmd] = await walk(cmd);
      }
      await toStart(); // restore
      const { up, down, left, right } = edge;
      if (up && down && left && right) {
        const bbox = [
          Math.min(left[0], right[0]), Math.min(up[1], down[1]),
          Math.max(left[0], right[0]), Math.max(up[1], down[1]),
        ];
        // reject a degenerate box (calibration failed) so we don't map onto a point
        if (Math.abs(bbox[2] - bbox[0]) > 1e-6 && Math.abs(bbox[3] - bbox[1]) > 1e-6) {
          onBounds?.(bbox);
        }
      }
      setStatus('Ready');
    }

    function onMessage(event) {
      if (event.origin !== AUDIOM_ORIGIN) return;
      const { type, payload } = event.data || {};
      switch (type) {
        case 'ready':
          readyRef.current = true;
          setStatus('Ready');
          if ((embedId || mapId) && onBounds) calibrate(); // discover the embed's real bounds
          break;
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
  }, [src, onEvent, embedId, mapId, onBounds]);

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
        Set <code>VITE_AUDIOM_KEY</code> in <code>.env</code> to enable Audiom.
      </div>
    );
  }
  if (!src) {
    return (
      <div className="audiom-panel audiom-panel--error">
        Choose a data source above to load the map.
      </div>
    );
  }

  return (
    <div className="audiom-panel" style={{ width: view.width }}>
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
        style={{ width: view.width, height: view.height }}
      />
    </div>
  );
}
