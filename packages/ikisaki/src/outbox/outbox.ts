/**
 * Effect outbox claim, apply, and recovery operations.
 *
 * - Effects are claimed atomically (CAS on status = 'pending').
 * - Only one worker can claim an effect at a time.
 * - Apply results must pass fencing validation (epoch + token).
 * - Supersede/replan atomically closes old effect and inserts new one.
 */

import { STORAGE_ERROR_CODES, StorageError } from "../contract/errors.js";
import type { EffectKind } from "../contract/constants.js";
import { withSqlSavepoint } from "../sql/sqlTransaction.js";
import {
  fenceParameters,
  isFencingValidWithSql,
} from "./writerLease.js";
import type { FencingContext } from "./writerLease.js";
import {
  decodeSqlRows,
  type SqlExecutor,
  type SqlRow,
  type SqlStorageAdapter,
} from "../sql/sql.js";
import type {
  ApplyResultOptions,
  ClaimEffectOptions,
  ClaimResult,
  MarkDeliveryUncertainOptions,
  NewEffect,
  RenewEffectLeaseOptions,
  PendingEffect,
  RetryClaimedEffectOptions,
} from "../contract/contracts.js";
import {
  isRecoverableEffectErrorCode,
  APPLY_EFFECT_RESULT_SQL,
  CLAIM_EFFECT_SQL,
  COUNT_ACTIVE_SYSTEM_STATE_EFFECTS_SQL,
  COUNT_PENDING_OR_PROCESSING_EFFECTS_SQL,
  INSERT_PENDING_EFFECT_SQL,
  INSERT_REPLANNED_EFFECT_SQL,
  MARK_DELIVERY_UNCERTAIN_SQL,
  READ_OUTBOX_SCAN_READINESS_SQL,
  RECOVER_EXPIRED_LEASES_SQL,
  RENEW_EFFECT_LEASE_SQL,
  REQUEUE_CLAIMED_EFFECT_SQL,
  RELEASE_UNPROCESSED_EFFECT_SQL,
  RELEASE_UNPROCESSED_EFFECT_REASON,
  SELECT_PENDING_EFFECTS_BY_TARGET_SQL,
  SELECT_READY_EFFECTS_SQL,
  SELECT_READY_FAST_APPEND_EFFECTS_SQL,
  SUPERSEDE_EFFECT_SQL,
} from "./outboxSql.js";
import {
  applyEffectResultParameters,
  claimEffectParameters,
  decodePendingEffectRow,
  pendingEffectParameters,
  markDeliveryUncertainParameters,
  replannedEffectParameters,
  retryClaimedEffectParameters,
} from "./effectRow.js";
import {
  assertProjectionConfirmationTargetWithSql,
  validateApplyResultOptions,
  writeProjectionConfirmationWithSql,
} from "./confirmation.js";
import {
  AsyncFenceLostError,
  requireCurrentFenceWithSql,
  validateEffectLeaseDuration,
  validateReadyEffectLimit,
} from "./writerLease.js";
export { SYNC_EFFECT_RECOVERY_ERROR_CODES } from "../contract/contracts.js";
export {
  RECOVERABLE_EFFECT_ERROR_CODES,
  RECOVERABLE_EFFECT_ERROR_CODE_SQL,
  isRecoverableEffectErrorCode,
} from "./outboxSql.js";
export type {
  AppliedEffectResultOptions,
  ApplyResultOptions,
  ClaimEffectOptions,
  ClaimResult,
  NonAppliedEffectResultOptions,
  RenewEffectLeaseOptions,
  EffectProjectionConfirmation,
  MarkDeliveryUncertainOptions,
  NewEffect,
  PendingEffect,
  RetryClaimedEffectOptions,
} from "../contract/contracts.js";

/**
 * Claims a pending effect through an already-active async SQL context.
 *
 * The compare-and-set query and both fencing checks use the same connection,
 * so a worker cannot claim through a different SQLite connection.
 */
export async function claimEffectWithSql(
  sql: SqlExecutor,
  options: ClaimEffectOptions,
): Promise<ClaimResult> {
  if (!(await isFencingValidWithSql(sql, options))) {
    return {
      effectId: options.effectId,
      claimToken: options.claimToken,
      status: "not_claimed",
      reason: "stale_fencing",
    };
  }
  validateEffectLeaseDuration(options.leaseDurationMs);

  const result = await sql.run(CLAIM_EFFECT_SQL, claimEffectParameters(options));
  if (result.changes > 0) {
    return {
      effectId: options.effectId,
      claimToken: options.claimToken,
      status: "claimed",
    };
  }

  return {
    effectId: options.effectId,
    claimToken: options.claimToken,
    status: "not_claimed",
    reason: await isFencingValidWithSql(sql, options) ? "not_claimable" : "stale_fencing",
  };
}

/** Claims one effect inside an adapter-owned transaction. */
export async function claimEffectWithAdapter(
  storage: SqlStorageAdapter,
  options: ClaimEffectOptions,
): Promise<ClaimResult> {
  return storage.transaction(({ sql }) => claimEffectWithSql(sql, options));
}

/** Renews a processing effect only while the current writer fence and claim still match. */
export async function renewEffectLeaseWithSql(
  sql: SqlExecutor,
  options: RenewEffectLeaseOptions,
): Promise<boolean> {
  if (!(await isFencingValidWithSql(sql, options))) return false;
  validateEffectLeaseDuration(options.leaseDurationMs);
  const result = await sql.run(RENEW_EFFECT_LEASE_SQL, [
    options.now + options.leaseDurationMs,
    options.effectId,
    options.claimToken,
    options.writerEpoch,
    options.now,
    ...fenceParameters(options),
  ]);
  return result.changes === 1;
}

/** Renews one claimed effect through an adapter-owned transaction. */
export async function renewEffectLeaseWithAdapter(
  storage: SqlStorageAdapter,
  options: RenewEffectLeaseOptions,
): Promise<boolean> {
  return storage.transaction(({ sql }) => renewEffectLeaseWithSql(sql, options));
}

/**
 * Appends pending effects inside an already-active async SQL transaction.
 *
 * This is the transaction-bound path used when an entity mutation and its
 * delivery-queue records must commit or roll back together. It owns a
 * savepoint so a duplicate dedupe key or a lost fence cannot leave only part
 * of an effect set behind.
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
 * Applies a claimed effect result through an already-active async SQL context.
 *
 * If delivery confirmation fails, the savepoint rolls the effect transition
 * back too; confirmed delivery state can never advance without its outbox row.
 */
export async function applyEffectResultWithSql(
  sql: SqlExecutor,
  options: ApplyResultOptions,
): Promise<boolean> {
  if (!(await isFencingValidWithSql(sql, options))) return false;
  validateApplyResultOptions(options);
  let confirmedEffectKind: EffectKind | undefined;
  if (options.projectionConfirmation !== undefined) {
    // The durable operation kind (from the claimed outbox row, never the
    // receipt) selects the confirmation's revision rule.
    confirmedEffectKind = await assertProjectionConfirmationTargetWithSql(
      sql,
      options.effectId,
      options.claimToken,
      options.projectionConfirmation,
    );
  }

  return withSqlSavepoint(sql, "apply_effect_result", async () => {
    const result = await sql.run(APPLY_EFFECT_RESULT_SQL, applyEffectResultParameters(options));
    if (result.changes !== 1) return false;
    if (options.projectionConfirmation !== undefined) {
      await writeProjectionConfirmationWithSql(
        sql,
        options.projectionConfirmation,
        confirmedEffectKind as EffectKind,
      );
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
 * The old effect is marked 'superseded', a new effect with a new effect_id and
 * new dedupe_key is inserted, and the new effect's predecessor_effect_id links
 * to the old one.
 */
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
 * Supersedes one effect without inserting a replacement.
 *
 * Used by reconciliation recovery to clear a terminal `failed` stream head
 * when a later correction already exists on the stream (for example a repair
 * that the old scanner enqueued while blocked). The durable outbox keeps the
 * `last_error_*` evidence; only the lifecycle advances to `superseded`, with
 * `supersedes_effect_id` linking to the effect that now owns the stream.
 *
 * Returns true when exactly one effect was superseded under the current fence.
 */
export async function supersedeEffectWithSql(
  sql: SqlExecutor,
  fence: FencingContext,
  effectId: string,
  supersededByEffectId: string,
): Promise<boolean> {
  await requireCurrentFenceWithSql(sql, fence);
  const result = await sql.run(SUPERSEDE_EFFECT_SQL, [
    supersededByEffectId,
    effectId,
    ...fenceParameters(fence),
  ]);
  return result.changes === 1;
}

/** Supersedes one effect without replacement inside an adapter transaction. */
export async function supersedeEffectWithAdapter(
  storage: SqlStorageAdapter,
  fence: FencingContext,
  effectId: string,
  supersededByEffectId: string,
): Promise<boolean> {
  return storage.transaction(({ sql }) =>
    supersedeEffectWithSql(sql, fence, effectId, supersededByEffectId),
  );
}

/**
 * Marks expired processing effects as requiring postcondition recovery.
 *
 * The worker must read the remote postcondition before it schedules a retry;
 * an expired lease is not evidence that the remote write did not happen.
 */
export async function recoverExpiredLeasesWithSql(
  sql: SqlExecutor,
  fence: FencingContext,
): Promise<number> {
  await requireCurrentFenceWithSql(sql, fence);
  const result = await sql.run(RECOVER_EXPIRED_LEASES_SQL, [
    fence.now,
    fence.now,
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

/** Moves a claimed effect into durable ambiguous-delivery recovery. */
export async function markDeliveryUncertainWithSql(
  sql: SqlExecutor,
  options: MarkDeliveryUncertainOptions,
): Promise<boolean> {
  if (!(await isFencingValidWithSql(sql, options))) return false;
  if (options.nextProbeAt < options.uncertainSince || options.uncertainSince < 0) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_EFFECT_OPTIONS,
      "uncertain delivery timestamps must be ordered non-negative values",
    );
  }
  const result = await sql.run(
    MARK_DELIVERY_UNCERTAIN_SQL,
    markDeliveryUncertainParameters(options),
  );
  return result.changes === 1;
}

/** Moves one claimed effect into durable ambiguous-delivery recovery. */
export async function markDeliveryUncertainWithAdapter(
  storage: SqlStorageAdapter,
  options: MarkDeliveryUncertainOptions,
): Promise<boolean> {
  return storage.transaction(({ sql }) => markDeliveryUncertainWithSql(sql, options));
}

/**
 * Returns an acknowledged-but-unprocessed batch suffix to pending.
 *
 * `reason` determines which `last_error_code`/`last_error_message` pair is
 * persisted on the row: `provider_batch` (default) when a valid provider
 * response explicitly says the batch budget stopped before this effect, or
 * `lease_recovered` when a writer-lease recovery requeues a renewed item
 * without any provider acknowledgement.
 */
export async function releaseUnprocessedEffectWithSql(
  sql: SqlExecutor,
  options: Pick<FencingContext, "role" | "writerEpoch" | "fencingToken" | "now"> & {
    readonly effectId: string;
    readonly claimToken: string;
    readonly reason?: "provider_batch" | "lease_recovered";
  },
): Promise<boolean> {
  if (!(await isFencingValidWithSql(sql, options))) return false;
  const reason = options.reason ?? "provider_batch";
  const pair = RELEASE_UNPROCESSED_EFFECT_REASON[reason];
  const result = await sql.run(RELEASE_UNPROCESSED_EFFECT_SQL, [
    options.now + 1_000,
    pair.code,
    pair.message,
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
    readonly reason?: "provider_batch" | "lease_recovered";
  },
): Promise<boolean> {
  return storage.transaction(({ sql }) => releaseUnprocessedEffectWithSql(sql, options));
}

/** Requeues a claimed effect only after the current fence still owns it. */
export async function retryClaimedEffectWithSql(
  sql: SqlExecutor,
  options: RetryClaimedEffectOptions,
): Promise<boolean> {
  if (!(await isFencingValidWithSql(sql, options))) return false;
  const result = await sql.run(REQUEUE_CLAIMED_EFFECT_SQL, retryClaimedEffectParameters(options));
  return result.changes === 1;
}

/** Requeues a claimed effect inside an adapter-owned transaction. */
export async function retryClaimedEffectWithAdapter(
  storage: SqlStorageAdapter,
  options: RetryClaimedEffectOptions,
): Promise<boolean> {
  return storage.transaction(({ sql }) => retryClaimedEffectWithSql(sql, options));
}

/** Reads one target stream through an already-active async SQL context. */
export async function findPendingEffectsByTargetWithSql(
  sql: SqlExecutor,
  logicalSheetId: string,
  targetKind: string,
  targetId: string,
): Promise<readonly PendingEffect[]> {
  const rows = await sql.all<SqlRow>(SELECT_PENDING_EFFECTS_BY_TARGET_SQL, [
    logicalSheetId,
    targetKind,
    targetId,
  ]);
  return decodeSqlRows(rows, decodePendingEffectRow, "pending effects");
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
export async function listReadyEffectsWithSql(
  sql: SqlExecutor,
  limit: number,
  now = Date.now(),
): Promise<readonly PendingEffect[]> {
  validateReadyEffectLimit(limit);
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_EFFECT_OPTIONS,
      "ready effect time must be a non-negative safe integer",
    );
  }
  const rows = await sql.all<SqlRow>(SELECT_READY_EFFECTS_SQL, [now, now, now, limit]);
  return decodeSqlRows(rows, decodePendingEffectRow, "ready effects");
}

/** Reads bounded head-of-line effects through a fresh adapter read context. */
export async function listReadyEffectsWithAdapter(
  storage: SqlStorageAdapter,
  limit: number,
  now = Date.now(),
): Promise<readonly PendingEffect[]> {
  return storage.read(({ sql }) => listReadyEffectsWithSql(sql, limit, now));
}

/**
 * Reads bounded head-of-line effects that can only be fast-append rows.
 *
 * The query jumps past any regular/recovery backlog in the same ready order,
 * so an arbitrary number of head-of-queue rows cannot starve the bulk append
 * path. Only the SQL-visible append shape is filtered; the caller still
 * validates each row's payload before claiming it.
 */
export async function listReadyFastAppendEffectsWithSql(
  sql: SqlExecutor,
  limit: number,
  now = Date.now(),
): Promise<readonly PendingEffect[]> {
  validateReadyEffectLimit(limit);
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_EFFECT_OPTIONS,
      "ready fast-append effect time must be a non-negative safe integer",
    );
  }
  const rows = await sql.all<SqlRow>(SELECT_READY_FAST_APPEND_EFFECTS_SQL, [now, limit]);
  return decodeSqlRows(rows, decodePendingEffectRow, "ready fast-append effects");
}

/** Reads bounded ready fast-append candidates through a fresh adapter read context. */
export async function listReadyFastAppendEffectsWithAdapter(
  storage: SqlStorageAdapter,
  limit: number,
  now = Date.now(),
): Promise<readonly PendingEffect[]> {
  return storage.read(({ sql }) => listReadyFastAppendEffectsWithSql(sql, limit, now));
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

/**
 * Readiness classification of the durable outbox for the FIRST
 * reconciliation-scan gate.
 *
 * - `busy`: claimable drain work exists — a `pending` effect with no
 *   earlier same-stream predecessor outside `applied`/`superseded` (a
 *   genuinely claimable head), or `processing`/`delivery_uncertain` work
 *   in flight. A first scan is deferred so it cannot enqueue corrections
 *   while the initial backlog is still draining.
 * - `repair-needed`: at least one terminal failed stream head exists (a
 *   `failed` effect whose `last_error_code` is NULL or NOT recoverable).
 *   Such a head blocks its stream; the scanner is the repair net that
 *   supersedes it, so the gate must ALLOW the first scan even while the
 *   outbox is busy.
 * - `idle`: no busy work and no terminal failed head; the scan runs.
 *
 * `conflict` and `blocked_candidate` rows are deliberately neither busy
 * work nor failed heads, and a `pending` follower behind them is not
 * claimable: those lifecycle states must never defer the first scan, or a
 * blocked stream could suppress the recovery that unblocks it forever.
 */
export type OutboxScanReadiness =
  | { readonly status: "idle" }
  | { readonly status: "busy" }
  | { readonly status: "repair-needed" };

/** Classifies the outbox scan readiness through an already-active SQL context. */
export async function readOutboxScanReadinessWithSql(
  sql: SqlExecutor,
): Promise<OutboxScanReadiness> {
  const row = await sql.get<{
    readonly busy_count: number;
    readonly terminal_failed_count: number;
  }>(READ_OUTBOX_SCAN_READINESS_SQL);
  const busyCount = row?.busy_count ?? 0;
  const terminalFailedCount = row?.terminal_failed_count ?? 0;
  if (terminalFailedCount > 0) return { status: "repair-needed" };
  if (busyCount > 0) return { status: "busy" };
  return { status: "idle" };
}

/** Classifies the outbox scan readiness through a fresh adapter read context. */
export async function readOutboxScanReadinessWithAdapter(
  storage: SqlStorageAdapter,
): Promise<OutboxScanReadiness> {
  return storage.read(({ sql }) => readOutboxScanReadinessWithSql(sql));
}

/**
 * Readiness of the System_State projection for the FIRST polling pass and
 * for external convergence barriers.
 *
 * - `draining`: at least one System_State effect is genuinely in flight
 *   (processing/delivery_uncertain, or a `pending` effect that is a
 *   claimable head). The first remote polling pass and external convergence
 *   readers defer so they cannot compete with the initial System_State
 *   drain on the shared request limiter.
 * - `ready`: no claimable System_State drain work remains. Terminal lifecycle
 *   states (applied, superseded, failed, conflict, blocked_candidate) never
 *   defer, and a `pending` follower behind such a predecessor is not drain
 *   work either, so a terminal failed head or an open conflict cannot keep
 *   the first polling pass draining forever — the poll/read-based checks
 *   surface those conditions themselves, exactly like the first
 *   reconciliation scan readiness. This is deliberately NOT the whole-outbox
 *   idle state: unrelated projections and repair-needed heads do not count.
 */
export type SystemStateDrainReadiness =
  | { readonly status: "draining" }
  | { readonly status: "ready" };

/** Classifies the System_State drain readiness through an already-active SQL context. */
export async function readSystemStateDrainReadinessWithSql(
  sql: SqlExecutor,
): Promise<SystemStateDrainReadiness> {
  const row = await sql.get<{ readonly count: number }>(COUNT_ACTIVE_SYSTEM_STATE_EFFECTS_SQL);
  const count = row?.count ?? 0;
  return count > 0 ? { status: "draining" } : { status: "ready" };
}

/** Classifies the System_State drain readiness through a fresh adapter read context. */
export async function readSystemStateDrainReadinessWithAdapter(
  storage: SqlStorageAdapter,
): Promise<SystemStateDrainReadiness> {
  return storage.read(({ sql }) => readSystemStateDrainReadinessWithSql(sql));
}
