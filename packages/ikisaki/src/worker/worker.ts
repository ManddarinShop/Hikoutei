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
import type {
  FencingContext,
  PendingEffect,
  WriterLease,
} from "../index.js";
import {
  LOOKUP_RESULT_KINDS,
  type Presence,
} from "../contract/state.js";
import {
  DEFAULT_WRITER_LEASE_HEARTBEAT_STALE_MS,
  WRITER_LEASE_CLAIM_RESULT_KINDS,
  writerLeaseHeartbeatStaleBoundMs,
} from "../outbox/writerLease.js";
import type { ClaimedEffect } from "./contracts.js";
import type {
  Dispatcher,
  ApplyOutcome,
  DispatchRequest,
  EffectLeaseRenewal,
  PreparedDispatch,
} from "./dispatcher.js";
import type {
  EffectWorkerBaseOptions,
  EffectWorkerWithAdapterOptions,
} from "./options.js";
import type { EffectWorkerStorage } from "./storage.js";
import {
  createAdapterEffectWorkerStorage,
} from "./storage.js";
import type {
  MutableReport,
  WorkerReport,
} from "./report.js";
import {
  mutableReport,
  freezeReport,
} from "./report.js";
import {
  DEFAULT_EFFECT_LEASE_DURATION_MS,
  DEFAULT_WORKER_ROLE,
  DEFAULT_WRITER_LEASE_DURATION_MS,
  EFFECT_BATCH_LIMIT,
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
} from "./pacing/timing.js";
import {
  completeFailure,
  completeProviderResult,
  failUnclassifiableItems,
  recoverUnknownResults,
} from "./dispatch/transitions.js";
import {
  dispatchFastAppendGroup,
  handleProviderDispatchError,
} from "./dispatch/dispatch.js";
import {
  isDispatchTransportError,
} from "./errors.js";
import {
  chunkEffectGroups,
  fenceFromLease,
  groupEffectsByRoute,
  isFastAppendPendingEffect,
  orderDispatchUnits,
  type EffectDispatchUnit,
  type EffectRouteGroup,
} from "./dispatch/routing.js";
import {
  TIMING_SCOPES,
} from "./pacing/timing.js";
import {
  validateOptions,
} from "./validate.js";

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
  const heartbeatStaleMs =
    options.writerLeaseHeartbeatStaleMs ?? DEFAULT_WRITER_LEASE_HEARTBEAT_STALE_MS;
  const effectLeaseDuration = options.effectLeaseDurationMs ?? DEFAULT_EFFECT_LEASE_DURATION_MS;
  const leaseStartedAt = Date.now();
  const claimResult = await storage.claimWriterLease({
    role,
    writerId: options.workerId,
    leaseDurationMs: leaseDuration,
    now: options.now,
    heartbeatStaleBeforeMs: writerLeaseHeartbeatStaleBoundMs(options.now, heartbeatStaleMs),
  });
  if (claimResult.kind !== WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED) {
    const report = mutableReport(absentValue<WriterLease>());
    report.leaseClaimFailureReason = claimResult.reason;
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
      heartbeatStaleBeforeMs: writerLeaseHeartbeatStaleBoundMs(now, heartbeatStaleMs),
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
   * Renews the writer authority and the effect leases of one claimed batch.
   *
   * Runs inside the host's acquired-lane `beforeRemoteDispatch` hook so the
   * leases cover lane queue time, limiter waits, and the remote call itself.
   * The pre-lane `prepareDispatchFences` renewal covers selection/claim time;
   * this in-lane renewal revalidates the WRITER lease after the lane wait so
   * a long queue cannot expire it during remote work and permit a stale
   * mutation after a takeover. On any failed renewal (writer takeover or an
   * expired/overridden effect claim) the expired/overridden claim is
   * recovered through the durable outbox (expired rows become
   * delivery_uncertain pending a probe; stale rows are requeued) and this
   * returns false; the caller must abort before any remote request, never
   * sending a write with an expired or unknown lease.
   */
  const renewDispatchEffectLeases = async (items: readonly ClaimedEffect[]): Promise<boolean> => {
    // Renew the WRITER lease in-lane so a long mutation-lane queue or shared
    // limiter wait cannot expire it during remote work. A failed renewal
    // (takeover) aborts before any remote request; the next pass recovers
    // the claimed effects safely under the new fence.
    const now = leaseNow();
    const writerRefresh = await storage.claimWriterLease({
      role,
      writerId: options.workerId,
      leaseDurationMs: leaseDuration,
      now,
      heartbeatStaleBeforeMs: writerLeaseHeartbeatStaleBoundMs(now, heartbeatStaleMs),
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
        reason: "lease_recovered",
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
      (effect) => options.dispatcher.fastAppendRouteKeyFor?.(effect)
        ?? options.dispatcher.routeKeyFor(effect),
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
  // Read-ahead pipeline: overlap one route's regular preflight (a paced read)
  // with the previous route's write/verify. Only a split-capable regular unit
  // whose route DIFFERS from the current unit is preflighted ahead, so
  // same-route writes and same-route preflight sequencing stay strictly serial
  // (no concurrent SQLite transactions, no CAS-predecessor violation). A
  // preflight does no SQLite work and no lease renewal, so it cannot race a
  // result persistence or a before-remote renewal; CAS guards make a stale
  // preflight safe (it resolves to a guard mismatch instead of overwriting).
  const supportsSplit = (unit: EffectDispatchUnit): boolean =>
    unit.bucket === "regular" &&
    options.dispatcher.preflight !== undefined &&
    options.dispatcher.applyPrepared !== undefined;
  const dispatchRequestFor = (unit: EffectDispatchUnit): DispatchRequest => ({
    routeKey: unit.group.routeKey,
    effects: unit.group.items.map((item) => item.pending),
    beforeRemoteDispatch: () => renewDispatchEffectLeases(unit.group.items),
  });
  // Fires a unit's preflight and feeds its latency/outcome into the adaptive
  // batch controller so a slow or failed read backs the route off instead of
  // letting later write successes falsely grow the batch limit.
  const preflightWithTiming = (unit: EffectDispatchUnit): Promise<PreparedDispatch> => {
    const routeKey = unit.group.routeKey;
    const startedAt = Date.now();
    const controller = options.batchController;
    return options.dispatcher.preflight!(dispatchRequestFor(unit)).then(
      (prepared) => {
        controller?.observePreflight?.(routeKey, {
          durationMs: Date.now() - startedAt,
          succeeded: true,
        });
        return prepared;
      },
      (error: unknown) => {
        controller?.observePreflight?.(routeKey, {
          durationMs: Date.now() - startedAt,
          succeeded: false,
        });
        throw error;
      },
    );
  };
  // Fires the NEXT unit's preflight ahead of the current write when the two
  // routes differ (a same-route next unit must observe the current write).
  // Read-ahead is only launched from a current REGULAR unit whose OWN preflight
  // and fence/authority check have already completed: a fast-append unit's
  // atomic multi-route write must not be overlapped by a regular preflight
  // (which could observe a stale prepared state), and a next-route read may
  // overlap the current WRITE but never the current preflight, so the two
  // preflights in an A→B chain stay strictly sequential.
  const fireNextPreflight = (current: EffectDispatchUnit, nextUnit: EffectDispatchUnit | undefined): void => {
    if (
      readAheadSuppressed ||
      current.bucket !== "regular" ||
      nextUnit === undefined ||
      !supportsSplit(nextUnit) ||
      nextUnit.group.routeKey === current.group.routeKey
    ) return;
    const prepared = preflightWithTiming(nextUnit);
    // Observe the rejection immediately so a preflight that fails before the
    // next loop iteration consumes it cannot surface as an unhandled
    // rejection; the consumer still awaits the original promise and sees the
    // rejection for requeue handling.
    void prepared.catch(() => undefined);
    pendingPrepared = prepared;
    pendingPreparedUnit = nextUnit;
  };
  let pendingPrepared: Promise<PreparedDispatch> | undefined;
  let pendingPreparedUnit: EffectDispatchUnit | undefined;
  // Read-ahead safety latch: once a current unit's fence/write is not
  // dispatchable or a preflight is refused/times out, stop overlapping any
  // further read-ahead for the remainder of THIS pass and run the remaining
  // units in safe sequential order. Reset implicitly because it is a local
  // per-pass value.
  let readAheadSuppressed = false;
  const suppressReadAhead = (): void => {
    readAheadSuppressed = true;
    pendingPrepared = undefined;
    pendingPreparedUnit = undefined;
  };
  // Settles an already-started read-ahead preflight (awaits it so it cannot
  // overlap the next unit's own preflight) and then suppresses further
  // read-ahead for the remainder of the pass. Used when a current unit's write
  // fails: the read-ahead for the next unit was already fired, so it must be
  // observed before the next unit runs its own preflight.
  const settleAndSuppressReadAhead = async (): Promise<void> => {
    const pending = pendingPrepared;
    const pendingUnit = pendingPreparedUnit;
    pendingPrepared = undefined;
    pendingPreparedUnit = undefined;
    readAheadSuppressed = true;
    if (pending !== undefined) {
      try {
        await pending;
      } catch {
        // The read-ahead preflight failed; it is already observed via the
        // `.catch(() => undefined)` in `fireNextPreflight`, so nothing to do.
      }
      // The read-ahead preflight was discarded (its write never runs), so drop
      // its buffered latency from the route; otherwise the next sequential
      // preflight for this route would add another sample and the next write
      // could be charged twice and incorrectly backed off.
      if (pendingUnit !== undefined) {
        options.batchController?.abandonPreflight?.(pendingUnit.group.routeKey);
      }
    }
  };
  // Runs one regular unit's write+verify and result persistence, settling the
  // pending read-ahead preflight if the unit throws. A result-persistence
  // failure (or any post-write storage transition) must not leave the
  // read-ahead's remote read unsettled or its controller latency retained when
  // the pass aborts: the pending preflight is awaited (so no remote read is
  // left unhandled) and its buffered latency is abandoned before the error
  // propagates out of the pass.
  const runRegularUnit = async (
    group: EffectRouteGroup,
    remote: () => Promise<ApplyOutcome>,
  ): Promise<boolean> => {
    try {
      const writeOk = await dispatchRegularUnit(
        options,
        storage,
        currentFence,
        group,
        report,
        remote,
        prepareDispatchFences,
        renewDispatchEffectLeases,
      );
      if (!writeOk) await settleAndSuppressReadAhead();
      return writeOk;
    } catch (error: unknown) {
      await settleAndSuppressReadAhead();
      throw error;
    }
  };
  for (let index = 0; index < dispatchUnits.length; index += 1) {
    const unit = dispatchUnits[index]!;
    const next = dispatchUnits[index + 1];
    const group = unit.group;
    if (unit.bucket === "fast-append") {
      if (!(await prepareDispatchFences(group.items))) {
        suppressReadAhead();
        continue;
      }
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
    if (pendingPreparedUnit === unit) {
      // This unit (B) was preflighted ahead by the previous unit's read-ahead;
      // consume it now. Only AFTER B's own fence/authority check succeeds is
      // C's preflight scheduled, immediately before B's write, so the A/B and
      // B/C preflights never overlap while C overlaps B's write.
      let prepared: PreparedDispatch;
      try {
        prepared = await pendingPrepared!;
      } catch (error: unknown) {
        pendingPrepared = undefined;
        pendingPreparedUnit = undefined;
        suppressReadAhead();
        await handlePreflightFailure(
          storage,
          currentFence,
          group,
          report,
          prepareDispatchFences,
          error,
        );
        continue;
      }
      pendingPrepared = undefined;
      pendingPreparedUnit = undefined;
      if (!(await prepareDispatchFences(group.items))) {
        // The prepared read succeeded but its write cannot run (fence or
        // authority loss). Drop the buffered read-ahead latency so the next
        // genuine write is not charged a read whose write never happened.
        options.batchController?.abandonPreflight?.(group.routeKey);
        suppressReadAhead();
        continue;
      }
      fireNextPreflight(unit, next);
      await runRegularUnit(
        group,
        () => options.dispatcher.applyPrepared!(dispatchRequestFor(unit), prepared),
      );
      continue;
    }
    if (supportsSplit(unit)) {
      // Current unit A: complete A's own preflight and its fence/authority
      // check FIRST, then start at most one next-route preflight immediately
      // before dispatching A's write, so the read overlaps A's WRITE and never
      // overlaps A's preflight.
      let prepared: PreparedDispatch;
      try {
        prepared = await preflightWithTiming(unit);
      } catch (error: unknown) {
        suppressReadAhead();
        await handlePreflightFailure(
          storage,
          currentFence,
          group,
          report,
          prepareDispatchFences,
          error,
        );
        continue;
      }
      if (!(await prepareDispatchFences(group.items))) {
        // The preflight succeeded but its write is dropped on fence/authority
        // loss; clear the buffered read latency so a future write is not
        // charged a read whose write never ran.
        options.batchController?.abandonPreflight?.(group.routeKey);
        suppressReadAhead();
        continue;
      }
      fireNextPreflight(unit, next);
      await runRegularUnit(
        group,
        () => options.dispatcher.applyPrepared!(dispatchRequestFor(unit), prepared),
      );
      continue;
    }
    // Legacy regular unit (dispatcher implements neither split method).
    if (!(await prepareDispatchFences(group.items))) {
      suppressReadAhead();
      continue;
    }
    await runRegularUnit(
      group,
      () => options.dispatcher.apply(dispatchRequestFor(unit)),
    );
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

/**
 * Runs one regular route group's write+verify phase and persists its results.
 *
 * Shared by the legacy single `apply` path and the split
 * `preflight`/`applyPrepared` path: `remote` performs the provider write
 * (either `dispatcher.apply` or `dispatcher.applyPrepared`) and throws a
 * classified `DispatchTransportError` on transport failure. `prepareFences`
 * and `renewEffectLeases` are the same safety closures the single-apply path
 * used, so lease/fence accounting, pacing, receipts, CAS evidence, response
 * classification, hasMore/budget behavior, and result persistence are
 * identical.
 */
async function dispatchRegularUnit(
  options: EffectWorkerBaseOptions,
  storage: EffectWorkerStorage,
  fence: () => FencingContext,
  group: EffectRouteGroup,
  report: MutableReport,
  remote: () => Promise<ApplyOutcome>,
  prepareFences: (items: readonly ClaimedEffect[]) => Promise<boolean>,
  renewEffectLeases: EffectLeaseRenewal,
): Promise<boolean> {
  const deferredEffectIds = new Set<string>();
  let outcome: ApplyOutcome;
  const regularOperationCounts = countsForItems(group.items);
  const regularOperationKinds = operationKindsForCounts(regularOperationCounts);
  const providerStartedAt = Date.now();
  const requestRouteKey = group.routeKey;
  const batchLimit = options.batchController?.beginDispatch(requestRouteKey, providerStartedAt)
    ?? EFFECT_BATCH_LIMIT;
  try {
    outcome = await remote();
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
    // Remote side may have written the effect before an uncertain transport
    // failure. Explicit remote failures skip recovery because the provider
    // already proved that the operation was rejected.
    await handleProviderDispatchError(
      options,
      storage,
      fence(),
      group.items,
      report,
      error,
      () => prepareFences(group.items),
      renewEffectLeases,
    );
    // The write failed (refusal, timeout, or delivery-uncertain fence loss):
    // signal the caller to suppress any already-started read-ahead so the
    // next unit cannot overlap a write that never ran.
    return false;
  }
  const regularProviderDurationMs = Date.now() - providerStartedAt;
  // A hasMore=true reply with a valid returned prefix is a healthy partial
  // application whose suffix is deferred to the next pass (the provider
  // stopped at its body budget), so it must not back the route off. Only a
  // hasMore=false reply that is missing results (a lost response) keeps the
  // delivery-uncertain recovery backoff.
  const regularDispatchHealthy =
    (outcome.results.length === group.items.length && !outcome.hasMore) ||
    (outcome.hasMore && outcome.results.length > 0);
  options.batchController?.observe(requestRouteKey, {
    durationMs: regularProviderDurationMs,
    responseSucceeded: regularDispatchHealthy,
    responseLoss: !outcome.hasMore && outcome.results.length !== group.items.length,
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
    responseSucceeded: regularDispatchHealthy,
    hasMore: outcome.hasMore,
    requestedEffects: group.items.length,
    acknowledgedEffects: outcome.results.length,
  });

  const resultPersistenceStartedAt = Date.now();
  const byEffectId = new Map(outcome.results.map((result) => [result.effectId, result]));
  for (const item of group.items) {
    const result = lookupResult(byEffectId.get(item.pending.effect_id));
    if (result.kind === LOOKUP_RESULT_KINDS.NOT_FOUND && outcome.hasMore) {
      if (await storage.releaseUnprocessedEffect({
        ...fence(),
        effectId: item.pending.effect_id,
        claimToken: item.claimToken,
        reason: "provider_batch",
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
    await completeProviderResult(options, storage, fence(), item, result.value, report);
  }
  if (await prepareFences(recoveryItems)) {
    await recoverUnknownResults(
      options,
      storage,
      fence(),
      recoveryItems,
      report,
      renewEffectLeases,
    );
  } else {
    // The recovery fence/authority check failed, so the uncertain results
    // could not be settled this pass. Signal the caller to suppress read-ahead
    // for the remainder of the pass.
    return false;
  }
  emitWorkerTiming(options, {
    scope: TIMING_SCOPES.WORKER,
    phase: "regular_result_persistence",
    durationMs: Date.now() - resultPersistenceStartedAt,
    operationKinds: regularOperationKinds,
    operationCounts: regularOperationCounts,
  });
  return true;
}

/**
 * Handles a failed regular-unit preflight.
 *
 * A preflight is a read-only stage: no remote write was issued and no effect
 * lease was renewed, so the claimed effects are safely requeued for the next
 * pass (never routed into delivery-uncertain response recovery, which is only
 * for a response lost after a write). The preflight is requeued under the
 * fence so a fencing-takeover still aborts cleanly.
 */
async function handlePreflightFailure(
  storage: EffectWorkerStorage,
  fence: () => FencingContext,
  group: EffectRouteGroup,
  report: MutableReport,
  prepareFences: (items: readonly ClaimedEffect[]) => Promise<boolean>,
  error: unknown,
): Promise<void> {
  if (!(await prepareFences(group.items))) return;
  // A provider-state/schema/route failure (explicit remote failure) cannot be
  // fixed by retrying, so it closes the effects through the terminal failure
  // path. A bounded transport refusal/timeout (delivery-uncertain) and any
  // unclassified error are safely requeued for the next pass.
  const terminal = isDispatchTransportError(error) && error.kind === "explicit_remote_failure";
  if (terminal) {
    const message = "Preflight read failed on provider state, schema, or route; the effect cannot be retried.";
    for (const item of group.items) {
      await completeFailure(
        storage,
        fence(),
        item,
        WORKER_ERROR_CODES.PROVIDER_SCHEMA_ERROR,
        presentValue(message),
        report,
      );
    }
    return;
  }
  const message = "Preflight read failed before any remote write; the effect will be retried.";
  for (const item of group.items) {
    if (await storage.retryClaimedEffect({
      ...fence(),
      effectId: item.pending.effect_id,
      claimToken: item.claimToken,
      lastErrorCode: WORKER_ERROR_CODES.PROVIDER_RETRYABLE_ERROR,
      lastErrorMessage: message,
    })) {
      report.deferred += 1;
      report.requeued += 1;
    }
  }
}
