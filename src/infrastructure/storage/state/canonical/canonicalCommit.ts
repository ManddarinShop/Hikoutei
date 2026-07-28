/**
 * Fenced canonical field commits for the SQLite-authoritative prototype.
 *
 * The writer applies every accepted field CAS and any resulting outbox rows in
 * one SQLite savepoint. A stale field or lost fence rolls back the complete
 * row-level commit, so a partially accepted event cannot leak a partial state.
 */

// Domain contract: canonical rows are the SQLite source of truth.
import { ROW_OPERATIONS } from "../../../../domain/model/constants.js";
import type {
  Applicability,
  FieldOwnership,
  NormalizedCell,
  Presence,
} from "../../../../domain/index.js";

// Shared state tags: these make applicability and presence explicit.
import {
  APPLICABILITY_KINDS,
  PRESENCE_KINDS,
} from "../../../../shared/state/constants.js";

// Storage boundary: errors, transactions, fencing, and SQL adapters.
import { STORAGE_ERROR_CODES, StorageError } from "../../errors.js";
import { rollbackSqlSavepoint } from "../../sqlite/sqlTransaction.js";
import { toSqlNullable } from "../../sqlite/sqlState.js";
import { isFencingValidWithSql } from "../../sync/shared/writerLease.js";
import type { FencingContext } from "../../sync/shared/writerLease.js";

// Outbound synchronization: accepted canonical changes become outbox effects.
import {
  appendPendingEffectsWithSql,
  type NewEffect,
} from "../../sync/outbound/effectOutbox.js";
import { FENCE_EXISTS_SQL } from "../../sync/outbound/effectOutboxSql.js";
import type { SqlExecutor, SqlStorageAdapter } from "../../../../adapter/persistence/contracts/sql.js";

const INSERT_CANONICAL_ENTITY_SQL = `
  INSERT INTO entity_state (entity_id, entity_revision, accepted_snapshot_hash, status)
  SELECT ?, 1, ?, 'active'
  WHERE EXISTS (${FENCE_EXISTS_SQL})
`;

const INSERT_CANONICAL_FIELD_SQL = `
  INSERT INTO entity_field_state (
    entity_id, field_name, normalized_value, field_revision, ownership
  )
  SELECT ?, ?, ?, 1, ?
  WHERE EXISTS (${FENCE_EXISTS_SQL})
`;

const READ_CANONICAL_ENTITY_SQL = `
  SELECT entity_revision FROM entity_state
  WHERE entity_id = ? AND status = 'active'
`;

const UPDATE_CANONICAL_FIELD_SQL = `
  UPDATE entity_field_state
  SET normalized_value = ?, field_revision = field_revision + 1
  WHERE entity_id = ? AND field_name = ? AND field_revision = ? AND ownership = ?
    AND EXISTS (${FENCE_EXISTS_SQL})
`;

const UPDATE_CANONICAL_ENTITY_SQL = `
  UPDATE entity_state
  SET entity_revision = ?, accepted_snapshot_hash = ?
  WHERE entity_id = ? AND entity_revision = ? AND status = 'active'
    AND EXISTS (${FENCE_EXISTS_SQL})
`;

const DELETE_CANONICAL_ENTITY_SQL = `
  UPDATE entity_state
  SET entity_revision = ?, accepted_snapshot_hash = ?, status = 'tombstoned'
  WHERE entity_id = ? AND entity_revision = ? AND status = 'active'
    AND EXISTS (${FENCE_EXISTS_SQL})
`;

/** Runtime values returned by the canonical commit writer. */
export const CANONICAL_COMMIT_RESULT_KINDS = {
  APPLIED: "applied",
  STALE: "stale",
  FENCED_OUT: "fenced_out",
  INVALID: "invalid",
} as const;

/** Closed set of canonical commit result kinds. */
export type CanonicalCommitResultKind =
  (typeof CANONICAL_COMMIT_RESULT_KINDS)[keyof typeof CANONICAL_COMMIT_RESULT_KINDS];

/** Runtime values describing which canonical target became stale. */
export const CANONICAL_COMMIT_STALE_TARGETS = {
  ENTITY: "entity",
  FIELD: "field",
} as const;

/** Closed set of canonical stale-target kinds. */
export type CanonicalCommitStaleTarget =
  (typeof CANONICAL_COMMIT_STALE_TARGETS)[keyof typeof CANONICAL_COMMIT_STALE_TARGETS];

/** A field value the writer should insert or compare-and-set. */
export interface CanonicalFieldWrite {
  readonly fieldName: string;
  readonly value: NormalizedCell;
  /** Inserts have no prior revision; updates carry the revision used by CAS. */
  readonly expectedFieldRevision: Applicability<number>;
  readonly ownership: FieldOwnership;
}

/** Shared canonical commit fields used by every row operation. */
interface CanonicalCommitBase {
  readonly entityId: string;
  /** Snapshot hash is absent when the caller has no accepted snapshot evidence. */
  readonly acceptedSnapshotHash: Presence<string>;
  /** Effects are inserted in this same savepoint as the canonical mutation. */
  readonly effects: readonly NewEffect[];
}

/** An insert prepared from one core evaluation result. */
export interface CanonicalInsertCommitInput extends CanonicalCommitBase {
  readonly kind: typeof ROW_OPERATIONS.INSERT;
  readonly fields: readonly CanonicalFieldWrite[];
}

/** A field-level update prepared from one core evaluation result. */
export interface CanonicalUpdateCommitInput extends CanonicalCommitBase {
  readonly kind: typeof ROW_OPERATIONS.UPDATE;
  readonly fields: readonly CanonicalFieldWrite[];
}

/** An insert or field-level update prepared from one core evaluation result. */
export type CanonicalFieldCommitInput = CanonicalInsertCommitInput | CanonicalUpdateCommitInput;

/** A confirmed delete that turns an active canonical entity into a tombstone. */
export interface CanonicalDeleteCommitInput extends CanonicalCommitBase {
  readonly kind: typeof ROW_OPERATIONS.DELETE;
  /** Entity revision observed with the explicit delete evidence. */
  readonly expectedEntityRevision: number;
}

/** A row-level canonical mutation prepared from one core evaluation result. */
export type CanonicalCommitInput = CanonicalFieldCommitInput | CanonicalDeleteCommitInput;

/** Observable result of a fenced canonical commit attempt. */
export type CanonicalCommitResult =
  | {
      readonly kind: typeof CANONICAL_COMMIT_RESULT_KINDS.APPLIED;
      readonly entityRevision: number;
      readonly fieldRevisions: ReadonlyMap<string, number>;
    }
  | {
      readonly kind: typeof CANONICAL_COMMIT_RESULT_KINDS.STALE;
      readonly target: CanonicalCommitStaleTarget;
      readonly fieldName: Applicability<string>;
    }
  | { readonly kind: typeof CANONICAL_COMMIT_RESULT_KINDS.FENCED_OUT }
  | {
      readonly kind: typeof CANONICAL_COMMIT_RESULT_KINDS.INVALID;
      readonly reason: string;
    };

/**
 * Commits canonical state and outbox effects inside an already-active async
 * SQL transaction.
 *
 * Call it from the same adapter transaction as the user entity mutation so a
 * database error cannot persist one side without the other.
 */
export async function commitCanonicalChangesWithSql(
  sql: SqlExecutor,
  fence: FencingContext,
  input: CanonicalCommitInput,
): Promise<CanonicalCommitResult> {
  const invalidReason = validateInput(input);
  if (invalidReason.kind === PRESENCE_KINDS.PRESENT) {
    return { kind: CANONICAL_COMMIT_RESULT_KINDS.INVALID, reason: invalidReason.value };
  }
  if (!(await isFencingValidWithSql(sql, fence))) {
    return { kind: CANONICAL_COMMIT_RESULT_KINDS.FENCED_OUT };
  }

  await sql.run("SAVEPOINT canonical_commit");
  try {
    const result = input.kind === ROW_OPERATIONS.INSERT
      ? await applyInsertWithSql(sql, fence, input)
      : input.kind === ROW_OPERATIONS.UPDATE
        ? await applyUpdateWithSql(sql, fence, input)
        : await applyDeleteWithSql(sql, fence, input);
    if (result.kind !== CANONICAL_COMMIT_RESULT_KINDS.APPLIED) {
      await rollbackSqlSavepoint(sql, "canonical_commit");
      return result;
    }

    if (!(await appendPendingEffectsWithSql(sql, fence, input.effects))) {
      throw new AsyncFenceLostError();
    }

    await sql.run("RELEASE canonical_commit");
    return result;
  } catch (error: unknown) {
    try {
      await rollbackSqlSavepoint(sql, "canonical_commit");
    } catch {
      // Preserve the storage error that made the canonical commit fail.
    }
    if (error instanceof AsyncFenceLostError) {
      return { kind: CANONICAL_COMMIT_RESULT_KINDS.FENCED_OUT };
    }
    throw error;
  }
}

/** Commits canonical state in one adapter-owned transaction. */
export async function commitCanonicalChangesWithAdapter(
  storage: SqlStorageAdapter,
  fence: FencingContext,
  input: CanonicalCommitInput,
): Promise<CanonicalCommitResult> {
  return storage.transaction(({ sql }) => commitCanonicalChangesWithSql(sql, fence, input));
}

async function applyInsertWithSql(
  sql: SqlExecutor,
  fence: FencingContext,
  input: CanonicalInsertCommitInput,
): Promise<CanonicalCommitResult> {
  const entityResult = await sql.run(INSERT_CANONICAL_ENTITY_SQL, [
    input.entityId,
    toSqlNullable(input.acceptedSnapshotHash),
    ...fenceParameters(fence),
  ]);
  if (entityResult.changes !== 1) return lostFenceOrStaleEntityWithSql(sql, fence);

  const fieldRevisions = new Map<string, number>();
  for (const field of input.fields) {
    const result = await sql.run(INSERT_CANONICAL_FIELD_SQL, [
      input.entityId,
      field.fieldName,
      serializeCell(field.value),
      field.ownership,
      ...fenceParameters(fence),
    ]);
    if (result.changes !== 1) {
      await throwFenceIfLostWithSql(sql, fence);
      return {
        kind: CANONICAL_COMMIT_RESULT_KINDS.STALE,
        target: CANONICAL_COMMIT_STALE_TARGETS.FIELD,
        fieldName: applicableFieldName(field.fieldName),
      };
    }
    fieldRevisions.set(field.fieldName, 1);
  }

  return {
    kind: CANONICAL_COMMIT_RESULT_KINDS.APPLIED,
    entityRevision: 1,
    fieldRevisions,
  };
}

async function applyUpdateWithSql(
  sql: SqlExecutor,
  fence: FencingContext,
  input: CanonicalUpdateCommitInput,
): Promise<CanonicalCommitResult> {
  const entity = await sql.get<{ readonly entity_revision: number }>(
    READ_CANONICAL_ENTITY_SQL,
    [input.entityId],
  );
  if (entity === undefined) {
    return {
      kind: CANONICAL_COMMIT_RESULT_KINDS.STALE,
      target: CANONICAL_COMMIT_STALE_TARGETS.ENTITY,
      fieldName: notApplicableFieldName(),
    };
  }

  const fieldRevisions = new Map<string, number>();
  for (const field of input.fields) {
    const expectedFieldRevision = requireApplicableRevision(field.expectedFieldRevision);
    const result = await sql.run(UPDATE_CANONICAL_FIELD_SQL, [
      serializeCell(field.value),
      input.entityId,
      field.fieldName,
      expectedFieldRevision,
      field.ownership,
      ...fenceParameters(fence),
    ]);
    if (result.changes !== 1) {
      await throwFenceIfLostWithSql(sql, fence);
      return {
        kind: CANONICAL_COMMIT_RESULT_KINDS.STALE,
        target: CANONICAL_COMMIT_STALE_TARGETS.FIELD,
        fieldName: applicableFieldName(field.fieldName),
      };
    }
    fieldRevisions.set(field.fieldName, expectedFieldRevision + 1);
  }

  const nextEntityRevision = entity.entity_revision + 1;
  const entityResult = await sql.run(UPDATE_CANONICAL_ENTITY_SQL, [
    nextEntityRevision,
    toSqlNullable(input.acceptedSnapshotHash),
    input.entityId,
    entity.entity_revision,
    ...fenceParameters(fence),
  ]);
  if (entityResult.changes !== 1) return lostFenceOrStaleEntityWithSql(sql, fence);

  return {
    kind: CANONICAL_COMMIT_RESULT_KINDS.APPLIED,
    entityRevision: nextEntityRevision,
    fieldRevisions,
  };
}

async function applyDeleteWithSql(
  sql: SqlExecutor,
  fence: FencingContext,
  input: CanonicalDeleteCommitInput,
): Promise<CanonicalCommitResult> {
  const nextEntityRevision = input.expectedEntityRevision + 1;
  const result = await sql.run(DELETE_CANONICAL_ENTITY_SQL, [
    nextEntityRevision,
    toSqlNullable(input.acceptedSnapshotHash),
    input.entityId,
    input.expectedEntityRevision,
    ...fenceParameters(fence),
  ]);
  if (result.changes !== 1) return lostFenceOrStaleEntityWithSql(sql, fence);

  return {
    kind: CANONICAL_COMMIT_RESULT_KINDS.APPLIED,
    entityRevision: nextEntityRevision,
    fieldRevisions: new Map(),
  };
}

function validateInput(input: CanonicalCommitInput): Presence<string> {
  if (input.entityId.length === 0) return presentError("entity ID is required");
  if (input.kind === ROW_OPERATIONS.DELETE) {
    return Number.isSafeInteger(input.expectedEntityRevision) && input.expectedEntityRevision >= 1
      ? absentError()
      : presentError("delete must have a positive expected entity revision");
  }
  if (input.fields.length === 0) return presentError("at least one accepted field is required");

  const fieldNames = new Set<string>();
  for (const field of input.fields) {
    if (field.fieldName.length === 0 || fieldNames.has(field.fieldName)) {
      return presentError("field names must be non-empty and unique");
    }
    fieldNames.add(field.fieldName);

    if (input.kind === ROW_OPERATIONS.INSERT &&
      field.expectedFieldRevision.kind !== APPLICABILITY_KINDS.NOT_APPLICABLE) {
      return presentError("insert fields must not have an expected revision");
    }
    if (
      input.kind === ROW_OPERATIONS.UPDATE &&
      (field.expectedFieldRevision.kind !== APPLICABILITY_KINDS.APPLICABLE ||
        !Number.isSafeInteger(field.expectedFieldRevision.value) ||
        field.expectedFieldRevision.value < 1)
    ) {
      return presentError("update fields must have a positive expected revision");
    }
  }
  return absentError();
}

function fenceParameters(fence: FencingContext): readonly [string, number, string, number] {
  return [fence.role, fence.writerEpoch, fence.fencingToken, fence.now];
}

function serializeCell(value: NormalizedCell): string {
  return JSON.stringify(value);
}

async function lostFenceOrStaleEntityWithSql(
  sql: SqlExecutor,
  fence: FencingContext,
): Promise<CanonicalCommitResult> {
  return (await isFencingValidWithSql(sql, fence))
    ? {
        kind: CANONICAL_COMMIT_RESULT_KINDS.STALE,
        target: CANONICAL_COMMIT_STALE_TARGETS.ENTITY,
        fieldName: notApplicableFieldName(),
      }
    : { kind: CANONICAL_COMMIT_RESULT_KINDS.FENCED_OUT };
}

function requireApplicableRevision(revision: Applicability<number>): number {
  if (revision.kind !== APPLICABILITY_KINDS.APPLICABLE) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_OBSERVATION_INPUT,
      "an update field must carry an applicable expected revision",
    );
  }
  return revision.value;
}

function applicableFieldName(fieldName: string): Applicability<string> {
  return { kind: APPLICABILITY_KINDS.APPLICABLE, value: fieldName };
}

function notApplicableFieldName(): Applicability<string> {
  return { kind: APPLICABILITY_KINDS.NOT_APPLICABLE };
}

function presentError(value: string): Presence<string> {
  return { kind: PRESENCE_KINDS.PRESENT, value };
}

function absentError(): Presence<string> {
  return { kind: PRESENCE_KINDS.ABSENT };
}

async function throwFenceIfLostWithSql(sql: SqlExecutor, fence: FencingContext): Promise<void> {
  if (!(await isFencingValidWithSql(sql, fence))) throw new AsyncFenceLostError();
}

/** Internal control-flow signal that rolls the async canonical savepoint back. */
class AsyncFenceLostError extends Error {}
