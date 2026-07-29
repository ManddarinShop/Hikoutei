/** SQL reads used by System_State reconciliation. */

import type { SqlExecutor } from "../../../../adapter/persistence/contracts/sql.js";

/** Raw entity-field row used to assemble the desired System_State projection. */
export interface ReconciliationDesiredSystemStateSqlRow {
  readonly entity_id: string;
  readonly row_binding_id: string;
  readonly anchor_reference: string;
  readonly entity_revision: number;
  readonly field_name: string;
  readonly normalized_value: string;
  readonly ownership: string;
}

/** Raw confirmed visible state used by reconciliation baseline planning. */
export interface ReconciliationVisibleStateSqlRow {
  readonly confirmed_visible_revision: number | null;
  readonly confirmed_snapshot_hash: string | null;
}

/** Raw latest effect used by reconciliation baseline planning. */
export interface ReconciliationLatestEffectSqlRow {
  readonly stream_sequence: number | null;
  readonly expected_visible_revision: number | null;
  readonly expected_visible_hash: string | null;
  readonly status: string;
  readonly payload_json: string | null;
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
): Promise<readonly ReconciliationDesiredSystemStateSqlRow[]> {
  return sql.all<ReconciliationDesiredSystemStateSqlRow>(
    READ_DESIRED_SYSTEM_STATE_SQL,
    [logicalSheetId],
  );
}

/** Reads confirmed visible state for one reconciliation row. */
export function readReconciliationVisibleStateWithSql(
  sql: SqlExecutor,
  physicalSheetId: string,
  rowBindingId: string,
): Promise<ReconciliationVisibleStateSqlRow | undefined> {
  return sql.get<ReconciliationVisibleStateSqlRow>(READ_LATEST_VISIBLE_STATE_SQL, [
    physicalSheetId,
    rowBindingId,
  ]);
}

/** Reads the latest outbox effect for one reconciliation target. */
export function readReconciliationLatestEffectWithSql(
  sql: SqlExecutor,
  logicalSheetId: string,
  entityId: string,
): Promise<ReconciliationLatestEffectSqlRow | undefined> {
  return sql.get<ReconciliationLatestEffectSqlRow>(READ_LATEST_EFFECT_SQL, [
    logicalSheetId,
    entityId,
  ]);
}
