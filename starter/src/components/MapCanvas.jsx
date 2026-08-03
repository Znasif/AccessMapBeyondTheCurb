/**
 * Map container, or a placeholder when no Mapbox token is configured.
 *
 * The div must stay mounted for mapboxgl to attach to, so the token check
 * happens here rather than around the whole main panel.
 */
export function MapCanvas({ containerRef, hasToken, children }) {
  return (
    <main className="map-panel">
      {hasToken ? (
        <div ref={containerRef} className="map" />
      ) : (
        <div className="map-placeholder">
          <div>
            <h2>Map preview disabled</h2>
            <p>
              Add <code>VITE_MAPBOX_TOKEN</code> to start the map at GitHub
              headquarters in San Francisco.
            </p>
          </div>
        </div>
      )}
      {children}
    </main>
  );
}

export default MapCanvas;
