import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AUDIOM_ORIGIN, AUDIOM_KEY, buildEmbedSrc, bboxSpanMeters } from './audiom';
import { createAudiomChannel, INBOUND, whatsHere as whatsHereAnswer } from './lib/audiomChannel';
import { speak } from './lib/speak';

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
 *  - featureRef: optional ref this component WRITES the last `featureEntered`
 *                record into — the outbound mirror of `coordRef`, so the M7
 *                dispatcher can answer `whats_here` with a synchronous read
 *                and no round trip (§2.2).
 *  - onChannel : handed `{ channel, whatsHere }` once the side-effect channel
 *                exists. The seam M7/M13 drive `moveAvatar`, `executeCommand`
 *                and `route_to` mode `fly_me_there` through. Pass a stable
 *                callback: it is re-invoked whenever its identity changes.
 *
 * ⚠️ The raw postMessage protocol is NOT owned here any more — it lives in
 * `lib/audiomChannel.js` (milestone 5b), which is platform-free and covered by
 * `scripts/test_audiom_channel.mjs`. This component is a consumer.
 */
export function AudiomMap({
  embedId, mapId, sources, view, bbox, coordRef,
  throttleMs = 500, stepMeters = 0, onEvent, onStart, onBounds,
  syncKey = 0, syncView = false, fill = false,
  featureRef, onChannel,
}) {
  const iframeRef = useRef(null);
  const readyRef = useRef(false);
  const lastSentRef = useRef(null);
  const discoveredRef = useRef(false);
  const [status, setStatus] = useState('Idle');

  /**
   * The last named feature the avatar entered.
   *
   * `lastFeatureRef` is the source a dispatcher reads SYNCHRONOUSLY; the
   * `lastFeature` string exists only so React re-renders the status line. Both
   * are written in one place, from the one channel event, so they cannot drift.
   */
  const lastFeatureRef = useRef(null);
  const [lastFeature, setLastFeature] = useState('');

  /**
   * One channel for the component's whole life, NOT one per `src`: `post`
   * resolves `iframeRef.current.contentWindow` lazily, so a reload swaps the
   * target underneath it without needing a new channel or a new window listener.
   */
  const channel = useMemo(() => {
    if (!AUDIOM_ORIGIN) return null;
    return createAudiomChannel({
      origin: AUDIOM_ORIGIN,
      post: (message, origin) => {
        const target = iframeRef.current?.contentWindow;
        if (!target) return false;
        target.postMessage(message, origin);
        return true;
      },
      subscribe: (handler) => {
        const onWindowMessage = (e) => handler({ origin: e.origin, data: e.data });
        window.addEventListener('message', onWindowMessage);
        return () => window.removeEventListener('message', onWindowMessage);
      },
    });
  }, []);
  useEffect(() => () => channel?.dispose(), [channel]);

  /**
   * Console handle. The M7 staleness threshold (`LIVE_FEATURE_MAX_AGE_MS`) is
   * currently a guess, and the only way to replace it with a number is to watch
   * a real map. From the browser console, on a live session:
   *
   *   audiomChannel.enableFeatureTiming({ label: 'map 885' })
   *   … move the avatar around for a minute …
   *   audiomChannel.dumpFeatureTiming()
   *
   * Recording is off until that first call, so this costs nothing by default.
   */
  useEffect(() => {
    if (!channel || typeof window === 'undefined') return undefined;
    window.audiomChannel = channel;
    return () => { if (window.audiomChannel === channel) delete window.audiomChannel; };
  }, [channel]);

  /**
   * L0 `whats_here` (§2.2 / design doc §3.2): a synchronous ref read plus an
   * utterance, and nothing else. No model, no network, no adjacency — the
   * payload carries names only, and under tier C that IS the answer.
   */
  const whatsHere = useCallback(() => {
    const answer = whatsHereAnswer(lastFeatureRef.current);
    speak(answer);
    return answer;
  }, []);

  useEffect(() => {
    if (channel) onChannel?.({ channel, whatsHere });
  }, [channel, whatsHere, onChannel]);

  // The live feature stream. Names only under tier C — that is the whole answer,
  // and it must not escalate for adjacency this world cannot supply.
  useEffect(() => {
    if (!channel) return undefined;
    return channel.onFeature((record) => {
      lastFeatureRef.current = record;
      if (featureRef) featureRef.current = record;
      setLastFeature(record.text);
    });
  }, [channel, featureRef]);

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
    if (!channel || !src) return undefined;
    readyRef.current = false;
    lastSentRef.current = null;
    discoveredRef.current = false;
    setStatus('Loading…');

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // Oracle: a movement command only moves the avatar while it is INSIDE the
    // map. Verified on a geographic map, a spatial diagram and a heatmap, so it
    // needs no per-map knowledge.
    //
    // `probe` is deliberately PERPENDICULAR to the edge being searched: testing
    // the north edge with a vertical step would be blocked by the edge itself
    // and read as "outside", so vertical edges are tested with a horizontal step
    // and vice versa.
    const isInside = async (lng, lat, probe) => {
      channel.moveAvatar([lng, lat]);
      await sleep(200);
      const before = await channel.getState();
      if (!before) return null;
      channel.executeCommand(probe);
      await sleep(220);
      const after = await channel.getState();
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
      channel.moveAvatar(start); // restore
      setStatus('Ready');
      if ([west, east, south, north].every((v) => Number.isFinite(v))
          && east > west && north > south) {
        onBounds?.([west, south, east, north]);
      }
    }

    function onMessage(type, payload) {
      switch (type) {
        case INBOUND.READY: {
          readyRef.current = true;
          setStatus('Ready');
          // The avatar's start position is always inside the map, whatever the
          // map's coordinate system — the seed for both centring and discovery.
          channel.getState({ timeoutMs: 3000 }).then((p) => {
            if (p && Number.isFinite(p[0]) && Number.isFinite(p[1])) {
              onStart?.(p);
              if (onBounds && !discoveredRef.current) {
                discoveredRef.current = true;
                discoverBounds(p);
              }
            }
          });
          break;
        }
        // featureEntered / featureSelected are handled by `channel.onFeature`.
        case INBOUND.ERROR:
          setStatus(`Error: ${payload?.code || 'unknown'}`);
          break;
        default:
          break;
      }
      onEvent?.(type, payload);
    }

    return channel.onMessage(onMessage);
  }, [channel, src, onEvent, onStart, onBounds]);

  // Throttled avatar updates from the shared fingertip ref.
  useEffect(() => {
    const id = setInterval(() => {
      const coord = coordRef?.current;
      if (!channel || !readyRef.current || !coord ||
          !Number.isFinite(coord.lng) || !Number.isFinite(coord.lat)) return;
      const last = lastSentRef.current;
      if (last && metersBetween(last, coord) < deadbandMeters) return;
      // `moveAvatar` is false when the iframe has no contentWindow yet — the old
      // `iframe.contentWindow?.postMessage` swallowed that but still advanced
      // `lastSentRef`, which suppressed the next real send inside the deadband.
      if (channel.moveAvatar(coord)) lastSentRef.current = coord;
    }, throttleMs);
    return () => clearInterval(id);
  }, [channel, throttleMs, coordRef, deadbandMeters]);

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
        <span>Audiom · {status}{lastFeature ? ` · ${lastFeature}` : ''}</span>
        {/* The system's first spoken output. Answered at L0 from the last
            featureEntered payload — no model, no network, no inference. */}
        <button
          type="button"
          onClick={whatsHere}
          title="Speak the feature under the avatar"
          style={{
            marginLeft: 8, padding: '1px 6px', border: 0, borderRadius: 4,
            background: '#334155', color: '#e2e8f0', fontSize: 11, cursor: 'pointer',
          }}
        >
          What&rsquo;s here?
        </button>
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
