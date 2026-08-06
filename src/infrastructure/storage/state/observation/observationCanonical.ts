/**
 * Canonical-state and conflict-ledger mutations for one observed row.
 *
 * Every exported operation assumes its caller already holds the writer fence
 * and is inside the observation writer's immediate transaction.
 */

import {
  LOOKUP_RESULT_KINDS,
  PRESENCE_KINDS,
  stableHash,
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
import {
  EMPTY_ARRAY_LENGTH_ZERO,
  EXPECTED_SINGLE_ROW_CHANGE_COUNT,
} from "../../constants.js";
import { fromSqlNullable, toSqlNullable } from "../../sqlite/sqlState.js";
import {
  CANONICAL_COMMIT_RESULT_KINDS,
  commitCanonicalChangesWithSql,
  type CanonicalCommitInput,
} from "../canonical/canonicalCommit.js";
import type { SqlExecutor } from "../../../../adapter/persistence/contracts/sql.js";
import type { FencingContext } from "@hikoutei/outbox";
import { auditJson } from "./observationAudit.js";
import {
  candidateHash,
  readActiveCandidateWithSql,
} from "./observationLedger.js";
import {
  OBSERVED_PROJECTION_EVIDENCE_SOURCES,
  type AppliedCanonicalCommit,
  type CanonicalRowMutation,
  type PersistObservedRowInput,
  type RowBindingRow,
} from "./observationTypes.js";
import { CanonicalStaleError, FenceLostError } from "./observationTypes.js";

const INITIAL_CANDIDATE_EPOCH = 0;
const CONFLICT_ID_PREFIX = "conflict:";

const INSERT_SYNC_CONFLICT_SQL = `
  INSERT INTO sync_conflict (
    conflict_id, conflict_group_id, event_id, logical_sheet_id, entity_id, row_binding_id,
    field_name, user_value, user_base_revision, canonical_value_at_detection,
    canonical_revision_at_detection, current_canonical_value, current_canonical_revision,
    candidate_epoch, status, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '${CONFLICT_STATUSES.OPEN}', ?, ?)
`;

const UPSERT_VISIBLE_FIELD_STATE_SQL = `
  INSERT INTO sheet_visible_field_state (
    physical_sheet_id, projection, row_binding_id, field_name,
    confirmed_field_hash, confirmed_visible_revision,
    active_candidate_conflict_id, active_candidate_hash, candidate_epoch,
    last_observed_field_hash
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(physical_sheet_id, projection, row_binding_id, field_name)
  DO UPDATE SET
    active_candidate_conflict_id = excluded.active_candidate_conflict_id,
    active_candidate_hash = excluded.active_candidate_hash,
    candidate_epoch = excluded.candidate_epoch,
    last_observed_field_hash = excluded.last_observed_field_hash
`;

const READ_CONFIRMED_VISIBLE_STATE_SQL = `
  SELECT confirmed_snapshot_hash, confirmed_visible_revision
  FROM sheet_visible_state
  WHERE physical_sheet_id = ? AND projection = ? AND row_binding_id = ?
`;

const CONFIRM_SYNTHETIC_VISIBLE_STATE_SQL = `
  UPDATE sheet_visible_state
  SET confirmed_snapshot_hash = ?, confirmed_visible_revision = ?,
      confirmed_entity_revision = ?, last_observed_hash = ?
  WHERE physical_sheet_id = ? AND projection = ? AND row_binding_id = ?
    AND confirmed_visible_revision = ? AND confirmed_snapshot_hash = ?
`;

const CONFIRM_OBSERVED_VISIBLE_STATE_SQL = `
  INSERT INTO sheet_visible_state (
    physical_sheet_id, projection, row_binding_id, confirmed_snapshot_hash,
    confirmed_visible_revision, confirmed_entity_revision, last_observed_hash
  ) VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(physical_sheet_id, projection, row_binding_id)
  DO UPDATE SET
    confirmed_snapshot_hash = excluded.confirmed_snapshot_hash,
    confirmed_visible_revision = excluded.confirmed_visible_revision,
    confirmed_entity_revision = excluded.confirmed_entity_revision,
    last_observed_hash = excluded.last_observed_hash
  WHERE sheet_visible_state.confirmed_visible_revision <= excluded.confirmed_visible_revision
`;

const CONFIRM_OBSERVED_VISIBLE_FIELD_STATE_SQL = `
  INSERT INTO sheet_visible_field_state (
    physical_sheet_id, projection, row_binding_id, field_name,
    confirmed_field_hash, confirmed_visible_revision, candidate_epoch,
    last_observed_field_hash
  ) VALUES (?, ?, ?, ?, ?, ?, 0, ?)
  ON CONFLICT(physical_sheet_id, projection, row_binding_id, field_name)
  DO UPDATE SET
    confirmed_field_hash = excluded.confirmed_field_hash,
    confirmed_visible_revision = excluded.confirmed_visible_revision,
    last_observed_field_hash = excluded.last_observed_field_hash
  WHERE sheet_visible_field_state.confirmed_visible_revision <= excluded.confirmed_visible_revision
`;

const ADVANCE_ROW_BINDING_CANDIDATE_EPOCH_SQL = `
  UPDATE row_binding
  SET candidate_epoch = CASE
    WHEN candidate_epoch < ? THEN ?
    ELSE candidate_epoch
  END
  WHERE row_binding_id = ? AND logical_sheet_id = ?
`;

const ACTIVATE_INSERTED_ROW_BINDING_SQL = `
  UPDATE row_binding
  SET entity_id = ?, state = '${ROW_BINDING_STATES.ACTIVE}'
  WHERE row_binding_id = ? AND logical_sheet_id = ?
    AND state = '${ROW_BINDING_STATES.CANDIDATE}' AND entity_id IS NULL
`;

const TOMBSTONE_DELETED_ROW_BINDING_SQL = `
  UPDATE row_binding
  SET state = '${ROW_BINDING_STATES.TOMBSTONED}'
  WHERE row_binding_id = ? AND logical_sheet_id = ?
    AND state = '${ROW_BINDING_STATES.ACTIVE}' AND entity_id = ?
`;

const DEACTIVATE_ENTITY_BUSINESS_KEYS_SQL = `
  UPDATE business_key_index
  SET state = 'inactive'
  WHERE logical_sheet_id = ? AND entity_id = ? AND state = 'active'
`;

const RETIRE_BUSINESS_KEY_SQL = `
  UPDATE business_key_index
  SET state = 'inactive'
  WHERE logical_sheet_id = ? AND field_name = ? AND normalized_key = ?
    AND entity_id = ? AND state = 'active'
`;

const READ_ACTIVE_BUSINESS_KEY_SQL = `
  SELECT entity_id
  FROM business_key_index
  WHERE logical_sheet_id = ? AND field_name = ? AND normalized_key = ? AND state = 'active'
`;

const INSERT_ACTIVE_BUSINESS_KEY_SQL = `
  INSERT INTO business_key_index (
    logical_sheet_id, field_name, normalized_key, entity_id, state
  ) VALUES (?, ?, ?, ?, 'active')
`;

const REBASE_ACTIVE_CONFLICT_SQL = `
  UPDATE sync_conflict
  SET current_canonical_value = ?, current_canonical_revision = ?,
      status = '${CONFLICT_STATUSES.NEEDS_REBASE}', last_rebased_commit_id = ?, updated_at = ?
  WHERE conflict_id = ?
    AND status IN ('${CONFLICT_STATUSES.OPEN}', '${CONFLICT_STATUSES.NEEDS_REBASE}')
`;

const READ_MAX_CANDIDATE_EPOCH_SQL = `
  SELECT MAX(candidate_epoch) AS max_epoch
  FROM sync_conflict
  WHERE row_binding_id = ? AND field_name = ?
`;

interface ActiveBusinessKeyRow {
  readonly entity_id: string;
}

interface MaxCandidateEpochRow {
  readonly max_epoch: number | null;
}

type PersistedRowOutcome = Exclude<RowOutcome, typeof ROW_OUTCOMES.QUARANTINE>;

/** Creates a deterministic conflict ID from its event, field, and candidate epoch. */
function makeConflictId(
  eventId: string,
  rowBindingId: string,
  fieldName: string,
  candidateEpoch: number,
): string {
  return `${CONFLICT_ID_PREFIX}${stableHash({
    eventId,
    rowBindingId,
    fieldName,
    candidateEpoch,
  })}`;
}

/**
 * Applies canonical state and related binding/key/conflict changes through
 * the active async SQL transaction.
 */
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

/** Rejects synthetic evidence when the exact baseline read by polling changed. */
export async function assertObservedProjectionBaselineWithSql(
  sql: SqlExecutor,
  input: PersistObservedRowInput,
  row: ObservedRowChange,
): Promise<void> {
  const evidence = input.observedProjection;
  if (
    evidence?.source !== OBSERVED_PROJECTION_EVIDENCE_SOURCES.SYNTHETIC ||
    evidence.baseline === undefined
  ) return;
  const current = await sql.get<{
    readonly confirmed_snapshot_hash: string;
    readonly confirmed_visible_revision: number;
  }>(READ_CONFIRMED_VISIBLE_STATE_SQL, [
    input.physicalSheetId,
    input.batch.projection,
    row.rowBindingId,
  ]);
  if (
    current === undefined ||
    current.confirmed_visible_revision !== evidence.baseline.visibleRevision ||
    current.confirmed_snapshot_hash !== evidence.baseline.visibleHash
  ) {
    throw new CanonicalStaleError();
  }
}

/**
 * Advances the confirmed visible baseline after an accepted observation.
 *
 * Without this confirmation, the next User_Input edit appears older than the
 * canonical entity revision and is forced into a false conflict. Candidate
 * columns are deliberately preserved; only accepted observed fields advance.
 */
export async function confirmObservedProjectionWithSql(
  sql: SqlExecutor,
  input: PersistObservedRowInput,
  row: ObservedRowChange,
  entityRevision: number,
): Promise<void> {
  const evidence = input.observedProjection;
  if (evidence === undefined) return;

  const rowResult = evidence.source === OBSERVED_PROJECTION_EVIDENCE_SOURCES.SYNTHETIC &&
      evidence.baseline !== undefined
    ? await sql.run(CONFIRM_SYNTHETIC_VISIBLE_STATE_SQL, [
      evidence.visibleHash,
      evidence.visibleRevision,
      entityRevision,
      evidence.visibleHash,
      input.physicalSheetId,
      input.batch.projection,
      row.rowBindingId,
      evidence.baseline.visibleRevision,
      evidence.baseline.visibleHash,
    ])
    : await sql.run(CONFIRM_OBSERVED_VISIBLE_STATE_SQL, [
      input.physicalSheetId,
      input.batch.projection,
      row.rowBindingId,
      evidence.visibleHash,
      evidence.visibleRevision,
      entityRevision,
      evidence.visibleHash,
    ]);
  if (rowResult.changes !== 1) return;

  const acceptedFields = new Set(input.evaluation.acceptedFields.map((field) => field.fieldName));
  for (const field of row.fields) {
    if (!acceptedFields.has(field.fieldName)) continue;
    const fieldResult = await sql.run(CONFIRM_OBSERVED_VISIBLE_FIELD_STATE_SQL, [
      input.physicalSheetId,
      input.batch.projection,
      row.rowBindingId,
      field.fieldName,
      stableHash(field.nextValue),
      evidence.visibleRevision,
      stableHash(field.nextValue),
    ]);
    if (fieldResult.changes !== 1) return;
  }
}

/** Writes new field candidates through the active async SQL transaction. */
export async function persistConflictAttemptsWithSql(
  sql: SqlExecutor,
  input: PersistObservedRowInput,
  row: ObservedRowChange,
  binding: RowBindingRow,
  eventId: string,
): Promise<readonly string[]> {
  if (input.evaluation.conflicts.length === EMPTY_ARRAY_LENGTH_ZERO) return [];
  if (
    binding.state !== ROW_BINDING_STATES.ACTIVE ||
    binding.entity_id.kind !== PRESENCE_KINDS.PRESENT
  ) {
    throw new StorageError(
      STORAGE_ERROR_CODES.OBSERVATION_STORAGE_INCONSISTENT,
      "a conflict requires an active entity binding",
    );
  }

  const conflictIds: string[] = [];
  const conflictGroupId: Presence<string> = input.evaluation.conflicts.length > 1
    ? { kind: PRESENCE_KINDS.PRESENT, value: `conflict-group:${eventId}` }
    : { kind: PRESENCE_KINDS.ABSENT };
  for (const conflict of input.evaluation.conflicts) {
    const active = await readActiveCandidateWithSql(
      sql,
      input.physicalSheetId,
      input.batch.projection,
      row.rowBindingId,
      conflict.fieldName,
    );
    const hash = candidateHash(conflict);
    if (
      active.kind === LOOKUP_RESULT_KINDS.FOUND &&
      (active.value.status === CONFLICT_STATUSES.OPEN ||
        active.value.status === CONFLICT_STATUSES.NEEDS_REBASE) &&
      active.value.active_candidate_hash === hash
    ) {
      continue;
    }

    const previousEpoch = Math.max(
      active.kind === LOOKUP_RESULT_KINDS.FOUND
        ? active.value.candidate_epoch
        : INITIAL_CANDIDATE_EPOCH,
      await maxCandidateEpochWithSql(sql, row.rowBindingId, conflict.fieldName),
    );
    const candidateEpoch = previousEpoch + 1;
    const conflictId = makeConflictId(
      eventId,
      row.rowBindingId,
      conflict.fieldName,
      candidateEpoch,
    );
    await sql.run(INSERT_SYNC_CONFLICT_SQL, [
      conflictId,
      toSqlNullable(conflictGroupId),
      eventId,
      input.batch.sheetId,
      binding.entity_id.value,
      row.rowBindingId,
      conflict.fieldName,
      auditJson(conflict.userValue),
      conflict.userBaseRevision,
      auditJson(conflict.canonicalValue),
      conflict.canonicalRevision,
      auditJson(conflict.canonicalValue),
      conflict.canonicalRevision,
      candidateEpoch,
      input.observation.receivedAt,
      input.observation.receivedAt,
    ]);
    await sql.run(UPSERT_VISIBLE_FIELD_STATE_SQL, [
      input.physicalSheetId,
      input.batch.projection,
      row.rowBindingId,
      conflict.fieldName,
      stableHash(conflict.canonicalValue),
      row.baseVisibleRevision,
      conflictId,
      hash,
      candidateEpoch,
      stableHash(conflict.userValue),
    ]);
    await sql.run(ADVANCE_ROW_BINDING_CANDIDATE_EPOCH_SQL, [
      candidateEpoch,
      candidateEpoch,
      row.rowBindingId,
      input.batch.sheetId,
    ]);
    conflictIds.push(conflictId);
  }
  return conflictIds;
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

/** Transitions an inserted or deleted binding through the active async SQL transaction. */
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

/** Applies business-key ownership transitions through the active async SQL transaction. */
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

/** Ensures one business key is owned by the expected entity through active async SQL. */
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

/** Rebases unresolved candidates affected by a canonical commit through active async SQL. */
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

/** Reads the maximum conflict candidate epoch through the active async SQL transaction. */
async function maxCandidateEpochWithSql(
  sql: SqlExecutor,
  rowBindingId: string,
  fieldName: string,
): Promise<number> {
  const row = await sql.get<MaxCandidateEpochRow>(READ_MAX_CANDIDATE_EPOCH_SQL, [
    rowBindingId,
    fieldName,
  ]);
  if (row === undefined) {
    throw new StorageError(
      STORAGE_ERROR_CODES.OBSERVATION_STORAGE_INCONSISTENT,
      "candidate epoch aggregate query returned no row",
    );
  }
  const maxEpoch = fromSqlNullable(row.max_epoch);
  return maxEpoch.kind === PRESENCE_KINDS.PRESENT
    ? maxEpoch.value
    : INITIAL_CANDIDATE_EPOCH;
}
