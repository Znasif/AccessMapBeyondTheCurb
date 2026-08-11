/**
 * Node — a graph vertex (an intersection, a street end, or a map-border point),
 * ported from `explore/simple_camio_llm/src/graph/node.py`.
 *
 * Milestone P of `docs/browser-voice-exploration-plan.md` §4. Platform-free:
 * imports only `coords.js`.
 */

import { Coords } from './coords.js';

/** Units the map data attaches to its own measurements, spelled out for speech. */
export const SPOKEN_UNITS = Object.freeze({
  m: 'meter',
  s: 'second',
  ft: 'foot',
  cm: 'centimeter',
});

/**
 * `'10 m'` -> `'10 meters'`. Values carry their own unit; say that one.
 *
 * The map data stores these with the unit attached, and the descriptions used
 * to append a second, contradicting one — "10 m feet wide" for a crossing that
 * is 10 metres. Nothing computes with these, so this is a wording fix, not a
 * conversion.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function spokenQuantity(value) {
  const text = String(value).trim();

  // Python's str.rpartition(" "): split on the LAST space.
  const idx = text.lastIndexOf(' ');
  const number = idx === -1 ? '' : text.slice(0, idx);
  const unit = idx === -1 ? text : text.slice(idx + 1);

  const word = SPOKEN_UNITS[unit];
  if (!number || word === undefined) return text; // no unit we recognise

  const plural = number === '1' || number === '1.0' ? '' : 's';
  return `${number} ${word}${plural}`;
}

/** Feature keys carried on a node in the map JSON. */
export const NodeFeatures = Object.freeze({
  ON_BORDER: 'on_border',
  CROSSWALK: 'crosswalk',
  WALK_LIGHT: 'walk_light',
  WALK_LIGHT_DURATION: 'walk_light_duration',
  ROUND_ABOUT: 'round-about',
  STREET_WIDTH: 'street_width',
  TACTILE_PAVING: 'tactile_paving',
});

/** Defaults applied when a node carries no features at all. */
export const defaultNodeFeatures = Object.freeze({
  on_border: false,
  crosswalk: false,
  walk_light: false,
  'round-about': false,
  street_width: 'unknown',
  tactile_paving: false,
});

/** @enum {string} */
export const IntersectionType = Object.freeze({
  FOUR_WAY: 'four-way',
  T: 'T',
  UNKNOWN: '',
});

/**
 * Python's `IntersectionType.__add__`: the UNKNOWN member contributes nothing
 * and does not leave a stray space behind.
 * @param {string} type
 * @param {string} other
 * @returns {string}
 */
function joinIntersectionType(type, other) {
  if (type === IntersectionType.UNKNOWN) return other;
  return `${type} ${other}`;
}

/**
 * A vertex of the road network.
 *
 * Implements the `Position` protocol (`distanceTo`, `closestPoint`,
 * `getCompleteDescription`) shared with `Coords`, `Edge` and `PoI`.
 */
export class Node {
  /**
   * @param {number} index Position in `Graph.nodes`; also the identity.
   * @param {Coords} coords
   * @param {Record<string, unknown>} [features]
   */
  constructor(index, coords, features = undefined) {
    this.coords = coords;
    this.index = index;
    /**
     * Street names touching this node, appended once per incident edge by
     * `loadEdges()`. Duplicates are meaningful: `intersectionType` counts the
     * list, not the set, so a four-way crossing of two streets has length 4.
     * @type {string[]}
     */
    this.adjacentsStreets = [];

    this.features = features !== undefined && features !== null ? features : { ...defaultNodeFeatures };
  }

  /** @returns {string} Stable key into the distance/predecessor matrices. */
  get id() {
    return `n${this.index}`;
  }

  /** @returns {boolean} */
  get onBorder() {
    return Boolean(this.features[NodeFeatures.ON_BORDER] ?? false);
  }

  /** @returns {string} One of {@link IntersectionType}. */
  get intersectionType() {
    if (this.adjacentsStreets.length === 4) return IntersectionType.FOUR_WAY;
    if (!this.onBorder && this.adjacentsStreets.length === 3) return IntersectionType.T;
    return IntersectionType.UNKNOWN;
  }

  /**
   * The short form used in spoken waypoint instructions ("until X at Y").
   * @returns {string}
   */
  getShortDescription() {
    if (this.adjacentsStreets.length === 0) return 'An isolated point';
    if (this.adjacentsStreets.length === 1) {
      if (this.onBorder) return `${this.adjacentsStreets[0]}, at the limit of the map`;
      return `end of ${this.adjacentsStreets[0]}`;
    }

    const streets = [...new Set(this.adjacentsStreets)].sort();
    let streetsStr = streets[0];
    if (streets.length === 2) streetsStr += ` at ${streets[1]}`;
    else streetsStr += ' at ' + streets.slice(1, -1).join(', ') + ` and ${streets[streets.length - 1]}`;

    return streetsStr;
  }

  /**
   * The form used in the LLM prompt.
   *
   * Deviation, documented: Python builds `list(set(...))`, whose order is the
   * hash order of the strings and therefore not reproducible across runs. This
   * uses first-appearance order, which is deterministic. Only the wording of a
   * three-or-more-street description is affected.
   *
   * @returns {string}
   */
  getLlmDescription() {
    if (this.adjacentsStreets.length === 0) return 'An isolated point';
    if (this.adjacentsStreets.length === 1) {
      if (this.onBorder) return `${this.adjacentsStreets[0]}, at the limit of the map`;
      return `end of ${this.adjacentsStreets[0]}`;
    }

    const streets = [...new Set(this.adjacentsStreets)];
    const streetsStr = streets.slice(0, -1).join(', ') + ' and ' + streets[streets.length - 1];

    return joinIntersectionType(this.intersectionType, 'intersection of ') + streetsStr;
  }

  /**
   * Everything known about this node, spoken.
   * @returns {string}
   */
  getCompleteDescription() {
    let description = this.getLlmDescription();

    if (this.onBorder) description += ', at the limit of the map';

    const tactilePaving = this.features[NodeFeatures.TACTILE_PAVING] ?? false;
    const crosswalk = this.features[NodeFeatures.CROSSWALK] ?? false;
    const walkLight = this.features[NodeFeatures.WALK_LIGHT] ?? false;
    const walkLightDuration = this.features[NodeFeatures.WALK_LIGHT_DURATION] ?? 'unknown';
    const streetWidth = this.features[NodeFeatures.STREET_WIDTH] ?? 'unknown';

    if (tactilePaving || crosswalk) {
      description += tactilePaving ? ', with tactile paving' : ', with crosswalks';
      if (walkLight) {
        description += ' and walk lights';
        if (walkLightDuration !== 'unknown') {
          description += ` that last ${spokenQuantity(walkLightDuration)}`;
        }
      }
    }

    if (streetWidth !== 'unknown') description += `, ${spokenQuantity(streetWidth)} wide`;

    return description;
  }

  /** @returns {boolean} */
  isDeadEnd() {
    return !this.onBorder && this.adjacentsStreets.length <= 1;
  }

  /**
   * @param {Node|Coords} coords
   * @returns {number}
   */
  distanceTo(coords) {
    if (coords instanceof Node) return this.coords.distanceTo(coords.coords);
    return this.coords.distanceTo(coords);
  }

  /**
   * @param {Node|Coords} other
   * @returns {number}
   */
  manhattanDistanceTo(other) {
    if (other instanceof Node) return this.coords.manhattanDistanceTo(other.coords);
    return this.coords.manhattanDistanceTo(other);
  }

  /**
   * @param {Coords} _coords
   * @returns {Coords}
   */
  closestPoint(_coords) {
    return this.coords;
  }

  /**
   * @param {Node} other
   * @returns {boolean}
   */
  isOnSameStreet(other) {
    const mine = new Set(this.adjacentsStreets);
    return other.adjacentsStreets.some((s) => mine.has(s));
  }

  /**
   * @param {number} index
   * @returns {number}
   */
  get(index) {
    return this.coords.get(index);
  }

  /**
   * Identity is the index, as in Python — two nodes at the same coordinates are
   * still different nodes.
   * @param {unknown} other
   * @returns {boolean}
   */
  equals(other) {
    return other instanceof Node && this.index === other.index;
  }

  /** @returns {string} */
  toString() {
    return `${this.id}: ${this.coords}`;
  }
}
