/**
 * Type declarations for `scripts/ci/local-soak/prng.mjs`.
 */

/** Immutable deterministic random source over one seed (mulberry32). */
export class SeededRandom {
  constructor(seed: number);
  /** Next float in [0, 1). */
  next(): number;
  /** Next integer in [0, maxExclusive). */
  int(maxExclusive: number): number;
  /** Picks one element from a non-empty array. */
  pick<T>(items: readonly T[]): T;
  /** True with probability `p` (0..1). */
  chance(p: number): boolean;
}

/** Derives one child PRNG seed from a parent seed and an integer label. */
export function deriveSeed(parentSeed: number, label: number): number;

/** Parses a `--seed` CLI value into [0, 2^32-1]; defaults when absent. */
export function parseSeed(raw: string | undefined): number;
