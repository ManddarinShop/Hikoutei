/** Validation, projection confirmation, fencing, and SQL parameter helpers. */

import { STORAGE_ERROR_CODES, StorageError } from "../../errors.js";
import type { DatabaseSyncLike } from "../../sqlite/sqliteBridge.js";
import {
  isFencingValid,
  isFencingValidWithSql,
} from "../shared/writerLease.js";
import type { FencingContext } from "../shared/writerLease.js";
import { toSqlNullable } from "../../sqlite/sqlState.js";
import {
  UPSERT_VISIBLE_FIELD_STATE_SQL,
  UPSERT_VISIBLE_STATE_SQL,
} from "./effectOutboxSql.js";
import type {
  ApplyResultOptions,
  ClaimEffectOptions,
  EffectProjectionConfirmation,
  NewEffect,
} from "./effectOutboxContracts.js";
import type {
  SqlExecutor,
  SqlParameter,
} from "../../../../adapter/persistence/contracts/sql.js";

export function validateProjectionConfirmation(confirmation: EffectProjectionConfirmation): void {
  if (
    confirmation.physicalSheetId.length === 0 ||
    confirmation.projection.length === 0 ||
    confirmation.rowBindingId.length === 0 ||
    confirmation.visibleHash.length === 0 ||
    !Number.isSafeInteger(confirmation.visibleRevision) ||
    confirmation.visibleRevision < 1
  ) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_PROJECTION_CONFIRMATION,
      "projection confirmation has an invalid identity or visible revision",
    );
  }
  for (const [fieldName, hash] of Object.entries(confirmation.fieldHashes)) {
    if (fieldName.length === 0 || hash.length === 0) {
      throw new StorageError(
        STORAGE_ERROR_CODES.INVALID_PROJECTION_CONFIRMATION,
        "projection confirmation contains an invalid field hash",
      );
    }
  }
}

export function validateApplyResultOptions(options: ApplyResultOptions): void {
  if (options.status !== "applied" && options.projectionConfirmation !== undefined) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_EFFECT_RESULT,
      "only an applied effect may advance confirmed projection state",
    );
  }
  if (options.projectionConfirmation !== undefined) {
    validateProjectionConfirmation(options.projectionConfirmation);
  }
}

export function validateEffectLeaseDuration(leaseDurationMs: number): void {
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs <= 0) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_EFFECT_OPTIONS,
      "effect lease duration must be a positive safe integer",
    );
  }
}

export function validateReadyEffectLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_EFFECT_OPTIONS,
      "ready effect limit must be a positive safe integer",
    );
  }
}

/** Writes row and field confirmation only after the outbox effect has won its claim CAS. */
export function writeProjectionConfirmation(
  db: DatabaseSyncLike,
  confirmation: EffectProjectionConfirmation,
): void {
  const row = db.prepare(UPSERT_VISIBLE_STATE_SQL).run(
    confirmation.physicalSheetId,
    confirmation.projection,
    confirmation.rowBindingId,
    confirmation.visibleHash,
    confirmation.visibleRevision,
    toSqlNullable(confirmation.entityRevision),
    confirmation.visibleHash,
  );
  if (row.changes !== 1) {
    throw new StorageError(
      STORAGE_ERROR_CODES.PROJECTION_CONFIRMATION_REGRESSION,
      "projection confirmation would move visible state backwards",
    );
  }

  for (const [fieldName, hash] of Object.entries(confirmation.fieldHashes)) {
    const field = db.prepare(UPSERT_VISIBLE_FIELD_STATE_SQL).run(
      confirmation.physicalSheetId,
      confirmation.projection,
      confirmation.rowBindingId,
      fieldName,
      hash,
      confirmation.visibleRevision,
      hash,
    );
    if (field.changes !== 1) {
      throw new StorageError(
        STORAGE_ERROR_CODES.PROJECTION_CONFIRMATION_REGRESSION,
        "projection confirmation would move a field visible state backwards",
      );
    }
  }
}

/** Writes confirmed row and field state through the active async SQL context. */
export async function writeProjectionConfirmationWithSql(
  sql: SqlExecutor,
  confirmation: EffectProjectionConfirmation,
): Promise<void> {
  const row = await sql.run(UPSERT_VISIBLE_STATE_SQL, [
    confirmation.physicalSheetId,
    confirmation.projection,
    confirmation.rowBindingId,
    confirmation.visibleHash,
    confirmation.visibleRevision,
    toSqlNullable(confirmation.entityRevision),
    confirmation.visibleHash,
  ]);
  if (row.changes !== 1) {
    throw new StorageError(
      STORAGE_ERROR_CODES.PROJECTION_CONFIRMATION_REGRESSION,
      "projection confirmation would move visible state backwards",
    );
  }

  for (const [fieldName, hash] of Object.entries(confirmation.fieldHashes)) {
    const field = await sql.run(UPSERT_VISIBLE_FIELD_STATE_SQL, [
      confirmation.physicalSheetId,
      confirmation.projection,
      confirmation.rowBindingId,
      fieldName,
      hash,
      confirmation.visibleRevision,
      hash,
    ]);
    if (field.changes !== 1) {
      throw new StorageError(
        STORAGE_ERROR_CODES.PROJECTION_CONFIRMATION_REGRESSION,
        "projection confirmation would move a field visible state backwards",
      );
    }
  }
}

export function requireCurrentFence(db: DatabaseSyncLike, fence: FencingContext): void {
  if (!isFencingValid(db, fence)) {
    throw new StorageError(
      STORAGE_ERROR_CODES.STALE_WRITER_FENCE,
      "writer fencing is stale or expired",
    );
  }
}

export async function requireCurrentFenceWithSql(
  sql: SqlExecutor,
  fence: FencingContext,
): Promise<void> {
  if (!(await isFencingValidWithSql(sql, fence))) {
    throw new StorageError(
      STORAGE_ERROR_CODES.STALE_WRITER_FENCE,
      "writer fencing is stale or expired",
    );
  }
}

export function fenceParameters(fence: FencingContext): readonly [string, number, string, number] {
  return [fence.role, fence.writerEpoch, fence.fencingToken, fence.now];
}

export function claimEffectParameters(options: ClaimEffectOptions): readonly SqlParameter[] {
  return [
    options.claimToken,
    options.writerEpoch,
    options.now + options.leaseDurationMs,
    options.effectId,
    ...fenceParameters(options),
  ];
}

export function applyEffectResultParameters(options: ApplyResultOptions): readonly SqlParameter[] {
  return [
    options.status,
    toSqlNullable(options.lastErrorCode),
    toSqlNullable(options.lastErrorMessage),
    options.effectId,
    options.claimToken,
    options.writerEpoch,
    options.now,
    ...fenceParameters(options),
  ];
}

export function effectInsertParameters(effect: NewEffect): readonly SqlParameter[] {
  return [
    effect.effectId,
    effect.effectKind,
    effect.commitId,
    effect.logicalSheetId,
    effect.physicalSheetId,
    effect.projection,
    toSqlNullable(effect.rowBindingId),
    toSqlNullable(effect.conflictId),
    effect.targetKind,
    effect.targetId,
    toSqlNullable(effect.targetEntityRevision),
    toSqlNullable(effect.targetFieldRevisionHash),
    toSqlNullable(effect.targetCanonicalCommitId),
    effect.expectedVisibleRevision,
    effect.expectedVisibleHash,
    toSqlNullable(effect.repairGuardHash),
    toSqlNullable(effect.sourceQuarantineId),
    effect.payloadJson,
    effect.payloadHash,
    effect.effectDedupeKey,
    effect.streamSequence,
  ];
}

export function pendingEffectParameters(
  effect: NewEffect,
  fence: FencingContext,
): readonly SqlParameter[] {
  return [
    ...effectInsertParameters(effect),
    fence.now,
    ...fenceParameters(fence),
  ];
}

export function replannedEffectParameters(
  effect: NewEffect,
  oldEffectId: string,
  fence: FencingContext,
): readonly SqlParameter[] {
  return [
    ...effectInsertParameters(effect),
    oldEffectId,
    fence.now,
    ...fenceParameters(fence),
  ];
}

/** Internal control-flow signal that forces the enclosing async savepoint to roll back. */
export class AsyncFenceLostError extends Error {}
