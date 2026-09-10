/** Storage reads used by System_State reconciliation. */

import {
  EFFECT_STATUSES,
  type EffectStatus,
} from "@hikoutei/contracts/domain/model/constants.js";
import { STORAGE_ERROR_CODES, StorageError } from "../../errors.js";
import type {
  SqlExecutor,
  SqlStorageAdapter,
} from "@hikoutei/contracts/storage/sql.js";

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

/**
 * Canonical rows that should be visible in System_State, ordered for keyset
 * pagination. This is the single implementation of the desired-state query:
 * the sync-engine reconciliation scanner imports it instead of carrying its
 * own copy, so the projection shape can only change in one place.
 */
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

/**
 * Maximum flat rows read per scan chunk. Still bounds the single-table
 * binding pages; the entity-batched desired/canonical pages below are
 * bounded by `RECONCILIATION_SCAN_ENTITY_PAGE_SIZE` instead.
 */
export const RECONCILIATION_SCAN_CHUNK_SIZE = 1_000;

/**
 * Maximum entities per entity-batched scan chunk. One chunk holds whole
 * entities only (fields × bindings), so scan memory stays flat while the
 * per-page cost stays bounded: the entity page is an `entity_state` primary
 * key range scan, field fetches are `entity_field_state` PK prefix seeks,
 * and binding fetches are `row_binding_entity_idx` covering seeks — no
 * temp-b-tree sort anywhere (verified with EXPLAIN QUERY PLAN).
 */
export const RECONCILIATION_SCAN_ENTITY_PAGE_SIZE = 250;

/** Keyset cursor for a paged desired-state chunk: the last entity already seen. */
export interface ReconciliationDesiredChunkCursor {
  readonly entityId: string;
}

/** One page of active entities in primary key order (no sort possible). */
const READ_ACTIVE_ENTITY_PAGE_SQL = `
  SELECT entity_id, entity_revision
  FROM entity_state
  WHERE status = 'active' AND entity_id > ?
  ORDER BY entity_id
  LIMIT ?
`;

const READ_ACTIVE_ENTITY_FIRST_PAGE_SQL = `
  SELECT entity_id, entity_revision
  FROM entity_state
  WHERE status = 'active'
  ORDER BY entity_id
  LIMIT ?
`;

interface ActiveEntitySqlRow {
  readonly entity_id: string;
  readonly entity_revision: number;
}

/** One entity's fields in primary key order (prefix seek, no sort). */
const READ_ENTITY_FIELDS_SQL = `
  SELECT field_name, normalized_value, ownership
  FROM entity_field_state
  WHERE entity_id = ?
  ORDER BY field_name
`;

const READ_ENTITY_USER_FIELDS_SQL = `
  SELECT field_name, normalized_value, ownership
  FROM entity_field_state
  WHERE entity_id = ? AND ownership = 'user'
  ORDER BY field_name
`;

interface EntityFieldSqlRow {
  readonly field_name: string;
  readonly normalized_value: string;
  readonly ownership: string;
}

/**
 * One entity's active bindings for a sheet (covering seek on
 * `row_binding_entity_idx`, no sort). Entities without an active binding
 * contribute no rows, exactly like the inner join of the full query.
 */
const READ_ENTITY_BINDINGS_SQL = `
  SELECT row_binding_id, anchor_reference
  FROM row_binding
  WHERE logical_sheet_id = ? AND entity_id = ? AND state = 'active'
  ORDER BY row_binding_id
`;

interface EntityBindingSqlRow {
  readonly row_binding_id: string;
  readonly anchor_reference: string;
}

/** One active entity in primary key order. */
export interface ReconciliationPagedEntity {
  readonly entityId: string;
  readonly entityRevision: number;
}

/**
 * Pages active entities in primary key order (range scan, no sort). Shared
 * driver for the entity-batched scan readers: every page holds whole
 * entities, so chunk boundaries never split an entity's rows and the
 * cursor (`last entity paged`) can neither skip nor repeat rows.
 */
export function readActiveEntityPageWithSql(
  sql: SqlExecutor,
  afterEntityId: string | undefined,
  limit: number,
): Promise<readonly ReconciliationPagedEntity[]> {
  return sql.all<ActiveEntitySqlRow>(
    afterEntityId === undefined ? READ_ACTIVE_ENTITY_FIRST_PAGE_SQL : READ_ACTIVE_ENTITY_PAGE_SQL,
    afterEntityId === undefined ? [limit] : [afterEntityId, limit],
  ).then((rows) => rows.map((row) => ({
    entityId: row.entity_id,
    entityRevision: row.entity_revision,
  })));
}

/** One entity's active bindings for a sheet. */
export interface ReconciliationEntityBinding {
  readonly rowBindingId: string;
  readonly anchorReference: string;
}

/**
 * One entity's active bindings (covering seek on `row_binding_entity_idx`,
 * no sort). Entities without an active binding yield no rows, exactly like
 * the inner join of the full queries.
 */
export function readEntityBindingsWithSql(
  sql: SqlExecutor,
  logicalSheetId: string,
  entityId: string,
): Promise<readonly ReconciliationEntityBinding[]> {
  return sql.all<EntityBindingSqlRow>(READ_ENTITY_BINDINGS_SQL, [
    logicalSheetId,
    entityId,
  ]).then((rows) => rows.map((row) => ({
    rowBindingId: row.row_binding_id,
    anchorReference: row.anchor_reference,
  })));
}

/** One entity's fields in primary key order (prefix seek, no sort). */
export interface ReconciliationEntityField {
  readonly fieldName: string;
  readonly normalizedValue: string;
  readonly ownership: string;
}

/**
 * One entity's fields, optionally ownership-filtered. PK prefix seek, no
 * sort; `ownership` narrows to the user-owned projection subset.
 */
export function readEntityFieldsWithSql(
  sql: SqlExecutor,
  entityId: string,
  ownership: "user" | undefined,
): Promise<readonly ReconciliationEntityField[]> {
  return sql.all<EntityFieldSqlRow>(
    ownership === undefined ? READ_ENTITY_FIELDS_SQL : READ_ENTITY_USER_FIELDS_SQL,
    [entityId],
  ).then((rows) => rows.map((row) => ({
    fieldName: row.field_name,
    normalizedValue: row.normalized_value,
    ownership: row.ownership,
  })));
}

/** One entity-batched chunk: whole entities as flat rows plus progress. */
export interface ReconciliationDesiredEntityChunk {
  readonly rows: readonly ReconciliationDesiredSystemStateRow[];
  /** Entities paged (including binding-less ones) — the termination signal. */
  readonly entityCount: number;
  /** Last entity paged — the next cursor (absent only when empty). */
  readonly lastEntityId: string | undefined;
}

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

/**
 * Reads one bounded chunk of whole entities as flat canonical rows, in the
 * same global `(entity_id, field_name)` order as the full query. Pass no
 * cursor for the first chunk, then `{ entityId }` of the last entity paged
 * as the next cursor; an empty chunk (or `entityCount < limit`) ends the
 * scan. Only `limit` entities (with their fields × bindings) are ever
 * materialized per call, so scan memory is O(chunk) at bounded per-page
 * cost — unlike a flat cross-table keyset, whose row-value predicate over
 * joined tables forces SQLite to materialize and sort the whole join per
 * page. Multi-binding entities emit one row per (binding, field) with the
 * smallest `row_binding_id` first, so grouping stays deterministic.
 */
export async function readReconciliationDesiredSystemStateChunkWithSql(
  sql: SqlExecutor,
  logicalSheetId: string,
  after: ReconciliationDesiredChunkCursor | undefined,
  limit: number = RECONCILIATION_SCAN_ENTITY_PAGE_SIZE,
): Promise<ReconciliationDesiredEntityChunk> {
  const entities = await readActiveEntityPageWithSql(sql, after?.entityId, limit);
  const rows: ReconciliationDesiredSystemStateRow[] = [];
  for (const entity of entities) {
    const [bindings, fields] = await Promise.all([
      readEntityBindingsWithSql(sql, logicalSheetId, entity.entityId),
      readEntityFieldsWithSql(sql, entity.entityId, undefined),
    ]);
    for (const binding of bindings) {
      for (const field of fields) {
        rows.push({
          entityId: entity.entityId,
          rowBindingId: binding.rowBindingId,
          anchorReference: binding.anchorReference,
          entityRevision: entity.entityRevision,
          fieldName: field.fieldName,
          normalizedValue: field.normalizedValue,
          ownership: field.ownership,
        });
      }
    }
  }
  const lastEntity = entities[entities.length - 1];
  return {
    rows,
    entityCount: entities.length,
    lastEntityId: lastEntity === undefined ? undefined : lastEntity.entityId,
  };
}

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
