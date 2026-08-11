/**
 * Coords — 2D point / vector geometry, ported from
 * `explore/simple_camio_llm/src/utils/coords.py` (+ the `CardinalDirection`
 * enum from `src/utils/utils.py`).
 *
 * Milestone P of `docs/browser-voice-exploration-plan.md` §4. PLATFORM-FREE ON
 * PURPOSE: no DOM, no React, no IndexedDB, no fetch — plain ES modules that run
 * unchanged in Node, so `scripts/test_logic_port.mjs` and eventually
 * `explore/simple_camio_llm/run_parity_benchmark.py`'s tool contract can be
 * exercised without a browser.
 *
 * Semantics are preserved exactly, including the units: everything here is in
 * *map coordinates* (the Python calls them pixels) or in feet once a caller has
 * multiplied by `feetsPerPixel`. Nothing converts silently.
 */

/**
 * Python's `round()` — round-half-to-**even**, not half-away-from-zero.
 *
 * `Math.round(0.5) === 1` and `Math.round(2.5) === 3`, where Python gives 0 and
 * 2. Two ported call sites round user-visible numbers (`Graph.getDistance`
 * snaps to a 10 ft step, `Graph.processInstructions` rounds leg lengths to one
 * decimal), so a half-up rounder would disagree with the reference
 * implementation on exact ties — which a 10 ft step hits often.
 *
 * `n === 0` is decided directly on the double, where `x - floor(x) === 0.5` is
 * exact. For `n > 0` scaling by `10 ** n` would invent ties that are not there
 * — `2.675 * 100` is exactly `267.5` in binary even though 2.675 itself is
 * slightly below the tie, which is why CPython gives 2.67 — so those go through
 * the decimal expansion instead, which is what CPython's `_Py_dg_dtoa` does.
 *
 * @param {number} x
 * @param {number} [n=0] Decimal places.
 * @returns {number}
 */
export function pyRound(x, n = 0) {
  if (!Number.isFinite(x)) return x;

  if (n > 0) return roundDecimal(x, Math.min(n, 90));

  const p = 10 ** n;
  const v = x * p;
  const floor = Math.floor(v);
  const frac = v - floor;

  let r;
  if (frac > 0.5) r = floor + 1;
  else if (frac < 0.5) r = floor;
  else r = floor % 2 === 0 ? floor : floor + 1;

  return r / p;
}

/**
 * Half-to-even at `n > 0` decimal places, decided on the double's exact decimal
 * expansion rather than on `x * 10 ** n`.
 * @param {number} x
 * @param {number} n
 * @returns {number}
 */
function roundDecimal(x, n) {
  const negative = x < 0;

  // toFixed is correctly rounded, and n + 20 significant fractional digits is
  // far more than a double can disagree over at position n.
  const text = Math.abs(x).toFixed(Math.min(n + 20, 100));
  const dot = text.indexOf('.');
  const intPart = text.slice(0, dot);
  const frac = text.slice(dot + 1);

  const keep = frac.slice(0, n).padEnd(n, '0');
  const rest = frac.slice(n);

  const firstRest = rest.length > 0 ? rest.charCodeAt(0) - 48 : 0;
  let cmp;
  if (firstRest > 5) cmp = 1;
  else if (firstRest < 5) cmp = -1;
  else cmp = /[1-9]/.test(rest.slice(1)) ? 1 : 0;

  let base = BigInt(intPart + keep);
  if (cmp > 0) base += 1n;
  else if (cmp === 0 && base % 2n === 1n) base += 1n;

  const result = Number(base) / 10 ** n;
  return negative ? -result : result;
}

/**
 * A straight line, as the two-parameter form the Python uses.
 *
 * `Edge` implements it. Vertical lines are represented as `m === Infinity` with
 * `q` carrying the x-intercept instead of the y-intercept — an odd convention,
 * but `distanceToLine` and `projectOn` both special-case it, so it is preserved.
 *
 * @typedef {object} StraightLine
 * @property {number} m Slope, or `Infinity` for a vertical line.
 * @property {number} q y-intercept, or the x-intercept when `m` is `Infinity`.
 */

/**
 * A pair of coordinates `(x, y)`, or a 2D vector.
 *
 * Instances are frozen; every operation returns a new instance, matching the
 * Python `@dataclass(frozen=True)`. Python's value equality becomes `.equals()`
 * — JS has no operator overloading, so every ported `a == b` on coordinates is
 * an explicit `a.equals(b)` call.
 */
export class Coords {
  /** @type {Coords} Zero vector `(0, 0)`. */
  static ZERO;
  /** @type {Coords} `(Infinity, Infinity)`. */
  static INF;

  /**
   * @param {number} x
   * @param {number} y
   */
  constructor(x, y) {
    this.x = x;
    this.y = y;
    Object.freeze(this);
  }

  /** @returns {[number, number]} */
  get coords() {
    return [this.x, this.y];
  }

  /**
   * `Coords` is its own closest point — the `Position` protocol shared with
   * `Node`, `Edge` and `PoI`.
   * @param {Coords} _coords
   * @returns {Coords}
   */
  closestPoint(_coords) {
    return this;
  }

  /** @returns {string} */
  getCompleteDescription() {
    return this.toString();
  }

  /**
   * Euclidean distance.
   * @param {Coords} coords
   * @returns {number}
   */
  distanceTo(coords) {
    return Math.sqrt((this.x - coords.x) ** 2 + (this.y - coords.y) ** 2);
  }

  /**
   * @param {Coords} other
   * @returns {number}
   */
  manhattanDistanceTo(other) {
    return Math.abs(this.x - other.x) + Math.abs(this.y - other.y);
  }

  /**
   * Perpendicular distance to a straight line.
   * @param {StraightLine} line
   * @returns {number}
   */
  distanceToLine(line) {
    if (!Number.isFinite(line.m)) return Math.abs(this.x - line.q);

    const num = Math.abs(line.m * this.x + line.q - this.y);
    const den = Math.sqrt(line.m ** 2 + 1);

    return num / den;
  }

  /**
   * Orthogonal projection onto a straight line. Note this is the projection on
   * the *infinite* line; `Edge.contains()` is what decides whether the result
   * lies on the segment.
   * @param {StraightLine} line
   * @returns {Coords}
   */
  projectOn(line) {
    if (!Number.isFinite(line.m)) return new Coords(line.q, this.y);

    const px = (this.x + line.m * this.y - line.m * line.q) / (line.m ** 2 + 1);
    const py = (line.m * this.x + line.m ** 2 * this.y + line.q) / (line.m ** 2 + 1);

    return new Coords(px, py);
  }

  /**
   * @param {Coords} other
   * @returns {number}
   */
  dot(other) {
    return this.x * other.x + this.y * other.y;
  }

  /**
   * 2D cross product (the z component of the 3D one). Sign gives the turn side.
   * @param {Coords} other
   * @returns {number}
   */
  cross2d(other) {
    return this.x * other.y - this.y * other.x;
  }

  /** @returns {number} */
  length() {
    return this.distanceTo(Coords.ZERO);
  }

  /** @returns {number} */
  magnitude() {
    return this.length();
  }

  /**
   * Unit vector with the same direction. A zero vector yields `(NaN, NaN)`,
   * exactly as the Python raises nothing and divides by zero — callers never
   * normalize a zero leg because `Graph.localLegs()` drops zero-length legs.
   * @returns {Coords}
   */
  normalized() {
    return this.div(this.length());
  }

  /**
   * @param {Coords|number} other
   * @returns {Coords}
   */
  add(other) {
    if (other instanceof Coords) return new Coords(this.x + other.x, this.y + other.y);
    return new Coords(this.x + other, this.y + other);
  }

  /**
   * @param {Coords|number} other
   * @returns {Coords}
   */
  sub(other) {
    if (other instanceof Coords) return new Coords(this.x - other.x, this.y - other.y);
    return new Coords(this.x - other, this.y - other);
  }

  /**
   * @param {number} other
   * @returns {Coords}
   */
  mul(other) {
    return new Coords(this.x * other, this.y * other);
  }

  /**
   * @param {number} other
   * @returns {Coords}
   */
  div(other) {
    return new Coords(this.x / other, this.y / other);
  }

  /**
   * @param {number} other
   * @returns {Coords}
   */
  floorDiv(other) {
    return new Coords(Math.floor(this.x / other), Math.floor(this.y / other));
  }

  /**
   * Index access, mirroring Python's `__getitem__`: `0` is x, anything else y.
   * @param {number} index
   * @returns {number}
   */
  get(index) {
    return index === 0 ? this.x : this.y;
  }

  /**
   * Python's `__round__`, which rounds each component and returns a `Coords`.
   * @param {number} [n=0]
   * @returns {Coords}
   */
  round(n = 0) {
    return new Coords(pyRound(this.x, n), pyRound(this.y, n));
  }

  /**
   * Value equality — the frozen dataclass's `__eq__`.
   * @param {unknown} other
   * @returns {boolean}
   */
  equals(other) {
    return other instanceof Coords && this.x === other.x && this.y === other.y;
  }

  /** @returns {string} */
  toString() {
    return `(${this.x}, ${this.y})`;
  }
}

Coords.ZERO = new Coords(0, 0);
Coords.INF = new Coords(Infinity, Infinity);

/**
 * Reference point tying map coordinates to real-world latitude/longitude.
 */
export class LatLngReference {
  /**
   * @param {Coords} coords Map coordinates of the reference point.
   * @param {number} lat
   * @param {number} lng
   */
  constructor(coords, lat, lng) {
    this.coords = coords;
    this.lat = lat;
    this.lng = lng;
  }
}

/** Conversion factor from meters to feet. */
export const FEETS_PER_METER = 3.280839895;

/** Earth radius in feet. */
export const R = 6378137 * FEETS_PER_METER;

/**
 * Map coordinates -> `(lat, lng)`, returned as a `Coords` with `x = lat` and
 * `y = lng` (the Python's convention, kept so the two agree component for
 * component).
 * @param {LatLngReference} latlngReference
 * @param {Coords} coords
 * @returns {Coords}
 */
export function coordsToLatLng(latlngReference, coords) {
  const diff = coords.sub(latlngReference.coords);
  const de = diff.get(0);
  const dn = -diff.get(1);

  const dLat = dn / R;
  const dLon = de / (R * Math.cos((Math.PI * latlngReference.lat) / 180));

  const latO = latlngReference.lat + (dLat * 180) / Math.PI;
  const lonO = latlngReference.lng + (dLon * 180) / Math.PI;

  return new Coords(latO, lonO);
}

/**
 * `(lat, lng)` -> map coordinates. `latlng.x` is the latitude, `latlng.y` the
 * longitude.
 * @param {LatLngReference} reference
 * @param {Coords} latlng
 * @returns {Coords}
 */
export function latLngToCoords(reference, latlng) {
  let dx = latLngDistance(reference.lat, reference.lng, reference.lat, latlng.y);
  let dy = latLngDistance(reference.lat, reference.lng, latlng.x, reference.lng);

  if (reference.lat > latlng.x) dy *= -1;
  if (reference.lng > latlng.y) dx *= -1;

  return new Coords(reference.coords.x + dx, reference.coords.y - dy);
}

/**
 * Great-circle distance in feet (haversine).
 * @param {number} lat1
 * @param {number} lng1
 * @param {number} lat2
 * @param {number} lng2
 * @returns {number}
 */
export function latLngDistance(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;

  const rLat1 = toRad(lat1);
  const rLng1 = toRad(lng1);
  const rLat2 = toRad(lat2);
  const rLng2 = toRad(lng2);

  const dLat = rLat2 - rLat1;
  const dLon = rLng2 - rLng1;

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLon / 2) ** 2;

  const c = 2 * Math.asin(Math.sqrt(a));
  return R * c;
}

/**
 * The eight cardinal directions, **in the Python enum's declaration order**.
 *
 * The order is load-bearing, not cosmetic: `getTurningDirection()` and
 * `FlyOverNavigator` both index into this list modulo its length and rely on
 * consecutive entries being 45° apart, walking counter-clockwise from
 * south-west. Reordering it silently rotates every spoken direction.
 *
 * @type {readonly string[]}
 */
export const DIRECTIONS = Object.freeze([
  'south-west',
  'west',
  'north-west',
  'north',
  'north-east',
  'east',
  'south-east',
  'south',
]);

/** Named access to {@link DIRECTIONS}, mirroring `CardinalDirection`. */
export const CardinalDirection = Object.freeze({
  SOUTH_WEST: 'south-west',
  WEST: 'west',
  NORTH_WEST: 'north-west',
  NORTH: 'north',
  NORTH_EAST: 'north-east',
  EAST: 'east',
  SOUTH_EAST: 'south-east',
  SOUTH: 'south',
});

/**
 * Python's `str_format`: stringify and replace underscores with spaces.
 * @param {unknown} v
 * @returns {string}
 */
export function strFormat(v) {
  return String(v).replace(/_/g, ' ');
}

/**
 * Python's `str_dict` — the flat, indented rendering the LLM prompt uses for
 * `get_point_of_interest_details`. Kept because the tool result's *shape* is
 * part of the contract the parity benchmark grades.
 * @param {Record<string, unknown>|Map<string, unknown>} d
 * @param {number} [indent=0]
 * @returns {string}
 */
export function strDict(d, indent = 0) {
  const entries = d instanceof Map ? [...d.entries()] : Object.entries(d);

  let res = '';
  for (const [key, value] of entries) {
    res += ' '.repeat(indent) + strFormat(key) + ': ';

    if (Array.isArray(value)) {
      if (value.length === 0) res += '[]\n';
      else if (value.length === 1) res += '[ ' + strFormat(value[0]) + ' ]\n';
      else {
        res += '[\n';
        for (const item of value) res += ' '.repeat(indent + 4) + strFormat(item) + ',\n';
        res += ' '.repeat(indent) + ']\n';
      }
    } else if (value !== null && typeof value === 'object' && !isStringable(value)) {
      res += '\n' + strDict(/** @type {Record<string, unknown>} */ (value), indent + 4);
    } else {
      res += strFormat(value) + '\n';
    }
  }

  return res;
}

/**
 * Python's `isinstance(value, dict)` test is narrower than "is an object" in
 * JS: `Coords`, `Edge` and `PoI` all reach `str_dict` and are rendered through
 * `str()`, not recursed into. Anything with its own `toString` is one of those.
 * @param {object} value
 * @returns {boolean}
 */
function isStringable(value) {
  return Object.getPrototypeOf(value) !== Object.prototype && typeof value.toString === 'function';
}
