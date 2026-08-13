import SliderField from './SliderField';

/**
 * Controls for the tactile pin grid and its two output paths (camera explorer,
 * Audiom audio).
 *
 * Split out of App.jsx's "Mobility preferences" section, which mixed these with
 * the routing sliders (street avoidance, max uphill/downhill, avoid barriers).
 * Those went with the routing stack; only the tactile controls remain.
 */
export function TactilePanel({
  showTactile, onShowTactileChange,
  pinScale, onPinScaleChange,
  bboxPadding, onBboxPaddingChange,
  showExplorer, onShowExplorerChange,
  showAudiom, onShowAudiomChange,
  hasMapboxToken,
  // MapIO Dispatcher & Map props
  selectedMapKey, onSelectMapKey, MAPIO_MAPS, mapInfo, isLoadingMap,
  isListening, toggleListening, transcript, lastAnswer, isProcessing, handleQuery, setTranscript,
  llmBackend, onLlmBackendChange,
  wllamaStatus,
  sttNotice, canInstallStt, installStt,
}) {
  return (
    <section className="panel-section">
      <h2>Tactile map</h2>

      {/* MapIO Map Selection & LLM Engine Dropdown */}
      {MAPIO_MAPS && (
        <div className="map-selector-group" style={{ marginBottom: '1rem' }}>
          <label style={{ display: 'block', fontWeight: 600, fontSize: '0.85rem', marginBottom: '0.3rem' }}>
            MapIO Map Model:
          </label>
          <select
            value={selectedMapKey || 'new_york'}
            onChange={(e) => onSelectMapKey && onSelectMapKey(e.target.value)}
            disabled={isLoadingMap}
            style={{
              width: '100%',
              padding: '0.4rem 0.6rem',
              borderRadius: '6px',
              border: '1px solid #ccc',
              background: '#fff',
              fontSize: '0.9rem',
              marginBottom: '0.5rem',
            }}
          >
            {Object.values(MAPIO_MAPS).map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>

          <label style={{ display: 'block', fontWeight: 600, fontSize: '0.85rem', marginBottom: '0.3rem' }}>
            LLM Engine:
          </label>
          <select
            value={llmBackend || 'wllama'}
            onChange={(e) => onLlmBackendChange && onLlmBackendChange(e.target.value)}
            style={{
              width: '100%',
              padding: '0.4rem 0.6rem',
              borderRadius: '6px',
              border: '1px solid #ccc',
              background: '#fff',
              fontSize: '0.85rem',
            }}
          >
            <option value="wllama">⚡ In-Tab WASM (Wllama - Zero Ports)</option>
            <option value="http">🌐 Local Router (HTTP Port 8081)</option>
          </select>

          {/* Wllama WASM Loading Progress Bar */}
          {llmBackend === 'wllama' && wllamaStatus && wllamaStatus.loading && (
            <div style={{
              marginTop: '0.5rem',
              padding: '0.5rem 0.6rem',
              borderRadius: '6px',
              background: 'rgba(0, 102, 204, 0.08)',
              border: '1px solid rgba(0, 102, 204, 0.3)',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.78rem', color: '#004488', fontWeight: 600 }}>
                <span>⚡ {wllamaStatus.text || 'Initializing WASM model...'}</span>
                <span>{wllamaStatus.percent}%</span>
              </div>
              <div style={{ width: '100%', height: '6px', background: '#ccc', borderRadius: '3px', marginTop: '4px', overflow: 'hidden' }}>
                <div style={{ width: `${Math.max(wllamaStatus.percent, 5)}%`, height: '100%', background: '#0066cc', transition: 'width 0.3s' }} />
              </div>
            </div>
          )}

          {/* A failed load is its own state, not "0% again": queries are blocked
              until it clears, so the panel has to say what went wrong. */}
          {wllamaStatus && wllamaStatus.failed && (
            <div
              role="alert"
              style={{
                marginTop: '0.5rem',
                padding: '0.5rem 0.6rem',
                borderRadius: '6px',
                background: 'rgba(220, 53, 69, 0.08)',
                border: '1px solid rgba(220, 53, 69, 0.4)',
                fontSize: '0.78rem',
                color: '#8a1220',
              }}
            >
              <strong>⚠ {wllamaStatus.text || 'The language model failed to load'}</strong>
              {wllamaStatus.error ? (
                <div style={{ marginTop: '0.25rem', fontFamily: 'monospace', fontSize: '0.72rem', wordBreak: 'break-word' }}>
                  {wllamaStatus.error}
                </div>
              ) : null}
              <div style={{ marginTop: '0.25rem' }}>
                Questions needing the model are unavailable. Reload the page to try again.
              </div>
            </div>
          )}

          {isLoadingMap ? (
            <p className="inline-note" style={{ color: '#0066cc', marginTop: '0.3rem' }}>Loading map model...</p>
          ) : mapInfo ? (
            <p className="inline-note" style={{ fontSize: '0.75rem', color: '#555', marginTop: '0.3rem' }}>
              Loaded: {mapInfo.pois} POIs, {mapInfo.nodes} nodes, {mapInfo.edges} streets
            </p>
          ) : null}
        </div>
      )}

      {/* Speak & Voice Question Controls */}
      <div className="voice-control-group" style={{
        margin: '1rem 0',
        padding: '0.75rem',
        borderRadius: '8px',
        background: 'rgba(0, 102, 204, 0.06)',
        border: '1px solid rgba(0, 102, 204, 0.2)'
      }}>
        <label style={{ display: 'block', fontWeight: 600, fontSize: '0.85rem', marginBottom: '0.5rem' }}>
          Voice Questions (Point & Ask):
        </label>
        
        {/* The recogniser's sticky notice. It is a STATE, not an event: while
            `severity: 'warning'` it means microphone audio is being sent to the
            browser vendor's servers, and that must stay on screen. */}
        {sttNotice ? (
          <div
            role={sttNotice.severity === 'warning' ? 'alert' : 'status'}
            style={{
              marginBottom: '0.5rem',
              padding: '0.4rem 0.55rem',
              borderRadius: '6px',
              fontSize: '0.75rem',
              lineHeight: 1.35,
              background: sttNotice.severity === 'warning' ? 'rgba(220, 53, 69, 0.08)' : 'rgba(0, 102, 204, 0.06)',
              border: `1px solid ${sttNotice.severity === 'warning' ? 'rgba(220, 53, 69, 0.4)' : 'rgba(0, 102, 204, 0.25)'}`,
              color: sttNotice.severity === 'warning' ? '#8a1220' : '#004488',
            }}
          >
            {sttNotice.severity === 'warning' ? '⚠ ' : 'ℹ '}
            {sttNotice.text}
            {/* The notice is only half the story while the pack is merely
                DOWNLOADABLE: local recognition is possible, it just has not been
                fetched. Chrome gates that download on a user gesture, so it has
                to be a button — `processLocally` alone will never get there. */}
            {canInstallStt ? (
              <div style={{ marginTop: '0.4rem' }}>
                <button
                  type="button"
                  onClick={() => installStt?.()}
                  style={{
                    fontSize: '0.75rem',
                    padding: '0.25rem 0.6rem',
                    borderRadius: '5px',
                    border: '1px solid rgba(0, 102, 204, 0.5)',
                    background: '#fff',
                    color: '#004488',
                    cursor: 'pointer',
                    fontWeight: 600,
                  }}
                >
                  ⬇ Install on-device speech (keeps audio on this machine)
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
          <button
            type="button"
            onClick={toggleListening}
            style={{
              flex: 1,
              padding: '0.5rem',
              borderRadius: '6px',
              border: 'none',
              background: isListening ? '#dc3545' : '#0066cc',
              color: '#fff',
              fontWeight: 600,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.4rem',
            }}
          >
            <span style={{ fontSize: '1.1rem' }}>{isListening ? '⏹' : '🎙'}</span>
            <span>{isListening ? 'Stop Listening' : 'Speak / Ask'}</span>
          </button>
        </div>

        {/* Live Transcript / Manual Input */}
        <div style={{ display: 'flex', gap: '0.3rem', marginBottom: '0.4rem' }}>
          <input
            type="text"
            placeholder={isListening ? 'Listening...' : 'Or type a question...'}
            value={transcript || ''}
            onChange={(e) => setTranscript && setTranscript(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleQuery && handleQuery(transcript);
            }}
            style={{
              flex: 1,
              padding: '0.35rem 0.5rem',
              borderRadius: '4px',
              border: '1px solid #ccc',
              fontSize: '0.82rem',
            }}
          />
          <button
            type="button"
            onClick={() => handleQuery && handleQuery(transcript)}
            disabled={isProcessing || !transcript?.trim()}
            style={{
              padding: '0.35rem 0.6rem',
              borderRadius: '4px',
              border: '1px solid #0066cc',
              background: '#fff',
              color: '#0066cc',
              fontWeight: 600,
              fontSize: '0.8rem',
              cursor: 'pointer',
            }}
          >
            {isProcessing ? '...' : 'Send'}
          </button>
        </div>

        {/* Spoken Answer */}
        {lastAnswer ? (
          <div style={{
            marginTop: '0.4rem',
            padding: '0.4rem 0.6rem',
            background: '#fff',
            borderRadius: '4px',
            borderLeft: '3px solid #0066cc',
            fontSize: '0.8rem',
            lineHeight: '1.3',
            color: '#222'
          }}>
            <strong>Answer:</strong> {lastAnswer}
          </div>
        ) : null}
      </div>

      <label className="switch-row">
        <input
          type="checkbox"
          checked={showTactile}
          onChange={(event) => onShowTactileChange(event.target.checked)}
        />
        <span>Show pin grid</span>
      </label>

      {showTactile && (
        <div className="tactile-subsection">
          <SliderField
            label={`Scale 1:${pinScale.toLocaleString()}`}
            min={500}
            max={20000}
            step={500}
            value={pinScale}
            onChange={onPinScaleChange}
          />

          {!showExplorer && (
            <SliderField
              label={`Grid padding: ${Math.round(bboxPadding * 100)}%`}
              min={0}
              max={0.5}
              step={0.05}
              value={bboxPadding}
              onChange={onBboxPaddingChange}
            />
          )}

          <label className="switch-row" style={{ marginBottom: 0 }}>
            <input
              type="checkbox"
              checked={showExplorer}
              onChange={(event) => onShowExplorerChange(event.target.checked)}
            />
            <span>Explore with camera</span>
          </label>

          <label className="switch-row" style={{ marginBottom: 0 }}>
            <input
              type="checkbox"
              checked={showAudiom}
              onChange={(event) => onShowAudiomChange(event.target.checked)}
            />
            <span>Audiom audio (sync to tactile)</span>
          </label>
        </div>
      )}

      {!hasMapboxToken ? (
        <p className="inline-note">
          Add a Mapbox public token in <code>.env</code> to enable the map and search.
        </p>
      ) : null}
    </section>
  );
}

export default TactilePanel;

