/** Applies canonical state, row-binding, and business-key transitions. */

import {
  LOOKUP_RESULT_KINDS,
  PRESENCE_KINDS,
  type ObservedRowChange,
  type Presence,
  type RowEvaluationResult,
  type RowOutcome,
} from "../../../../domain/index.js";
import { ROW_OUTCOMES } from "../../../../domain/evaluate/constants.js";
import {
  CONFLICT_STATUSES,
  ROW_BINDING_STATES,
  ROW_OPERATIONS,
} from "../../../../domain/model/constants.js";
import { STORAGE_ERROR_CODES, StorageError } from "../../errors.js";
import { EXPECTED_SINGLE_ROW_CHANGE_COUNT } from "../../constants.js";
import {
  CANONICAL_COMMIT_RESULT_KINDS,
  commitCanonicalChangesWithSql,
} from "../canonical/canonicalCommit.js";
import type { CanonicalCommitInput } from "../canonical/canonicalCommit.js";
import type { SqlExecutor } from "../../../../adapter/persistence/contracts/sql.js";
import type { FencingContext } from "../../sync/shared/writerLease.js";
import { auditJson } from "./observationAudit.js";
import { readActiveCandidateWithSql } from "./observationLedger.js";
import type {
  AppliedCanonicalCommit,
  CanonicalRowMutation,
  PersistObservedRowInput,
  RowBindingRow,
} from "./observationTypes.js";
import { CanonicalStaleError, FenceLostError } from "./observationTypes.js";
import {
  ACTIVATE_INSERTED_ROW_BINDING_SQL,
  DEACTIVATE_ENTITY_BUSINESS_KEYS_SQL,
  INSERT_ACTIVE_BUSINESS_KEY_SQL,
  READ_ACTIVE_BUSINESS_KEY_SQL,
  REBASE_ACTIVE_CONFLICT_SQL,
  RETIRE_BUSINESS_KEY_SQL,
  TOMBSTONE_DELETED_ROW_BINDING_SQL,
} from "./observationCanonicalSql.js";

interface ActiveBusinessKeyRow {
  readonly entity_id: string;
}

type PersistedRowOutcome = Exclude<RowOutcome, typeof ROW_OUTCOMES.QUARANTINE>;

/** Applies canonical state and its dependent binding/key transitions atomically. */
export async function applyCanonicalMutationWithSql(
  sql: SqlExecutor,
  fence: FencingContext,
  input: PersistObservedRowInput,
  row: ObservedRowChange,
  binding: RowBindingRow,
): Promise<Presence<AppliedCanonicalCommit>> {
  const needsCanonical = input.evaluation.acceptedFields.length > 0 ||
    (row.operation === ROW_OPERATIONS.DELETE &&
      input.evaluation.outcome === ROW_OUTCOMES.ACCEPTED);
  if (!needsCanonical) return { kind: PRESENCE_KINDS.ABSENT };

  if (input.canonical.kind === PRESENCE_KINDS.ABSENT) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_OBSERVATION_INPUT,
      "canonical mutation disappeared after validation",
    );
  }
  const mutation = input.canonical.value;
  assertCanonicalBinding(binding, mutation.commit);
  const result = await commitCanonicalChangesWithSql(sql, fence, mutation.commit);
  if (result.kind === CANONICAL_COMMIT_RESULT_KINDS.FENCED_OUT) throw new FenceLostError();
  if (result.kind === CANONICAL_COMMIT_RESULT_KINDS.STALE) throw new CanonicalStaleError();
  if (result.kind === CANONICAL_COMMIT_RESULT_KINDS.INVALID) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_OBSERVATION_INPUT,
      `canonical mutation was invalid: ${result.reason}`,
    );
  }

  await transitionBindingAfterCanonicalCommitWithSql(
    sql,
    input.batch.sheetId,
    row.rowBindingId,
    mutation.commit,
  );
  await applyBusinessKeyChangesWithSql(sql, input.batch.sheetId, mutation);
  await rebaseActiveConflictsWithSql(sql, input, row, mutation, result);
  return { kind: PRESENCE_KINDS.PRESENT, value: result };
}

/** Rejects an impossible persistence result before it becomes public output. */
export function requirePersistedOutcome(
  evaluation: RowEvaluationResult,
): PersistedRowOutcome {
  if (evaluation.outcome === ROW_OUTCOMES.QUARANTINE) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_OBSERVATION_INPUT,
      "a quarantined row cannot be reported as a persisted event outcome",
    );
  }
  return evaluation.outcome;
}

function assertCanonicalBinding(binding: RowBindingRow, commit: CanonicalCommitInput): void {
  if (commit.kind === ROW_OPERATIONS.INSERT) {
    if (
      binding.state !== ROW_BINDING_STATES.CANDIDATE ||
      binding.entity_id.kind !== PRESENCE_KINDS.ABSENT
    ) {
      throw new CanonicalStaleError();
    }
    return;
  }
  if (
    binding.state !== ROW_BINDING_STATES.ACTIVE ||
    binding.entity_id.kind !== PRESENCE_KINDS.PRESENT ||
    binding.entity_id.value !== commit.entityId
  ) {
    throw new CanonicalStaleError();
  }
}

async function transitionBindingAfterCanonicalCommitWithSql(
  sql: SqlExecutor,
  logicalSheetId: string,
  rowBindingId: string,
  commit: CanonicalCommitInput,
): Promise<void> {
  if (commit.kind === ROW_OPERATIONS.UPDATE) return;
  const result = commit.kind === ROW_OPERATIONS.INSERT
    ? await sql.run(ACTIVATE_INSERTED_ROW_BINDING_SQL, [commit.entityId, rowBindingId, logicalSheetId])
    : await sql.run(TOMBSTONE_DELETED_ROW_BINDING_SQL, [rowBindingId, logicalSheetId, commit.entityId]);
  if (result.changes !== EXPECTED_SINGLE_ROW_CHANGE_COUNT) {
    throw new CanonicalStaleError();
  }
}

async function applyBusinessKeyChangesWithSql(
  sql: SqlExecutor,
  logicalSheetId: string,
  mutation: CanonicalRowMutation,
): Promise<void> {
  const commit = mutation.commit;
  if (commit.kind === ROW_OPERATIONS.DELETE) {
    await sql.run(DEACTIVATE_ENTITY_BUSINESS_KEYS_SQL, [logicalSheetId, commit.entityId]);
    return;
  }

  for (const change of mutation.businessKeyChanges) {
    if (
      change.previousNormalizedKey.kind === PRESENCE_KINDS.PRESENT &&
      (change.nextNormalizedKey.kind === PRESENCE_KINDS.ABSENT ||
        change.previousNormalizedKey.value !== change.nextNormalizedKey.value)
    ) {
      const retired = await sql.run(RETIRE_BUSINESS_KEY_SQL, [
        logicalSheetId,
        change.fieldName,
        change.previousNormalizedKey.value,
        commit.entityId,
      ]);
      if (retired.changes !== EXPECTED_SINGLE_ROW_CHANGE_COUNT) {
        throw new CanonicalStaleError();
      }
    }

    if (change.nextNormalizedKey.kind === PRESENCE_KINDS.PRESENT) {
      await ensureActiveBusinessKeyWithSql(
        sql,
        logicalSheetId,
        change.fieldName,
        change.nextNormalizedKey.value,
        commit.entityId,
      );
    }
  }
}

async function ensureActiveBusinessKeyWithSql(
  sql: SqlExecutor,
  logicalSheetId: string,
  fieldName: string,
  normalizedKey: string,
  entityId: string,
): Promise<void> {
  const existing = await sql.get<ActiveBusinessKeyRow>(READ_ACTIVE_BUSINESS_KEY_SQL, [
    logicalSheetId,
    fieldName,
    normalizedKey,
  ]);
  if (existing !== undefined) {
    if (existing.entity_id !== entityId) throw new CanonicalStaleError();
    return;
  }
  await sql.run(INSERT_ACTIVE_BUSINESS_KEY_SQL, [
    logicalSheetId,
    fieldName,
    normalizedKey,
    entityId,
  ]);
}

async function rebaseActiveConflictsWithSql(
  sql: SqlExecutor,
  input: PersistObservedRowInput,
  row: ObservedRowChange,
  mutation: CanonicalRowMutation,
  result: AppliedCanonicalCommit,
): Promise<void> {
  if (mutation.commit.kind === ROW_OPERATIONS.DELETE) return;
  for (const field of mutation.commit.fields) {
    const nextRevision = result.fieldRevisions.get(field.fieldName);
    if (nextRevision === undefined) continue;
    const active = await readActiveCandidateWithSql(
      sql,
      input.physicalSheetId,
      input.batch.projection,
      row.rowBindingId,
      field.fieldName,
    );
    if (
      active.kind === LOOKUP_RESULT_KINDS.NOT_FOUND ||
      active.value.status === CONFLICT_STATUSES.RESOLVED
    ) continue;
    await sql.run(REBASE_ACTIVE_CONFLICT_SQL, [
      auditJson(field.value),
      nextRevision,
      mutation.commitId,
      input.observation.receivedAt,
      active.value.active_candidate_conflict_id,
    ]);
  }
}
