/** Reads row bindings and active conflict candidates for observation dedupe. */

import {
  stableHash,
  type FieldConflict,
  type LookupResult,
  type ObservedRowChange,
  LOOKUP_RESULT_KINDS,
} from "../../../../domain/index.js";
import { ROW_OUTCOMES } from "../../../../domain/evaluate/constants.js";
import {
  CONFLICT_STATUSES,
  ROW_BINDING_STATES,
} from "../../../../domain/model/constants.js";
import { PRESENCE_KINDS } from "../../../../shared/state/constants.js";
import { STORAGE_ERROR_CODES, StorageError } from "../../errors.js";
import { EMPTY_ARRAY_LENGTH_ZERO } from "../../constants.js";
import type { SqlExecutor } from "../../../../adapter/persistence/contracts/sql.js";
import type {
  ActiveCandidateRow,
  PersistObservedRowInput,
  RowBindingRow,
} from "./observationTypes.js";
import {
  READ_ACTIVE_CANDIDATE_SQL,
  READ_ROW_BINDING_SQL,
} from "./observationLedgerSql.js";

interface SqlRowBindingRow {
  readonly entity_id: string | null;
  readonly state: RowBindingRow["state"];
}

/** Requires a known row binding for an event-bearing observation. */
export async function requireKnownBindingWithSql(
  sql: SqlExecutor,
  logicalSheetId: string,
  rowBindingId: string,
): Promise<RowBindingRow> {
  const binding = await sql.get<SqlRowBindingRow>(READ_ROW_BINDING_SQL, [
    rowBindingId,
    logicalSheetId,
  ]);
  if (binding === undefined) {
    throw new StorageError(
      STORAGE_ERROR_CODES.OBSERVATION_STORAGE_INCONSISTENT,
      "event-bearing observations require a known row binding",
    );
  }
  return {
    entity_id: binding.entity_id === null
      ? { kind: PRESENCE_KINDS.ABSENT }
      : { kind: PRESENCE_KINDS.PRESENT, value: binding.entity_id },
    state: binding.state,
  };
}

/** Finds an unchanged active conflict candidate for an observed row. */
export async function findMatchingCandidateEventIdWithSql(
  sql: SqlExecutor,
  input: PersistObservedRowInput,
  row: ObservedRowChange,
  binding: RowBindingRow,
): Promise<LookupResult<string>> {
  if (
    input.evaluation.outcome === ROW_OUTCOMES.QUARANTINE ||
    input.evaluation.acceptedFields.length > 0 ||
    input.evaluation.conflicts.length === EMPTY_ARRAY_LENGTH_ZERO ||
    binding.state !== ROW_BINDING_STATES.ACTIVE ||
    binding.entity_id.kind === PRESENCE_KINDS.ABSENT
  ) {
    return { kind: LOOKUP_RESULT_KINDS.NOT_FOUND };
  }

  const eventIds = new Set<string>();
  for (const conflict of input.evaluation.conflicts) {
    const active = await readActiveCandidateWithSql(
      sql,
      input.physicalSheetId,
      input.batch.projection,
      row.rowBindingId,
      conflict.fieldName,
    );
    if (
      active.kind === LOOKUP_RESULT_KINDS.NOT_FOUND ||
      (active.value.status !== CONFLICT_STATUSES.OPEN &&
        active.value.status !== CONFLICT_STATUSES.NEEDS_REBASE) ||
      active.value.active_candidate_hash !== candidateHash(conflict)
    ) {
      return { kind: LOOKUP_RESULT_KINDS.NOT_FOUND };
    }
    eventIds.add(active.value.event_id);
  }
  if (eventIds.size !== 1) return { kind: LOOKUP_RESULT_KINDS.NOT_FOUND };
  const eventId = [...eventIds][0];
  return eventId === undefined
    ? { kind: LOOKUP_RESULT_KINDS.NOT_FOUND }
    : { kind: LOOKUP_RESULT_KINDS.FOUND, value: eventId };
}

/** Reads the active candidate pointer for one visible field. */
export async function readActiveCandidateWithSql(
  sql: SqlExecutor,
  physicalSheetId: string,
  projection: string,
  rowBindingId: string,
  fieldName: string,
): Promise<LookupResult<ActiveCandidateRow>> {
  const candidate = await sql.get<ActiveCandidateRow>(READ_ACTIVE_CANDIDATE_SQL, [
    physicalSheetId,
    projection,
    rowBindingId,
    fieldName,
  ]);
  return candidate === undefined
    ? { kind: LOOKUP_RESULT_KINDS.NOT_FOUND }
    : { kind: LOOKUP_RESULT_KINDS.FOUND, value: candidate };
}

/** Produces the idempotency hash for a visible unresolved field candidate. */
export function candidateHash(conflict: FieldConflict): string {
  return stableHash({ value: conflict.userValue, revision: conflict.userBaseRevision });
}
