/** Persists observation receipts and links them to completed events. */

import {
  type ObservedEditBatch,
  type Presence,
} from "../../../../domain/index.js";
import { fromSqlNullable, toSqlNullable } from "../../sqlite/sqlState.js";
import type { SqlExecutor } from "../../../../adapter/persistence/contracts/sql.js";
import {
  OBSERVATION_APPEND_RESULT_KINDS,
  OBSERVATION_RECEIPT_STATES,
  type ObservationCompletionState,
} from "./observationConstants.js";
import type {
  ObservationAppendResult,
  ObservationAttemptInput,
  ReceiptRow,
} from "./observationTypes.js";
import {
  COMPLETE_OBSERVATION_RECEIPT_SQL,
  INSERT_EVENT_OBSERVATION_SQL,
  INSERT_OBSERVATION_RECEIPT_SQL,
  READ_OBSERVATION_RECEIPT_SQL,
  UPDATE_EVENT_OBSERVATION_EVENT_SQL,
  UPDATE_OBSERVATION_RECEIPT_REPLAY_SQL,
} from "./observationLedgerSql.js";

/** Appends an observation occurrence and classifies receipt replay semantics. */
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

/** Completes an observation receipt and links the resulting event, if any. */
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
