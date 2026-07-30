/** Applies one state-specific canonical mutation through the active SQL transaction. */

import type { Applicability, NormalizedCell } from "../../../../domain/index.js";
import {
  APPLICABILITY_KINDS,
} from "../../../../shared/state/constants.js";
import { toSqlNullable } from "../../sqlite/sqlState.js";
import { isFencingValidWithSql } from "../../sync/shared/writerLease.js";
import type { FencingContext } from "../../sync/shared/writerLease.js";
import type { SqlExecutor } from "../../../../adapter/persistence/contracts/sql.js";
import { FENCE_EXISTS_SQL } from "../../sync/outbound/effectOutboxSql.js";
import {
  CANONICAL_COMMIT_RESULT_KINDS,
  CANONICAL_COMMIT_STALE_TARGETS,
} from "./canonicalCommitConstants.js";
import {
  requireApplicableRevision,
} from "./canonicalCommitValidation.js";
import type {
  CanonicalCommitResult,
  CanonicalDeleteCommitInput,
  CanonicalInsertCommitInput,
  CanonicalUpdateCommitInput,
} from "./canonicalCommit.js";

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

/** Applies an insert prepared by the domain evaluator. */
export async function applyCanonicalInsertWithSql(
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

/** Applies a field-level compare-and-set update prepared by the domain evaluator. */
export async function applyCanonicalUpdateWithSql(
  sql: SqlExecutor,
  fence: FencingContext,
  input: CanonicalUpdateCommitInput,
): Promise<CanonicalCommitResult> {
  const entity = await sql.get<{ readonly entity_revision: number }>(
    READ_CANONICAL_ENTITY_SQL,
    [input.entityId],
  );
  if (entity === undefined) return staleEntityResult();

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

/** Applies the explicit delete evidence as a canonical tombstone. */
export async function applyCanonicalDeleteWithSql(
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

function lostFenceOrStaleEntityWithSql(
  sql: SqlExecutor,
  fence: FencingContext,
): Promise<CanonicalCommitResult> {
  return isFencingValidWithSql(sql, fence).then((valid) =>
    valid ? staleEntityResult() : { kind: CANONICAL_COMMIT_RESULT_KINDS.FENCED_OUT });
}

function staleEntityResult(): CanonicalCommitResult {
  return {
    kind: CANONICAL_COMMIT_RESULT_KINDS.STALE,
    target: CANONICAL_COMMIT_STALE_TARGETS.ENTITY,
    fieldName: notApplicableFieldName(),
  };
}

function fenceParameters(fence: FencingContext): readonly [string, number, string, number] {
  return [fence.role, fence.writerEpoch, fence.fencingToken, fence.now];
}

function serializeCell(value: NormalizedCell): string {
  return JSON.stringify(value);
}

function applicableFieldName(fieldName: string): Applicability<string> {
  return { kind: APPLICABILITY_KINDS.APPLICABLE, value: fieldName };
}

function notApplicableFieldName(): Applicability<string> {
  return { kind: APPLICABILITY_KINDS.NOT_APPLICABLE };
}

async function throwFenceIfLostWithSql(sql: SqlExecutor, fence: FencingContext): Promise<void> {
  if (!(await isFencingValidWithSql(sql, fence))) throw new AsyncFenceLostError();
}

/** Internal control-flow signal that rolls the async canonical savepoint back. */
export class AsyncFenceLostError extends Error {}
