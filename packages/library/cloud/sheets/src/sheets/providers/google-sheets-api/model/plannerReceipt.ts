/**
 * Sheets boundary adapter over the neutral CAS-evidence receipt encoders.
 *
 * The planning outcome shapes (`plannerContracts.ts`) and the Sheets result
 * contract (`SyncEffectResult`) stay provider-owned; the receipt and
 * result-encoding semantics live in the kernel (`@hikoutei/ikisaki`
 * `evidence/plannerReceipt.ts`). This module maps between the two at the
 * boundary with no semantic content of its own.
 */

import type { SyncEffectResult, SyncProjectionEffect } from "@hikoutei/contracts/sheets/syncSheets.js";
import { SYNC_EFFECT_RESULT_STATUSES, SYNC_POSTCONDITION_STATUSES } from "@hikoutei/contracts/sheets/constants.js";
import { presentValue, absentValue } from "@hikoutei/contracts/state/index.js";
import {
  encodeOutcomeResultEvidence,
  encodeSchemaErrorResultEvidence,
  makeReceiptEvidence,
  withDeferredPostconditionEvidence,
  type CodedEffectResult,
  type PlannedOutcomeEvidence,
} from "@hikoutei/ikisaki";
import type { PlannedOutcome, PlannedReceipt } from "./plannerContracts.js";

/** Builds a receipt record exactly like `makeReceipt_`. */
export function makeReceipt(
  effect: SyncProjectionEffect,
  visibleHash: string,
  visibleRevision: number,
): PlannedReceipt {
  return makeReceiptEvidence(effect.effectId, effect.payloadHash, visibleHash, visibleRevision);
}

/** Encodes a planned outcome as a provider result (Apps Script `result_`). */
export function encodeOutcomeResult(outcome: PlannedOutcome): SyncEffectResult {
  return toSyncEffectResult(encodeOutcomeResultEvidence(toOutcomeEvidence(outcome)));
}

/** Builds a schema_error result without any receipt-backed evidence. */
export function encodeSchemaErrorResult(
  effect: SyncProjectionEffect,
  reason: string,
): SyncEffectResult {
  return toSyncEffectResult(
    encodeSchemaErrorResultEvidence(effect.effectId, effect.payloadHash, reason),
  );
}

/** Applies the deferred-mode postcondition relabeling for applied results. */
export function withDeferredPostcondition(
  result: SyncEffectResult,
): SyncEffectResult {
  // Non-applied results (and already-relabeled ones) pass through
  // untouched, exactly like the historical helper — only a verified
  // applied result is relabeled, so unlisted statuses can never be
  // corrupted by the neutral round-trip.
  if (
    (result.status !== SYNC_EFFECT_RESULT_STATUSES.APPLIED &&
      result.status !== SYNC_EFFECT_RESULT_STATUSES.ALREADY_APPLIED) ||
    result.postcondition !== SYNC_POSTCONDITION_STATUSES.VERIFIED
  ) {
    return result;
  }
  return toSyncEffectResult(
    withDeferredPostconditionEvidence(fromSyncEffectResult(result)),
  );
}

/** Projects a planner outcome onto the neutral evidence shape. */
function toOutcomeEvidence(outcome: PlannedOutcome): PlannedOutcomeEvidence {
  switch (outcome.kind) {
    case "applied":
      return {
        kind: "applied",
        effectId: outcome.effect.effectId,
        payloadHash: outcome.effect.payloadHash,
        receipt: outcome.receipt,
        created: outcome.created,
        deletion: outcome.deletion,
      };
    case "already_applied":
      return {
        kind: "already_applied",
        effectId: outcome.effect.effectId,
        payloadHash: outcome.effect.payloadHash,
        receipt: outcome.receipt,
      };
    case "guard_mismatch":
    case "repair_reobserve":
    case "schema_error":
    case "retryable_error":
      return {
        kind: outcome.kind,
        effectId: outcome.effect.effectId,
        payloadHash: outcome.effect.payloadHash,
        reason: outcome.reason,
      };
  }
}

/** Maps a neutral coded result onto the Sheets result contract. */
function toSyncEffectResult(result: CodedEffectResult): SyncEffectResult {
  return {
    effectId: result.effectId,
    payloadHash: result.payloadHash,
    status: result.status === "applied"
      ? SYNC_EFFECT_RESULT_STATUSES.APPLIED
      : result.status === "already_applied"
        ? SYNC_EFFECT_RESULT_STATUSES.ALREADY_APPLIED
        : result.status === "guard_mismatch"
          ? SYNC_EFFECT_RESULT_STATUSES.GUARD_MISMATCH
          : result.status === "repair_reobserve"
            ? SYNC_EFFECT_RESULT_STATUSES.REPAIR_REOBSERVE
            : result.status === "schema_error"
              ? SYNC_EFFECT_RESULT_STATUSES.SCHEMA_ERROR
              : SYNC_EFFECT_RESULT_STATUSES.RETRYABLE_ERROR,
    visibleRevision: result.visibleRevision === undefined
      ? absentValue()
      : presentValue(result.visibleRevision),
    visibleHash: result.visibleHash === undefined
      ? absentValue()
      : presentValue(result.visibleHash),
    snapshotHash: absentValue(),
    reason: result.reason === undefined ? absentValue() : presentValue(result.reason),
    postcondition: result.postcondition === "verified"
      ? SYNC_POSTCONDITION_STATUSES.VERIFIED
      : result.postcondition === "acknowledged"
        ? SYNC_POSTCONDITION_STATUSES.ACKNOWLEDGED
        : SYNC_POSTCONDITION_STATUSES.UNAVAILABLE,
  };
}

/** Projects a Sheets result back onto the neutral coded shape. */
function fromSyncEffectResult(result: SyncEffectResult): CodedEffectResult {
  return {
    effectId: result.effectId,
    payloadHash: result.payloadHash,
    status: result.status === SYNC_EFFECT_RESULT_STATUSES.APPLIED
      ? "applied"
      : result.status === SYNC_EFFECT_RESULT_STATUSES.ALREADY_APPLIED
        ? "already_applied"
        : result.status === SYNC_EFFECT_RESULT_STATUSES.GUARD_MISMATCH
          ? "guard_mismatch"
          : result.status === SYNC_EFFECT_RESULT_STATUSES.REPAIR_REOBSERVE
            ? "repair_reobserve"
            : result.status === SYNC_EFFECT_RESULT_STATUSES.SCHEMA_ERROR
              ? "schema_error"
              : "retryable_error",
    visibleRevision: result.visibleRevision.kind === "present"
      ? result.visibleRevision.value
      : undefined,
    visibleHash: result.visibleHash.kind === "present"
      ? result.visibleHash.value
      : undefined,
    reason: result.reason.kind === "present" ? result.reason.value : undefined,
    postcondition: result.postcondition === SYNC_POSTCONDITION_STATUSES.VERIFIED
      ? "verified"
      : result.postcondition === SYNC_POSTCONDITION_STATUSES.ACKNOWLEDGED
        ? "acknowledged"
        : "unavailable",
  };
}
