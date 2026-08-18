/** Fast-append dispatch and transport-failure handling for the effect worker. */

import type { ClaimedEffect } from "./contracts.js";
import type { EffectLeaseRenewal, FastAppendOutcome } from "./dispatcher.js";
import type { EffectWorkerBaseOptions } from "./options.js";
import type { MutableReport } from "./report.js";
import type { EffectWorkerStorage } from "./storage.js";
import type { FencingContext } from "../index.js";
import {
  LOOKUP_RESULT_KINDS,
} from "../state.js";
import {
  TIMING_OPERATION_KINDS,
  TIMING_SCOPES,
} from "./timing.js";
import { WORKER_ERROR_CODES } from "./constants.js";
import {
  isDispatchTransportError,
} from "./errors.js";
import {
  isPresent,
  lookupResult,
  presentValue,
  safeErrorMessage,
} from "./helpers.js";
import {
  completeApplied,
  completeFailure,
  recoverUnknownResults,
} from "./transitions.js";
import {
  emitProviderTiming,
  emitWorkerTiming,
} from "./timing.js";

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
 * Dispatches append-only rows through the idempotent dispatcher batch
 * operation. A lost response is still returned to recovery; the provider
 * receipt batch lets the next attempt classify an already committed write
 * without appending again.
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
  try {
    const renewGroupLeases = renewEffectLeases;
    outcome = await options.dispatcher.fastAppend({
      routeKey: requestRouteKey,
      effects: group.items.map((item) => item.pending),
      ...(renewGroupLeases === undefined ? {} : {
        beforeRemoteDispatch: () => renewGroupLeases(group.items),
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
    });
    const resultFence = {
      ...fence,
      now: options.clock?.() ?? fence.now + Math.max(0, Date.now() - providerStartedAt),
    };
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
  options.batchController?.observe(requestRouteKey, {
    durationMs,
    responseSucceeded: outcome.results.length === group.items.length && !outcome.hasMore,
    responseLoss: outcome.results.length !== group.items.length || outcome.hasMore,
  });
  emitProviderTiming(options, outcome.timing);
  emitWorkerTiming(options, {
    scope: TIMING_SCOPES.WORKER,
    phase: "append_provider_dispatch",
    durationMs,
    operationKinds: [TIMING_OPERATION_KINDS.APPEND],
    operationCounts: { append: group.items.length, update: 0, delete: 0 },
    routeKey: requestRouteKey,
    batchLimit,
    responseSucceeded: outcome.results.length === group.items.length && !outcome.hasMore,
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
