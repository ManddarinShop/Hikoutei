/**
 * Type declarations for `scripts/ci/local-soak/args.mjs`.
 *
 * Hand-written ESM helper consumed by the soak CLI and by Vitest; these
 * declarations give the TypeScript test suite full type checking without
 * adding `scripts/**` to a `tsconfig` `include` set.
 */

/** Documented maximum soak duration in hours. */
export const MAX_DURATION_HOURS: number;

/** Default option values matching the approved plan. */
export const DEFAULT_SOAK_OPTIONS: {
  readonly durationHours: number;
  readonly intervalSeconds: number;
  readonly actors: number;
  readonly operationsPerActor: number;
  readonly tables: string[] | undefined;
  readonly seed: string | undefined;
  readonly maxConsecutiveFailures: number;
  readonly logFile: string | undefined;
  readonly resume: boolean;
  readonly cleanupOnly: boolean;
  readonly outputDir: string | undefined;
};

/** All table names accepted by `--tables`. */
export const SOAK_TABLE_NAMES: readonly string[];

/** Resolved soak options after validation and default application. */
export interface SoakOptions {
  readonly durationHours: number;
  readonly intervalSeconds: number;
  readonly actors: number;
  readonly operationsPerActor: number;
  readonly tables: string[] | undefined;
  readonly seed: string | undefined;
  readonly maxConsecutiveFailures: number;
  readonly logFile: string | undefined;
  readonly resume: boolean;
  readonly cleanupOnly: boolean;
  readonly outputDir: string | undefined;
  readonly durationMs: number;
  readonly resolvedTables: readonly string[];
}

/** Parses and validates the soak CLI arguments. Throws on invalid input. */
export function parseSoakArgs(argv: readonly string[]): SoakOptions;

/** Validates cross-field constraints and applies derived defaults. */
export function finalizeOptions(
  options: Record<string, unknown>,
): SoakOptions;
