/**
 * Local long-term multi-table soak runner over the CURRENT repository build.
 *
 * Usage (build first):
 *   npm run build
 *   node scripts/ci/run-local-multitable-soak.mjs --duration-hours 6
 *
 * The runner imports `hikoutei` through the package self-reference, which
 * resolves to `./dist` — the freshly built local code. It never installs or
 * imports the npm release. Mutations flow exclusively through the public
 * `createTypedSheets()` / EntityManager surface.
 *
 * Modes:
 * - local preflight (default): no credentials needed; SQLite-only soak with
 *   oracle verification, probes/convergence skipped and recorded as such.
 * - direct live: set `HIKOUTEI_SYNC_SPREADSHEET_URL` and
 *   `GOOGLE_APPLICATION_CREDENTIALS`; the internal sync service starts with
 *   the runtime and every cycle additionally verifies eventual Sheets
 *   convergence and the duplicate/lost/silent-overwrite invariants.
 *
 * Options: --duration-hours (0<h<=24, default 24), --interval-seconds
 * (default 300), --actors (default 4), --operations-per-actor (default 20),
 * --tables (comma-separated subset), --seed, --max-consecutive-failures
 * (default 5), --log-file, --resume, --cleanup-only, --output-dir.
 *
 * Progress goes to stderr; the redacted summary JSON goes to stdout. No
 * secrets, spreadsheet IDs/URLs, entity values, or raw provider payloads
 * are ever printed or written to artifacts, and the top-level failure
 * line prints only the error class plus a stable code/status class.
 */

import { parseSoakArgs } from "./local-soak/args.mjs";
import { parseSpreadsheetIdFromUrl, runLocalMultiTableSoak } from "./local-soak/runner.mjs";
import { SOAK_ENTITY_ORDER } from "./local-soak/entities.mjs";
import {
  sanitizeErrorClass,
  sanitizeStableCode,
  sanitizeStatusClass,
} from "./local-soak/redact.mjs";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

/** CLI entry point: parses argv, runs cleanup or the soak loop. */
export async function main() {
  let options;
  try {
    options = parseSoakArgs(process.argv.slice(2));
  } catch (error) {
    // Argument parsing runs before any runtime, credential, or provider
    // exists; its messages are static harness text that never carries
    // environment, credential, or remote payload data.
    process.stderr.write(
      `soak runner arguments invalid: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  if (options.cleanupOnly) {
    await runCleanupOnly(options);
    return;
  }

  const summary = await runLocalMultiTableSoak(options);
  if (summary.status !== "passed") {
    process.exitCode = 1;
  }
}

/** Deletes the sandbox projection tabs from the live sandbox spreadsheet. */
async function runCleanupOnly(options) {
  const url = process.env.HIKOUTEI_SYNC_SPREADSHEET_URL;
  const credentials = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const reason = cleanupLiveEnvMissingReason(url, credentials);
  if (reason !== null) {
    // Missing live env is a HARD precondition failure, not a local success:
    // fail nonzero (and stable/redacted) so CI can never mistake "nothing to
    // clean locally" for a healthy run.
    const error = new Error(reason);
    error.code = CLEANUP_LIVE_ENV_MISSING_CODE;
    throw error;
  }
  const spreadsheetId = parseSpreadsheetIdFromUrl(url);
  if (spreadsheetId === undefined) {
    throw new Error("HIKOUTEI_SYNC_SPREADSHEET_URL could not be parsed for cleanup");
  }
  const { createDirectSheetsClient } = await import("./local-soak/sheetsDirect.mjs");
  const client = createDirectSheetsClient();
  const tabNames = options.resolvedTables === undefined
    ? soakTabNames(SOAK_ENTITY_ORDER.map((entry) => entry.name))
    : soakTabNames(entityNamesForTables(options.resolvedTables));
  // Only a FULL-table cleanup removes the shared receipt tab; a `--tables`
  // subset cleanup must leave it in place for the untouched tables.
  const { deleted } = await client.deleteTabs(spreadsheetId, tabNames, {
    includeReceiptTab: options.tables === undefined,
  });
  process.stdout.write(`cleanup removed ${deleted} sandbox tabs\n`);
}

/**
 * Stable, non-sensitive code carried by a missing-live-env cleanup error.
 *
 * Chosen as a fixed literal (not derived from env values) so the failure is
 * reproducible and never leaks environment, credential, or remote payload
 * data. It is not a Hikoutei error code and therefore collapses to the error
 * class name in CLI diagnostics, which is the intended redacted behavior.
 */
export const CLEANUP_LIVE_ENV_MISSING_CODE = "soak-cleanup-live-env-missing";

/**
 * Stable diagnostic for the cleanup-only live-env precondition.
 *
 * Returns a stable, non-sensitive reason string when either required live
 * sandbox environment variable is missing or blank, or `null` when both are
 * present. Only the variable NAMES are mentioned — never their values — so
 * a missing-credential failure produces no sensitive output. Keep the
 * returned text free of any credential/secret content.
 *
 * @param {string | undefined} url `HIKOUTEI_SYNC_SPREADSHEET_URL` value.
 * @param {string | undefined} credentials `GOOGLE_APPLICATION_CREDENTIALS` value.
 * @returns {string | null} stable reason, or `null` when both env vars are set.
 */
export function cleanupLiveEnvMissingReason(url, credentials) {
  const missing = [];
  if (url === undefined || url.trim() === "") missing.push("HIKOUTEI_SYNC_SPREADSHEET_URL");
  if (credentials === undefined || credentials.trim() === "") missing.push("GOOGLE_APPLICATION_CREDENTIALS");
  if (missing.length === 0) return null;
  return `cleanup-only needs the live sandbox env (${missing.join(" and ")})`;
}

/** Expands entity names into their projection tab names. */
export function soakTabNames(entityNames) {
  const tabs = [];
  for (const entityName of entityNames) {
    tabs.push(`${entityName}_System`, `${entityName}_Input`, `${entityName}_Conflicts`);
  }
  return tabs;
}

/** Maps --tables table names back to entity names for cleanup. */
export function entityNamesForTables(tableNames) {
  return SOAK_ENTITY_ORDER
    .filter((entry) => tableNames.includes(entry.tableName))
    .map((entry) => entry.name);
}

/**
 * Stable redacted description of one run failure for the CLI catch path.
 *
 * Only the ALLOWLISTED error class plus, when present, the ALLOWLISTED
 * HikouteiError code or the DirectSheetsError status class are printed.
 * Unknown classes, codes, and status classes collapse to `unknown`; the
 * raw message, stack, provider payload, spreadsheet ID, and credential
 * path never reach the console.
 */
export function describeSoakFailure(error) {
  const name = error !== null && typeof error === "object" &&
    typeof error?.name === "string" && error.name.length > 0
    ? sanitizeErrorClass(error.name)
    : "unknown";
  const code = error !== null && typeof error === "object" &&
    typeof error?.code === "string"
    ? sanitizeStableCode(error.code)
    : undefined;
  const statusClass = error !== null && typeof error === "object" &&
    typeof error?.statusClass === "string"
    ? sanitizeStatusClass(error.statusClass)
    : undefined;
  // Prefer a known non-unknown code; otherwise a known non-unknown status
  // class; otherwise the class name only. A sanitized `unknown` code must
  // never shadow a valid status class.
  const stable =
    code !== undefined && code !== "unknown" ? code
    : statusClass !== undefined && statusClass !== "unknown" ? statusClass
    : undefined;
  return stable === undefined
    ? name
    : `${name} (${stable})`;
}

/** True when this module is the executed script (not imported by a test). */
function isDirectExecution() {
  if (process.argv[1] === undefined) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  main().catch((error) => {
    process.stderr.write(`soak runner failed: ${describeSoakFailure(error)}\n`);
    process.exitCode = 1;
  });
}
