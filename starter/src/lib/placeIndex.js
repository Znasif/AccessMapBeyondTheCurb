/**
 * PlaceIndex — milestone 8.
 *
 * Implements §4.2 and §6.4 of the local-LLM design: place resolution is
 * retrieval, not a tool call. MapIO calls `enable_points_of_interests` on every
 * single question, which is the most frequent call in that system and costs LLM
 * tokens to do what a dot product does for free. Here the index is built once
 * per (world, window) and queried locally:
 *
 *   on window change:  places -> embed -> IndexedDB, key = worldId + windowId
 *   on utterance:      top-k = cosine(embed(utterance), places), k = 5
 *
 * The resolved names are then injected as candidate places for L2/L3, so the
 * model formats a call against a name that already exists rather than
 * inventing one.
 */

import { LocalLLMClient, dot } from './localLLM.js';

const DB_NAME = 'abtc-place-index';
const DB_VERSION = 1;
const STORE = 'indices';

/**
 * Bump when the persisted record shape or the embedded document text changes.
 * Records at an older version are rebuilt rather than reused — a store holding
 * two encodings ranks badly instead of failing loudly, which is far worse.
 */
const RECORD_VERSION = 3;

/** §6.4: "evict LRU past ~20". */
export const MAX_CACHED_INDICES = 20;

/** §4.2: "ties within 0.02 cosine trigger a clarifying question rather than a guess". */
export const TIE_EPSILON = 0.02;

/**
 * Margin threshold for the L2 fast path — NOT a verdict on the retrieval.
 *
 * L1's job is to cut context, not to decide. Measured over all 50 POIs of the
 * new_york model, recall@1 is 1/5 while recall@5 is 5/5: for "the Korean place"
 * the top five are BCD Tofu House, Gammeeok, Barn Joo 35, Woorijip — all Korean
 * — and for "I need an ATM" they are five banks. Which of five equally-valid
 * candidates lands at rank 1 is close to arbitrary, so scoring this index on
 * top-1 correctness measures nothing useful. Recall@k is the metric; the whole
 * top-k goes to L3, which does the choosing.
 *
 * This margin only feeds §4's escalation rule (is L2's cheap path allowed, or
 * do we fall through to L3 with the full candidate list). A low margin means
 * "L3 should decide", not "retrieval failed".
 *
 * It is relative rather than the design doc's absolute "~0.55 cosine" because
 * that figure was calibrated on un-prefixed embeddings. EmbeddingGemma's task
 * prefixes improve ranking but compress absolute scores to ~0.36-0.53, so an
 * absolute 0.55 would reject nearly every correct match.
 */
export const MIN_RELATIVE_MARGIN = 0.15;

/**
 * The text actually embedded for a place. Bump RECORD_VERSION when this
 * changes: a store holding two encodings ranks badly rather than failing loudly.
 *
 * Includes far more than name+category, because the retrieval is genuinely
 * grounded in this text rather than in the model's world knowledge. Measured
 * precision@5 against the structured fields, over the 50-POI new_york model:
 *
 *   "somewhere with tactile paving"   2/5   base  4%   10.0x lift  (2 of 2 found)
 *   "a place with an elevator"        3/5   base  6%   10.0x lift  (3 of 3 found)
 *   "what is on 5th Avenue"           5/5   base 12%    8.3x lift
 *   "somewhere wheelchair accessible" 5/5   base 46%    2.2x lift
 *
 * The first two matter most: only two POIs in the whole model have tactile
 * paving and only three have an elevator, and the query surfaces all of them at
 * the top. That information exists nowhere except this text, so the ranking
 * cannot be coming from a prior about the names.
 *
 * The last line is the counter-lesson: an attribute held by half the dataset
 * carries almost no signal. Do not embed near-universal flags — they cost
 * tokens and dilute the vector.
 *
 * `accessibility` is included on principle as well as measurement: this is a
 * tactile map for blind users, and "tactile map near the entrance, following
 * the tactile paving" is exactly what the user needs to be able to ask for.
 */
export function placeDocument(place) {
  const parts = [place.name];
  if (place.category) parts.push(place.category);
  // Prose like "on 5th Avenue, between the intersection with West 33rd Street
  // and ...". Carries the spatial relations that categories cannot.
  if (place.locationDescription) parts.push(place.locationDescription);
  if (place.accessibility?.length) parts.push(`accessibility: ${place.accessibility.join(', ')}`);
  if (place.context) parts.push(place.context);
  return { name: place.name, text: parts.join('. ') + '.' };
}

/**
 * Normalise a camio-style POI record into the shape placeDocument expects.
 *
 * `coords` and `edge` are deliberately NOT used, and must not be added here.
 * Geometry is not this layer's job:
 *
 *   L1          resolves the NAME        "the Korean place" -> BCD Tofu House
 *   dispatcher  supplies the POSITION    injectedContext.uv, never from the model
 *   tool        computes the GEOMETRY    get_distance_to, get_direction_to,
 *                                        describe_surroundings, whats_here
 *
 * describe_surroundings takes only `radius` and `category` and is answered from
 * uv against the graph; whats_here takes no arguments at all and is answered at
 * L0 from the last featureEntered payload. Re-ranking this index by proximity
 * would duplicate the adapter, in a structure that cannot represent distance.
 *
 * One caveat on the enriched document: location_description is spatial PROSE
 * ("between the intersection with West 33rd Street and ..."), and it makes
 * queries like "between 33rd and 34th" rank well. That is legitimate as name
 * resolution — the user is describing which place they mean. It must never be
 * the source of an actual distance or bearing; those come from the tool.
 */
export function fromCamioPoi(poi, id) {
  const a = poi.accessibility || {};
  const flags = Object.entries(a).filter(([, v]) => v === true).map(([k]) => k.replace(/_/g, ' '));
  if (typeof a.tactile_map === 'string') flags.push(`tactile map ${a.tactile_map}`);
  return {
    id,
    name: poi.name,
    category: (poi.categories || []).join(', '),
    locationDescription: poi.location_description || '',
    accessibility: flags,
    context: [poi.street, poi.housenumber].filter(Boolean).join(' '),
  };
}

/* ------------------------------------------------------------------ *
 * Storage. IndexedDB in the browser; injectable so the retrieval logic
 * is testable in Node, where IndexedDB does not exist.
 * ------------------------------------------------------------------ */

export class MemoryStore {
  constructor() { this.map = new Map(); }
  async get(key) { return this.map.get(key) || null; }
  async put(key, value) { this.map.set(key, value); }
  async delete(key) { this.map.delete(key); }
  async entries() { return [...this.map.entries()].map(([key, value]) => ({ key, value })); }
}

export class IndexedDBStore {
  #dbPromise = null;

  #db() {
    if (!this.#dbPromise) {
      this.#dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains(STORE)) {
            req.result.createObjectStore(STORE, { keyPath: 'key' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return this.#dbPromise;
  }

  async #tx(mode, fn) {
    const db = await this.#db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.onerror = () => reject(tx.error);
      if (req) req.onsuccess = () => resolve(req.result);
      else tx.oncomplete = () => resolve();
    });
  }

  async get(key) { return (await this.#tx('readonly', (s) => s.get(key))) || null; }
  async put(key, value) { return this.#tx('readwrite', (s) => s.put({ ...value, key })); }
  async delete(key) { return this.#tx('readwrite', (s) => s.delete(key)); }
  async entries() {
    const all = (await this.#tx('readonly', (s) => s.getAll())) || [];
    return all.map((value) => ({ key: value.key, value }));
  }
}

function defaultStore() {
  return typeof indexedDB !== 'undefined' ? new IndexedDBStore() : new MemoryStore();
}

export const indexKey = (worldId, windowId) => `${worldId}::${windowId}`;

/* ------------------------------------------------------------------ *
 * Index
 * ------------------------------------------------------------------ */

export class PlaceIndex {
  constructor({ client = new LocalLLMClient(), store = defaultStore(), maxCached = MAX_CACHED_INDICES } = {}) {
    this.client = client;
    this.store = store;
    this.maxCached = maxCached;
    /** In-flight builds, so a burst of window changes does not embed twice. */
    this.pending = new Map();
  }

  /**
   * Build (or reuse) the index for one (world, window).
   *
   * Vectors persist as a single flat Float32Array rather than an array of
   * arrays: structured-clone handles typed arrays natively, and one 768×N
   * buffer is far cheaper to store and reload than N small ones.
   */
  async build({ worldId, windowId, places, force = false }) {
    const key = indexKey(worldId, windowId);

    if (!force) {
      const cached = await this.store.get(key);
      if (cached && cached.version === RECORD_VERSION && cached.count === places.length) {
        await this.#touch(key, cached);
        return cached;
      }
      if (this.pending.has(key)) return this.pending.get(key);
    }

    const job = (async () => {
      const docs = places.map(placeDocument);
      const vectors = await this.client.embedDocuments(docs);
      const dim = vectors[0]?.length || 0;

      const flat = new Float32Array(dim * vectors.length);
      vectors.forEach((v, i) => flat.set(v, i * dim));

      const record = {
        key,
        version: RECORD_VERSION,
        worldId,
        windowId,
        dim,
        count: places.length,
        names: places.map((p) => p.name),
        // Carried so the candidate block can show WHY a place ranked where it
        // did. Injecting bare names measurably loses calls: L3 cannot connect
        // "the observation deck" to "Empire State Building" without seeing
        // tourism.attraction, and asks a clarifying question instead.
        categories: places.map((p) => p.category || ''),
        ids: places.map((p, i) => p.id ?? i),
        vectors: flat,
        builtAt: Date.now(),
        usedAt: Date.now(),
      };

      await this.store.put(key, record);
      await this.#evict();
      return record;
    })();

    this.pending.set(key, job);
    try { return await job; } finally { this.pending.delete(key); }
  }

  /**
   * Retrieve the top-k candidate places for an utterance.
   *
   * The product here is `matches` — the shortlist injected into the L2/L3
   * prompt. Measured on the new_york model that replaces ~9,852 tokens of POI
   * context (or ~11,073 for the full graph, which does not even fit in an 8192
   * window) with ~27 tokens of names, in 12-120 ms.
   *
   * `confident` and `ambiguous` are routing hints for §4's escalation rule,
   * not a judgement on retrieval quality. Do not treat a low margin as failure:
   * it usually means several candidates are equally valid, which is precisely
   * the case that should reach L3 with all of them.
   */
  async resolve(utterance, { worldId, windowId, k = 5 } = {}) {
    const record = await this.store.get(indexKey(worldId, windowId));
    if (!record || !record.count) {
      return { matches: [], confident: false, ambiguous: false, reason: 'no-index' };
    }
    await this.#touch(record.key, record);

    const [queryVec] = await this.client.embedQueries([utterance]);
    const { dim, count, vectors } = record;

    const scored = new Array(count);
    for (let i = 0; i < count; i++) {
      scored[i] = {
        id: record.ids[i],
        name: record.names[i],
        category: record.categories?.[i] || '',
        score: dot(queryVec, vectors.subarray(i * dim, (i + 1) * dim)),
      };
    }
    scored.sort((a, b) => b.score - a.score);

    const matches = scored.slice(0, k);
    const [top, second] = matches;
    const gap = second ? top.score - second.score : top.score;

    return {
      matches,
      // Scale-free: see MIN_RELATIVE_MARGIN on why this is not an absolute cutoff.
      confident: top.score > 0 && gap / top.score >= MIN_RELATIVE_MARGIN,
      ambiguous: Boolean(second) && gap < TIE_EPSILON,
      margin: gap,
      reason: 'ok',
    };
  }

  /** Names only. Prefer resolve() + buildCandidateBlock() — see candidateContext.js. */
  async candidateNames(utterance, opts) {
    const { matches, ambiguous } = await this.resolve(utterance, opts);
    return { names: matches.map((m) => m.name), ambiguous };
  }

  async #touch(key, record) {
    record.usedAt = Date.now();
    await this.store.put(key, record);
  }

  async #evict() {
    const entries = await this.store.entries();
    if (entries.length <= this.maxCached) return;
    entries
      .sort((a, b) => (a.value.usedAt || 0) - (b.value.usedAt || 0))
      .slice(0, entries.length - this.maxCached)
      .forEach((e) => this.store.delete(e.key));
  }
}
