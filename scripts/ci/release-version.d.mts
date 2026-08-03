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

/** CLI entry point; returns the process exit code. */
export function main(argv?: readonly string[]): Promise<number>;
