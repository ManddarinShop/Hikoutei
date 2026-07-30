/** Creates and reads durable observation events through the active SQL transaction. */

import { randomUUID } from "node:crypto";
import {
  type LookupResult,
  type ObservedRowChange,
  LOOKUP_RESULT_KINDS,
} from "../../../../domain/index.js";
import { ROW_OUTCOMES } from "../../../../domain/evaluate/constants.js";
import { PRESENCE_KINDS } from "../../../../shared/state/constants.js";
import { STORAGE_ERROR_CODES, StorageError } from "../../errors.js";
import type { SqlExecutor } from "../../../../adapter/persistence/contracts/sql.js";
import { auditJson, rowHash } from "./observationAudit.js";
import type {
  CreatedEvent,
  EventRow,
  PersistObservedRowInput,
} from "./observationTypes.js";
import {
  INSERT_EVENT_BATCH_SQL,
  INSERT_EVENT_FIELD_SQL,
  INSERT_EVENT_LOG_SQL,
  INSERT_EVENT_ROW_SQL,
  READ_EVENT_BATCH_SQL,
  READ_EVENT_BY_KEY_SQL,
  READ_NEXT_EVENT_SEQUENCE_SQL,
} from "./observationLedgerSql.js";
import { observedAfterRow, observedBeforeRow } from "./observationLedgerRows.js";

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

/** Finds an idempotent event key through the active SQL transaction. */
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

/** Creates an event, its row evidence, and its field evidence. */
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
