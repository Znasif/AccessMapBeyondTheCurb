/**
 * PoI — a point of interest attached to an edge, ported from
 * `explore/simple_camio_llm/src/graph/poi.py`.
 *
 * Milestone P of `docs/browser-voice-exploration-plan.md` §4. Platform-free.
 *
 * NOTE on the design rule "names, not indices" (tooling design §3, rule 2): the
 * *index* survives here because the parity benchmark's tool contract is written
 * in indices and `PoI.index` is also the identity used by `equals()`. The
 * `Graph` API added on top resolves POIs by name as well — see
 * `Graph.resolvePoi()`. Nothing in this file builds a POI index *structure*;
 * that is the part §4 says not to port.
 */

import { Coords, strDict } from './coords.js';
import { Edge } from './edge.js';

/** Keys `toString()` keeps when summarising a POI. */
export const POIS_IMPORTANT_KEYS = Object.freeze([
  'name',
  'name_other',
  'index',
  'street',
  'coords',
  'edge',
  'opening_hours',
  'brand',
  'categories',
  'facilities',
  'catering',
  'commercial',
]);

/** Accessibility feature keys. */
export const PoIFeatures = Object.freeze({
  WHEELCHAIR_ACCESSIBLE: 'wheelchair_accessible',
  TACTILE_PAVING: 'tactile_paving',
  TACTILE_MAP: 'tactile_map',
  RECEPTION: 'reception',
  STAIRS: 'stairs',
  ELEVATOR: 'elevator',
});

/** Defaults used when a POI declares no accessibility block. */
export const defaultPoIFeatures = Object.freeze({
  wheelchair_accessible: false,
  tactile_paving: false,
  tactile_map: false,
  reception: false,
  stairs: false,
  elevator: false,
});

/**
 * A named place, positioned in map coordinates and bound to the edge it sits on.
 *
 * `enabled` is the LLM-visibility flag: with the LLM in the loop the model
 * enables the subset it wants to reason about, and `Graph.getNearestPoi()` only
 * ever considers enabled POIs.
 */
export class PoI {
  /**
   * @param {number} index
   * @param {string} name
   * @param {Coords} coords
   * @param {Edge} edge
   * @param {Record<string, unknown>} info Raw entry from the map JSON.
   */
  constructor(index, name, coords, edge, info) {
    this.index = index;
    this.name = name;
    this.coords = coords;
    this.edge = edge;

    // Deviation, documented: the Python `del`s "name", "coords" and "edge" out
    // of the dict it was handed, mutating the caller's parsed model JSON in
    // place. Copying first keeps a re-parse-free reload of the same object
    // usable, and nothing downstream can tell the difference.
    /** @type {Record<string, unknown>} */
    const own = { ...info };
    delete own.name;
    delete own.coords;
    delete own.edge;
    this._info = own;

    this.enabled = false;
  }

  /**
   * @returns {Record<string, unknown>} A copy — mutating it changes nothing.
   */
  accessibility() {
    const a = this._info.accessibility;
    return a && typeof a === 'object' ? { ...a } : { ...defaultPoIFeatures };
  }

  /** @returns {string} */
  getCompleteDescription() {
    let description = `${this.name} on ${this.street}`;

    const accessibility = this.accessibility();

    if (accessibility[PoIFeatures.WHEELCHAIR_ACCESSIBLE]) description += ', wheelchair accessible';

    /** @type {string[]} */
    const tactileFeatures = [];
    if (accessibility[PoIFeatures.TACTILE_PAVING]) tactileFeatures.push('tactile paving');
    if (accessibility[PoIFeatures.TACTILE_MAP]) tactileFeatures.push('tactile map');

    // Faithful to the Python, which tests `> 1`: a POI with exactly one tactile
    // feature says nothing about it. Reported, not fixed.
    if (tactileFeatures.length > 1) description += `, with ${tactileFeatures.join(' and ')}`;

    if (accessibility[PoIFeatures.ELEVATOR]) description += ', accessible via elevator';
    else if (accessibility[PoIFeatures.STAIRS]) description += ', accessible via stairs';

    if (accessibility[PoIFeatures.RECEPTION]) description += ', includes a reception area';

    return description;
  }

  /**
   * @param {Coords} coords
   * @returns {number}
   */
  distanceTo(coords) {
    return this.coords.distanceTo(coords);
  }

  /**
   * @param {Coords} _coords
   * @returns {Coords}
   */
  closestPoint(_coords) {
    return this.coords;
  }

  /** @returns {string} Street the POI's edge belongs to. */
  get street() {
    return this.edge.street;
  }

  /** @returns {void} */
  enable() {
    this.enabled = true;
  }

  /** @returns {void} */
  disable() {
    this.enabled = false;
  }

  /**
   * Everything the tool layer may show, identity first. Frozen, matching the
   * Python's `MappingProxyType`.
   * @returns {Record<string, unknown>}
   */
  get info() {
    return Object.freeze({
      name: this.name,
      index: this.index,
      coords: this.coords,
      edge: this.edge,
      ...this._info,
    });
  }

  /**
   * @param {string} key
   * @returns {unknown}
   */
  get(key) {
    return this._info[key];
  }

  /**
   * @param {unknown} other
   * @returns {boolean}
   */
  equals(other) {
    return other instanceof PoI && this.index === other.index;
  }

  /** @returns {string} The `str_dict` rendering the LLM prompt receives. */
  toString() {
    /** @type {Record<string, unknown>} */
    const summary = {
      index: this.index,
      name: this.name,
      coords: this.coords,
      edge: this.edge,
    };
    for (const [key, value] of Object.entries(this._info)) {
      if (POIS_IMPORTANT_KEYS.includes(key)) summary[key] = value;
    }

    return strDict(summary);
  }
}
