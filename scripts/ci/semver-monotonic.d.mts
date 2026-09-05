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

/** Compares two dev-channel versions (stable `X.Y.Z`, legacy `X.Y.Z-dev.N`, or new `X.Y.Z-dev`). Triple first; `-dev` is below same-triple stable. */
export function compareDevChannelVersions(
  left: unknown,
  right: unknown,
): ComparisonResult;

/** True when `target` does not move the dev channel behind `current`. */
export function isMonotonicDevChannelUpdate(
  current: unknown,
  target: unknown,
): MonotonicResult;

/** Resolves a `develop-vX.Y.Z-dev` tag to its prerelease version; rejects legacy `-dev.N` and plain tags. */
export function resolveDevelopTag(tag: unknown): TagResolutionResult;

/**
 * Computes the next `X.Y.(Z+k)-dev` version from the published `latest` triple
 * and the current `dev` dist-tag value. Accepts positional `(latest,
 * currentDev)` or object `{ latest, currentDev }` input.
 */
export function computeNextDevVersion(
  latestOrInput: unknown,
  currentDev?: unknown,
): TagResolutionResult;

/**
 * CLI entry point; returns the process exit code.
 * `--monotonic` exits 0 forward/equal, 1 backward, 3 invalid input, 2 usage.
 */
export function main(argv?: readonly string[]): Promise<number>;