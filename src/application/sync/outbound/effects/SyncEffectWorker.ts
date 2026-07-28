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
} from "../../../../domain/index.js";
import {
  APPLICABILITY_KINDS,
  LOOKUP_RESULT_KINDS,
  PRESENCE_KINDS,
} from "../../../../shared/state/constants.js";
import { CONFLICT_STATUSES } from "../../../../domain/model/constants.js";
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
} from "../../../../infrastructure/storage/index.js";
import {
  STORAGE_ERROR_CODES,
  StorageError,
} from "../../../../infrastructure/storage/errors.js";
import { fromSqlNullable } from "../../../../infrastructure/storage/sqlite/sqlState.js";
import type { SqlExecutor, SqlStorageAdapter } from "../../../../adapter/persistence/contracts/sql.js";
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
} from "../../gateway/syncGateway.js";
import {
  SYNC_GATEWAY_EFFECT_RESULT_STATUSES,
  SYNC_GATEWAY_POSTCONDITION_DISPOSITIONS,
  SYNC_GATEWAY_POSTCONDITION_MODES,
  SYNC_GATEWAY_POSTCONDITION_STATUSES,
  SYNC_GATEWAY_PROJECTIONS,
} from "../../gateway/constants.js";
import { WRITER_LEASE_CLAIM_RESULT_KINDS } from "../../../../infrastructure/storage/sync/shared/writerLease.js";
import {
  SYNC_TIMING_OPERATION_KINDS,
  SYNC_TIMING_SCOPES,
  type SyncGatewayTiming,
  type SyncTimingEvent,
  type SyncTimingOperationCounts,
  type SyncTimingOperationKind,
  type SyncTimingSink,
} from "../../telemetry/syncTiming.js";
import {
  DEFAULT_EFFECT_LEASE_DURATION_MS,
  DEFAULT_WORKER_ROLE,
  DEFAULT_WRITER_LEASE_DURATION_MS,
  EFFECT_TARGET_KINDS,
  OUTBOX_EFFECT_STATUSES,
  SYNC_EFFECT_KINDS,
  USER_INPUT_CANDIDATE_BLOCK_SQL,
  WORKER_ERROR_CODES,
  type SyncEffectWorkerErrorCode,
} from "./SyncEffectWorkerConstants.js";
import {
  absentValue,
  applicabilityFromSqlNullable,
  isAbsent,
  isPresent,
  lookupResult,
  presentValue,
  safeErrorMessage,
  throwWorkerError,
  type CandidateBlockSqlRow,
  type PresentValue,
} from "./SyncEffectWorkerHelpers.js";
import {
  countsForItems,
  countsForPendingEffects,
  emptyOperationCounts,
  emitGatewayTiming,
  emitWorkerTiming,
  operationKindsForItems,
  operationKindsForPendingEffects,
  operationKindsForCounts,
} from "./SyncEffectWorkerTiming.js";
import {
  completeApplied,
  completeFailure,
  completeGatewayResult,
  recoverUnknownResults,
} from "./SyncEffectWorkerTransitions.js";
import {
  dispatchFastAppendGroup,
  rejectUnsupportedGatewayEffects,
} from "./SyncEffectWorkerDispatch.js";
import {
  fenceFromLease,
  groupByFastAppendRequest,
  groupByGatewayRequest,
  isCandidateProtectingUserInputEffect,
  isFastAppendCandidate,
  isSuccessfulGatewayPostcondition,
  toGatewayEffect,
} from "./SyncEffectWorkerRouting.js";

/** An effect plus evidence supplied to a writer-owned system-repair replanner. */
export interface RepairReplanRequest {
  readonly effect: PendingEffect;
  readonly gatewayResult: Presence<SyncGatewayEffectResult>;
  readonly postcondition: Presence<SyncEffectPostcondition>;
}

/** Callback that creates a fresh effect without mutating the old evidence. */
export type RepairReplanFactory = (request: RepairReplanRequest) => Presence<NewEffect>;

/** Shared construction options for a bounded effect-worker pass. */
export interface SyncEffectWorkerBaseOptions {
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

export type SyncEffectWorkerFullOptions = Omit<SyncEffectWorkerBaseOptions, "gateway"> & {
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

export interface ClaimedEffect {
  readonly pending: PendingEffect;
  readonly claimToken: string;
  readonly gatewayEffect: Presence<SyncGatewayEffect>;
  readonly invalidPayloadError: Presence<string>;
}

/** Persistence operations used by the shared effect-worker state machine. */
export interface EffectWorkerStorage {
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




export interface MutableReport {
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
