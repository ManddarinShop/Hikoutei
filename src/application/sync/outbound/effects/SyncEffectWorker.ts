/**
 * Fenced outbox worker for projection effects.
 *
 * It owns only claim/result transitions.  Canonical state and any repair
 * replan payload are supplied by the writer boundary; the gateway is never
 * allowed to choose a winner or silently retry a response-lost write.
 */

import { randomUUID } from "node:crypto";
import type { LookupResult } from "../../../../domain/index.js";
import {
  LOOKUP_RESULT_KINDS,
} from "../../../../shared/state/constants.js";
import {
  type FencingContext,
  type PendingEffect,
  type WriterLease,
} from "../../../../infrastructure/storage/index.js";
import {
  type SyncGatewayEffectResult,
  type SyncEffectWorkerFullGateway,
} from "../../gateway/syncGateway.js";
import {
  SYNC_GATEWAY_EFFECT_RESULT_STATUSES,
} from "../../gateway/constants.js";
import { WRITER_LEASE_CLAIM_RESULT_KINDS } from "../../../../infrastructure/storage/sync/shared/writerLease.js";
import {
  SYNC_TIMING_SCOPES,
} from "../../telemetry/syncTiming.js";
import {
  DEFAULT_EFFECT_LEASE_DURATION_MS,
  DEFAULT_WORKER_ROLE,
  DEFAULT_WRITER_LEASE_DURATION_MS,
  OUTBOX_EFFECT_STATUSES,
  WORKER_ERROR_CODES,
} from "./SyncEffectWorkerConstants.js";
import {
  absentValue,
  isAbsent,
  isPresent,
  lookupResult,
  presentValue,
  safeErrorMessage,
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
  isFastAppendCandidate,
  isSuccessfulGatewayPostcondition,
  toGatewayEffect,
} from "./SyncEffectWorkerRouting.js";
import { freezeReport, mutableReport } from "./SyncEffectWorkerReport.js";
import { validateSyncEffectWorkerOptions } from "./SyncEffectWorkerValidation.js";
import { createAdapterEffectWorkerStorage } from "./SyncEffectWorkerStorage.js";
import { isFullEffectGateway } from "./SyncEffectWorkerGateway.js";
import type {
  ClaimedEffect,
  EffectWorkerStorage,
  MutableReport,
  SyncEffectWorkerBaseOptions,
  SyncEffectWorkerReport,
  SyncEffectWorkerWithAdapterOptions,
} from "./SyncEffectWorkerContracts.js";
export type {
  ClaimedEffect,
  EffectWorkerStorage,
  MutableReport,
  RepairReplanFactory,
  RepairReplanRequest,
  SyncEffectWorkerBaseOptions,
  SyncEffectWorkerFullOptions,
  SyncEffectWorkerReport,
  SyncEffectWorkerWithAdapterOptions,
} from "./SyncEffectWorkerContracts.js";

/**
 * Processes effects through an adapter-owned SQL connection.
 *
 * This is the adapter-backed worker entrypoint. It uses the same connection as
 * the entity and sync transaction boundaries.
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
  const pass = await startWorkerPass(options, storage, passStartedAt);
  if (pass.kind === "lease_unavailable") return freezeReport(pass.report);

  const { fence, report } = pass;
  const { claimed, recoveryCandidates } = await recoverAndClaimEffects(
    options,
    storage,
    fence,
    report,
  );
  const fullGateway = isFullEffectGateway(options.gateway);
  await recoverClaimedFailures(options, storage, fence, fullGateway, recoveryCandidates, report);
  const dispatchable = await prepareDispatchableEffects(options, storage, fence, claimed, report);
  await dispatchEffects(options, storage, fence, fullGateway, dispatchable, report);

  emitWorkerTiming(options, {
    scope: SYNC_TIMING_SCOPES.WORKER,
    phase: "worker_total",
    durationMs: Date.now() - passStartedAt,
    operationKinds: operationKindsForItems(dispatchable),
    operationCounts: countsForItems(dispatchable),
  });
  return freezeReport(report);
}

type WorkerPass =
  | {
    readonly kind: "lease_unavailable";
    readonly report: MutableReport;
  }
  | {
    readonly kind: "ready";
    readonly fence: FencingContext;
    readonly report: MutableReport;
  };

async function startWorkerPass(
  options: SyncEffectWorkerBaseOptions,
  storage: EffectWorkerStorage,
  passStartedAt: number,
): Promise<WorkerPass> {
  validateSyncEffectWorkerOptions(options);
  const role = options.writerRole ?? DEFAULT_WORKER_ROLE;
  const leaseDuration = options.writerLeaseDurationMs ?? DEFAULT_WRITER_LEASE_DURATION_MS;
  const leaseStartedAt = Date.now();
  const claimResult = await storage.claimWriterLease({
    role,
    writerId: options.workerId,
    leaseDurationMs: leaseDuration,
    now: options.now,
  });
  const leaseTiming = {
    scope: SYNC_TIMING_SCOPES.WORKER,
    phase: "writer_lease_claim" as const,
    durationMs: Date.now() - leaseStartedAt,
    operationKinds: [],
    operationCounts: emptyOperationCounts(),
  };
  if (claimResult.kind !== WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED) {
    emitWorkerTiming(options, leaseTiming);
    emitWorkerTiming(options, {
      scope: SYNC_TIMING_SCOPES.WORKER,
      phase: "worker_total",
      durationMs: Date.now() - passStartedAt,
      operationKinds: [],
      operationCounts: emptyOperationCounts(),
    });
    return {
      kind: "lease_unavailable",
      report: mutableReport(absentValue<WriterLease>()),
    };
  }
  emitWorkerTiming(options, leaseTiming);
  return {
    kind: "ready",
    fence: fenceFromLease(claimResult.lease, options.now),
    report: mutableReport(presentValue(claimResult.lease)),
  };
}

interface ClaimedEffects {
  readonly claimed: readonly ClaimedEffect[];
  readonly recoveryCandidates: readonly ClaimedEffect[];
}

async function recoverAndClaimEffects(
  options: SyncEffectWorkerBaseOptions,
  storage: EffectWorkerStorage,
  fence: FencingContext,
  report: MutableReport,
): Promise<ClaimedEffects> {
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
  const effectLeaseDuration = options.effectLeaseDurationMs ?? DEFAULT_EFFECT_LEASE_DURATION_MS;
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
    const item = claimedEffect(pending, claimToken);
    if (pending.status === OUTBOX_EFFECT_STATUSES.FAILED) {
      recoveryCandidates.push(item);
    } else {
      claimed.push(item);
    }
  }
  const allClaimed = [...claimed, ...recoveryCandidates];
  emitWorkerTiming(options, {
    scope: SYNC_TIMING_SCOPES.WORKER,
    phase: "effect_claims",
    durationMs: Date.now() - claimEffectsStartedAt,
    operationKinds: operationKindsForItems(allClaimed),
    operationCounts: countsForItems(allClaimed),
  });
  return { claimed, recoveryCandidates };
}

function claimedEffect(pending: PendingEffect, claimToken: string): ClaimedEffect {
  try {
    return {
      pending,
      claimToken,
      gatewayEffect: presentValue(toGatewayEffect(pending)),
      invalidPayloadError: absentValue(),
    };
  } catch (error: unknown) {
    return {
      pending,
      claimToken,
      gatewayEffect: absentValue(),
      invalidPayloadError: presentValue(safeErrorMessage(error)),
    };
  }
}

async function recoverClaimedFailures(
  options: SyncEffectWorkerBaseOptions,
  storage: EffectWorkerStorage,
  fence: FencingContext,
  fullGateway: SyncEffectWorkerFullGateway | undefined,
  items: readonly ClaimedEffect[],
  report: MutableReport,
): Promise<void> {
  if (fullGateway === undefined) {
    await rejectUnsupportedGatewayEffects(storage, fence, items, report);
    return;
  }
  await recoverUnknownResults(
    { ...options, gateway: fullGateway },
    storage,
    fence,
    items,
    report,
  );
}

async function prepareDispatchableEffects(
  options: SyncEffectWorkerBaseOptions,
  storage: EffectWorkerStorage,
  fence: FencingContext,
  claimed: readonly ClaimedEffect[],
  report: MutableReport,
): Promise<readonly ClaimedEffect[]> {
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
  return dispatchable;
}

async function dispatchEffects(
  options: SyncEffectWorkerBaseOptions,
  storage: EffectWorkerStorage,
  fence: FencingContext,
  fullGateway: SyncEffectWorkerFullGateway | undefined,
  items: readonly ClaimedEffect[],
  report: MutableReport,
): Promise<void> {
  const fastAppendItems = items.filter(isFastAppendCandidate);
  const regularItems = items.filter((item) => !isFastAppendCandidate(item));
  for (const group of groupByFastAppendRequest(fastAppendItems)) {
    await dispatchFastAppendGroup(options, storage, fence, group, report);
  }
  if (fullGateway === undefined) {
    await rejectUnsupportedGatewayEffects(storage, fence, regularItems, report);
    return;
  }
  for (const group of groupByGatewayRequest(regularItems)) {
    await dispatchRegularEffectGroup(options, storage, fence, fullGateway, group, report);
  }
}

async function dispatchRegularEffectGroup(
  options: SyncEffectWorkerBaseOptions,
  storage: EffectWorkerStorage,
  fence: FencingContext,
  gateway: SyncEffectWorkerFullGateway,
  group: ReturnType<typeof groupByGatewayRequest>[number],
  report: MutableReport,
): Promise<void> {
  const regularOperationCounts = countsForItems(group.items);
  const regularOperationKinds = operationKindsForCounts(regularOperationCounts);
  const gatewayStartedAt = Date.now();
  let response: Awaited<ReturnType<SyncEffectWorkerFullGateway["applyEffects"]>>;
  try {
    response = await gateway.applyEffects(group.request);
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
      { ...options, gateway },
      storage,
      fence,
      group.items,
      report,
    );
    return;
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
  const deferredEffectIds = await releaseDeferredRegularEffects(
    storage,
    fence,
    group.items,
    response.hasMore,
    byEffectId,
    report,
  );
  const recoveryItems: ClaimedEffect[] = [];
  for (const item of group.items) {
    const result = lookupResult(byEffectId.get(item.pending.effect_id));
    if (
      result.kind === LOOKUP_RESULT_KINDS.NOT_FOUND &&
      deferredEffectIds.has(item.pending.effect_id)
    ) continue;
    if (requiresRegularResultRecovery(item, result)) {
      recoveryItems.push(item);
      continue;
    }
    if (result.kind === LOOKUP_RESULT_KINDS.FOUND) {
      await completeGatewayResult(options, storage, fence, item, result.value, report);
    }
  }
  await recoverUnknownResults(
    { ...options, gateway },
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

async function releaseDeferredRegularEffects(
  storage: EffectWorkerStorage,
  fence: FencingContext,
  items: readonly ClaimedEffect[],
  hasMore: boolean,
  results: ReadonlyMap<string, SyncGatewayEffectResult>,
  report: MutableReport,
): Promise<ReadonlySet<string>> {
  const deferredEffectIds = new Set<string>();
  if (!hasMore) return deferredEffectIds;
  for (const item of items) {
    if (results.has(item.pending.effect_id)) continue;
    if (await storage.releaseUnprocessedEffect({
      ...fence,
      effectId: item.pending.effect_id,
      claimToken: item.claimToken,
    })) {
      report.deferred += 1;
      deferredEffectIds.add(item.pending.effect_id);
    }
  }
  return deferredEffectIds;
}

function requiresRegularResultRecovery(
  item: ClaimedEffect,
  result: LookupResult<SyncGatewayEffectResult>,
): boolean {
  if (result.kind === LOOKUP_RESULT_KINDS.NOT_FOUND) return true;
  if (result.value.payloadHash !== item.pending.payload_hash) return true;
  if (
    result.value.status !== SYNC_GATEWAY_EFFECT_RESULT_STATUSES.APPLIED &&
    result.value.status !== SYNC_GATEWAY_EFFECT_RESULT_STATUSES.ALREADY_APPLIED
  ) return false;
  return !isVerifiedGatewayResult(item, result.value);
}

function isVerifiedGatewayResult(
  item: ClaimedEffect,
  result: SyncGatewayEffectResult,
): boolean {
  return isSuccessfulGatewayPostcondition(result.postcondition) &&
    isPresent(result.visibleRevision) &&
    isPresent(result.visibleHash) &&
    isPresent(item.gatewayEffect) &&
    result.visibleHash.value === item.gatewayEffect.value.payload.targetVisibleHash;
}
