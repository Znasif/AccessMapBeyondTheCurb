import { useCallback, useMemo, useRef, useState } from 'react';
import {
  parseEmbedId, parseMapId, parseAudiomView, parseAudiomSources,
  subWindow, mercAspect, zoomForBbox, bboxSpanMeters, PREDEFINED_SOURCES,
} from './audiom';
import { AudiomMap } from './AudiomMap';
import { TactileExplorerGeneric } from './TactileExplorerGeneric';
import asset from './lib/assetUrl';

const BASE_PX = 640; // pixel basis for the debug view only

function SliderField({ label, min, max, step, value, onChange }) {
  return (
    <label className="slider-field">
      <span>{label}</span>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

export default function AudiomTactileApp() {
  const [sourceInput, setSourceInput] = useState('/maps/d/885');
  const [sources, setSources] = useState('');
  const [embedId, setEmbedId] = useState('');
  const [mapId, setMapId] = useState('');
  const [error, setError] = useState('');

  // Discovered full-map bounds — the origin of the whole window model.
  const [fullBbox, setFullBbox] = useState(null);
  const [center, setCenter] = useState(null);   // window centre; seeded from avatar start
  const [fraction, setFraction] = useState(1);  // 1 = whole map
  const [cellsAcross, setCellsAcross] = useState(43); // tactile resolution only
  // Physical size of the material you actually have. If its aspect differs from
  // the window's, the artwork is letterboxed inside it and the mapping adjusts.
  const [matW, setMatW] = useState('');
  const [matH, setMatH] = useState('');
  const [syncView, setSyncView] = useState(false);
  const [syncKey, setSyncKey] = useState(0);
  const [overlay, setOverlay] = useState(true);
  const [overlayOpacity, setOverlayOpacity] = useState(0.55);
  const [overlayPct, setOverlayPct] = useState(60);
  const [showRectPanel, setShowRectPanel] = useState(false);

  const fingerRef = useRef(null);

  // The material is printed at this aspect; every window inherits it, so the
  // four touched corners always correspond to the four bbox corners.
  const aspect = useMemo(() => (fullBbox ? mercAspect(fullBbox) : null), [fullBbox]);

  const bbox = useMemo(() => {
    if (!fullBbox) return null;
    return subWindow(fullBbox, {
      fraction,
      centerLng: center?.lng,
      centerLat: center?.lat,
    });
  }, [fullBbox, fraction, center]);

  // Square cells on the material: rows follow from the invariant aspect.
  const rows = useMemo(
    () => (aspect ? Math.max(2, Math.round(cellsAcross / aspect)) : 31),
    [aspect, cellsAcross],
  );

  const view = useMemo(() => {
    if (!bbox) return null;
    const width = BASE_PX;
    const height = Math.max(1, Math.round(BASE_PX / (aspect || 1.387)));
    const [w, s, e, n] = bbox;
    return {
      centerLng: (w + e) / 2, centerLat: (s + n) / 2,
      zoom: zoomForBbox(bbox, width), width, height,
    };
  }, [bbox, aspect]);

  const materialAspect = useMemo(() => {
    const w = Number(matW), h = Number(matH);
    return (w > 0 && h > 0) ? w / h : null;
  }, [matW, matH]);

  const mismatch = useMemo(() => {
    if (!materialAspect || !aspect) return null;
    return materialAspect / aspect - 1;
  }, [materialAspect, aspect]);

  const cellMeters = useMemo(() => {
    if (!bbox) return null;
    return bboxSpanMeters(bbox) / cellsAcross;
  }, [bbox, cellsAcross]);

  const handleStart = useCallback((pos) => {
    setCenter((cur) => cur || { lng: pos[0], lat: pos[1] });
  }, []);

  const handleBounds = useCallback((bb) => {
    setFullBbox(bb);
    setCenter({ lng: (bb[0] + bb[2]) / 2, lat: (bb[1] + bb[3]) / 2 });
  }, []);

  function load() {
    const raw = String(sourceInput || '').trim();
    if (!raw) { setError('Enter a map link, an embed id, a source, or a GeoJSON URL.'); return; }
    setSources(''); setEmbedId(''); setMapId('');
    setFullBbox(null); setCenter(null); setFraction(1); setError('');

    const mid = parseMapId(raw);
    if (mid) { setMapId(mid); return; }
    const eid = parseEmbedId(raw);
    if (eid) { setEmbedId(eid); return; }
    const fromUrl = parseAudiomSources(raw);
    const v = parseAudiomView(raw);
    if (v.centerLng != null) setCenter({ lng: v.centerLng, lat: v.centerLat });
    setSources(fromUrl || raw);
  }

  const pick = (s) => {
    setSourceInput(s); setSources(s);
    setEmbedId(''); setMapId(''); setFullBbox(null); setCenter(null); setFraction(1); setError('');
  };

  // Pan by half a window, clamped inside the map by subWindow().
  const pan = (dx, dy) => {
    if (!bbox || !center) return;
    const [w, s, e, n] = bbox;
    setCenter({ lng: center.lng + dx * (e - w) * 0.5, lat: center.lat + dy * (n - s) * 0.5 });
  };

  const loaded = sources || embedId || mapId;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <header className="sidebar-header">
          <div>
            <p className="eyebrow">Audiom · any map, any data source</p>
            <h1>Tactile Audiom Explorer</h1>
          </div>
          <p className="subtle">
            Print the material at the map's aspect ratio, register its four corners,
            then explore the whole map or any part of it at any scale.
          </p>
          <a href={asset('index.html')} style={{ display: 'inline-block', marginTop: '0.5rem', fontSize: '0.85rem', fontWeight: 600, color: '#2563eb', textDecoration: 'none' }}>
            ← Door-to-Door (OSM) mode
          </a>
        </header>

        <section className="panel-section">
          <h2>Map</h2>
          <div className="geocoder">
            <input
              className="geocoder-input"
              placeholder="/maps/d/885 · 570 · osm · https://…/data.geojson"
              value={sourceInput}
              onChange={(e) => setSourceInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') load(); }}
              aria-label="Audiom map, embed id, or data source"
            />
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', margin: '0.5rem 0' }}>
            {PREDEFINED_SOURCES.map((s) => (
              <button key={s} type="button" onClick={() => pick(s)}
                style={{
                  fontSize: '0.75rem', padding: '0.2rem 0.5rem', borderRadius: '0.4rem',
                  border: '1px solid #cbd5e1', cursor: 'pointer',
                  background: sources === s ? '#2563eb' : '#fff',
                  color: sources === s ? '#fff' : '#334155',
                }}>{s}</button>
            ))}
          </div>
          <button type="button" className="primary-button" onClick={load}>Load</button>
          {mapId ? <p className="point-meta">map id {mapId} · /embed/d/{mapId}</p> : null}
          {embedId ? <p className="point-meta">embed id {embedId}</p> : null}
          {!mapId && !embedId && sources ? <p className="point-meta">source: {sources}</p> : null}
          {error ? <p className="error-text">{error}</p> : null}
        </section>

        <section className="panel-section">
          <h2>Print the material at</h2>
          {aspect ? (
            <>
              <p className="point-meta" style={{ fontSize: '1.05rem' }}>
                aspect <strong>{aspect.toFixed(4)}</strong> (w : h = 1 : {(1 / aspect).toFixed(3)})
              </p>
              <p className="subtle">
                e.g. {(20 * aspect).toFixed(1)} cm × 20 cm. Every window below keeps this
                aspect, so your four corners always match the window corners.
              </p>
              <p className="point-meta">
                full bounds {fullBbox.map((n) => n.toFixed(4)).join(', ')}
              </p>

              <p className="subtle" style={{ marginTop: '0.5rem' }}>
                Already have a material? Enter its size to check it against the window.
              </p>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <label className="slider-field">
                  <span>Material W</span>
                  <input type="number" step="0.1" min="0" value={matW}
                    placeholder="cm" onChange={(e) => setMatW(e.target.value)} />
                </label>
                <label className="slider-field">
                  <span>Material H</span>
                  <input type="number" step="0.1" min="0" value={matH}
                    placeholder="cm" onChange={(e) => setMatH(e.target.value)} />
                </label>
              </div>
              {mismatch !== null && (
                Math.abs(mismatch) <= 0.01 ? (
                  <p className="point-meta" style={{ color: '#16a34a' }}>
                    ✓ material matches the window ({(mismatch * 100).toFixed(1)}%)
                  </p>
                ) : (
                  <p className="inline-note">
                    Material aspect {materialAspect.toFixed(3)} vs window {aspect.toFixed(3)}
                    &nbsp;({mismatch > 0 ? '+' : ''}{(mismatch * 100).toFixed(1)}%). The artwork is
                    treated as letterboxed inside the material — point at the <strong>material's</strong>
                    corners and the dashed box in the rectified view shows the artwork area.
                  </p>
                )
              )}
            </>
          ) : (
            <p className="subtle">
              {loaded ? 'Discovering map bounds… (~20 s, avatar probes the edges)' : 'Load a map first.'}
            </p>
          )}
        </section>

        {fullBbox && (
          <section className="panel-section">
            <h2>Window</h2>
            <label className="slider-field">
              <span>
                Scale: {fraction >= 0.999 ? 'whole map' : `${(fraction * 100).toFixed(1)}% of width`}
              </span>
              <input type="range" min={0.02} max={1} step={0.01}
                value={fraction} onChange={(e) => setFraction(Number(e.target.value))} />
            </label>
            <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
              {[1, 0.5, 0.25, 0.1, 0.05].map((v) => (
                <button key={v} type="button" onClick={() => setFraction(v)}
                  style={{
                    fontSize: '0.7rem', padding: '0.15rem 0.4rem', borderRadius: '0.3rem',
                    border: '1px solid #cbd5e1', cursor: 'pointer',
                    background: fraction === v ? '#2563eb' : '#fff',
                    color: fraction === v ? '#fff' : '#334155',
                  }}>{v === 1 ? 'whole' : `${v * 100}%`}</button>
              ))}
            </div>

            <div style={{ display: 'flex', gap: '0.3rem', alignItems: 'center', margin: '0.4rem 0' }}>
              <span className="subtle" style={{ fontSize: '0.75rem' }}>Pan</span>
              <button type="button" onClick={() => pan(0, 1)}>↑</button>
              <button type="button" onClick={() => pan(0, -1)}>↓</button>
              <button type="button" onClick={() => pan(-1, 0)}>←</button>
              <button type="button" onClick={() => pan(1, 0)}>→</button>
              <button type="button" onClick={() => { setFraction(1); handleBounds(fullBbox); }}>Reset</button>
            </div>

            <label className="slider-field">
              <span>Tactile resolution: {cellsAcross} × {rows} cells</span>
              <input type="range" min={8} max={120} step={1}
                value={cellsAcross} onChange={(e) => setCellsAcross(Number(e.target.value))} />
            </label>
            {cellMeters && (
              <p className="point-meta">
                1 cell ≈ {cellMeters < 1000 ? `${cellMeters.toFixed(1)} m` : `${(cellMeters / 1000).toFixed(2)} km`} (square on the material)
              </p>
            )}
            {bbox && <p className="point-meta">window {bbox.map((n) => n.toFixed(4)).join(', ')}</p>}

            <label className="switch-row" style={{ marginTop: '0.5rem' }}>
              <input type="checkbox" checked={syncView}
                onChange={(e) => { setSyncView(e.target.checked); setSyncKey((k) => k + 1); }} />
              <span>Sync displayed view to window (reloads embed)</span>
            </label>
            {syncView && <button type="button" onClick={() => setSyncKey((k) => k + 1)}>Re-sync view</button>}
          </section>
        )}

        <section className="panel-section">
          <h2>Camera overlay</h2>
          <p className="subtle">
            The rectified camera view sits over the map as a fixed rectangle.
            Pan/zoom Audiom underneath (cursor works through the overlay) until the
            map lines up with it — that confirms material and window agree.
          </p>
          <label className="switch-row">
            <input type="checkbox" checked={overlay} onChange={(e) => setOverlay(e.target.checked)} />
            <span>Show overlay on map</span>
          </label>
          {overlay && (
            <>
              <SliderField
                label={`Opacity: ${Math.round(overlayOpacity * 100)}%`}
                min={0.1} max={1} step={0.05}
                value={overlayOpacity} onChange={setOverlayOpacity}
              />
              <SliderField
                label={`Size: ${overlayPct}% of fitted box (100% = fills the view)`}
                min={20} max={100} step={1}
                value={overlayPct} onChange={setOverlayPct}
              />
            </>
          )}
          <label className="switch-row">
            <input type="checkbox" checked={showRectPanel}
              onChange={(e) => setShowRectPanel(e.target.checked)} />
            <span>Also show rectified side panel (adds cell grid)</span>
          </label>
          <p className="subtle" style={{ fontSize: '0.75rem' }}>
            One box only: <span style={{ color: '#16a34a', fontWeight: 700 }}>green</span> = the Audiom
            window holding the rectified camera view. Scale/pan Audiom until the map lines up inside it.
            <span style={{ color: '#ca8a04', fontWeight: 700 }}> Yellow</span> = your finger;
            <span style={{ color: '#ea580c', fontWeight: 700 }}> orange dashed</span> only appears if
            the material's aspect differs from the window's.
          </p>
        </section>

        <section className="panel-section compact">
          <h2>How to use</h2>
          <ol className="entrance-list" style={{ listStyle: 'decimal', paddingLeft: '1.25rem' }}>
            <li>Load a map and wait for bounds discovery.</li>
            <li>Print/emboss the material at the aspect shown above.</li>
            <li>Hold the camera steady, press <strong>Register material</strong>, point at each corner (TL → TR → BR → BL), ~1.5 s each.</li>
            <li>Explore. Change scale or pan any time — the aspect never changes, so registration stays valid.</li>
            <li><kbd>;</kbd> fixes the homography, <kbd>r</kbd> re-registers.</li>
          </ol>
        </section>
      </aside>

      <main className="map-panel">
        {loaded ? (
          <>
            <AudiomMap
              fill
              embedId={embedId} mapId={mapId} sources={sources}
              view={view} bbox={bbox} coordRef={fingerRef}
              onStart={handleStart} onBounds={handleBounds}
              syncView={syncView} syncKey={syncKey}
            />
            <TactileExplorerGeneric
              bbox={bbox} cols={cellsAcross} rows={rows}
              bboxAspect={aspect} materialAspect={materialAspect}
              overlay={overlay} overlayOpacity={overlayOpacity} overlayPct={overlayPct}
              showRectPanel={showRectPanel}
              onCoord={(c) => { fingerRef.current = c; }}
            />
          </>
        ) : (
          <div className="map-placeholder">
            <div>
              <h2>Load a map to begin</h2>
              <p>Try <code>/maps/d/885</code>, <code>570</code>, or <code>osm</code>.</p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
