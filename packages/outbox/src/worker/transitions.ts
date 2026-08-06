/** Durable result transitions for dispatcher outcomes and response-loss recovery. */

import { EFFECT_KINDS } from "../constants.js";
import type { ClaimedEffect } from "./contracts.js";
import type {
  ApplyEffectResult,
  Postcondition,
  PostconditionResult,
  RepairReplanRequest,
} from "./dispatcher.js";
import type { EffectWorkerBaseOptions } from "./options.js";
import type { MutableReport } from "./report.js";
import type { EffectWorkerStorage } from "./storage.js";
import type {
  FencingContext,
  NewEffect,
} from "../index.js";
import type { Presence } from "../state.js";
import {
  LOOKUP_RESULT_KINDS,
} from "../state.js";
import {
  OUTBOX_EFFECT_STATUSES,
  WORKER_ERROR_CODES,
  type WorkerErrorCode,
} from "./constants.js";
import {
  absentValue,
  applicabilityFromSqlNullable,
  isAbsent,
  isPresent,
  lookupResult,
  presentValue,
  safeErrorMessage,
} from "./helpers.js";
import {
  isCandidateProtectingUserInputEffect,
} from "./routing.js";

/**
 * Persists one dispatcher per-effect result.
 *
 * `applied`/`already_applied` results were already verified by the dispatcher
 * against the effect target; `delivery_uncertain` results never reach this
 * function (the pass probes them first).
 */
export async function completeProviderResult(
  options: EffectWorkerBaseOptions,
  storage: EffectWorkerStorage,
  fence: FencingContext,
  item: ClaimedEffect,
  result: ApplyEffectResult,
  report: MutableReport,
): Promise<void> {
  if (
    result.status === "applied" ||
    result.status === "already_applied"
  ) {
    await completeApplied(
      storage,
      fence,
      item,
      result.visibleRevision,
      result.visibleHash,
      result.fieldHashes,
      report,
    );
    return;
  }
  if (result.status === "superseded") {
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
  if (result.status === "guard_mismatch") {
    const blocked = isCandidateProtectingUserInputEffect(item.pending);
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
  if (result.status === "repair_reobserve") {
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
    result.status === "schema_error"
      ? WORKER_ERROR_CODES.PROVIDER_SCHEMA_ERROR
      : WORKER_ERROR_CODES.PROVIDER_RETRYABLE_ERROR,
    result.reason,
    report,
  );
}

const DURABLE_PROBE_RETRY_DELAY_MS = 1_000;

/**
 * Recovers response-loss effects by reading their remote postconditions.
 *
 * The dispatcher classifies each read-back result; every effect is settled
 * from durable evidence only, never from the lost response.
 */
export async function recoverUnknownResults(
  options: EffectWorkerBaseOptions,
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
    if (isAbsentInvalidPayload(item)) {
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
  let groups: readonly { readonly routeKey: string; readonly items: readonly ClaimedEffect[] }[];
  try {
    groups = groupByRoute(usable, options);
  } catch (error: unknown) {
    // The route predicate is declared never to throw, but a violating
    // dispatcher must not abort the pass: fail the affected recovery items
    // per-effect and skip the probe instead.
    await failUnclassifiableItems(
      storage,
      liveFence(),
      usable,
      "Dispatcher route classification threw: " + safeErrorMessage(error),
      report,
    );
    return;
  }
  for (const group of groups) {
    let results: readonly PostconditionResult[];
    try {
      const outcome = await options.dispatcher.readPostconditions({
        routeKey: group.routeKey,
        effects: group.items.map((item) => item.pending),
      });
      results = outcome.results;
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

/** Settles one response-loss effect from its classified read-back outcome. */
export async function settleUnknownPostcondition(
  options: EffectWorkerBaseOptions,
  storage: EffectWorkerStorage,
  fence: FencingContext,
  item: ClaimedEffect,
  postcondition: Postcondition,
  report: MutableReport,
): Promise<void> {
  if (isPresentInvalidPayload(item)) {
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
  if (postcondition.disposition === "applied") {
    if (await completeApplied(
      storage,
      fence,
      item,
      postcondition.visibleRevision,
      postcondition.visibleHash,
      postcondition.fieldHashes,
      report,
    )) {
      report.responseLossRecovered += 1;
    }
    return;
  }
  if (postcondition.disposition === "applied_target_mismatch") {
    await completeFailure(
      storage,
      fence,
      item,
      WORKER_ERROR_CODES.POSTCONDITION_READ_FAILED,
      presentValue("Provider postcondition visible hash does not match the effect target."),
      report,
    );
    return;
  }
  if (postcondition.disposition === "applied_without_visible_state") {
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
  if (postcondition.disposition === "changed") {
    if (item.pending.effect_kind === EFFECT_KINDS.SYSTEM_REPAIR) {
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
    await completeFailure(
      storage,
      fence,
      item,
      WORKER_ERROR_CODES.POSTCONDITION_CHANGED,
      presentValue(
        "Provider response was not observed; postcondition=changed" +
          (postcondition.reason === undefined ? "" : ", reason=" + postcondition.reason),
      ),
      report,
    );
    return;
  }
  if (postcondition.disposition === "unapplied") {
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
  await deferDeliveryUncertain(
    storage,
    fence,
    item,
    WORKER_ERROR_CODES.POSTCONDITION_UNAVAILABLE,
    "Provider response was not observed; postcondition=unavailable" +
      (postcondition.reason === undefined ? "" : ", reason=" + postcondition.reason),
    report,
  );
}

async function deferDeliveryUncertain(
  storage: EffectWorkerStorage,
  fence: FencingContext,
  item: ClaimedEffect,
  code: WorkerErrorCode,
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

/**
 * Persists a verified applied result, including confirmed projection state
 * when the effect carries a row binding.
 */
export async function completeApplied(
  storage: EffectWorkerStorage,
  fence: FencingContext,
  item: ClaimedEffect,
  visibleRevision: number,
  visibleHash: string,
  fieldHashes: Readonly<Record<string, string>>,
  report: MutableReport,
): Promise<boolean> {
  if (isPresentInvalidPayload(item)) {
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
  const rowBindingId = item.pending.row_binding_id;
  const confirmation = rowBindingId === null
    ? undefined
    : {
      physicalSheetId: item.pending.physical_sheet_id,
      projection: item.pending.projection,
      rowBindingId,
      visibleRevision,
      visibleHash,
      entityRevision: applicabilityFromSqlNullable(item.pending.target_entity_revision),
      fieldHashes,
    };
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
  options: EffectWorkerBaseOptions,
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
  code: WorkerErrorCode,
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

/**
 * Fails claimed items whose dispatcher payload-classification predicate threw.
 *
 * A throwing route-key/candidacy predicate is treated like an invalid
 * payload: each affected effect is closed per-effect through the terminal
 * failure path so the pass continues instead of aborting into supervisor
 * backoff. Only contract-violating dispatchers trigger this path; compliant
 * dispatchers never do.
 */
export async function failUnclassifiableItems(
  storage: EffectWorkerStorage,
  fence: FencingContext,
  items: readonly ClaimedEffect[],
  message: string,
  report: MutableReport,
): Promise<void> {
  for (const item of items) {
    await completeFailure(
      storage,
      fence,
      item,
      WORKER_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
      presentValue(message),
      report,
    );
  }
}

/** Groups usable recovery items by their dispatcher-declared route. */
function groupByRoute(
  items: readonly ClaimedEffect[],
  options: EffectWorkerBaseOptions,
): readonly { readonly routeKey: string; readonly items: readonly ClaimedEffect[] }[] {
  const groups = new Map<string, ClaimedEffect[]>();
  for (const item of items) {
    const key = options.dispatcher.routeKeyFor(item.pending);
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, [item]);
    } else {
      existing.push(item);
    }
  }
  return [...groups.entries()].map(([routeKey, grouped]) => ({ routeKey, items: grouped }));
}

function isAbsentInvalidPayload(item: ClaimedEffect): boolean {
  return isAbsent(item.invalidPayloadError);
}

function isPresentInvalidPayload(item: ClaimedEffect): boolean {
  return isPresent(item.invalidPayloadError);
}
