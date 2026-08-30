/**
 * Read-only observability over the local SQLite authority for first-party
 * * tooling (the `spreadsheet-db-mcp` server)..
 *
 * This module is deliberately NOT part of the public application contract:
 * it is exposed only through the unstable `hikoutei/internal/sync-status`
 * subpath so the MCP layer can report outbox delivery state and unresolved
 * conflicts without widening `src/index.ts`. It opens its own read-only
 * `node:sqlite` connection and never mutates the database, so it coexists
 * with a running sync worker (the WAL lets multiple readers share the file).
 *
 * Failure model: malformed arguments raise a structured
 * {@link HikouteiSyncStatusError}; a database file that does not exist yet or
 * a database without sync tables (local-only mode) is not an error — it maps
 * to `{ mode: "local" }` and an empty conflict list respectively.
 */

import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { EFFECT_STATUSES } from "@hikoutei/ikisaki";
import { CONFLICT_STATUSES } from "@hikoutei/contracts/domain/model/constants.js";
import { isNormalizedCell } from "@hikoutei/contracts/encoding/index.js";

/** Stable machine-readable codes raised by the internal status reader. */
export const HIKOUTEI_SYNC_STATUS_ERROR_CODES = {
  /** The dbName argument is not a non-empty string. */
  INVALID_DB_NAME: "invalid_db_name",
  /** The SQLite file exists but could not be opened read-only. */
  OPEN_FAILED: "open_failed",
  /** A status query failed against an unexpected storage state. */
  READ_FAILED: "read_failed",
} as const;

/** Closed set of internal status-reader error codes. */
export type HikouteiSyncStatusErrorCode =
  (typeof HIKOUTEI_SYNC_STATUS_ERROR_CODES)[keyof typeof HIKOUTEI_SYNC_STATUS_ERROR_CODES];

/** Structured error raised by this module; never part of the public API. */
export class HikouteiSyncStatusError extends Error {
  readonly code: HikouteiSyncStatusErrorCode;

  constructor(code: HikouteiSyncStatusErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "HikouteiSyncStatusError";
    this.code = code;
    if (cause !== undefined) {
      // `Error.cause` (ES2022) carries the underlying storage failure for
      // diagnostics; optional parameter properties cannot use `override`.
      this.cause = cause;
    }
  }
}

/** Plain scalar value extracted from a stored normalized cell. */
export type HikouteiStoredValue = string | number | boolean | null;

/** Unresolved conflict lifecycle states surfaced by `listHikouteiConflicts`. */
export type HikouteiOpenConflictStatus =
  | (typeof CONFLICT_STATUSES)["OPEN"]
  | (typeof CONFLICT_STATUSES)["NEEDS_REBASE"];

/** Delivery-focused counts over the durable Sheet effect outbox. */
export interface HikouteiSyncEffectCounts {
  readonly pending: number;
  readonly processing: number;
  readonly deliveryUncertain: number;
  readonly failed: number;
}

/** Unresolved conflict counts. */
export interface HikouteiSyncConflictCounts {
  readonly open: number;
  readonly needsRebase: number;
}

/**
 * Sync observability snapshot.
 *
 * - `{ mode: "local" }`: no sync tables exist (local-only runtime, or the
 *   database file has not been created yet).
 * - `{ mode: "sync" }`: sync state exists; `spreadsheetId` is the bound
 *   spreadsheet's ID (full URLs are never returned) or `null` when the
 *   authority row has not been written yet.
 */
export type HikouteiSyncStatus =
  | { readonly mode: "local" }
  | {
      readonly mode: "sync";
      readonly spreadsheetId: string | null;
      readonly effects: HikouteiSyncEffectCounts;
      readonly conflicts: HikouteiSyncConflictCounts;
    };

/** One unresolved human-edit conflict, values decoded to plain scalars. */
export interface HikouteiConflictSummary {
  readonly conflictId: string;
  readonly entityId: string;
  readonly fieldName: string;
  readonly userValue: HikouteiStoredValue;
  readonly currentCanonicalValue: HikouteiStoredValue;
  readonly userBaseRevision: number;
  readonly currentCanonicalRevision: number;
  readonly candidateEpoch: number;
  readonly status: HikouteiOpenConflictStatus;
  readonly updatedAt: number;
}

/** Options accepted by the read-only status queries. */
export interface HikouteiSyncStatusOptions {
  /** SQLite database file path used by the runtime. */
  readonly dbName: string;
}

/** Options accepted by `listHikouteiConflicts`. */
export interface HikouteiConflictListOptions extends HikouteiSyncStatusOptions {
  /** Maximum number of conflicts to return; default 50, capped at 500. */
  readonly limit?: number;
}

/** Default conflict page size when `limit` is omitted. */
export const DEFAULT_CONFLICT_LIST_LIMIT = 50;

/** Hard upper bound for one conflict page; protects caller context windows. */
export const MAX_CONFLICT_LIST_LIMIT = 500;

/**
 * Reads a delivery/conflict snapshot from the SQLite authority.
 *
 * Returns `{ mode: "local" }` when the database file does not exist yet or
 * was created by a local-only runtime (no sync tables). Never writes, never
 * opens the network, and never returns spreadsheet URLs — only the ID.
 */
export async function readHikouteiSyncStatus(
  options: HikouteiSyncStatusOptions,
): Promise<HikouteiSyncStatus> {
  const dbName = requireValidDbName(options);
  if (!existsSync(dbName)) {
    return { mode: "local" };
  }
  return withReadOnlyConnection(dbName, (database) => {
    if (!syncTablesExist(database)) return { mode: "local" } as const;
    return {
      mode: "sync" as const,
      spreadsheetId: readSpreadsheetId(database),
      effects: readEffectCounts(database),
      conflicts: readConflictCounts(database),
    };
  });
}

/**
 * Lists unresolved (OPEN / NEEDS_REBASE) conflicts, newest first.
 *
 * Stored cell values are decoded from normalized cells into plain scalars;
 * a value that fails decoding falls back to its raw stored text so a corrupt
 * row can still be inspected instead of failing the whole listing. Returns
 * an empty list for local-only databases.
 */
export async function listHikouteiConflicts(
  options: HikouteiConflictListOptions,
): Promise<readonly HikouteiConflictSummary[]> {
  const dbName = requireValidDbName(options);
  // Input validation runs before the existence check so malformed arguments
  // always reject, independent of database state.
  const limit = resolveLimit(options.limit);
  if (!existsSync(dbName)) {
    return [];
  }
  return withReadOnlyConnection(dbName, (database) => {
    if (!tableExists(database, "sync_conflict")) return [];
    const rows = database
      .prepare(
        `SELECT conflict_id, entity_id, field_name, user_value, current_canonical_value,
                user_base_revision, current_canonical_revision, candidate_epoch, status, updated_at
           FROM sync_conflict
          WHERE status IN (?, ?)
          ORDER BY updated_at DESC
          LIMIT ?`,
      )
      .all(
        CONFLICT_STATUSES.OPEN,
        CONFLICT_STATUSES.NEEDS_REBASE,
        limit,
      ) as ReadonlyArray<Record<string, unknown>>;
    return rows.map(toConflictSummary);
  });
}

/** Validates the options object and returns the non-empty dbName. */
function requireValidDbName(
  options: HikouteiSyncStatusOptions,
): string {
  if (options === null || typeof options !== "object") {
    throw new HikouteiSyncStatusError(
      HIKOUTEI_SYNC_STATUS_ERROR_CODES.INVALID_DB_NAME,
      "sync-status options must be an object with a dbName string.",
    );
  }
  const dbName = options.dbName;
  if (typeof dbName !== "string" || dbName.trim() === "") {
    throw new HikouteiSyncStatusError(
      HIKOUTEI_SYNC_STATUS_ERROR_CODES.INVALID_DB_NAME,
      "sync-status dbName must be a non-empty string.",
    );
  }
  return dbName;
}

/** Clamps and validates the conflict page size. */
function resolveLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_CONFLICT_LIST_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new HikouteiSyncStatusError(
      HIKOUTEI_SYNC_STATUS_ERROR_CODES.READ_FAILED,
      "sync-status limit must be a positive integer.",
    );
  }
  return Math.min(limit, MAX_CONFLICT_LIST_LIMIT);
}

/** Typed view of the `node:sqlite` built-in used by this module. */
type NodeSqliteModule = {
  readonly DatabaseSync: new (
    location: string,
    options?: { readonly readOnly?: boolean },
  ) => DatabaseSync;
};

/**
 * Loads the `node:sqlite` built-in without a module specifier.
 *
 * `process.getBuiltinModule` (Node 22.3+) keeps bundlers and test runners
 * from trying to resolve `node:sqlite` as a package; the same approach is
 * used by MikroORM's NodeSqliteDialect. Returns null when the runtime
 * lacks the built-in.
 */
function loadNodeSqlite(): NodeSqliteModule | null {
  const candidate = (process as {
    getBuiltinModule?: (id: string) => unknown;
  }).getBuiltinModule;
  if (typeof candidate !== "function") return null;
  const module = candidate.call(process, "node:sqlite") as NodeSqliteModule | undefined;
  return module ?? null;
}

/**
 * Opens a read-only connection, runs the callback, and always closes it.
 *
 * A second connection to the same file is safe because it never writes;
 * open failures are classified as `open_failed` instead of surfacing the
 * raw node:sqlite error.
 */
function withReadOnlyConnection<Result>(
  dbName: string,
  read: (database: DatabaseSync) => Result,
): Result {
  const nodeSqlite = loadNodeSqlite();
  if (nodeSqlite === null) {
    throw new HikouteiSyncStatusError(
      HIKOUTEI_SYNC_STATUS_ERROR_CODES.OPEN_FAILED,
      "this Node runtime does not provide the node:sqlite built-in (Node 22.5+ required)",
    );
  }
  let database: DatabaseSync;
  try {
    database = new nodeSqlite.DatabaseSync(dbName, { readOnly: true });
  } catch (error: unknown) {
    throw new HikouteiSyncStatusError(
      HIKOUTEI_SYNC_STATUS_ERROR_CODES.OPEN_FAILED,
      `could not open ${dbName} read-only: ${messageOf(error)}`,
      error,
    );
  }
  try {
    return read(database);
  } catch (error: unknown) {
    if (error instanceof HikouteiSyncStatusError) throw error;
    throw new HikouteiSyncStatusError(
      HIKOUTEI_SYNC_STATUS_ERROR_CODES.READ_FAILED,
      `status query failed on ${dbName}: ${messageOf(error)}`,
      error,
    );
  } finally {
    database.close();
  }
}

/** True when the durable sync tables are present in this database. */
function syncTablesExist(database: DatabaseSync): boolean {
  return tableExists(database, "sheet_effect_outbox");
}

/** Checks sqlite_master for one table name. */
function tableExists(database: DatabaseSync, tableName: string): boolean {
  const row = database
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { present: number } | undefined;
  return row !== undefined;
}

/** Reads the bound spreadsheet ID, or null when no registry row exists yet. */
function readSpreadsheetId(database: DatabaseSync): string | null {
  // Provisioning registers physical sheets eagerly, so the registry knows
  // the bound spreadsheet even before the writer claims an authority row.
  const registryRow = database
    .prepare("SELECT spreadsheet_id FROM physical_sheet_registry LIMIT 1")
    .get() as { spreadsheet_id: string } | undefined;
  if (registryRow !== undefined) return registryRow.spreadsheet_id;
  const authorityRow = database
    .prepare("SELECT spreadsheet_id FROM spreadsheet_authority LIMIT 1")
    .get() as { spreadsheet_id: string } | undefined;
  return authorityRow === undefined ? null : authorityRow.spreadsheet_id;
}

/**
 * Validates one raw `{ status, count }` aggregate row, or throws a
 * structured read failure.
 *
 * SQLite `COUNT(*)` always yields a non-negative integer, so any other
 * shape means the storage schema has drifted and the counts cannot be
 * trusted; failing the whole read is safer than reporting false zeros.
 */
function requireStatusCountRow(row: unknown): { readonly status: string; readonly count: number } {
  if (typeof row !== "object" || row === null) {
    throw malformedStatusCountRow(row);
  }
  const { status, count } = row as Record<string, unknown>;
  if (
    typeof status !== "string" ||
    typeof count !== "number" ||
    !Number.isInteger(count) ||
    count < 0
  ) {
    throw malformedStatusCountRow(row);
  }
  return { status, count };
}

/** Builds the structured read failure for one malformed aggregate row. */
function malformedStatusCountRow(row: unknown): HikouteiSyncStatusError {
  return new HikouteiSyncStatusError(
    HIKOUTEI_SYNC_STATUS_ERROR_CODES.READ_FAILED,
    `status query returned a malformed aggregate row: ${JSON.stringify(row)}`,
  );
}

/** Counts outbox effects by the delivery-relevant statuses. */
function readEffectCounts(database: DatabaseSync): HikouteiSyncEffectCounts {
  const rows = database
    .prepare("SELECT status, COUNT(*) AS count FROM sheet_effect_outbox GROUP BY status")
    .all();
  const byStatus = new Map(
    rows.map((row) => {
      const validated = requireStatusCountRow(row);
      return [validated.status, validated.count] as const;
    }),
  );
  return {
    pending: byStatus.get(EFFECT_STATUSES.PENDING) ?? 0,
    processing: byStatus.get(EFFECT_STATUSES.PROCESSING) ?? 0,
    deliveryUncertain: byStatus.get(EFFECT_STATUSES.DELIVERY_UNCERTAIN) ?? 0,
    failed: byStatus.get(EFFECT_STATUSES.FAILED) ?? 0,
  };
}

/** Counts unresolved conflicts by status. */
function readConflictCounts(database: DatabaseSync): HikouteiSyncConflictCounts {
  const rows = database
    .prepare(
      "SELECT status, COUNT(*) AS count FROM sync_conflict WHERE status IN (?, ?) GROUP BY status",
    )
    .all(CONFLICT_STATUSES.OPEN, CONFLICT_STATUSES.NEEDS_REBASE);
  const byStatus = new Map(
    rows.map((row) => {
      const validated = requireStatusCountRow(row);
      return [validated.status, validated.count] as const;
    }),
  );
  return {
    open: byStatus.get(CONFLICT_STATUSES.OPEN) ?? 0,
    needsRebase: byStatus.get(CONFLICT_STATUSES.NEEDS_REBASE) ?? 0,
  };
}

/** Maps one raw conflict row to the summary contract, decoding stored cells. */
function toConflictSummary(row: Record<string, unknown>): HikouteiConflictSummary {
  const status = row.status === CONFLICT_STATUSES.NEEDS_REBASE
    ? CONFLICT_STATUSES.NEEDS_REBASE
    : CONFLICT_STATUSES.OPEN;
  return {
    conflictId: String(row.conflict_id),
    entityId: String(row.entity_id),
    fieldName: String(row.field_name),
    userValue: decodeStoredValue(row.user_value),
    currentCanonicalValue: decodeStoredValue(row.current_canonical_value),
    userBaseRevision: Number(row.user_base_revision),
    currentCanonicalRevision: Number(row.current_canonical_revision),
    candidateEpoch: Number(row.candidate_epoch),
    status,
    updatedAt: Number(row.updated_at),
  };
}

/**
 * Decodes one stored normalized-cell JSON value into a plain scalar.
 *
 * Falls back to the raw stored text when the payload is not valid JSON or
 * not a normalized cell, so a partially corrupt row remains inspectable.
 */
function decodeStoredValue(raw: unknown): HikouteiStoredValue {
  if (raw === null || raw === undefined) return null;
  const text = String(raw);
  try {
    const parsed: unknown = JSON.parse(text);
    if (isNormalizedCell(parsed)) {
      return parsed === null ? null : parsed.value;
    }
  } catch {
    // fall through to the raw text
  }
  return text;
}

/** Best-effort human-readable message from an unknown error. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
