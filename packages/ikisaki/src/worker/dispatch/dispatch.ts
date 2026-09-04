/** Fast-append dispatch and transport-failure handling for the effect worker. */

import type { ClaimedEffect } from "../contracts.js";
import type { EffectLeaseRenewal, FastAppendOutcome } from "../dispatcher.js";
import type { EffectWorkerBaseOptions } from "../options.js";
import type { MutableReport } from "../report.js";
import type { EffectWorkerStorage } from "../storage.js";
import type { FencingContext } from "../../index.js";
import {
  LOOKUP_RESULT_KINDS,
} from "../../contract/state.js";
import {
  TIMING_OPERATION_KINDS,
  TIMING_SCOPES,
} from "../pacing/timing.js";
import { WORKER_ERROR_CODES } from "../constants.js";
import {
  isDispatchTransportError,
} from "../errors.js";
import {
  isPresent,
  lookupResult,
  presentValue,
  safeErrorMessage,
} from "../helpers.js";
import {
  completeApplied,
  completeFailure,
  recoverUnknownResults,
  settleAbsorbedProbeResults,
} from "./transitions.js";
import {
  emitProviderTiming,
  emitWorkerTiming,
} from "../pacing/timing.js";

/**
 * Handles a failed remote dispatch at the transport boundary.
 *
 * A thrown batch-level dispatch error is not per-effect rejection evidence
 * for an uncertain transport. Explicit structured remote failures are
 * different: the dispatcher has returned a verified rejection, so they close
 * the effects in the terminal failure path rather than entering recovery.
 */
export async function handleProviderDispatchError(
  options: EffectWorkerBaseOptions,
  storage: EffectWorkerStorage,
  fence: FencingContext,
  items: readonly ClaimedEffect[],
  report: MutableReport,
  error: unknown,
  beforeRecovery?: () => Promise<boolean>,
  renewEffectLeases?: EffectLeaseRenewal,
): Promise<void> {
  const outcome = isDispatchTransportError(error)
    ? error
    : { kind: "delivery_uncertain" as const, message: safeErrorMessage(error) };
  if (outcome.kind === "explicit_remote_failure") {
    for (const item of items) {
      await completeFailure(
        storage,
        fence,
        item,
        WORKER_ERROR_CODES.PROVIDER_REMOTE_ERROR,
        presentValue(outcome.message),
        report,
      );
    }
    return;
  }
  if (beforeRecovery === undefined || await beforeRecovery()) {
    await recoverUnknownResults(options, storage, fence, items, report, renewEffectLeases);
  }
}

/**
 * Delivery-uncertain recovery effects attached to one dispatch unit so their
 * probe reads are absorbed into the unit's own batch reads (Phase 4, design
 * §10.3). `consumed` is set once the unit's dispatch ran the settle attempt
 * (success or failure); an unconsumed attachment's items are requeued to the
 * standalone end-of-pass probe by the worker.
 */
export interface UnitProbeAttachment {
  readonly items: readonly ClaimedEffect[];
  consumed: boolean;
}

/**
 * Dispatches append-only rows through the idempotent dispatcher batch
 * operation. A lost response is still returned to recovery; the provider
 * receipt batch lets the next attempt classify an already committed write
 * without appending again.
 *
 * When supplied, `probes` carries the same-route recovery effects absorbed
 * into this append's provider call; their classifications settle through the
 * unchanged transitions, and any item the dispatcher did not settle is
 * pushed to `probeResidual` for the worker's standalone probe fallback.
 *
 * When the append throttle is configured, the request waits only the time
 * remaining since the previous append request started; regular apply dispatch
 * never waits on this throttle.
 */
export async function dispatchFastAppendGroup(
  options: EffectWorkerBaseOptions,
  storage: EffectWorkerStorage,
  fence: FencingContext,
  group: {
    readonly routeKey: string;
    readonly items: readonly ClaimedEffect[];
  },
  report: MutableReport,
  beforeRecovery?: () => Promise<boolean>,
  renewEffectLeases?: EffectLeaseRenewal,
  probes?: UnitProbeAttachment,
  probeResidual?: ClaimedEffect[],
): Promise<void> {
  const throttleStartedAt = Date.now();
  const throttledMs = await options.batchController?.waitForAppendThrottle(throttleStartedAt) ?? 0;
  if (throttledMs > 0) {
    emitWorkerTiming(options, {
      scope: TIMING_SCOPES.WORKER,
      phase: "append_throttle_wait",
      durationMs: Date.now() - throttleStartedAt,
      operationKinds: [TIMING_OPERATION_KINDS.APPEND],
      operationCounts: { append: group.items.length, update: 0, delete: 0 },
    });
  }
  let outcome: FastAppendOutcome;
  const providerStartedAt = Date.now();
  options.batchController?.beginAppendDispatch(providerStartedAt);
  const requestRouteKey = group.routeKey;
  const batchLimit = options.batchController?.beginDispatch(requestRouteKey, providerStartedAt)
    ?? group.items.length;
  const probeItems = probes?.items ?? [];
  try {
    const renewGroupLeases = renewEffectLeases;
    outcome = await options.dispatcher.fastAppend({
      routeKey: requestRouteKey,
      effects: group.items.map((item) => item.pending),
      ...(probeItems.length === 0 ? {} : { probeEffects: probeItems.map((item) => item.pending) }),
      ...(renewGroupLeases === undefined ? {} : {
        // The absorbed probe leases renew with the batch so a long lane wait
        // cannot expire a claimed head mid-pass; a failed renewal aborts the
        // whole dispatch (the probes then fall back to the standalone pass).
        beforeRemoteDispatch: () => renewGroupLeases([...group.items, ...probeItems]),
      }),
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
      phase: "append_provider_dispatch",
      durationMs: failedDurationMs,
      operationKinds: [TIMING_OPERATION_KINDS.APPEND],
      operationCounts: { append: group.items.length, update: 0, delete: 0 },
      routeKey: requestRouteKey,
      batchLimit,
      responseSucceeded: false,
      requestedEffects: group.items.length,
    });
    const resultFence = {
      ...fence,
      now: options.clock?.() ?? fence.now + Math.max(0, Date.now() - providerStartedAt),
    };
    // The append never returned a result envelope, so no probe was settled:
    // hand the absorbed items back for the standalone end-of-pass probe. A
    // caller without a residual sink leaves them claimed; the durable lease
    // sweep recovers them exactly like any aborted pass (fail-closed).
    if (probes !== undefined && !probes.consumed && probeItems.length > 0) {
      probes.consumed = true;
      probeResidual?.push(...probeItems);
    }
    await handleProviderDispatchError(
      options,
      storage,
      resultFence,
      group.items,
      report,
      error,
      beforeRecovery,
      renewEffectLeases,
    );
    return;
  }
  const durationMs = Date.now() - providerStartedAt;
  const resultFence = {
    ...fence,
    now: options.clock?.() ?? fence.now + Math.max(0, Date.now() - providerStartedAt),
  };
  // A hasMore=true reply with a valid returned prefix is a healthy partial
  // application whose suffix is deferred to the next pass (the provider
  // stopped at its body budget), so it must not back the route off. Only a
  // hasMore=false reply that is missing results (a lost response) keeps the
  // delivery-uncertain recovery backoff.
  const fastAppendHealthy =
    (outcome.results.length === group.items.length && !outcome.hasMore) ||
    (outcome.hasMore && outcome.results.length > 0);
  options.batchController?.observe(requestRouteKey, {
    durationMs,
    responseSucceeded: fastAppendHealthy,
    responseLoss: !outcome.hasMore && outcome.results.length !== group.items.length,
  });
  emitProviderTiming(options, outcome.timing);
  // Settle the absorbed same-route probes from this append's own reads
  // BEFORE persisting the append's results: the verdicts came from the
  // pre-write evidence and settle through the unchanged fenced transitions.
  if (probes !== undefined && !probes.consumed && probeItems.length > 0) {
    probes.consumed = true;
    const unsettled = await settleAbsorbedProbeResults(
      options,
      storage,
      () => resultFence,
      probeItems,
      outcome.probeResults,
      report,
    );
    probeResidual?.push(...unsettled);
  }
  emitWorkerTiming(options, {
    scope: TIMING_SCOPES.WORKER,
    phase: "append_provider_dispatch",
    durationMs,
    operationKinds: [TIMING_OPERATION_KINDS.APPEND],
    operationCounts: { append: group.items.length, update: 0, delete: 0 },
    routeKey: requestRouteKey,
    batchLimit,
    responseSucceeded: fastAppendHealthy,
    hasMore: outcome.hasMore,
    requestedEffects: group.items.length,
    acknowledgedEffects: outcome.results.length,
  });

  const resultPersistenceStartedAt = Date.now();
  const byEffectId = new Map(outcome.results.map((result) => [result.effectId, result]));
  const deferredEffectIds = new Set<string>();
  const recoveryItems: ClaimedEffect[] = [];
  for (const item of group.items) {
    // A suffix the provider intentionally deferred (`hasMore: true`) is
    // released for the next pass; `hasMore: false` means the envelope is
    // complete, so every expected effect id must appear in the results.
    if (byEffectId.has(item.pending.effect_id) || !outcome.hasMore) continue;
    if (await storage.releaseUnprocessedEffect({
      ...resultFence,
      effectId: item.pending.effect_id,
      claimToken: item.claimToken,
      reason: "provider_batch",
    })) {
      deferredEffectIds.add(item.pending.effect_id);
      report.deferred += 1;
    }
  }

  for (const item of group.items) {
    if (deferredEffectIds.has(item.pending.effect_id)) continue;
    const result = lookupResult(byEffectId.get(item.pending.effect_id));
    if (result.kind === LOOKUP_RESULT_KINDS.NOT_FOUND) {
      // A `hasMore: false` response missing an expected effect id is a
      // malformed or partial provider envelope, never proof the row was not
      // applied. Requeuing would redrive the append without receipt or
      // postcondition evidence; route the item through delivery-uncertain
      // recovery so the pass probes receipts and settles from durable
      // remote evidence instead.
      recoveryItems.push(item);
      continue;
    }
    if (isPresent(item.invalidPayloadError)) {
      await requeueFastAppendItems(storage, resultFence, [item], report);
      continue;
    }
    if (result.value.status === "delivery_uncertain") {
      // A fast-append status is not enough to close a worker-owned effect.
      // The append receipt must provide the remote visible revision and hash;
      // the dispatcher never synthesizes either value from local expectations.
      recoveryItems.push(item);
      continue;
    }
    if (result.value.status === "applied_target_mismatch") {
      await completeFailure(
        storage,
        resultFence,
        item,
        WORKER_ERROR_CODES.POSTCONDITION_READ_FAILED,
        presentValue("Provider postcondition visible hash does not match the effect target."),
        report,
      );
      continue;
    }
    await completeApplied(
      storage,
      resultFence,
      item,
      result.value.visibleRevision,
      result.value.visibleHash,
      result.value.fieldHashes,
      report,
    );
  }
  if (recoveryItems.length > 0) {
    const recoveryFence = {
      ...resultFence,
      now: options.clock?.() ?? resultFence.now,
    };
    if (beforeRecovery === undefined || await beforeRecovery()) {
      await recoverUnknownResults(
        options,
        storage,
        recoveryFence,
        recoveryItems,
        report,
        renewEffectLeases,
      );
    }
  }
  emitWorkerTiming(options, {
    scope: TIMING_SCOPES.WORKER,
    phase: "append_result_persistence",
    durationMs: Date.now() - resultPersistenceStartedAt,
    operationKinds: [TIMING_OPERATION_KINDS.APPEND],
    operationCounts: { append: group.items.length, update: 0, delete: 0 },
  });
}

/** Returns a response-lost fast append to pending for reconciliation-backed retry. */
export async function requeueFastAppendItems(
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
      lastErrorCode: WORKER_ERROR_CODES.PROVIDER_RETRYABLE_ERROR,
      lastErrorMessage: "Fast append response was not observed; the row will be retried and reconciled later.",
    })) {
      report.deferred += 1;
      report.requeued += 1;
    }
  }
}
