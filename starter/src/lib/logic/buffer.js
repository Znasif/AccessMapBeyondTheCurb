/**
 * Buffer / ArithmeticBuffer — a bounded, self-expiring sample window, ported
 * from `explore/simple_camio_llm/src/utils/buffer.py`.
 *
 * Milestone P of `docs/browser-voice-exploration-plan.md` §4. Platform-free,
 * and — per the milestone's callback rule — the clock is injected: the Python
 * calls `time.time()` directly, this takes a `now()` returning **seconds**.
 * Tests drive it with a fake clock; the browser passes
 * `() => performance.now() / 1000`.
 */

/**
 * Holds the last `maxSize` values for at most `maxLife` seconds each.
 *
 * @template T
 */
export class Buffer {
  /**
   * @param {number} maxSize Ring capacity; oldest is dropped when full.
   * @param {number} [maxLife=1] Seconds a sample stays readable.
   * @param {() => number} [now] Clock in seconds. Defaults to `Date.now() / 1000`.
   */
  constructor(maxSize, maxLife = 1, now = () => Date.now() / 1000) {
    if (!(maxSize > 0)) throw new Error('maxSize must be > 0');
    if (!(maxLife > 0)) throw new Error('maxLife must be > 0');

    this.maxSize = maxSize;
    this.maxLife = maxLife;
    this.now = now;

    /** @type {T[]} */
    this.buffer = [];
    /** @type {number[]} */
    this.bufferTimestamps = [];
  }

  /**
   * @param {T} value
   * @returns {void}
   */
  add(value) {
    this.buffer.push(value);
    this.bufferTimestamps.push(this.now());

    // deque(maxlen=max_size): pushing past capacity drops from the left.
    while (this.buffer.length > this.maxSize) {
      this.buffer.shift();
      this.bufferTimestamps.shift();
    }
  }

  /**
   * Live samples, expiring anything older than `maxLife` as a side effect —
   * exactly as the Python's `_items()` does.
   * @returns {T[]}
   */
  items() {
    while (this.buffer.length > 0 && this.now() - this.bufferTimestamps[0] > this.maxLife) {
      this.buffer.shift();
      this.bufferTimestamps.shift();
    }

    return this.buffer;
  }

  /** @returns {void} */
  clear() {
    this.buffer = [];
    this.bufferTimestamps = [];
  }

  /**
   * Most frequent live sample.
   *
   * Deviation, documented: Python's `max(set(items), key=items.count)` breaks
   * ties by set iteration order, which is hash order. This breaks them by first
   * appearance, which is deterministic. Values are compared with `===`, so this
   * is only useful for primitives — which is all the Python uses it for.
   *
   * @returns {T|null}
   */
  mode() {
    const items = this.items();
    if (items.length === 0) return null;

    /** @type {Map<T, number>} */
    const counts = new Map();
    for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);

    let best = items[0];
    let bestCount = -1;
    for (const [value, count] of counts) {
      if (count > bestCount) {
        best = value;
        bestCount = count;
      }
    }

    return best;
  }

  /** @returns {T|null} Oldest live sample. */
  first() {
    const items = this.items();
    return items.length === 0 ? null : items[0];
  }

  /** @returns {T|null} Newest live sample. */
  last() {
    const items = this.items();
    return items.length === 0 ? null : items[items.length - 1];
  }

  /** @returns {string} */
  toString() {
    return `[${this.items().join(', ')}]`;
  }
}

/**
 * A `Buffer` whose contents can be averaged.
 *
 * Python relies on `__add__` / `__truediv__` being defined on the element type;
 * JS has no operator overloading, so the two operations are injectable and
 * default to the `Coords` method names (`add`, `div`) that every existing call
 * site uses.
 *
 * @template T
 * @extends {Buffer<T>}
 */
export class ArithmeticBuffer extends Buffer {
  /**
   * @param {number} maxSize
   * @param {number} [maxLife=1]
   * @param {() => number} [now]
   * @param {{sum?: (a: T, b: T) => T, scale?: (v: T, n: number) => T}} [ops]
   */
  constructor(maxSize, maxLife = 1, now = undefined, ops = {}) {
    super(maxSize, maxLife, now);

    this.sum = ops.sum ?? ((a, b) => /** @type {any} */ (a).add(b));
    this.scale = ops.scale ?? ((v, n) => /** @type {any} */ (v).div(n));
  }

  /**
   * Mean of the live samples.
   * @returns {T|null}
   */
  average() {
    const items = this.items();
    if (items.length === 0) return null;

    let acc = items[0];
    for (let i = 1; i < items.length; i += 1) acc = this.sum(acc, items[i]);

    return this.scale(acc, items.length);
  }
}
