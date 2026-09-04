/** Durable result transitions for dispatcher outcomes and response-loss recovery. */

import { EFFECT_KINDS } from "../../contract/constants.js";
import type { ClaimedEffect } from "../contracts.js";
import type { PendingEffect } from "../../contract/contracts.js";
import type {
  ApplyEffectResult,
  EffectLeaseRenewal,
  Postcondition,
  PostconditionResult,
  RepairReplanRequest,
} from "../dispatcher.js";
import type { EffectWorkerBaseOptions } from "../options.js";
import type { MutableReport } from "../report.js";
import type { EffectWorkerStorage } from "../storage.js";
import type {
  FencingContext,
  NewEffect,
} from "../../index.js";
import type { Presence } from "../../contract/state.js";
import {
  LOOKUP_RESULT_KINDS,
} from "../../contract/state.js";
import {
  OUTBOX_EFFECT_STATUSES,
  WORKER_ERROR_CODES,
  type WorkerErrorCode,
} from "../constants.js";
import {
  absentValue,
  applicabilityFromSqlNullable,
  isAbsent,
  isPresent,
  lookupResult,
  presentValue,
  safeErrorMessage,
} from "../helpers.js";
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
 * Maximum continuous delivery uncertainty before a response-loss probe is
 * force-settled as failed. Bounds the recovery loop so a permanently
 * unverifiable effect (for example a corrupted target sheet) cannot stay
 * `delivery_uncertain` forever and keep the in-flight predecessor guard
 * (`READ_PROCESSING_PREDECESSOR_SQL`) blocking later writes on its stream.
 */
const DURABLE_PROBE_MAX_UNCERTAIN_MS = 30_000;

/**
 * Recovers response-loss effects by reading their remote postconditions.
 *
 * The dispatcher classifies each read-back result; every effect is settled
 * from durable evidence only, never from the lost response. When supplied,
 * `renewEffectLeases` is attached to the probe request so the host renews
 * the effect leases inside its acquired-lane `beforeRemoteDispatch` hook
 * immediately before the probe's remote read.
 */
export async function recoverUnknownResults(
  options: EffectWorkerBaseOptions,
  storage: EffectWorkerStorage,
  fence: FencingContext,
  items: readonly ClaimedEffect[],
  report: MutableReport,
  renewEffectLeases?: EffectLeaseRenewal,
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
      const renewGroupLeases = renewEffectLeases;
      const outcome = await options.dispatcher.readPostconditions({
        routeKey: group.routeKey,
        effects: group.items.map((item) => item.pending),
        ...(renewGroupLeases === undefined ? {} : {
          beforeRemoteDispatch: () => renewGroupLeases(group.items),
        }),
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
    await settleProbeResultsForItems(options, storage, liveFence, group.items, byEffectId, report);
  }
}

/**
 * Settles claimed items from the standalone probe's result set.
 *
 * A missing or payload-hash-mismatched entry is a provider contract gap: the
 * probe RAN but returned no durable evidence for that effect, so the item is
 * deferred (`deferDeliveryUncertain`), never blindly redriven. Every present
 * entry settles through `settleUnknownPostcondition`. The absorbed path uses
 * its own uncovered-entry fallback (`settleAbsorbedProbeResults`).
 */
async function settleProbeResultsForItems(
  options: EffectWorkerBaseOptions,
  storage: EffectWorkerStorage,
  fence: () => FencingContext,
  items: readonly ClaimedEffect[],
  byEffectId: ReadonlyMap<string, PostconditionResult>,
  report: MutableReport,
): Promise<void> {
  for (const item of items) {
    const result = lookupResult(byEffectId.get(item.pending.effect_id));
    if (
      result.kind === LOOKUP_RESULT_KINDS.NOT_FOUND ||
      result.value.payloadHash !== item.pending.payload_hash
    ) {
      await deferDeliveryUncertain(
        storage,
        fence(),
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
      fence(),
      item,
      result.value.postcondition,
      report,
    );
  }
}

/**
 * Settles delivery-uncertain items from probe results carried by one batch
 * dispatch (`probeEffects` absorption, design §10.3).
 *
 * Returns the items that were NOT settled this call so the worker can run
 * them through the standalone `recoverUnknownResults` probe at the end of
 * the pass (D6 fail-closed): an absent, EMPTY, or PARTIAL result set means
 * the dispatcher did not absorb every probe (older/fake dispatcher, provider
 * route mismatch, or an envelope that simply omitted an effect), and each
 * uncovered item keeps the standalone fallback — a missing entry is never
 * deferred as a contract gap here because absorption may simply not have
 * covered it. Only items whose entry is present AND payload-hash matched
 * settle, through the unchanged `settleUnknownPostcondition` transitions
 * (D2: absorption changes the read source, never the rules). Transitions
 * are CAS-fenced exactly like the standalone path: a lost race requeues,
 * it does not double-settle.
 */
export async function settleAbsorbedProbeResults(
  options: EffectWorkerBaseOptions,
  storage: EffectWorkerStorage,
  fence: () => FencingContext,
  items: readonly ClaimedEffect[],
  results: readonly PostconditionResult[] | undefined,
  report: MutableReport,
): Promise<readonly ClaimedEffect[]> {
  if (items.length === 0) return [];
  const byEffectId = new Map((results ?? []).map((result) => [result.effectId, result]));
  const residual: ClaimedEffect[] = [];
  for (const item of items) {
    const result = lookupResult(byEffectId.get(item.pending.effect_id));
    if (
      result.kind === LOOKUP_RESULT_KINDS.NOT_FOUND ||
      result.value.payloadHash !== item.pending.payload_hash
    ) {
      // Uncovered (missing entry or stale payload hash): fall back to the
      // standalone probe instead of settling or deferring on partial evidence.
      residual.push(item);
      continue;
    }
    await settleUnknownPostcondition(
      options,
      storage,
      fence(),
      item,
      result.value.postcondition,
      report,
    );
  }
  return residual;
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
    // The read-back proved the remote did not apply this effect, so it is
    // returned to `pending` for a fresh dispatch (re-drive) rather than kept
    // uncertain. This path is intentionally not bounded by
    // `DURABLE_PROBE_MAX_UNCERTAIN_MS`: `retryClaimedEffect` resets
    // `uncertain_since` to NULL, so the uncertainty clock does not persist
    // across the re-queue, and `created_at` measures total enqueue age (not
    // uncertainty) and would risk force-failing legitimate backlogged
    // effects. The unbounded delivery_uncertain loop from #193 is closed by
    // the bound in `deferDeliveryUncertain`, which every defer path reaches.
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
  const uncertainSince = item.pending.uncertain_since ?? fence.now;
  const uncertainForMs = fence.now - uncertainSince;
  if (uncertainForMs >= DURABLE_PROBE_MAX_UNCERTAIN_MS) {
    // The remote write stayed unverifiable past the durable probe bound:
    // force-settle as failed so the in-flight predecessor guard stops
    // blocking later writes on this target stream. The durable outbox keeps
    // the failed effect together with its timeout evidence.
    await completeFailure(
      storage,
      fence,
      item,
      WORKER_ERROR_CODES.DELIVERY_UNCERTAIN_TIMEOUT,
      presentValue(
        "delivery_uncertain exceeded the durable probe bound; force-settled as failed.",
      ),
      report,
    );
    return;
  }
  const marked = await storage.markDeliveryUncertain({
    ...fence,
    effectId: item.pending.effect_id,
    claimToken: item.claimToken,
    uncertainSince,
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
      // A create-if-missing repair restarts the provider's revision counter
      // at 1, so its confirmation may advance a higher durable confirmed
      // revision instead of being rejected as a regression (which would
      // wedge the applied effect in delivery_uncertain forever).
      ...(isCreateIfMissingBaseline(item.pending)
        ? { allowCreateRebaseline: true }
        : {}),
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

/**
 * True when the pending effect applied from an empty visible baseline.
 *
 * Only create-if-missing repairs carry revision 0 with an empty visible
 * hash (the kernel forbids an empty hash at any other revision, and the
 * provider only creates rows from that baseline), so only those effects may
 * produce a receipt revision below a binding's confirmed revision without
 * being stale evidence.
 */
function isCreateIfMissingBaseline(pending: PendingEffect): boolean {
  return pending.expected_visible_revision === 0 && pending.expected_visible_hash === "";
}

function isPresentInvalidPayload(item: ClaimedEffect): boolean {
  return isPresent(item.invalidPayloadError);
}
