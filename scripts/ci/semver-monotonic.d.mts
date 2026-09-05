/** Type declarations for the dev-channel semver helper used by CI and tests. */

export type ComparisonResult =
  | { status: "valid"; comparison: -1 | 0 | 1 }
  | { status: "invalid"; code: string; reason: string };

export type MonotonicResult =
  | { status: "valid"; monotonic: boolean }
  | { status: "invalid"; code: string; reason: string };

export type TagResolutionResult =
  | { status: "valid"; version: string }
  | { status: "invalid"; code: string; reason: string };

/** Compares two dev-channel versions (`X.Y.Z` or `X.Y.Z-dev.N`). */
export function compareDevChannelVersions(
  left: unknown,
  right: unknown,
): ComparisonResult;

/** True when `target` does not move the dev channel behind `current`. */
export function isMonotonicDevChannelUpdate(
  current: unknown,
  target: unknown,
): MonotonicResult;

/** Resolves a `develop-vX.Y.Z-dev.N` tag to its prerelease version. */
export function resolveDevelopTag(tag: unknown): TagResolutionResult;

/** Computes the next `X.Y.Z-dev.N` version for the dev channel. */
export function computeNextDevVersion(input: {
  baseVersion: unknown;
  currentDevTag: unknown;
}): TagResolutionResult;

/**
 * CLI entry point; returns the process exit code.
 * `--monotonic` exits 0 forward/equal, 1 backward, 3 invalid input, 2 usage.
 */
export function main(argv?: readonly string[]): Promise<number>;