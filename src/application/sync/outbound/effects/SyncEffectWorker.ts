/**
 * Fenced outbox worker for projection effects.
 *
 * It owns only claim/result transitions.  Canonical state and any repair
 * replan payload are supplied by the writer boundary; the provider is never
 * allowed to choose a winner or silently retry a response-lost write.
 */

import { randomUUID } from "node:crypto";
import {
  EMPTY_STRING_LENGTH_ZERO,
  NON_NEGATIVE_SAFE_INTEGER_MINIMUM,
  POSITIVE_SAFE_INTEGER_MINIMUM,
  type Presence,
} from "../../../../domain/index.js";
import { CONFLICT_STATUSES } from "../../../../domain/model/constants.js";
import {
  LOOKUP_RESULT_KINDS,
  absentValue,
  presentValue,
} from "../../../../shared/state/index.js";
import {
  applyEffectResultWithAdapter,
  claimEffectWithAdapter,
  claimWriterLeaseWithAdapter,
  markDeliveryUncertainWithAdapter,
  renewEffectLeaseWithAdapter,
  recoverExpiredLeasesWithAdapter,
  listReadyEffectsWithAdapter,
  listReadyFastAppendEffectsWithAdapter,
  releaseUnprocessedEffectWithAdapter,
  retryClaimedEffectWithAdapter,
  supersedeAndReplanWithAdapter,
  hasActiveUserInputCandidateWithSql,
  ensureSpreadsheetAuthorityWithAdapter,
  type ApplyResultOptions,
  type ClaimEffectOptions,
  type ClaimLeaseOptions,
  type ClaimResult,
  type MarkDeliveryUncertainOptions,
  type FencingContext,
  type RenewEffectLeaseOptions,
  type NewEffect,
  type PendingEffect,
  type RetryClaimedEffectOptions,
  type WriterLease,
  type WriterLeaseClaimResult,
} from "../../../../infrastructure/storage/index.js";
import type { SqlStorageAdapter } from "../../../../adapter/persistence/contracts/sql.js";
import type {
  SyncEffectPostcondition,
  SyncProjectionEffect,
  SyncEffectResult,
  SyncEffectWorkerProvider,
} from "../../sheets/syncSheets.js";
import {
  SYNC_EFFECT_RESULT_STATUSES,
  SYNC_PROJECTIONS,
} from "../../sheets/constants.js";
import {
  classifyTransportOutcome,
  TRANSPORT_OUTCOME_KINDS,
} from "../../sheets/transportOutcome.js";
import { WRITER_LEASE_CLAIM_RESULT_KINDS } from "../../../../infrastructure/storage/sync/shared/writerLease.js";
import {
  SYNC_TIMING_SCOPES,
  type SyncTimingSink,
} from "../../telemetry/syncTiming.js";
import {
  DEFAULT_EFFECT_LEASE_DURATION_MS,
  DEFAULT_WORKER_ROLE,
  EFFECT_LEASE_PROVIDER_HEADROOM_MS,
  DEFAULT_WRITER_LEASE_DURATION_MS,
  EFFECT_BATCH_LIMIT,
  MAX_IN_FLIGHT_EFFECTS,
  OUTBOX_EFFECT_STATUSES,
  WORKER_ERROR_CODES,
} from "./SyncEffectWorkerConstants.js";
import {
  isAbsent,
  isPresent,
  lookupResult,
  safeErrorMessage,
  throwWorkerError,
} from "./SyncEffectWorkerHelpers.js";
import {
  countsForItems,
  countsForPendingEffects,
  emptyOperationCounts,
  emitProviderTiming,
  emitWorkerTiming,
  operationKindsForItems,
  operationKindsForPendingEffects,
  operationKindsForCounts,
} from "./SyncEffectWorkerTiming.js";
import {
  completeFailure,
  completeProviderResult,
  recoverUnknownResults,
} from "./SyncEffectWorkerTransitions.js";
import {
  dispatchFastAppendGroup,
  handleProviderDispatchError,
  rejectUnsupportedProviderEffects,
} from "./SyncEffectWorkerDispatch.js";
import {
  fenceFromLease,
  groupByFastAppendRequest,
  groupByProviderRequest,
  chunkFastAppendGroups,
  chunkProviderEffectGroups,
  routeKey,
  isCandidateProtectingUserInputEffect,
  isFastAppendCandidate,
  isFastAppendPendingEffect,
  isSuccessfulPostcondition,
  toProviderEffect,
} from "./SyncEffectWorkerRouting.js";
import type { AdaptiveEffectBatchController } from "./AdaptiveEffectBatchController.js";

/** An effect plus evidence supplied to a writer-owned system-repair replanner. */
export interface RepairReplanRequest {
  readonly effect: PendingEffect;
  readonly providerResult: Presence<SyncEffectResult>;
  readonly postcondition: Presence<SyncEffectPostcondition>;
}

/** Callback that creates a fresh effect without mutating the old evidence. */
export type RepairReplanFactory = (request: RepairReplanRequest) => Presence<NewEffect>;

/** Shared construction options for a bounded effect-worker pass. */
export interface SyncEffectWorkerBaseOptions {
  readonly provider: SyncEffectWorkerProvider;
  readonly workerId: string;
  readonly now: number;
  readonly maxEffects: number;
  readonly writerRole?: string;
  readonly writerLeaseDurationMs?: number;
  readonly effectLeaseDurationMs?: number;
  /** Internal transport timeout used to validate lease headroom. */
  readonly requestTimeoutMs?: number;
  readonly batchController?: AdaptiveEffectBatchController;
  /**
   * Internal bulk-append claim window for the real provider runtime. When
   * set, a pass claims up to this many append candidates through a dedicated
   * ready fast-append selection (so a regular/recovery backlog ahead of them
   * cannot starve appends), and keeps the regular/recovery claim window at
   * the bounded 20-effect limit. Direct workers and fake providers omit it
   * and keep the 20-item window.
   */
  readonly maxFastAppendCandidates?: number;
  /**
   * Internal minimum interval between fast-append request starts. Only the
   * full provider runtime sets it; the batch controller owns the actual wait.
   */
  readonly appendDispatchIntervalMs?: number;
  /** Shared supervisor clock used to refresh fencing timestamps after remote I/O. */
  readonly clock?: () => number;
  readonly makeRepairReplan?: RepairReplanFactory;
  /** Optional diagnostics sink for worker and provider phases. */
  readonly onTiming?: SyncTimingSink;
}

export type SyncEffectWorkerFullOptions = Omit<SyncEffectWorkerBaseOptions, "provider"> & {
  readonly provider: SyncEffectWorkerProvider;
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
  readonly providerEffect: Presence<SyncProjectionEffect>;
  readonly invalidPayloadError: Presence<string>;
}

/** Persistence operations used by the shared effect-worker state machine. */
export interface EffectWorkerStorage {
  claimWriterLease(options: ClaimLeaseOptions): Promise<WriterLeaseClaimResult>;
  recoverExpiredLeases(fence: FencingContext): Promise<number>;
  listReadyEffects(limit: number, now?: number): Promise<readonly PendingEffect[]>;
  listReadyFastAppendEffects(limit: number, now?: number): Promise<readonly PendingEffect[]>;
  claimEffect(options: ClaimEffectOptions): Promise<ClaimResult>;
  ensureSpreadsheetAuthority(options: FencingContext & {
    readonly physicalSheetId: string;
    readonly ownerId: string;
  }): Promise<boolean>;
  markDeliveryUncertain(options: MarkDeliveryUncertainOptions): Promise<boolean>;
  renewEffectLease(options: RenewEffectLeaseOptions): Promise<boolean>;
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
  if (options.clock === undefined) {
    const baselineNow = options.now;
    options = {
      ...options,
      clock: () => baselineNow + Math.max(0, Date.now() - passStartedAt),
    };
  }
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
  let fence = fenceFromLease(claimResult.lease, options.now);
  const leaseNow = (): number => options.clock?.() ?? options.now + Math.max(0, Date.now() - passStartedAt);
  const currentFence = (): FencingContext => ({
    ...fence,
    // Direct worker callers may provide a deterministic `now` but no clock;
    // advance that baseline by elapsed wall time so a slow remote call cannot
    // reuse a pass-start timestamp after the writer lease has expired.
    now: leaseNow(),
  });
  const refreshDispatchLeases = async (items: readonly ClaimedEffect[]): Promise<boolean> => {
    const now = leaseNow();
    const writerRefresh = await storage.claimWriterLease({
      role,
      writerId: options.workerId,
      leaseDurationMs: leaseDuration,
      now,
    });
    if (writerRefresh.kind !== WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED) return false;
    if (
      writerRefresh.lease.writerEpoch !== fence.writerEpoch ||
      writerRefresh.lease.fencingToken !== fence.fencingToken
    ) {
      // The old fence expired and was taken over. Do not dispatch effects
      // claimed under that token; the next pass will recover them safely.
      fence = fenceFromLease(writerRefresh.lease, now);
      await storage.recoverExpiredLeases(currentFence());
      return false;
    }
    const authoritySheetIds = new Set(items.map((item) => item.pending.physical_sheet_id));
    for (const physicalSheetId of authoritySheetIds) {
      if (!(await storage.ensureSpreadsheetAuthority({
        ...currentFence(),
        physicalSheetId,
        ownerId: options.workerId,
      }))) {
        await storage.recoverExpiredLeases(currentFence());
        return false;
      }
    }
    const renewed: ClaimedEffect[] = [];
    const notRenewed: ClaimedEffect[] = [];
    for (const item of items) {
      if (await storage.renewEffectLease({
        ...currentFence(),
        effectId: item.pending.effect_id,
        claimToken: item.claimToken,
        leaseDurationMs: effectLeaseDuration,
      })) renewed.push(item);
      else notRenewed.push(item);
    }
    if (renewed.length === items.length) return true;
    await storage.recoverExpiredLeases(currentFence());
    for (const item of renewed) {
      if (await storage.releaseUnprocessedEffect({
        ...currentFence(),
        effectId: item.pending.effect_id,
        claimToken: item.claimToken,
      })) report.deferred += 1;
    }
    for (const item of notRenewed) {
      if (await storage.retryClaimedEffect({
        ...currentFence(),
        effectId: item.pending.effect_id,
        claimToken: item.claimToken,
        lastErrorCode: WORKER_ERROR_CODES.PROVIDER_RETRYABLE_ERROR,
        lastErrorMessage: "Effect lease could not be renewed before remote dispatch.",
      })) {
        report.requeued += 1;
        report.deferred += 1;
      }
    }
    return false;
  };
  const coalesceStartedAt = Date.now();
  const coalescedMs = await options.batchController?.waitForCoalescing(Date.now()) ?? 0;
  if (coalescedMs > 0) {
    emitWorkerTiming(options, {
      scope: SYNC_TIMING_SCOPES.WORKER,
      phase: "batch_coalesce_wait",
      durationMs: Date.now() - coalesceStartedAt,
      operationKinds: [],
      operationCounts: emptyOperationCounts(),
    });
  }
  const selectStartedAt = Date.now();
  report.expiredLeasesRecovered = await storage.recoverExpiredLeases(currentFence());
  // The bulk provider runtime selects ready append candidates through their
  // own bounded query and keeps the regular/recovery selection on the
  // head-of-line window; every other runtime keeps maxEffects as the SQLite
  // selection upper bound. Only the bounded in-flight window is ever leased
  // before the first remote dispatch; remaining rows stay durable and are
  // picked up on the next pass.
  const maxFastAppendCandidates = options.maxFastAppendCandidates;
  const selectionLimit = maxFastAppendCandidates === undefined
    ? options.maxEffects
    : Math.max(options.maxEffects, maxFastAppendCandidates + MAX_IN_FLIGHT_EFFECTS);
  const selected = await storage.listReadyEffects(selectionLimit, currentFence().now);
  let claimable: PendingEffect[];
  if (maxFastAppendCandidates === undefined) {
    claimable = selected.slice(0, MAX_IN_FLIGHT_EFFECTS);
  } else {
    // Append candidates are discovered independently of the head-of-queue
    // prefix: the dedicated query jumps past any regular/recovery backlog in
    // the same ready order, so an arbitrary number of rows before the first
    // append candidate cannot starve the bulk append path. Each returned row
    // is still payload-validated here before claiming, the claim CAS still
    // enforces per-target predecessor ordering, and the regular bucket stays
    // at the existing bounded window without leasing the claimed append rows
    // twice. The general selection can extend past the dedicated append
    // query's window, so the regular bucket excludes every pending fast-append
    // effect, not only the claimed IDs: an append candidate beyond the bulk
    // window stays on the outbox for the next pass instead of being
    // reclassified into a second append request. Payload-invalid potential
    // rows and recovery-status rows are not fast-append pending and remain
    // eligible for the regular path.
    const appendCandidates = (await storage.listReadyFastAppendEffects(
      maxFastAppendCandidates,
      currentFence().now,
    )).filter(isFastAppendPendingEffect).slice(0, maxFastAppendCandidates);
    const regular: PendingEffect[] = [];
    for (const pending of selected) {
      if (regular.length >= MAX_IN_FLIGHT_EFFECTS) break;
      if (isFastAppendPendingEffect(pending)) continue;
      regular.push(pending);
    }
    claimable = [...appendCandidates, ...regular];
  }
  report.selected = claimable.length;
  emitWorkerTiming(options, {
    scope: SYNC_TIMING_SCOPES.WORKER,
    phase: "recover_and_select",
    durationMs: Date.now() - selectStartedAt,
    operationKinds: operationKindsForPendingEffects(claimable),
    operationCounts: countsForPendingEffects(claimable),
  });

  const claimed: ClaimedEffect[] = [];
  const recoveryCandidates: ClaimedEffect[] = [];
  const claimEffectsStartedAt = Date.now();
  for (const pending of claimable) {
    const claimToken = "claim:" + randomUUID();
    const claim = await storage.claimEffect({
      ...currentFence(),
      effectId: pending.effect_id,
      claimToken,
      dispatchId: "dispatch:" + randomUUID(),
      leaseDurationMs: effectLeaseDuration,
    });
    if (claim.status !== "claimed") continue;
    report.claimed += 1;
    let providerEffect: Presence<SyncProjectionEffect>;
    let invalidPayloadError: Presence<string>;
    try {
      providerEffect = presentValue(toProviderEffect(pending));
      invalidPayloadError = absentValue();
    } catch (error: unknown) {
      providerEffect = absentValue();
      invalidPayloadError = presentValue(safeErrorMessage(error));
    }
    const item = { pending, claimToken, providerEffect, invalidPayloadError };
    if (
      pending.status === OUTBOX_EFFECT_STATUSES.FAILED ||
      pending.status === OUTBOX_EFFECT_STATUSES.DELIVERY_UNCERTAIN
    ) {
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

  const fullProvider = isFullEffectProvider(options.provider)
    ? options.provider
    : undefined;
  if (fullProvider === undefined) {
    await rejectUnsupportedProviderEffects(
      storage,
      currentFence(),
      recoveryCandidates,
      report,
    );
  } else if (await refreshDispatchLeases(recoveryCandidates)) {
    await recoverUnknownResults(
      { ...options, provider: fullProvider },
      storage,
      currentFence(),
      recoveryCandidates,
      report,
    );
  }

  const usable = claimed.filter((item) => isPresent(item.providerEffect));
  for (const invalid of claimed.filter((item) => isAbsent(item.providerEffect))) {
    await completeFailure(
      storage,
      currentFence(),
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
      ...currentFence(),
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

  const fastAppendGroups = chunkFastAppendGroups(
    groupByFastAppendRequest(fastAppendItems),
    // The bulk provider runtime sends one append request per route at the
    // bulk claim window; every other runtime keeps the adaptive/bounded
    // per-request chunking.
    (group) => options.maxFastAppendCandidates
      ?? options.batchController?.limitFor(routeKey(group.request))
      ?? EFFECT_BATCH_LIMIT,
  );
  for (const group of fastAppendGroups) {
    if (!(await refreshDispatchLeases(group.items))) continue;
    await dispatchFastAppendGroup(
      options,
      storage,
      currentFence(),
      group,
      report,
      fullProvider,
      () => refreshDispatchLeases(group.items),
    );
  }

  if (fullProvider === undefined) {
    await rejectUnsupportedProviderEffects(storage, currentFence(), regularItems, report);
  } else {
    // Chunk each physical route to the provider's bounded effect batch so one
    // applyEffects call returns a complete result set. An oversized configured
    // worker limit (maxEffects) would otherwise send more effects than the
    // provider acknowledges per call, producing hasMore partial prefixes and the
    // deferred/requeue churn they cause on every pass.
    const regularGroups = chunkProviderEffectGroups(
      groupByProviderRequest(regularItems),
      (group) => options.batchController?.limitFor(routeKey(group.request)) ?? EFFECT_BATCH_LIMIT,
    );
    for (const group of regularGroups) {
      if (!(await refreshDispatchLeases(group.items))) continue;
      const deferredEffectIds = new Set<string>();
      let response: Awaited<ReturnType<SyncEffectWorkerProvider["applyEffects"]>>;
      const regularOperationCounts = countsForItems(group.items);
      const regularOperationKinds = operationKindsForCounts(regularOperationCounts);
      const providerStartedAt = Date.now();
      const requestRouteKey = routeKey(group.request);
      const batchLimit = options.batchController?.beginDispatch(requestRouteKey, providerStartedAt) ?? EFFECT_BATCH_LIMIT;
      try {
        response = await fullProvider.applyEffects(group.request);
      } catch (error: unknown) {
        const outcome = classifyTransportOutcome(error);
        options.batchController?.observe(requestRouteKey, {
          durationMs: Date.now() - providerStartedAt,
          responseSucceeded: false,
          responseLoss: outcome.kind === TRANSPORT_OUTCOME_KINDS.DELIVERY_UNCERTAIN,
        });
        const failedDurationMs = Date.now() - providerStartedAt;
        emitWorkerTiming(options, {
          scope: SYNC_TIMING_SCOPES.WORKER,
          phase: "regular_provider_dispatch",
          durationMs: failedDurationMs,
          operationKinds: regularOperationKinds,
          operationCounts: regularOperationCounts,
          routeKey: requestRouteKey,
          batchLimit,
          responseSucceeded: false,
        });
        // Remote side may have written the effect before an uncertain
        // transport failure. Explicit remote failures skip recovery because
        // the provider already proved that the operation was rejected.
        const resultFence = currentFence();
        await handleProviderDispatchError(
          options,
          storage,
          resultFence,
          group.items,
          report,
          outcome,
          fullProvider,
          () => refreshDispatchLeases(group.items),
        );
        continue;
      }
      const regularProviderDurationMs = Date.now() - providerStartedAt;
      options.batchController?.observe(requestRouteKey, {
        durationMs: regularProviderDurationMs,
        responseSucceeded: response.results.length === group.items.length && !response.hasMore,
        responseLoss: response.results.length !== group.items.length || response.hasMore,
      });
      emitProviderTiming(options, response.timing);
      emitWorkerTiming(options, {
        scope: SYNC_TIMING_SCOPES.WORKER,
        phase: "regular_provider_dispatch",
        durationMs: regularProviderDurationMs,
        operationKinds: regularOperationKinds,
        operationCounts: regularOperationCounts,
        routeKey: requestRouteKey,
        batchLimit,
        responseSucceeded: response.results.length === group.items.length && !response.hasMore,
      });

      const resultPersistenceStartedAt = Date.now();
      const byEffectId = new Map(response.results.map((result) => [result.effectId, result]));
      for (const item of group.items) {
        const result = lookupResult(byEffectId.get(item.pending.effect_id));
        if (result.kind === LOOKUP_RESULT_KINDS.NOT_FOUND && response.hasMore) {
          if (await storage.releaseUnprocessedEffect({
            ...currentFence(),
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
          (result.value.status === SYNC_EFFECT_RESULT_STATUSES.APPLIED ||
            result.value.status === SYNC_EFFECT_RESULT_STATUSES.ALREADY_APPLIED) &&
          (
            !isSuccessfulPostcondition(result.value.postcondition) ||
            !isPresent(result.value.visibleRevision) ||
            !isPresent(result.value.visibleHash) ||
            !isPresent(item.providerEffect) ||
            result.value.visibleHash.value !== item.providerEffect.value.payload.targetVisibleHash
          )
        ) {
          // A success label without the acknowledged target state is not enough
          // to close a durable effect. Treat it like a lost response and read
          // back first.
          recoveryItems.push(item);
          continue;
        }
        await completeProviderResult(options, storage, currentFence(), item, result.value, report);
      }
      if (await refreshDispatchLeases(recoveryItems)) {
        await recoverUnknownResults(
          { ...options, provider: fullProvider },
          storage,
          currentFence(),
          recoveryItems,
          report,
        );
      }
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
    listReadyEffects: (limit, now) => listReadyEffectsWithAdapter(storage, limit, now),
    listReadyFastAppendEffects: (limit, now) => listReadyFastAppendEffectsWithAdapter(storage, limit, now),
    claimEffect: (options) => claimEffectWithAdapter(storage, options),
    ensureSpreadsheetAuthority: async (options) => {
      const result = await ensureSpreadsheetAuthorityWithAdapter(storage, options);
      return result.kind === "claimed";
    },
    markDeliveryUncertain: (options) => markDeliveryUncertainWithAdapter(storage, options),
    renewEffectLease: (options) => renewEffectLeaseWithAdapter(storage, options),
    applyEffectResult: (options) => applyEffectResultWithAdapter(storage, options),
    releaseUnprocessedEffect: (options) => releaseUnprocessedEffectWithAdapter(storage, options),
    retryClaimedEffect: (options) => retryClaimedEffectWithAdapter(storage, options),
    supersedeAndReplan: (fence, oldEffectId, newEffect) => {
      return supersedeAndReplanWithAdapter(storage, fence, oldEffectId, newEffect);
    },
    isUserInputCandidateBlocked: (item) => {
      const effect = item.providerEffect;
      if (
        !isPresent(effect) ||
        !isCandidateProtectingUserInputEffect(effect.value)
      ) {
        return Promise.resolve(false);
      }
      const rowBinding = effect.value.rowBindingId;
      if (!isPresent(rowBinding)) return Promise.resolve(false);
      const providerEffect = effect.value;
      const rowBindingId = rowBinding.value;
      const fieldNames = Object.keys(providerEffect.payload.fields);
      return storage.read(({ sql }) => hasActiveUserInputCandidateWithSql(sql, {
        physicalSheetId: providerEffect.physicalSheetId,
        projection: SYNC_PROJECTIONS.USER_INPUT,
        rowBindingId,
        fieldNames,
        openConflictStatus: CONFLICT_STATUSES.OPEN,
        rebasedConflictStatus: CONFLICT_STATUSES.NEEDS_REBASE,
      }));
    },
  };
}

/** Returns the full provider only when every regular recovery capability exists. */
function isFullEffectProvider(
  provider: SyncEffectWorkerProvider,
): provider is SyncEffectWorkerProvider {
  return "applyEffects" in provider &&
    typeof provider.applyEffects === "function" &&
    "readEffectPostcondition" in provider &&
    typeof provider.readEffectPostcondition === "function" &&
    "readEffectPostconditions" in provider &&
    typeof provider.readEffectPostconditions === "function";
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
  if (
    options.maxFastAppendCandidates !== undefined &&
    (!Number.isSafeInteger(options.maxFastAppendCandidates) ||
      options.maxFastAppendCandidates < POSITIVE_SAFE_INTEGER_MINIMUM)
  ) {
    throwWorkerError("effect worker maxFastAppendCandidates must be a positive safe integer");
  }
  if (
    options.appendDispatchIntervalMs !== undefined &&
    (!Number.isSafeInteger(options.appendDispatchIntervalMs) ||
      options.appendDispatchIntervalMs < NON_NEGATIVE_SAFE_INTEGER_MINIMUM)
  ) {
    throwWorkerError("effect worker appendDispatchIntervalMs must be a non-negative safe integer");
  }
  for (const [name, value] of [
    ["writerLeaseDurationMs", options.writerLeaseDurationMs],
    ["effectLeaseDurationMs", options.effectLeaseDurationMs],
    ["requestTimeoutMs", options.requestTimeoutMs],
  ] as const) {
    if (
      value !== undefined &&
      (!Number.isSafeInteger(value) || value < POSITIVE_SAFE_INTEGER_MINIMUM)
    ) {
      throwWorkerError(name + " must be a positive safe integer");
    }
  }
  const writerLeaseDuration = options.writerLeaseDurationMs ?? DEFAULT_WRITER_LEASE_DURATION_MS;
  const effectLeaseDuration = options.effectLeaseDurationMs ?? DEFAULT_EFFECT_LEASE_DURATION_MS;
  if (writerLeaseDuration <= effectLeaseDuration) {
    throwWorkerError("writerLeaseDurationMs must exceed effectLeaseDurationMs");
  }
  if (
    options.requestTimeoutMs !== undefined &&
    effectLeaseDuration <= options.requestTimeoutMs + EFFECT_LEASE_PROVIDER_HEADROOM_MS
  ) {
    throwWorkerError("effectLeaseDurationMs must exceed requestTimeoutMs by 30 seconds");
  }
}
