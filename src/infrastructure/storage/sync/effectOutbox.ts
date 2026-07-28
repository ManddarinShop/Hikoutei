/**
 * Effect outbox claim, apply, and recovery operations.
 *
 * Per design concurrency/writer-rpc.md and storage-schema.md:
 * - Effects are claimed atomically (CAS on status = 'pending').
 * - Only one worker can claim an effect at a time.
 * - Apply results must pass fencing validation (epoch + token).
 * - Supersede/replan atomically closes old effect and inserts new one.
 */

import { STORAGE_ERROR_CODES, StorageError } from "../errors.js";
import type { DatabaseSyncLike } from "../sqlite/sqliteBridge.js";
import { withSqlSavepoint } from "../sqlite/sqlTransaction.js";
import {
  isFencingValid,
  isFencingValidWithSql,
} from "./writerLease.js";
import type { FencingContext } from "./writerLease.js";
import type {
  Applicability,
  EffectKind,
  EffectTargetKind,
  Presence,
} from "../../../domain/index.js";
import type {
  SqlExecutor,
  SqlParameter,
  SqlStorageAdapter,
} from "../../../adapter/persistence/contracts/sql.js";
import { toSqlNullable } from "../sqlite/sqlState.js";

/** Failed effect codes that are safe to inspect and redrive after read-back. */
export const SYNC_EFFECT_RECOVERY_ERROR_CODES = {
  LEASE_EXPIRED_REQUIRES_POSTCONDITION: "lease_expired_requires_postcondition",
  GATEWAY_RETRYABLE_ERROR: "gateway_retryable_error",
  POSTCONDITION_READ_FAILED: "postcondition_read_failed",
  POSTCONDITION_UNAVAILABLE: "postcondition_unavailable",
  POSTCONDITION_UNAPPLIED_REQUIRES_REDRIVE: "postcondition_unapplied_requires_redrive",
} as const;

const RECOVERABLE_EFFECT_ERROR_CODE_SQL = [
  SYNC_EFFECT_RECOVERY_ERROR_CODES.LEASE_EXPIRED_REQUIRES_POSTCONDITION,
  SYNC_EFFECT_RECOVERY_ERROR_CODES.GATEWAY_RETRYABLE_ERROR,
  SYNC_EFFECT_RECOVERY_ERROR_CODES.POSTCONDITION_READ_FAILED,
  SYNC_EFFECT_RECOVERY_ERROR_CODES.POSTCONDITION_UNAVAILABLE,
  SYNC_EFFECT_RECOVERY_ERROR_CODES.POSTCONDITION_UNAPPLIED_REQUIRES_REDRIVE,
].map((code) => `'${code}'`)
  .join(", ");

const FENCE_EXISTS_SQL = `
  SELECT 1 FROM writer_lease
  WHERE role = ? AND writer_epoch = ? AND fencing_token = ? AND lease_until > ?
`;

const CLAIM_EFFECT_SQL = `
  UPDATE sheet_effect_outbox AS candidate
  SET status = 'processing', claim_token = ?, writer_epoch = ?, lease_until = ?,
      attempts = attempts + 1
  WHERE candidate.effect_id = ?
    AND candidate.status IN ('pending', 'failed')
    AND EXISTS (${FENCE_EXISTS_SQL})
    AND NOT EXISTS (
      SELECT 1
      FROM sheet_effect_outbox AS predecessor
      WHERE predecessor.logical_sheet_id = candidate.logical_sheet_id
        AND predecessor.target_kind = candidate.target_kind
        AND predecessor.target_id = candidate.target_id
        AND predecessor.stream_sequence < candidate.stream_sequence
        AND predecessor.status NOT IN ('applied', 'superseded')
    )
`;

const INSERT_PENDING_EFFECT_SQL = `
  INSERT INTO sheet_effect_outbox (
    effect_id, effect_kind, commit_id, logical_sheet_id, physical_sheet_id,
    projection, row_binding_id, conflict_id, target_kind, target_id,
    target_entity_revision, target_field_revision_hash, target_canonical_commit_id,
    expected_visible_revision, expected_visible_hash, repair_guard_hash,
    source_quarantine_id, payload_json, payload_hash, effect_dedupe_key,
    stream_sequence, created_at, status
  )
  SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending'
  WHERE EXISTS (${FENCE_EXISTS_SQL})
`;

const APPLY_EFFECT_RESULT_SQL = `
  UPDATE sheet_effect_outbox
  SET status = ?, last_error_code = ?, last_error_message = ?,
      claim_token = NULL, lease_until = NULL
  WHERE effect_id = ?
    AND status = 'processing'
    AND claim_token = ?
    AND writer_epoch = ?
    AND lease_until IS NOT NULL
    AND lease_until > ?
    AND EXISTS (${FENCE_EXISTS_SQL})
`;

const SUPERSEDE_EFFECT_SQL = `
  UPDATE sheet_effect_outbox
  SET status = 'superseded', supersedes_effect_id = ?
  WHERE effect_id = ?
    AND status IN ('pending', 'processing', 'blocked_candidate', 'conflict', 'failed')
    AND EXISTS (${FENCE_EXISTS_SQL})
`;

const INSERT_REPLANNED_EFFECT_SQL = `
  INSERT INTO sheet_effect_outbox (
    effect_id, effect_kind, commit_id, logical_sheet_id, physical_sheet_id,
    projection, row_binding_id, conflict_id, target_kind, target_id,
    target_entity_revision, target_field_revision_hash, target_canonical_commit_id,
    expected_visible_revision, expected_visible_hash, repair_guard_hash,
    source_quarantine_id, payload_json, payload_hash, effect_dedupe_key,
    stream_sequence, predecessor_effect_id, created_at, status
  )
  SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending'
  WHERE EXISTS (${FENCE_EXISTS_SQL})
`;

const RECOVER_EXPIRED_LEASES_SQL = `
  UPDATE sheet_effect_outbox
  SET status = 'failed', claim_token = NULL, lease_until = NULL,
      last_error_code = '${SYNC_EFFECT_RECOVERY_ERROR_CODES.LEASE_EXPIRED_REQUIRES_POSTCONDITION}',
      last_error_message = 'Read the remote postcondition before retrying this effect.'
  WHERE status = 'processing' AND lease_until IS NOT NULL AND lease_until <= ?
    AND EXISTS (${FENCE_EXISTS_SQL})
`;

const REQUEUE_CLAIMED_EFFECT_SQL = `
  UPDATE sheet_effect_outbox
  SET status = 'pending', claim_token = NULL, lease_until = NULL,
      last_error_code = ?, last_error_message = ?
  WHERE effect_id = ? AND status = 'processing' AND claim_token = ?
    AND writer_epoch = ? AND lease_until IS NOT NULL AND lease_until > ?
    AND EXISTS (${FENCE_EXISTS_SQL})
`;

const RELEASE_UNPROCESSED_EFFECT_SQL = `
  UPDATE sheet_effect_outbox
  SET status = 'pending', claim_token = NULL, lease_until = NULL,
      last_error_code = 'gateway_batch_deferred',
      last_error_message = 'Gateway acknowledged a bounded batch before this effect.'
  WHERE effect_id = ? AND status = 'processing' AND claim_token = ?
    AND writer_epoch = ? AND lease_until IS NOT NULL AND lease_until > ?
    AND EXISTS (${FENCE_EXISTS_SQL})
`;

const SELECT_PENDING_EFFECTS_BY_TARGET_SQL = `
  SELECT effect_id, effect_kind, commit_id, logical_sheet_id, physical_sheet_id,
         projection, row_binding_id, conflict_id, target_kind, target_id,
         target_entity_revision, target_field_revision_hash, target_canonical_commit_id,
         expected_visible_revision, expected_visible_hash, repair_guard_hash,
         source_quarantine_id, payload_json, payload_hash, effect_dedupe_key,
         stream_sequence, created_at, status
  FROM sheet_effect_outbox
  WHERE logical_sheet_id = ? AND target_kind = ? AND target_id = ?
    AND status = 'pending'
    AND NOT EXISTS (
      SELECT 1
      FROM sheet_effect_outbox AS predecessor
      WHERE predecessor.logical_sheet_id = sheet_effect_outbox.logical_sheet_id
        AND predecessor.target_kind = sheet_effect_outbox.target_kind
        AND predecessor.target_id = sheet_effect_outbox.target_id
        AND predecessor.stream_sequence < sheet_effect_outbox.stream_sequence
        AND predecessor.status NOT IN ('applied', 'superseded')
    )
  ORDER BY stream_sequence
`;

const SELECT_READY_EFFECTS_SQL = `
  SELECT effect_id, effect_kind, commit_id, logical_sheet_id, physical_sheet_id,
         projection, row_binding_id, conflict_id, target_kind, target_id,
         target_entity_revision, target_field_revision_hash, target_canonical_commit_id,
         expected_visible_revision, expected_visible_hash, repair_guard_hash,
         source_quarantine_id, payload_json, payload_hash, effect_dedupe_key,
         stream_sequence, created_at, status
  FROM sheet_effect_outbox AS candidate
  WHERE (
    candidate.status = 'pending'
    OR (
      candidate.status = 'failed'
      AND candidate.last_error_code IN (${RECOVERABLE_EFFECT_ERROR_CODE_SQL})
    )
  )
    AND NOT EXISTS (
      SELECT 1
      FROM sheet_effect_outbox AS predecessor
      WHERE predecessor.logical_sheet_id = candidate.logical_sheet_id
        AND predecessor.target_kind = candidate.target_kind
        AND predecessor.target_id = candidate.target_id
        AND predecessor.stream_sequence < candidate.stream_sequence
        AND predecessor.status NOT IN ('applied', 'superseded')
    )
  ORDER BY candidate.logical_sheet_id, candidate.physical_sheet_id,
           candidate.target_kind, candidate.target_id, candidate.stream_sequence
  LIMIT ?
`;

const COUNT_PENDING_OR_PROCESSING_EFFECTS_SQL = `
  SELECT COUNT(*) AS count
  FROM sheet_effect_outbox
  WHERE status IN ('pending', 'processing')
`;

const UPSERT_VISIBLE_STATE_SQL = `
  INSERT INTO sheet_visible_state (
    physical_sheet_id, projection, row_binding_id, confirmed_snapshot_hash,
    confirmed_visible_revision, confirmed_entity_revision, last_observed_hash
  ) VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(physical_sheet_id, projection, row_binding_id)
  DO UPDATE SET
    confirmed_snapshot_hash = excluded.confirmed_snapshot_hash,
    confirmed_visible_revision = excluded.confirmed_visible_revision,
    confirmed_entity_revision = excluded.confirmed_entity_revision,
    last_observed_hash = excluded.last_observed_hash
  WHERE sheet_visible_state.confirmed_visible_revision <= excluded.confirmed_visible_revision
`;

const UPSERT_VISIBLE_FIELD_STATE_SQL = `
  INSERT INTO sheet_visible_field_state (
    physical_sheet_id, projection, row_binding_id, field_name,
    confirmed_field_hash, confirmed_visible_revision, candidate_epoch,
    last_observed_field_hash
  ) VALUES (?, ?, ?, ?, ?, ?, 0, ?)
  ON CONFLICT(physical_sheet_id, projection, row_binding_id, field_name)
  DO UPDATE SET
    confirmed_field_hash = excluded.confirmed_field_hash,
    confirmed_visible_revision = excluded.confirmed_visible_revision,
    last_observed_field_hash = excluded.last_observed_field_hash
  WHERE sheet_visible_field_state.confirmed_visible_revision <= excluded.confirmed_visible_revision
`;

export interface ClaimResult {
  readonly effectId: string;
  readonly claimToken: string;
  readonly success: boolean;
  readonly reason: "claimed" | "stale_fencing" | "not_claimable";
}

/** Input required to claim an effect with the current worker fence. */
export interface ClaimEffectOptions extends FencingContext {
  readonly effectId: string;
  readonly claimToken: string;
  readonly leaseDurationMs: number;
}

/**
 * Claims a pending effect for processing.
 * Uses CAS on status to ensure only one worker wins.
 */
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

export interface ApplyResultOptions extends FencingContext {
  readonly effectId: string;
  readonly claimToken: string;
  readonly status: "applied" | "blocked_candidate" | "superseded" | "conflict" | "failed";
  readonly lastErrorCode: Presence<string>;
  readonly lastErrorMessage: Presence<string>;
  /**
   * Gateway read-back evidence that advances confirmed projection state in the
   * same savepoint as an applied outbox result.  It is intentionally optional
   * for legacy callers that do not materialize a projection row.
   */
  readonly projectionConfirmation?: EffectProjectionConfirmation;
}

/** Confirmed projection state returned only after a gateway postcondition read. */
export interface EffectProjectionConfirmation {
  readonly physicalSheetId: string;
  readonly projection: string;
  readonly rowBindingId: string;
  readonly visibleRevision: number;
  readonly visibleHash: string;
  readonly entityRevision: Applicability<number>;
  readonly fieldHashes: Readonly<Record<string, string>>;
}

/** A pending outbox row prepared by the writer transaction. */
export interface NewEffect {
  readonly effectId: string;
  readonly effectKind: EffectKind;
  readonly commitId: string;
  readonly logicalSheetId: string;
  readonly physicalSheetId: string;
  readonly projection: string;
  readonly rowBindingId: Presence<string>;
  readonly conflictId: Presence<string>;
  readonly targetKind: EffectTargetKind;
  readonly targetId: string;
  readonly targetEntityRevision: Applicability<number>;
  readonly targetFieldRevisionHash: Applicability<string>;
  readonly targetCanonicalCommitId: Applicability<string>;
  readonly expectedVisibleRevision: number;
  readonly expectedVisibleHash: string;
  readonly repairGuardHash: Presence<string>;
  readonly sourceQuarantineId: Presence<string>;
  readonly payloadJson: string;
  readonly payloadHash: string;
  readonly effectDedupeKey: string;
  readonly streamSequence: number;
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
export interface RetryClaimedEffectOptions
  extends Pick<FencingContext, "role" | "writerEpoch" | "fencingToken" | "now"> {
  readonly effectId: string;
  readonly claimToken: string;
  readonly lastErrorCode: string;
  readonly lastErrorMessage: string;
}

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

export interface PendingEffect {
  readonly effect_id: string;
  readonly effect_kind: string;
  readonly commit_id: string;
  readonly logical_sheet_id: string;
  readonly physical_sheet_id: string;
  readonly projection: string;
  readonly row_binding_id: string | null;
  readonly conflict_id: string | null;
  readonly target_kind: string;
  readonly target_id: string;
  readonly target_entity_revision: number | null;
  readonly target_field_revision_hash: string | null;
  readonly target_canonical_commit_id: string | null;
  readonly expected_visible_revision: number;
  readonly expected_visible_hash: string;
  readonly repair_guard_hash: string | null;
  readonly source_quarantine_id: string | null;
  readonly payload_json: string;
  readonly payload_hash: string;
  readonly effect_dedupe_key: string;
  readonly stream_sequence: number;
  readonly created_at: number;
  readonly status: string;
}

function validateProjectionConfirmation(confirmation: EffectProjectionConfirmation): void {
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

function validateApplyResultOptions(options: ApplyResultOptions): void {
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

function validateEffectLeaseDuration(leaseDurationMs: number): void {
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs <= 0) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_EFFECT_OPTIONS,
      "effect lease duration must be a positive safe integer",
    );
  }
}

function validateReadyEffectLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_EFFECT_OPTIONS,
      "ready effect limit must be a positive safe integer",
    );
  }
}

/** Writes row and field confirmation only after the outbox effect has won its claim CAS. */
function writeProjectionConfirmation(
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
async function writeProjectionConfirmationWithSql(
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

function requireCurrentFence(db: DatabaseSyncLike, fence: FencingContext): void {
  if (!isFencingValid(db, fence)) {
    throw new StorageError(
      STORAGE_ERROR_CODES.STALE_WRITER_FENCE,
      "writer fencing is stale or expired",
    );
  }
}

async function requireCurrentFenceWithSql(
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

function fenceParameters(fence: FencingContext): readonly [string, number, string, number] {
  return [fence.role, fence.writerEpoch, fence.fencingToken, fence.now];
}

function claimEffectParameters(options: ClaimEffectOptions): readonly SqlParameter[] {
  return [
    options.claimToken,
    options.writerEpoch,
    options.now + options.leaseDurationMs,
    options.effectId,
    ...fenceParameters(options),
  ];
}

function applyEffectResultParameters(options: ApplyResultOptions): readonly SqlParameter[] {
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

function effectInsertParameters(effect: NewEffect): readonly SqlParameter[] {
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

function pendingEffectParameters(
  effect: NewEffect,
  fence: FencingContext,
): readonly SqlParameter[] {
  return [
    ...effectInsertParameters(effect),
    fence.now,
    ...fenceParameters(fence),
  ];
}

function replannedEffectParameters(
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
class AsyncFenceLostError extends Error {}
