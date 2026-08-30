/**
 * Public existing-sheet adoption entrypoint.
 *
 * Wraps the internal sync auto-start bridge (`createTypedSheetsWithSync`) with
 * a lazy dynamic import so importing this module never loads the sync module
 * graph (MikroORM, Google SDK) — the same principle `createTypedSheets()`
 * follows for its env-absent path.
 *
 * PUBLIC TYPE RULE: every type exported here is declared STRUCTURALLY in this
 * module. The public-surface audit (test/hikoutei-public-surface-audit.test.ts)
 * walks the emitted declaration graph from the root entrypoint and forbids any
 * reach into engine/SDK packages; re-exporting internal sync types would pull
 * the Google transport and MikroORM declarations into that graph. The mirrors
 * are ASSIGNABILITY-PINNED at the wrapper boundary — the wrapper's return
 * type forces the internal result/report to remain assignable to these public
 * types, so a BREAKING internal change fails typecheck; purely ADDITIVE
 * internal fields flow through at runtime while the mirror lags by design.
 *
 * Adoption: one or more entities per service (each with an empty local
 * SQLite state), and each adopted tab must satisfy the contiguous-block
 * constraints of
 * `design/existing-sheet-adoption-design.md` (D1–D7). `mode: "dry-run"`
 * performs ZERO mutations and returns `{ kind: "adopt-dry-run", report }`;
 * `mode: "adopt"` binds + seeds every existing row fail-closed before the
 * sync supervisors start.
 */

import type { Hikoutei } from "./Hikoutei.js";
import type { HikouteiEntity } from "./entity.js";

/** One entity's existing-sheet adoption request (design D1/D4). */
export interface AdoptEntitySpec {
  /** The existing tab that becomes this entity's User_Input route (D1). */
  readonly tabName: string;
  /**
   * Sheet header that carries the business key. `"auto"` (or absent) prefers
   * the column matching the entity's primary-key property and falls back to
   * appending a generated PK column (D4). MVP: an alias whose header differs
   * from the PK property name is blocked (IDENTITY_ALIAS_UNSUPPORTED).
   */
  readonly identityFrom?: string | "auto";
  /**
   * Tab name for the freshly provisioned System_State projection. Defaults to
   * `<tabName>_System`.
   */
  readonly systemStateTabName?: string;
  /**
   * Tab name for the freshly provisioned Sync_Conflicts projection. Defaults
   * to `<tabName>_Conflicts`.
   */
  readonly syncConflictsTabName?: string;
  /**
   * §12: explicit header → property bindings for sheets whose headers differ
   * from the property names (adoption-only). Mapped headers take precedence
   * over name matching; a mapped PK header absorbs the identityFrom alias.
   */
  readonly columnMap?: Readonly<Record<string, string>>;
}

/** Public existing-sheet adoption spec (design §4.1). */
export interface AdoptSpec {
  readonly mode: "dry-run" | "adopt";
  readonly entities: Readonly<Record<string, AdoptEntitySpec>>;
}

/** One bound column: entity property → sheet column (read-only report). */
export interface AdoptionColumnBinding {
  readonly field: string;
  /** 0-based column index in the sheet. */
  readonly columnIndex: number;
  readonly columnLetter: string;
  readonly header: string;
}

/** One problem surfaced by the dry-run analysis. */
export interface AdoptionProblem {
  readonly severity: "error" | "warning";
  readonly code: string;
  readonly message: string;
  readonly detail?: Readonly<Record<string, string | number | readonly string[] | readonly number[]>>;
}

/** Per-entity adoption dry-run report (design §4.2). */
export interface AdoptionEntityReport {
  readonly entityName: string;
  readonly tabName: string;
  /** `"ready"` = adoption may proceed; `"blocked"` = at least one error. */
  readonly status: "ready" | "blocked";
  readonly sheetHeaders: readonly string[];
  readonly totalRows: number;
  readonly emptyRows: number;
  readonly bindings: readonly AdoptionColumnBinding[];
  readonly ignoredColumns: readonly { readonly columnLetter: string; readonly header: string }[];
  readonly missingFields: readonly string[];
  readonly contiguity: "contiguous" | "segmented";
  readonly segments: readonly { readonly startColumnIndex: number; readonly endColumnIndex: number }[];
  readonly pk: {
    readonly source: "existing-column" | "auto-generate";
    readonly column?: string;
    readonly generatedCount?: number;
    readonly duplicates?: readonly { readonly value: string; readonly rowNumbers: readonly number[] }[];
  };
  readonly columnsToBeAdded: readonly string[];
  readonly tabsToProvision: readonly string[];
  readonly problems: readonly AdoptionProblem[];
}

/** Complete dry-run report; `ok` is true only when every entity is ready. */
export interface AdoptionRunReport {
  readonly mode: "dry-run";
  readonly ok: boolean;
  readonly entities: readonly AdoptionEntityReport[];
}

/** Local-only result: no sync service was started (env absent or blank). */
export interface LocalSyncRuntimeResult {
  readonly kind: "local";
  readonly hikoutei: Hikoutei;
}

/** Sync result: the running sync service's public runtime handle. */
export interface RunningSyncServiceResult {
  readonly kind: "sync";
  readonly hikoutei: Hikoutei;
}

/**
 * Adoption dry-run result: the read-only report was produced and the
 * spreadsheet was NOT mutated; no sync service was started.
 */
export interface AdoptDryRunResult {
  readonly kind: "adopt-dry-run";
  readonly report: AdoptionRunReport;
}

export type TypedSheetsWithSyncResult =
  | LocalSyncRuntimeResult
  | RunningSyncServiceResult
  | AdoptDryRunResult;

/**
 * Options for {@link createTypedSheetsWithSync}.
 *
 * `env` (default: `process.env`) drives sync auto-start via
 * `HIKOUTEI_SYNC_SPREADSHEET_URL` + `GOOGLE_APPLICATION_CREDENTIALS`; without
 * the URL the result is `{ kind: "local" }`. The stub-transport affordance
 * used by tests stays internal — production always builds the real ADC
 * transport.
 */
export interface CreateTypedSheetsWithSyncOptions {
  readonly dbName: string;
  readonly entities: readonly HikouteiEntity[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly onDiagnostic?: (level: "info" | "error", message: string) => void;
  readonly adopt?: AdoptSpec;
}

/**
 * Opens the runtime for the declared entities and starts the internal sync
 * service when the env is configured — with existing-sheet adoption support.
 *
 * This is the public counterpart of `createTypedSheets()` for applications
 * that need the richer result union (e.g. the adoption dry-run report) instead
 * of the bare runtime handle. See `scripts/live-smoke/` for a complete worked
 * example of every adoption stage against a real spreadsheet.
 */
export async function createTypedSheetsWithSync(
  options: CreateTypedSheetsWithSyncOptions,
): Promise<TypedSheetsWithSyncResult> {
  // Lazy import: the sync module graph loads only when sync actually starts.
  // P8-C: routed through the composition root (see packages/composition/src/index.ts).
  const { createTypedSheetsWithSync: bridge } = await import(
    "@hikoutei/composition/syncAutoStart.js"
  );
  const result = await bridge({
    dbName: options.dbName,
    entities: [...options.entities],
    // Contract (see CreateTypedSheetsWithSyncOptions): env defaults to
    // `process.env`, read at call time — exactly like `createTypedSheets()`
    // in Hikoutei.ts. Omitting the forward would starve the autostart bridge
    // (its internal default is `{}`) even when the host process env carries
    // HIKOUTEI_SYNC_SPREADSHEET_URL / GOOGLE_APPLICATION_CREDENTIALS.
    ...(options.env === undefined
      ? { env: process.env as Readonly<Record<string, string | undefined>> }
      : { env: options.env }),
    ...(options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }),
    ...(options.adopt === undefined ? {} : { adopt: options.adopt }),
  });
  // Drop the internal service handle from the public result: the runtime
  // handle is the application-facing contract.
  return result.kind === "sync" ? { kind: "sync", hikoutei: result.hikoutei } : result;
}