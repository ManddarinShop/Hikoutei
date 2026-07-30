/** Fast-append and unsupported-capability dispatch paths for the effect worker. */

import type { FencingContext } from "../../../../infrastructure/storage/sync/shared/writerLease.js";
import { LOOKUP_RESULT_KINDS } from "../../../../shared/state/constants.js";
import type {
  FastAppendRowsRequest,
  SyncEffectWorkerGateway,
} from "../../gateway/syncGateway.js";
import {
  SYNC_TIMING_OPERATION_KINDS,
  SYNC_TIMING_SCOPES,
} from "../../telemetry/syncTiming.js";
import { WORKER_ERROR_CODES } from "./SyncEffectWorkerConstants.js";
import {
  isPresent,
  lookupResult,
  presentValue,
} from "./SyncEffectWorkerHelpers.js";
import {
  completeApplied,
  completeFailure,
} from "./SyncEffectWorkerTransitions.js";
import {
  emitGatewayTiming,
  emitWorkerTiming,
} from "./SyncEffectWorkerTiming.js";
import type {
  ClaimedEffect,
  EffectWorkerStorage,
  MutableReport,
  SyncEffectWorkerBaseOptions,
} from "./SyncEffectWorkerContracts.js";

/** Fails regular effects explicitly when the configured gateway is fast-only. */
export async function rejectUnsupportedGatewayEffects(
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
export async function dispatchFastAppendGroup(
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
      lastErrorCode: WORKER_ERROR_CODES.GATEWAY_RETRYABLE_ERROR,
      lastErrorMessage: "Fast append response was not observed; the row will be retried and reconciled later.",
    })) {
      report.deferred += 1;
      report.requeued += 1;
    }
  }
}
