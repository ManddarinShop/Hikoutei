/**
 * Receipt construction and result encoding for the effect planner.
 *
 * `makeReceipt` builds a receipt record exactly like the Apps Script
 * `makeReceipt_`; the encoders translate planned outcomes into provider
 * results exactly like the Apps Script `result_` helper, including the
 * deferred-mode postcondition relabeling.
 */

import type { SyncEffectResult, SyncProjectionEffect } from "../../../../../application/sync/sheets/syncSheets.js";
import { SYNC_EFFECT_RESULT_STATUSES, SYNC_POSTCONDITION_STATUSES } from "../../../../../application/sync/sheets/constants.js";
import { presentValue, absentValue } from "../../../../../shared/state/index.js";
import type { PlannedOutcome, PlannedReceipt } from "./planner.js";

/** Builds a receipt record exactly like `makeReceipt_`. */
export function makeReceipt(
  effect: SyncProjectionEffect,
  visibleHash: string,
  visibleRevision: number,
): PlannedReceipt {
  return {
    effectId: effect.effectId,
    payloadHash: effect.payloadHash,
    status: "applied",
    visibleHash,
    visibleRevision,
  };
}

/** Encodes a planned outcome as a provider result (Apps Script `result_`). */
export function encodeOutcomeResult(outcome: PlannedOutcome): SyncEffectResult {
  switch (outcome.kind) {
    case "applied":
    case "already_applied":
      return {
        effectId: outcome.effect.effectId,
        payloadHash: outcome.effect.payloadHash,
        status: outcome.kind === "applied"
          ? SYNC_EFFECT_RESULT_STATUSES.APPLIED
          : SYNC_EFFECT_RESULT_STATUSES.ALREADY_APPLIED,
        visibleRevision: presentValue(outcome.receipt.visibleRevision),
        visibleHash: presentValue(outcome.receipt.visibleHash),
        snapshotHash: absentValue(),
        reason: absentValue(),
        postcondition: SYNC_POSTCONDITION_STATUSES.VERIFIED,
      };
    case "guard_mismatch":
    case "repair_reobserve":
    case "schema_error":
    case "retryable_error":
      return {
        effectId: outcome.effect.effectId,
        payloadHash: outcome.effect.payloadHash,
        status: outcome.kind,
        visibleRevision: absentValue(),
        visibleHash: absentValue(),
        snapshotHash: absentValue(),
        reason: presentValue(outcome.reason),
        postcondition: SYNC_POSTCONDITION_STATUSES.UNAVAILABLE,
      };
  }
}

/** Builds a schema_error result without any receipt-backed evidence. */
export function encodeSchemaErrorResult(
  effect: SyncProjectionEffect,
  reason: string,
): SyncEffectResult {
  return {
    effectId: effect.effectId,
    payloadHash: effect.payloadHash,
    status: SYNC_EFFECT_RESULT_STATUSES.SCHEMA_ERROR,
    visibleRevision: absentValue(),
    visibleHash: absentValue(),
    snapshotHash: absentValue(),
    reason: presentValue(reason),
    postcondition: SYNC_POSTCONDITION_STATUSES.UNAVAILABLE,
  };
}

/** Applies the deferred-mode postcondition relabeling for applied results. */
export function withDeferredPostcondition(
  result: SyncEffectResult,
): SyncEffectResult {
  if (
    (result.status === SYNC_EFFECT_RESULT_STATUSES.APPLIED ||
      result.status === SYNC_EFFECT_RESULT_STATUSES.ALREADY_APPLIED) &&
    result.postcondition === SYNC_POSTCONDITION_STATUSES.VERIFIED
  ) {
    return { ...result, postcondition: SYNC_POSTCONDITION_STATUSES.ACKNOWLEDGED };
  }
  return result;
}
