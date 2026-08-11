#!/usr/bin/env node
/**
 * Milestone 1 check: the Surface abstraction (§2 of local-llm-tooling-design.md).
 *
 *   node starter/scripts/test_surface.mjs
 *
 * No server, no network, no browser — `lib/surface.js` is platform-free and this
 * script exists to keep it that way. Exits non-zero on the first failing group's
 * count reaching the summary.
 */

import {
  ACUITY_FLOOR_MM,
  ASPECT_EPSILON,
  A4_LANDSCAPE,
  A4_LANDSCAPE_ARTWORK,
  BRAILLE_DOODLE,
  MONARCH,
  SURFACE_DESCRIPTORS,
  acuityCellCenter,
  acuityCellIndex,
  acuityGrid,
  aspectMismatch,
  bboxAspect,
  clampUnit,
  createSurface,
  fitWindowToAspect,
  negotiateWindow,
} from '../src/lib/surface.js';

// ---- tiny harness ---------------------------------------------------------
let pass = 0;
let fail = 0;
const failures = [];

function ok(cond, name, detail = '') {
  if (cond) { pass += 1; console.log(`  ok   ${name}`); return true; }
  fail += 1;
  failures.push(name);
  console.log(`  FAIL ${name}${detail ? `  — ${detail}` : ''}`);
  return false;
}
const eq = (a, b, name) => ok(Object.is(a, b), name, `expected ${b}, got ${a}`);
const near = (a, b, tol, name) =>
  ok(Math.abs(a - b) <= tol, name, `expected ${b} ±${tol}, got ${a}`);
const throws = (fn, name) => {
  try { fn(); } catch { return ok(true, name); }
  return ok(false, name, 'did not throw');
};
const group = (title) => console.log(`\n${title}`);

// ---------------------------------------------------------------------------
group('§2.2 acuity quantization — the three doc numbers');

const doodle = createSurface(BRAILLE_DOODLE);
eq(doodle.cellSizeMm, 6.4, 'Braille Doodle: 6.4 mm pitch dominates the 2.5 mm floor');
eq(doodle.acuityCols, 43, 'Braille Doodle: 43 acuity columns');
eq(doodle.acuityRows, 31, 'Braille Doodle: 31 acuity rows');
eq(doodle.acuityCellCount, 1333, 'Braille Doodle: 1,333 cells — exactly the device grid');
ok(doodle.acuityCols === doodle.deviceCols && doodle.acuityRows === doodle.deviceRows,
   'Braille Doodle: acuity grid degrades to the device grid');
near(doodle.materialAspect, 1.387, 5e-4, 'Braille Doodle: material aspect ~1.387');

const monarch = createSurface(MONARCH);
eq(monarch.cellSizeMm, 3.2, 'Monarch: 3.2 mm pitch dominates the floor');
eq(monarch.acuityCols, 96, 'Monarch: 96 acuity columns');
eq(monarch.acuityRows, 40, 'Monarch: 40 acuity rows');
eq(monarch.acuityCellCount, 3840, 'Monarch: 3,840 cells — exactly the device grid');
near(monarch.materialAspect, 2.4, 1e-9, 'Monarch: material aspect exactly 2.4');

// §2.2's "~108 × 76 ≈ 8,200" is reproduced by the printable artwork area, not by
// the full sheet — see the note on A4_LANDSCAPE in surface.js.
const a4art = createSurface(A4_LANDSCAPE_ARTWORK);
eq(a4art.cellSizeMm, ACUITY_FLOOR_MM, 'A4 artwork: falls to the 2.5 mm acuity floor');
eq(a4art.acuityCols, 108, 'A4 artwork (270 mm): 108 acuity columns');
eq(a4art.acuityRows, 76, 'A4 artwork (190 mm): 76 acuity rows');
eq(a4art.acuityCellCount, 8208, 'A4 artwork: 8,208 cells ≈ the doc’s 8,200');

const a4full = createSurface(A4_LANDSCAPE);
eq(a4full.acuityCols, 118, 'A4 full sheet (297 mm): 118 columns');
eq(a4full.acuityRows, 84, 'A4 full sheet (210 mm): 84 rows');
eq(a4full.acuityCellCount, 9912, 'A4 full sheet: 9,912 cells (documented divergence)');

eq(acuityGrid({ materialWidthMm: 100, materialHeightMm: 100 }).cellSizeMm, ACUITY_FLOOR_MM,
   'acuityGrid: absent pitch takes the floor');
eq(acuityGrid({ materialWidthMm: 100, materialHeightMm: 100, devicePinPitchMm: 1 }).cellSizeMm,
   ACUITY_FLOOR_MM, 'acuityGrid: a pitch finer than the finger is ignored');
throws(() => acuityGrid({ materialWidthMm: 0, materialHeightMm: 10 }), 'acuityGrid: rejects zero extent');

// ---------------------------------------------------------------------------
group('acuityCell — corners, range, monotonicity');

const { acuityCols: C, acuityRows: R } = doodle;
eq(doodle.acuityCell(0, 0), 0, 'u=v=0 → cell 0 (top-left)');
eq(doodle.acuityCell(1, 0), C - 1, 'u=1 clamps into the last column of row 0');
eq(doodle.acuityCell(0, 1), (R - 1) * C, 'v=1 clamps into the first column of the last row');
eq(doodle.acuityCell(1, 1), C * R - 1, 'u=v=1 → last cell, still in range');
eq(doodle.acuityCell(-0.5, -2), 0, 'negative (u,v) clamps to cell 0');
eq(doodle.acuityCell(4, 9), C * R - 1, 'out-of-range (u,v) clamps to the last cell');
eq(doodle.acuityCell(1 - 1e-15, 1 - 1e-15), C * R - 1, 'u,v just below 1 stay in range');

let inRange = true;
let monotone = true;
let prev = -1;
for (let i = 0; i <= 1000; i += 1) {
  const u = i / 1000;
  const cell = doodle.acuityCell(u, 0.5);
  if (!Number.isInteger(cell) || cell < 0 || cell >= C * R) inRange = false;
  if (cell < prev) monotone = false;
  prev = cell;
}
ok(inRange, 'acuityCell stays an integer in [0, cols*rows) across a full sweep');
ok(monotone, 'acuityCell is non-decreasing along a row (u increasing, v fixed)');

let rowsMonotone = true;
prev = -1;
for (let i = 0; i <= 1000; i += 1) {
  const cell = doodle.acuityCell(0.5, i / 1000);
  if (cell < prev) rowsMonotone = false;
  prev = cell;
}
ok(rowsMonotone, 'acuityCell is non-decreasing down a column (v increasing, u fixed)');

let covered = new Set();
for (let i = 0; i < C * R * 4; i += 1) {
  covered.add(doodle.acuityCell(((i % (C * 2)) + 0.5) / (C * 2), Math.floor(i / (C * 2)) / (R * 2)));
}
ok(covered.size === C * R, 'a 2× oversampled sweep hits every cell exactly once or more',
   `covered ${covered.size} of ${C * R}`);

// round trip: the centre of a cell maps back to that cell
let roundTrip = true;
for (let cell = 0; cell < C * R; cell += 1) {
  const { u, v } = acuityCellCenter(cell, doodle);
  if (doodle.acuityCell(u, v) !== cell) { roundTrip = false; break; }
}
ok(roundTrip, 'cellCenter → acuityCell round-trips for all 1,333 cells');
throws(() => acuityCellCenter(C * R, doodle), 'cellCenter: rejects an out-of-range index');
throws(() => clampUnit(NaN), 'clampUnit: rejects NaN rather than silently yielding cell 0');
throws(() => doodle.acuityCell(NaN, 0), 'acuityCell: rejects NaN');
eq(acuityCellIndex(0.5, 0.5, { cols: 10, rows: 10 }), 55, 'acuityCellIndex is usable standalone');

// ---------------------------------------------------------------------------
group('§2.3 fitWindowToAspect — invariants');

// Deliberately not centred on the origin and not square, so a bug that assumes
// either would show up. Numbers are opaque: lng/lat or ENU alike.
const WIDE = { minX: -122.35, minY: 47.6, maxX: -122.31, maxY: 47.62 };   // aspect 2.0
const TALL = { minX: 100, minY: 200, maxX: 110, maxY: 240 };              // aspect 0.25

const contains = (outer, inner) =>
  outer.minX <= inner.minX + 1e-12 && outer.minY <= inner.minY + 1e-12 &&
  outer.maxX >= inner.maxX - 1e-12 && outer.maxY >= inner.maxY - 1e-12;
const centred = (a, b) =>
  Math.abs((a.minX + a.maxX) / 2 - (b.minX + b.maxX) / 2) < 1e-9 &&
  Math.abs((a.minY + a.maxY) / 2 - (b.minY + b.maxY) / 2) < 1e-9;

near(bboxAspect(WIDE), 2.0, 1e-9, 'bboxAspect: wide window is 2.0');
near(bboxAspect(TALL), 0.25, 1e-9, 'bboxAspect: tall window is 0.25');

for (const [name, box] of [['wide→', WIDE], ['tall→', TALL]]) {
  for (const target of [2.4, 1.387, 0.5, bboxAspect(box)]) {
    for (const mode of ['crop', 'pad']) {
      const out = fitWindowToAspect(box, target, mode);
      const label = `${name}${target} ${mode}`;
      near(bboxAspect(out), target, ASPECT_EPSILON, `${label}: aspect equals target`);
      ok(centred(out, box), `${label}: centred on the input`);
      ok(mode === 'crop' ? contains(box, out) : contains(out, box),
         `${label}: ${mode === 'crop' ? 'contained in' : 'contains'} the input`);
    }
  }
}

// Only one axis may move, and it must move the right way.
const cropped = fitWindowToAspect(WIDE, 1.0, 'crop');
near(cropped.maxY - cropped.minY, WIDE.maxY - WIDE.minY, 1e-12,
     'crop of a too-wide window preserves height');
ok(cropped.maxX - cropped.minX < WIDE.maxX - WIDE.minX, 'crop of a too-wide window loses width');
const padded = fitWindowToAspect(WIDE, 1.0, 'pad');
near(padded.maxX - padded.minX, WIDE.maxX - WIDE.minX, 1e-12,
     'pad of a too-wide window preserves width');
ok(padded.maxY - padded.minY > WIDE.maxY - WIDE.minY, 'pad of a too-wide window gains height');

const already = fitWindowToAspect(TALL, 0.25, 'crop');
near(already.minX, TALL.minX, 1e-12, 'fitting to the window’s own aspect is a no-op (minX)');
near(already.maxY, TALL.maxY, 1e-12, 'fitting to the window’s own aspect is a no-op (maxY)');

// Array form, as `audiom.js` and `pinGrid.js` already pass bboxes around.
const arrOut = fitWindowToAspect([-122.35, 47.6, -122.31, 47.62], 2.4, 'crop');
ok(Array.isArray(arrOut) && arrOut.length === 4, 'array bbox in → array bbox out');
near(bboxAspect(arrOut), 2.4, ASPECT_EPSILON, 'array form honours the target aspect');

throws(() => fitWindowToAspect(WIDE, 2.0, 'stretch'), 'rejects an unknown mode');
throws(() => fitWindowToAspect(WIDE, 0, 'crop'), 'rejects a non-positive target aspect');
throws(() => fitWindowToAspect({ minX: 1, minY: 1, maxX: 1, maxY: 2 }, 1, 'crop'),
       'rejects a degenerate bbox');

// ---------------------------------------------------------------------------
group('aspectMismatch — sign convention (AudiomTactileApp.jsx)');

eq(aspectMismatch(2, 2), 0, 'agreement is exactly zero');
ok(aspectMismatch(2.4, 1.387) > 0, 'material wider than the window → positive');
ok(aspectMismatch(1.387, 2.4) < 0, 'material taller than the window → negative');
near(aspectMismatch(1.5, 1.0), 0.5, 1e-12, 'materialAspect / windowAspect - 1');

// ---------------------------------------------------------------------------
group('negotiateWindow — per surface class');

const printed = createSurface(A4_LANDSCAPE_ARTWORK);
const passthrough = negotiateWindow(printed, WIDE);
ok(passthrough === WIDE, 'continuous surface: bbox returned unchanged, same reference');
eq(negotiateWindow(printed, [1, 2, 3, 4]).join(','), '1,2,3,4',
   'continuous surface: array bbox untouched too');

for (const surface of [doodle, monarch]) {
  const win = negotiateWindow(surface, WIDE);
  const label = surface.id;
  near(bboxAspect(win), surface.materialAspect, ASPECT_EPSILON,
       `${label}: negotiated window matches the hardware aspect`);
  near(aspectMismatch(surface.materialAspect, bboxAspect(win)), 0, ASPECT_EPSILON,
       `${label}: mismatch driven to zero, not merely reported`);
  ok(contains(WIDE, win), `${label}: crops rather than pads — never leaves the loaded window`);
  ok(centred(win, WIDE), `${label}: negotiated window stays centred`);
}

const mismatchBefore = Math.abs(aspectMismatch(monarch.materialAspect, bboxAspect(WIDE)));
ok(mismatchBefore > 0.1, 'Monarch on a 2.0 window really is mismatched before negotiation',
   `mismatch ${mismatchBefore.toFixed(3)}`);

const padOverride = negotiateWindow(monarch, TALL, { mode: 'pad' });
ok(contains(padOverride, TALL), 'explicit pad override still available for callers that load wider');

// ---------------------------------------------------------------------------
group('createSurface — descriptors and guards');

eq(Object.keys(SURFACE_DESCRIPTORS).length, 4, 'four ready-made descriptors');
ok(Object.values(SURFACE_DESCRIPTORS).every((d) => {
  const s = createSurface(d);
  return s.acuityCellCount > 0 && s.materialAspect > 0;
}), 'every ready-made descriptor builds a usable Surface');
ok(Object.isFrozen(doodle), 'a Surface is a frozen value, not a mutable device handle');
eq(monarch.refreshable, true, 'Monarch is refreshable');
eq(printed.refreshable, false, 'pre-printed material is not');
eq(printed.devicePinPitchMm, null, 'continuous surfaces have no pitch');
eq(printed.deviceCols, null, 'continuous surfaces have no device grid');
throws(() => createSurface({ id: 'x', kind: 'refreshable', cols: 10, rows: 10 }),
       'refreshable descriptor without a pitch is rejected');
throws(() => createSurface({ id: 'x', kind: 'holographic', widthMm: 10, heightMm: 10 }),
       'unknown surface kind is rejected');
throws(() => createSurface(null), 'null descriptor is rejected');

// A refreshable device with a bezel: explicit material size overrides cols*pitch.
const bezelled = createSurface({
  id: 'bezelled', kind: 'refreshable', cols: 43, rows: 31, pinPitchMm: 6.4,
  widthMm: 300, heightMm: 200,
});
eq(bezelled.acuityCols, 46, 'explicit widthMm overrides cols × pitch');
eq(bezelled.deviceCols, 43, 'the device pin count is still reported');

// ---------------------------------------------------------------------------
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) console.log(`failing: ${failures.join(' | ')}`);
process.exit(fail ? 1 : 0);
