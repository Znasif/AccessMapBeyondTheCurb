/**
 * CamioWorldAdapter — milestone 6.
 *
 * The `.camio` route of `browser-voice-exploration-plan.md` §3 / design §3.3.
 * Frame **image** (template pixels), capabilities `{places, regions}` → 7 tools
 * reach the prompt (`toolFilter.js`; the schema's own `capabilityProfiles`).
 *
 * The input contract is taken from what this repo actually has, not from a guess
 * at `@camio/common`:
 *
 *   `explore/models/ProjectLoader.ts`        `data` (ProjectData), `templateBase64`,
 *                                            `colorMapBase64`, `soundFilesBase64s`
 *   `explore/viewmodels/InteractionViewModel.ts`
 *                                            `projectLoader.getProjectData().hotspots`,
 *                                            `hotspot.compareColor(color)`, `hotspot.sound`
 *   `explore/viewmodels/TemplateMatchingViewModel.ts#getColorAtPoint`
 *                                            `colorMap.ucharPtr(y, x)` → `new Color(r, g, b)`
 *   `explore/Explore.ts`                     `hotspot.title`, `hotspot.description`
 *   `explore/simple_camio_llm/models/new_york/new_york.json`
 *                                            POI records (`name`, `categories`,
 *                                            `location_description`, `coords`), the shape
 *                                            `placeIndex.js#fromCamioPoi` already consumes
 *
 * So: a hotspot is `{ color, title, description, sound? }`, the colour map is read
 * one pixel at a time in (x, y), and POIs — when a project carries them — are the
 * MapIO-shaped records `fromCamioPoi()` was fitted to. Everything is accepted in a
 * few spellings (`title`/`name`, `{r,g,b}`/`[r,g,b]`/`"#rrggbb"`/packed int) because
 * `ProjectData` is not vendored here and the exact casing cannot be verified.
 *
 * ZERO platform imports — no `Image`, no canvas, no DOM, no fetch. The colour map
 * arrives as an injectable pixel accessor:
 *
 *   { width, height, getPixel(x, y) -> [r,g,b] | {r,g,b} | 0xRRGGBB }
 *
 * A browser caller wraps `ctx.getImageData()` (or the cv.Mat of
 * `TemplateMatchingViewModel`); Node tests build one over a plain array. That is
 * the whole platform boundary, and it is one function wide.
 *
 * WHAT COSTS WHAT
 *   construction  one full-grid pass, O(W·H) `getPixel` calls, two comparisons per
 *                 pixel (left and up). It yields, in that single pass: per-region
 *                 pixel count, bounding box, centroid, boundary pixels, and the
 *                 complete 4-neighbourhood adjacency. Nothing rescans the grid.
 *   at(u, v)      exactly one `getPixel`. L0, no inference (§3).
 *   nearby/dist   bounding-box reject, then O(perimeter) over stored boundary
 *                 pixels of the surviving regions. Never O(W·H).
 */

import {
  CAPABILITIES,
  FRAMES,
  WorldAdapter,
  ambiguous,
  isAmbiguous,
  unsupported,
} from '../worldAdapter.js';

/** Millimetres on the material — the only unit this frame may answer in (§5.4). */
export const MATERIAL_UNITS = 'material_mm';

/**
 * Default `nearby` radius. A finger explores a printed sheet in centimetres, not
 * metres: 25 mm is about a finger-width past the fingertip, so "what's near here"
 * returns the couple of hotspots a user could reach without lifting off, rather
 * than half the sheet. Callers override per query.
 */
export const DEFAULT_NEARBY_RADIUS_MM = 25;

/** Not a colour key: the sentinel for background / unknown colours. */
const NO_REGION = -1;

/* ------------------------------------------------------------- colour keys -- */

/**
 * Pack a colour into a single int, `(r << 16) | (g << 8) | b`.
 *
 * This is `Color.toKey()` from `@camio/common/utils` in integer form — the colour
 * is an identifier, not an appearance (§3), so the only operations it needs are
 * equality and Map lookup. Alpha is dropped: the colour map is opaque, and a
 * canvas-backed accessor hands back RGBA.
 *
 * @param {number[]|Uint8Array|{r:number,g:number,b:number}|string|number} value
 * @returns {number}
 */
export function colorKey(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`camio: colour key is not finite: ${value}`);
    return value & 0xffffff;
  }
  if (typeof value === 'string') {
    const text = value.trim();
    const hex = /^#?([0-9a-f]{6})$/i.exec(text);
    if (hex) return parseInt(hex[1], 16);
    const short = /^#?([0-9a-f]{3})$/i.exec(text);
    if (short) {
      const [r, g, b] = short[1].split('').map((c) => parseInt(c + c, 16));
      return pack(r, g, b);
    }
    const csv = text.split(/[,\s]+/).map(Number);
    if (csv.length >= 3 && csv.every((n) => Number.isFinite(n))) return pack(csv[0], csv[1], csv[2]);
    throw new Error(`camio: cannot read colour ${JSON.stringify(value)}`);
  }
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    if (value.length < 3) throw new Error(`camio: colour array needs 3 components, got ${value.length}`);
    return pack(value[0], value[1], value[2]);
  }
  if (value && typeof value === 'object') {
    const { r, g, b, red, green, blue } = /** @type {any} */ (value);
    const rr = r ?? red;
    const gg = g ?? green;
    const bb = b ?? blue;
    if ([rr, gg, bb].every((n) => typeof n === 'number')) return pack(rr, gg, bb);
  }
  throw new Error(`camio: cannot read colour ${JSON.stringify(value)}`);
}

/** @param {number} r @param {number} g @param {number} b */
function pack(r, g, b) {
  return ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
}

/** `0xff8800` → `#ff8800`. Used as the stable provenance id of a hotspot. */
export function keyToHex(key) {
  return `#${(key & 0xffffff).toString(16).padStart(6, '0')}`;
}

/* ------------------------------------------------------------ input shapes -- */

/**
 * @typedef {object} PixelAccessor
 * @property {number} width
 * @property {number} height
 * @property {(x: number, y: number) => number[]|{r:number,g:number,b:number}|number} getPixel
 */

const first = (...values) => values.find((v) => v !== undefined && v !== null && v !== '');

/** Normalise for name matching: case, surrounding space, internal runs of space. */
const norm = (text) => String(text ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

/* ---------------------------------------------------------------- adapter -- */

export class CamioWorldAdapter extends WorldAdapter {
  /**
   * @param {object} opts
   * @param {PixelAccessor} opts.colorMap  The colour map, as a pixel accessor. Required —
   *   without it `at()` cannot answer and the adapter would be lying about `regions`.
   * @param {object} [opts.projectData]    `ProjectData` from `ProjectLoader.getProjectData()`.
   *   Read for `hotspots`, POIs, `metadata` and the material size (see below).
   * @param {object[]} [opts.hotspots]     Hotspots directly, if you have no ProjectData.
   *   Each: `{ color, title|name, description, sound?, id? }`.
   * @param {object[]} [opts.pois]         POI records (`fromCamioPoi` shape). Bound to a
   *   region by `hotspot`/`hotspotId`/`region`/`color`, else by `coords: [x, y]` looked up
   *   in the colour map.
   * @param {number} [opts.widthMm]        Material width in mm — the fallback. See note.
   * @param {number} [opts.heightMm]       Material height in mm — the fallback. See note.
   * @param {string} [opts.worldId]        Defaults to `camio:<project name>`.
   *
   * MATERIAL SIZE. The printed sheet is the authority on millimetres, so a size
   * carried by the project data WINS over the constructor argument, which is only
   * the fallback for projects that do not record one. Recognised paths, in order:
   * `projectData.material.{widthMm,heightMm}`, `projectData.metadata.{widthMm,heightMm}`
   * (and the `_mm` / `width`+`units:'mm'` spellings), then `opts.widthMm/heightMm`.
   * Neither present is an error rather than a default: guessing A4 would silently
   * put every `material_mm` answer out by tens of millimetres.
   */
  constructor({
    colorMap,
    projectData,
    hotspots,
    pois,
    widthMm,
    heightMm,
    worldId,
  } = {}) {
    super({
      frame: FRAMES.IMAGE,
      capabilities: [CAPABILITIES.PLACES, CAPABILITIES.REGIONS],
      worldId: worldId || `camio:${first(projectData?.metadata?.name, projectData?.name, 'project')}`,
    });

    this.colorMap = validateColorMap(colorMap);

    const size = materialSize(projectData, widthMm, heightMm);
    /** Material width in millimetres. */
    this.widthMm = size.widthMm;
    /** Material height in millimetres. */
    this.heightMm = size.heightMm;
    /** Millimetres per colour-map pixel, per axis — the colour map need not be square-pixelled. */
    this.mmPerPxX = this.widthMm / this.colorMap.width;
    this.mmPerPxY = this.heightMm / this.colorMap.height;

    /** @type {Map<number, object>} colour key → Region (plus private pixel stats). */
    this._byKey = new Map();
    /** @type {Map<string, object>} region id → Region. */
    this._byId = new Map();

    this._loadHotspots(first(hotspots, projectData?.hotspots, projectData?.regions) || []);
    this._scan();
    this._bindPois(first(pois, projectData?.pois, projectData?.points_of_interest,
      projectData?.graph?.points_of_interest) || []);
    this._buildPlaces();
  }

  /* ------------------------------------------------------------ construction */

  /** Hotspots → Regions, keyed by colour. Duplicate colours are a project bug. */
  _loadHotspots(hotspots) {
    hotspots.forEach((hotspot, i) => {
      const raw = first(hotspot.color, hotspot.colour, hotspot.colorKey, hotspot.key);
      if (raw === undefined) throw new Error(`camio: hotspot ${i} has no colour key`);
      const key = colorKey(raw);
      if (this._byKey.has(key)) {
        throw new Error(
          `camio: colour ${keyToHex(key)} is claimed by two hotspots ` +
            `("${this._byKey.get(key).name}" and "${first(hotspot.title, hotspot.name)}"). ` +
            'The colour is the identifier; two hotspots cannot share one.',
        );
      }
      const id = String(first(hotspot.id, hotspot.hotspotId, keyToHex(key)));
      /** @type {any} */
      const region = {
        id,
        name: String(first(hotspot.title, hotspot.name, id)),
        description: first(hotspot.description, hotspot.text, ''),
        sound: hotspot.sound || undefined,
        provenance: { source: 'camio:colormap', id: keyToHex(key) },
        // Populated by _scan(). No `geometry`: a bounding-box polygon would be a
        // lie for the L-shaped hotspots this adapter is tested against, and no
        // tool in the schema needs an outline — `at`, `nearby` and distance all
        // read pixels.
        key,
        pixels: 0,
        bbox: null,
        centroid: null,
        boundary: null,
        neighbours: new Set(),
      };
      this._byKey.set(key, region);
      this._byId.set(id, region);
    });
  }

  /**
   * The single full-grid pass (§3: "adjacency = which regions share a border").
   *
   * One row is read at a time and compared against the previous row, so every
   * 4-neighbour edge is visited exactly once — (x-1,y)→(x,y) horizontally and
   * (x,y-1)→(x,y) vertically. That gives adjacency, and it also identifies
   * boundary pixels: a region pixel whose left/right/up/down neighbour differs,
   * or which sits on the image edge. Boundary pixels are what every later
   * distance query walks, so the O(W·H) cost is paid once, here.
   */
  _scan() {
    const { width: W, height: H } = this.colorMap;
    const getPixel = (x, y) => this.colorMap.getPixel(x, y);
    const marked = new Uint8Array(W * H);
    let prev = new Int32Array(W);
    let row = new Int32Array(W);
    const boundaries = new Map(); // key -> number[] of x, y pairs

    for (const region of this._byKey.values()) {
      boundaries.set(region.key, []);
      region.bbox = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
      region._sumX = 0;
      region._sumY = 0;
    }

    const mark = (x, y, key) => {
      const i = y * W + x;
      if (marked[i]) return;
      marked[i] = 1;
      boundaries.get(key).push(x, y);
    };

    /**
     * One 4-neighbour edge, visited exactly once. Different colours make both
     * ends boundary pixels, and make the two regions adjacent.
     */
    const edge = (aKey, ax, ay, bKey, bx, by) => {
      if (aKey === bKey) return;
      if (aKey !== NO_REGION) mark(ax, ay, aKey);
      if (bKey !== NO_REGION) mark(bx, by, bKey);
      if (aKey !== NO_REGION && bKey !== NO_REGION) {
        const a = this._byKey.get(aKey);
        const b = this._byKey.get(bKey);
        a.neighbours.add(b.id);
        b.neighbours.add(a.id);
      }
    };

    for (let y = 0; y < H; y += 1) {
      for (let x = 0; x < W; x += 1) {
        const px = getPixel(x, y);
        const key = px === null || px === undefined ? NO_REGION : colorKey(px);
        row[x] = this._byKey.has(key) ? key : NO_REGION;
      }

      for (let x = 0; x < W; x += 1) {
        const key = row[x];
        if (key !== NO_REGION) {
          const region = this._byKey.get(key);
          region.pixels += 1;
          region._sumX += x;
          region._sumY += y;
          const b = region.bbox;
          if (x < b.minX) b.minX = x;
          if (x > b.maxX) b.maxX = x;
          if (y < b.minY) b.minY = y;
          if (y > b.maxY) b.maxY = y;
          if (x === 0 || x === W - 1 || y === 0 || y === H - 1) mark(x, y, key);
        }

        if (x > 0) edge(row[x - 1], x - 1, y, key, x, y);
        if (y > 0) edge(prev[x], x, y - 1, key, x, y);
      }

      const swap = prev;
      prev = row;
      row = swap;
    }

    for (const region of this._byKey.values()) {
      region.boundary = Int32Array.from(boundaries.get(region.key));
      if (region.pixels === 0) {
        region.bbox = null;
        region.centroid = null;
      } else {
        region.centroid = {
          x: region._sumX / region.pixels + 0.5,
          y: region._sumY / region.pixels + 0.5,
        };
      }
      delete region._sumX;
      delete region._sumY;
      region.neighbours = Object.freeze([...region.neighbours].sort());
    }

    /** @type {Map<string, string[]>} region id → sorted neighbour ids. Cached, never recomputed. */
    this._adjacency = new Map([...this._byId.values()].map((r) => [r.id, r.neighbours]));
  }

  /**
   * Attach POI records to regions. A POI may name its hotspot outright; otherwise
   * its `coords` (colour-map pixels, as in `new_york.json`) are looked up — one
   * `getPixel` each, not a scan.
   */
  _bindPois(pois) {
    for (const poi of pois) {
      const ref = first(poi.hotspot, poi.hotspotId, poi.region, poi.regionId);
      let region = ref !== undefined ? this._byId.get(String(ref)) : undefined;
      if (!region && poi.color !== undefined) region = this._byKey.get(colorKey(poi.color));
      if (!region && Array.isArray(poi.coords) && poi.coords.length >= 2) {
        region = this._regionAtPixel(Math.round(poi.coords[0]), Math.round(poi.coords[1]));
      }
      if (!region) continue; // A POI outside every hotspot is not addressable by touch.
      region.poi = poi;
    }
  }

  /**
   * One Place per region: the hotspot title is the name a user says, and a bound
   * POI upgrades it (its own name wins, the hotspot title stays as an alias so
   * both phrasings resolve).
   */
  _buildPlaces() {
    /** @type {object[]} */
    this._places = [];
    for (const region of this._byId.values()) {
      const poi = region.poi;
      const name = String(first(poi?.name, region.name));
      const aliases = [];
      if (norm(region.name) !== norm(name)) aliases.push(region.name);
      const short = poi?.name_other?.short_name;
      if (short) aliases.push(short);

      const place = {
        id: `${region.id}:place`,
        name,
        aliases,
        category: (poi?.categories || []).join(', ') || undefined,
        // §3.4: geometry is in this adapter's frame — template pixels. The centroid
        // of an L-shaped region can fall outside it, which is exactly why distances
        // below are measured to the boundary rather than to this point.
        geometry: region.centroid
          ? { type: 'Point', coordinates: [region.centroid.x, region.centroid.y] }
          : undefined,
        props: {
          description: first(poi?.location_description, region.description) || undefined,
          sound: region.sound,
          uv: region.centroid ? this.pixelToUv(region.centroid.x, region.centroid.y) : undefined,
          ...(poi ? { poi } : null),
        },
        provenance: region.provenance,
        regionId: region.id,
      };
      region.place = place;
      this._places.push(place);
    }
  }

  /* -------------------------------------------------------------- accessors */

  /** Every region, in project order. Includes regions with zero pixels (a project bug worth seeing). */
  regions() {
    return [...this._byId.values()].map(publicRegion);
  }

  /** Every named place — one per region, POI-upgraded where a POI was bound. */
  places() {
    return this._places.map((p) => ({ ...p }));
  }

  /** @param {string} id */
  region(id) {
    const region = this._byId.get(String(id));
    return region ? publicRegion(region) : null;
  }

  /**
   * Which regions share a border, 4-neighbourhood, computed once in `_scan()`.
   *
   * Diagonal touching is deliberately not adjacency: two hotspots meeting at a
   * single corner do not share an edge a finger can follow.
   *
   * @returns {Map<string, string[]>} region id → neighbour ids, sorted.
   */
  regionAdjacency() {
    return new Map([...this._adjacency].map(([id, ids]) => [id, [...ids]]));
  }

  /** Neighbours of one region, as Regions. @param {string|{id:string}} idOrRegion */
  regionNeighbours(idOrRegion) {
    const id = typeof idOrRegion === 'string' ? idOrRegion : idOrRegion?.id;
    const ids = this._adjacency.get(String(id));
    if (!ids) return null;
    return ids.map((n) => publicRegion(this._byId.get(n)));
  }

  /* ------------------------------------------------------------ coordinates */

  /**
   * `(u, v) ∈ [0,1]²` → colour-map pixel. `u = 0` is left, `v = 0` is top, matching
   * `surface.js#acuityCellIndex` and `audiom.js#uvToLngLat`. Clamped, because a
   * finger sitting exactly on the right edge must still read a pixel.
   *
   * @param {number} u @param {number} v
   * @returns {{x: number, y: number}}
   */
  uvToPixel(u, v) {
    const { width: W, height: H } = this.colorMap;
    const x = Math.min(W - 1, Math.max(0, Math.floor(u * W)));
    const y = Math.min(H - 1, Math.max(0, Math.floor(v * H)));
    return { x, y };
  }

  /** Pixel (or fractional pixel) → `(u, v)`. @returns {{u: number, v: number}} */
  pixelToUv(x, y) {
    return { u: x / this.colorMap.width, v: y / this.colorMap.height };
  }

  /** `(u, v)` → millimetres from the top-left of the material. */
  uvToMm(u, v) {
    return { x: u * this.widthMm, y: v * this.heightMm };
  }

  /* ------------------------------------------------------------------ tools */

  /**
   * What is under the finger. One `getPixel`, no inference — L0 (§3).
   *
   * @param {number} u @param {number} v
   * @returns {{region?: object, place?: object}} Empty when the pixel is background.
   */
  at(u, v) {
    const { x, y } = this.uvToPixel(u, v);
    const region = this._regionAtPixel(x, y);
    if (!region) return {};
    return { region: publicRegion(region), place: { ...region.place } };
  }

  /** @returns {object|null} the internal region record, or null for background. */
  _regionAtPixel(x, y) {
    const { width: W, height: H } = this.colorMap;
    if (!(x >= 0 && x < W && y >= 0 && y < H)) return null;
    const px = this.colorMap.getPixel(x, y);
    if (px === null || px === undefined) return null;
    return this._byKey.get(colorKey(px)) || null;
  }

  /**
   * Resolve a phrasing to a place. Not L1's semantic ranking (`PlaceIndex` does
   * that) — this is the adapter's own authority on what exists.
   *
   * Exact (case-insensitive, over names and aliases) beats substring, so a hotspot
   * whose name is a prefix of another's still resolves cleanly. Ties at either
   * stage are `Ambiguous`, ranked shortest-name first, and the dispatcher asks.
   *
   * @param {string} text
   * @returns {object|import('../worldAdapter.js').Ambiguous|null}
   */
  resolvePlace(text) {
    const query = norm(text);
    if (!query) return null;

    const labelsOf = (place) => [place.name, ...(place.aliases || [])].map(norm);
    const exact = this._places.filter((p) => labelsOf(p).includes(query));
    const pool = exact.length > 0
      ? exact
      : this._places.filter((p) => labelsOf(p).some((label) => label.includes(query)));

    if (pool.length === 0) return null;
    if (pool.length === 1) return { ...pool[0] };
    const ranked = [...pool].sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name));
    return ambiguous(ranked.map((p) => ({ ...p })), text);
  }

  /**
   * Named places whose region comes within `radiusMm` of `(u, v)`, nearest first.
   *
   * The radius is millimetres on the material, per §5.4 — the only unit this frame
   * has. Each returned place carries its own `distance: { value, units }` so the
   * unit rides in the result rather than being assumed downstream.
   *
   * Cost: a bounding-box reject per region (bboxes precomputed in `_scan()`), then
   * the boundary walk only for survivors. No full-grid scan.
   *
   * @param {number} u @param {number} v
   * @param {number} [radiusMm]
   * @returns {object[]}
   */
  nearby(u, v, radiusMm = DEFAULT_NEARBY_RADIUS_MM) {
    const { x, y } = this.uvToPixel(u, v);
    const here = this._regionAtPixel(x, y);
    const point = { x: (x + 0.5) * this.mmPerPxX, y: (y + 0.5) * this.mmPerPxY };

    const hits = [];
    for (const region of this._byId.values()) {
      if (region.pixels === 0) continue;
      if (region !== here && this._bboxLowerBoundMm(region, point) > radiusMm) continue;
      const value = this._distanceMm(region, point, here);
      if (value === null || value > radiusMm) continue;
      hits.push({ region, value });
    }

    hits.sort((a, b) => a.value - b.value || a.region.place.name.localeCompare(b.region.place.name));
    return hits.map(({ region, value }) => ({
      ...region.place,
      distance: { value, units: MATERIAL_UNITS },
    }));
  }

  /**
   * Distance from `(u, v)` to a named place or region, in millimetres on the
   * material. The unit rides in the result (§5.4) — `get_distance_to` is served
   * with its enum narrowed to `material_mm`, and L3 must narrate what it was given.
   *
   * NEAREST BOUNDARY, not centroid. Two reasons, both load-bearing here:
   *   - a finger inside a hotspot is at distance 0, which is the honest answer to
   *     "how far is the park" while standing in it; a centroid would say 40 mm;
   *   - hotspots are not convex. The centroid of an L-shaped region can sit in the
   *     concavity — outside the region entirely — so centroid distance is not just
   *     imprecise but wrong in a way the user can feel.
   * The cost is the same order either way: the boundary pixel list is precomputed.
   *
   * @param {number} u @param {number} v
   * @param {string|{regionId?: string, id?: string}} target Place, Region, or a name.
   * @returns {{value: number, units: string, frame: string, method: string, place: object, region: object}
   *   |import('../worldAdapter.js').Ambiguous|null}
   */
  distanceTo(u, v, target) {
    const resolved = this._targetRegion(target);
    if (resolved === null) return null;
    // Ambiguous is passed straight through — the dispatcher asks which one, and a
    // distance to a guess would be worse than the question.
    if (isAmbiguous(resolved)) return resolved;

    const region = resolved;
    if (region.pixels === 0) return null;

    const { x, y } = this.uvToPixel(u, v);
    const here = this._regionAtPixel(x, y);
    const point = { x: (x + 0.5) * this.mmPerPxX, y: (y + 0.5) * this.mmPerPxY };
    const value = this._distanceMm(region, point, here);
    if (value === null) return null;

    return {
      value,
      units: MATERIAL_UNITS,
      frame: this.frame,
      method: 'nearest_boundary',
      place: { ...region.place },
      region: publicRegion(region),
    };
  }

  /**
   * `route_to` is offered with its mode enum narrowed to `fly_me_there` (§3), and
   * that mode is executed by the dispatcher/navigator — it is finger guidance on
   * the material, not a path through a graph. There is no network in a colour map,
   * so the adapter has nothing to compute and says so rather than inventing a line.
   *
   * `attributes()` is inherited: `accessibilityAttrs` is not declared, so the base
   * class already returns `Unsupported` and the tools that need it were never
   * offered.
   *
   * @returns {import('../worldAdapter.js').Unsupported}
   */
  route() {
    return unsupported(
      'This is a printed tactile map, so there are no walking directions. ' +
        'I can help you find a place on the sheet with your finger instead.',
      CAPABILITIES.ROUTING,
    );
  }

  /* ---------------------------------------------------------------- private */

  /** Name / Place / Region → internal region record, or Ambiguous, or null. */
  _targetRegion(target) {
    if (!target) return null;
    if (typeof target === 'string') {
      const place = this.resolvePlace(target);
      if (place === null) return null;
      if (!place.regionId) return place; // Ambiguous
      return this._byId.get(place.regionId) || null;
    }
    const id = target.regionId ?? target.id;
    return this._byId.get(String(id)) || null;
  }

  /**
   * Lower bound on the distance to any of a region's boundary pixel centres,
   * from its precomputed bounding box. Exact enough to reject, never to answer.
   */
  _bboxLowerBoundMm(region, point) {
    const b = region.bbox;
    if (!b) return Infinity;
    const minX = (b.minX + 0.5) * this.mmPerPxX;
    const maxX = (b.maxX + 0.5) * this.mmPerPxX;
    const minY = (b.minY + 0.5) * this.mmPerPxY;
    const maxY = (b.maxY + 0.5) * this.mmPerPxY;
    const dx = Math.max(minX - point.x, 0, point.x - maxX);
    const dy = Math.max(minY - point.y, 0, point.y - maxY);
    return Math.hypot(dx, dy);
  }

  /**
   * Millimetres from a point to a region: 0 inside, else the nearest boundary
   * pixel centre.
   *
   * @param {object} region @param {{x:number,y:number}} point
   * @param {object|null} here The region under the point, already read once.
   */
  _distanceMm(region, point, here) {
    if (here === region) return 0;
    const boundary = region.boundary;
    if (!boundary || boundary.length === 0) return null;
    let best = Infinity;
    for (let i = 0; i < boundary.length; i += 2) {
      const dx = (boundary[i] + 0.5) * this.mmPerPxX - point.x;
      const dy = (boundary[i + 1] + 0.5) * this.mmPerPxY - point.y;
      const d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  }
}

/* ------------------------------------------------------------------ helpers */

/** The Region of §3.4, without the pixel bookkeeping the adapter keeps beside it. */
function publicRegion(region) {
  if (!region) return null;
  return {
    id: region.id,
    name: region.name,
    description: region.description,
    sound: region.sound,
    provenance: region.provenance,
    pixels: region.pixels,
    bbox: region.bbox ? { ...region.bbox } : null,
    centroid: region.centroid ? { ...region.centroid } : null,
    neighbours: [...region.neighbours],
  };
}

/** @param {PixelAccessor} colorMap */
function validateColorMap(colorMap) {
  if (!colorMap || typeof colorMap.getPixel !== 'function') {
    throw new Error(
      'CamioWorldAdapter: colorMap must be { width, height, getPixel(x, y) }. ' +
        'The browser wraps a canvas; Node tests wrap an array. This module touches neither.',
    );
  }
  const { width, height } = colorMap;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`CamioWorldAdapter: colorMap needs positive integer width/height, got ${width}×${height}`);
  }
  return colorMap;
}

/**
 * Material size in mm. Project data wins; the constructor arguments are the
 * fallback. See the constructor doc for why there is no default.
 */
function materialSize(projectData, widthMmArg, heightMmArg) {
  const sources = [projectData?.material, projectData?.metadata, projectData];
  let widthMm;
  let heightMm;
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    const w = first(source.widthMm, source.width_mm, source.materialWidthMm,
      norm(source.units) === 'mm' ? source.width : undefined);
    const h = first(source.heightMm, source.height_mm, source.materialHeightMm,
      norm(source.units) === 'mm' ? source.height : undefined);
    if (typeof w === 'number' && typeof h === 'number') {
      widthMm = w;
      heightMm = h;
      break;
    }
  }
  if (widthMm === undefined) {
    widthMm = widthMmArg;
    heightMm = heightMmArg;
  }
  if (!(widthMm > 0) || !(heightMm > 0)) {
    throw new Error(
      'CamioWorldAdapter: material size in mm is required — pass widthMm/heightMm, or carry them ' +
        'on the project data. Every distance this adapter returns is material_mm (§5.4), and ' +
        'guessing a sheet size would put all of them out by tens of millimetres.',
    );
  }
  return { widthMm, heightMm };
}

export default CamioWorldAdapter;
