/**
 * Deterministic seeded PRNG for the local multi-table soak runner.
 *
 * All workload randomness (operation mix, field picks, filter shapes) flows
 * through one seeded mulberry32 stream so a run is reproducible from its
 * `--seed` value. The PRNG is deliberately self-contained: no crypto, no
 * global state, and integer arithmetic only.
 */

/** Immutable deterministic random source over one seed. */
export class SeededRandom {
  #state;

  /**
   * @param {number} seed non-negative 32-bit integer seed.
   */
  constructor(seed) {
    if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) {
      throw new Error(`seed must be a safe integer in [0, 2^32-1]: ${seed}`);
    }
    this.#state = seed >>> 0;
  }

  /** Next float in [0, 1). */
  next() {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Next integer in [0, maxExclusive). */
  int(maxExclusive) {
    if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0) {
      throw new Error(`maxExclusive must be a positive integer: ${maxExclusive}`);
    }
    return Math.floor(this.next() * maxExclusive);
  }

  /** Picks one element from a non-empty array. */
  pick(items) {
    if (items.length === 0) throw new Error("pick() requires a non-empty array");
    return items[this.int(items.length)];
  }

  /** True with probability `p` (0..1). */
  chance(p) {
    return this.next() < p;
  }
}

/** Derives one child PRNG seed from a parent seed and an integer label. */
export function deriveSeed(parentSeed, label) {
  const base = parentSeed >>> 0;
  const mixed = Math.imul(base ^ (label + 0x9e3779b9), 0x85ebca6b) >>> 0;
  return (mixed ^ (mixed >>> 13)) >>> 0;
}

/**
 * Parses a `--seed` CLI value; returns a default when absent.
 *
 * Accepts decimal or `0x` hexadecimal integers so compact run identifiers can
 * be used as seeds. Throws a descriptive error for malformed values.
 *
 * @returns {number} seed in [0, 2^32-1].
 */
export function parseSeed(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    return 0x50414b53;
  }
  const value = Number(String(raw).trim());
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    // The raw seed value is never echoed: it could be a URL, email, or
    // path pasted by mistake, and error output must stay redacted.
    throw new Error("--seed must be an integer in [0, 4294967295]");
  }
  return value >>> 0;
}
