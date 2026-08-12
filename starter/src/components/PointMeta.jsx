/** Coordinate readout for the currently selected place. */
export function PointMeta({ point }) {
  if (!point) {
    return <p className="point-meta empty">Click the map or search to choose a location.</p>;
  }

  return (
    <p className="point-meta">
      {point.lat.toFixed(5)}, {point.lng.toFixed(5)}
    </p>
  );
}

export default PointMeta;
