/**
 * Fenced observation-to-storage composer for the SQLite-authoritative phase.
 *
 * It persists one already-normalized, already-evaluated row per immediate
 * transaction. The focused modules it calls own validation, receipt/event
 * ledgering, canonical state, conflicts, and quarantine evidence.
 */

import {
  APPLICABILITY_KINDS,
  LOOKUP_RESULT_KINDS,
  PRESENCE_KINDS,
  type Applicability,
  type Presence,
} from "../../../../domain/index.js";
import { ROW_OUTCOMES } from "../../../../domain/evaluate/constants.js";
import { EMPTY_ARRAY_LENGTH_ZERO, EXPECTED_SINGLE_ROW_CHANGE_COUNT } from "../../constants.js";
import { STORAGE_ERROR_CODES, StorageError } from "../../errors.js";
import { appendPendingEffectsWithSql } from "../../sync/outbound/effectOutbox.js";
import type { NewEffect } from "../../sync/outbound/effectOutbox.js";
import { withSqlSavepoint } from "../../sqlite/sqlTransaction.js";
import {
  isFencingValidWithSql,
  type FencingContext,
} from "../../sync/shared/writerLease.js";
import {
  applyCanonicalMutationWithSql,
  assertObservedProjectionBaselineWithSql,
  confirmObservedProjectionWithSql,
  persistConflictAttemptsWithSql,
  requirePersistedOutcome,
} from "./observationCanonical.js";
import {
  appendObservationWithSql,
  completeObservationWithSql,
  createEventWithSql,
  findEventByKeyWithSql,
  findMatchingCandidateEventIdWithSql,
  persistObservedHashesWithSql,
  requireKnownBindingWithSql,
} from "./observationLedger.js";
import {
  persistIntegrityQuarantineWithSql,
  persistQuarantineWithSql,
} from "./observationQuarantine.js";
import {
  OBSERVATION_APPEND_RESULT_KINDS,
  OBSERVATION_COMPLETION_STATES,
  OBSERVATION_DUPLICATE_REASONS,
  OBSERVATION_INTEGRITY_DISCRIMINATORS,
  OBSERVATION_WRITE_RESULT_KINDS,
} from "./observationConstants.js";
import {
  CanonicalStaleError,
  FenceLostError,
  type PersistObservedRowInput,
  type PersistObservedRowResult,
} from "./observationTypes.js";
import {
  ensureEffectsTargetRegisteredWithSql,
  ensureRegisteredProjectionWithSql,
  requireBatchRow,
  validatePersistObservedRowInput,
} from "./observationValidation.js";
import type { SqlExecutor, SqlStorageAdapter } from "../../../../adapter/persistence/contracts/sql.js";

const UPDATE_EVENT_STATUS_SQL = `
  UPDATE event_log
  SET status = ?
  WHERE event_id = ?
`;

const ABSENT_EVENT_ID: Presence<string> = { kind: PRESENCE_KINDS.ABSENT };

export type {
  ObservationAttemptInput,
  EventIdentityInput,
  BusinessKeyChange,
  CanonicalRowMutation,
  ObservedProjectionEvidence,
  PersistObservedRowInput,
  PersistObservedRowResult,
} from "./observationTypes.js";

/**
 * Persists one normalized row outcome inside an already-active async SQL
 * transaction. It lets the caller keep a user entity mutation and its sync
 * records atomic.
 */
export async function persistObservedRowWithSql(
  sql: SqlExecutor,
  fence: FencingContext,
  input: PersistObservedRowInput,
): Promise<PersistObservedRowResult> {
  validatePersistObservedRowInput(input);
  if (!(await isFencingValidWithSql(sql, fence))) {
    return { kind: OBSERVATION_WRITE_RESULT_KINDS.FENCED_OUT };
  }

  try {
    return await withSqlSavepoint(sql, "persist_observed_row", async () => {
      await assertCurrentFenceWithSql(sql, fence);
      const row = requireBatchRow(input.batch, input.rowIndex);
      await ensureRegisteredProjectionWithSql(sql, input.batch, input.physicalSheetId);
      await ensureEffectsTargetRegisteredWithSql(sql, input.batch.sheetId, input.effects);
      if (input.canonical.kind === PRESENCE_KINDS.PRESENT) {
        await ensureEffectsTargetRegisteredWithSql(
          sql,
          input.batch.sheetId,
          input.canonical.value.commit.effects,
        );
      }

      const observation = await appendObservationWithSql(
        sql,
        input.batch,
        input.physicalSheetId,
        input.observation,
      );
      if (observation.kind === OBSERVATION_APPEND_RESULT_KINDS.DUPLICATE) {
        return {
          kind: OBSERVATION_WRITE_RESULT_KINDS.DUPLICATE,
          observationId: input.observation.observationId,
          eventId: observation.eventId,
          reason: OBSERVATION_DUPLICATE_REASONS.OBSERVATION,
        };
      }
      if (observation.kind === OBSERVATION_APPEND_RESULT_KINDS.INTEGRITY_COLLISION) {
        const quarantineId = await persistIntegrityQuarantineWithSql(
          sql,
          input,
          row,
          ABSENT_EVENT_ID,
          OBSERVATION_INTEGRITY_DISCRIMINATORS.OBSERVATION_KEY_PAYLOAD_MISMATCH,
        );
        return completeQuarantineWithSql(
          sql,
          fence,
          input,
          quarantineId,
          ABSENT_EVENT_ID,
          [],
        );
      }

      if (input.event.kind === PRESENCE_KINDS.ABSENT) {
        if (input.evaluation.outcome !== ROW_OUTCOMES.QUARANTINE) {
          throw new StorageError(
            STORAGE_ERROR_CODES.INVALID_OBSERVATION_INPUT,
            "an unresolved observation must have a core quarantine plan",
          );
        }
        const quarantineId = await persistQuarantineWithSql(
          sql,
          input,
          input.evaluation.quarantine,
          ABSENT_EVENT_ID,
        );
        return completeQuarantineWithSql(
          sql,
          fence,
          input,
          quarantineId,
          ABSENT_EVENT_ID,
          input.effects,
        );
      }

      const binding = await requireKnownBindingWithSql(
        sql,
        input.batch.sheetId,
        row.rowBindingId,
      );
      const matchingCandidateEventId = await findMatchingCandidateEventIdWithSql(
        sql,
        input,
        row,
        binding,
      );
      if (matchingCandidateEventId.kind === LOOKUP_RESULT_KINDS.FOUND) {
        await completeObservationWithSql(
          sql,
          input.batch.sheetId,
          input.observation,
          presentEventId(matchingCandidateEventId.value),
          OBSERVATION_COMPLETION_STATES.DUPLICATE,
        );
        return {
          kind: OBSERVATION_WRITE_RESULT_KINDS.DUPLICATE,
          observationId: input.observation.observationId,
          eventId: presentEventId(matchingCandidateEventId.value),
          reason: OBSERVATION_DUPLICATE_REASONS.CANDIDATE,
        };
      }

      const eventIdentity = input.event.value;
      const existingEvent = await findEventByKeyWithSql(
        sql,
        input.batch.sheetId,
        eventIdentity.eventKey,
      );
      if (existingEvent.kind === LOOKUP_RESULT_KINDS.FOUND) {
        if (existingEvent.value.payload_hash === eventIdentity.payloadHash) {
          await completeObservationWithSql(
            sql,
            input.batch.sheetId,
            input.observation,
            presentEventId(existingEvent.value.event_id),
            OBSERVATION_COMPLETION_STATES.DUPLICATE,
          );
          return {
            kind: OBSERVATION_WRITE_RESULT_KINDS.DUPLICATE,
            observationId: input.observation.observationId,
            eventId: presentEventId(existingEvent.value.event_id),
            reason: OBSERVATION_DUPLICATE_REASONS.EVENT,
          };
        }

        const quarantineId = await persistIntegrityQuarantineWithSql(
          sql,
          input,
          row,
          ABSENT_EVENT_ID,
          OBSERVATION_INTEGRITY_DISCRIMINATORS.EVENT_KEY_PAYLOAD_MISMATCH,
        );
        return completeQuarantineWithSql(
          sql,
          fence,
          input,
          quarantineId,
          ABSENT_EVENT_ID,
          [],
        );
      }

      const createdEvent = await createEventWithSql(sql, input, row);
      await persistObservedHashesWithSql(sql, input, row);

      if (input.evaluation.outcome === ROW_OUTCOMES.QUARANTINE) {
        const quarantineId = await persistQuarantineWithSql(
          sql,
          input,
          input.evaluation.quarantine,
          presentEventId(createdEvent.eventId),
        );
        return completeQuarantineWithSql(
          sql,
          fence,
          input,
          quarantineId,
          presentEventId(createdEvent.eventId),
          input.effects,
        );
      }

      await assertObservedProjectionBaselineWithSql(sql, input, row);
      const canonicalResult = await applyCanonicalMutationWithSql(sql, fence, input, row, binding);
      const conflictIds = await persistConflictAttemptsWithSql(
        sql,
        input,
        row,
        binding,
        createdEvent.eventId,
      );
      if (canonicalResult.kind === PRESENCE_KINDS.PRESENT) {
        await confirmObservedProjectionWithSql(
          sql,
          input,
          row,
          canonicalResult.value.entityRevision,
        );
      }
      await appendAdditionalEffectsOrThrowWithSql(sql, fence, input.effects);

      const eventStatus = input.evaluation.conflicts.length === EMPTY_ARRAY_LENGTH_ZERO
        ? ROW_OUTCOMES.ACCEPTED
        : ROW_OUTCOMES.CONFLICT;
      const statusResult = await sql.run(UPDATE_EVENT_STATUS_SQL, [
        eventStatus,
        createdEvent.eventId,
      ]);
      if (statusResult.changes !== EXPECTED_SINGLE_ROW_CHANGE_COUNT) {
        throw new StorageError(
          STORAGE_ERROR_CODES.OBSERVATION_STORAGE_INCONSISTENT,
          `could not complete event ${createdEvent.eventId}`,
        );
      }
      await completeObservationWithSql(
        sql,
        input.batch.sheetId,
        input.observation,
        presentEventId(createdEvent.eventId),
        OBSERVATION_COMPLETION_STATES.EVALUATED,
      );

      const entityRevision: Applicability<number> = canonicalResult.kind === PRESENCE_KINDS.PRESENT
        ? { kind: APPLICABILITY_KINDS.APPLICABLE, value: canonicalResult.value.entityRevision }
        : { kind: APPLICABILITY_KINDS.NOT_APPLICABLE };

      return {
        kind: OBSERVATION_WRITE_RESULT_KINDS.PERSISTED,
        observationId: input.observation.observationId,
        eventId: createdEvent.eventId,
        eventSequence: createdEvent.eventSequence,
        outcome: requirePersistedOutcome(input.evaluation),
        entityRevision,
        conflictIds,
      };
    });
  } catch (error: unknown) {
    if (error instanceof FenceLostError) {
      return { kind: OBSERVATION_WRITE_RESULT_KINDS.FENCED_OUT };
    }
    if (error instanceof CanonicalStaleError) {
      return { kind: OBSERVATION_WRITE_RESULT_KINDS.STALE };
    }
    throw error;
  }
}

/** Persists one observed row in an adapter-owned transaction. */
export async function persistObservedRowWithAdapter(
  storage: SqlStorageAdapter,
  fence: FencingContext,
  input: PersistObservedRowInput,
): Promise<PersistObservedRowResult> {
  return storage.transaction(({ sql }) => persistObservedRowWithSql(sql, fence, input));
}

/** Appends quarantine effects and closes the receipt through active async SQL. */
async function completeQuarantineWithSql(
  sql: SqlExecutor,
  fence: FencingContext,
  input: PersistObservedRowInput,
  quarantineId: string,
  eventId: Presence<string>,
  effects: readonly NewEffect[],
): Promise<PersistObservedRowResult> {
  await appendAdditionalEffectsOrThrowWithSql(sql, fence, effects);
  await completeObservationWithSql(
    sql,
    input.batch.sheetId,
    input.observation,
    eventId,
    OBSERVATION_COMPLETION_STATES.QUARANTINED,
  );
  return {
    kind: OBSERVATION_WRITE_RESULT_KINDS.QUARANTINED,
    observationId: input.observation.observationId,
    eventId,
    quarantineId,
  };
}

/** Appends additional effects through active async SQL or signals a lost fence. */
async function appendAdditionalEffectsOrThrowWithSql(
  sql: SqlExecutor,
  fence: FencingContext,
  effects: readonly NewEffect[],
): Promise<void> {
  if (!(await appendPendingEffectsWithSql(sql, fence, effects))) throw new FenceLostError();
}

/** Wraps a newly created event ID in the storage presence contract. */
function presentEventId(eventId: string): Presence<string> {
  return { kind: PRESENCE_KINDS.PRESENT, value: eventId };
}

/** Requires the writer fence to remain current within the active async transaction. */
async function assertCurrentFenceWithSql(
  sql: SqlExecutor,
  fence: FencingContext,
): Promise<void> {
  if (!(await isFencingValidWithSql(sql, fence))) throw new FenceLostError();
}
