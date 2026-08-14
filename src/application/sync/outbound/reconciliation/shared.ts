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

import { stableHash } from "../../../../shared/encoding/stableEncode.js";
import type { NormalizedCell } from "../../../../shared/encoding/types.js";
import { NORMALIZED_CELL_KINDS } from "../../../../shared/encoding/constants.js";
import { isNormalizedCell } from "../../../../shared/encoding/normalizedCell.js";
import { STORAGE_ERROR_CODES, StorageError } from "../../../../infrastructure/storage/errors.js";
import type { SqlExecutor, SqlStorageAdapter } from "../../../../adapter/persistence/contracts/sql.js";
import type { SyncSheetsObservationProvider } from "../../sheetsContract/syncSheets.js";

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

export interface DesiredRowSqlShape {
  readonly entity_id: string;
  readonly row_binding_id: string;
  readonly anchor_reference: string;
  readonly entity_revision: number;
  readonly field_name: string;
  readonly normalized_value: string;
  readonly ownership: string;
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

export const READ_DESIRED_SYSTEM_STATE_SQL = `
  SELECT
    entity.entity_id              AS entity_id,
    binding.row_binding_id        AS row_binding_id,
    binding.anchor_reference      AS anchor_reference,
    entity.entity_revision        AS entity_revision,
    field.field_name              AS field_name,
    field.normalized_value        AS normalized_value,
    field.ownership               AS ownership
  FROM entity_state AS entity
  JOIN row_binding AS binding
    ON binding.entity_id = entity.entity_id
   AND binding.logical_sheet_id = ?
   AND binding.state = 'active'
  JOIN entity_field_state AS field
    ON field.entity_id = entity.entity_id
  WHERE entity.status = 'active'
  ORDER BY entity.entity_id, field.field_name
`;

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

export interface ScanContext {
  readonly storage: SqlStorageAdapter;
  readonly provider: SyncSheetsObservationProvider;
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
  context: ScanContext,
): Promise<readonly DesiredRow[]> {
  const rows = await sql.all<DesiredRowSqlShape>(READ_DESIRED_SYSTEM_STATE_SQL, [
    context.logicalSheetId,
  ]);

  const byEntity = new Map<string, DesiredRow>();
  for (const row of rows) {
    const existing = byEntity.get(row.entity_id);
    const cell = decodeNormalizedCell(row.normalized_value);
    if (existing === undefined) {
      const fields: Record<string, NormalizedCell> = {};
      fields[row.field_name] = cell;
      byEntity.set(row.entity_id, {
        entityId: row.entity_id,
        rowBindingId: row.row_binding_id,
        anchorReference: row.anchor_reference,
        entityRevision: row.entity_revision,
        fields,
        fieldRevisionHash: "",
      });
      continue;
    }
    existing.fields[row.field_name] = cell;
  }

  const desired: DesiredRow[] = [];
  for (const row of byEntity.values()) {
    ensureTombstoneField(row, context.tombstoneField);
    const hash = computeFieldRevisionHash(row.fields);
    desired.push({ ...row, fieldRevisionHash: hash });
  }
  return desired;
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
