/**
 * Audiom integration helpers for the generalized tactile explorer.
 *
 * Not beholden to OSM: loads any saved Audiom map by id and maps a pre-made
 * physical tactile material onto it via four corners. See audiom-tactile-guide.md.
 */

// ---- config (works with the existing .env; VITE_AUDIOM_ORIGIN is optional) ----
const EMBED_URL = (import.meta.env.VITE_AUDIOM_EMBED_URL || '').trim();
export const AUDIOM_ORIGIN = (() => {
  const explicit = (import.meta.env.VITE_AUDIOM_ORIGIN || '').trim();
  if (explicit) return explicit.replace(/\/$/, '');
  try { return new URL(EMBED_URL).origin; } catch { /* noop */ }
  return 'https://audiom-staging.herokuapp.com';
})();
// Prefer the full-access key: it resolves pre-configured embeds (e.g. /embed/570,
// the human skeleton). The standard key only works for dynamic `sources`.
export const AUDIOM_KEY = (
  import.meta.env.VITE_AUDIOM_FULL_ACCESS_KEY || import.meta.env.VITE_AUDIOM_KEY || ''
).trim();

// ---- 1. parse a map id from a pasted Audiom URL or bare id ----
// Accepts "885", ".../maps/d/885", ".../embed/885", ".../map/885" (+ query/hash).
export function parseAudiomId(input) {
  const s = String(input || '').trim();
  if (/^\d+$/.test(s)) return s;
  const m = s.match(/\/(?:maps\/d|embed|map)\/(\d+)/);
  return m ? m[1] : null;
}

// A pre-configured EMBED id: a bare number or an `/embed/<id>` URL. This is a
// DIFFERENT namespace from the map-editor id in `/maps/d/<id>` — e.g. the human
// skeleton's embed id is 570, which is not its editor id.
export function parseEmbedId(input) {
  const s = String(input || '').trim();
  if (/^\d+$/.test(s)) return s;
  const m = s.match(/\/embed\/(\d+)(?:[/?#]|$)/); // /embed/<id> but NOT /embed/d/<id>
  return m ? m[1] : null;
}

// A map-EDITOR map id, from `/maps/d/<id>` or `/embed/d/<id>`. These embed via
// the `/embed/d/<id>` route (verified: /embed/d/885 loads the Wisconsin map).
export function parseMapId(input) {
  const s = String(input || '').trim();
  const m = s.match(/\/(?:maps|embed)\/d\/(\d+)/);
  return m ? m[1] : null;
}

// Pull center/zoom out of a pasted URL if present (e.g. a /map?center=..&zoom=.. link).
export function parseAudiomView(input) {
  const out = {};
  try {
    const u = new URL(String(input), window.location.origin);
    const center = u.searchParams.get('center');
    if (center) {
      const [lng, lat] = center.replace(/['"]/g, '').split(',').map(Number);
      if (Number.isFinite(lng) && Number.isFinite(lat)) { out.centerLng = lng; out.centerLat = lat; }
    }
    const zoom = Number(u.searchParams.get('zoom'));
    if (Number.isFinite(zoom) && zoom > 0) out.zoom = zoom;
  } catch { /* not a URL */ }
  return out;
}

// Predefined embeddable sources. Anything other than "osm" fulfils the
// "not beholden to OSM" goal. A direct GeoJSON URL also works as a source.
export const PREDEFINED_SOURCES = [
  'osm', 'TDEI', 'covid_daily', 'goodmaps', 'coon', 'IMDF', 'presidential_election',
];

// ---- 2. build the embed src ----
// IMPORTANT (verified against staging): the embed loads DATA from `sources`, not
// from a saved-map id. `/embed/885` sends no sources -> "Map not ready" forever.
// So we drive `/embed/dynamic` with an explicit source: a predefined id above or
// a direct GeoJSON URL. `center`+`zoom` pin the view to the printed material.
export function buildEmbedSrc({ embedId, mapId, sources, center, zoom } = {}) {
  const p = new URLSearchParams();
  if (AUDIOM_KEY) p.set('apiKey', AUDIOM_KEY);
  p.set('allowedOrigins', window.location.origin); // required to enable postMessage
  p.set('showVisualMap', 'true');
  p.set('showHeading', 'false');
  // A pre-configured embed (/embed/<id>) or a saved map-editor map (/embed/d/<id>)
  // carries its own data + view, so we don't pass sources/center/zoom. A dynamic
  // source needs them.
  if (!embedId && !mapId) {
    if (sources) p.set('sources', sources);
    if (center && Number.isFinite(center.lng) && Number.isFinite(center.lat)) {
      p.set('center', `${center.lng.toFixed(6)},${center.lat.toFixed(6)}`);
    }
    if (zoom != null && Number.isFinite(zoom)) p.set('zoom', Number(zoom).toFixed(3));
  }
  const path = mapId ? `/embed/d/${mapId}` : embedId ? `/embed/${embedId}` : '/embed/dynamic';
  return `${AUDIOM_ORIGIN}${path}?${p.toString()}`;
}

// Extract a `sources`/`source` value from a pasted Audiom /map?… URL, if present.
export function parseAudiomSources(input) {
  try {
    const u = new URL(String(input), window.location.origin);
    return u.searchParams.get('sources') || u.searchParams.get('source') || '';
  } catch { return ''; }
}

// ---- 3. Web-Mercator helpers ----
const TILE = 512;
const mercX = (lng) => (lng + 180) / 360;
const mercY = (lat) => {
  const s = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
};
const invMercX = (x) => x * 360 - 180;
const invMercY = (y) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;

// ---- 4. center+zoom+pixel-size -> geographic bbox [minLng,minLat,maxLng,maxLat] ----
// width/height are the iframe pixel size; use the physical material's aspect ratio.
export function viewToBbox({ centerLng, centerLat, zoom, width, height }) {
  const scale = TILE * 2 ** zoom;
  const cx = mercX(centerLng), cy = mercY(centerLat);
  const hx = width / 2 / scale, hy = height / 2 / scale;
  return [
    invMercX(cx - hx),   // minLng (left)
    invMercY(cy + hy),   // minLat (bottom -> larger mercY)
    invMercX(cx + hx),   // maxLng (right)
    invMercY(cy - hy),   // maxLat (top    -> smaller mercY)
  ];
}

// Approx span in metres of a bbox (used to derive a step-matched deadband).
export function bboxSpanMeters(bbox) {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  const midLat = (minLat + maxLat) / 2;
  const w = Math.abs(maxLng - minLng) * 111320 * Math.cos((midLat * Math.PI) / 180);
  const h = Math.abs(maxLat - minLat) * 111320;
  return Math.max(w, h);
}

// ---- 5. normalized (u,v) in the 4 corners -> a point in the MAP'S space ----
// u=0 left, u=1 right ; v=0 top, v=1 bottom.
//
// Geographic map: interpolate lng linearly, lat in mercator-Y (matches a print of
// Audiom's Web-Mercator visual). Returns { lng, lat } for moveAvatar.
export function uvToLngLat(u, v, bbox) {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  const lng = minLng + u * (maxLng - minLng);
  const yTop = mercY(maxLat), yBot = mercY(minLat);
  const lat = invMercY(yTop + v * (yBot - yTop));
  return { lng, lat };
}

// Spatial diagram / ENU map: East/North metres only, interpolate LINEARLY.
// enBox = { e0, n0, e1, n1 } from the map's announced dimensions.
// NOTE: moveAvatar is lat/lng-only per the docs, so a pure diagram needs Audiom
// to accept E/N — see §9 of the guide (open item).
export function uvToEastNorth(u, v, enBox) {
  const { e0, n0, e1, n1 } = enBox;
  return { e: e0 + u * (e1 - e0), n: n1 - v * (n1 - n0) };
}
