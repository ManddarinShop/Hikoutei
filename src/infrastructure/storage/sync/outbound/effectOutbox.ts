/**
 * Effect outbox claim, apply, and recovery operations.
 *
 * Per design concurrency/writer-rpc.md and storage-schema.md:
 * - Effects are claimed atomically (CAS on status = 'pending').
 * - Only one worker can claim an effect at a time.
 * - Apply results must pass fencing validation (epoch + token).
 * - Supersede/replan atomically closes old effect and inserts new one.
 */

import { STORAGE_ERROR_CODES, StorageError } from "../../errors.js";
import type { DatabaseSyncLike } from "../../sqlite/sqliteBridge.js";
import { withSqlSavepoint } from "../../sqlite/sqlTransaction.js";
import {
  isFencingValid,
  isFencingValidWithSql,
} from "../shared/writerLease.js";
import type { FencingContext } from "../shared/writerLease.js";
import type {
  SqlExecutor,
  SqlStorageAdapter,
} from "../../../../adapter/persistence/contracts/sql.js";
import { toSqlNullable } from "../../sqlite/sqlState.js";
import type {
  ApplyResultOptions,
  ClaimEffectOptions,
  ClaimResult,
  EffectProjectionConfirmation,
  NewEffect,
  PendingEffect,
  RetryClaimedEffectOptions,
} from "./effectOutboxContracts.js";
import {
  APPLY_EFFECT_RESULT_SQL,
  CLAIM_EFFECT_SQL,
  COUNT_PENDING_OR_PROCESSING_EFFECTS_SQL,
  INSERT_PENDING_EFFECT_SQL,
  INSERT_REPLANNED_EFFECT_SQL,
  RECOVER_EXPIRED_LEASES_SQL,
  REQUEUE_CLAIMED_EFFECT_SQL,
  RELEASE_UNPROCESSED_EFFECT_SQL,
  SELECT_PENDING_EFFECTS_BY_TARGET_SQL,
  SELECT_READY_EFFECTS_SQL,
  SUPERSEDE_EFFECT_SQL,
} from "./effectOutboxSql.js";
import {
  applyEffectResultParameters,
  AsyncFenceLostError,
  claimEffectParameters,
  effectInsertParameters,
  fenceParameters,
  pendingEffectParameters,
  replannedEffectParameters,
  requireCurrentFence,
  requireCurrentFenceWithSql,
  validateApplyResultOptions,
  validateEffectLeaseDuration,
  validateReadyEffectLimit,
  writeProjectionConfirmation,
  writeProjectionConfirmationWithSql,
} from "./effectOutboxSupport.js";
export { SYNC_EFFECT_RECOVERY_ERROR_CODES } from "./effectOutboxContracts.js";
export type {
  ApplyResultOptions,
  ClaimEffectOptions,
  ClaimResult,
  EffectProjectionConfirmation,
  NewEffect,
  PendingEffect,
  RetryClaimedEffectOptions,
} from "./effectOutboxContracts.js";

export function claimEffect(db: DatabaseSyncLike, options: ClaimEffectOptions): ClaimResult {
  if (!isFencingValid(db, options)) {
    return {
      effectId: options.effectId,
      claimToken: options.claimToken,
      success: false,
      reason: "stale_fencing",
    };
  }
  validateEffectLeaseDuration(options.leaseDurationMs);

  const result = db
    .prepare(CLAIM_EFFECT_SQL)
    .run(
      options.claimToken,
      options.writerEpoch,
      options.now + options.leaseDurationMs,
      options.effectId,
      ...fenceParameters(options),
    );

  const success = result.changes > 0;

  return {
    effectId: options.effectId,
    claimToken: options.claimToken,
    success,
    reason: success
      ? "claimed"
      : isFencingValid(db, options) ? "not_claimable" : "stale_fencing",
  };
}

/**
 * Claims a pending effect through an already-active async SQL context.
 *
 * The compare-and-set query and both fencing checks use the same connection,
 * so a MikroORM-backed worker cannot accidentally claim through a second
 * SQLite connection.
 */
export async function claimEffectWithSql(
  sql: SqlExecutor,
  options: ClaimEffectOptions,
): Promise<ClaimResult> {
  if (!(await isFencingValidWithSql(sql, options))) {
    return {
      effectId: options.effectId,
      claimToken: options.claimToken,
      success: false,
      reason: "stale_fencing",
    };
  }
  validateEffectLeaseDuration(options.leaseDurationMs);

  const result = await sql.run(CLAIM_EFFECT_SQL, claimEffectParameters(options));
  const success = result.changes > 0;

  return {
    effectId: options.effectId,
    claimToken: options.claimToken,
    success,
    reason: success
      ? "claimed"
      : await isFencingValidWithSql(sql, options) ? "not_claimable" : "stale_fencing",
  };
}

/** Claims one effect inside an adapter-owned transaction. */
export async function claimEffectWithAdapter(
  storage: SqlStorageAdapter,
  options: ClaimEffectOptions,
): Promise<ClaimResult> {
  return storage.transaction(({ sql }) => claimEffectWithSql(sql, options));
}


/**
 * Appends pending effects under the supplied writer fence.
 *
 * This is used for conflict/quarantine effects that do not accompany a
 * canonical field commit. It owns a savepoint so a duplicate dedupe key or a
 * lost fence cannot leave only part of an effect set behind.
 */
export function appendPendingEffects(
  db: DatabaseSyncLike,
  fence: FencingContext,
  effects: readonly NewEffect[],
): boolean {
  if (effects.length === 0) return isFencingValid(db, fence);
  if (!isFencingValid(db, fence)) return false;

  db.exec("SAVEPOINT append_pending_effects");
  try {
    for (const effect of effects) {
      const result = db.prepare(INSERT_PENDING_EFFECT_SQL).run(
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
        fence.now,
        ...fenceParameters(fence),
      );
      if (result.changes !== 1) {
        if (!isFencingValid(db, fence)) {
          db.exec("ROLLBACK TO append_pending_effects");
          db.exec("RELEASE append_pending_effects");
          return false;
        }
        throw new StorageError(
          STORAGE_ERROR_CODES.EFFECT_WRITE_FAILED,
          `could not insert effect ${effect.effectId}`,
        );
      }
    }
    db.exec("RELEASE append_pending_effects");
    return true;
  } catch (error: unknown) {
    db.exec("ROLLBACK TO append_pending_effects");
    db.exec("RELEASE append_pending_effects");
    throw error;
  }
}

/**
 * Appends pending effects inside an already-active async SQL transaction.
 *
 * This is the MikroORM-compatible path used when an entity mutation and its
 * Sheets outbox records must commit or roll back together.
 */
export async function appendPendingEffectsWithSql(
  sql: SqlExecutor,
  fence: FencingContext,
  effects: readonly NewEffect[],
): Promise<boolean> {
  if (effects.length === 0) return isFencingValidWithSql(sql, fence);
  if (!(await isFencingValidWithSql(sql, fence))) return false;

  try {
    return await withSqlSavepoint(sql, "append_pending_effects", async () => {
      for (const effect of effects) {
        const result = await sql.run(INSERT_PENDING_EFFECT_SQL, pendingEffectParameters(effect, fence));
        if (result.changes === 1) continue;
        if (!(await isFencingValidWithSql(sql, fence))) {
          throw new AsyncFenceLostError();
        }
        throw new StorageError(
          STORAGE_ERROR_CODES.EFFECT_WRITE_FAILED,
          `could not insert effect ${effect.effectId}`,
        );
      }
      return true;
    });
  } catch (error: unknown) {
    if (error instanceof AsyncFenceLostError) return false;
    throw error;
  }
}

/** Appends pending effects in one adapter-owned transaction. */
export async function appendPendingEffectsWithAdapter(
  storage: SqlStorageAdapter,
  fence: FencingContext,
  effects: readonly NewEffect[],
): Promise<boolean> {
  return storage.transaction(({ sql }) => appendPendingEffectsWithSql(sql, fence, effects));
}

/**
 * Applies a result to a claimed effect.
 * Validates fencing (claim token + writer epoch) before applying.
 * Returns true if the result was applied, false if fencing failed.
 */
export function applyEffectResult(db: DatabaseSyncLike, options: ApplyResultOptions): boolean {
  if (!isFencingValid(db, options)) {
    return false;
  }
  validateApplyResultOptions(options);

  db.exec("SAVEPOINT apply_effect_result");
  try {
    const result = db
      .prepare(APPLY_EFFECT_RESULT_SQL)
      .run(
        options.status,
        toSqlNullable(options.lastErrorCode),
        toSqlNullable(options.lastErrorMessage),
        options.effectId,
        options.claimToken,
        options.writerEpoch,
        options.now,
        ...fenceParameters(options),
      );

    if (result.changes !== 1) {
      db.exec("ROLLBACK TO apply_effect_result");
      db.exec("RELEASE apply_effect_result");
      return false;
    }
    if (options.projectionConfirmation !== undefined) {
      writeProjectionConfirmation(db, options.projectionConfirmation);
    }
    db.exec("RELEASE apply_effect_result");
    return true;
  } catch (error: unknown) {
    try {
      db.exec("ROLLBACK TO apply_effect_result");
      db.exec("RELEASE apply_effect_result");
    } catch {
      // Preserve the storage error that caused the result write to fail.
    }
    throw error;
  }
}

/**
 * Applies a claimed effect result through an already-active async SQL context.
 *
 * If projection confirmation fails, the savepoint rolls the effect transition
 * back too; confirmed visible state can never advance without its outbox row.
 */
export async function applyEffectResultWithSql(
  sql: SqlExecutor,
  options: ApplyResultOptions,
): Promise<boolean> {
  if (!(await isFencingValidWithSql(sql, options))) return false;
  validateApplyResultOptions(options);

  return withSqlSavepoint(sql, "apply_effect_result", async () => {
    const result = await sql.run(APPLY_EFFECT_RESULT_SQL, applyEffectResultParameters(options));
    if (result.changes !== 1) return false;
    if (options.projectionConfirmation !== undefined) {
      await writeProjectionConfirmationWithSql(sql, options.projectionConfirmation);
    }
    return true;
  });
}

/** Applies one effect result inside an adapter-owned transaction. */
export async function applyEffectResultWithAdapter(
  storage: SqlStorageAdapter,
  options: ApplyResultOptions,
): Promise<boolean> {
  return storage.transaction(({ sql }) => applyEffectResultWithSql(sql, options));
}

/**
 * Supersedes an old effect and inserts a new replacement effect atomically.
 * Used for repair replan when the canonical target has advanced.
 *
 * Per design: the old effect is marked 'superseded', a new effect with a new
 * effect_id and new dedupe_key is inserted, and the new effect's
 * predecessor_effect_id links to the old one.
 */
export function supersedeAndReplan(
  db: DatabaseSyncLike,
  fence: FencingContext,
  oldEffectId: string,
  newEffect: NewEffect,
): void {
  requireCurrentFence(db, fence);
  db.exec("SAVEPOINT replan");
  try {
    const superseded = db.prepare(SUPERSEDE_EFFECT_SQL)
      .run(newEffect.effectId, oldEffectId, ...fenceParameters(fence));
    if (superseded.changes !== 1) {
      requireCurrentFence(db, fence);
      throw new StorageError(
        STORAGE_ERROR_CODES.EFFECT_REPLAN_CONFLICT,
        `effect ${oldEffectId} cannot be replanned from its current status`,
      );
    }

    const inserted = db.prepare(INSERT_REPLANNED_EFFECT_SQL).run(
      newEffect.effectId,
      newEffect.effectKind,
      newEffect.commitId,
      newEffect.logicalSheetId,
      newEffect.physicalSheetId,
      newEffect.projection,
      toSqlNullable(newEffect.rowBindingId),
      toSqlNullable(newEffect.conflictId),
      newEffect.targetKind,
      newEffect.targetId,
      toSqlNullable(newEffect.targetEntityRevision),
      toSqlNullable(newEffect.targetFieldRevisionHash),
      toSqlNullable(newEffect.targetCanonicalCommitId),
      newEffect.expectedVisibleRevision,
      newEffect.expectedVisibleHash,
      toSqlNullable(newEffect.repairGuardHash),
      toSqlNullable(newEffect.sourceQuarantineId),
      newEffect.payloadJson,
      newEffect.payloadHash,
      newEffect.effectDedupeKey,
      newEffect.streamSequence,
      oldEffectId,
      fence.now,
      ...fenceParameters(fence),
    );
    if (inserted.changes !== 1) {
      requireCurrentFence(db, fence);
      throw new StorageError(
        STORAGE_ERROR_CODES.EFFECT_WRITE_FAILED,
        `effect ${newEffect.effectId} could not be inserted during replan`,
      );
    }

    db.exec("RELEASE replan");
  } catch (error) {
    db.exec("ROLLBACK TO replan");
    db.exec("RELEASE replan");
    throw error;
  }
}

/** Supersedes and replans an effect through an already-active async SQL context. */
export async function supersedeAndReplanWithSql(
  sql: SqlExecutor,
  fence: FencingContext,
  oldEffectId: string,
  newEffect: NewEffect,
): Promise<void> {
  await requireCurrentFenceWithSql(sql, fence);
  await withSqlSavepoint(sql, "replan", async () => {
    const superseded = await sql.run(SUPERSEDE_EFFECT_SQL, [
      newEffect.effectId,
      oldEffectId,
      ...fenceParameters(fence),
    ]);
    if (superseded.changes !== 1) {
      await requireCurrentFenceWithSql(sql, fence);
      throw new StorageError(
        STORAGE_ERROR_CODES.EFFECT_REPLAN_CONFLICT,
        `effect ${oldEffectId} cannot be replanned from its current status`,
      );
    }

    const inserted = await sql.run(
      INSERT_REPLANNED_EFFECT_SQL,
      replannedEffectParameters(newEffect, oldEffectId, fence),
    );
    if (inserted.changes !== 1) {
      await requireCurrentFenceWithSql(sql, fence);
      throw new StorageError(
        STORAGE_ERROR_CODES.EFFECT_WRITE_FAILED,
        `effect ${newEffect.effectId} could not be inserted during replan`,
      );
    }
  });
}

/** Supersedes and replans an effect inside an adapter-owned transaction. */
export async function supersedeAndReplanWithAdapter(
  storage: SqlStorageAdapter,
  fence: FencingContext,
  oldEffectId: string,
  newEffect: NewEffect,
): Promise<void> {
  await storage.transaction(({ sql }) => supersedeAndReplanWithSql(sql, fence, oldEffectId, newEffect));
}

/**
 * Marks expired processing effects as requiring postcondition recovery.
 *
 * The worker must read the remote postcondition before it schedules a retry;
 * an expired lease is not evidence that the remote write did not happen.
 */
export function recoverExpiredLeases(
  db: DatabaseSyncLike,
  fence: FencingContext,
): number {
  requireCurrentFence(db, fence);
  const result = db
    .prepare(RECOVER_EXPIRED_LEASES_SQL)
    .run(fence.now, ...fenceParameters(fence));
  return result.changes;
}

/** Marks expired effect leases through an already-active async SQL context. */
export async function recoverExpiredLeasesWithSql(
  sql: SqlExecutor,
  fence: FencingContext,
): Promise<number> {
  await requireCurrentFenceWithSql(sql, fence);
  const result = await sql.run(RECOVER_EXPIRED_LEASES_SQL, [
    fence.now,
    ...fenceParameters(fence),
  ]);
  return result.changes;
}

/** Marks expired effect leases inside an adapter-owned transaction. */
export async function recoverExpiredLeasesWithAdapter(
  storage: SqlStorageAdapter,
  fence: FencingContext,
): Promise<number> {
  return storage.transaction(({ sql }) => recoverExpiredLeasesWithSql(sql, fence));
}

/**
 * Returns an acknowledged-but-unprocessed batch suffix to pending.
 *
 * This is intentionally narrower than a generic redrive: it may be used only
 * after a valid gateway response explicitly says the batch budget stopped
 * before this effect.  Unknown response loss remains failed until read-back.
 */
export function releaseUnprocessedEffect(
  db: DatabaseSyncLike,
  options: Pick<FencingContext, "role" | "writerEpoch" | "fencingToken" | "now"> & {
    readonly effectId: string;
    readonly claimToken: string;
  },
): boolean {
  if (!isFencingValid(db, options)) return false;
  const result = db.prepare(RELEASE_UNPROCESSED_EFFECT_SQL).run(
    options.effectId,
    options.claimToken,
    options.writerEpoch,
    options.now,
    ...fenceParameters(options),
  );
  return result.changes === 1;
}

/** Returns one acknowledged-but-unprocessed effect through an async SQL context. */
export async function releaseUnprocessedEffectWithSql(
  sql: SqlExecutor,
  options: Pick<FencingContext, "role" | "writerEpoch" | "fencingToken" | "now"> & {
    readonly effectId: string;
    readonly claimToken: string;
  },
): Promise<boolean> {
  if (!(await isFencingValidWithSql(sql, options))) return false;
  const result = await sql.run(RELEASE_UNPROCESSED_EFFECT_SQL, [
    options.effectId,
    options.claimToken,
    options.writerEpoch,
    options.now,
    ...fenceParameters(options),
  ]);
  return result.changes === 1;
}

/** Returns one acknowledged-but-unprocessed effect inside an adapter transaction. */
export async function releaseUnprocessedEffectWithAdapter(
  storage: SqlStorageAdapter,
  options: Pick<FencingContext, "role" | "writerEpoch" | "fencingToken" | "now"> & {
    readonly effectId: string;
    readonly claimToken: string;
  },
): Promise<boolean> {
  return storage.transaction(({ sql }) => releaseUnprocessedEffectWithSql(sql, options));
}

/** Input for returning a claimed effect to the redrive queue after read-back. */

/** Requeues a claimed effect only after the current fence still owns it. */
export function retryClaimedEffect(
  db: DatabaseSyncLike,
  options: RetryClaimedEffectOptions,
): boolean {
  if (!isFencingValid(db, options)) return false;
  const result = db.prepare(REQUEUE_CLAIMED_EFFECT_SQL).run(
    options.lastErrorCode,
    options.lastErrorMessage,
    options.effectId,
    options.claimToken,
    options.writerEpoch,
    options.now,
    ...fenceParameters(options),
  );
  return result.changes === 1;
}

/** Requeues a claimed effect through an already-active async SQL context. */
export async function retryClaimedEffectWithSql(
  sql: SqlExecutor,
  options: RetryClaimedEffectOptions,
): Promise<boolean> {
  if (!(await isFencingValidWithSql(sql, options))) return false;
  const result = await sql.run(REQUEUE_CLAIMED_EFFECT_SQL, [
    options.lastErrorCode,
    options.lastErrorMessage,
    options.effectId,
    options.claimToken,
    options.writerEpoch,
    options.now,
    ...fenceParameters(options),
  ]);
  return result.changes === 1;
}

/** Requeues a claimed effect inside an adapter-owned transaction. */
export async function retryClaimedEffectWithAdapter(
  storage: SqlStorageAdapter,
  options: RetryClaimedEffectOptions,
): Promise<boolean> {
  return storage.transaction(({ sql }) => retryClaimedEffectWithSql(sql, options));
}

/**
 * Finds pending effects for a given stream (target), ordered by stream_sequence.
 * Returns the head-of-line effects for a target stream.
 */
export function findPendingEffectsByTarget(
  db: DatabaseSyncLike,
  logicalSheetId: string,
  targetKind: string,
  targetId: string,
): readonly PendingEffect[] {
  return db
    .prepare(SELECT_PENDING_EFFECTS_BY_TARGET_SQL)
    .all(logicalSheetId, targetKind, targetId) as PendingEffect[];
}

/** Reads one target stream through an already-active async SQL context. */
export async function findPendingEffectsByTargetWithSql(
  sql: SqlExecutor,
  logicalSheetId: string,
  targetKind: string,
  targetId: string,
): Promise<readonly PendingEffect[]> {
  return sql.all<PendingEffect>(SELECT_PENDING_EFFECTS_BY_TARGET_SQL, [
    logicalSheetId,
    targetKind,
    targetId,
  ]);
}

/** Reads one target stream through a fresh adapter read context. */
export async function findPendingEffectsByTargetWithAdapter(
  storage: SqlStorageAdapter,
  logicalSheetId: string,
  targetKind: string,
  targetId: string,
): Promise<readonly PendingEffect[]> {
  return storage.read(({ sql }) => {
    return findPendingEffectsByTargetWithSql(sql, logicalSheetId, targetKind, targetId);
  });
}

/**
 * Returns ordered head-of-line effects across streams for one bounded worker pass.
 *
 * Claiming still performs the authoritative CAS, so a concurrent worker can
 * safely race this advisory selection without processing a later stream item.
 */
export function listReadyEffects(
  db: DatabaseSyncLike,
  limit: number,
): readonly PendingEffect[] {
  validateReadyEffectLimit(limit);
  return db.prepare(SELECT_READY_EFFECTS_SQL).all(limit) as PendingEffect[];
}

/** Reads bounded head-of-line effects through an already-active async SQL context. */
export async function listReadyEffectsWithSql(
  sql: SqlExecutor,
  limit: number,
): Promise<readonly PendingEffect[]> {
  validateReadyEffectLimit(limit);
  return sql.all<PendingEffect>(SELECT_READY_EFFECTS_SQL, [limit]);
}

/** Reads bounded head-of-line effects through a fresh adapter read context. */
export async function listReadyEffectsWithAdapter(
  storage: SqlStorageAdapter,
  limit: number,
): Promise<readonly PendingEffect[]> {
  return storage.read(({ sql }) => listReadyEffectsWithSql(sql, limit));
}

/** Returns whether normal outbox work is still pending or actively processing. */
export function hasPendingOrProcessingEffects(db: DatabaseSyncLike): boolean {
  const row = db.prepare(COUNT_PENDING_OR_PROCESSING_EFFECTS_SQL).get() as
    | { count: number }
    | undefined;
  return row !== undefined && row.count > 0;
}

/** Checks whether the durable outbox still has pending or processing work. */
export async function hasPendingOrProcessingEffectsWithSql(
  sql: SqlExecutor,
): Promise<boolean> {
  const row = await sql.get<{ count: number }>(COUNT_PENDING_OR_PROCESSING_EFFECTS_SQL);
  return row !== undefined && row.count > 0;
}

/** Checks outbox activity through a fresh adapter read context. */
export async function hasPendingOrProcessingEffectsWithAdapter(
  storage: SqlStorageAdapter,
): Promise<boolean> {
  return storage.read(({ sql }) => hasPendingOrProcessingEffectsWithSql(sql));
}
