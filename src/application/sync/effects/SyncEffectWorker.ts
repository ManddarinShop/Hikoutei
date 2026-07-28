/**
 * Fenced outbox worker for projection effects.
 *
 * It owns only claim/result transitions.  Canonical state and any repair
 * replan payload are supplied by the writer boundary; the gateway is never
 * allowed to choose a winner or silently retry a response-lost write.
 */

import { randomUUID } from "node:crypto";
import {
  EMPTY_STRING_LENGTH_ZERO,
  NON_NEGATIVE_SAFE_INTEGER_MINIMUM,
  POSITIVE_SAFE_INTEGER_MINIMUM,
  stableHash,
  type Applicability,
  type EffectKind,
  type EffectStatus,
  type EffectTargetKind,
  type LookupResult,
  type Presence,
} from "../../../domain/index.js";
import {
  APPLICABILITY_KINDS,
  LOOKUP_RESULT_KINDS,
  PRESENCE_KINDS,
} from "../../../shared/state/constants.js";
import { CONFLICT_STATUSES } from "../../../domain/model/constants.js";
import {
  applyEffectResultWithAdapter,
  claimEffectWithAdapter,
  claimWriterLeaseWithAdapter,
  recoverExpiredLeasesWithAdapter,
  listReadyEffectsWithAdapter,
  releaseUnprocessedEffectWithAdapter,
  retryClaimedEffectWithAdapter,
  supersedeAndReplanWithAdapter,
  SYNC_EFFECT_RECOVERY_ERROR_CODES,
  type ApplyResultOptions,
  type ClaimEffectOptions,
  type ClaimLeaseOptions,
  type ClaimResult,
  type FencingContext,
  type NewEffect,
  type PendingEffect,
  type RetryClaimedEffectOptions,
  type WriterLease,
  type WriterLeaseClaimResult,
} from "../../../infrastructure/storage/index.js";
import {
  STORAGE_ERROR_CODES,
  StorageError,
} from "../../../infrastructure/storage/errors.js";
import { fromSqlNullable } from "../../../infrastructure/storage/sqlite/sqlState.js";
import type { SqlExecutor, SqlStorageAdapter } from "../../../adapter/persistence/contracts/sql.js";
import {
  parseSyncProjectionEffectPayload,
  type ApplySyncEffectsRequest,
  type FastAppendRowsRequest,
  type ReadSyncEffectPostconditionsRequest,
  type SyncEffectPostcondition,
  type SyncGatewayEffect,
  type SyncGatewayEffectResult,
  type SyncProjection,
  type SyncEffectWorkerGateway,
  type SyncEffectWorkerFullGateway,
} from "../gateway/syncGateway.js";
import {
  SYNC_GATEWAY_EFFECT_RESULT_STATUSES,
  SYNC_GATEWAY_POSTCONDITION_DISPOSITIONS,
  SYNC_GATEWAY_POSTCONDITION_MODES,
  SYNC_GATEWAY_POSTCONDITION_STATUSES,
  SYNC_GATEWAY_PROJECTIONS,
} from "../gateway/constants.js";
import { WRITER_LEASE_CLAIM_RESULT_KINDS } from "../../../infrastructure/storage/sync/writerLease.js";
import {
  SYNC_TIMING_OPERATION_KINDS,
  SYNC_TIMING_SCOPES,
  type SyncGatewayTiming,
  type SyncTimingEvent,
  type SyncTimingOperationCounts,
  type SyncTimingOperationKind,
  type SyncTimingSink,
} from "../telemetry/syncTiming.js";

const DEFAULT_WORKER_ROLE = "sync-effect-worker";
const DEFAULT_WRITER_LEASE_DURATION_MS = 60_000;
const DEFAULT_EFFECT_LEASE_DURATION_MS = 30_000;

const SYNC_EFFECT_KINDS = {
  SYSTEM_PROJECTION: "system_projection",
  CANDIDATE_RECONCILE: "candidate_reconcile",
  SYSTEM_REPAIR: "system_repair",
  RESOLUTION_PROJECTION: "resolution_projection",
  RESOLUTION_DELETE: "resolution_delete",
  USER_INPUT_DELETE: "user_input_delete",
} as const satisfies Record<string, EffectKind>;

const EFFECT_TARGET_KINDS = {
  ENTITY: "entity",
  ROW_BINDING: "row_binding",
  PROJECTION_ROW: "projection_row",
  CONFLICT: "conflict",
} as const satisfies Record<string, EffectTargetKind>;

const OUTBOX_EFFECT_STATUSES = {
  FAILED: "failed",
  APPLIED: "applied",
  BLOCKED_CANDIDATE: "blocked_candidate",
  SUPERSEDED: "superseded",
  CONFLICT: "conflict",
} as const satisfies Record<string, EffectStatus>;

const WORKER_ERROR_CODES = {
  INVALID_EFFECT_PAYLOAD: "invalid_effect_payload",
  ACTIVE_CANDIDATE_PRESERVED: "active_candidate_preserved",
  GATEWAY_SUPERSEDED: "gateway_superseded",
  CANDIDATE_GUARD_MISMATCH: "candidate_guard_mismatch",
  VISIBLE_GUARD_MISMATCH: "visible_guard_mismatch",
  GATEWAY_SCHEMA_ERROR: "gateway_schema_error",
  GATEWAY_RETRYABLE_ERROR: SYNC_EFFECT_RECOVERY_ERROR_CODES.GATEWAY_RETRYABLE_ERROR,
  POSTCONDITION_READ_FAILED: SYNC_EFFECT_RECOVERY_ERROR_CODES.POSTCONDITION_READ_FAILED,
  POSTCONDITION_APPLIED_WITHOUT_VISIBLE_STATE: "postcondition_applied_without_visible_state",
  POSTCONDITION_UNAVAILABLE: SYNC_EFFECT_RECOVERY_ERROR_CODES.POSTCONDITION_UNAVAILABLE,
  POSTCONDITION_CHANGED: "postcondition_changed",
  POSTCONDITION_UNAPPLIED_REQUIRES_REDRIVE:
    SYNC_EFFECT_RECOVERY_ERROR_CODES.POSTCONDITION_UNAPPLIED_REQUIRES_REDRIVE,
  REPAIR_REOBSERVE_REQUIRES_WRITER_REPLAN: "repair_reobserve_requires_writer_replan",
  REPAIR_REPLAN_FAILED: "repair_replan_failed",
  REPAIR_REPLAN_DEFERRED: "repair_replan_deferred",
  GATEWAY_CAPABILITY_MISSING: "gateway_capability_missing",
} as const;

type SyncEffectWorkerErrorCode =
  (typeof WORKER_ERROR_CODES)[keyof typeof WORKER_ERROR_CODES];

const USER_INPUT_CANDIDATE_BLOCK_SQL = `
    SELECT 1 AS blocked
    FROM sheet_visible_field_state AS visible
    LEFT JOIN sync_conflict AS conflict
      ON conflict.conflict_id = visible.active_candidate_conflict_id
    WHERE visible.physical_sheet_id = ?
      AND visible.projection = '${SYNC_GATEWAY_PROJECTIONS.USER_INPUT}'
      AND visible.row_binding_id = ?
      AND visible.field_name IN (__FIELD_NAMES__)
      AND visible.active_candidate_conflict_id IS NOT NULL
      AND visible.active_candidate_hash IS NOT NULL
      AND (conflict.conflict_id IS NULL OR conflict.status IN (
        '${CONFLICT_STATUSES.OPEN}', '${CONFLICT_STATUSES.NEEDS_REBASE}'
      ))
    LIMIT 1
  `;

/** An effect plus evidence supplied to a writer-owned system-repair replanner. */
export interface RepairReplanRequest {
  readonly effect: PendingEffect;
  readonly gatewayResult: Presence<SyncGatewayEffectResult>;
  readonly postcondition: Presence<SyncEffectPostcondition>;
}

/** Callback that creates a fresh effect without mutating the old evidence. */
export type RepairReplanFactory = (request: RepairReplanRequest) => Presence<NewEffect>;

/** Shared construction options for a bounded effect-worker pass. */
interface SyncEffectWorkerBaseOptions {
  readonly gateway: SyncEffectWorkerGateway;
  readonly workerId: string;
  readonly now: number;
  readonly maxEffects: number;
  readonly writerRole?: string;
  readonly writerLeaseDurationMs?: number;
  readonly effectLeaseDurationMs?: number;
  readonly makeRepairReplan?: RepairReplanFactory;
  /** Optional diagnostics sink for worker and gateway phases. */
  readonly onTiming?: SyncTimingSink;
}

type SyncEffectWorkerFullOptions = Omit<SyncEffectWorkerBaseOptions, "gateway"> & {
  readonly gateway: SyncEffectWorkerFullGateway;
};

/** Construction options for a worker running through an async storage adapter. */
export interface SyncEffectWorkerWithAdapterOptions extends SyncEffectWorkerBaseOptions {
  readonly storage: SqlStorageAdapter;
}

/** Counters that make partial results and recovery visible to callers. */
export interface SyncEffectWorkerReport {
  readonly lease: Presence<WriterLease>;
  readonly expiredLeasesRecovered: number;
  readonly selected: number;
  readonly claimed: number;
  readonly applied: number;
  readonly blockedCandidate: number;
  readonly superseded: number;
  readonly conflicted: number;
  readonly failed: number;
  readonly deferred: number;
  readonly requeued: number;
  readonly replanned: number;
  readonly responseLossRecovered: number;
}

interface ClaimedEffect {
  readonly pending: PendingEffect;
  readonly claimToken: string;
  readonly gatewayEffect: Presence<SyncGatewayEffect>;
  readonly invalidPayloadError: Presence<string>;
}

/** Persistence operations used by the shared effect-worker state machine. */
interface EffectWorkerStorage {
  claimWriterLease(options: ClaimLeaseOptions): Promise<WriterLeaseClaimResult>;
  recoverExpiredLeases(fence: FencingContext): Promise<number>;
  listReadyEffects(limit: number): Promise<readonly PendingEffect[]>;
  claimEffect(options: ClaimEffectOptions): Promise<ClaimResult>;
  applyEffectResult(options: ApplyResultOptions): Promise<boolean>;
  releaseUnprocessedEffect(
    options: Pick<FencingContext, "role" | "writerEpoch" | "fencingToken" | "now"> & {
      readonly effectId: string;
      readonly claimToken: string;
    },
  ): Promise<boolean>;
  retryClaimedEffect(options: RetryClaimedEffectOptions): Promise<boolean>;
  supersedeAndReplan(
    fence: FencingContext,
    oldEffectId: string,
    newEffect: NewEffect,
  ): Promise<void>;
  isUserInputCandidateBlocked(item: ClaimedEffect): Promise<boolean>;
}

/**
 * Processes effects through an adapter-owned SQL connection.
 *
 * This is the MikroORM-compatible worker entrypoint. It never opens the
 * legacy synchronous `node:sqlite` database beside the ORM connection.
 */
export async function runSyncEffectWorkerWithAdapter(
  options: SyncEffectWorkerWithAdapterOptions,
): Promise<SyncEffectWorkerReport> {
  return runEffectWorker(options, createAdapterEffectWorkerStorage(options.storage));
}

async function runEffectWorker(
  options: SyncEffectWorkerBaseOptions,
  storage: EffectWorkerStorage,
): Promise<SyncEffectWorkerReport> {
  const passStartedAt = Date.now();
  validateOptions(options);
  const role = options.writerRole ?? DEFAULT_WORKER_ROLE;
  const leaseDuration = options.writerLeaseDurationMs ?? DEFAULT_WRITER_LEASE_DURATION_MS;
  const effectLeaseDuration = options.effectLeaseDurationMs ?? DEFAULT_EFFECT_LEASE_DURATION_MS;
  const leaseStartedAt = Date.now();
  const claimResult = await storage.claimWriterLease({
    role,
    writerId: options.workerId,
    leaseDurationMs: leaseDuration,
    now: options.now,
  });
  if (claimResult.kind !== WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED) {
    const report = mutableReport(absentValue<WriterLease>());
    emitWorkerTiming(options, {
      scope: SYNC_TIMING_SCOPES.WORKER,
      phase: "writer_lease_claim",
      durationMs: Date.now() - leaseStartedAt,
      operationKinds: [],
      operationCounts: emptyOperationCounts(),
    });
    emitWorkerTiming(options, {
      scope: SYNC_TIMING_SCOPES.WORKER,
      phase: "worker_total",
      durationMs: Date.now() - passStartedAt,
      operationKinds: [],
      operationCounts: emptyOperationCounts(),
    });
    return freezeReport(report);
  }
  const report = mutableReport(presentValue(claimResult.lease));
  emitWorkerTiming(options, {
    scope: SYNC_TIMING_SCOPES.WORKER,
    phase: "writer_lease_claim",
    durationMs: Date.now() - leaseStartedAt,
    operationKinds: [],
    operationCounts: emptyOperationCounts(),
  });
  const fence = fenceFromLease(claimResult.lease, options.now);
  const selectStartedAt = Date.now();
  report.expiredLeasesRecovered = await storage.recoverExpiredLeases(fence);
  const selected = await storage.listReadyEffects(options.maxEffects);
  report.selected = selected.length;
  emitWorkerTiming(options, {
    scope: SYNC_TIMING_SCOPES.WORKER,
    phase: "recover_and_select",
    durationMs: Date.now() - selectStartedAt,
    operationKinds: operationKindsForPendingEffects(selected),
    operationCounts: countsForPendingEffects(selected),
  });

  const claimed: ClaimedEffect[] = [];
  const recoveryCandidates: ClaimedEffect[] = [];
  const claimEffectsStartedAt = Date.now();
  for (const pending of selected) {
    const claimToken = "claim:" + randomUUID();
    const claim = await storage.claimEffect({
      ...fence,
      effectId: pending.effect_id,
      claimToken,
      leaseDurationMs: effectLeaseDuration,
    });
    if (!claim.success) continue;
    report.claimed += 1;
    let gatewayEffect: Presence<SyncGatewayEffect>;
    let invalidPayloadError: Presence<string>;
    try {
      gatewayEffect = presentValue(toGatewayEffect(pending));
      invalidPayloadError = absentValue();
    } catch (error: unknown) {
      gatewayEffect = absentValue();
      invalidPayloadError = presentValue(safeErrorMessage(error));
    }
    const item = { pending, claimToken, gatewayEffect, invalidPayloadError };
    if (pending.status === OUTBOX_EFFECT_STATUSES.FAILED) {
      recoveryCandidates.push(item);
      continue;
    }
    claimed.push(item);
  }
  emitWorkerTiming(options, {
    scope: SYNC_TIMING_SCOPES.WORKER,
    phase: "effect_claims",
    durationMs: Date.now() - claimEffectsStartedAt,
    operationKinds: operationKindsForItems([...claimed, ...recoveryCandidates]),
    operationCounts: countsForItems([...claimed, ...recoveryCandidates]),
  });

  const fullGateway = isFullEffectGateway(options.gateway);
  if (fullGateway === undefined) {
    await rejectUnsupportedGatewayEffects(
      storage,
      fence,
      recoveryCandidates,
      report,
    );
  } else {
    await recoverUnknownResults(
      { ...options, gateway: fullGateway },
      storage,
      fence,
      recoveryCandidates,
      report,
    );
  }

  const usable = claimed.filter((item) => isPresent(item.gatewayEffect));
  for (const invalid of claimed.filter((item) => isAbsent(item.gatewayEffect))) {
    await completeFailure(
      storage,
      fence,
      invalid,
      WORKER_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
      invalid.invalidPayloadError,
      report,
    );
  }

  // A User_Input reconcile or physical delete is safe only while no unresolved
  // user candidate owns one of its fields. This local gate runs before the
  // remote CAS so stale canonical work cannot erase a candidate merely because
  // its Sheet baseline happens to still look unchanged.
  const dispatchable: ClaimedEffect[] = [];
  const candidateGateStartedAt = Date.now();
  for (const item of usable) {
    if (!(await storage.isUserInputCandidateBlocked(item))) {
      dispatchable.push(item);
      continue;
    }
    if (await storage.applyEffectResult({
      ...fence,
      effectId: item.pending.effect_id,
      claimToken: item.claimToken,
      status: OUTBOX_EFFECT_STATUSES.BLOCKED_CANDIDATE,
      lastErrorCode: presentValue(WORKER_ERROR_CODES.ACTIVE_CANDIDATE_PRESERVED),
      lastErrorMessage: presentValue("An unresolved User_Input candidate owns a projected field."),
    })) {
      report.blockedCandidate += 1;
    }
  }
  emitWorkerTiming(options, {
    scope: SYNC_TIMING_SCOPES.WORKER,
    phase: "candidate_gate",
    durationMs: Date.now() - candidateGateStartedAt,
    operationKinds: operationKindsForItems(usable),
    operationCounts: countsForItems(usable),
  });

  const fastAppendItems = dispatchable.filter(isFastAppendCandidate);
  const regularItems = dispatchable.filter((item) => !isFastAppendCandidate(item));

  for (const group of groupByFastAppendRequest(fastAppendItems)) {
    await dispatchFastAppendGroup(options, storage, fence, group, report);
  }

  if (fullGateway === undefined) {
    await rejectUnsupportedGatewayEffects(storage, fence, regularItems, report);
  } else {
    for (const group of groupByGatewayRequest(regularItems)) {
      const deferredEffectIds = new Set<string>();
      let response: Awaited<ReturnType<SyncEffectWorkerFullGateway["applyEffects"]>>;
      const regularOperationCounts = countsForItems(group.items);
      const regularOperationKinds = operationKindsForCounts(regularOperationCounts);
      const gatewayStartedAt = Date.now();
      try {
        response = await fullGateway.applyEffects(group.request);
      } catch {
        emitWorkerTiming(options, {
          scope: SYNC_TIMING_SCOPES.WORKER,
          phase: "regular_gateway_dispatch",
          durationMs: Date.now() - gatewayStartedAt,
          operationKinds: regularOperationKinds,
          operationCounts: regularOperationCounts,
        });
        // Remote side may have written the effect before transport failed.
        await recoverUnknownResults(
          { ...options, gateway: fullGateway },
          storage,
          fence,
          group.items,
          report,
        );
        continue;
      }
      emitGatewayTiming(options, response.timing);
      emitWorkerTiming(options, {
        scope: SYNC_TIMING_SCOPES.WORKER,
        phase: "regular_gateway_dispatch",
        durationMs: Date.now() - gatewayStartedAt,
        operationKinds: regularOperationKinds,
        operationCounts: regularOperationCounts,
      });

      const resultPersistenceStartedAt = Date.now();
      const byEffectId = new Map(response.results.map((result) => [result.effectId, result]));
      for (const item of group.items) {
        const result = lookupResult(byEffectId.get(item.pending.effect_id));
        if (result.kind === LOOKUP_RESULT_KINDS.NOT_FOUND && response.hasMore) {
          if (await storage.releaseUnprocessedEffect({
            ...fence,
            effectId: item.pending.effect_id,
            claimToken: item.claimToken,
          })) {
            report.deferred += 1;
            deferredEffectIds.add(item.pending.effect_id);
          }
        }
      }
      const recoveryItems: ClaimedEffect[] = [];
      for (const item of group.items) {
        const result = lookupResult(byEffectId.get(item.pending.effect_id));
        if (
          result.kind === LOOKUP_RESULT_KINDS.NOT_FOUND &&
          deferredEffectIds.has(item.pending.effect_id)
        ) continue;
        if (
          result.kind === LOOKUP_RESULT_KINDS.NOT_FOUND ||
          result.value.payloadHash !== item.pending.payload_hash
        ) {
          recoveryItems.push(item);
          continue;
        }
        if (
          (result.value.status === SYNC_GATEWAY_EFFECT_RESULT_STATUSES.APPLIED ||
            result.value.status === SYNC_GATEWAY_EFFECT_RESULT_STATUSES.ALREADY_APPLIED) &&
          (
            !isSuccessfulGatewayPostcondition(result.value.postcondition) ||
            !isPresent(result.value.visibleRevision) ||
            !isPresent(result.value.visibleHash) ||
            !isPresent(item.gatewayEffect) ||
            result.value.visibleHash.value !== item.gatewayEffect.value.payload.targetVisibleHash
          )
        ) {
          // A success label without the acknowledged target state is not enough
          // to close a durable effect. Treat it like a lost response and read
          // back first.
          recoveryItems.push(item);
          continue;
        }
        await completeGatewayResult(options, storage, fence, item, result.value, report);
      }
      await recoverUnknownResults(
        { ...options, gateway: fullGateway },
        storage,
        fence,
        recoveryItems,
        report,
      );
      emitWorkerTiming(options, {
        scope: SYNC_TIMING_SCOPES.WORKER,
        phase: "regular_result_persistence",
        durationMs: Date.now() - resultPersistenceStartedAt,
        operationKinds: regularOperationKinds,
        operationCounts: regularOperationCounts,
      });
    }
  }

  emitWorkerTiming(options, {
    scope: SYNC_TIMING_SCOPES.WORKER,
    phase: "worker_total",
    durationMs: Date.now() - passStartedAt,
    operationKinds: operationKindsForItems(dispatchable),
    operationCounts: countsForItems(dispatchable),
  });
  return freezeReport(report);
}

function createAdapterEffectWorkerStorage(storage: SqlStorageAdapter): EffectWorkerStorage {
  return {
    claimWriterLease: (options) => claimWriterLeaseWithAdapter(storage, options),
    recoverExpiredLeases: (fence) => recoverExpiredLeasesWithAdapter(storage, fence),
    listReadyEffects: (limit) => listReadyEffectsWithAdapter(storage, limit),
    claimEffect: (options) => claimEffectWithAdapter(storage, options),
    applyEffectResult: (options) => applyEffectResultWithAdapter(storage, options),
    releaseUnprocessedEffect: (options) => releaseUnprocessedEffectWithAdapter(storage, options),
    retryClaimedEffect: (options) => retryClaimedEffectWithAdapter(storage, options),
    supersedeAndReplan: (fence, oldEffectId, newEffect) => {
      return supersedeAndReplanWithAdapter(storage, fence, oldEffectId, newEffect);
    },
    isUserInputCandidateBlocked: (item) => {
      return storage.read(({ sql }) => isUserInputCandidateBlockedWithSql(sql, item));
    },
  };
}

async function isUserInputCandidateBlockedWithSql(
  sql: SqlExecutor,
  item: ClaimedEffect,
): Promise<boolean> {
  const effect = item.gatewayEffect;
  if (
    !isPresent(effect) ||
    !isCandidateProtectingUserInputEffect(effect.value) ||
    !isPresent(effect.value.rowBindingId)
  ) {
    return false;
  }
  const fieldNames = Object.keys(effect.value.payload.fields);
  if (fieldNames.length === 0) return true;
  const placeholders = fieldNames.map(() => "?").join(", ");
  const blockSql = USER_INPUT_CANDIDATE_BLOCK_SQL.replace("__FIELD_NAMES__", placeholders);
  const row = await sql.get<CandidateBlockSqlRow>(blockSql, [
    effect.value.physicalSheetId,
    effect.value.rowBindingId.value,
    ...fieldNames,
  ]);
  return row !== undefined;
}

async function completeGatewayResult(
  options: SyncEffectWorkerBaseOptions,
  storage: EffectWorkerStorage,
  fence: FencingContext,
  item: ClaimedEffect,
  result: SyncGatewayEffectResult,
  report: MutableReport,
): Promise<void> {
  if (
    result.status === SYNC_GATEWAY_EFFECT_RESULT_STATUSES.APPLIED ||
    result.status === SYNC_GATEWAY_EFFECT_RESULT_STATUSES.ALREADY_APPLIED
  ) {
    await completeApplied(storage, fence, item, result.visibleRevision, result.visibleHash, report);
    return;
  }
  if (result.status === SYNC_GATEWAY_EFFECT_RESULT_STATUSES.SUPERSEDED) {
    if (await storage.applyEffectResult({
      ...fence,
      effectId: item.pending.effect_id,
      claimToken: item.claimToken,
      status: OUTBOX_EFFECT_STATUSES.SUPERSEDED,
      lastErrorCode: presentValue(WORKER_ERROR_CODES.GATEWAY_SUPERSEDED),
      lastErrorMessage: result.reason,
    })) report.superseded += 1;
    return;
  }
  if (result.status === SYNC_GATEWAY_EFFECT_RESULT_STATUSES.GUARD_MISMATCH) {
    const blocked = isPresent(item.gatewayEffect) &&
      isCandidateProtectingUserInputEffect(item.gatewayEffect.value);
    const status = blocked
      ? OUTBOX_EFFECT_STATUSES.BLOCKED_CANDIDATE
      : OUTBOX_EFFECT_STATUSES.CONFLICT;
    const applied = await storage.applyEffectResult({
      ...fence,
      effectId: item.pending.effect_id,
      claimToken: item.claimToken,
      status,
      lastErrorCode: presentValue(
        blocked
          ? WORKER_ERROR_CODES.CANDIDATE_GUARD_MISMATCH
          : WORKER_ERROR_CODES.VISIBLE_GUARD_MISMATCH,
      ),
      lastErrorMessage: result.reason,
    });
    if (applied) {
      if (blocked) report.blockedCandidate += 1;
      else report.conflicted += 1;
    }
    return;
  }
  if (result.status === SYNC_GATEWAY_EFFECT_RESULT_STATUSES.REPAIR_REOBSERVE) {
    await replanOrFail(
      options,
      storage,
      fence,
      item,
      {
        effect: item.pending,
        gatewayResult: presentValue(result),
        postcondition: absentValue(),
      },
      report,
    );
    return;
  }
  await completeFailure(
    storage,
    fence,
    item,
    result.status === SYNC_GATEWAY_EFFECT_RESULT_STATUSES.SCHEMA_ERROR
      ? WORKER_ERROR_CODES.GATEWAY_SCHEMA_ERROR
      : WORKER_ERROR_CODES.GATEWAY_RETRYABLE_ERROR,
    result.reason,
    report,
  );
}

async function recoverUnknownResults(
  options: SyncEffectWorkerFullOptions,
  storage: EffectWorkerStorage,
  fence: FencingContext,
  items: readonly ClaimedEffect[],
  report: MutableReport,
): Promise<void> {
  const usable: ClaimedEffect[] = [];
  for (const item of items) {
    if (isPresent(item.gatewayEffect)) {
      usable.push(item);
      continue;
    }
    await completeFailure(
      storage,
      fence,
      item,
      WORKER_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
      item.invalidPayloadError,
      report,
    );
  }
  for (const group of groupByGatewayPostconditionRequest(usable)) {
    let results: readonly {
      readonly effectId: string;
      readonly payloadHash: string;
      readonly postcondition: SyncEffectPostcondition;
    }[];
    try {
      results = await options.gateway.readEffectPostconditions(group.request);
    } catch (error: unknown) {
      for (const item of group.items) {
        await completeFailure(
          storage,
          fence,
          item,
          WORKER_ERROR_CODES.POSTCONDITION_READ_FAILED,
          presentValue(safeErrorMessage(error)),
          report,
        );
      }
      continue;
    }
    const byEffectId = new Map(results.map((result) => [result.effectId, result]));
    for (const item of group.items) {
      const result = lookupResult(byEffectId.get(item.pending.effect_id));
      if (
        result.kind === LOOKUP_RESULT_KINDS.NOT_FOUND ||
        result.value.payloadHash !== item.pending.payload_hash
      ) {
        await completeFailure(
          storage,
          fence,
          item,
          WORKER_ERROR_CODES.POSTCONDITION_READ_FAILED,
          presentValue("Gateway postcondition batch did not return the expected effect evidence."),
          report,
        );
        continue;
      }
      await settleUnknownPostcondition(
        options,
        storage,
        fence,
        item,
        result.value.postcondition,
        report,
      );
    }
  }
}

async function settleUnknownPostcondition(
  options: SyncEffectWorkerBaseOptions,
  storage: EffectWorkerStorage,
  fence: FencingContext,
  item: ClaimedEffect,
  postcondition: SyncEffectPostcondition,
  report: MutableReport,
): Promise<void> {
  if (!isPresent(item.gatewayEffect)) {
    await completeFailure(
      storage,
      fence,
      item,
      WORKER_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
      item.invalidPayloadError,
      report,
    );
    return;
  }
  if (
    postcondition.disposition === SYNC_GATEWAY_POSTCONDITION_DISPOSITIONS.APPLIED &&
    isPresent(postcondition.visibleRevision) &&
    isPresent(postcondition.visibleHash)
  ) {
    await completeApplied(
      storage,
      fence,
      item,
      postcondition.visibleRevision,
      postcondition.visibleHash,
      report,
    );
    report.responseLossRecovered += 1;
    return;
  }
  if (postcondition.disposition === SYNC_GATEWAY_POSTCONDITION_DISPOSITIONS.APPLIED) {
    await completeFailure(
      storage,
      fence,
      item,
      WORKER_ERROR_CODES.POSTCONDITION_APPLIED_WITHOUT_VISIBLE_STATE,
      presentValue("Gateway claimed an applied postcondition without a verified visible revision and hash."),
      report,
    );
    return;
  }
  if (
    postcondition.disposition === SYNC_GATEWAY_POSTCONDITION_DISPOSITIONS.CHANGED &&
    item.gatewayEffect.value.effectKind === SYNC_EFFECT_KINDS.SYSTEM_REPAIR
  ) {
    await replanOrFail(
      options,
      storage,
      fence,
      item,
      {
        effect: item.pending,
        gatewayResult: absentValue(),
        postcondition: presentValue(postcondition),
      },
      report,
    );
    return;
  }
  if (postcondition.disposition === SYNC_GATEWAY_POSTCONDITION_DISPOSITIONS.UNAPPLIED) {
    const requeued = await storage.retryClaimedEffect({
      ...fence,
      effectId: item.pending.effect_id,
      claimToken: item.claimToken,
      lastErrorCode: WORKER_ERROR_CODES.POSTCONDITION_UNAPPLIED_REQUIRES_REDRIVE,
      lastErrorMessage: "Gateway did not expose the effect as applied; it was returned to pending.",
    });
    if (requeued) {
      report.deferred += 1;
      report.requeued += 1;
    }
    return;
  }
  const code = postcondition.disposition === SYNC_GATEWAY_POSTCONDITION_DISPOSITIONS.UNAVAILABLE
    ? WORKER_ERROR_CODES.POSTCONDITION_UNAVAILABLE
    : postcondition.disposition === SYNC_GATEWAY_POSTCONDITION_DISPOSITIONS.CHANGED
      ? WORKER_ERROR_CODES.POSTCONDITION_CHANGED
      : WORKER_ERROR_CODES.POSTCONDITION_UNAPPLIED_REQUIRES_REDRIVE;
  await completeFailure(
    storage,
    fence,
    item,
    code,
    presentValue("Gateway response was not observed; postcondition=" + postcondition.disposition),
    report,
  );
}

async function completeApplied(
  storage: EffectWorkerStorage,
  fence: FencingContext,
  item: ClaimedEffect,
  visibleRevision: Presence<number>,
  visibleHash: Presence<string>,
  report: MutableReport,
): Promise<void> {
  const gatewayEffect = item.gatewayEffect;
  const confirmation = isPresent(gatewayEffect) &&
    isPresent(gatewayEffect.value.rowBindingId) &&
    isPresent(visibleRevision) &&
    isPresent(visibleHash)
    ? {
      physicalSheetId: item.pending.physical_sheet_id,
      projection: item.pending.projection,
      rowBindingId: gatewayEffect.value.rowBindingId.value,
      visibleRevision: visibleRevision.value,
      visibleHash: visibleHash.value,
      entityRevision: applicabilityFromSqlNullable(item.pending.target_entity_revision),
      fieldHashes: Object.fromEntries(
        Object.entries(gatewayEffect.value.payload.fields)
          .map(([fieldName, value]) => [fieldName, stableHash(value)]),
      ),
    }
    : undefined;
  const applied = await storage.applyEffectResult({
    ...fence,
    effectId: item.pending.effect_id,
    claimToken: item.claimToken,
    status: OUTBOX_EFFECT_STATUSES.APPLIED,
    lastErrorCode: absentValue(),
    lastErrorMessage: absentValue(),
    ...(confirmation === undefined ? {} : { projectionConfirmation: confirmation }),
  });
  if (applied) report.applied += 1;
}

async function replanOrFail(
  options: SyncEffectWorkerBaseOptions,
  storage: EffectWorkerStorage,
  fence: FencingContext,
  item: ClaimedEffect,
  request: RepairReplanRequest,
  report: MutableReport,
): Promise<void> {
  if (options.makeRepairReplan === undefined) {
    await completeFailure(
      storage,
      fence,
      item,
      WORKER_ERROR_CODES.REPAIR_REOBSERVE_REQUIRES_WRITER_REPLAN,
      presentValue("A system repair changed remotely and no writer replan factory was configured."),
      report,
    );
    return;
  }
  let replacement: Presence<NewEffect>;
  try {
    replacement = options.makeRepairReplan(request);
  } catch (error: unknown) {
    await completeFailure(
      storage,
      fence,
      item,
      WORKER_ERROR_CODES.REPAIR_REPLAN_FAILED,
      presentValue(safeErrorMessage(error)),
      report,
    );
    return;
  }
  if (!isPresent(replacement)) {
    await completeFailure(
      storage,
      fence,
      item,
      WORKER_ERROR_CODES.REPAIR_REPLAN_DEFERRED,
      presentValue("Writer deferred repair replan pending a fresh observation."),
      report,
    );
    return;
  }
  try {
    await storage.supersedeAndReplan(fence, item.pending.effect_id, replacement.value);
    report.replanned += 1;
  } catch (error: unknown) {
    await completeFailure(
      storage,
      fence,
      item,
      WORKER_ERROR_CODES.REPAIR_REPLAN_FAILED,
      presentValue(safeErrorMessage(error)),
      report,
    );
  }
}

async function completeFailure(
  storage: EffectWorkerStorage,
  fence: FencingContext,
  item: ClaimedEffect,
  code: SyncEffectWorkerErrorCode,
  message: Presence<string>,
  report: MutableReport,
): Promise<void> {
  if (await storage.applyEffectResult({
    ...fence,
    effectId: item.pending.effect_id,
    claimToken: item.claimToken,
    status: OUTBOX_EFFECT_STATUSES.FAILED,
    lastErrorCode: presentValue(code),
    lastErrorMessage: message,
  })) report.failed += 1;
}

/** Returns the full gateway only when every regular recovery capability exists. */
function isFullEffectGateway(
  gateway: SyncEffectWorkerGateway,
): SyncEffectWorkerFullGateway | undefined {
  const candidate = gateway as Partial<SyncEffectWorkerFullGateway>;
  if (
    typeof candidate.applyEffects !== "function" ||
    typeof candidate.readEffectPostcondition !== "function" ||
    typeof candidate.readEffectPostconditions !== "function"
  ) {
    return undefined;
  }
  return gateway as SyncEffectWorkerFullGateway;
}

function emptyOperationCounts(): SyncTimingOperationCounts {
  return { append: 0, update: 0, delete: 0 };
}

function timingOperationKindForEffect(effect: SyncGatewayEffect): SyncTimingOperationKind {
  if (
    effect.effectKind === SYNC_EFFECT_KINDS.RESOLUTION_DELETE ||
    effect.effectKind === SYNC_EFFECT_KINDS.USER_INPUT_DELETE
  ) {
    return SYNC_TIMING_OPERATION_KINDS.DELETE;
  }
  if (
    effect.payload.createIfMissing &&
    effect.expectedVisibleRevision === NON_NEGATIVE_SAFE_INTEGER_MINIMUM &&
    effect.expectedVisibleHash === ""
  ) {
    return SYNC_TIMING_OPERATION_KINDS.APPEND;
  }
  return SYNC_TIMING_OPERATION_KINDS.UPDATE;
}

function timingOperationKindForPending(effect: PendingEffect): SyncTimingOperationKind {
  if (
    effect.effect_kind === SYNC_EFFECT_KINDS.RESOLUTION_DELETE ||
    effect.effect_kind === SYNC_EFFECT_KINDS.USER_INPUT_DELETE
  ) {
    return SYNC_TIMING_OPERATION_KINDS.DELETE;
  }
  if (
    effect.expected_visible_revision === NON_NEGATIVE_SAFE_INTEGER_MINIMUM &&
    effect.expected_visible_hash === ""
  ) {
    return SYNC_TIMING_OPERATION_KINDS.APPEND;
  }
  return SYNC_TIMING_OPERATION_KINDS.UPDATE;
}

function countsForOperationKinds(
  kinds: readonly SyncTimingOperationKind[],
): SyncTimingOperationCounts {
  return {
    append: kinds.filter((kind) => kind === SYNC_TIMING_OPERATION_KINDS.APPEND).length,
    update: kinds.filter((kind) => kind === SYNC_TIMING_OPERATION_KINDS.UPDATE).length,
    delete: kinds.filter((kind) => kind === SYNC_TIMING_OPERATION_KINDS.DELETE).length,
  };
}

function countsForItems(items: readonly ClaimedEffect[]): SyncTimingOperationCounts {
  const kinds = items.flatMap((item) =>
    isPresent(item.gatewayEffect) ? [timingOperationKindForEffect(item.gatewayEffect.value)] : []);
  return countsForOperationKinds(kinds);
}

function operationKindsForItems(items: readonly ClaimedEffect[]): readonly SyncTimingOperationKind[] {
  return operationKindsForCounts(countsForItems(items));
}

function countsForPendingEffects(effects: readonly PendingEffect[]): SyncTimingOperationCounts {
  return countsForOperationKinds(effects.map(timingOperationKindForPending));
}

function operationKindsForPendingEffects(
  effects: readonly PendingEffect[],
): readonly SyncTimingOperationKind[] {
  return operationKindsForCounts(countsForPendingEffects(effects));
}

function operationKindsForCounts(
  counts: SyncTimingOperationCounts,
): readonly SyncTimingOperationKind[] {
  return [
    ...(counts.append > 0 ? [SYNC_TIMING_OPERATION_KINDS.APPEND] : []),
    ...(counts.update > 0 ? [SYNC_TIMING_OPERATION_KINDS.UPDATE] : []),
    ...(counts.delete > 0 ? [SYNC_TIMING_OPERATION_KINDS.DELETE] : []),
  ];
}

function emitGatewayTiming(
  options: SyncEffectWorkerBaseOptions,
  timing: SyncGatewayTiming | undefined,
): void {
  if (timing === undefined) return;
  for (const phase of timing.phases) {
    emitWorkerTiming(options, {
      scope: SYNC_TIMING_SCOPES.GATEWAY,
      phase: phase.phase,
      durationMs: phase.durationMs,
      operationKinds: timing.operationKinds,
      operationCounts: timing.operationCounts,
    });
  }
}

function emitWorkerTiming(
  options: SyncEffectWorkerBaseOptions,
  event: SyncTimingEvent,
): void {
  try {
    options.onTiming?.(event);
  } catch {
    // Diagnostics must never change worker state transitions.
  }
}

/** Fails regular effects explicitly when the configured gateway is fast-only. */
async function rejectUnsupportedGatewayEffects(
  storage: EffectWorkerStorage,
  fence: FencingContext,
  items: readonly ClaimedEffect[],
  report: MutableReport,
): Promise<void> {
  for (const item of items) {
    if (!isPresent(item.gatewayEffect)) {
      await completeFailure(
        storage,
        fence,
        item,
        WORKER_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
        item.invalidPayloadError,
        report,
      );
      continue;
    }
    await completeFailure(
      storage,
      fence,
      item,
      WORKER_ERROR_CODES.GATEWAY_CAPABILITY_MISSING,
      presentValue(
        "The configured gateway supports fast append only; regular effect dispatch or recovery is unavailable.",
      ),
      report,
    );
  }
}

/**
 * Dispatches append-only system rows without remote CAS or postcondition reads.
 *
 * A lost response is returned to pending. The append-only gateway deliberately
 * does not keep row metadata for retry deduplication, so a retry can append a
 * duplicate; reconciliation remains the eventual correction path.
 */
async function dispatchFastAppendGroup(
  options: SyncEffectWorkerBaseOptions,
  storage: EffectWorkerStorage,
  fence: FencingContext,
  group: {
    readonly request: FastAppendRowsRequest;
    readonly items: readonly ClaimedEffect[];
  },
  report: MutableReport,
): Promise<void> {
  let response: Awaited<ReturnType<SyncEffectWorkerGateway["fastAppendRows"]>>;
  const gatewayStartedAt = Date.now();
  try {
    response = await options.gateway.fastAppendRows(group.request);
  } catch {
    emitWorkerTiming(options, {
      scope: SYNC_TIMING_SCOPES.WORKER,
      phase: "append_gateway_dispatch",
      durationMs: Date.now() - gatewayStartedAt,
      operationKinds: [SYNC_TIMING_OPERATION_KINDS.APPEND],
      operationCounts: { append: group.items.length, update: 0, delete: 0 },
    });
    await requeueFastAppendItems(storage, fence, group.items, report);
    return;
  }
  emitGatewayTiming(options, response.timing);
  emitWorkerTiming(options, {
    scope: SYNC_TIMING_SCOPES.WORKER,
    phase: "append_gateway_dispatch",
    durationMs: Date.now() - gatewayStartedAt,
    operationKinds: [SYNC_TIMING_OPERATION_KINDS.APPEND],
    operationCounts: { append: group.items.length, update: 0, delete: 0 },
  });

  const resultPersistenceStartedAt = Date.now();
  const byEffectId = new Map(response.results.map((result) => [result.effectId, result]));
  const deferredEffectIds = new Set<string>();
  for (const item of group.items) {
    if (byEffectId.has(item.pending.effect_id) || !response.hasMore) continue;
    if (await storage.releaseUnprocessedEffect({
      ...fence,
      effectId: item.pending.effect_id,
      claimToken: item.claimToken,
    })) {
      deferredEffectIds.add(item.pending.effect_id);
      report.deferred += 1;
    }
  }

  for (const item of group.items) {
    if (deferredEffectIds.has(item.pending.effect_id)) continue;
    const result = lookupResult(byEffectId.get(item.pending.effect_id));
    if (result.kind === LOOKUP_RESULT_KINDS.NOT_FOUND) {
      await requeueFastAppendItems(storage, fence, [item], report);
      continue;
    }
    if (!isPresent(item.gatewayEffect)) {
      await requeueFastAppendItems(storage, fence, [item], report);
      continue;
    }
    await completeApplied(
      storage,
      fence,
      item,
      presentValue(item.pending.expected_visible_revision + 1),
      presentValue(item.gatewayEffect.value.payload.targetVisibleHash),
      report,
    );
  }
  emitWorkerTiming(options, {
    scope: SYNC_TIMING_SCOPES.WORKER,
    phase: "append_result_persistence",
    durationMs: Date.now() - resultPersistenceStartedAt,
    operationKinds: [SYNC_TIMING_OPERATION_KINDS.APPEND],
    operationCounts: { append: group.items.length, update: 0, delete: 0 },
  });
}

/** Returns a response-lost fast append to pending for reconciliation-backed retry. */
async function requeueFastAppendItems(
  storage: EffectWorkerStorage,
  fence: FencingContext,
  items: readonly ClaimedEffect[],
  report: MutableReport,
): Promise<void> {
  for (const item of items) {
    if (await storage.retryClaimedEffect({
      ...fence,
      effectId: item.pending.effect_id,
      claimToken: item.claimToken,
      lastErrorCode: WORKER_ERROR_CODES.GATEWAY_RETRYABLE_ERROR,
      lastErrorMessage: "Fast append response was not observed; the row will be retried and reconciled later.",
    })) {
      report.deferred += 1;
      report.requeued += 1;
    }
  }
}

/** Accepts either inline read-back or a flushed-write acknowledgement. */
function isSuccessfulGatewayPostcondition(
  status: SyncGatewayEffectResult["postcondition"],
): boolean {
  return status === SYNC_GATEWAY_POSTCONDITION_STATUSES.VERIFIED ||
    status === SYNC_GATEWAY_POSTCONDITION_STATUSES.ACKNOWLEDGED;
}

function toGatewayEffect(effect: PendingEffect): SyncGatewayEffect {
  if (!isSyncEffectKind(effect.effect_kind)) {
    throwWorkerError("unsupported sync effect kind: " + effect.effect_kind);
  }
  if (!isSyncProjection(effect.projection)) {
    throwWorkerError("unsupported sync projection: " + effect.projection);
  }
  if (!isEffectTargetKind(effect.target_kind)) {
    throwWorkerError("unsupported sync effect target kind: " + effect.target_kind);
  }
  return {
    effectId: effect.effect_id,
    payloadHash: effect.payload_hash,
    effectKind: effect.effect_kind,
    physicalSheetId: effect.physical_sheet_id,
    projection: effect.projection,
    targetKind: effect.target_kind,
    targetId: effect.target_id,
    rowBindingId: fromSqlNullable(effect.row_binding_id),
    conflictId: fromSqlNullable(effect.conflict_id),
    expectedVisibleRevision: effect.expected_visible_revision,
    expectedVisibleHash: effect.expected_visible_hash,
    repairGuardHash: fromSqlNullable(effect.repair_guard_hash),
    payload: parseSyncProjectionEffectPayload(effect.payload_json),
  };
}

function groupByGatewayRequest(items: readonly ClaimedEffect[]): readonly {
  readonly request: ApplySyncEffectsRequest;
  readonly items: readonly ClaimedEffect[];
}[] {
  const groups = new Map<string, { request: ApplySyncEffectsRequest; items: ClaimedEffect[] }>();
  for (const item of items) {
    const effect = item.gatewayEffect;
    if (!isPresent(effect)) continue;
    const key = [
      effect.value.physicalSheetId,
      effect.value.payload.sheetName,
      effect.value.payload.registeredRange,
      effect.value.projection,
      effect.value.payload.schemaVersion,
    ].join("\u0000");
    const existing = lookupResult(groups.get(key));
    if (existing.kind === LOOKUP_RESULT_KINDS.NOT_FOUND) {
      groups.set(key, {
        request: {
          physicalSheetId: effect.value.physicalSheetId,
          sheetName: effect.value.payload.sheetName,
          registeredRange: effect.value.payload.registeredRange,
          projection: effect.value.projection,
          schemaVersion: effect.value.payload.schemaVersion,
          postconditionMode: SYNC_GATEWAY_POSTCONDITION_MODES.DEFERRED,
          effects: [effect.value],
        },
        items: [item],
      });
    } else {
      existing.value.request = {
        ...existing.value.request,
        postconditionMode: SYNC_GATEWAY_POSTCONDITION_MODES.DEFERRED,
        effects: [...existing.value.request.effects, effect.value],
      };
      existing.value.items.push(item);
    }
  }
  return [...groups.values()];
}

/** Groups append-only system effects into one fast gateway request per route. */
function groupByFastAppendRequest(items: readonly ClaimedEffect[]): readonly {
  readonly request: FastAppendRowsRequest;
  readonly items: readonly ClaimedEffect[];
}[] {
  const groups = new Map<string, { request: FastAppendRowsRequest; items: ClaimedEffect[] }>();
  for (const item of items) {
    const effect = item.gatewayEffect;
    if (!isPresent(effect)) continue;
    const key = [
      effect.value.physicalSheetId,
      effect.value.payload.sheetName,
      effect.value.payload.registeredRange,
      effect.value.projection,
      effect.value.payload.schemaVersion,
    ].join("\u0000");
    const row = {
      effectId: effect.value.effectId,
      fields: effect.value.payload.fields,
    };
    const existing = lookupResult(groups.get(key));
    if (existing.kind === LOOKUP_RESULT_KINDS.NOT_FOUND) {
      groups.set(key, {
        request: {
          physicalSheetId: effect.value.physicalSheetId,
          sheetName: effect.value.payload.sheetName,
          registeredRange: effect.value.payload.registeredRange,
          projection: effect.value.projection,
          schemaVersion: effect.value.payload.schemaVersion,
          rows: [row],
        },
        items: [item],
      });
    } else {
      existing.value.request = {
        ...existing.value.request,
        rows: [...existing.value.request.rows, row],
      };
      existing.value.items.push(item);
    }
  }
  return [...groups.values()];
}

/** Groups postcondition reads so each group performs one remote Sheet scan. */
function groupByGatewayPostconditionRequest(items: readonly ClaimedEffect[]): readonly {
  readonly request: ReadSyncEffectPostconditionsRequest;
  readonly items: readonly ClaimedEffect[];
}[] {
  const groups = new Map<string, {
    request: ReadSyncEffectPostconditionsRequest;
    items: ClaimedEffect[];
  }>();
  for (const item of items) {
    const effect = item.gatewayEffect;
    if (!isPresent(effect)) continue;
    const key = [
      effect.value.physicalSheetId,
      effect.value.payload.sheetName,
      effect.value.payload.registeredRange,
      effect.value.projection,
      effect.value.payload.schemaVersion,
    ].join("\u0000");
    const existing = lookupResult(groups.get(key));
    if (existing.kind === LOOKUP_RESULT_KINDS.NOT_FOUND) {
      groups.set(key, {
        request: {
          physicalSheetId: effect.value.physicalSheetId,
          sheetName: effect.value.payload.sheetName,
          registeredRange: effect.value.payload.registeredRange,
          projection: effect.value.projection,
          schemaVersion: effect.value.payload.schemaVersion,
          effects: [effect.value],
        },
        items: [item],
      });
    } else {
      existing.value.request = {
        ...existing.value.request,
        effects: [...existing.value.request.effects, effect.value],
      };
      existing.value.items.push(item);
    }
  }
  return [...groups.values()];
}

function isSyncEffectKind(value: string): value is SyncGatewayEffect["effectKind"] {
  return value === SYNC_EFFECT_KINDS.SYSTEM_PROJECTION ||
    value === SYNC_EFFECT_KINDS.CANDIDATE_RECONCILE ||
    value === SYNC_EFFECT_KINDS.SYSTEM_REPAIR ||
    value === SYNC_EFFECT_KINDS.RESOLUTION_PROJECTION ||
    value === SYNC_EFFECT_KINDS.RESOLUTION_DELETE ||
    value === SYNC_EFFECT_KINDS.USER_INPUT_DELETE;
}

function isCandidateProtectingUserInputEffect(effect: SyncGatewayEffect): boolean {
  return effect.effectKind === SYNC_EFFECT_KINDS.CANDIDATE_RECONCILE ||
    effect.effectKind === SYNC_EFFECT_KINDS.USER_INPUT_DELETE;
}

/** Selects only new System_State entity rows for the append-only fast path. */
function isFastAppendCandidate(item: ClaimedEffect): boolean {
  if (!isPresent(item.gatewayEffect)) return false;
  const effect = item.gatewayEffect.value;
  return effect.effectKind === SYNC_EFFECT_KINDS.SYSTEM_PROJECTION &&
    effect.projection === SYNC_GATEWAY_PROJECTIONS.SYSTEM_STATE &&
    effect.targetKind === EFFECT_TARGET_KINDS.ENTITY &&
    effect.payload.createIfMissing &&
    effect.expectedVisibleRevision === NON_NEGATIVE_SAFE_INTEGER_MINIMUM &&
    effect.expectedVisibleHash === "";
}

function isSyncProjection(value: string): value is SyncProjection {
  return value === SYNC_GATEWAY_PROJECTIONS.USER_INPUT ||
    value === SYNC_GATEWAY_PROJECTIONS.SYSTEM_STATE ||
    value === SYNC_GATEWAY_PROJECTIONS.SYNC_CONFLICTS;
}

function isEffectTargetKind(value: string): value is EffectTargetKind {
  return value === EFFECT_TARGET_KINDS.ENTITY ||
    value === EFFECT_TARGET_KINDS.ROW_BINDING ||
    value === EFFECT_TARGET_KINDS.PROJECTION_ROW ||
    value === EFFECT_TARGET_KINDS.CONFLICT;
}

function fenceFromLease(lease: WriterLease, now: number): FencingContext {
  return {
    role: lease.role,
    writerEpoch: lease.writerEpoch,
    fencingToken: lease.fencingToken,
    now,
  };
}

interface MutableReport {
  lease: Presence<WriterLease>;
  expiredLeasesRecovered: number;
  selected: number;
  claimed: number;
  applied: number;
  blockedCandidate: number;
  superseded: number;
  conflicted: number;
  failed: number;
  deferred: number;
  requeued: number;
  replanned: number;
  responseLossRecovered: number;
}

function mutableReport(lease: Presence<WriterLease>): MutableReport {
  return {
    lease,
    expiredLeasesRecovered: 0,
    selected: 0,
    claimed: 0,
    applied: 0,
    blockedCandidate: 0,
    superseded: 0,
    conflicted: 0,
    failed: 0,
    deferred: 0,
    requeued: 0,
    replanned: 0,
    responseLossRecovered: 0,
  };
}

function freezeReport(report: MutableReport): SyncEffectWorkerReport {
  return { ...report };
}

function validateOptions(options: SyncEffectWorkerBaseOptions): void {
  if (options.workerId.length === EMPTY_STRING_LENGTH_ZERO) {
    throwWorkerError("effect worker ID is required");
  }
  if (
    !Number.isSafeInteger(options.now) ||
    options.now < NON_NEGATIVE_SAFE_INTEGER_MINIMUM
  ) {
    throwWorkerError("effect worker time must be a non-negative safe integer");
  }
  if (
    !Number.isSafeInteger(options.maxEffects) ||
    options.maxEffects < POSITIVE_SAFE_INTEGER_MINIMUM
  ) {
    throwWorkerError("effect worker maxEffects must be a positive safe integer");
  }
  for (const [name, value] of [
    ["writerLeaseDurationMs", options.writerLeaseDurationMs],
    ["effectLeaseDurationMs", options.effectLeaseDurationMs],
  ] as const) {
    if (
      value !== undefined &&
      (!Number.isSafeInteger(value) || value < POSITIVE_SAFE_INTEGER_MINIMUM)
    ) {
      throwWorkerError(name + " must be a positive safe integer");
    }
  }
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : "unknown sync gateway failure";
}

interface CandidateBlockSqlRow {
  readonly blocked: number;
}

type PresentValue<T> = {
  readonly kind: typeof PRESENCE_KINDS.PRESENT;
  readonly value: T;
};

function presentValue<T>(value: T): Presence<T> {
  return { kind: PRESENCE_KINDS.PRESENT, value };
}

function absentValue<T>(): Presence<T> {
  return { kind: PRESENCE_KINDS.ABSENT };
}

function isPresent<T>(value: Presence<T>): value is PresentValue<T> {
  return value.kind === PRESENCE_KINDS.PRESENT;
}

function isAbsent<T>(value: Presence<T>): boolean {
  return value.kind === PRESENCE_KINDS.ABSENT;
}

function lookupResult<T>(value: T | undefined): LookupResult<T> {
  return value === undefined
    ? { kind: LOOKUP_RESULT_KINDS.NOT_FOUND }
    : { kind: LOOKUP_RESULT_KINDS.FOUND, value };
}

function applicabilityFromSqlNullable<T>(value: T | null): Applicability<T> {
  return value === null
    ? { kind: APPLICABILITY_KINDS.NOT_APPLICABLE }
    : { kind: APPLICABILITY_KINDS.APPLICABLE, value };
}

function throwWorkerError(message: string): never {
  throw new StorageError(STORAGE_ERROR_CODES.INVALID_PENDING_EFFECT, message);
}
