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
}) {
  return (
    <section className="panel-section">
      <h2>Tactile map</h2>

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

          {/* The explorer derives its own bbox from the registered material, so
              padding is meaningless while it is running. */}
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
