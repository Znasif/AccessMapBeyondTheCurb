/**
 * Client for the local llama.cpp router (see ~/.config/abtc/models.ini).
 *
 * The router serves every tier from ONE port and selects between them with the
 * OpenAI `model` field, so there is a single base URL here rather than the
 * three ports the original setup guide described. `l1` is EmbeddingGemma
 * (embeddings only — sending it a chat completion returns "the current context
 * does not logits computation"), `l3` is Gemma 4 E4B.
 *
 * This is the embeddings half of the milestone-3 LocalLLMClient, extracted
 * early because milestone 8 (PlaceIndex) needs it. Streaming, GBNF and the
 * tool loop belong on this same client and are not implemented yet.
 */

export const TIER = { EMBED: 'l1', REASON: 'l3' };

function defaultBase() {
  // Vite dev/proxy path in the browser; overridable for Node scripts and tests.
  if (typeof process !== 'undefined' && process.env?.VITE_LLM_BASE) {
    return process.env.VITE_LLM_BASE;
  }
  if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_LLM_BASE) {
    return import.meta.env.VITE_LLM_BASE;
  }
  return '/llm/v1';
}

/**
 * EmbeddingGemma is trained with task-specific prefixes, and they are not
 * cosmetic. Measured on real POIs, query "the Korean place" against four
 * places, comparing bare strings with the documented prefixes:
 *
 *            top-1        top-2        margin   margin/top-1
 *   bare     0.640        0.461        0.179    28%
 *   prefixed 0.416        0.215        0.201    48%
 *
 * Prefixes nearly double the *relative* separation, which is what ranking
 * quality depends on. But note they also compress absolute scores: the design
 * doc's "top-1 similarity exceeds ~0.55" escalation rule was calibrated on bare
 * strings and would reject a correct 0.416 match. Use the scale-free margin
 * from resolvePlaces() for that decision instead of an absolute cutoff.
 */
const PREFIX = {
  query: (text) => `task: search result | query: ${text}`,
  document: (title, text) => `title: ${title || 'none'} | text: ${text}`,
};

export class LocalLLMClient {
  constructor({ baseUrl = defaultBase(), fetchImpl, timeoutMs = 120_000 } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetch = fetchImpl || globalThis.fetch.bind(globalThis);
    this.timeoutMs = timeoutMs;
  }

  async #post(path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const json = await res.json();
      if (!res.ok || json.error) {
        throw new Error(json?.error?.message || `${path} failed: HTTP ${res.status}`);
      }
      return json;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Embed raw strings with no prefixing. Prefer embedQueries/embedDocuments —
   * mixing prefixed and bare vectors in one index silently degrades ranking.
   *
   * @returns {Promise<Float32Array[]>} unit-normalised vectors
   */
  async embed(texts, { model = TIER.EMBED } = {}) {
    if (!texts.length) return [];
    const json = await this.#post('/embeddings', { model, input: texts });
    // The server returns results with an `index` field; do not assume order.
    const out = new Array(texts.length);
    for (const row of json.data) {
      out[row.index ?? json.data.indexOf(row)] = normalise(Float32Array.from(row.embedding));
    }
    return out;
  }

  embedQueries(queries, opts) {
    return this.embed(queries.map(PREFIX.query), opts);
  }

  /** @param {{name: string, text: string}[]} docs */
  embedDocuments(docs, opts) {
    return this.embed(docs.map((d) => PREFIX.document(d.name, d.text)), opts);
  }
}

/**
 * Normalise in place so similarity is a plain dot product. EmbeddingGemma
 * output is close to unit length already, but "close" turns into drift once
 * vectors are quantised to Float32 and persisted across sessions.
 */
export function normalise(vec) {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}

/** Dot product of two unit vectors == cosine similarity. */
export function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}
