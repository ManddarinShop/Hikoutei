/** Durable effect outbox state transitions and adapter transaction wrappers. */

import { STORAGE_ERROR_CODES, StorageError } from "../../errors.js";
import { withSqlSavepoint } from "../../sqlite/sqlTransaction.js";
import { isFencingValidWithSql } from "../shared/writerLease.js";
import type { FencingContext } from "../shared/writerLease.js";
import type {
  SqlExecutor,
  SqlStorageAdapter,
} from "../../../../adapter/persistence/contracts/sql.js";
import type {
  ApplyResultOptions,
  ClaimEffectOptions,
  ClaimResult,
  NewEffect,
  RetryClaimedEffectOptions,
} from "./effectOutboxContracts.js";
import {
  APPLY_EFFECT_RESULT_SQL,
  CLAIM_EFFECT_SQL,
  INSERT_PENDING_EFFECT_SQL,
  INSERT_REPLANNED_EFFECT_SQL,
  RECOVER_EXPIRED_LEASES_SQL,
  REQUEUE_CLAIMED_EFFECT_SQL,
  RELEASE_UNPROCESSED_EFFECT_SQL,
  SUPERSEDE_EFFECT_SQL,
} from "./effectOutboxSql.js";
import {
  applyEffectResultParameters,
  AsyncFenceLostError,
  claimEffectParameters,
  fenceParameters,
  pendingEffectParameters,
  replannedEffectParameters,
  requireCurrentFenceWithSql,
  validateApplyResultOptions,
  validateEffectLeaseDuration,
  writeProjectionConfirmationWithSql,
} from "./effectOutboxSupport.js";

/** Claims one pending effect through the active SQL context. */
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

/** Appends pending effects atomically under the supplied writer fence. */
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
        if (!(await isFencingValidWithSql(sql, fence))) throw new AsyncFenceLostError();
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

/** Appends pending effects inside an adapter-owned transaction. */
export async function appendPendingEffectsWithAdapter(
  storage: SqlStorageAdapter,
  fence: FencingContext,
  effects: readonly NewEffect[],
): Promise<boolean> {
  return storage.transaction(({ sql }) => appendPendingEffectsWithSql(sql, fence, effects));
}

/** Applies a claimed effect result and optional visible-state confirmation atomically. */
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

/** Supersedes one effect and inserts its replacement atomically. */
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
  return storage.transaction(({ sql }) => supersedeAndReplanWithSql(sql, fence, oldEffectId, newEffect));
}

/** Marks expired effect leases for postcondition recovery. */
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

/** Returns one acknowledged-but-unprocessed effect to pending. */
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

/** Requeues a claimed effect only while the current fence still owns it. */
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
