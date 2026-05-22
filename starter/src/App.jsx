import { useEffect, useMemo, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';

const GH_HQ = {
  lng: -122.391,
  lat: 37.7823,
  zoom: 15,
};

const EMPTY_GEOJSON = {
  type: 'FeatureCollection',
  features: [],
};

const DEFAULT_PREFS = {
  streetAvoidance: 1,
  maxUphill: 9,
  maxDownhill: 15,
  avoidBarriers: true,
};

function App() {
  const mapboxToken = (import.meta.env.VITE_MAPBOX_TOKEN || '').trim();
  const mapillaryToken = (import.meta.env.VITE_MAPILLARY_TOKEN || '').trim();
  const accessMapBase =
    (import.meta.env.VITE_ACCESSMAP_BASE_URL || 'https://stage.accessmap.app/api/v1/routing').trim();

  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const mapLoadedRef = useRef(false);
  const clickModeRef = useRef('start');
  const mapSelectionHandlerRef = useRef(null);
  const startMarkerRef = useRef(null);
  const endMarkerRef = useRef(null);

  const [clickMode, setClickMode] = useState('start');
  const [startQuery, setStartQuery] = useState('');
  const [endQuery, setEndQuery] = useState('');
  const [startPoint, setStartPoint] = useState(null);
  const [endPoint, setEndPoint] = useState(null);
  const [prefs, setPrefs] = useState(DEFAULT_PREFS);
  const [routeState, setRouteState] = useState({
    loading: false,
    error: '',
    code: '',
    route: null,
  });
  const [imagesLoading, setImagesLoading] = useState(false);
  const [imagery, setImagery] = useState({ origin: [], destination: [] });
  const [imageryError, setImageryError] = useState('');
  const [selectedImageId, setSelectedImageId] = useState(null);
  const [nearbyBuildings, setNearbyBuildings] = useState({ origin: [], destination: [] });

  function handleImageClick(image) {
    setSelectedImageId((prev) => (prev === image.id ? null : image.id));
  }

  const proximity = useMemo(
    () => [startPoint, endPoint].find(Boolean) || { lng: GH_HQ.lng, lat: GH_HQ.lat },
    [startPoint, endPoint],
  );

  useEffect(() => {
    clickModeRef.current = clickMode;
    if (mapRef.current) {
      mapRef.current.getCanvas().style.cursor = 'crosshair';
    }
  }, [clickMode]);

  useEffect(() => {
    if (!mapboxToken || mapRef.current) {
      return;
    }

    mapboxgl.accessToken = mapboxToken;

    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: 'mapbox://styles/mapbox/streets-v12',
      center: [GH_HQ.lng, GH_HQ.lat],
      zoom: GH_HQ.zoom,
      attributionControl: true,
    });

    map.addControl(new mapboxgl.NavigationControl(), 'top-right');

    map.on('load', () => {
      mapLoadedRef.current = true;

      // ---- Buildings (rendered below routes and imagery) ----
      map.addSource('buildings', {
        type: 'geojson',
        data: '/ca.sanfrancisco.graph.polygons.geojson',
        buffer: 0,
        tolerance: 0.3,
      });

      map.addLayer({
        id: 'buildings-fill',
        type: 'fill',
        source: 'buildings',
        filter: ['has', 'building'],
        paint: { 'fill-color': '#94a3b8', 'fill-opacity': 0.25 },
      });

      map.addLayer({
        id: 'buildings-outline',
        type: 'line',
        source: 'buildings',
        filter: ['has', 'building'],
        paint: { 'line-color': '#64748b', 'line-width': 0.5, 'line-opacity': 0.5 },
      });

      map.addSource('origin-buildings', { type: 'geojson', data: EMPTY_GEOJSON });
      map.addLayer({
        id: 'origin-buildings-fill',
        type: 'fill',
        source: 'origin-buildings',
        paint: { 'fill-color': '#16a34a', 'fill-opacity': 0.45 },
      });
      map.addLayer({
        id: 'origin-buildings-outline',
        type: 'line',
        source: 'origin-buildings',
        paint: { 'line-color': '#16a34a', 'line-width': 1.5 },
      });

      map.addSource('destination-buildings', { type: 'geojson', data: EMPTY_GEOJSON });
      map.addLayer({
        id: 'destination-buildings-fill',
        type: 'fill',
        source: 'destination-buildings',
        paint: { 'fill-color': '#dc2626', 'fill-opacity': 0.45 },
      });
      map.addLayer({
        id: 'destination-buildings-outline',
        type: 'line',
        source: 'destination-buildings',
        paint: { 'line-color': '#dc2626', 'line-width': 1.5 },
      });

      // ---- Route and imagery layers ----
      map.addSource('route', {
        type: 'geojson',
        data: EMPTY_GEOJSON,
      });

      map.addLayer({
        id: 'route-line',
        type: 'line',
        source: 'route',
        filter: ['==', ['get', 'kind'], 'route'],
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
        },
        paint: {
          'line-color': '#2563eb',
          'line-width': 6,
          'line-opacity': 0.9,
        },
      });

      map.addLayer({
        id: 'route-connector-line',
        type: 'line',
        source: 'route',
        filter: ['==', ['get', 'kind'], 'connector'],
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
        },
        paint: {
          'line-color': '#2563eb',
          'line-width': 4,
          'line-opacity': 0.75,
          'line-dasharray': [0, 2],
        },
      });

      map.addSource('origin-images', { type: 'geojson', data: EMPTY_GEOJSON });

      map.addLayer({
        id: 'origin-sector-fill',
        type: 'fill',
        source: 'origin-images',
        filter: ['==', ['get', 'kind'], 'sector'],
        paint: {
          'fill-color': ['case', ['boolean', ['get', 'selected'], false], '#f59e0b', '#16a34a'],
          'fill-opacity': ['case', ['boolean', ['get', 'selected'], false], 0.35, 0.2],
        },
      });

      map.addLayer({
        id: 'origin-sector-outline',
        type: 'line',
        source: 'origin-images',
        filter: ['==', ['get', 'kind'], 'sector'],
        paint: {
          'line-color': ['case', ['boolean', ['get', 'selected'], false], '#f59e0b', '#16a34a'],
          'line-width': 1.5,
          'line-opacity': 0.8,
        },
      });

      map.addLayer({
        id: 'origin-images-layer',
        type: 'circle',
        source: 'origin-images',
        filter: ['==', ['get', 'kind'], 'dot'],
        paint: {
          'circle-radius': ['case', ['boolean', ['get', 'selected'], false], 7, 5],
          'circle-color': ['case', ['boolean', ['get', 'selected'], false], '#f59e0b', '#16a34a'],
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#ffffff',
        },
      });

      map.addSource('destination-images', { type: 'geojson', data: EMPTY_GEOJSON });

      map.addLayer({
        id: 'destination-sector-fill',
        type: 'fill',
        source: 'destination-images',
        filter: ['==', ['get', 'kind'], 'sector'],
        paint: {
          'fill-color': ['case', ['boolean', ['get', 'selected'], false], '#f59e0b', '#dc2626'],
          'fill-opacity': ['case', ['boolean', ['get', 'selected'], false], 0.35, 0.2],
        },
      });

      map.addLayer({
        id: 'destination-sector-outline',
        type: 'line',
        source: 'destination-images',
        filter: ['==', ['get', 'kind'], 'sector'],
        paint: {
          'line-color': ['case', ['boolean', ['get', 'selected'], false], '#f59e0b', '#dc2626'],
          'line-width': 1.5,
          'line-opacity': 0.8,
        },
      });

      map.addLayer({
        id: 'destination-images-layer',
        type: 'circle',
        source: 'destination-images',
        filter: ['==', ['get', 'kind'], 'dot'],
        paint: {
          'circle-radius': ['case', ['boolean', ['get', 'selected'], false], 7, 5],
          'circle-color': ['case', ['boolean', ['get', 'selected'], false], '#f59e0b', '#dc2626'],
          'circle-stroke-width': 1.5,
          'circle-stroke-color': '#ffffff',
        },
      });
    });

    map.on('click', (event) => {
      mapSelectionHandlerRef.current?.({
        lng: event.lngLat.lng,
        lat: event.lngLat.lat,
      });
    });

    mapRef.current = map;

    return () => {
      startMarkerRef.current?.remove();
      endMarkerRef.current?.remove();
      mapLoadedRef.current = false;
      map.remove();
      mapRef.current = null;
    };
  }, [mapboxToken]);

  useEffect(() => {
    mapSelectionHandlerRef.current = async (point) => {
      const label = await reverseLookup(point, mapboxToken);
      const target = clickModeRef.current;

      if (target === 'start') {
        setStartPoint({ ...point, label });
        setStartQuery(label);
        setClickMode('end');
      } else {
        setEndPoint({ ...point, label });
        setEndQuery(label);
      }
    };
  }, [mapboxToken]);

  useEffect(() => {
    syncPointMarker(mapRef.current, startMarkerRef, startPoint, 'start');
  }, [startPoint]);

  useEffect(() => {
    syncPointMarker(mapRef.current, endMarkerRef, endPoint, 'end');
  }, [endPoint]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapLoadedRef.current || !map) {
      return;
    }

    const source = map.getSource('route');
    if (!source) {
      return;
    }

    source.setData(toRouteGeoJson(routeState.route));
  }, [routeState.route]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapLoadedRef.current || !map) {
      return;
    }

    map.getSource('origin-images')?.setData(toImageGeoJson(imagery.origin, selectedImageId));
    map.getSource('destination-images')?.setData(toImageGeoJson(imagery.destination, selectedImageId));
  }, [imagery, selectedImageId]);

  useEffect(() => {
    if (!startPoint || !mapLoadedRef.current) return;
    const map = mapRef.current;
    if (!map) return;
    const handler = () => {
      const results = queryNearbyBuildings(map, startPoint);
      setNearbyBuildings((prev) => ({ ...prev, origin: results }));
      map.getSource('origin-buildings')?.setData({ type: 'FeatureCollection', features: results });
    };
    map.once('idle', handler);
    return () => map.off('idle', handler);
  }, [startPoint]);

  useEffect(() => {
    if (!endPoint || !mapLoadedRef.current) return;
    const map = mapRef.current;
    if (!map) return;
    const handler = () => {
      const results = queryNearbyBuildings(map, endPoint);
      setNearbyBuildings((prev) => ({ ...prev, destination: results }));
      map.getSource('destination-buildings')?.setData({ type: 'FeatureCollection', features: results });
    };
    map.once('idle', handler);
    return () => map.off('idle', handler);
  }, [endPoint]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapLoadedRef.current || !map) {
      return;
    }

    const bounds = new mapboxgl.LngLatBounds();
    let hasBounds = false;

    if (routeState.route?.geometry?.coordinates?.length) {
      routeState.route.geometry.coordinates.forEach((coordinate) => {
        bounds.extend(coordinate);
        hasBounds = true;
      });
    } else {
      [startPoint, endPoint].filter(Boolean).forEach((point) => {
        bounds.extend([point.lng, point.lat]);
        hasBounds = true;
      });
    }

    if (!hasBounds) {
      return;
    }

    map.fitBounds(bounds, {
      padding: { top: 60, right: 60, bottom: 60, left: 420 },
      duration: 700,
      maxZoom: 16,
    });
  }, [startPoint, endPoint, routeState.route]);

  async function handleRouteRequest() {
    if (!startPoint || !endPoint) {
      setRouteState((current) => ({
        ...current,
        error: 'Pick both a start point and an end point first.',
      }));
      return;
    }

    setRouteState({ loading: true, error: '', code: '', route: null });
    setImagesLoading(true);
    setImageryError('');

    try {
      const routePromise = fetchAccessibleRoute({
        accessMapBase,
        startPoint,
        endPoint,
        prefs,
      });

      const originImagesPromise = mapillaryToken
        ? fetchNearbyMapillaryImages(startPoint, mapillaryToken)
        : Promise.resolve([]);
      const destinationImagesPromise = mapillaryToken
        ? fetchNearbyMapillaryImages(endPoint, mapillaryToken)
        : Promise.resolve([]);

      const [routeResult, originImages, destinationImages] = await Promise.all([
        routePromise,
        originImagesPromise,
        destinationImagesPromise,
      ]);

      if (routeResult.code !== 'Ok' || !routeResult.route) {
        setRouteState({
          loading: false,
          error: routeMessage(routeResult.code),
          code: routeResult.code,
          route: null,
        });
      } else {
        setRouteState({
          loading: false,
          error: '',
          code: routeResult.code,
          route: routeResult.route,
        });
      }

      setImagery({ origin: originImages, destination: destinationImages });

      if (!mapillaryToken) {
        setImageryError('Add a Mapillary client token to load nearby street-level imagery.');
      } else if (!originImages.length && !destinationImages.length) {
        setImageryError('No nearby Mapillary images were found for either endpoint.');
      } else if (!originImages.length || !destinationImages.length) {
        setImageryError('Imagery was found for one endpoint, but not the other.');
      }
    } catch (error) {
      setRouteState({
        loading: false,
        error: error.message || 'Unable to load route right now.',
        code: '',
        route: null,
      });
      setImagery({ origin: [], destination: [] });
      setImageryError(mapillaryToken ? 'Could not load Mapillary imagery.' : '');
    } finally {
      setImagesLoading(false);
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <header className="sidebar-header">
          <div>
            <p className="eyebrow">Open Source Assistive Technology Hackathon</p>
            <h1>Door-to-Door Accessibility Explorer</h1>
          </div>
          <p className="subtle">
            Lightweight React starter inspired by the AccessMap left-panel layout.
          </p>
        </header>

        <section className="panel-section">
          <div className="field-row">
            <span className="waypoint-badge start">A</span>
            <GeocoderInput
              label="Start point"
              placeholder="Start address"
              value={startQuery}
              onChange={setStartQuery}
              onSelect={(feature) => {
                const point = featureToPoint(feature);
                if (!point) return;
                const label = featureToLabel(feature);
                setStartPoint({ ...point, label });
                setStartQuery(label);
                setClickMode('end');
              }}
              accessToken={mapboxToken}
              proximity={proximity}
            />
          </div>
          <PointMeta point={startPoint} />

          <div className="field-row">
            <span className="waypoint-badge end">B</span>
            <GeocoderInput
              label="End point"
              placeholder="End address"
              value={endQuery}
              onChange={setEndQuery}
              onSelect={(feature) => {
                const point = featureToPoint(feature);
                if (!point) return;
                const label = featureToLabel(feature);
                setEndPoint({ ...point, label });
                setEndQuery(label);
              }}
              accessToken={mapboxToken}
              proximity={proximity}
            />
          </div>
          <PointMeta point={endPoint} />

          <div className="click-mode-row">
            <span className="click-mode-label">Map click sets</span>
            <div className="segmented-control" role="tablist" aria-label="Map click mode">
              <button
                type="button"
                className={clickMode === 'start' ? 'active' : ''}
                onClick={() => setClickMode('start')}
              >
                Start
              </button>
              <button
                type="button"
                className={clickMode === 'end' ? 'active' : ''}
                onClick={() => setClickMode('end')}
              >
                End
              </button>
            </div>
          </div>
        </section>

        <section className="panel-section">
          <h2>Mobility preferences</h2>

          <SliderField
            label={`Street avoidance: ${prefs.streetAvoidance.toFixed(2)}`}
            min={0}
            max={1}
            step={0.05}
            value={prefs.streetAvoidance}
            onChange={(value) => setPrefs((current) => ({ ...current, streetAvoidance: value }))}
          />

          <SliderField
            label={`Max uphill: ${prefs.maxUphill}%`}
            min={4}
            max={15}
            step={1}
            value={prefs.maxUphill}
            onChange={(value) => setPrefs((current) => ({ ...current, maxUphill: value }))}
          />

          <SliderField
            label={`Max downhill: ${prefs.maxDownhill}%`}
            min={4}
            max={15}
            step={1}
            value={prefs.maxDownhill}
            onChange={(value) => setPrefs((current) => ({ ...current, maxDownhill: value }))}
          />

          <label className="switch-row">
            <input
              type="checkbox"
              checked={prefs.avoidBarriers}
              onChange={(event) =>
                setPrefs((current) => ({ ...current, avoidBarriers: event.target.checked }))
              }
            />
            <span>Avoid raised curbs and stairs</span>
          </label>

          <button
            type="button"
            className="primary-button"
            onClick={handleRouteRequest}
            disabled={routeState.loading || !mapboxToken}
          >
            {routeState.loading ? 'Loading route…' : 'Find accessible route'}
          </button>

          {!mapboxToken ? (
            <p className="inline-note">Add a Mapbox public token in <code>.env</code> to enable the map and geocoder.</p>
          ) : null}
        </section>

        <section className="panel-section compact">
          <h2>Route summary</h2>
          {routeState.route ? (
            <div className="summary-card">
              <div className="summary-grid">
                <div>
                  <span className="summary-label">Distance</span>
                  <strong>{formatDistance(routeState.route.distance)}</strong>
                </div>
                <div>
                  <span className="summary-label">Duration</span>
                  <strong>{formatDuration(routeState.route.duration)}</strong>
                </div>
              </div>
              <p className="summary-code">AccessMap status: {routeState.code}</p>
            </div>
          ) : (
            <p className="empty-state">Run a route to show distance, duration, and the returned geometry.</p>
          )}
          {routeState.error ? <p className="error-text">{routeState.error}</p> : null}
        </section>

        <section className="panel-section compact">
          <div className="images-header">
            <h2>Frontage imagery</h2>
            {imagesLoading ? <span className="loading-pill">Loading…</span> : null}
          </div>

          <ImageBucket title="Origin frontage" images={imagery.origin} selectedImageId={selectedImageId} onImageClick={handleImageClick} />
          <ImageBucket title="Destination frontage" images={imagery.destination} selectedImageId={selectedImageId} onImageClick={handleImageClick} />

          {imageryError ? <p className="error-text">{imageryError}</p> : null}
          {!mapillaryToken ? (
            <p className="inline-note">Use a Mapillary client token for nearby thumbnail imagery.</p>
          ) : null}
        </section>
      </aside>

      <main className="map-panel">
        {mapboxToken ? (
          <div ref={mapContainerRef} className="map" />
        ) : (
          <div className="map-placeholder">
            <div>
              <h2>Map preview disabled</h2>
              <p>Add <code>VITE_MAPBOX_TOKEN</code> to start the map at GitHub headquarters in San Francisco.</p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function GeocoderInput({ label, placeholder, value, onChange, onSelect, accessToken, proximity }) {
  const wrapperRef = useRef(null);
  const skipNextFetchRef = useRef(false);
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState([]);

  useEffect(() => {
    function handleOutsideClick(event) {
      if (!wrapperRef.current?.contains(event.target)) {
        setSuggestions([]);
      }
    }

    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  useEffect(() => {
    if (!accessToken) {
      setSuggestions([]);
      return;
    }

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
        <button type="button" className="clear-button" onClick={() => { onChange(''); setSuggestions([]); }}>
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

function SliderField({ label, min, max, step, value, onChange }) {
  return (
    <label className="slider-field">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function PointMeta({ point }) {
  if (!point) {
    return <p className="point-meta empty">Click the map or search to set this point.</p>;
  }

  return (
    <p className="point-meta">
      {point.lat.toFixed(5)}, {point.lng.toFixed(5)}
    </p>
  );
}

function ImageBucket({ title, images, selectedImageId, onImageClick }) {
  return (
    <div className="image-bucket">
      <h3>{title}</h3>
      {images.length ? (
        <div className="image-grid">
          {images.map((image) => (
            <article
              key={image.id}
              className={`image-card${image.id === selectedImageId ? ' selected' : ''}`}
              onClick={() => onImageClick?.(image)}
            >
              {image.imageUrl ? <img src={image.imageUrl} alt={title} loading="lazy" /> : null}
              <div className="image-meta">
                <strong>{image.distanceMeters ? `${image.distanceMeters} m away` : 'Nearby image'}</strong>
                <span>{image.capturedAt ? formatDate(image.capturedAt) : 'Capture date unavailable'}</span>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <p className="empty-state">No imagery loaded yet.</p>
      )}
    </div>
  );
}

async function fetchAccessibleRoute({ accessMapBase, startPoint, endPoint, prefs }) {
  const url = new URL(`${accessMapBase.replace(/\/$/, '')}/shortest_path/custom.json`);
  url.search = new URLSearchParams({
    lon1: startPoint.lng.toString(),
    lat1: startPoint.lat.toString(),
    lon2: endPoint.lng.toString(),
    lat2: endPoint.lat.toString(),
    uphill: (prefs.maxUphill / 100).toFixed(2),
    downhill: (prefs.maxDownhill / 100).toFixed(2),
    avoidCurbs: prefs.avoidBarriers ? '1' : '0',
    streetAvoidance: prefs.streetAvoidance.toFixed(2),
  }).toString();

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`AccessMap request failed with status ${response.status}.`);
  }

  const data = await response.json();
  const route = data.routes?.[0] || null;
  return {
    code: data.code || 'Unknown',
    route: route ? { ...route, origin: data.origin, destination: data.destination } : null,
  };
}

async function fetchNearbyMapillaryImages(point, token) {
  for (const delta of [0.00075, 0.0015]) {
    const url = new URL('https://graph.mapillary.com/images');
    url.search = new URLSearchParams({
      access_token: token,
      fields: 'id,captured_at,thumb_1024_url,geometry,computed_geometry,compass_angle,computed_compass_angle,camera_type,is_pano',
      bbox: buildBbox(point, delta).join(','),
      limit: '50',
    }).toString();

    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`Mapillary request failed with status ${response.status}.`);
    }

    const data = await response.json();
    const items = (data.data || [])
      .map((item) => normalizeImage(item, point))
      .filter((item) => item.imageUrl)
      .sort((left, right) => (right.capturedAt || 0) - (left.capturedAt || 0))
      .slice(0, 4);

    if (items.length) {
      return items;
    }
  }

  return [];
}

async function forwardLookup(query, token, proximity, signal) {
  const url = new URL('https://api.mapbox.com/search/searchbox/v1/forward');
  url.search = new URLSearchParams({
    q: query,
    access_token: token,
    language: 'en',
    limit: '5',
    proximity: `${proximity.lng},${proximity.lat}`,
  }).toString();

  const response = await fetch(url.toString(), { signal });
  if (!response.ok) {
    throw new Error(`Mapbox search failed with status ${response.status}.`);
  }

  const data = await response.json();
  return data.features || [];
}

async function reverseLookup(point, token) {
  if (!token) {
    return `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`;
  }

  const url = new URL('https://api.mapbox.com/search/searchbox/v1/reverse');
  url.search = new URLSearchParams({
    longitude: point.lng.toString(),
    latitude: point.lat.toString(),
    access_token: token,
    language: 'en',
    limit: '1',
  }).toString();

  try {
    const response = await fetch(url.toString());
    if (!response.ok) {
      return `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`;
    }

    const data = await response.json();
    return featureToLabel(data.features?.[0]) || `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`;
  } catch {
    return `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`;
  }
}

function syncPointMarker(map, markerRef, point, kind) {
  if (!map) {
    return;
  }

  if (!point) {
    markerRef.current?.remove();
    markerRef.current = null;
    return;
  }

  if (!markerRef.current) {
    markerRef.current = new mapboxgl.Marker({ element: createMarkerElement(kind), anchor: 'bottom' })
      .setLngLat([point.lng, point.lat])
      .addTo(map);
    return;
  }

  markerRef.current.setLngLat([point.lng, point.lat]);
}

function createMarkerElement(kind) {
  const element = document.createElement('div');
  element.className = `point-marker ${kind}`;
  element.innerHTML = `<span>${kind === 'start' ? 'A' : 'B'}</span>`;
  return element;
}

function featureToPoint(feature) {
  const routablePoint = feature?.properties?.coordinates?.routable_points?.[0];
  if (routablePoint?.longitude != null && routablePoint?.latitude != null) {
    return {
      lng: routablePoint.longitude,
      lat: routablePoint.latitude,
    };
  }

  if (Array.isArray(feature?.geometry?.coordinates)) {
    return {
      lng: feature.geometry.coordinates[0],
      lat: feature.geometry.coordinates[1],
    };
  }

  const rawCoordinates = feature?.properties?.coordinates;
  if (rawCoordinates?.longitude != null && rawCoordinates?.latitude != null) {
    return {
      lng: rawCoordinates.longitude,
      lat: rawCoordinates.latitude,
    };
  }

  return null;
}

function featureToLabel(feature) {
  if (!feature) {
    return '';
  }

  const properties = feature.properties || {};
  return (
    properties.full_address ||
    [properties.name, properties.place_formatted].filter(Boolean).join(', ') ||
    properties.name ||
    feature.place_name ||
    ''
  );
}

function normalizeImage(item, point) {
  const geometry = item.computed_geometry || item.geometry;
  const coordinates = geometry?.coordinates;
  const distanceMeters = Array.isArray(coordinates)
    ? Math.round(distanceBetween(point, { lng: coordinates[0], lat: coordinates[1] }))
    : null;

  return {
    id: item.id,
    imageUrl: item.thumb_1024_url || item.thumb_2048_url || '',
    capturedAt: item.captured_at,
    compassAngle: item.computed_compass_angle ?? item.compass_angle ?? 0,
    cameraType: item.camera_type || 'perspective',
    isPano: item.is_pano || false,
    distanceMeters,
    geometry: coordinates ? { type: 'Point', coordinates } : null,
  };
}

function queryNearbyBuildings(map, point, radiusMeters = 150) {
  const center = map.project([point.lng, point.lat]);
  // Convert meter radius to pixels at the current zoom level
  const metersPerPx =
    (40075016.68 / (256 * Math.pow(2, map.getZoom()))) *
    Math.cos((point.lat * Math.PI) / 180);
  const r = radiusMeters / metersPerPx;

  const features = map.queryRenderedFeatures(
    [[center.x - r, center.y - r], [center.x + r, center.y + r]],
    { layers: ['buildings-fill'] },
  );

  const seen = new Set();
  return features.filter((f) => {
    const id = f.properties?._id;
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function buildBbox(point, delta) {
  return [point.lng - delta, point.lat - delta, point.lng + delta, point.lat + delta];
}

function toRouteGeoJson(route) {
  const coordinates = route?.geometry?.coordinates;
  if (!coordinates?.length) {
    return EMPTY_GEOJSON;
  }

  const origin = route.origin?.geometry?.coordinates;
  const destination = route.destination?.geometry?.coordinates;
  const firstRoutePoint = coordinates[0];
  const lastRoutePoint = coordinates[coordinates.length - 1];

  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {
          kind: 'route',
          distance: route.distance,
          duration: route.duration,
        },
        geometry: route.geometry,
      },
      origin && firstRoutePoint
        ? {
            type: 'Feature',
            properties: { kind: 'connector', endpoint: 'origin' },
            geometry: {
              type: 'LineString',
              coordinates: [origin, firstRoutePoint],
            },
          }
        : null,
      destination && lastRoutePoint
        ? {
            type: 'Feature',
            properties: { kind: 'connector', endpoint: 'destination' },
            geometry: {
              type: 'LineString',
              coordinates: [destination, lastRoutePoint],
            },
          }
        : null,
    ].filter(Boolean),
  };
}

function toImageGeoJson(images, selectedImageId = null) {
  const features = [];
  for (const image of images) {
    if (!image.geometry) continue;
    const selected = image.id === selectedImageId;
    const center = { lng: image.geometry.coordinates[0], lat: image.geometry.coordinates[1] };

    features.push({
      type: 'Feature',
      properties: { kind: 'sector', id: image.id, selected },
      geometry: buildSectorGeometry(center, image.compassAngle, image.cameraType, image.isPano),
    });

    features.push({
      type: 'Feature',
      properties: { kind: 'dot', id: image.id, selected },
      geometry: image.geometry,
    });
  }
  return { type: 'FeatureCollection', features };
}

function buildSectorGeometry(center, bearingDeg, cameraType, isPano) {
  const spanDeg = isPano || cameraType === 'equirectangular' ? 360 : cameraType === 'fisheye' ? 150 : 65;
  const radiusMeters = 20;
  const steps = 32;

  const latRad = (center.lat * Math.PI) / 180;
  const metersPerDegLat = 111320;
  const metersPerDegLng = 111320 * Math.cos(latRad);

  if (spanDeg >= 360) {
    const coords = [];
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * 2 * Math.PI;
      coords.push([
        center.lng + (Math.sin(a) * radiusMeters) / metersPerDegLng,
        center.lat + (Math.cos(a) * radiusMeters) / metersPerDegLat,
      ]);
    }
    return { type: 'Polygon', coordinates: [coords] };
  }

  const halfSpan = spanDeg / 2;
  const coords = [[center.lng, center.lat]];
  for (let i = 0; i <= steps; i++) {
    const a = ((bearingDeg - halfSpan + (i / steps) * spanDeg) * Math.PI) / 180;
    coords.push([
      center.lng + (Math.sin(a) * radiusMeters) / metersPerDegLng,
      center.lat + (Math.cos(a) * radiusMeters) / metersPerDegLat,
    ]);
  }
  coords.push([center.lng, center.lat]);
  return { type: 'Polygon', coordinates: [coords] };
}

function distanceBetween(left, right) {
  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const earthRadiusMeters = 6371000;
  const dLat = toRadians(right.lat - left.lat);
  const dLng = toRadians(right.lng - left.lng);
  const lat1 = toRadians(left.lat);
  const lat2 = toRadians(right.lat);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.sin(dLng / 2) * Math.sin(dLng / 2) * Math.cos(lat1) * Math.cos(lat2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusMeters * c;
}

function formatDuration(seconds) {
  if (!seconds && seconds !== 0) {
    return '—';
  }

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes} min`;
}

function formatDistance(meters) {
  if (!meters && meters !== 0) {
    return '—';
  }

  if (meters >= 1000) {
    return `${(meters / 1000).toFixed(2)} km`;
  }
  return `${Math.round(meters)} m`;
}

function formatDate(value) {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function routeMessage(code) {
  switch (code) {
    case 'InvalidWaypoint':
      return 'One or both selected points are too far from a traversable path.';
    case 'NoPath':
      return 'AccessMap could not find a route that matches the current mobility preferences.';
    case 'NoGraph':
      return 'AccessMap reported a server-side graph error.';
    case 'Ok':
      return '';
    default:
      return 'The route request did not return a usable path.';
  }
}

export default App;
