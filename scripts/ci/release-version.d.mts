/** Type declarations for the release version helper used by CI and tests. */

export type ReleaseBump = "patch" | "minor";

export type ReleaseVersionInput = {
  baseVersion: unknown;
  bump: unknown;
};

export type ReleaseVersionResult =
  | { status: "valid"; version: string }
  | { status: "invalid"; code: string; reason: string };

/** Computes the next numeric stable version for a branch release. */
export function computeReleaseVersion(input: ReleaseVersionInput): ReleaseVersionResult;

/**
 * Normalizes `X.Y.Z-dev.N` (or passes through `X.Y.Z`) to the numeric base a
 * stable release bumps; rejects any other prerelease/build metadata.
 */
export function normalizeStableBaseVersion(value: unknown): ReleaseVersionResult;

export type StableVersionComparisonResult =
  | { status: "valid"; comparison: -1 | 0 | 1 }
  | { status: "invalid"; code: string; reason: string };

/** Compares two numeric stable versions for monotonic channel publication. */
export function compareStableVersions(
  left: unknown,
  right: unknown,
): StableVersionComparisonResult;

/** CLI entry point; returns the process exit code. */
export function main(argv?: readonly string[]): Promise<number>;
