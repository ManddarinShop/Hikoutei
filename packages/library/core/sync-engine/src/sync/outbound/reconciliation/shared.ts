/**
 * Shared contracts and helpers for the reconciliation scanner modules.
 *
 * The drift detector (diff.ts), the correction builder (repair.ts), and the
 * scan orchestrator (ReconciliationScanner.ts) all operate on the durable
 * desired state, the visible state, and the outbox. This module owns those
 * shared types, the SQL statements that read them, and the small helpers that
 * decode canonical rows into the internal desired-row shape, so the role
 * modules can import from one place without importing each other.
 */

import { stableHash } from "@hikoutei/contracts/encoding/stableEncode.js";
import {
  isRecoverableEffectErrorCode,
} from "@hikoutei/ikisaki";
import type { NormalizedCell } from "@hikoutei/contracts/encoding/types.js";
import { NORMALIZED_CELL_KINDS } from "@hikoutei/contracts/encoding/constants.js";
import { isNormalizedCell } from "@hikoutei/contracts/encoding/normalizedCell.js";
import { STORAGE_ERROR_CODES, StorageError } from "@hikoutei/storage/storage/errors.js";
import {
  READ_DESIRED_SYSTEM_STATE_SQL,
  RECONCILIATION_SCAN_CHUNK_SIZE,
  RECONCILIATION_SCAN_ENTITY_PAGE_SIZE,
  readActiveEntityPageWithSql,
  readEntityBindingsWithSql,
  readEntityFieldsWithSql,
  readReconciliationDesiredSystemStateChunkWithSql,
  readReconciliationDesiredSystemStateWithSql as readFlatDesiredSystemStateWithSql,
  type ReconciliationDesiredChunkCursor,
  type ReconciliationDesiredEntityChunk,
  type ReconciliationDesiredSystemStateRow,
} from "@hikoutei/storage/storage/sync/outbound/reconciliationSql.js";
import type { SqlExecutor, SqlStorageAdapter } from "@hikoutei/contracts/storage/sql.js";
import type { SyncSheetsProvider } from "@hikoutei/contracts/sheets/syncSheets.js";

// The desired-state query lives in storage; this module re-exports the
// shared pieces so scanner role modules keep importing from one place.
export {
  READ_DESIRED_SYSTEM_STATE_SQL,
  RECONCILIATION_SCAN_CHUNK_SIZE,
  RECONCILIATION_SCAN_ENTITY_PAGE_SIZE,
  readActiveEntityPageWithSql,
  readEntityBindingsWithSql,
  readEntityFieldsWithSql,
  readReconciliationDesiredSystemStateChunkWithSql,
};
export type {
  ReconciliationDesiredChunkCursor,
  ReconciliationDesiredEntityChunk,
  ReconciliationDesiredSystemStateRow,
};

export const DEFAULT_RECONCILIATION_ROLE = "typed-sheets-reconciler";
export const DEFAULT_RECONCILIATION_LEASE_MS = 60_000;
export const DEFAULT_SYSTEM_TOMBSTONE_FIELD = "_deleted";

/** Builder used by the scanner to produce fresh effect/commit identifiers. */
export type ReconciliationIdFactory = () => string;

export interface DesiredRow {
  readonly entityId: string;
  readonly rowBindingId: string;
  readonly anchorReference: string;
  readonly entityRevision: number;
  readonly fields: Record<string, NormalizedCell>;
  readonly fieldRevisionHash: string;
}



export interface LatestVisibleSqlShape {
  readonly confirmed_visible_revision: number | null;
  readonly confirmed_snapshot_hash: string | null;
}

export interface LatestEffectSqlShape {
  readonly effect_id: string;
  readonly stream_sequence: number | null;
  readonly expected_visible_revision: number | null;
  readonly expected_visible_hash: string | null;
  readonly status: string;
  readonly last_error_code: string | null;
  readonly payload_json: string | null;
}



export const READ_LATEST_VISIBLE_STATE_SQL = `
  SELECT confirmed_visible_revision, confirmed_snapshot_hash
  FROM sheet_visible_state
  WHERE physical_sheet_id = ? AND projection = 'system_state' AND row_binding_id = ?
`;

export const READ_LATEST_EFFECT_SQL = `
  SELECT effect_id, stream_sequence, expected_visible_revision, expected_visible_hash, status, last_error_code, payload_json
  FROM sheet_effect_outbox
  WHERE logical_sheet_id = ? AND target_kind = 'entity' AND target_id = ?
  ORDER BY stream_sequence DESC
  LIMIT 1
`;

/**
 * Reads the active `failed` effect for one target stream.
 *
 * At most one `failed` effect can be active per stream: a failed effect is
 * never in `('applied','superseded')`, so the durable predecessor guard blocks
 * every later effect until it is superseded. The caller decides whether the
 * code is terminal (non-recoverable) and must be superseded by a repair.
 */
export const READ_FAILED_HEAD_SQL = `
  SELECT effect_id, last_error_code
  FROM sheet_effect_outbox
  WHERE logical_sheet_id = ? AND target_kind = 'entity' AND target_id = ? AND status = 'failed'
  ORDER BY stream_sequence DESC
  LIMIT 1
`;

export interface FailedHeadSqlShape {
  readonly effect_id: string;
  readonly last_error_code: string | null;
}

/**
 * Reads every active `failed` effect of one logical sheet, newest stream
 * first, so the scanner can detect terminal heads on streams whose Sheet row
 * already matches canonical (drift-free rows never reach per-drift repair
 * planning).
 */
export const READ_FAILED_HEADS_SQL = `
  SELECT effect_id, target_id, last_error_code
  FROM sheet_effect_outbox
  WHERE logical_sheet_id = ? AND target_kind = 'entity' AND status = 'failed'
  ORDER BY stream_sequence DESC
`;

export interface FailedHeadsSqlShape {
  readonly effect_id: string;
  readonly target_id: string;
  readonly last_error_code: string | null;
}

/**
 * Returns the terminal (non-recoverable) failed head effect id per target
 * stream for one logical sheet.
 *
 * Recoverable failed heads stay on the worker retry path and are never
 * superseded by reconciliation, mirroring `readTerminalFailedHeadWithSql`.
 */
export async function readTerminalFailedHeads(
  context: ScanContext,
): Promise<ReadonlyMap<string, string>> {
  return context.storage.read(({ sql }) =>
    readTerminalFailedHeadsWithSql(sql, context.logicalSheetId),
  );
}

/**
 * Reads terminal failed heads inside the caller's SQL context so the chunked
 * scan can share one read with its pages instead of opening a second one.
 */
export async function readTerminalFailedHeadsWithSql(
  sql: SqlExecutor,
  logicalSheetId: string,
): Promise<ReadonlyMap<string, string>> {
  const rows = await sql.all<FailedHeadsSqlShape>(READ_FAILED_HEADS_SQL, [
    logicalSheetId,
  ]);
  const byTarget = new Map<string, string>();
  for (const row of rows) {
    if (isRecoverableEffectErrorCode(row.last_error_code)) continue;
    if (!byTarget.has(row.target_id)) byTarget.set(row.target_id, row.effect_id);
  }
  return byTarget;
}

export interface ScanContext {
  readonly storage: SqlStorageAdapter;
  readonly provider: SyncSheetsProvider;
  readonly physicalSheetId: string;
  readonly logicalSheetId: string;
  readonly systemFields: readonly string[];
  readonly tombstoneField: string | undefined;
  readonly schemaVersion: number;
  readonly writerId: string;
  readonly now: () => number;
  readonly createId: ReconciliationIdFactory;
  readonly role: string;
  readonly leaseDurationMs: number;
}

export async function readDesiredSystemState(context: ScanContext): Promise<readonly DesiredRow[]> {
  return context.storage.read(({ sql }) => readDesiredSystemStateWithSql(sql, context));
}

export async function readDesiredSystemStateWithSql(
  sql: SqlExecutor,
  context: Pick<ScanContext, "logicalSheetId" | "tombstoneField">,
): Promise<readonly DesiredRow[]> {
  // The flat rows come from the storage-owned reader; grouping stays here
  // because DesiredRow (decoded cells, tombstone default, revision hash) is
  // the scanner's internal contract, not a storage shape.
  const rows = await readFlatDesiredSystemStateWithSql(sql, context.logicalSheetId);
  const { completed, carry } = assembleDesiredChunk(rows, undefined, context.tombstoneField);
  const flushed = flushDesiredCarry(carry, context.tombstoneField);
  return flushed === undefined ? completed : [...completed, flushed];
}

/** One entity's fields accumulated across chunk boundaries. */
export interface PartialDesiredRow {
  readonly entityId: string;
  readonly rowBindingId: string;
  readonly anchorReference: string;
  readonly entityRevision: number;
  readonly fields: Record<string, NormalizedCell>;
}

/** Completed desired rows plus the trailing entity still missing fields. */
export interface DesiredChunkResult {
  readonly completed: readonly DesiredRow[];
  readonly carry: PartialDesiredRow | undefined;
}

/**
 * Groups one ordered page of flat canonical rows into completed desired
 * rows. A page may split an entity's fields across the boundary, so the
 * trailing entity is returned as `carry` and must seed the next call; only
 * `flushDesiredCarry` after the last page finalizes it. Completed rows are
 * finalized (tombstone default + revision hash) exactly like the full-load
 * reader, in global `(entity_id, field_name)` order.
 */
export function assembleDesiredChunk(
  rows: readonly ReconciliationDesiredSystemStateRow[],
  carry: PartialDesiredRow | undefined,
  tombstoneField: string | undefined,
): DesiredChunkResult {
  const completed: DesiredRow[] = [];
  let current = carry === undefined ? undefined : {
    entityId: carry.entityId,
    rowBindingId: carry.rowBindingId,
    anchorReference: carry.anchorReference,
    entityRevision: carry.entityRevision,
    fields: { ...carry.fields },
  };
  const finalizeCurrent = (): PartialDesiredRow | undefined => {
    if (current === undefined) return undefined;
    completed.push(finalizeDesiredRow(current, tombstoneField));
    return undefined;
  };
  for (const row of rows) {
    if (current !== undefined && current.entityId !== row.entityId) {
      current = finalizeCurrent();
    }
    if (current === undefined) {
      current = {
        entityId: row.entityId,
        rowBindingId: row.rowBindingId,
        anchorReference: row.anchorReference,
        entityRevision: row.entityRevision,
        fields: {},
      };
    }
    current.fields[row.fieldName] = decodeNormalizedCell(row.normalizedValue);
  }
  return {
    completed,
    carry: current === undefined ? undefined : {
      entityId: current.entityId,
      rowBindingId: current.rowBindingId,
      anchorReference: current.anchorReference,
      entityRevision: current.entityRevision,
      fields: current.fields,
    },
  };
}

/** Finalizes the trailing entity after the last page. */
export function flushDesiredCarry(
  carry: PartialDesiredRow | undefined,
  tombstoneField: string | undefined,
): DesiredRow | undefined {
  if (carry === undefined) return undefined;
  return finalizeDesiredRow(carry, tombstoneField);
}

function finalizeDesiredRow(
  row: PartialDesiredRow,
  tombstoneField: string | undefined,
): DesiredRow {
  const desired: DesiredRow = {
    entityId: row.entityId,
    rowBindingId: row.rowBindingId,
    anchorReference: row.anchorReference,
    entityRevision: row.entityRevision,
    fields: row.fields,
    fieldRevisionHash: "",
  };
  ensureTombstoneField(desired, tombstoneField);
  return { ...desired, fieldRevisionHash: computeFieldRevisionHash(desired.fields) };
}

export function ensureTombstoneField(row: DesiredRow, tombstoneField: string | undefined): void {
  if (tombstoneField === undefined) return;
  const fields = row.fields;
  if (fields[tombstoneField] === undefined) {
    fields[tombstoneField] = { kind: NORMALIZED_CELL_KINDS.BOOLEAN, value: false };
  }
}

export function computeFieldRevisionHash(fields: Readonly<Record<string, NormalizedCell>>): string {
  const entries = Object.entries(fields)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([fieldName, value]) => ({ fieldName, value }));
  return stableHash({ fields: entries });
}

export function decodeNormalizedCell(value: string): NormalizedCell {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isNormalizedCell(parsed)) {
      throw new StorageError(
        STORAGE_ERROR_CODES.OBSERVATION_STORAGE_INCONSISTENT,
        "entity_field_state.normalized_value is not a normalized cell",
      );
    }
    return parsed;
  } catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError(
      STORAGE_ERROR_CODES.OBSERVATION_STORAGE_INCONSISTENT,
      "entity_field_state.normalized_value is not valid JSON",
    );
  }
}
