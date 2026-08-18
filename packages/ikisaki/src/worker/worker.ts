/**
 * Fenced outbox worker for projection effects.
 *
 * It owns only claim/result transitions against the kernel. The dispatcher
 * supplies every remote operation and payload-derived decision; canonical
 * state and any repair replan payload are supplied by the writer boundary.
 * The dispatcher is never allowed to choose a winner or silently retry a
 * response-lost write.
 */

import { randomUUID } from "node:crypto";
import type { SqlStorageAdapter } from "../sql.js";
import type {
  FencingContext,
  PendingEffect,
  WriterLease,
} from "../index.js";
import {
  LOOKUP_RESULT_KINDS,
  type Presence,
} from "../state.js";
import {
  claimEffectWithAdapter,
  applyEffectResultWithAdapter,
  markDeliveryUncertainWithAdapter,
  renewEffectLeaseWithAdapter,
  recoverExpiredLeasesWithAdapter,
  listReadyEffectsWithAdapter,
  listReadyFastAppendEffectsWithAdapter,
  releaseUnprocessedEffectWithAdapter,
  retryClaimedEffectWithAdapter,
  supersedeAndReplanWithAdapter,
} from "../outbox.js";
import {
  claimWriterLeaseWithAdapter,
  WRITER_LEASE_CLAIM_RESULT_KINDS,
} from "../writerLease.js";
import type { ClaimedEffect } from "./contracts.js";
import type { Dispatcher } from "./dispatcher.js";
import type {
  EffectWorkerBaseOptions,
  EffectWorkerWithAdapterOptions,
} from "./options.js";
import type { EffectWorkerStorage } from "./storage.js";
import type {
  MutableReport,
  WorkerReport,
} from "./report.js";
import {
  DEFAULT_EFFECT_LEASE_DURATION_MS,
  DEFAULT_WORKER_ROLE,
  DEFAULT_WRITER_LEASE_DURATION_MS,
  EFFECT_BATCH_LIMIT,
  EFFECT_LEASE_PROVIDER_HEADROOM_MS,
  MAX_IN_FLIGHT_EFFECTS,
  OUTBOX_EFFECT_STATUSES,
  WORKER_ERROR_CODES,
} from "./constants.js";
import {
  absentValue,
  isAbsent,
  isPresent,
  lookupResult,
  presentValue,
  safeErrorMessage,
  throwWorkerError,
} from "./helpers.js";
import {
  countsForItems,
  countsForPendingEffects,
  emptyOperationCounts,
  emitProviderTiming,
  emitWorkerTiming,
  operationKindsForCounts,
  operationKindsForItems,
  operationKindsForPendingEffects,
} from "./timing.js";
import {
  completeFailure,
  completeProviderResult,
  failUnclassifiableItems,
  recoverUnknownResults,
} from "./transitions.js";
import {
  dispatchFastAppendGroup,
  handleProviderDispatchError,
} from "./dispatch.js";
import {
  isDispatchTransportError,
} from "./errors.js";
import {
  chunkEffectGroups,
  fenceFromLease,
  groupEffectsByRoute,
  isFastAppendPendingEffect,
  orderDispatchUnits,
  type EffectRouteGroup,
} from "./routing.js";
import {
  TIMING_SCOPES,
} from "./timing.js";

const EMPTY_STRING_LENGTH_ZERO = 0;
const NON_NEGATIVE_SAFE_INTEGER_MINIMUM = 0;
const POSITIVE_SAFE_INTEGER_MINIMUM = 1;

/**
 * Processes effects through an adapter-owned SQL connection.
 *
 * This is the adapter-compatible worker entrypoint: it never opens its own
 * database beside a host connection.
 */
export async function runEffectWorkerWithAdapter(
  options: EffectWorkerWithAdapterOptions,
): Promise<WorkerReport> {
  return runEffectWorker(options, createAdapterEffectWorkerStorage(options.storage));
}

async function runEffectWorker(
  options: EffectWorkerBaseOptions,
  storage: EffectWorkerStorage,
): Promise<WorkerReport> {
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
      scope: TIMING_SCOPES.WORKER,
      phase: "writer_lease_claim",
      durationMs: Date.now() - leaseStartedAt,
      operationKinds: [],
      operationCounts: emptyOperationCounts(),
    });
    emitWorkerTiming(options, {
      scope: TIMING_SCOPES.WORKER,
      phase: "worker_total",
      durationMs: Date.now() - passStartedAt,
      operationKinds: [],
      operationCounts: emptyOperationCounts(),
    });
    return freezeReport(report);
  }
  const report = mutableReport(presentValue(claimResult.lease));
  emitWorkerTiming(options, {
    scope: TIMING_SCOPES.WORKER,
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
  /**
   * Refreshes the writer fence and dispatch authority BEFORE the mutation
   * lane is entered.
   *
   * Effect leases are deliberately NOT renewed here: queue time on the
   * physical-sheet mutation lane plus shared limiter waits can outlive a
   * lease refreshed this early. Renewal happens inside
   * `renewDispatchEffectLeases`, which the host runs from its
   * `beforeRemoteDispatch` hook immediately before the remote call.
   */
  const prepareDispatchFences = async (items: readonly ClaimedEffect[]): Promise<boolean> => {
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
      const ensured = await options.dispatcher.ensureAuthority?.(
        currentFence(),
        physicalSheetId,
        options.workerId,
      );
      if (ensured === false) {
        await storage.recoverExpiredLeases(currentFence());
        return false;
      }
    }
    return true;
  };
  /**
   * Renews only the effect leases of one claimed batch.
   *
   * Runs inside the host's acquired-lane `beforeRemoteDispatch` hook so the
   * lease covers lane queue time, limiter waits, and the remote call itself.
   * On any failed renewal the expired/overridden claim is recovered through
   * the durable outbox (expired rows become delivery_uncertain pending a
   * probe; stale rows are requeued) and this returns false; the caller must
   * abort before any remote request, never sending a write with an
   * expired or unknown lease.
   */
  const renewDispatchEffectLeases = async (items: readonly ClaimedEffect[]): Promise<boolean> => {
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
      scope: TIMING_SCOPES.WORKER,
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
    )).filter((pending) => isFastAppendPendingEffect(pending, options.dispatcher))
      .slice(0, maxFastAppendCandidates);
    const regular: PendingEffect[] = [];
    for (const pending of selected) {
      if (regular.length >= MAX_IN_FLIGHT_EFFECTS) break;
      if (isFastAppendPendingEffect(pending, options.dispatcher)) continue;
      regular.push(pending);
    }
    claimable = [...appendCandidates, ...regular];
  }
  report.selected = claimable.length;
  emitWorkerTiming(options, {
    scope: TIMING_SCOPES.WORKER,
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
    let invalidPayloadError: Presence<string>;
    try {
      invalidPayloadError = options.dispatcher.payloadValidationError(pending);
    } catch (error: unknown) {
      // The validation predicate is declared never to throw, but a violating
      // dispatcher must not abort the pass: degrade the claimed effect
      // through the same per-effect invalid-payload failure path the old
      // worker used for payload-parse failures.
      invalidPayloadError = presentValue(
        "Dispatcher payload validation threw: " + safeErrorMessage(error),
      );
    }
    const item = { pending, claimToken, invalidPayloadError };
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
    scope: TIMING_SCOPES.WORKER,
    phase: "effect_claims",
    durationMs: Date.now() - claimEffectsStartedAt,
    operationKinds: operationKindsForItems([...claimed, ...recoveryCandidates]),
    operationCounts: countsForItems([...claimed, ...recoveryCandidates]),
  });

  if (await prepareDispatchFences(recoveryCandidates)) {
    await recoverUnknownResults(
      options,
      storage,
      currentFence(),
      recoveryCandidates,
      report,
      renewDispatchEffectLeases,
    );
  }

  const usable = claimed.filter((item) => isAbsent(item.invalidPayloadError));
  for (const invalid of claimed.filter((item) => isPresent(item.invalidPayloadError))) {
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
  if (options.dispatcher.gate !== undefined && usable.length > 0) {
    const gate = await options.dispatcher.gate(usable);
    const blockedIds = new Set(gate.blocked);
    for (const item of usable) {
      if (!blockedIds.has(item.pending.effect_id)) {
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
  } else {
    dispatchable.push(...usable);
  }
  emitWorkerTiming(options, {
    scope: TIMING_SCOPES.WORKER,
    phase: "candidate_gate",
    durationMs: Date.now() - candidateGateStartedAt,
    operationKinds: operationKindsForItems(usable),
    operationCounts: countsForItems(usable),
  });

  const fastAppendItems: ClaimedEffect[] = [];
  const regularItems: ClaimedEffect[] = [];
  for (const item of dispatchable) {
    try {
      if (options.dispatcher.isFastAppendCandidate(item.pending)) {
        fastAppendItems.push(item);
      } else {
        regularItems.push(item);
      }
    } catch (error: unknown) {
      // The candidacy predicate is declared never to throw, but a violating
      // dispatcher must not abort the pass: fail the claimed effect
      // per-effect through the invalid-payload path and skip it.
      await completeFailure(
        storage,
        currentFence(),
        item,
        WORKER_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
        presentValue("Dispatcher fast-append classification threw: " + safeErrorMessage(error)),
        report,
      );
    }
  }

  let fastAppendRouteGroups: readonly EffectRouteGroup[];
  try {
    fastAppendRouteGroups = groupEffectsByRoute(
      fastAppendItems,
      (effect) => options.dispatcher.routeKeyFor(effect),
    );
  } catch (error: unknown) {
    // The route predicate is declared never to throw, but a violating
    // dispatcher must not abort the pass: fail the affected claimed items
    // per-effect and skip the whole bucket instead of dispatching it.
    await failUnclassifiableItems(
      storage,
      currentFence(),
      fastAppendItems,
      "Dispatcher route classification threw: " + safeErrorMessage(error),
      report,
    );
    fastAppendRouteGroups = [];
  }
  const fastAppendGroups = chunkEffectGroups(
    fastAppendRouteGroups,
    // The bulk provider runtime sends one append request per route at the
    // bulk claim window; every other runtime keeps the adaptive/bounded
    // per-request chunking.
    (group) => options.maxFastAppendCandidates
      ?? options.batchController?.limitFor(group.routeKey)
      ?? EFFECT_BATCH_LIMIT,
  );
  // Ready effects run in ascending dispatcher-declared priority across BOTH
  // dispatch buckets, so the host can keep its critical projection (System_State
  // fast appends, then System_State regular followers, then Sync_Conflicts fast
  // appends, then everything else) ahead of unrelated work. Only the dispatch
  // SEQUENCE changes: claim windows, leases, fencing, per-target predecessor
  // ordering, the limiter, and the bounded selection are untouched, every
  // claimed group is still dispatched in this same pass, and unready
  // predecessors are never forced (claiming enforces the durable guard).

  // Chunk each physical route to the dispatcher's bounded effect batch so one
  // apply call returns a complete result set. An oversized configured worker
  // limit (maxEffects) would otherwise send more effects than the dispatcher
  // acknowledges per call, producing hasMore partial prefixes and the
  // deferred/requeue churn they cause on every pass.
  let regularRouteGroups: readonly EffectRouteGroup[];
  try {
    regularRouteGroups = groupEffectsByRoute(
      regularItems,
      (effect) => options.dispatcher.routeKeyFor(effect),
    );
  } catch (error: unknown) {
    await failUnclassifiableItems(
      storage,
      currentFence(),
      regularItems,
      "Dispatcher route classification threw: " + safeErrorMessage(error),
      report,
    );
    regularRouteGroups = [];
  }
  const regularGroups = chunkEffectGroups(
    regularRouteGroups,
    (group) => options.batchController?.limitFor(group.routeKey) ?? EFFECT_BATCH_LIMIT,
  );
  const dispatchUnits = orderDispatchUnits(
    fastAppendGroups,
    regularGroups,
    options.dispatcher,
  );
  for (const unit of dispatchUnits) {
    const group = unit.group;
    if (unit.bucket === "fast-append") {
      if (!(await prepareDispatchFences(group.items))) continue;
      await dispatchFastAppendGroup(
        options,
        storage,
        currentFence(),
        group,
        report,
        () => prepareDispatchFences(group.items),
        renewDispatchEffectLeases,
      );
      continue;
    }
    if (!(await prepareDispatchFences(group.items))) continue;
    const deferredEffectIds = new Set<string>();
    let outcome: Awaited<ReturnType<Dispatcher["apply"]>>;
    const regularOperationCounts = countsForItems(group.items);
    const regularOperationKinds = operationKindsForCounts(regularOperationCounts);
    const providerStartedAt = Date.now();
    const requestRouteKey = group.routeKey;
    const batchLimit = options.batchController?.beginDispatch(requestRouteKey, providerStartedAt)
      ?? EFFECT_BATCH_LIMIT;
    try {
      outcome = await options.dispatcher.apply({
        routeKey: requestRouteKey,
        effects: group.items.map((item) => item.pending),
        beforeRemoteDispatch: () => renewDispatchEffectLeases(group.items),
      });
    } catch (error: unknown) {
      const uncertain = !isDispatchTransportError(error) ||
        error.kind === "delivery_uncertain";
      options.batchController?.observe(requestRouteKey, {
        durationMs: Date.now() - providerStartedAt,
        responseSucceeded: false,
        responseLoss: uncertain,
      });
      const failedDurationMs = Date.now() - providerStartedAt;
      emitWorkerTiming(options, {
        scope: TIMING_SCOPES.WORKER,
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
        error,
        () => prepareDispatchFences(group.items),
        renewDispatchEffectLeases,
      );
      continue;
    }
    const regularProviderDurationMs = Date.now() - providerStartedAt;
    options.batchController?.observe(requestRouteKey, {
      durationMs: regularProviderDurationMs,
      responseSucceeded: outcome.results.length === group.items.length && !outcome.hasMore,
      responseLoss: outcome.results.length !== group.items.length || outcome.hasMore,
    });
    emitProviderTiming(options, outcome.timing);
    emitWorkerTiming(options, {
      scope: TIMING_SCOPES.WORKER,
      phase: "regular_provider_dispatch",
      durationMs: regularProviderDurationMs,
      operationKinds: regularOperationKinds,
      operationCounts: regularOperationCounts,
      routeKey: requestRouteKey,
      batchLimit,
      responseSucceeded: outcome.results.length === group.items.length && !outcome.hasMore,
    });

    const resultPersistenceStartedAt = Date.now();
    const byEffectId = new Map(outcome.results.map((result) => [result.effectId, result]));
    for (const item of group.items) {
      const result = lookupResult(byEffectId.get(item.pending.effect_id));
      if (result.kind === LOOKUP_RESULT_KINDS.NOT_FOUND && outcome.hasMore) {
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
      if (result.value.status === "delivery_uncertain") {
        // A success label without the acknowledged target state is not enough
        // to close a durable effect. Treat it like a lost response and read
        // back first.
        recoveryItems.push(item);
        continue;
      }
      await completeProviderResult(options, storage, currentFence(), item, result.value, report);
    }
    if (await prepareDispatchFences(recoveryItems)) {
      await recoverUnknownResults(
        options,
        storage,
        currentFence(),
        recoveryItems,
        report,
        renewDispatchEffectLeases,
      );
    }
    emitWorkerTiming(options, {
      scope: TIMING_SCOPES.WORKER,
      phase: "regular_result_persistence",
      durationMs: Date.now() - resultPersistenceStartedAt,
      operationKinds: regularOperationKinds,
      operationCounts: regularOperationCounts,
    });
  }
  emitWorkerTiming(options, {
    scope: TIMING_SCOPES.WORKER,
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
    markDeliveryUncertain: (options) => markDeliveryUncertainWithAdapter(storage, options),
    renewEffectLease: (options) => renewEffectLeaseWithAdapter(storage, options),
    applyEffectResult: (options) => applyEffectResultWithAdapter(storage, options),
    releaseUnprocessedEffect: (options) => releaseUnprocessedEffectWithAdapter(storage, options),
    retryClaimedEffect: (options) => retryClaimedEffectWithAdapter(storage, options),
    supersedeAndReplan: (fence, oldEffectId, newEffect) => {
      return supersedeAndReplanWithAdapter(storage, fence, oldEffectId, newEffect);
    },
  };
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

function freezeReport(report: MutableReport): WorkerReport {
  return { ...report };
}

function validateOptions(options: EffectWorkerBaseOptions): void {
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
