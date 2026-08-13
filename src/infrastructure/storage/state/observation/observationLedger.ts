/**
 * Append-only observation and event ledger operations.
 *
 * These helpers run within the observation writer's already-fenced immediate
 * transaction. They do not perform canonical or conflict mutation themselves.
 */

import { randomUUID } from "node:crypto";
import { stableHash } from "../../../../shared/encoding/stableEncode.js";
import type {
  FieldConflict,
} from "../../../../domain/evaluate/contracts.js";
import type {
  ObservedEditBatch,
  ObservedRowChange,
  NormalizedRow,
} from "../../../../domain/model/types.js";
import type {
  Presence,
  LookupResult,
} from "../../../../shared/state/types.js";
import { LOOKUP_RESULT_KINDS } from "../../../../shared/state/constants.js";
import { ROW_OUTCOMES } from "../../../../domain/evaluate/constants.js";
import { PRESENCE_KINDS } from "../../../../shared/state/constants.js";
import {
  CONFLICT_STATUSES,
  ROW_BINDING_STATES,
  ROW_OPERATIONS,
} from "../../../../domain/model/constants.js";
import { STORAGE_ERROR_CODES, StorageError } from "../../errors.js";
import { EMPTY_ARRAY_LENGTH_ZERO } from "../../constants.js";
import { fromSqlNullable, toSqlNullable } from "../../sqlite/sqlState.js";
import type { SqlExecutor } from "../../../../adapter/persistence/contracts/sql.js";
import {
  OBSERVATION_APPEND_RESULT_KINDS,
  OBSERVATION_RECEIPT_STATES,
  type ObservationCompletionState,
} from "./observationConstants.js";
import { auditJson, rowHash } from "./observationAudit.js";
import type {
  ActiveCandidateRow,
  CreatedEvent,
  EventRow,
  ObservationAppendResult,
  ObservationAttemptInput,
  PersistObservedRowInput,
  ReceiptRow,
  RowBindingRow,
} from "./observationTypes.js";

interface SqlRowBindingRow {
  readonly entity_id: string | null;
  readonly state: RowBindingRow["state"];
}

interface EventSequenceRow {
  readonly next_sequence: number;
}

interface EventBatchRow {
  readonly logical_sheet_id: string;
  readonly physical_sheet_id: string;
  readonly source: string;
  readonly projection: string;
  readonly atomicity: string;
  readonly base_snapshot_hash: string;
}

/** Returns the before snapshot, using SQL null only for insert rows. */
function observedBeforeRow(row: ObservedRowChange): NormalizedRow | null {
  switch (row.operation) {
    case ROW_OPERATIONS.INSERT:
      return null;
    case ROW_OPERATIONS.UPDATE:
    case ROW_OPERATIONS.RENAME:
    case ROW_OPERATIONS.DELETE:
      return row.beforeRow;
  }
}

/** Returns the after snapshot, using SQL null only for delete rows. */
function observedAfterRow(row: ObservedRowChange): NormalizedRow | null {
  switch (row.operation) {
    case ROW_OPERATIONS.INSERT:
    case ROW_OPERATIONS.UPDATE:
    case ROW_OPERATIONS.RENAME:
      return row.afterRow;
    case ROW_OPERATIONS.DELETE:
      return null;
  }
}

/**
 * Appends an observation occurrence through the active async SQL transaction
 * and classifies receipt replay semantics without leaking SQL nullability.
 */
export async function appendObservationWithSql(
  sql: SqlExecutor,
  batch: ObservedEditBatch,
  physicalSheetId: string,
  observation: ObservationAttemptInput,
): Promise<ObservationAppendResult> {
  const receipt = await sql.get<ReceiptRow>(READ_OBSERVATION_RECEIPT_SQL, [
    batch.sheetId,
    observation.observationKey,
  ]);

  const samePayload = receipt !== undefined &&
    receipt.representative_payload_hash === observation.payloadHash;
  const linkedEventId = samePayload ? receipt.event_id : null;
  await sql.run(INSERT_EVENT_OBSERVATION_SQL, [
    observation.observationId,
    batch.sheetId,
    physicalSheetId,
    observation.observationKey,
    linkedEventId,
    batch.source,
    observation.payloadJson,
    observation.payloadHash,
    observation.detectedAt,
    observation.receivedAt,
    observation.ingressActorId,
    toSqlNullable(observation.editorActorId),
    observation.editorActorSource,
  ]);

  if (receipt === undefined) {
    await sql.run(INSERT_OBSERVATION_RECEIPT_SQL, [
      batch.sheetId,
      observation.observationKey,
      observation.payloadHash,
      observation.observationId,
      observation.observationId,
      observation.receivedAt,
      observation.receivedAt,
    ]);
    return {
      kind: OBSERVATION_APPEND_RESULT_KINDS.NEW,
      eventId: fromSqlNullable<string>(null),
    };
  }

  const nextState = !samePayload
    ? receipt.state
    : receipt.state === OBSERVATION_RECEIPT_STATES.PENDING
      ? OBSERVATION_RECEIPT_STATES.PENDING
      : receipt.state === OBSERVATION_RECEIPT_STATES.QUARANTINED
        ? OBSERVATION_RECEIPT_STATES.QUARANTINED
        : OBSERVATION_RECEIPT_STATES.DUPLICATE;
  await sql.run(UPDATE_OBSERVATION_RECEIPT_REPLAY_SQL, [
    observation.observationId,
    observation.receivedAt,
    nextState,
    batch.sheetId,
    observation.observationKey,
  ]);

  if (!samePayload) {
    return {
      kind: OBSERVATION_APPEND_RESULT_KINDS.INTEGRITY_COLLISION,
      eventId: fromSqlNullable<string>(null),
    };
  }
  if (receipt.state === OBSERVATION_RECEIPT_STATES.PENDING && receipt.event_id === null) {
    return {
      kind: OBSERVATION_APPEND_RESULT_KINDS.PENDING_REPLAY,
      eventId: fromSqlNullable<string>(null),
    };
  }
  return {
    kind: OBSERVATION_APPEND_RESULT_KINDS.DUPLICATE,
    eventId: fromSqlNullable(receipt.event_id),
  };
}

/** Completes one observation receipt through the active async SQL transaction. */
export async function completeObservationWithSql(
  sql: SqlExecutor,
  logicalSheetId: string,
  observation: ObservationAttemptInput,
  eventId: Presence<string>,
  state: ObservationCompletionState,
): Promise<void> {
  await sql.run(UPDATE_EVENT_OBSERVATION_EVENT_SQL, [
    toSqlNullable(eventId),
    observation.observationId,
  ]);
  await sql.run(COMPLETE_OBSERVATION_RECEIPT_SQL, [
    toSqlNullable(eventId),
    state,
    logicalSheetId,
    observation.observationKey,
  ]);
}

/** Requires a row binding through the active async SQL transaction. */
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
    entity_id: fromSqlNullable(binding.entity_id),
    state: binding.state,
  };
}

/** Finds an unchanged active conflict candidate through the active async SQL transaction. */
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

/** Reads the active candidate through the active async SQL transaction. */
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

/** Finds an idempotent event key through the active async SQL transaction. */
export async function findEventByKeyWithSql(
  sql: SqlExecutor,
  logicalSheetId: string,
  eventKey: string,
): Promise<LookupResult<EventRow>> {
  const event = await sql.get<EventRow>(READ_EVENT_BY_KEY_SQL, [logicalSheetId, eventKey]);
  return event === undefined
    ? { kind: LOOKUP_RESULT_KINDS.NOT_FOUND }
    : { kind: LOOKUP_RESULT_KINDS.FOUND, value: event };
}

/** Creates the event and its evidence through the active async SQL transaction. */
export async function createEventWithSql(
  sql: SqlExecutor,
  input: PersistObservedRowInput,
  row: ObservedRowChange,
): Promise<CreatedEvent> {
  const eventIdentity = input.event;
  if (eventIdentity.kind === PRESENCE_KINDS.ABSENT) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_OBSERVATION_INPUT,
      "cannot create an event without an identity",
    );
  }
  const event = eventIdentity.value;
  await ensureEventBatchWithSql(sql, input);

  const sequenceRow = await sql.get<EventSequenceRow>(READ_NEXT_EVENT_SEQUENCE_SQL, [
    input.batch.sheetId,
  ]);
  const eventSequence = sequenceRow?.next_sequence;
  if (eventSequence === undefined || !Number.isSafeInteger(eventSequence)) {
    throw new StorageError(
      STORAGE_ERROR_CODES.OBSERVATION_STORAGE_INCONSISTENT,
      "could not allocate the next event sequence",
    );
  }

  const eventId = `event:${randomUUID()}`;
  const status = input.evaluation.outcome === ROW_OUTCOMES.QUARANTINE
    ? "quarantined"
    : input.evaluation.conflicts.length > 0
      ? ROW_OUTCOMES.CONFLICT
      : ROW_OUTCOMES.ACCEPTED;
  await sql.run(INSERT_EVENT_LOG_SQL, [
    eventId,
    input.batch.sheetId,
    input.physicalSheetId,
    event.eventKey,
    event.payloadHash,
    eventSequence,
    input.batch.batchId,
    row.rowBindingId,
    row.operation,
    status,
    input.observation.receivedAt,
  ]);
  const beforeRow = observedBeforeRow(row);
  const afterRow = observedAfterRow(row);
  await sql.run(INSERT_EVENT_ROW_SQL, [
    eventId,
    auditJson(beforeRow),
    auditJson(afterRow),
    rowHash(beforeRow, row.rowBindingId),
    rowHash(afterRow, row.rowBindingId),
  ]);
  for (const field of row.fields) {
    await sql.run(INSERT_EVENT_FIELD_SQL, [
      eventId,
      field.fieldName,
      auditJson(field.previousValue),
      auditJson(field.nextValue),
      field.baseFieldRevision === undefined ? null : field.baseFieldRevision,
    ]);
  }
  return { eventId, eventSequence };
}

/** Updates observed row and field hashes through the active async SQL transaction. */
export async function persistObservedHashesWithSql(
  sql: SqlExecutor,
  input: PersistObservedRowInput,
  row: ObservedRowChange,
): Promise<void> {
  await sql.run(UPDATE_VISIBLE_ROW_OBSERVED_HASH_SQL, [
    rowHash(observedAfterRow(row), row.rowBindingId),
    input.physicalSheetId,
    input.batch.projection,
    row.rowBindingId,
  ]);
  for (const field of row.fields) {
    await sql.run(UPDATE_VISIBLE_FIELD_OBSERVED_HASH_SQL, [
      stableHash(field.nextValue),
      input.physicalSheetId,
      input.batch.projection,
      row.rowBindingId,
      field.fieldName,
    ]);
  }
}

/** Produces the idempotency hash for a visible unresolved field candidate. */
export function candidateHash(conflict: FieldConflict): string {
  return stableHash({ value: conflict.userValue, revision: conflict.userBaseRevision });
}

/** Creates or verifies the idempotent batch identity through active async SQL. */
async function ensureEventBatchWithSql(
  sql: SqlExecutor,
  input: PersistObservedRowInput,
): Promise<void> {
  const existing = await sql.get<EventBatchRow>(READ_EVENT_BATCH_SQL, [input.batch.batchId]);
  if (existing !== undefined) {
    const matches = existing.logical_sheet_id === input.batch.sheetId &&
      existing.physical_sheet_id === input.physicalSheetId &&
      existing.source === input.batch.source &&
      existing.projection === input.batch.projection &&
      existing.atomicity === input.batch.atomicity &&
      existing.base_snapshot_hash === input.batch.baseSnapshotHash;
    if (!matches) {
      throw new StorageError(
        STORAGE_ERROR_CODES.OBSERVATION_STORAGE_INCONSISTENT,
        "batch ID was replayed with different batch identity",
      );
    }
    return;
  }

  await sql.run(INSERT_EVENT_BATCH_SQL, [
    input.batch.batchId,
    input.batch.sheetId,
    input.physicalSheetId,
    input.batch.source,
    input.batch.projection,
    input.batch.atomicity,
    input.batch.baseSnapshotHash,
  ]);
}


const READ_OBSERVATION_RECEIPT_SQL = `
  SELECT representative_payload_hash, event_id, state
  FROM observation_receipt
  WHERE logical_sheet_id = ? AND observation_key = ?
`;

const INSERT_EVENT_OBSERVATION_SQL = `
  INSERT INTO event_observation (
    observation_id, logical_sheet_id, physical_sheet_id, observation_key, event_id,
    source, payload_json, payload_hash, detected_at, received_at, ingress_actor_id,
    editor_actor_id, editor_actor_source
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const INSERT_OBSERVATION_RECEIPT_SQL = `
  INSERT INTO observation_receipt (
    logical_sheet_id, observation_key, representative_payload_hash,
    first_observation_id, last_observation_id, event_id, state,
    first_seen_at, last_seen_at
  ) VALUES (?, ?, ?, ?, ?, NULL, '${OBSERVATION_RECEIPT_STATES.PENDING}', ?, ?)
`;

const UPDATE_OBSERVATION_RECEIPT_REPLAY_SQL = `
  UPDATE observation_receipt
  SET last_observation_id = ?, last_seen_at = ?, state = ?
  WHERE logical_sheet_id = ? AND observation_key = ?
`;

const UPDATE_EVENT_OBSERVATION_EVENT_SQL = `
  UPDATE event_observation
  SET event_id = ?
  WHERE observation_id = ?
`;

const COMPLETE_OBSERVATION_RECEIPT_SQL = `
  UPDATE observation_receipt
  SET event_id = ?, state = ?
  WHERE logical_sheet_id = ? AND observation_key = ?
`;

const READ_ROW_BINDING_SQL = `
  SELECT entity_id, state
  FROM row_binding
  WHERE row_binding_id = ? AND logical_sheet_id = ?
`;

const READ_ACTIVE_CANDIDATE_SQL = `
  SELECT visible.active_candidate_conflict_id, visible.active_candidate_hash,
         visible.candidate_epoch, conflict.event_id, conflict.status
  FROM sheet_visible_field_state AS visible
  JOIN sync_conflict AS conflict
    ON conflict.conflict_id = visible.active_candidate_conflict_id
  WHERE visible.physical_sheet_id = ? AND visible.projection = ?
    AND visible.row_binding_id = ? AND visible.field_name = ?
    AND visible.active_candidate_conflict_id IS NOT NULL
    AND visible.active_candidate_hash IS NOT NULL
`;

const READ_EVENT_BY_KEY_SQL = `
  SELECT event_id, payload_hash, event_sequence
  FROM event_log
  WHERE logical_sheet_id = ? AND event_key = ?
`;

const READ_NEXT_EVENT_SEQUENCE_SQL = `
  SELECT COALESCE(MAX(event_sequence), 0) + 1 AS next_sequence
  FROM event_log
  WHERE logical_sheet_id = ?
`;

const INSERT_EVENT_LOG_SQL = `
  INSERT INTO event_log (
    event_id, logical_sheet_id, physical_sheet_id, event_key, payload_hash,
    event_sequence, batch_id, row_binding_id, operation, status, received_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const INSERT_EVENT_ROW_SQL = `
  INSERT INTO event_row (event_id, before_row_json, after_row_json, before_hash, after_hash)
  VALUES (?, ?, ?, ?, ?)
`;

const INSERT_EVENT_FIELD_SQL = `
  INSERT INTO event_field (
    event_id, field_name, previous_value, next_value, base_field_revision
  ) VALUES (?, ?, ?, ?, ?)
`;

const UPDATE_VISIBLE_ROW_OBSERVED_HASH_SQL = `
  UPDATE sheet_visible_state
  SET last_observed_hash = ?
  WHERE physical_sheet_id = ? AND projection = ? AND row_binding_id = ?
`;

const UPDATE_VISIBLE_FIELD_OBSERVED_HASH_SQL = `
  UPDATE sheet_visible_field_state
  SET last_observed_field_hash = ?
  WHERE physical_sheet_id = ? AND projection = ?
    AND row_binding_id = ? AND field_name = ?
`;

const READ_EVENT_BATCH_SQL = `
  SELECT logical_sheet_id, physical_sheet_id, source, projection, atomicity, base_snapshot_hash
  FROM event_batch
  WHERE batch_id = ?
`;

const INSERT_EVENT_BATCH_SQL = `
  INSERT INTO event_batch (
    batch_id, logical_sheet_id, physical_sheet_id, source, projection, atomicity, base_snapshot_hash
  ) VALUES (?, ?, ?, ?, ?, ?, ?)
`;
