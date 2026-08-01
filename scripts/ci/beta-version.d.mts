/**
 * Type declarations for `scripts/ci/beta-version.mjs`.
 *
 * The helper is hand-written ESM (consistent with the other `scripts/ci/*.mjs`
 * tools) and is consumed by the beta-publish workflow and by Vitest. These
 * declarations give the TypeScript test suite full type checking without
 * adding `scripts/**` to a `tsconfig` `include` set.
 */

export type BetaVersionInput = {
  /** The package.json version, e.g. `0.3.0` or `0.3.0-beta.1`. */
  baseVersion: string;
  /** GitHub `${{ github.run_id }}`. */
  runId: string | number;
  /** GitHub `${{ github.run_attempt }}`. */
  runAttempt: string | number;
};

export type BetaVersionResult =
  | { status: "valid"; version: string }
  | { status: "invalid"; reason: string };

/** Pure beta-version calculator returning an explicit valid/invalid result. */
export function computeBetaVersion(input: BetaVersionInput): BetaVersionResult;

/** CLI entry point; returns the process exit code. */
export function main(argv?: readonly string[]): Promise<number>;
