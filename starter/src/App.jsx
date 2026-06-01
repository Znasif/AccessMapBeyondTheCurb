import { useEffect, useMemo, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import '@photo-sphere-viewer/core/index.css';
import { loadEntranceModel, detectEntrance } from './entranceDetector';
import TACTILE_STYLE from './tactileStyle';
import { computeScaleBBox, rasterizeRoads, pinGridToGeoJSON, queryRoadFeatures, MIN_ZOOM } from './pinGrid';
import { TactileExplorer } from './TactileExplorer';

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
    (import.meta.env.VITE_ACCESSMAP_BASE_URL || '/accessmap-api').trim();

  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const mapLoadedRef = useRef(false);
  const clickModeRef = useRef('start');
  const mapSelectionHandlerRef = useRef(null);
  const startMarkerRef = useRef(null);
  const endMarkerRef = useRef(null);
  const imageCardRefs = useRef({});

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
  const [expandedImage, setExpandedImage] = useState(null);
  const [entranceOverlays, setEntranceOverlays] = useState({});
  const [savedEntrances, setSavedEntrances] = useState({});  // imageId → true
  const [showTactile, setShowTactile] = useState(true);
  const [pinScale, setPinScale] = useState(5000);
  const [bboxPadding, setBboxPadding] = useState(0.15);
  const [pinBbox, setPinBbox] = useState(null);
  const [showExplorer, setShowExplorer] = useState(false);
  const modelRef = useRef(null);

  const addCustomLayersRef = useRef(null);
  const routeStateRef = useRef(routeState);
  const imageryRef = useRef(imagery);
  const selectedImageIdRef = useRef(selectedImageId);
  const originBuildingsDataRef = useRef(EMPTY_GEOJSON);
  const destinationBuildingsDataRef = useRef(EMPTY_GEOJSON);
  const entranceLineDataRef = useRef(EMPTY_GEOJSON);
  const proposedEntranceDataRef = useRef(EMPTY_GEOJSON);
  const pinGridDataRef = useRef(EMPTY_GEOJSON);
  const pinGridMaskRef = useRef(EMPTY_GEOJSON);

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

  useEffect(() => { routeStateRef.current = routeState; }, [routeState]);
  useEffect(() => { imageryRef.current = imagery; }, [imagery]);
  useEffect(() => { selectedImageIdRef.current = selectedImageId; }, [selectedImageId]);

  useEffect(() => {
    if (!mapboxToken || mapRef.current) {
      return;
    }

    mapboxgl.accessToken = mapboxToken;

    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: TACTILE_STYLE,
      center: [GH_HQ.lng, GH_HQ.lat],
      zoom: GH_HQ.zoom,
      attributionControl: true,
    });

    map.addControl(new mapboxgl.NavigationControl(), 'top-right');

    addCustomLayersRef.current = (m) => {
      // ---- Buildings (rendered below routes and imagery) ----
      m.addSource('buildings', {
        type: 'geojson',
        data: '/ca.sanfrancisco.graph.polygons.geojson',
        buffer: 0,
        tolerance: 0.3,
      });

      m.addLayer({
        id: 'buildings-fill',
        type: 'fill',
        source: 'buildings',
        filter: ['has', 'building'],
        paint: { 'fill-color': '#000000', 'fill-opacity': 0.2 },
      });

      m.addLayer({
        id: 'buildings-outline',
        type: 'line',
        source: 'buildings',
        filter: ['has', 'building'],
        paint: { 'line-color': '#000000', 'line-width': 1, 'line-opacity': 0.8 },
      });

      // ---- Pin grid (braille display simulation) ----
      m.addSource('pin-grid-mask', { type: 'geojson', data: EMPTY_GEOJSON });
      m.addLayer({
        id: 'pin-grid-mask-fill',
        type: 'fill',
        source: 'pin-grid-mask',
        paint: { 'fill-color': '#ffffff', 'fill-opacity': 0.95 },
      });
      m.addLayer({
        id: 'pin-grid-outline',
        type: 'line',
        source: 'pin-grid-mask',
        paint: { 'line-color': '#414042', 'line-width': 1.5, 'line-opacity': 0.6 },
      });

      m.addSource('pin-grid-pins', { type: 'geojson', data: EMPTY_GEOJSON });
      m.addLayer({
        id: 'pin-grid-down',
        type: 'circle',
        source: 'pin-grid-pins',
        filter: ['==', ['get', 'up'], false],
        paint: {
          'circle-radius': 3,
          'circle-color': '#d2d2d2',
          'circle-stroke-width': 0.5,
          'circle-stroke-color': '#b4b4b4',
          'circle-opacity': 0.3,
        },
      });
      m.addLayer({
        id: 'pin-grid-up',
        type: 'circle',
        source: 'pin-grid-pins',
        filter: ['==', ['get', 'up'], true],
        paint: {
          'circle-radius': 3,
          'circle-color': '#1e1e1e',
          'circle-stroke-width': 0.5,
          'circle-stroke-color': '#b4b4b4',
          'circle-opacity': 0.95,
        },
      });

      m.addSource('origin-buildings', { type: 'geojson', data: EMPTY_GEOJSON });
      m.addLayer({
        id: 'origin-buildings-fill',
        type: 'fill',
        source: 'origin-buildings',
        paint: { 'fill-color': '#16a34a', 'fill-opacity': 0.45 },
      });
      m.addLayer({
        id: 'origin-buildings-outline',
        type: 'line',
        source: 'origin-buildings',
        paint: { 'line-color': '#16a34a', 'line-width': 1.5 },
      });

      m.addSource('destination-buildings', { type: 'geojson', data: EMPTY_GEOJSON });
      m.addLayer({
        id: 'destination-buildings-fill',
        type: 'fill',
        source: 'destination-buildings',
        paint: { 'fill-color': '#dc2626', 'fill-opacity': 0.45 },
      });
      m.addLayer({
        id: 'destination-buildings-outline',
        type: 'line',
        source: 'destination-buildings',
        paint: { 'line-color': '#dc2626', 'line-width': 1.5 },
      });

      // ---- Route and imagery layers ----
      m.addSource('route', {
        type: 'geojson',
        data: EMPTY_GEOJSON,
      });

      m.addLayer({
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

      m.addLayer({
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

      m.addSource('origin-images', { type: 'geojson', data: EMPTY_GEOJSON });

      m.addLayer({
        id: 'origin-sector-fill',
        type: 'fill',
        source: 'origin-images',
        filter: ['==', ['get', 'kind'], 'sector'],
        paint: {
          'fill-color': ['case', ['boolean', ['get', 'selected'], false], '#f59e0b', '#16a34a'],
          'fill-opacity': ['case', ['boolean', ['get', 'selected'], false], 0.35, 0.2],
        },
      });

      m.addLayer({
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

      m.addLayer({
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

      const selectImageFromMapPoint = (event) => {
        const imageId = event.features?.[0]?.properties?.id;
        if (imageId == null) return;

        const selectedId = String(imageId);
        setSelectedImageId(selectedId);
        imageCardRefs.current[selectedId]?.scrollIntoView({
          behavior: 'smooth',
          block: 'center',
        });
      };

      ['origin-images-layer', 'destination-images-layer'].forEach((layerId) => {
        m.on('mouseenter', layerId, (event) => {
          m.getCanvas().style.cursor = 'pointer';
          selectImageFromMapPoint(event);
        });

        m.on('mouseleave', layerId, () => {
          m.getCanvas().style.cursor = 'crosshair';
          setSelectedImageId(null);
        });
      });

      m.addSource('mapillary-lookup-points', {
        type: 'geojson',
        data: EMPTY_GEOJSON,
      });

      m.addLayer({
        id: 'mapillary-lookup-points-layer',
        type: 'circle',
        source: 'mapillary-lookup-points',
        paint: {
          'circle-radius': 7,
          'circle-color': '#facc15',
          'circle-stroke-width': 2,
          'circle-stroke-color': '#000000',
        },
      });

      m.addSource('destination-images', { type: 'geojson', data: EMPTY_GEOJSON });

      m.addLayer({
        id: 'destination-sector-fill',
        type: 'fill',
        source: 'destination-images',
        filter: ['==', ['get', 'kind'], 'sector'],
        paint: {
          'fill-color': ['case', ['boolean', ['get', 'selected'], false], '#f59e0b', '#dc2626'],
          'fill-opacity': ['case', ['boolean', ['get', 'selected'], false], 0.35, 0.2],
        },
      });

      m.addLayer({
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

      m.addLayer({
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

      // Heading line (white dashed) — where you are currently looking
      m.addSource('heading-line', { type: 'geojson', data: EMPTY_GEOJSON });
      m.addLayer({
        id: 'heading-line-layer',
        type: 'line',
        source: 'heading-line',
        paint: {
          'line-color': '#ffffff',
          'line-width': 2,
          'line-opacity': 0.95,
          'line-dasharray': [3, 2],
        },
      });

      // Entrance lines — red for origin images, green for destination images
      m.addSource('entrance-line', { type: 'geojson', data: EMPTY_GEOJSON });
      m.addLayer({
        id: 'entrance-line-layer',
        type: 'line',
        source: 'entrance-line',
        paint: {
          'line-color': ['match', ['get', 'side'], 'origin', '#dc2626', '#16a34a'],
          'line-width': 2.5,
          'line-opacity': 0.95,
        },
      });

      // Proposed entrance intersection points — shown after "Mark entrance"
      m.addSource('proposed-entrances', { type: 'geojson', data: EMPTY_GEOJSON });
      m.addLayer({
        id: 'proposed-entrances-layer',
        type: 'circle',
        source: 'proposed-entrances',
        paint: {
          'circle-radius': 8,
          'circle-color': ['match', ['get', 'side'], 'origin', '#dc2626', '#16a34a'],
          'circle-stroke-width': 2.5,
          'circle-stroke-color': '#ffffff',
          'circle-opacity': 0.95,
        },
      });
    };

    map.on('load', () => {
      mapLoadedRef.current = true;
      addCustomLayersRef.current(map);
      // Tactile mode is the initial state — hide GeoJSON buildings (roads only)
      map.setLayoutProperty('buildings-fill', 'visibility', 'none');
      map.setLayoutProperty('buildings-outline', 'visibility', 'none');
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
    const map = mapRef.current;
    if (!map || !mapLoadedRef.current) return;

    const newStyle = showTactile ? TACTILE_STYLE : 'mapbox://styles/mapbox/streets-v12';
    mapLoadedRef.current = false;
    map.setStyle(newStyle);

    map.once('style.load', () => {
      addCustomLayersRef.current(map);
      if (showTactile) {
        map.setLayoutProperty('buildings-fill', 'visibility', 'none');
        map.setLayoutProperty('buildings-outline', 'visibility', 'none');
      }
      mapLoadedRef.current = true;

      const rs = routeStateRef.current;
      map.getSource('route')?.setData(toRouteGeoJson(rs.route));
      map.getSource('mapillary-lookup-points')?.setData(
        mapillaryToken ? toMapillaryLookupPointGeoJson(rs.route) : EMPTY_GEOJSON,
      );
      const im = imageryRef.current;
      const sid = selectedImageIdRef.current;
      map.getSource('origin-images')?.setData(toImageGeoJson(im.origin, sid));
      map.getSource('destination-images')?.setData(toImageGeoJson(im.destination, sid));
      map.getSource('entrance-line')?.setData(entranceLineDataRef.current);
      map.getSource('proposed-entrances')?.setData(proposedEntranceDataRef.current);
      map.getSource('origin-buildings')?.setData(originBuildingsDataRef.current);
      map.getSource('destination-buildings')?.setData(destinationBuildingsDataRef.current);
      map.getSource('pin-grid-pins')?.setData(pinGridDataRef.current);
      map.getSource('pin-grid-mask')?.setData(pinGridMaskRef.current);
      if (!showTactile) {
        ['pin-grid-mask-fill', 'pin-grid-outline', 'pin-grid-down', 'pin-grid-up'].forEach((id) => {
          if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none');
        });
      }
    });
  }, [showTactile]); // eslint-disable-line react-hooks/exhaustive-deps

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
    map.getSource('mapillary-lookup-points')?.setData(
      mapillaryToken ? toMapillaryLookupPointGeoJson(routeState.route) : EMPTY_GEOJSON,
    );
  }, [routeState.route, mapillaryToken]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapLoadedRef.current || !map) {
      return;
    }

    map.getSource('origin-images')?.setData(toImageGeoJson(imagery.origin, selectedImageId));
    map.getSource('destination-images')?.setData(toImageGeoJson(imagery.destination, selectedImageId));
  }, [imagery, selectedImageId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapLoadedRef.current || !map) return;
    const features = [];
    for (const [side, images] of [['origin', imagery.origin], ['destination', imagery.destination]]) {
      for (const image of images) {
        if (!image.geometry) continue;
        const detection = entranceOverlays[String(image.id)];
        if (!detection) continue;
        const [lng, lat] = image.geometry.coordinates;
        const bearing = ((image.compassAngle + (detection.barFraction - 0.5) * 360) % 360 + 360) % 360;
        const latRad = (lat * Math.PI) / 180;
        const a = (bearing * Math.PI) / 180;
        const r = 20;
        features.push({
          type: 'Feature',
          properties: { imageId: String(image.id), side },
          geometry: {
            type: 'LineString',
            coordinates: [
              [lng, lat],
              [lng + (Math.sin(a) * r) / (111320 * Math.cos(latRad)), lat + (Math.cos(a) * r) / 111320],
            ],
          },
        });
      }
    }
    const data = { type: 'FeatureCollection', features };
    entranceLineDataRef.current = data;
    map.getSource('entrance-line')?.setData(data);
  }, [entranceOverlays, imagery]);

  useEffect(() => {
    if (!startPoint || !mapLoadedRef.current) return;
    const map = mapRef.current;
    if (!map) return;
    const handler = () => {
      const results = queryNearbyBuildings(map, startPoint);
      setNearbyBuildings((prev) => ({ ...prev, origin: results }));
      const target = findTargetBuilding(startPoint, results);
      const data = { type: 'FeatureCollection', features: target ? [target] : [] };
      originBuildingsDataRef.current = data;
      map.getSource('origin-buildings')?.setData(data);
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
      const target = findTargetBuilding(endPoint, results);
      const data = { type: 'FeatureCollection', features: target ? [target] : [] };
      destinationBuildingsDataRef.current = data;
      map.getSource('destination-buildings')?.setData(data);
    };
    map.once('idle', handler);
    return () => map.off('idle', handler);
  }, [endPoint]);

  // ---- Pin-grid computation (braille rasterization) ----
  // Recomputes on every pan/zoom — the grid always tracks the viewport.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    // Clear pin grid when not in tactile mode
    if (!showTactile) {
      pinGridDataRef.current = EMPTY_GEOJSON;
      pinGridMaskRef.current = EMPTY_GEOJSON;
      if (mapLoadedRef.current) {
        map.getSource('pin-grid-pins')?.setData(EMPTY_GEOJSON);
        map.getSource('pin-grid-mask')?.setData(EMPTY_GEOJSON);
      }
      return;
    }

    const computeGrid = () => {
      if (!mapLoadedRef.current) return;

      const zoom = map.getZoom();
      if (zoom < MIN_ZOOM) {
        pinGridDataRef.current = EMPTY_GEOJSON;
        pinGridMaskRef.current = EMPTY_GEOJSON;
        map.getSource('pin-grid-pins')?.setData(EMPTY_GEOJSON);
        map.getSource('pin-grid-mask')?.setData(EMPTY_GEOJSON);
        return;
      }

      const bbox = computeScaleBBox(map, pinScale, bboxPadding);
      setPinBbox(bbox);
      const roads = queryRoadFeatures(map, bbox);
      const grid = rasterizeRoads(roads, bbox);
      const { pinGeoJSON, maskGeoJSON } = pinGridToGeoJSON(grid, bbox);

      pinGridDataRef.current = pinGeoJSON;
      pinGridMaskRef.current = maskGeoJSON;
      map.getSource('pin-grid-pins')?.setData(pinGeoJSON);
      map.getSource('pin-grid-mask')?.setData(maskGeoJSON);
    };

    // Compute now and on every subsequent pan/zoom stop
    map.on('moveend', computeGrid);
    computeGrid();

    return () => map.off('moveend', computeGrid);
  }, [showTactile, pinScale, bboxPadding]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapLoadedRef.current || !map) {
      return;
    }

    const selectedId = selectedImageId == null ? '' : String(selectedImageId);
    const isSelected = ['==', ['to-string', ['get', 'id']], selectedId];

    ['origin-images-layer', 'destination-images-layer'].forEach((layerId) => {
      if (!map.getLayer(layerId)) return;
      map.setPaintProperty(layerId, 'circle-radius', ['case', isSelected, 11, 5]);
      map.setPaintProperty(layerId, 'circle-stroke-width', ['case', isSelected, 4, 1.5]);
      map.setPaintProperty(layerId, 'circle-stroke-color', ['case', isSelected, '#facc15', '#ffffff']);
    });
  }, [selectedImageId]);

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
    setEntranceOverlays({});
    setSavedEntrances({});

    try {
      const routePromise = fetchAccessibleRoute({
        accessMapBase,
        startPoint,
        endPoint,
        prefs,
      });

      const originImagesPromise = mapillaryToken
      ? routePromise.then((routeResponse) => {
        const firstRoutePoint = routeEndpointToPoint(routeResponse.route, 'first');
        return firstRoutePoint
          ? fetchNearbyMapillaryImages(firstRoutePoint, mapillaryToken)
          : [];
      })
        : Promise.resolve([]);
      const destinationImagesPromise = mapillaryToken
      ? routePromise.then((routeResponse) => {
        const lastRoutePoint = routeEndpointToPoint(routeResponse.route, 'last');
        return lastRoutePoint
          ? fetchNearbyMapillaryImages(lastRoutePoint, mapillaryToken)
          : [];
      })
        : Promise.resolve([]);

        const [routeResult, originImagesResult, destinationImagesResult] = await Promise.allSettled([
          routePromise,
          originImagesPromise,
          destinationImagesPromise,
        ]);
  
        if (routeResult.status === 'rejected') {
          throw routeResult.reason;
        }

        const routeResponse = routeResult.value;

        const originImages = selectVantageImages(
          originImagesResult.status === 'fulfilled' ? originImagesResult.value : [],
          startPoint,
          nearbyBuildings.origin,
        );
        const destinationImages = selectVantageImages(
          destinationImagesResult.status === 'fulfilled' ? destinationImagesResult.value : [],
          endPoint,
          nearbyBuildings.destination,
        );

      if (routeResponse.code !== 'Ok' || !routeResponse.route) {
        setRouteState({
          loading: false,
          error: routeMessage(routeResponse.code),
          code: routeResponse.code,
          route: null,
        });
      } else {
        setRouteState({
          loading: false,
          error: '',
          code: routeResponse.code,
          route: routeResponse.route,
        });
      }

      setImagery({ origin: originImages, destination: destinationImages });
      runEntranceDetection([...originImages, ...destinationImages]);

      if (
        originImagesResult.status === 'rejected' ||
        destinationImagesResult.status === 'rejected'
      ) {
        setImageryError('Route loaded, but Mapillary imagery could not be loaded.');
      }

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

  function handleEntranceAdjusted(imageId, barFraction) {
    setEntranceOverlays((prev) => ({
      ...prev,
      [String(imageId)]: { ...prev[String(imageId)], barFraction, adjusted: true },
    }));
  }

  const proposedEntrances = useMemo(() => {
    const targetOrigin = startPoint ? findTargetBuilding(startPoint, nearbyBuildings.origin) : null;
    const targetDest   = endPoint   ? findTargetBuilding(endPoint,   nearbyBuildings.destination) : null;
    const proposals = [];
    for (const [side, images, target] of [
      ['origin',      imagery.origin,      targetOrigin],
      ['destination', imagery.destination, targetDest],
    ]) {
      for (const image of images) {
        const detection = entranceOverlays[String(image.id)];
        if (detection == null || detection.barFraction == null) continue;
        const bearing = ((image.compassAngle + (detection.barFraction - 0.5) * 360) % 360 + 360) % 360;
        proposals.push({
          imageId:    String(image.id),
          image,
          side,
          barFraction: detection.barFraction,
          confidence:  detection.confidence,
          adjusted:    detection.adjusted ?? false,
          bearing,
          coordinate:  computeEntrancePoint(image, bearing, target),
        });
      }
    }
    return proposals;
  }, [entranceOverlays, imagery, nearbyBuildings, startPoint, endPoint]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapLoadedRef.current || !map) return;
    const features = proposedEntrances
      .filter((p) => p.coordinate)
      .map((p) => ({
        type: 'Feature',
        properties: { imageId: p.imageId, side: p.side },
        geometry: { type: 'Point', coordinates: p.coordinate },
      }));
    const data = { type: 'FeatureCollection', features };
    proposedEntranceDataRef.current = data;
    map.getSource('proposed-entrances')?.setData(data);
  }, [proposedEntrances]);

  async function handleSaveEntrance(proposal) {
    if (!proposal.coordinate) return;
    const feature = {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: proposal.coordinate },
      properties: {
        entrance: 'yes',
        source_image_id: proposal.imageId,
        confidence: proposal.confidence,
        detection_adjusted: proposal.adjusted,
        detection_method: 'yolo_mapillary',
      },
    };
    try {
      const res = await fetch('/api/save-entrance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feature }),
      });
      if (!res.ok) throw new Error(await res.text());
      setSavedEntrances((prev) => ({ ...prev, [proposal.imageId]: true }));
    } catch (e) {
      console.error('Save failed:', e);
    }
  }

  async function runEntranceDetection(images) {
    console.log(`[entrance] starting detection on ${images.length} image(s)`);
    try {
      if (!modelRef.current) {
        console.log('[entrance] loading ONNX model…');
        modelRef.current = await loadEntranceModel();
        console.log('[entrance] model ready');
      }
    } catch (e) {
      console.warn('[entrance] model failed to load:', e);
      return;
    }
    for (const image of images) {
      if (!image.imageUrl) continue;
      try {
        const result = await detectEntrance(image.imageUrl, modelRef.current);
        console.log(`[entrance] ${image.id} →`, result ?? 'no detection');
        setEntranceOverlays((prev) => ({ ...prev, [String(image.id)]: result }));
      } catch (e) {
        console.warn(`[entrance] detection failed for ${image.id}:`, e);
      }
    }
    console.log('[entrance] done');
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

          <label className="switch-row">
            <input
              type="checkbox"
              checked={showTactile}
              onChange={(event) => setShowTactile(event.target.checked)}
            />
            <span>Tactile map</span>
          </label>

          {showTactile && (
            <div style={{ paddingLeft: '1rem', borderLeft: '2px solid #e5e7eb' }}>
              <SliderField
                label={`Scale 1:${pinScale.toLocaleString()}`}
                min={500}
                max={20000}
                step={500}
                value={pinScale}
                onChange={setPinScale}
              />
              <SliderField
                label={`Grid padding: ${Math.round(bboxPadding * 100)}%`}
                min={0}
                max={0.5}
                step={0.05}
                value={bboxPadding}
                onChange={setBboxPadding}
              />
              <label className="switch-row" style={{ marginBottom: 0 }}>
                <input
                  type="checkbox"
                  checked={showExplorer}
                  onChange={(e) => setShowExplorer(e.target.checked)}
                />
                <span>Explore with camera</span>
              </label>
            </div>
          )}

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

          <ImageBucket
            title="Origin frontage"
            images={imagery.origin}
            selectedImageId={selectedImageId}
            onSelectImage={setSelectedImageId}
            imageCardRefs={imageCardRefs}
            onExpandImage={setExpandedImage}
            entranceOverlays={entranceOverlays}
          />
          <ImageBucket
            title="Destination frontage"
            images={imagery.destination}
            selectedImageId={selectedImageId}
            onSelectImage={setSelectedImageId}
            imageCardRefs={imageCardRefs}
            onExpandImage={setExpandedImage}
            entranceOverlays={entranceOverlays}
          />

          {imageryError ? <p className="error-text">{imageryError}</p> : null}
          {!mapillaryToken ? (
            <p className="inline-note">Use a Mapillary client token for nearby thumbnail imagery.</p>
          ) : null}
        </section>

        {proposedEntrances.length > 0 && (
          <section className="panel-section compact">
            <h2>Entrance proposals</h2>
            <ul className="entrance-list">
              {proposedEntrances.map((p) => (
                <li key={p.imageId} className={`entrance-item ${p.side}`}>
                  <span className="entrance-dot" />
                  <div className="entrance-body">
                    {p.coordinate ? (
                      <code className="entrance-coord">
                        {p.coordinate[1].toFixed(6)}, {p.coordinate[0].toFixed(6)}
                      </code>
                    ) : (
                      <em className="entrance-no-hit">No building intersection</em>
                    )}
                    <span className="entrance-meta">
                      {p.confidence != null ? `conf ${p.confidence.toFixed(2)}` : 'manual'}{p.adjusted ? ' · adjusted' : ''}
                    </span>
                  </div>
                  {p.coordinate && (
                    <button
                      type="button"
                      className={`entrance-save-btn ${savedEntrances[p.imageId] ? 'saved' : ''}`}
                      onClick={() => handleSaveEntrance(p)}
                      disabled={!!savedEntrances[p.imageId]}
                      title="Save to resources/entrances.geojson"
                    >
                      {savedEntrances[p.imageId] ? '✓' : 'Save'}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
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

        {expandedImage ? (
          <ImageViewer
            image={expandedImage}
            entranceFraction={entranceOverlays[String(expandedImage.id)]?.barFraction ?? null}
            onEntranceAdjusted={handleEntranceAdjusted}
            mapRef={mapRef}
            mapLoadedRef={mapLoadedRef}
            onClose={() => setExpandedImage(null)}
          />
        ) : null}

        {showExplorer && showTactile && (
          <TactileExplorer
            bbox={pinBbox}
            mapRef={mapRef}
            mapLoadedRef={mapLoadedRef}
            templateUrl="/Vision Walk.jpg"
          />
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

function ImageBucket({ title, images, selectedImageId, onSelectImage, imageCardRefs, onExpandImage, entranceOverlays }) {
  return (
    <div className="image-bucket">
      <h3>{title}</h3>
      {images.length ? (
        <div className="image-grid">
          {images.map((image) => {
            const imageId = String(image.id);
            const isSelected = selectedImageId === imageId;
            const detection = entranceOverlays?.[imageId];
            const hasEntrance = detection != null;

            return (
              <article
                key={image.id}
                ref={(element) => {
                  if (element) {
                    imageCardRefs.current[imageId] = element;
                  } else {
                    delete imageCardRefs.current[imageId];
                  }
                }}
                className={`image-card ${isSelected ? 'selected' : ''}`}
                onClick={() => onExpandImage?.(image)}
                onMouseEnter={() => onSelectImage?.(imageId)}
                onMouseLeave={() => onSelectImage?.(null)}
              >
                {image.imageUrl ? <img src={image.imageUrl} alt={title} loading="lazy" /> : null}
                {hasEntrance && (
                  <div className="entrance-badge" title={detection.confidence != null ? `Entrance detected (conf ${detection.confidence.toFixed(2)})` : 'Entrance marked'} />
                )}
                <div className="image-meta">
                  <strong>{image.distanceMeters ? `${image.distanceMeters} m away` : 'Nearby image'}</strong>
                  <span>{image.capturedAt ? formatDate(image.capturedAt) : 'Capture date unavailable'}</span>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <p className="empty-state">No imagery loaded yet.</p>
      )}
    </div>
  );
}

async function fetchAccessibleRoute({ accessMapBase, startPoint, endPoint, prefs }) {
  const base = accessMapBase.replace(/\/$/, '');
  const url = new URL(`${base}/shortest_path/custom.json`, window.location.origin);
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
  const url = new URL('https://graph.mapillary.com/images');
  url.search = new URLSearchParams({
    access_token: token,
    fields: 'id,captured_at,thumb_1024_url,geometry,computed_geometry,compass_angle,computed_compass_angle,camera_type,is_pano',
    bbox: buildBboxMeters(point, 50).join(','),
  }).toString();

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Mapillary request failed with status ${response.status}.`);
  }

  const data = await response.json();
  return (data.data || [])
    .map((item) => normalizeImage(item, point))
    .filter((item) => item.imageUrl && item.isPano);
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

  const routablePoint = feature?.properties?.coordinates?.routable_points?.[0];
  if (routablePoint?.longitude != null && routablePoint?.latitude != null) {
    return {
      lng: routablePoint.longitude,
      lat: routablePoint.latitude,
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

function routeEndpointToPoint(route, endpoint) {
  const coordinates = route?.geometry?.coordinates;
  if (!coordinates?.length) return null;
  const coordinate = endpoint === 'first' ? coordinates[0] : coordinates[coordinates.length - 1];
  return { lng: coordinate[0], lat: coordinate[1] };
}

function updateHeadingLine(map, loaded, image, headingAngle) {
  if (!map || !loaded) return;
  const source = map.getSource('heading-line');
  if (!source) return;

  if (!image?.geometry) {
    source.setData(EMPTY_GEOJSON);
    return;
  }

  const [lng, lat] = image.geometry.coordinates;
  const radiusMeters = 20;
  const latRad = (lat * Math.PI) / 180;
  const a = (headingAngle * Math.PI) / 180;

  source.setData({
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: [
          [lng, lat],
          [
            lng + (Math.sin(a) * radiusMeters) / (111320 * Math.cos(latRad)),
            lat + (Math.cos(a) * radiusMeters) / 111320,
          ],
        ],
      },
    }],
  });
}

function updateMapEntranceLine(map, loaded, image, bearingAngle) {
  if (!map || !loaded) return;
  const source = map.getSource('entrance-line');
  if (!source) return;

  if (!image?.geometry) {
    source.setData(EMPTY_GEOJSON);
    return;
  }

  const [lng, lat] = image.geometry.coordinates;
  const radiusMeters = 20;
  const latRad = (lat * Math.PI) / 180;
  const a = (bearingAngle * Math.PI) / 180;

  source.setData({
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: [
          [lng, lat],
          [
            lng + (Math.sin(a) * radiusMeters) / (111320 * Math.cos(latRad)),
            lat + (Math.cos(a) * radiusMeters) / 111320,
          ],
        ],
      },
    }],
  });
}

function ImageViewer({ image, entranceFraction, onEntranceAdjusted, mapRef, mapLoadedRef, onClose }) {
  return (
    <div className="viewer-panel">
      {image.isPano
        ? <PanoViewer image={image} entranceFraction={entranceFraction} onEntranceAdjusted={onEntranceAdjusted} mapRef={mapRef} mapLoadedRef={mapLoadedRef} onClose={onClose} />
        : <FlatViewer image={image} entranceFraction={entranceFraction} onEntranceAdjusted={onEntranceAdjusted} mapRef={mapRef} mapLoadedRef={mapLoadedRef} onClose={onClose} />
      }
    </div>
  );
}

function PanoViewer({ image, entranceFraction, onEntranceAdjusted, mapRef, mapLoadedRef, onClose }) {
  const containerRef = useRef(null);
  const psvRef = useRef(null);
  const entranceFractionRef = useRef(entranceFraction);
  const currentYawRef = useRef(0);

  // Sync ref and react to late-arriving detections without recreating the viewer
  useEffect(() => {
    entranceFractionRef.current = entranceFraction;
    if (entranceFraction == null || !psvRef.current) return;
    const entranceYaw = (entranceFraction - 0.5) * 2 * Math.PI;
    psvRef.current.animate({ yaw: entranceYaw, pitch: 0, speed: '3rpm' });
  }, [entranceFraction]);

  // Create/destroy PSV only when the image changes
  useEffect(() => {
    if (!containerRef.current) return;
    let viewer;

    updateHeadingLine(mapRef.current, mapLoadedRef.current, image, image.compassAngle);

    import('@photo-sphere-viewer/core').then(({ Viewer }) => {
      if (!containerRef.current) return;
      viewer = new Viewer({
        container: containerRef.current,
        panorama: image.imageUrl,
        defaultYaw: 0,
        navbar: false,
        loadingImg: null,
        touchmoveTwoFingers: false,
      });
      psvRef.current = viewer;

      viewer.addEventListener('position-updated', ({ position }) => {
        currentYawRef.current = position.yaw;
        const yawDeg = (position.yaw * 180) / Math.PI;
        updateHeadingLine(mapRef.current, mapLoadedRef.current, image,
          (image.compassAngle + yawDeg + 360) % 360);
      });

      viewer.addEventListener('ready', () => {
        const fraction = entranceFractionRef.current;
        if (fraction == null) return;
        const entranceYaw = (fraction - 0.5) * 2 * Math.PI;
        viewer.animate({ yaw: entranceYaw, pitch: 0, speed: '3rpm' });
      });
    });

    return () => {
      psvRef.current = null;
      updateHeadingLine(mapRef.current, mapLoadedRef.current, null, 0);
      viewer?.destroy();
    };
  }, [image.id]);

  return (
    <>
      <div className="viewer-panel-header">
        <span className="viewer-panel-label">360° · pan to aim · green = entrance</span>
        <div className="viewer-header-actions">
          <button
            type="button"
            className="viewer-mark-entrance-btn"
            onClick={() => {
              const fraction = ((currentYawRef.current / (2 * Math.PI) + 0.5) % 1 + 1) % 1;
              onEntranceAdjusted?.(image.id, fraction);
            }}
            title="Mark the crosshair position as the entrance"
          >
            Mark entrance
          </button>
          <button className="viewer-close" onClick={onClose}>×</button>
        </div>
      </div>
      <div ref={containerRef} className="viewer-pano-container" />
      <div className="viewer-crosshair" />
    </>
  );
}

function FlatViewer({ image, entranceFraction, onEntranceAdjusted, mapRef, mapLoadedRef, onClose }) {
  const [barFraction, setBarFraction] = useState(0.5);
  const [entranceBarFraction, setEntranceBarFraction] = useState(entranceFraction ?? null);
  const dragging = useRef(null); // null | 'heading' | 'entrance'
  const currentEntranceFractionRef = useRef(entranceFraction ?? null);
  const containerRef = useRef(null);
  const halfFov = (image.cameraType === 'fisheye' ? 150 : 65) / 2;

  useEffect(() => {
    if (entranceFraction != null) {
      setEntranceBarFraction(entranceFraction);
      currentEntranceFractionRef.current = entranceFraction;
    }
  }, [entranceFraction]);

  useEffect(() => {
    updateHeadingLine(mapRef.current, mapLoadedRef.current, image, image.compassAngle);
    return () => updateHeadingLine(mapRef.current, mapLoadedRef.current, null, 0);
  }, [image.id]);

  function handlePointerMove(e) {
    if (!dragging.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    if (dragging.current === 'heading') {
      setBarFraction(fraction);
      updateHeadingLine(mapRef.current, mapLoadedRef.current, image,
        (image.compassAngle - halfFov + fraction * halfFov * 2 + 360) % 360);
    } else {
      setEntranceBarFraction(fraction);
      currentEntranceFractionRef.current = fraction;
    }
  }

  return (
    <>
      <div className="viewer-panel-header">
        <span className="viewer-panel-label">{halfFov * 2}° FOV · drag bar to aim</span>
        <button className="viewer-close" onClick={onClose}>×</button>
      </div>
      <div
        ref={containerRef}
        className="viewer-flat-container"
        onPointerDown={(e) => {
          dragging.current = e.target.classList.contains('viewer-entrance-bar') ? 'entrance' : 'heading';
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerUp={() => {
          if (dragging.current === 'entrance' && currentEntranceFractionRef.current != null) {
            onEntranceAdjusted?.(image.id, currentEntranceFractionRef.current);
          }
          dragging.current = null;
        }}
        onPointerMove={handlePointerMove}
      >
        <img src={image.imageUrl} alt="" draggable={false} />
        <div className="viewer-heading-bar" style={{ left: `${barFraction * 100}%` }} />
        {entranceBarFraction != null && (
          <div className="viewer-entrance-bar" style={{ left: `${entranceBarFraction * 100}%` }} />
        )}
      </div>
    </>
  );
}

function buildBboxMeters(point, meters) {
  const latDelta = meters / 111320;
  const lngDelta = meters / (111320 * Math.cos((point.lat * Math.PI) / 180));
  return [point.lng - lngDelta, point.lat - latDelta, point.lng + lngDelta, point.lat + latDelta];
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

function toMapillaryLookupPointGeoJson(route) {
  const coordinates = route?.geometry?.coordinates;
  if (!coordinates?.length) {
    return EMPTY_GEOJSON;
  }

  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { endpoint: 'origin' },
        geometry: {
          type: 'Point',
          coordinates: coordinates[0],
        },
      },
      {
        type: 'Feature',
        properties: { endpoint: 'destination' },
        geometry: {
          type: 'Point',
          coordinates: coordinates[coordinates.length - 1],
        },
      },
    ],
  };
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

// ---- Vantage-point image selection ----

function geoBearingTo(from, to) {
  const φ1 = (from.lat * Math.PI) / 180;
  const φ2 = (to.lat * Math.PI) / 180;
  const Δλ = ((to.lng - from.lng) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function inAngularSpan(bearing, b1, b2) {
  const norm = (b) => ((b % 360) + 360) % 360;
  bearing = norm(bearing);
  b1 = norm(b1);
  b2 = norm(b2);
  const diff = norm(b2 - b1);
  // Use the shorter arc; if diff > 180 the shorter arc goes b2 → b1
  if (diff > 180) {
    return norm(bearing - b2) <= 360 - diff;
  }
  return norm(bearing - b1) <= diff;
}

function segmentsIntersect(a1, a2, b1, b2) {
  function cross(o, a, b) {
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  }
  const d1 = cross(b1, b2, a1);
  const d2 = cross(b1, b2, a2);
  const d3 = cross(a1, a2, b1);
  const d4 = cross(a1, a2, b2);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
         ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function segmentClearsBuildings(p1, p2, buildingFeatures, excludeFeature) {
  for (const f of buildingFeatures) {
    if (f === excludeFeature) continue;
    const geom = f.geometry;
    if (!geom) continue;
    const rings = geom.type === 'MultiPolygon' ? geom.coordinates[0] : geom.coordinates;
    const ring = rings[0];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      if (segmentsIntersect(p1, p2, ring[j], ring[i])) return false;
    }
  }
  return true;
}

function pointInRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if ((yi > point.lat) !== (yj > point.lat) &&
        point.lng < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function findTargetBuilding(point, buildingFeatures) {
  for (const f of buildingFeatures) {
    if (!f.geometry) continue;
    const geom = f.geometry;
    const rings = geom.type === 'MultiPolygon' ? geom.coordinates[0] : geom.coordinates;
    if (pointInRing(point, rings[0])) return f;
  }
  // Waypoint is on the street — fall back to the building whose centroid is closest
  let nearest = null;
  let minDist = Infinity;
  for (const f of buildingFeatures) {
    if (!f.geometry) continue;
    const rings = f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates[0] : f.geometry.coordinates;
    const ring = rings[0];
    const centLng = ring.reduce((s, c) => s + c[0], 0) / ring.length;
    const centLat = ring.reduce((s, c) => s + c[1], 0) / ring.length;
    const d = distanceBetween(point, { lng: centLng, lat: centLat });
    if (d < minDist) { minDist = d; nearest = f; }
  }
  return nearest;
}

function spatialDedup(images, minDistMeters = 15) {
  const kept = [];
  for (const img of images) {
    if (!img.geometry) continue;
    const [lng, lat] = img.geometry.coordinates;
    const tooClose = kept.some((s) => {
      const [slng, slat] = s.geometry.coordinates;
      return distanceBetween({ lng, lat }, { lng: slng, lat: slat }) < minDistMeters;
    });
    if (!tooClose) kept.push(img);
  }
  return kept;
}

function selectVantageImages(images, point, buildingFeatures) {
  const target = findTargetBuilding(point, buildingFeatures);

  if (!target) {
    return spatialDedup(
      [...images].sort((a, b) => (a.distanceMeters ?? 9999) - (b.distanceMeters ?? 9999)),
    );
  }

  const geom = target.geometry;
  const rings = geom.type === 'MultiPolygon' ? geom.coordinates[0] : geom.coordinates;
  const ring = rings[0];

  // Assign each image to the best-scoring face whose span it falls in
  const faceGroups = new Map(); // faceIndex -> [{img, score}]

  for (const img of images) {
    if (!img.geometry) continue;
    const [cLng, cLat] = img.geometry.coordinates;
    const cBearing = geoBearingTo(point, { lng: cLng, lat: cLat });
    let bestFace = -1;
    let bestScore = -1;

    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const v1 = ring[j];
      const v2 = ring[i];
      const b1 = geoBearingTo(point, { lng: v1[0], lat: v1[1] });
      const b2 = geoBearingTo(point, { lng: v2[0], lat: v2[1] });

      if (!inAngularSpan(cBearing, b1, b2)) continue;

      // Outward-side check: camera must be on the exterior of this face.
      // Rotate wall direction 90° to get a candidate normal; pick the sign
      // that points away from the polygon interior (i.e. toward the camera).
      const wLng = v2[0] - v1[0];
      const wLat = v2[1] - v1[1];
      const wLen = Math.hypot(wLng, wLat);
      if (wLen < 1e-10) continue;
      const nLng = -wLat / wLen;
      const nLat = wLng / wLen;
      if (nLng * (cLng - v1[0]) + nLat * (cLat - v1[1]) <= 0) continue;

      const midLng = (v1[0] + v2[0]) / 2;
      const midLat = (v1[1] + v2[1]) / 2;

      if (!segmentClearsBuildings([cLng, cLat], [midLng, midLat], buildingFeatures, target)) continue;

      const d = distanceBetween({ lng: cLng, lat: cLat }, { lng: midLng, lat: midLat });
      const faceLen = distanceBetween({ lng: v1[0], lat: v1[1] }, { lng: v2[0], lat: v2[1] });
      const ideal = Math.max(8, faceLen * 1.2);
      const score = Math.exp(-0.5 * Math.pow((d - ideal) / 6, 2));

      if (score > bestScore) { bestScore = score; bestFace = i; }
    }

    if (bestFace >= 0) {
      if (!faceGroups.has(bestFace)) faceGroups.set(bestFace, []);
      faceGroups.get(bestFace).push({ img, score: bestScore });
    }
  }

  if (faceGroups.size === 0) {
    return spatialDedup(
      [...images].sort((a, b) => (a.distanceMeters ?? 9999) - (b.distanceMeters ?? 9999)),
    );
  }

  // Per face: sort by score desc, then spatial dedup to thin same-run clusters
  const result = [];
  for (const candidates of faceGroups.values()) {
    candidates.sort((a, b) => b.score - a.score);
    result.push(...spatialDedup(candidates.map((c) => c.img)));
  }
  return result;
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

// Shoots a ray from the camera in the given bearing and returns the [lng, lat]
// of the first wall intersection on the target building.
function computeEntrancePoint(image, bearing, buildingFeature) {
  if (!image.geometry || !buildingFeature?.geometry) return null;

  const [camLng, camLat] = image.geometry.coordinates;
  const cosLat = Math.cos((camLat * Math.PI) / 180);
  const cx = camLng * cosLat;
  const cy = camLat;
  const bearingRad = (bearing * Math.PI) / 180;
  const dx = Math.sin(bearingRad);
  const dy = Math.cos(bearingRad);

  const geom = buildingFeature.geometry;
  const rings = geom.type === 'MultiPolygon' ? geom.coordinates[0] : geom.coordinates;
  const ring  = rings[0];

  let best = null;
  let bestT = Infinity;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const ax = ring[j][0] * cosLat, ay = ring[j][1];
    const bx = ring[i][0] * cosLat, by = ring[i][1];
    const ex = bx - ax, ey = by - ay;
    const denom = dy * ex - dx * ey;
    if (Math.abs(denom) < 1e-14) continue;
    const fx = ax - cx, fy = ay - cy;
    const t = (fy * ex - fx * ey) / denom;
    const u = (dx * fy - dy * fx) / denom;
    if (t > 1e-7 && u >= 0 && u <= 1 && t < bestT) {
      bestT = t;
      best = [(cx + t * dx) / cosLat, cy + t * dy]; // [lng, lat]
    }
  }

  return best;
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
