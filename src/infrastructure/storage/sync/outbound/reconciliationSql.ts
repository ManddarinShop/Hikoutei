/** Storage reads used by System_State reconciliation. */

import {
  EFFECT_STATUSES,
  type EffectStatus,
} from "../../../../domain/model/constants.js";
import { STORAGE_ERROR_CODES, StorageError } from "../../errors.js";
import type {
  SqlExecutor,
  SqlStorageAdapter,
} from "../../../../adapter/persistence/contracts/sql.js";

/** Canonical field row used to assemble the desired System_State projection. */
export interface ReconciliationDesiredSystemStateRow {
  readonly entityId: string;
  readonly rowBindingId: string;
  readonly anchorReference: string;
  readonly entityRevision: number;
  readonly fieldName: string;
  readonly normalizedValue: string;
  readonly ownership: string;
}

interface ReconciliationDesiredSystemStateSqlRow {
  readonly entity_id: string;
  readonly row_binding_id: string;
  readonly anchor_reference: string;
  readonly entity_revision: number;
  readonly field_name: string;
  readonly normalized_value: string;
  readonly ownership: string;
}

/** Confirmed visible state used by reconciliation baseline planning. */
export interface ReconciliationVisibleState {
  readonly confirmedVisibleRevision: number | null;
  readonly confirmedSnapshotHash: string | null;
}

interface ReconciliationVisibleStateSqlRow {
  readonly confirmed_visible_revision: number | null;
  readonly confirmed_snapshot_hash: string | null;
}

/** Latest effect used by reconciliation baseline planning. */
export interface ReconciliationLatestEffect {
  readonly streamSequence: number | null;
  readonly expectedVisibleRevision: number | null;
  readonly expectedVisibleHash: string | null;
  readonly status: EffectStatus;
  readonly payloadJson: string | null;
}

interface ReconciliationLatestEffectSqlRow {
  readonly stream_sequence: number | null;
  readonly expected_visible_revision: number | null;
  readonly expected_visible_hash: string | null;
  readonly status: string;
  readonly payload_json: string | null;
}

/** Read set used to plan one correction without exposing SQL row names. */
export interface ReconciliationCorrectionState {
  readonly latestEffect: ReconciliationLatestEffect | undefined;
  readonly visibleState: ReconciliationVisibleState | undefined;
}

const READ_DESIRED_SYSTEM_STATE_SQL = `
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

const READ_LATEST_VISIBLE_STATE_SQL = `
  SELECT confirmed_visible_revision, confirmed_snapshot_hash
  FROM sheet_visible_state
  WHERE physical_sheet_id = ? AND projection = 'system_state' AND row_binding_id = ?
`;

const READ_LATEST_EFFECT_SQL = `
  SELECT stream_sequence, expected_visible_revision, expected_visible_hash, status, payload_json
  FROM sheet_effect_outbox
  WHERE logical_sheet_id = ? AND target_kind = 'entity' AND target_id = ?
  ORDER BY stream_sequence DESC
  LIMIT 1
`;

/** Reads the canonical rows that should be visible in System_State. */
export function readReconciliationDesiredSystemStateWithSql(
  sql: SqlExecutor,
  logicalSheetId: string,
): Promise<readonly ReconciliationDesiredSystemStateRow[]> {
  return sql.all<ReconciliationDesiredSystemStateSqlRow>(
    READ_DESIRED_SYSTEM_STATE_SQL,
    [logicalSheetId],
  ).then((rows) => rows.map(toDesiredSystemStateRow));
}

/** Reads the canonical rows that should be visible in System_State. */
export function readReconciliationDesiredSystemStateWithAdapter(
  storage: SqlStorageAdapter,
  logicalSheetId: string,
): Promise<readonly ReconciliationDesiredSystemStateRow[]> {
  return storage.read(({ sql }) =>
    readReconciliationDesiredSystemStateWithSql(sql, logicalSheetId),
  );
}

/** Reads confirmed visible state for one reconciliation row. */
export function readReconciliationVisibleStateWithSql(
  sql: SqlExecutor,
  physicalSheetId: string,
  rowBindingId: string,
): Promise<ReconciliationVisibleState | undefined> {
  return sql.get<ReconciliationVisibleStateSqlRow>(READ_LATEST_VISIBLE_STATE_SQL, [
    physicalSheetId,
    rowBindingId,
  ]).then((row) => row === undefined ? undefined : toVisibleState(row));
}

/** Reads the latest outbox effect for one reconciliation target. */
export function readReconciliationLatestEffectWithSql(
  sql: SqlExecutor,
  logicalSheetId: string,
  entityId: string,
): Promise<ReconciliationLatestEffect | undefined> {
  return sql.get<ReconciliationLatestEffectSqlRow>(READ_LATEST_EFFECT_SQL, [
    logicalSheetId,
    entityId,
  ]).then((row) => row === undefined ? undefined : toLatestEffect(row));
}

/** Reads the latest effect and visible baseline in one adapter-owned context. */
export function readReconciliationCorrectionStateWithAdapter(
  storage: SqlStorageAdapter,
  input: {
    readonly logicalSheetId: string;
    readonly physicalSheetId: string;
    readonly entityId: string;
    readonly rowBindingId: string;
  },
): Promise<ReconciliationCorrectionState> {
  return storage.read(async ({ sql }) => {
    const latestEffect = await readReconciliationLatestEffectWithSql(
      sql,
      input.logicalSheetId,
      input.entityId,
    );
    const visibleState = await readReconciliationVisibleStateWithSql(
      sql,
      input.physicalSheetId,
      input.rowBindingId,
    );
    return { latestEffect, visibleState };
  });
}

function toDesiredSystemStateRow(
  row: ReconciliationDesiredSystemStateSqlRow,
): ReconciliationDesiredSystemStateRow {
  return {
    entityId: row.entity_id,
    rowBindingId: row.row_binding_id,
    anchorReference: row.anchor_reference,
    entityRevision: row.entity_revision,
    fieldName: row.field_name,
    normalizedValue: row.normalized_value,
    ownership: row.ownership,
  };
}

function toVisibleState(row: ReconciliationVisibleStateSqlRow): ReconciliationVisibleState {
  return {
    confirmedVisibleRevision: row.confirmed_visible_revision,
    confirmedSnapshotHash: row.confirmed_snapshot_hash,
  };
}

function toLatestEffect(row: ReconciliationLatestEffectSqlRow): ReconciliationLatestEffect {
  return {
    streamSequence: row.stream_sequence,
    expectedVisibleRevision: row.expected_visible_revision,
    expectedVisibleHash: row.expected_visible_hash,
    status: requireEffectStatus(row.status),
    payloadJson: row.payload_json,
  };
}

function requireEffectStatus(value: string): EffectStatus {
  if (value === EFFECT_STATUSES.PENDING ||
      value === EFFECT_STATUSES.PROCESSING ||
      value === EFFECT_STATUSES.DELIVERY_UNCERTAIN ||
      value === EFFECT_STATUSES.APPLIED ||
      value === EFFECT_STATUSES.BLOCKED_CANDIDATE ||
      value === EFFECT_STATUSES.SUPERSEDED ||
      value === EFFECT_STATUSES.CONFLICT ||
      value === EFFECT_STATUSES.FAILED) return value;
  throw new StorageError(
    STORAGE_ERROR_CODES.INVALID_EFFECT_RESULT,
    `stored reconciliation effect has invalid status ${value}`,
  );
}
