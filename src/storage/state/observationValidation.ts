/**
 * Input and registry validation for the observation writer.
 *
 * Validation happens before the writer opens its transaction so malformed
 * adapter input never creates a partial receipt or event occurrence.
 */

import { stableHash } from "../../core/index.js";
import type { ObservedEditBatch } from "../../core/index.js";
import {
  APPLICABILITY_KINDS,
  PRESENCE_KINDS,
} from "../../core/state/constants.js";
import type { Applicability, Presence } from "../../core/state/types.js";
import { ROW_OUTCOMES } from "../../core/evaluate/constants.js";
import { ROW_OPERATIONS } from "../../core/model/constants.js";
import { EMPTY_STRING_LENGTH_ZERO } from "../constants.js";
import { STORAGE_ERROR_CODES, StorageError } from "../errors.js";
import type { NewEffect } from "../sync/effectOutbox.js";
import type { DatabaseSyncLike } from "../sqlite/sqliteBridge.js";
import type { SqlExecutor } from "../../adapter/persistence/contracts/sql.js";
import type {
  CanonicalRowMutation,
  ObservationAttemptInput,
  PersistObservedRowInput,
} from "./observationTypes.js";

const READ_REGISTERED_PROJECTION_SQL = `
  SELECT logical_sheet_id, projection, enabled
  FROM physical_sheet_registry
  WHERE physical_sheet_id = ?
`;

const READ_LOGICAL_SHEET_ENABLED_SQL = `
  SELECT enabled
  FROM sheet_registry
  WHERE sheet_id = ?
`;

interface RegisteredProjectionRow {
  readonly logical_sheet_id: string;
  readonly projection: string;
  readonly enabled: number;
}

interface LogicalSheetEnabledRow {
  readonly enabled: number;
}

/** Validates one complete writer submission before durable mutation begins. */
export function validatePersistObservedRowInput(input: PersistObservedRowInput): void {
  const row = requireBatchRow(input.batch, input.rowIndex);
  if (input.physicalSheetId.length === EMPTY_STRING_LENGTH_ZERO) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_OBSERVATION_INPUT,
      "physical sheet ID is required",
    );
  }
  if (
    input.batch.sheetId.length === EMPTY_STRING_LENGTH_ZERO ||
    input.batch.batchId.length === EMPTY_STRING_LENGTH_ZERO
  ) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_OBSERVATION_INPUT,
      "logical sheet ID and batch ID are required",
    );
  }
  if (input.evaluation.rowBindingId !== row.rowBindingId) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_OBSERVATION_INPUT,
      "evaluation row binding does not match the observed row",
    );
  }
  validateObservation(input.observation);
  if (input.event.kind === PRESENCE_KINDS.PRESENT &&
    (input.event.value.eventKey.length === EMPTY_STRING_LENGTH_ZERO ||
      input.event.value.payloadHash.length === EMPTY_STRING_LENGTH_ZERO)) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_OBSERVATION_INPUT,
      "event key and payload hash are required when an event is present",
    );
  }
  if (input.event.kind === PRESENCE_KINDS.ABSENT &&
    input.evaluation.outcome !== ROW_OUTCOMES.QUARANTINE) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_OBSERVATION_INPUT,
      "only quarantined rows may omit an event identity",
    );
  }
  if (input.evaluation.outcome === ROW_OUTCOMES.QUARANTINE &&
    input.canonical.kind === PRESENCE_KINDS.PRESENT) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_OBSERVATION_INPUT,
      "a quarantined row cannot carry a canonical mutation",
    );
  }

  const needsCanonical = input.evaluation.acceptedFields.length > 0 ||
    (row.operation === ROW_OPERATIONS.DELETE &&
      input.evaluation.outcome === ROW_OUTCOMES.ACCEPTED);
  const hasCanonical = input.canonical.kind === PRESENCE_KINDS.PRESENT;
  if (needsCanonical !== hasCanonical) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_OBSERVATION_INPUT,
      "accepted canonical work must have exactly one canonical mutation",
    );
  }
  if (hasCanonical) {
    validateCanonicalMutation(input.canonical.value, row.operation, input.evaluation);
  }
  validateEffects(input.effects, input.batch);
  if (hasCanonical) validateEffects(input.canonical.value.commit.effects, input.batch);
}

/** Requires a valid row index and returns its observed row. */
export function requireBatchRow(batch: ObservedEditBatch, rowIndex: number) {
  if (!Number.isSafeInteger(rowIndex) || rowIndex < 0) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_OBSERVATION_INPUT,
      "row index must be a non-negative safe integer",
    );
  }
  const row = batch.rows[rowIndex];
  if (row === undefined) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_OBSERVATION_INPUT,
      "row index is outside the observed batch",
    );
  }
  return row;
}

/** Ensures the observed physical projection is an enabled registry member. */
export function ensureRegisteredProjection(
  db: DatabaseSyncLike,
  batch: ObservedEditBatch,
  physicalSheetId: string,
): void {
  const row = db.prepare(READ_REGISTERED_PROJECTION_SQL)
    .get<RegisteredProjectionRow>(physicalSheetId);
  if (
    row === undefined ||
    row.logical_sheet_id !== batch.sheetId ||
    row.projection !== batch.projection ||
    row.enabled !== 1
  ) {
    throw new StorageError(
      STORAGE_ERROR_CODES.SYNC_REGISTRY_TARGET_UNAVAILABLE,
      "physical sheet is not an enabled projection of the observed logical sheet",
    );
  }

  const logical = db.prepare(READ_LOGICAL_SHEET_ENABLED_SQL)
    .get<LogicalSheetEnabledRow>(batch.sheetId);
  if (logical === undefined || logical.enabled !== 1) {
    throw new StorageError(
      STORAGE_ERROR_CODES.SYNC_REGISTRY_TARGET_UNAVAILABLE,
      "logical sheet is not enabled",
    );
  }
}

/**
 * Ensures the observed projection is enabled through the active async SQL
 * context. This keeps registry validation in the same transaction as the
 * observation receipt it protects.
 */
export async function ensureRegisteredProjectionWithSql(
  sql: SqlExecutor,
  batch: ObservedEditBatch,
  physicalSheetId: string,
): Promise<void> {
  const row = await sql.get<RegisteredProjectionRow>(READ_REGISTERED_PROJECTION_SQL, [
    physicalSheetId,
  ]);
  if (
    row === undefined ||
    row.logical_sheet_id !== batch.sheetId ||
    row.projection !== batch.projection ||
    row.enabled !== 1
  ) {
    throw new StorageError(
      STORAGE_ERROR_CODES.SYNC_REGISTRY_TARGET_UNAVAILABLE,
      "physical sheet is not an enabled projection of the observed logical sheet",
    );
  }

  const logical = await sql.get<LogicalSheetEnabledRow>(READ_LOGICAL_SHEET_ENABLED_SQL, [
    batch.sheetId,
  ]);
  if (logical === undefined || logical.enabled !== 1) {
    throw new StorageError(
      STORAGE_ERROR_CODES.SYNC_REGISTRY_TARGET_UNAVAILABLE,
      "logical sheet is not enabled",
    );
  }
}

/** Ensures every generated effect targets an enabled registered projection. */
export function ensureEffectsTargetRegistered(
  db: DatabaseSyncLike,
  logicalSheetId: string,
  effects: readonly NewEffect[],
): void {
  for (const effect of effects) {
    const target = db.prepare(READ_REGISTERED_PROJECTION_SQL)
      .get<RegisteredProjectionRow>(effect.physicalSheetId);
    if (
      target === undefined ||
      target.logical_sheet_id !== logicalSheetId ||
      target.projection !== effect.projection ||
      target.enabled !== 1
    ) {
      throw new StorageError(
        STORAGE_ERROR_CODES.SYNC_REGISTRY_TARGET_UNAVAILABLE,
        "effect targets an unregistered physical projection",
      );
    }
  }
}

/** Validates every generated effect target through the active async SQL context. */
export async function ensureEffectsTargetRegisteredWithSql(
  sql: SqlExecutor,
  logicalSheetId: string,
  effects: readonly NewEffect[],
): Promise<void> {
  for (const effect of effects) {
    const target = await sql.get<RegisteredProjectionRow>(READ_REGISTERED_PROJECTION_SQL, [
      effect.physicalSheetId,
    ]);
    if (
      target === undefined ||
      target.logical_sheet_id !== logicalSheetId ||
      target.projection !== effect.projection ||
      target.enabled !== 1
    ) {
      throw new StorageError(
        STORAGE_ERROR_CODES.SYNC_REGISTRY_TARGET_UNAVAILABLE,
        "effect targets an unregistered physical projection",
      );
    }
  }
}

function validateObservation(observation: ObservationAttemptInput): void {
  if (
    observation.observationId.length === EMPTY_STRING_LENGTH_ZERO ||
    observation.observationKey.length === EMPTY_STRING_LENGTH_ZERO ||
    observation.payloadJson.length === EMPTY_STRING_LENGTH_ZERO ||
    observation.payloadHash.length === EMPTY_STRING_LENGTH_ZERO ||
    observation.ingressActorId.length === EMPTY_STRING_LENGTH_ZERO
  ) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_OBSERVATION_INPUT,
      "observation identity, payload, and ingress actor are required",
    );
  }
  for (const [name, value] of [["detectedAt", observation.detectedAt], ["receivedAt", observation.receivedAt]] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new StorageError(
        STORAGE_ERROR_CODES.INVALID_OBSERVATION_INPUT,
        `${name} must be a non-negative safe integer`,
      );
    }
  }
  if (observation.editorActorSource === "google_active_user" &&
    observation.editorActorId.kind === PRESENCE_KINDS.ABSENT) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_OBSERVATION_INPUT,
      "a verified editor source requires an editor actor ID",
    );
  }
  if (observation.editorActorSource === "unavailable" &&
    observation.editorActorId.kind === PRESENCE_KINDS.PRESENT) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_OBSERVATION_INPUT,
      "an unavailable editor source cannot claim an editor actor ID",
    );
  }
}

function validateCanonicalMutation(
  mutation: CanonicalRowMutation,
  operation: string,
  evaluation: PersistObservedRowInput["evaluation"],
): void {
  if (mutation.commitId.length === EMPTY_STRING_LENGTH_ZERO) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_OBSERVATION_INPUT,
      "canonical commit ID is required",
    );
  }
  const expectedKind = operation === ROW_OPERATIONS.INSERT
    ? ROW_OPERATIONS.INSERT
    : operation === ROW_OPERATIONS.DELETE
      ? ROW_OPERATIONS.DELETE
      : ROW_OPERATIONS.UPDATE;
  if (mutation.commit.kind !== expectedKind) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_OBSERVATION_INPUT,
      `observed ${operation} requires a ${expectedKind} canonical mutation`,
    );
  }

  if (mutation.commit.kind !== ROW_OPERATIONS.DELETE) {
    const acceptedByName = new Map(evaluation.acceptedFields.map((field) => [field.fieldName, field]));
    if (acceptedByName.size !== mutation.commit.fields.length) {
      throw new StorageError(
        STORAGE_ERROR_CODES.INVALID_OBSERVATION_INPUT,
        "canonical fields must exactly match accepted fields",
      );
    }
    for (const field of mutation.commit.fields) {
      const accepted = acceptedByName.get(field.fieldName);
      if (accepted === undefined || stableHash(field.value) !== stableHash(accepted.nextValue)) {
        throw new StorageError(
          STORAGE_ERROR_CODES.INVALID_OBSERVATION_INPUT,
          `canonical field ${field.fieldName} does not match the core result`,
        );
      }
      const expectedRevision: Applicability<number> = mutation.commit.kind === ROW_OPERATIONS.INSERT
        ? { kind: APPLICABILITY_KINDS.NOT_APPLICABLE }
        : { kind: APPLICABILITY_KINDS.APPLICABLE, value: accepted.nextFieldRevision - 1 };
      if (!sameApplicability(field.expectedFieldRevision, expectedRevision)) {
        throw new StorageError(
          STORAGE_ERROR_CODES.INVALID_OBSERVATION_INPUT,
          `canonical field ${field.fieldName} has an unexpected base revision`,
        );
      }
    }
  }

  const keyNames = new Set<string>();
  for (const change of mutation.businessKeyChanges) {
    if (
      change.fieldName.length === EMPTY_STRING_LENGTH_ZERO ||
      keyNames.has(change.fieldName)
    ) {
      throw new StorageError(
        STORAGE_ERROR_CODES.INVALID_OBSERVATION_INPUT,
        "business key changes must have unique non-empty field names",
      );
    }
    keyNames.add(change.fieldName);
    if (
      (change.previousNormalizedKey.kind === PRESENCE_KINDS.PRESENT &&
        change.previousNormalizedKey.value.length === EMPTY_STRING_LENGTH_ZERO) ||
      (change.nextNormalizedKey.kind === PRESENCE_KINDS.PRESENT &&
        change.nextNormalizedKey.value.length === EMPTY_STRING_LENGTH_ZERO)
    ) {
      throw new StorageError(
        STORAGE_ERROR_CODES.INVALID_OBSERVATION_INPUT,
        "business key hashes cannot be empty strings",
      );
    }
  }
}

function sameApplicability<T>(left: Applicability<T>, right: Applicability<T>): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === APPLICABILITY_KINDS.NOT_APPLICABLE) return true;
  return right.kind === APPLICABILITY_KINDS.APPLICABLE && left.value === right.value;
}

function validateEffects(effects: readonly NewEffect[], batch: ObservedEditBatch): void {
  for (const effect of effects) {
    if (
      effect.logicalSheetId !== batch.sheetId ||
      effect.physicalSheetId.length === EMPTY_STRING_LENGTH_ZERO ||
      effect.projection.length === EMPTY_STRING_LENGTH_ZERO
    ) {
      throw new StorageError(
        STORAGE_ERROR_CODES.INVALID_OBSERVATION_INPUT,
        "effect must target a registered physical projection of the logical sheet",
      );
    }
  }
}
