import { useEffect, useRef, useState } from 'react';
import { forwardLookup, featureToLabel } from '../lib/geocoding';
import PointMeta from './PointMeta';

/**
 * Debounced Mapbox Search Box autocomplete.
 *
 * Was `GeocoderInput` in App.jsx, instantiated twice for the routing A/B pair.
 * With routing removed there is a single location search whose job is to move
 * the map to wherever the tactile pin grid should be generated.
 */
export function GeocoderInput({ label, placeholder, value, onChange, onSelect, accessToken, proximity }) {
  const wrapperRef = useRef(null);
  const skipNextFetchRef = useRef(false);
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState([]);

  useEffect(() => {
    function handleOutsideClick(event) {
      if (!wrapperRef.current?.contains(event.target)) setSuggestions([]);
    }
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  useEffect(() => {
    if (!accessToken) {
      setSuggestions([]);
      return;
    }

    // Selecting a suggestion writes its label back into `value`; without this
    // guard that write would immediately trigger a fresh search for the label.
    if (skipNextFetchRef.current) {
      skipNextFetchRef.current = false;
      return;
    }

    const query = value.trim();
    if (query.length < 2) {
      setSuggestions([]);
      return;
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(async () => {
      setLoading(true);
      try {
        const results = await forwardLookup(query, accessToken, proximity, controller.signal);
        setSuggestions(results);
      } catch (error) {
        if (error.name !== 'AbortError') {
          console.error(error);
          setSuggestions([]);
        }
      } finally {
        setLoading(false);
      }
    }, 250);

    return () => {
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [value, accessToken, proximity]);

  return (
    <div className="geocoder" ref={wrapperRef}>
      <label className="sr-only">{label}</label>
      <input
        aria-label={label}
        className="geocoder-input"
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {value ? (
        <button
          type="button"
          className="clear-button"
          aria-label="Clear search"
          onClick={() => { onChange(''); setSuggestions([]); }}
        >
          ×
        </button>
      ) : null}
      {loading ? <span className="search-status">Searching…</span> : null}
      {suggestions.length ? (
        <ul className="suggestions" role="listbox">
          {suggestions.map((feature) => {
            const itemLabel = featureToLabel(feature);
            return (
              <li key={feature.id || itemLabel}>
                <button
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    skipNextFetchRef.current = true;
                    onSelect(feature);
                    setSuggestions([]);
                  }}
                >
                  <span className="suggestion-primary">{feature.properties?.name || itemLabel}</span>
                  <span className="suggestion-secondary">
                    {feature.properties?.place_formatted || feature.properties?.feature_type || 'Mapbox result'}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

/** Search box plus its coordinate readout. */
export function LocationSearch({ query, onQueryChange, point, onSelectFeature, accessToken, proximity }) {
  return (
    <section className="panel-section">
      <h2>Location</h2>
      {/* Not .field-row — that is a 40px + 1fr grid whose first column held the
          A/B waypoint badge. With the badge gone it squeezed the input into
          40px. A single full-width field needs no grid. */}
      <GeocoderInput
        label="Find a place"
        placeholder="Search an address or place"
        value={query}
        onChange={onQueryChange}
        onSelect={onSelectFeature}
        accessToken={accessToken}
        proximity={proximity}
      />
      <PointMeta point={point} />
      <p className="inline-note">
        Search, or click the map, to centre the tactile grid.
      </p>
    </section>
  );
}

export default LocationSearch;
