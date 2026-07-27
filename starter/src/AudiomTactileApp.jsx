import { useMemo, useRef, useState } from 'react';
import { parseEmbedId, parseMapId, parseAudiomView, parseAudiomSources, viewToBbox, PREDEFINED_SOURCES } from './audiom';
import { AudiomMap } from './AudiomMap';
import { TactileExplorerGeneric } from './TactileExplorerGeneric';

// Per-material config. Record these once from the map / printed material:
//  - center + zoom define the geographic view the material was printed to
//  - width:height must match the printed material's aspect ratio
const DEFAULT_VIEW = { centerLng: -122.1431, centerLat: 47.6495, zoom: 16, width: 480, height: 360 };

function NumField({ label, value, onChange, step = 'any' }) {
  return (
    <label className="slider-field">
      <span>{label}</span>
      <input
        type="number"
        step={step}
        value={value}
        onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
      />
    </label>
  );
}

export default function AudiomTactileApp() {
  const [sourceInput, setSourceInput] = useState('osm');
  const [sources, setSources] = useState('');       // active dynamic source
  const [embedId, setEmbedId] = useState('');        // active pre-configured embed id (/embed/<id>)
  const [mapId, setMapId] = useState('');            // active map-editor map id (/embed/d/<id>)
  const [view, setView] = useState(DEFAULT_VIEW);
  const [stepMeters, setStepMeters] = useState(0);  // announced "… metres per step"; 0 = auto
  const [error, setError] = useState('');
  const fingerRef = useRef(null);
  const [embedBbox, setEmbedBbox] = useState(null); // bounds auto-discovered from a pre-configured embed

  // For a pre-configured embed, use the bounds discovered from the embed itself
  // (null until calibration finishes). For dynamic sources, derive from the view.
  const bbox = useMemo(
    () => ((embedId || mapId) ? embedBbox : viewToBbox(view)),
    [embedId, mapId, embedBbox, view],
  );
  const setV = (patch) => setView((v) => ({ ...v, ...patch }));

  function loadSource() {
    const raw = String(sourceInput || '').trim();
    if (!raw) { setError('Enter a map link, an embed id (e.g. 570), a source (osm…), or a GeoJSON URL.'); return; }
    setSources(''); setEmbedId(''); setMapId(''); setEmbedBbox(null);

    // A map-editor map (/maps/d/<id> or /embed/d/<id>) — loads via /embed/d/<id>.
    const mid = parseMapId(raw);
    if (mid) { setMapId(mid); setError(''); return; }

    // A pre-configured embed (bare number or /embed/<id>) — needs the full-access key.
    const eid = parseEmbedId(raw);
    if (eid) { setEmbedId(eid); setError(''); return; }

    // Otherwise a dynamic source (predefined id or GeoJSON URL); pull center/zoom from a /map URL if present.
    const fromUrl = parseAudiomSources(raw);
    const viewFromUrl = parseAudiomView(raw);
    setSources(fromUrl || raw);
    setView((v) => ({ ...v, ...viewFromUrl }));
    setError('');
  }

  const pick = (s) => { setSourceInput(s); setSources(s); setEmbedId(''); setMapId(''); setEmbedBbox(null); setError(''); };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <header className="sidebar-header">
          <div>
            <p className="eyebrow">Audiom · any data source</p>
            <h1>Tactile Audiom Explorer</h1>
          </div>
          <p className="subtle">
            Load any Audiom data source, register a pre-made tactile material by its 4 corners,
            then drive the avatar with your finger.
          </p>
          <a
            href="/index.html"
            style={{ display: 'inline-block', marginTop: '0.5rem', fontSize: '0.85rem', fontWeight: 600, color: '#2563eb', textDecoration: 'none' }}
          >
            ← Door-to-Door (OSM) mode
          </a>
        </header>

        <section className="panel-section">
          <h2>Data source</h2>
          <p className="subtle">
            A <strong>map link</strong> (<code>/maps/d/885</code> = geology), an <strong>embed id</strong>
            (<code>570</code> = skeleton), a predefined source, or a direct GeoJSON URL. Map/embed ids
            need the full-access key.
          </p>
          <div className="geocoder">
            <input
              className="geocoder-input"
              placeholder="/maps/d/885 · 570 · osm · https://…/data.geojson"
              value={sourceInput}
              onChange={(e) => setSourceInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') loadSource(); }}
              aria-label="Audiom data source"
            />
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem', margin: '0.5rem 0' }}>
            {PREDEFINED_SOURCES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => pick(s)}
                style={{
                  fontSize: '0.75rem', padding: '0.2rem 0.5rem', borderRadius: '0.4rem',
                  border: '1px solid #cbd5e1', cursor: 'pointer',
                  background: sources === s ? '#2563eb' : '#fff', color: sources === s ? '#fff' : '#334155',
                }}
              >
                {s}
              </button>
            ))}
          </div>
          <button type="button" className="primary-button" onClick={loadSource}>Load source</button>
          {mapId ? <p className="point-meta">Active map id: {mapId} (/embed/d/{mapId})</p>
            : embedId ? <p className="point-meta">Active embed id: {embedId}</p>
            : sources ? <p className="point-meta">Active source: {sources}</p> : null}
          {error ? <p className="error-text">{error}</p> : null}
        </section>

        <section className="panel-section">
          <h2>Material extent</h2>
          <p className="subtle">
            Match these to the printed material. Read the map's dimensions from its
            orientation briefing (Speech Log) and the center/zoom from the source view.
          </p>
          <NumField label="Center longitude" value={view.centerLng} onChange={(v) => setV({ centerLng: v })} />
          <NumField label="Center latitude" value={view.centerLat} onChange={(v) => setV({ centerLat: v })} />
          <NumField label="Zoom" value={view.zoom} onChange={(v) => setV({ zoom: v })} step={0.01} />
          <NumField label="Material width (px)" value={view.width} onChange={(v) => setV({ width: v })} step={1} />
          <NumField label="Material height (px)" value={view.height} onChange={(v) => setV({ height: v })} step={1} />
          <NumField label="Step size (m, 0 = auto)" value={stepMeters} onChange={(v) => setStepMeters(v || 0)} step={0.01} />
          <p className="point-meta">
            bbox: {bbox ? bbox.map((n) => n.toFixed(5)).join(', ') : ((embedId || mapId) ? 'discovering from embed…' : '—')}
          </p>
        </section>

        <section className="panel-section compact">
          <h2>How to use</h2>
          <ol className="entrance-list" style={{ listStyle: 'decimal', paddingLeft: '1.25rem' }}>
            <li>Pick a source and set the extent above (the map can take up to ~30 s to load).</li>
            <li>Hold the camera steady over the tactile material.</li>
            <li>Press <strong>Register material</strong> and point at each corner (top-left → top-right → bottom-right → bottom-left), holding ~1.5 s each.</li>
            <li>Move your finger on the material; the avatar follows. Press <kbd>;</kbd> to Fix, <kbd>r</kbd> to re-register.</li>
          </ol>
        </section>
      </aside>

      <main className="map-panel" style={{ display: 'flex', alignItems: 'flex-start', gap: '1rem', padding: '1rem' }}>
        {(sources || embedId || mapId) ? (
          <>
            <AudiomMap embedId={embedId} mapId={mapId} sources={sources} view={view} coordRef={fingerRef} stepMeters={stepMeters} onBounds={setEmbedBbox} />
            <TactileExplorerGeneric bbox={bbox} onCoord={(c) => { fingerRef.current = c; }} />
          </>
        ) : (
          <div className="map-placeholder">
            <div>
              <h2>Choose a source to begin</h2>
              <p>Try <code>/maps/d/885</code>, an embed id like <code>570</code>, <code>osm</code>, or a GeoJSON URL.</p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
