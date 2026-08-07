/**
 * Deletion judgment for the effect planner.
 *
 * `validateDeletion` reproduces the Apps Script `validateDeletion_` full-row
 * deletion guard exactly; the kind predicates classify delete effects and
 * supported effect kinds for the apply-effects request validation.
 */

import type { SyncProjectionEffect } from "../../../../../application/sync/sheets/syncSheets.js";
import { EFFECT_KINDS } from "../../../../../domain/model/constants.js";
import { GOOGLE_SHEETS_API_EFFECT_REASONS, fullRowDeletionReason } from "../constants.js";
import type { PreflightContext } from "./preflight.js";

/** Validates the full-row deletion guard exactly like `validateDeletion_`. */
export function validateDeletion(
  context: PreflightContext,
  effect: SyncProjectionEffect,
): string | null {
  if (
    effect.payload.createIfMissing ||
    effect.expectedVisibleRevision < 1 ||
    effect.payload.targetVisibleHash !== effect.expectedVisibleHash
  ) {
    return GOOGLE_SHEETS_API_EFFECT_REASONS.INVALID_DELETION_GUARD;
  }
  const actual = Object.keys(effect.payload.fields).sort();
  const expected = [...context.headers].sort();
  if (
    actual.length !== expected.length ||
    actual.some((fieldName, index) => fieldName !== expected[index])
  ) {
    return fullRowDeletionReason(effect.effectKind);
  }
  return null;
}

export function isDeletionEffect(effectKind: string): boolean {
  return effectKind === EFFECT_KINDS.RESOLUTION_DELETE ||
    effectKind === EFFECT_KINDS.USER_INPUT_DELETE;
}

export function isSyncEffectKind(value: string): boolean {
  return value === "system_projection" ||
    value === "candidate_reconcile" ||
    value === "system_repair" ||
    value === "resolution_projection" ||
    value === EFFECT_KINDS.RESOLUTION_DELETE ||
    value === EFFECT_KINDS.USER_INPUT_DELETE;
}
