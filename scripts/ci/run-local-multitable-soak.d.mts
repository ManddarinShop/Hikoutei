/**
 * Type declarations for `scripts/ci/run-local-multitable-soak.mjs`.
 *
 * The CLI entry exports `main` for the local cleanup-only test path and
 * re-exports the pure tab-name helpers used by cleanup tests.
 */

/** CLI entry point: parses argv, runs cleanup or the soak loop. */
export function main(): Promise<void>;

/** Expands entity names into their projection tab names. */
export function soakTabNames(entityNames: readonly string[]): string[];

/** Maps `--tables` table names back to entity names for cleanup. */
export function entityNamesForTables(tableNames: readonly string[]): string[];

/** Stable redacted description of one run failure for the CLI catch path. */
export function describeSoakFailure(error: unknown): string;

/**
 * Stable, non-sensitive code carried by a missing-live-env cleanup error.
 */
export const CLEANUP_LIVE_ENV_MISSING_CODE: string;

/**
 * Stable diagnostic for the cleanup-only live-env precondition. Returns a
 * stable, non-sensitive reason string (naming only the missing env vars) when
 * either `HIKOUTEI_SYNC_SPREADSHEET_URL` or `GOOGLE_APPLICATION_CREDENTIALS`
 * is missing/blank, or `null` when both are present.
 */
export function cleanupLiveEnvMissingReason(
  url: string | undefined,
  credentials: string | undefined,
): string | null;
