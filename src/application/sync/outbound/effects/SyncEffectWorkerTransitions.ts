/** Durable result transitions for provider responses and response-loss recovery. */

import { stableHash } from "../../../../domain/index.js";
import type { NewEffect } from "../../../../infrastructure/storage/index.js";
import type { FencingContext } from "../../../../infrastructure/storage/sync/shared/writerLease.js";
import {
  LOOKUP_RESULT_KINDS,
} from "../../../../shared/state/constants.js";
import type { Presence } from "../../../../shared/state/types.js";
import {
  SYNC_EFFECT_RESULT_STATUSES,
  SYNC_POSTCONDITION_DISPOSITIONS,
} from "../../sheets/constants.js";
import type {
  SyncEffectPostcondition,
  SyncEffectResult,
} from "../../sheets/syncSheets.js";
import {
  OUTBOX_EFFECT_STATUSES,
  SYNC_EFFECT_KINDS,
  WORKER_ERROR_CODES,
  type SyncEffectWorkerErrorCode,
} from "./SyncEffectWorkerConstants.js";
import { absentValue, presentValue } from "../../../../shared/state/index.js";
import {
  applicabilityFromSqlNullable,
  isPresent,
  lookupResult,
  safeErrorMessage,
} from "./SyncEffectWorkerHelpers.js";
import {
  groupByPostconditionRequest,
  isCandidateProtectingUserInputEffect,
} from "./SyncEffectWorkerRouting.js";
import type {
  ClaimedEffect,
  EffectWorkerStorage,
  MutableReport,
  RepairReplanRequest,
  SyncEffectWorkerBaseOptions,
  SyncEffectWorkerFullOptions,
} from "./SyncEffectWorker.js";

export async function completeProviderResult(
  options: SyncEffectWorkerBaseOptions,
  storage: EffectWorkerStorage,
  fence: FencingContext,
  item: ClaimedEffect,
  result: SyncEffectResult,
  report: MutableReport,
): Promise<void> {
  if (
    result.status === SYNC_EFFECT_RESULT_STATUSES.APPLIED ||
    result.status === SYNC_EFFECT_RESULT_STATUSES.ALREADY_APPLIED
  ) {
    if (!isPresent(result.visibleRevision) || !isPresent(result.visibleHash)) {
      await deferDeliveryUncertain(
        storage,
        fence,
        item,
        WORKER_ERROR_CODES.POSTCONDITION_APPLIED_WITHOUT_VISIBLE_STATE,
        "Provider applied result did not include receipt-backed visible evidence.",
        report,
      );
      return;
    }
    await completeApplied(storage, fence, item, result.visibleRevision, result.visibleHash, report);
    return;
  }
  if (result.status === SYNC_EFFECT_RESULT_STATUSES.SUPERSEDED) {
    if (await storage.applyEffectResult({
      ...fence,
      effectId: item.pending.effect_id,
      claimToken: item.claimToken,
      status: OUTBOX_EFFECT_STATUSES.SUPERSEDED,
      lastErrorCode: presentValue(WORKER_ERROR_CODES.PROVIDER_SUPERSEDED),
      lastErrorMessage: result.reason,
    })) report.superseded += 1;
    return;
  }
  if (result.status === SYNC_EFFECT_RESULT_STATUSES.GUARD_MISMATCH) {
    const blocked = isPresent(item.providerEffect) &&
      isCandidateProtectingUserInputEffect(item.providerEffect.value);
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
  if (result.status === SYNC_EFFECT_RESULT_STATUSES.REPAIR_REOBSERVE) {
    await replanOrFail(
      options,
      storage,
      fence,
      item,
      {
        effect: item.pending,
        providerResult: presentValue(result),
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
    result.status === SYNC_EFFECT_RESULT_STATUSES.SCHEMA_ERROR
      ? WORKER_ERROR_CODES.PROVIDER_SCHEMA_ERROR
      : WORKER_ERROR_CODES.PROVIDER_RETRYABLE_ERROR,
    result.reason,
    report,
  );
}

const DURABLE_PROBE_RETRY_DELAY_MS = 1_000;

export async function recoverUnknownResults(
  options: SyncEffectWorkerFullOptions,
  storage: EffectWorkerStorage,
  fence: FencingContext,
  items: readonly ClaimedEffect[],
  report: MutableReport,
): Promise<void> {
  const liveFence = (): FencingContext => ({
    ...fence,
    now: options.clock?.() ?? fence.now,
  });
  const usable: ClaimedEffect[] = [];
  for (const item of items) {
    if (isPresent(item.providerEffect)) {
      usable.push(item);
      continue;
    }
    await completeFailure(
      storage,
      liveFence(),
      item,
      WORKER_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
      item.invalidPayloadError,
      report,
    );
  }
  for (const group of groupByPostconditionRequest(usable)) {
    let results: readonly {
      readonly effectId: string;
      readonly payloadHash: string;
      readonly postcondition: SyncEffectPostcondition;
    }[];
    try {
      results = await options.provider.readEffectPostconditions(group.request);
    } catch (error: unknown) {
      for (const item of group.items) {
        await deferDeliveryUncertain(
          storage,
          liveFence(),
          item,
          WORKER_ERROR_CODES.POSTCONDITION_READ_FAILED,
          safeErrorMessage(error),
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
        await deferDeliveryUncertain(
          storage,
          liveFence(),
          item,
          WORKER_ERROR_CODES.POSTCONDITION_READ_FAILED,
          "Provider postcondition batch did not return the expected effect evidence.",
          report,
        );
        continue;
      }
      await settleUnknownPostcondition(
        options,
        storage,
        liveFence(),
        item,
        result.value.postcondition,
        report,
      );
    }
  }
}

export async function settleUnknownPostcondition(
  options: SyncEffectWorkerBaseOptions,
  storage: EffectWorkerStorage,
  fence: FencingContext,
  item: ClaimedEffect,
  postcondition: SyncEffectPostcondition,
  report: MutableReport,
): Promise<void> {
  if (!isPresent(item.providerEffect)) {
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
    postcondition.disposition === SYNC_POSTCONDITION_DISPOSITIONS.APPLIED &&
    isPresent(postcondition.visibleRevision) &&
    isPresent(postcondition.visibleHash)
  ) {
    if (await completeApplied(
      storage,
      fence,
      item,
      postcondition.visibleRevision,
      postcondition.visibleHash,
      report,
    )) {
      report.responseLossRecovered += 1;
    }
    return;
  }
  if (postcondition.disposition === SYNC_POSTCONDITION_DISPOSITIONS.APPLIED) {
    await deferDeliveryUncertain(
      storage,
      fence,
      item,
      WORKER_ERROR_CODES.POSTCONDITION_APPLIED_WITHOUT_VISIBLE_STATE,
      "Provider claimed an applied postcondition without a verified visible revision and hash.",
      report,
    );
    return;
  }
  if (
    postcondition.disposition === SYNC_POSTCONDITION_DISPOSITIONS.CHANGED &&
    item.providerEffect.value.effectKind === SYNC_EFFECT_KINDS.SYSTEM_REPAIR
  ) {
    await replanOrFail(
      options,
      storage,
      fence,
      item,
      {
        effect: item.pending,
        providerResult: absentValue(),
        postcondition: presentValue(postcondition),
      },
      report,
    );
    return;
  }
  if (postcondition.disposition === SYNC_POSTCONDITION_DISPOSITIONS.UNAPPLIED) {
    const requeued = await storage.retryClaimedEffect({
      ...fence,
      effectId: item.pending.effect_id,
      claimToken: item.claimToken,
      lastErrorCode: WORKER_ERROR_CODES.POSTCONDITION_UNAPPLIED_REQUIRES_REDRIVE,
      lastErrorMessage: "Provider did not expose the effect as applied; it was returned to pending.",
      nextAttemptAt: fence.now + DURABLE_PROBE_RETRY_DELAY_MS,
    });
    if (requeued) {
      report.deferred += 1;
      report.requeued += 1;
    }
    return;
  }
  if (postcondition.disposition === SYNC_POSTCONDITION_DISPOSITIONS.UNAVAILABLE) {
    await deferDeliveryUncertain(
      storage,
      fence,
      item,
      WORKER_ERROR_CODES.POSTCONDITION_UNAVAILABLE,
      "Provider response was not observed; postcondition=unavailable" +
        (postcondition.reason === undefined ? "" : ", reason=" + postcondition.reason),
      report,
    );
    return;
  }
  const code = postcondition.disposition === SYNC_POSTCONDITION_DISPOSITIONS.CHANGED
    ? WORKER_ERROR_CODES.POSTCONDITION_CHANGED
    : WORKER_ERROR_CODES.POSTCONDITION_UNAPPLIED_REQUIRES_REDRIVE;
  await completeFailure(
    storage,
    fence,
    item,
    code,
    presentValue(
      "Provider response was not observed; postcondition=" +
      postcondition.disposition +
      (postcondition.reason === undefined ? "" : ", reason=" + postcondition.reason),
    ),
    report,
  );
}

async function deferDeliveryUncertain(
  storage: EffectWorkerStorage,
  fence: FencingContext,
  item: ClaimedEffect,
  code: SyncEffectWorkerErrorCode,
  message: string,
  report: MutableReport,
): Promise<void> {
  const marked = await storage.markDeliveryUncertain({
    ...fence,
    effectId: item.pending.effect_id,
    claimToken: item.claimToken,
    uncertainSince: item.pending.uncertain_since ?? fence.now,
    nextProbeAt: fence.now + DURABLE_PROBE_RETRY_DELAY_MS,
    lastErrorCode: code,
    lastErrorMessage: message,
  });
  if (marked) report.deferred += 1;
}

export async function completeApplied(
  storage: EffectWorkerStorage,
  fence: FencingContext,
  item: ClaimedEffect,
  visibleRevision: Presence<number>,
  visibleHash: Presence<string>,
  report: MutableReport,
): Promise<boolean> {
  const providerEffect = item.providerEffect;
  if (!isPresent(providerEffect)) {
    await completeFailure(
      storage,
      fence,
      item,
      WORKER_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
      item.invalidPayloadError,
      report,
    );
    return false;
  }
  if (!isPresent(visibleRevision) || !isPresent(visibleHash)) {
    await deferDeliveryUncertain(
      storage,
      fence,
      item,
      WORKER_ERROR_CODES.POSTCONDITION_APPLIED_WITHOUT_VISIBLE_STATE,
      "Applied effect lacks receipt-backed visible revision and hash evidence.",
      report,
    );
    return false;
  }
  if (
    visibleHash.value !== providerEffect.value.payload.targetVisibleHash
  ) {
    await completeFailure(
      storage,
      fence,
      item,
      WORKER_ERROR_CODES.POSTCONDITION_READ_FAILED,
      presentValue("Provider postcondition visible hash does not match the effect target."),
      report,
    );
    return false;
  }
  const confirmation =
    isPresent(providerEffect) &&
    isPresent(providerEffect.value.rowBindingId) &&
    isPresent(visibleRevision) &&
    isPresent(visibleHash)
    ? {
      physicalSheetId: item.pending.physical_sheet_id,
      projection: item.pending.projection,
      rowBindingId: providerEffect.value.rowBindingId.value,
      visibleRevision: visibleRevision.value,
      visibleHash: visibleHash.value,
      entityRevision: applicabilityFromSqlNullable(item.pending.target_entity_revision),
      fieldHashes: Object.fromEntries(
        Object.entries(providerEffect.value.payload.fields)
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
  return applied;
}

export async function replanOrFail(
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

export async function completeFailure(
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
