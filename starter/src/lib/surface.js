/**
 * Surface — the tactile output as a single abstraction.
 *
 * Milestone M1 of `docs/browser-voice-exploration-plan.md`, implementing §2 of
 * `docs/local-llm-tooling-design.md`. Three surface classes are live or targeted
 * (Braille Doodle pin grid, APH Monarch, pre-printed material) and they differ on
 * resolution, aspect and refreshability. Everything above this module works in
 * normalized `(u, v) ∈ [0,1]²` over the material (§2.1) and asks the surface for
 * the two things that actually vary: how finely to quantize (§2.2) and what
 * aspect the window must have (§2.3).
 *
 * PLATFORM-FREE ON PURPOSE: no DOM, no React, no browser APIs, no imports. It
 * runs in Node so `scripts/test_surface.mjs` can check it without a server, and
 * so the ported logic (milestone P) can depend on it.
 */

/**
 * Two-point discrimination at the fingertip is roughly 2–3 mm, so no useful
 * quantization is finer than this regardless of what the device can render.
 * @type {number}
 */
export const ACUITY_FLOOR_MM = 2.5;

/**
 * Largest double strictly below 1. `(u, v)` are clamped to `[0, 1)` — closed at
 * 0, open at 1 — so `floor(u * cols)` can never produce `cols`.
 * @type {number}
 */
export const ONE_MINUS_EPSILON = 1 - Number.EPSILON / 2;

/**
 * Tolerance for the `floor()` in the acuity grid. `cols * pitch / pitch` is not
 * exactly `cols` in binary floating point (43 × 6.4 mm / 6.4 mm = 43.00000000000001,
 * and the error lands on either side depending on the pitch), so a device whose
 * material dimensions are derived from its own pin count could otherwise lose a
 * row or column. Applied only when sizing the grid, never to `(u, v)`.
 * @type {number}
 */
const FLOOR_EPSILON = 1e-9;

/** Aspect equality tolerance for the negotiated-window invariants. */
export const ASPECT_EPSILON = 1e-9;

// ---------------------------------------------------------------------------
// 1. Descriptors
// ---------------------------------------------------------------------------

/**
 * @typedef {object} SurfaceDescriptor
 * @property {string} id                     Stable identifier, safe as a cache key.
 * @property {string} [label]                Human-readable name.
 * @property {'refreshable'|'continuous'} kind
 *   `refreshable` — a pin array with a hardware-fixed pin count and aspect, redrawn
 *   per window. `continuous` — pre-printed material with no pins; its aspect is
 *   whatever was printed and cannot be changed.
 * @property {number} [cols]                 Device pin columns (refreshable only).
 * @property {number} [rows]                 Device pin rows (refreshable only).
 * @property {number} [pinPitchMm]           Centre-to-centre pin spacing in mm (refreshable only).
 * @property {number} [widthMm]              Material width in mm. Defaults to `cols * pinPitchMm`.
 * @property {number} [heightMm]             Material height in mm. Defaults to `rows * pinPitchMm`.
 */

/**
 * Braille Doodle refreshable pin grid — 43 × 31 = 1,333 pins at 6.4 mm pitch.
 * The pitch dominates the 2.5 mm acuity floor, so the acuity grid degrades back
 * to exactly the device grid, which is the behaviour §2.2 wants.
 * @type {SurfaceDescriptor}
 */
export const BRAILLE_DOODLE = Object.freeze({
  id: 'braille-doodle',
  label: 'Braille Doodle pin grid',
  kind: 'refreshable',
  cols: 43,
  rows: 31,
  pinPitchMm: 6.4,
});

/**
 * APH Monarch — 96 × 40 = 3,840 pins at ~3.2 mm pitch, aspect fixed at 2.4:1 in
 * hardware. This is the surface that makes §2.3 a correctness issue rather than a
 * nicety: a 1.39:1 window rendered on it is geometrically wrong everywhere.
 * @type {SurfaceDescriptor}
 */
export const MONARCH = Object.freeze({
  id: 'monarch',
  label: 'APH Monarch',
  kind: 'refreshable',
  cols: 96,
  rows: 40,
  pinPitchMm: 3.2,
});

/**
 * Pre-printed A4 in landscape, full sheet — 297 × 210 mm, no pins, so it gets the
 * 2.5 mm acuity floor: 118 × 84 = 9,912 cells.
 *
 * NOTE: §2.2's stated check is "an A4 sheet at 2.5 mm gives ~108 × 76 ≈ 8,200
 * cells", which the formula reproduces only for a 270 × 190 mm *artwork area*,
 * not for the full sheet — see {@link A4_LANDSCAPE_ARTWORK}. Both are exported so
 * callers pick deliberately; nothing here silently splits the difference.
 * @type {SurfaceDescriptor}
 */
export const A4_LANDSCAPE = Object.freeze({
  id: 'a4-landscape',
  label: 'Pre-printed A4 (landscape, full sheet)',
  kind: 'continuous',
  widthMm: 297,
  heightMm: 210,
});

/**
 * Pre-printed A4 in landscape, printable artwork area only — 270 × 190 mm, which
 * at the 2.5 mm floor gives §2.2's 108 × 76 = 8,208 cells. This is the honest
 * surface for a real print: the four calibrated corners bound the artwork, not
 * the sheet edge, exactly as `lib/geo.js#shrinkBboxToGrid` already assumes.
 * @type {SurfaceDescriptor}
 */
export const A4_LANDSCAPE_ARTWORK = Object.freeze({
  id: 'a4-landscape-artwork',
  label: 'Pre-printed A4 (landscape, artwork area)',
  kind: 'continuous',
  widthMm: 270,
  heightMm: 190,
});

/**
 * The ready-made descriptors, keyed by id.
 * @type {Readonly<Record<string, SurfaceDescriptor>>}
 */
export const SURFACE_DESCRIPTORS = Object.freeze({
  [BRAILLE_DOODLE.id]: BRAILLE_DOODLE,
  [MONARCH.id]: MONARCH,
  [A4_LANDSCAPE.id]: A4_LANDSCAPE,
  [A4_LANDSCAPE_ARTWORK.id]: A4_LANDSCAPE_ARTWORK,
});

// ---------------------------------------------------------------------------
// 2. Acuity quantization (§2.2)
// ---------------------------------------------------------------------------

/**
 * The acuity grid for a piece of material: quantize by what a fingertip can
 * distinguish, not by what the device can render.
 *
 *   cellSizeMm = max(devicePinPitchMm ?? 0, 2.5)
 *   acuityCols = floor(materialWidthMm  / cellSizeMm)
 *   acuityRows = floor(materialHeightMm / cellSizeMm)
 *
 * One formula for all three surface classes: it degrades to the device grid
 * exactly when the device is coarser than the finger, and to the acuity floor
 * when it is finer or absent.
 *
 * @param {object} spec
 * @param {number} spec.materialWidthMm   Width of the material in mm (> 0).
 * @param {number} spec.materialHeightMm  Height of the material in mm (> 0).
 * @param {number|null} [spec.devicePinPitchMm] Pin pitch in mm, or null/undefined for continuous material.
 * @returns {{ cellSizeMm: number, cols: number, rows: number, count: number }}
 */
export function acuityGrid({ materialWidthMm, materialHeightMm, devicePinPitchMm }) {
  if (!(materialWidthMm > 0) || !(materialHeightMm > 0)) {
    throw new TypeError(
      `acuityGrid: materialWidthMm/materialHeightMm must be positive, got ${materialWidthMm}×${materialHeightMm}`,
    );
  }
  const cellSizeMm = Math.max(devicePinPitchMm ?? 0, ACUITY_FLOOR_MM);
  const cols = Math.max(1, Math.floor(materialWidthMm / cellSizeMm + FLOOR_EPSILON));
  const rows = Math.max(1, Math.floor(materialHeightMm / cellSizeMm + FLOOR_EPSILON));
  return { cellSizeMm, cols, rows, count: cols * rows };
}

/**
 * Clamp a normalized material coordinate into `[0, 1)`.
 *
 * Open at the top so that `floor(u * cols) <= cols - 1` for every input,
 * including the `u = 1` a corner touch legitimately produces.
 *
 * @param {number} t
 * @returns {number}
 */
export function clampUnit(t) {
  if (!Number.isFinite(t)) {
    throw new TypeError(`clampUnit: expected a finite number, got ${t}`);
  }
  if (t <= 0) return 0;
  return t < ONE_MINUS_EPSILON ? t : ONE_MINUS_EPSILON;
}

/**
 * Accept either an {@link acuityGrid} result (`{cols, rows}`) or a whole
 * {@link Surface} (`{acuityCols, acuityRows}`) wherever a grid is wanted, so
 * callers holding a Surface never have to unpack it.
 *
 * @param {{cols?: number, rows?: number, acuityCols?: number, acuityRows?: number}} grid
 * @returns {{cols: number, rows: number}}
 */
function readGrid(grid) {
  const cols = grid?.cols ?? grid?.acuityCols;
  const rows = grid?.rows ?? grid?.acuityRows;
  if (!(cols > 0) || !(rows > 0)) {
    throw new TypeError(`expected a grid of {cols, rows} or a Surface, got ${JSON.stringify(grid)}`);
  }
  return { cols, rows };
}

/**
 * Row-major acuity cell index for a normalized material coordinate.
 *
 *   acuityCell = floor(v * acuityRows) * acuityCols + floor(u * acuityCols)
 *
 * `u = 0` is left and `v = 0` is top, matching `audiom.js#uvToLngLat`, so cell 0
 * is the top-left of the material.
 *
 * @param {number} u  Normalized horizontal position, clamped into [0,1).
 * @param {number} v  Normalized vertical position, clamped into [0,1).
 * @param {{cols: number, rows: number}} grid  An {@link acuityGrid} result or a Surface.
 * @returns {number} Integer in `[0, cols * rows)`.
 */
export function acuityCellIndex(u, v, grid) {
  const { cols, rows } = readGrid(grid);
  const cu = clampUnit(u);
  const cv = clampUnit(v);
  return Math.floor(cv * rows) * cols + Math.floor(cu * cols);
}

/**
 * Centre of an acuity cell in `(u, v)`. Inverse of {@link acuityCellIndex} up to
 * the cell, useful for debug rendering and for naming a cell back to the user.
 *
 * @param {number} cell  Integer cell index.
 * @param {{cols: number, rows: number}} grid
 * @returns {{u: number, v: number}}
 */
export function acuityCellCenter(cell, grid) {
  const { cols, rows } = readGrid(grid);
  const n = cols * rows;
  if (!Number.isInteger(cell) || cell < 0 || cell >= n) {
    throw new RangeError(`acuityCellCenter: cell ${cell} outside [0, ${n})`);
  }
  const col = cell % cols;
  const row = (cell - col) / cols;
  return { u: (col + 0.5) / cols, v: (row + 0.5) / rows };
}

// ---------------------------------------------------------------------------
// 3. Aspect negotiation (§2.3)
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Bbox
 * @property {number} minX
 * @property {number} minY
 * @property {number} maxX
 * @property {number} maxY
 */

/**
 * Accept either the `{minX,minY,maxX,maxY}` object form or the
 * `[minX,minY,maxX,maxY]` array form that `audiom.js` and `pinGrid.js` already
 * pass around, and remember which so the result can be returned in kind.
 *
 * @param {Bbox|number[]} bbox
 * @returns {{ minX: number, minY: number, maxX: number, maxY: number, wasArray: boolean }}
 */
function readBbox(bbox) {
  if (Array.isArray(bbox)) {
    const [minX, minY, maxX, maxY] = bbox;
    return { minX, minY, maxX, maxY, wasArray: true };
  }
  if (bbox && typeof bbox === 'object') {
    const { minX, minY, maxX, maxY } = bbox;
    return { minX, minY, maxX, maxY, wasArray: false };
  }
  throw new TypeError(`bbox: expected {minX,minY,maxX,maxY} or [minX,minY,maxX,maxY], got ${bbox}`);
}

/** @returns {Bbox|number[]} */
function writeBbox({ minX, minY, maxX, maxY }, wasArray) {
  return wasArray ? [minX, minY, maxX, maxY] : { minX, minY, maxX, maxY };
}

/**
 * Aspect (width / height) of a bbox, in whatever units it carries.
 *
 * The numbers are opaque: lng/lat, Web-Mercator or ENU metres all work. For a
 * geographic window that is going to be *printed*, project first — `audiom.js`
 * measures aspect in Web-Mercator because that is what Audiom renders and
 * therefore what a print of it depicts.
 *
 * @param {Bbox|number[]} bbox
 * @returns {number}
 */
export function bboxAspect(bbox) {
  const b = readBbox(bbox);
  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  if (!(w > 0) || !(h > 0)) {
    throw new RangeError(`bboxAspect: bbox must have positive extent, got ${w}×${h}`);
  }
  return w / h;
}

/**
 * Grow or shrink a bbox about its centre until its aspect equals `targetAspect`.
 *
 * - `'crop'` — the result is **contained in** the input. Only one axis shrinks.
 * - `'pad'`  — the result **contains** the input. Only one axis grows.
 *
 * Pure arithmetic on the four numbers, so it is correct for lng/lat, Mercator or
 * ENU alike; the caller decides which space the window lives in.
 *
 * @param {Bbox|number[]} bbox
 * @param {number} targetAspect  Desired width / height (> 0).
 * @param {'crop'|'pad'} [mode='crop']
 * @returns {Bbox|number[]} Same shape as the input.
 */
export function fitWindowToAspect(bbox, targetAspect, mode = 'crop') {
  const b = readBbox(bbox);
  if (!(targetAspect > 0) || !Number.isFinite(targetAspect)) {
    throw new RangeError(`fitWindowToAspect: targetAspect must be finite and positive, got ${targetAspect}`);
  }
  if (mode !== 'crop' && mode !== 'pad') {
    throw new RangeError(`fitWindowToAspect: mode must be 'crop' or 'pad', got ${mode}`);
  }

  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  if (!(w > 0) || !(h > 0)) {
    throw new RangeError(`fitWindowToAspect: bbox must have positive extent, got ${w}×${h}`);
  }

  // Too wide for the target? Cropping takes width off; padding adds height.
  const tooWide = w / h > targetAspect;
  const shrinkWidth = mode === 'crop' ? tooWide : !tooWide;

  // Exactly one axis is recomputed from the other, so the result's aspect is
  // targetAspect by construction rather than by a second division.
  const newW = shrinkWidth ? h * targetAspect : w;
  const newH = shrinkWidth ? h : w / targetAspect;

  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  return writeBbox(
    { minX: cx - newW / 2, minY: cy - newH / 2, maxX: cx + newW / 2, maxY: cy + newH / 2 },
    b.wasArray,
  );
}

/**
 * Relative aspect error between the material and the window it is showing.
 *
 * Sign convention matches `AudiomTactileApp.jsx`'s displayed `mismatch`
 * (`materialAspect / aspect - 1`): positive means the material is wider than the
 * window, negative means it is taller, zero means they agree. For a refreshable
 * surface this value must be *driven to zero by changing the window* (see
 * {@link negotiateWindow}), not merely reported.
 *
 * @param {number} materialAspect
 * @param {number} windowAspect
 * @returns {number}
 */
export function aspectMismatch(materialAspect, windowAspect) {
  return materialAspect / windowAspect - 1;
}

// ---------------------------------------------------------------------------
// 4. Surface
// ---------------------------------------------------------------------------

/**
 * @typedef {object} Surface
 * @property {string} id
 * @property {string} label
 * @property {'refreshable'|'continuous'} kind
 * @property {boolean} refreshable
 * @property {number|null} devicePinPitchMm
 * @property {number|null} deviceCols   Hardware pin columns, or null for continuous material.
 * @property {number|null} deviceRows
 * @property {number} materialWidthMm
 * @property {number} materialHeightMm
 * @property {number} materialAspect    Width / height of the physical material.
 * @property {number} cellSizeMm
 * @property {number} acuityCols
 * @property {number} acuityRows
 * @property {number} acuityCellCount
 * @property {(u: number, v: number) => number} acuityCell
 * @property {(cell: number) => {u: number, v: number}} cellCenter
 */

/**
 * Build a Surface from a descriptor.
 *
 * Refreshable descriptors give `cols`/`rows`/`pinPitchMm` and the material size
 * follows (`cols * pitch`); continuous ones give `widthMm`/`heightMm` and have no
 * pitch. Either may state `widthMm`/`heightMm` explicitly — a pin device with a
 * bezel or a non-square active area is a real case.
 *
 * @param {SurfaceDescriptor} descriptor
 * @returns {Surface} Frozen; a Surface is a value, not a mutable device handle.
 */
export function createSurface(descriptor) {
  if (!descriptor || typeof descriptor !== 'object') {
    throw new TypeError(`createSurface: expected a descriptor object, got ${descriptor}`);
  }
  const { id, label, kind, cols, rows, pinPitchMm, widthMm, heightMm } = descriptor;
  if (kind !== 'refreshable' && kind !== 'continuous') {
    throw new RangeError(`createSurface(${id}): kind must be 'refreshable' or 'continuous', got ${kind}`);
  }

  const refreshable = kind === 'refreshable';
  if (refreshable && !(pinPitchMm > 0 && cols > 0 && rows > 0)) {
    throw new RangeError(
      `createSurface(${id}): a refreshable surface needs positive cols, rows and pinPitchMm`,
    );
  }

  const materialWidthMm = widthMm ?? (refreshable ? cols * pinPitchMm : undefined);
  const materialHeightMm = heightMm ?? (refreshable ? rows * pinPitchMm : undefined);
  const devicePinPitchMm = refreshable ? pinPitchMm : null;

  const grid = acuityGrid({ materialWidthMm, materialHeightMm, devicePinPitchMm });

  /** @type {Surface} */
  const surface = {
    id: String(id),
    label: label ?? String(id),
    kind,
    refreshable,
    devicePinPitchMm,
    deviceCols: refreshable ? cols : null,
    deviceRows: refreshable ? rows : null,
    materialWidthMm,
    materialHeightMm,
    materialAspect: materialWidthMm / materialHeightMm,
    cellSizeMm: grid.cellSizeMm,
    acuityCols: grid.cols,
    acuityRows: grid.rows,
    acuityCellCount: grid.count,
    acuityCell: (u, v) => acuityCellIndex(u, v, grid),
    cellCenter: (cell) => acuityCellCenter(cell, grid),
  };
  return Object.freeze(surface);
}

/**
 * The window a surface should actually be shown, given the window the caller wants.
 *
 * §2.3: causality runs one way for paper and the other for hardware.
 *
 *   paper:       window aspect → material aspect   (the print inherits it)
 *   refreshable: device aspect → window aspect     (the window must give way)
 *
 * So a continuous surface gets its bbox back untouched — its aspect was fixed at
 * print time and there is nothing to negotiate — while a refreshable surface gets
 * the bbox refitted to the hardware aspect.
 *
 * **Crop, not pad, is the default.** Padding would widen the window past what the
 * caller asked for, and the extra band lies outside the loaded window's data: the
 * adapter has no features there, so the device would render an authoritative-feeling
 * empty margin and every `(u, v)` would still be wrong, just wrong over a larger
 * area. Cropping only discards data the surface cannot faithfully show. Callers
 * that genuinely want the whole window visible can call
 * `fitWindowToAspect(bbox, surface.materialAspect, 'pad')` and are then responsible
 * for loading data over the padded extent.
 *
 * @param {Surface} surface
 * @param {Bbox|number[]} bbox
 * @param {{mode?: 'crop'|'pad'}} [options]
 * @returns {Bbox|number[]} Same shape as the input.
 */
export function negotiateWindow(surface, bbox, { mode = 'crop' } = {}) {
  if (!surface || typeof surface !== 'object') {
    throw new TypeError(`negotiateWindow: expected a Surface, got ${surface}`);
  }
  if (!surface.refreshable) return bbox;
  return fitWindowToAspect(bbox, surface.materialAspect, mode);
}
