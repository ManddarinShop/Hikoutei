/** Fast-append and unsupported-capability dispatch paths for the effect worker. */

import type { FencingContext } from "../../../../infrastructure/storage/sync/shared/writerLease.js";
import { LOOKUP_RESULT_KINDS, presentValue } from "../../../../shared/state/index.js";
import type {
  FastAppendRowsRequest,
  SyncEffectWorkerProvider,
} from "../../sheets/syncSheets.js";
import {
  SYNC_TIMING_OPERATION_KINDS,
  SYNC_TIMING_SCOPES,
} from "../../telemetry/syncTiming.js";
import { WORKER_ERROR_CODES } from "./SyncEffectWorkerConstants.js";
import {
  isPresent,
  lookupResult,
} from "./SyncEffectWorkerHelpers.js";
import {
  completeApplied,
  completeFailure,
  recoverUnknownResults,
} from "./SyncEffectWorkerTransitions.js";
import {
  emitProviderTiming,
  emitWorkerTiming,
} from "./SyncEffectWorkerTiming.js";
import { routeKey } from "./SyncEffectWorkerRouting.js";
import {
  classifyTransportOutcome,
  TRANSPORT_OUTCOME_KINDS,
  type TransportOutcome,
} from "../../sheets/transportOutcome.js";
import type {
  ClaimedEffect,
  EffectWorkerStorage,
  MutableReport,
  SyncEffectWorkerBaseOptions,
} from "./SyncEffectWorker.js";

/** Fails regular effects explicitly when the configured provider is fast-only. */
export async function rejectUnsupportedProviderEffects(
  storage: EffectWorkerStorage,
  fence: FencingContext,
  items: readonly ClaimedEffect[],
  report: MutableReport,
): Promise<void> {
  for (const item of items) {
    if (item.pending.status === "delivery_uncertain") {
      await markUncertainWithoutRecovery(
        storage,
        fence,
        [item],
        report,
        "The configured provider cannot probe an uncertain delivery yet.",
      );
      continue;
    }
    if (!isPresent(item.providerEffect)) {
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
      WORKER_ERROR_CODES.PROVIDER_CAPABILITY_MISSING,
      presentValue(
        "The configured provider supports fast append only; regular effect dispatch or recovery is unavailable.",
      ),
      report,
    );
  }
}

/**
 * Handles a failed remote dispatch at the transport boundary.
 *
 * A thrown batch-level dispatch error is not per-effect rejection evidence for
 * an uncertain transport. Explicit structured remote failures are different:
 * the provider has returned a verified rejection, so they close the effects in
 * the terminal failure path rather than entering recovery.
 */
export async function handleProviderDispatchError(
  options: SyncEffectWorkerBaseOptions,
  storage: EffectWorkerStorage,
  fence: FencingContext,
  items: readonly ClaimedEffect[],
  report: MutableReport,
  outcome: TransportOutcome,
  fullProvider?: SyncEffectWorkerProvider,
  beforeRecovery?: () => Promise<boolean>,
  onUncertainWithoutRecovery?: () => Promise<void>,
): Promise<void> {
  if (outcome.kind === TRANSPORT_OUTCOME_KINDS.EXPLICIT_REMOTE_FAILURE) {
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
  if (fullProvider === undefined) {
    if (onUncertainWithoutRecovery !== undefined) {
      await onUncertainWithoutRecovery();
      return;
    }
    await markUncertainWithoutRecovery(storage, fence, items, report, outcome.message);
    return;
  }
  if (beforeRecovery === undefined || await beforeRecovery()) {
    await recoverUnknownResults(
      { ...options, provider: fullProvider },
      storage,
      fence,
      items,
      report,
    );
  }
}

/**
 * Dispatches append-only rows through the idempotent provider batch operation.
 * A lost response is still returned to recovery; the provider receipt batch lets
 * the next attempt classify an already committed write without appending again.
 *
 * When the full provider runtime configured the append throttle, the request
 * waits only the time remaining since the previous append request started;
 * regular applyEffects dispatch never waits on this throttle.
 */
export async function dispatchFastAppendGroup(
  options: SyncEffectWorkerBaseOptions,
  storage: EffectWorkerStorage,
  fence: FencingContext,
  group: {
    readonly request: FastAppendRowsRequest;
    readonly items: readonly ClaimedEffect[];
  },
  report: MutableReport,
  fullProvider?: SyncEffectWorkerProvider,
  beforeRecovery?: () => Promise<boolean>,
): Promise<void> {
  const throttleStartedAt = Date.now();
  const throttledMs = await options.batchController?.waitForAppendThrottle(throttleStartedAt) ?? 0;
  if (throttledMs > 0) {
    emitWorkerTiming(options, {
      scope: SYNC_TIMING_SCOPES.WORKER,
      phase: "append_throttle_wait",
      durationMs: Date.now() - throttleStartedAt,
      operationKinds: [SYNC_TIMING_OPERATION_KINDS.APPEND],
      operationCounts: { append: group.items.length, update: 0, delete: 0 },
    });
  }
  let response: Awaited<ReturnType<SyncEffectWorkerProvider["fastAppendRows"]>>;
  const providerStartedAt = Date.now();
  options.batchController?.beginAppendDispatch(providerStartedAt);
  const requestRouteKey = routeKey(group.request);
  const batchLimit = options.batchController?.beginDispatch(requestRouteKey, providerStartedAt) ?? group.items.length;
  try {
    response = await options.provider.fastAppendRows(group.request);
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
      phase: "append_provider_dispatch",
      durationMs: failedDurationMs,
      operationKinds: [SYNC_TIMING_OPERATION_KINDS.APPEND],
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
      outcome,
      fullProvider,
      beforeRecovery,
      () => markFastAppendUncertain(storage, resultFence, group.items, report, outcome.message),
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
    responseSucceeded: response.results.length === group.items.length && !response.hasMore,
    responseLoss: response.results.length !== group.items.length || response.hasMore,
  });
  emitProviderTiming(options, response.timing);
  emitWorkerTiming(options, {
    scope: SYNC_TIMING_SCOPES.WORKER,
    phase: "append_provider_dispatch",
    durationMs,
    operationKinds: [SYNC_TIMING_OPERATION_KINDS.APPEND],
    operationCounts: { append: group.items.length, update: 0, delete: 0 },
    routeKey: requestRouteKey,
    batchLimit,
    responseSucceeded: response.results.length === group.items.length && !response.hasMore,
  });

  const resultPersistenceStartedAt = Date.now();
  const byEffectId = new Map(response.results.map((result) => [result.effectId, result]));
  const deferredEffectIds = new Set<string>();
  const recoveryItems: ClaimedEffect[] = [];
  for (const item of group.items) {
    if (byEffectId.has(item.pending.effect_id) || !response.hasMore) continue;
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
      await requeueFastAppendItems(storage, resultFence, [item], report);
      continue;
    }
    if (!isPresent(item.providerEffect)) {
      await requeueFastAppendItems(storage, resultFence, [item], report);
      continue;
    }
    if (!hasReceiptBackedVisibleEvidence(result.value)) {
      // A fast-append status is not enough to close a worker-owned effect. The
      // append receipt must provide the remote visible revision and hash; do
      // not synthesize either value from local expectations or payload data.
      recoveryItems.push(item);
      continue;
    }
    await completeApplied(
      storage,
      resultFence,
      item,
      presentValue(result.value.visibleRevision),
      presentValue(result.value.visibleHash),
      report,
    );
  }
  if (recoveryItems.length > 0) {
    const recoveryFence = {
      ...resultFence,
      now: options.clock?.() ?? resultFence.now,
    };
    if (fullProvider !== undefined && (beforeRecovery === undefined || await beforeRecovery())) {
      await recoverUnknownResults(
        { ...options, provider: fullProvider },
        storage,
        recoveryFence,
        recoveryItems,
        report,
      );
    } else {
      await markFastAppendUncertain(
        storage,
        recoveryFence,
        recoveryItems,
        report,
        "Fast append did not return receipt-backed visible evidence.",
      );
    }
  }
  emitWorkerTiming(options, {
    scope: SYNC_TIMING_SCOPES.WORKER,
    phase: "append_result_persistence",
    durationMs: Date.now() - resultPersistenceStartedAt,
    operationKinds: [SYNC_TIMING_OPERATION_KINDS.APPEND],
    operationCounts: { append: group.items.length, update: 0, delete: 0 },
  });
}

function hasReceiptBackedVisibleEvidence(
  result: Awaited<ReturnType<SyncEffectWorkerProvider["fastAppendRows"]>>["results"][number],
): result is typeof result & { readonly visibleRevision: number; readonly visibleHash: string } {
  return typeof result.visibleRevision === "number" &&
    Number.isSafeInteger(result.visibleRevision) &&
    result.visibleRevision >= 1 &&
    typeof result.visibleHash === "string" &&
    result.visibleHash.length > 0;
}

/** Returns a response-lost fast append to pending for reconciliation-backed retry. */
async function markFastAppendUncertain(
  storage: EffectWorkerStorage,
  fence: FencingContext,
  items: readonly ClaimedEffect[],
  report: MutableReport,
  message: string,
): Promise<void> {
  await markUncertainWithoutRecovery(storage, fence, items, report, message);
}

async function markUncertainWithoutRecovery(
  storage: EffectWorkerStorage,
  fence: FencingContext,
  items: readonly ClaimedEffect[],
  report: MutableReport,
  message: string,
): Promise<void> {
  for (const item of items) {
    if (await storage.markDeliveryUncertain({
      ...fence,
      effectId: item.pending.effect_id,
      claimToken: item.claimToken,
      uncertainSince: item.pending.uncertain_since ?? fence.now,
      nextProbeAt: fence.now + 1_000,
      lastErrorCode: WORKER_ERROR_CODES.DELIVERY_UNCERTAIN_REQUIRES_PROBE,
      lastErrorMessage: message,
    })) report.deferred += 1;
  }
}

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
