/**
 * SQL-backed metadata operations used by mapped entity persistence.
 *
 * The application layer may coordinate these operations inside its existing
 * transaction, but it must not own SQLite table names or SQL text. Keeping the
 * statements here makes the current SQLite provider boundary explicit without
 * changing the public entity lifecycle API.
 */

import type { EffectStatus, NormalizedCell } from "../../../../domain/index.js";
import { ROW_BINDING_STATES } from "../../../../domain/model/constants.js";
import type {
  SqlExecutor,
  SqlMutationResult,
} from "../../../../adapter/persistence/contracts/sql.js";
import { parseNormalizedCell } from "../resolution/resolutionWriterHelpers.js";

/** Raw row-binding state returned by SQLite. */
export interface MappedRowBindingSqlRow {
  readonly logical_sheet_id: string;
  readonly anchor_reference: string;
  readonly entity_id: string | null;
  readonly state: string;
}

/** Raw canonical entity revision returned by SQLite. */
export interface MappedCanonicalEntitySqlRow {
  readonly entity_revision: number;
}

/** Raw canonical field revision returned by SQLite. */
export interface MappedCanonicalFieldRevisionSqlRow {
  readonly field_name: string;
  readonly field_revision: number;
}

/** Raw canonical field value used to rebuild a transaction-local projection. */
export interface MappedCanonicalFieldValueSqlRow {
  readonly field_name: string;
  readonly normalized_value: string;
}

/** Raw active business-key row returned by SQLite. */
export interface MappedActiveBusinessKeySqlRow {
  readonly entity_id: string;
  readonly normalized_key: string;
}

/** Raw business-key owner row returned by SQLite. */
export interface MappedBusinessKeyOwnerSqlRow {
  readonly entity_id: string;
}

/** Raw confirmed projection state returned by SQLite. */
export interface MappedVisibleProjectionSqlRow {
  readonly confirmed_snapshot_hash: string;
  readonly confirmed_visible_revision: number;
}

/** Raw latest projection effect returned by SQLite. */
export interface MappedLatestProjectionEffectSqlRow {
  readonly physical_sheet_id: string;
  readonly projection: string;
  readonly status: EffectStatus;
  readonly payload_json: string;
  readonly expected_visible_revision: number;
  readonly expected_visible_hash: string;
  readonly stream_sequence: number;
}

const READ_ROW_BINDING_SQL = `
  SELECT logical_sheet_id, anchor_reference, entity_id, state
  FROM row_binding
  WHERE row_binding_id = ?
`;

const INSERT_ACTIVE_ROW_BINDING_SQL = `
  INSERT INTO row_binding (
    row_binding_id, logical_sheet_id, anchor_reference, entity_id, state
  ) VALUES (?, ?, ?, ?, '${ROW_BINDING_STATES.ACTIVE}')
`;

const TOMBSTONE_ACTIVE_ROW_BINDING_SQL = `
  UPDATE row_binding
  SET state = '${ROW_BINDING_STATES.TOMBSTONED}'
  WHERE row_binding_id = ? AND logical_sheet_id = ? AND entity_id = ?
    AND state = '${ROW_BINDING_STATES.ACTIVE}'
`;

const READ_ACTIVE_CANONICAL_ENTITY_SQL = `
  SELECT entity_revision
  FROM entity_state
  WHERE entity_id = ? AND status = 'active'
`;

const READ_CANONICAL_FIELD_REVISIONS_SQL = `
  SELECT field_name, field_revision
  FROM entity_field_state
  WHERE entity_id = ?
`;

const READ_CANONICAL_FIELD_VALUES_SQL = `
  SELECT field_name, normalized_value
  FROM entity_field_state
  WHERE entity_id = ?
`;

const READ_ACTIVE_BUSINESS_KEY_SQL = `
  SELECT entity_id, normalized_key
  FROM business_key_index
  WHERE logical_sheet_id = ? AND field_name = ? AND entity_id = ? AND state = 'active'
`;

const READ_BUSINESS_KEY_OWNER_SQL = `
  SELECT entity_id
  FROM business_key_index
  WHERE logical_sheet_id = ? AND field_name = ? AND normalized_key = ? AND state = 'active'
`;

const INSERT_ACTIVE_BUSINESS_KEY_SQL = `
  INSERT INTO business_key_index (
    logical_sheet_id, field_name, normalized_key, entity_id, state
  ) VALUES (?, ?, ?, ?, 'active')
`;

const RETIRE_ACTIVE_BUSINESS_KEY_SQL = `
  UPDATE business_key_index
  SET state = 'inactive'
  WHERE logical_sheet_id = ? AND field_name = ? AND normalized_key = ?
    AND entity_id = ? AND state = 'active'
`;

const RETIRE_ENTITY_BUSINESS_KEYS_SQL = `
  UPDATE business_key_index
  SET state = 'inactive'
  WHERE logical_sheet_id = ? AND entity_id = ? AND state = 'active'
`;

const READ_VISIBLE_PROJECTION_STATE_SQL = `
  SELECT confirmed_snapshot_hash, confirmed_visible_revision
  FROM sheet_visible_state
  WHERE physical_sheet_id = ? AND projection = ? AND row_binding_id = ?
`;

const READ_LATEST_PROJECTION_EFFECT_SQL = `
  SELECT physical_sheet_id, projection, status, payload_json,
         expected_visible_revision, expected_visible_hash, stream_sequence
  FROM sheet_effect_outbox
  WHERE logical_sheet_id = ? AND target_kind = ? AND target_id = ?
  ORDER BY stream_sequence DESC
  LIMIT 1
`;

/** Reads one mapped row binding inside the caller-owned transaction. */
export function readMappedRowBindingWithSql(
  sql: SqlExecutor,
  rowBindingId: string,
): Promise<MappedRowBindingSqlRow | undefined> {
  return sql.get<MappedRowBindingSqlRow>(READ_ROW_BINDING_SQL, [rowBindingId]);
}

/** Inserts the active binding shared by the mapped System_State and User_Input rows. */
export function insertMappedActiveRowBindingWithSql(
  sql: SqlExecutor,
  rowBindingId: string,
  logicalSheetId: string,
  anchorReference: string,
  entityId: string,
): Promise<SqlMutationResult> {
  return sql.run(INSERT_ACTIVE_ROW_BINDING_SQL, [
    rowBindingId,
    logicalSheetId,
    anchorReference,
    entityId,
  ]);
}

/** Tombstones one active mapped row binding after a canonical delete. */
export function tombstoneMappedActiveRowBindingWithSql(
  sql: SqlExecutor,
  rowBindingId: string,
  logicalSheetId: string,
  entityId: string,
): Promise<SqlMutationResult> {
  return sql.run(TOMBSTONE_ACTIVE_ROW_BINDING_SQL, [
    rowBindingId,
    logicalSheetId,
    entityId,
  ]);
}

/** Reads the active canonical entity revision used by mapped flush validation. */
export function readMappedActiveCanonicalEntityWithSql(
  sql: SqlExecutor,
  entityId: string,
): Promise<MappedCanonicalEntitySqlRow | undefined> {
  return sql.get<MappedCanonicalEntitySqlRow>(READ_ACTIVE_CANONICAL_ENTITY_SQL, [entityId]);
}

/** Reads the current canonical values used for transaction-local projection payloads. */
export async function readMappedCanonicalFieldsWithSql(
  sql: SqlExecutor,
  entityId: string,
): Promise<Readonly<Record<string, NormalizedCell>>> {
  const rows = await sql.all<MappedCanonicalFieldValueSqlRow>(
    READ_CANONICAL_FIELD_VALUES_SQL,
    [entityId],
  );
  return Object.fromEntries(rows.map((row) => [
    row.field_name,
    parseNormalizedCell(row.normalized_value, `${entityId}.${row.field_name}`),
  ]));
}

/** Reads canonical field revisions used to build update compare-and-set input. */
export function readMappedCanonicalFieldRevisionsWithSql(
  sql: SqlExecutor,
  entityId: string,
): Promise<readonly MappedCanonicalFieldRevisionSqlRow[]> {
  return sql.all<MappedCanonicalFieldRevisionSqlRow>(READ_CANONICAL_FIELD_REVISIONS_SQL, [entityId]);
}

/** Reads the active business key currently owned by one mapped entity. */
export function readMappedActiveBusinessKeyWithSql(
  sql: SqlExecutor,
  logicalSheetId: string,
  fieldName: string,
  entityId: string,
): Promise<MappedActiveBusinessKeySqlRow | undefined> {
  return sql.get<MappedActiveBusinessKeySqlRow>(READ_ACTIVE_BUSINESS_KEY_SQL, [
    logicalSheetId,
    fieldName,
    entityId,
  ]);
}

/** Reads the current owner of a normalized business key. */
export function readMappedBusinessKeyOwnerWithSql(
  sql: SqlExecutor,
  logicalSheetId: string,
  fieldName: string,
  normalizedKey: string,
): Promise<MappedBusinessKeyOwnerSqlRow | undefined> {
  return sql.get<MappedBusinessKeyOwnerSqlRow>(READ_BUSINESS_KEY_OWNER_SQL, [
    logicalSheetId,
    fieldName,
    normalizedKey,
  ]);
}

/** Claims a normalized business key for a mapped entity. */
export function insertMappedActiveBusinessKeyWithSql(
  sql: SqlExecutor,
  logicalSheetId: string,
  fieldName: string,
  normalizedKey: string,
  entityId: string,
): Promise<SqlMutationResult> {
  return sql.run(INSERT_ACTIVE_BUSINESS_KEY_SQL, [
    logicalSheetId,
    fieldName,
    normalizedKey,
    entityId,
  ]);
}

/** Retires one previous business key during an accepted key rotation. */
export function retireMappedActiveBusinessKeyWithSql(
  sql: SqlExecutor,
  logicalSheetId: string,
  fieldName: string,
  normalizedKey: string,
  entityId: string,
): Promise<SqlMutationResult> {
  return sql.run(RETIRE_ACTIVE_BUSINESS_KEY_SQL, [
    logicalSheetId,
    fieldName,
    normalizedKey,
    entityId,
  ]);
}

/** Retires every active business key owned by a deleted mapped entity. */
export function retireMappedEntityBusinessKeysWithSql(
  sql: SqlExecutor,
  logicalSheetId: string,
  entityId: string,
): Promise<SqlMutationResult> {
  return sql.run(RETIRE_ENTITY_BUSINESS_KEYS_SQL, [logicalSheetId, entityId]);
}

/** Reads the last confirmed visible state for one projection row. */
export function readMappedVisibleProjectionStateWithSql(
  sql: SqlExecutor,
  physicalSheetId: string,
  projection: string,
  rowBindingId: string,
): Promise<MappedVisibleProjectionSqlRow | undefined> {
  return sql.get<MappedVisibleProjectionSqlRow>(READ_VISIBLE_PROJECTION_STATE_SQL, [
    physicalSheetId,
    projection,
    rowBindingId,
  ]);
}

/** Reads the latest queued or applied effect used to derive the next baseline. */
export function readMappedLatestProjectionEffectWithSql(
  sql: SqlExecutor,
  logicalSheetId: string,
  targetKind: string,
  targetId: string,
): Promise<MappedLatestProjectionEffectSqlRow | undefined> {
  return sql.get<MappedLatestProjectionEffectSqlRow>(READ_LATEST_PROJECTION_EFFECT_SQL, [
    logicalSheetId,
    targetKind,
    targetId,
  ]);
}
