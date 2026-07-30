/** Persists conflict candidates created by an evaluated observed row. */

import {
  LOOKUP_RESULT_KINDS,
  PRESENCE_KINDS,
  stableHash,
  type ObservedRowChange,
  type Presence,
} from "../../../../domain/index.js";
import { ROW_BINDING_STATES, CONFLICT_STATUSES } from "../../../../domain/model/constants.js";
import { STORAGE_ERROR_CODES, StorageError } from "../../errors.js";
import { EMPTY_ARRAY_LENGTH_ZERO } from "../../constants.js";
import { fromSqlNullable, toSqlNullable } from "../../sqlite/sqlState.js";
import type { SqlExecutor } from "../../../../adapter/persistence/contracts/sql.js";
import { auditJson } from "./observationAudit.js";
import { candidateHash, readActiveCandidateWithSql } from "./observationLedger.js";
import type {
  PersistObservedRowInput,
  RowBindingRow,
} from "./observationTypes.js";
import {
  ADVANCE_ROW_BINDING_CANDIDATE_EPOCH_SQL,
  INSERT_SYNC_CONFLICT_SQL,
  READ_MAX_CANDIDATE_EPOCH_SQL,
  UPSERT_VISIBLE_FIELD_STATE_SQL,
} from "./observationCanonicalSql.js";

const INITIAL_CANDIDATE_EPOCH = 0;
const CONFLICT_ID_PREFIX = "conflict:" as const;

interface MaxCandidateEpochRow {
  readonly max_epoch: number | null;
}

/** Writes new field candidates and updates their active visible pointers. */
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
