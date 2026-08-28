/**
 * Testable orchestration for `hikoutei adopt`.
 *
 * The flow owns presentation and sequencing only: it renders the dry-run
 * report (human or `--json`), asks for confirmation in adopt mode unless
 * `--yes`, calls the INJECTABLE runner (the production runner wraps
 * `createTypedSheetsWithSync()`; tests inject a fake), and maps outcomes to
 * exit codes. It never imports the sync module graph itself.
 *
 * Exit codes: 0 success (a READY dry-run also succeeds), 1 failure (a BLOCKED
 * dry-run, sync-disabled env, or runner error), 2 argument errors (handled by
 * the parser, not here).
 */

import type { AdoptOptions } from "./adoptArgs.js";
import { confirmAdopt } from "./confirm.js";
import type { HikouteiEntity } from "../api/entity.js";
import type {
  AdoptSpec,
  AdoptionEntityReport,
  TypedSheetsWithSyncResult,
} from "../api/syncRuntime.js";

/** Machine-readable CLI error prefix, shared with adoptMain.ts. */
export const ADOPT_ERROR_PREFIX = "hikoutei-adopt";

/** What the flow asks the runner to execute. */
export interface AdoptRunnerInput {
  readonly spec: AdoptSpec;
  readonly dbName: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly entities: readonly HikouteiEntity[];
}

/** Injectable adoption execution; production wraps the public API factory. */
export type AdoptRunner = (input: AdoptRunnerInput) => Promise<TypedSheetsWithSyncResult>;

export interface RunAdoptCliInput {
  readonly options: AdoptOptions;
  readonly entities: readonly HikouteiEntity[];
  readonly runner: AdoptRunner;
  /** Line/chunk source; `process.stdin` in the real CLI. */
  readonly input: AsyncIterable<string>;
  readonly output: { readonly write: (text: string) => void };
  readonly error: { readonly write: (text: string) => void };
  /**
   * Releases the shared stdin stream so the CLI process can exit after the
   * flow settles. The single-chunk confirmation read leaves the shared async
   * iterator OPEN (`next()` without `return()`), which keeps a Node process
   * alive forever on an open stdin pipe — the exact bug class the setup CLI
   * fixed with its finalizer (see test/cli-setup.test.ts subprocess
   * regression). Production passes `createStdinFinalizer()`; tests may count
   * invocations instead.
   */
  readonly finalizeStdin?: () => void;
}

/** Exit code 0: success (a READY dry-run included). */
export const ADOPT_SUCCESS_EXIT_CODE = 0;
/** Exit code 1: runtime failure or a BLOCKED dry-run. */
export const ADOPT_RUNTIME_ERROR_EXIT_CODE = 1;

/**
 * Runs the adopt flow. Never throws: every failure becomes a non-zero exit
 * code with a machine-readable `hikoutei-adopt:<code>:` line on stderr.
 */
export async function runAdoptCli(input: RunAdoptCliInput): Promise<number> {
  try {
    return await runAdoptCliInner(input);
  } finally {
    // The single-chunk confirmation read leaves the shared stdin iterator
    // open; destroy the stream so the CLI process can exit (Terra S1).
    input.finalizeStdin?.();
  }
}

async function runAdoptCliInner(input: RunAdoptCliInput): Promise<number> {
  const { options } = input;

  // Adopt mode mutates the spreadsheet and the local database: confirm unless
  // --yes. The prompt and the cancellation line go to STDERR so `--json`
  // consumers always get a clean stdout payload (Terra S3).
  if (options.mode === "adopt" && !options.yes) {
    const confirmation = await confirmAdopt({
      yes: options.yes,
      input: input.input,
      output: input.error,
      summary: `adopt tab "${options.tabName}" as entity "${options.entityName}" into ${options.db}`,
    });
    if (confirmation.status === "declined") {
      // Exit 1, not 0: an automation run that forgot --yes must not read as
      // a successful (silently skipped) adoption (Terra S2).
      input.error.write("Adoption cancelled. Pass --yes to run without confirmation.\n");
      return ADOPT_RUNTIME_ERROR_EXIT_CODE;
    }
  }

  const spec: AdoptSpec = {
    mode: options.mode,
    entities: {
      [options.entityName]: {
        tabName: options.tabName,
        identityFrom: options.identityFrom,
        ...(options.systemTabName === undefined ? {} : { systemStateTabName: options.systemTabName }),
        ...(options.conflictsTabName === undefined ? {} : { syncConflictsTabName: options.conflictsTabName }),
      },
    },
  };

  let result: TypedSheetsWithSyncResult;
  try {
    result = await input.runner({
      spec,
      dbName: options.db,
      env: adoptEnv(input.options),
      entities: input.entities,
    });
  } catch (error: unknown) {
    return reportError(input, error);
  }

  if (result.kind === "adopt-dry-run") {
    const report = result.report;
    if (options.json) {
      input.output.write(`${JSON.stringify(report, null, 2)}\n`);
      return report.ok ? ADOPT_SUCCESS_EXIT_CODE : ADOPT_RUNTIME_ERROR_EXIT_CODE;
    }
    input.output.write(renderReport(report.entities[0]!, report.ok));
    return report.ok ? ADOPT_SUCCESS_EXIT_CODE : ADOPT_RUNTIME_ERROR_EXIT_CODE;
  }

  if (result.kind === "local") {
    input.error.write(
      `${ADOPT_ERROR_PREFIX}:sync_disabled: sync is not configured — set --spreadsheet-url or ` +
      `HIKOUTEI_SYNC_SPREADSHEET_URL (and the credentials file) to adopt a tab.\n`,
    );
    return ADOPT_RUNTIME_ERROR_EXIT_CODE;
  }

  // kind "sync": adoption completed and the sync service started. The runner
  // closes the runtime before returning, so print the summary and exit.
  if (options.json) {
    input.output.write(`${JSON.stringify({ ok: true, kind: "sync" }, null, 2)}\n`);
  } else {
    input.output.write(
      `Adoption complete: tab "${options.tabName}" is now entity "${options.entityName}"'s ` +
      `User_Input surface; the local state was seeded and the System_State projection ` +
      `will backfill automatically. Human edits on the tab are absorbed from now on.\n`,
    );
  }
  return ADOPT_SUCCESS_EXIT_CODE;
}

/** Maps a runner failure to the machine-readable CLI error line. */
function reportError(input: RunAdoptCliInput, error: unknown): number {
  const code = typeof (error as { code?: unknown })?.code === "string"
    ? (error as { code: string }).code
    : "unexpected";
  const message = error instanceof Error ? error.message : String(error);
  input.error.write(`${ADOPT_ERROR_PREFIX}:${code}: ${message}\n`);
  return ADOPT_RUNTIME_ERROR_EXIT_CODE;
}

/** Builds the env the runner passes to the sync factory (explicit overrides win). */
function adoptEnv(options: AdoptOptions): Record<string, string | undefined> {
  return {
    ...process.env,
    ...(options.spreadsheetUrl === undefined ? {} : { HIKOUTEI_SYNC_SPREADSHEET_URL: options.spreadsheetUrl }),
    ...(options.credentialsPath === undefined ? {} : { GOOGLE_APPLICATION_CREDENTIALS: options.credentialsPath }),
  };
}

/** Renders one entity's dry-run report as aligned human-readable text. */
export function renderAdoptionReport(entity: AdoptionEntityReport, ok: boolean): string {
  const lines: string[] = [];
  lines.push(`Adoption dry-run — entity "${entity.entityName}", tab "${entity.tabName}": ${ok ? "READY" : "BLOCKED"}`);
  lines.push("");
  lines.push(`  Bindings:    ${entity.bindings.map((b) => `${b.field} → ${b.columnLetter}`).join(", ") || "(none)"}`);
  lines.push(`  Ignored:     ${entity.ignoredColumns.map((c) => `${c.columnLetter} (${c.header})`).join(", ") || "(none)"}`);
  lines.push(`  Contiguity:  ${entity.contiguity}${entity.segments.length > 0 ? ` [${entity.segments.map((s) => `${s.startColumnIndex}-${s.endColumnIndex}`).join(", ")}]` : ""}`);
  lines.push(`  PK:          ${entity.pk.source === "existing-column" ? `existing column "${entity.pk.column ?? ""}"` : "auto-generate (appended)"}`);
  lines.push(`  Rows:        ${entity.totalRows} data, ${entity.emptyRows} empty`);
  lines.push(`  To add:      ${entity.columnsToBeAdded.join(", ") || "(none)"}`);
  lines.push(`  New tabs:    ${entity.tabsToProvision.join(", ") || "(none)"}`);
  if (entity.missingFields.length > 0) {
    lines.push(`  Missing:     ${entity.missingFields.join(", ")}`);
  }
  lines.push("");
  if (entity.problems.length === 0) {
    lines.push("  Problems:    (none)");
  } else {
    lines.push("  Problems:");
    for (const problem of entity.problems) {
      lines.push(`    [${problem.severity}] ${problem.code}: ${problem.message}`);
    }
  }
  if (ok) {
    lines.push("");
    lines.push("  Ready. Re-run with --mode adopt --entities <module> to perform the adoption.");
  }
  lines.push("");
  return lines.join("\n");
}

/** Thin wrapper kept for tests that want the renderer without the flow. */
function renderReport(entity: AdoptionEntityReport, ok: boolean): string {
  return renderAdoptionReport(entity, ok);
}