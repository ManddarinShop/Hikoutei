/**
 * Response-loss postcondition classifier (Apps Script `classifyPostcondition_`).
 *
 * Recovery probes classify one effect against a fresh target+receipt read.
 * The classifier never assumes success: a receipt proves the effect reached
 * the sheet, a matching visible hash proves the target content, and anything
 * else is `unapplied`, `changed`, or `unavailable` so the worker redrives,
 * fails, or keeps probing instead of closing the outbox on weak evidence.
 */

import type { SyncEffectPostcondition, SyncProjectionEffect } from "../../../../../application/sync/sheetsContract/syncSheets.js";
import { PRESENCE_KINDS } from "../../../../../shared/state/index.js";
import { presentValue, absentValue } from "../../../../../shared/state/index.js";
import type { PreflightContext, PreflightReceipt } from "./preflight.js";
import {
  currentHash,
  findWorkingRow,
  isDeletionEffect,
  requireProviderEffect,
  toWorkingRow,
  type WorkingRow,
} from "./planner.js";

/**
 * Classifies one effect's delivery state. `context` must come from the same
 * read pass as `receipts` so the classification is a single consistent view.
 */
export function classifyPostcondition(
  context: PreflightContext,
  effect: SyncProjectionEffect,
  receipts: ReadonlyMap<string, PreflightReceipt>,
): SyncEffectPostcondition {
  const request = {
    physicalSheetId: effect.physicalSheetId,
    sheetName: effect.payload.sheetName,
    registeredRange: effect.payload.registeredRange,
    projection: effect.projection,
    schemaVersion: effect.payload.schemaVersion,
    effects: [effect],
  };
  requireProviderEffect(effect, request, context);
  const receipt = receipts.get(effect.effectId);
  if (receipt !== undefined && receipt.payloadHash !== effect.payloadHash) {
    return postcondition("changed", absentValue(), absentValue());
  }
  const row = findProbeRow(context, effect);
  if (isDeletionEffect(effect.effectKind)) {
    if (receipt !== undefined && row === undefined) {
      return postcondition("applied", presentValue(receipt.visibleRevision), presentValue(receipt.visibleHash));
    }
    if (row === undefined) {
      // An absent row without this effect's receipt could be a manual
      // deletion; never let that absence close an outbox effect.
      return postcondition("unavailable", absentValue(), absentValue());
    }
    const deleteHash = currentHash(row, effect.payload.fields);
    if (receipt !== undefined) {
      return postcondition("changed", absentValue(), presentValue(deleteHash));
    }
    return deleteHash === effect.expectedVisibleHash
      ? postcondition("unapplied", presentValue(effect.expectedVisibleRevision), presentValue(deleteHash))
      : postcondition("changed", absentValue(), presentValue(deleteHash));
  }
  // A receipt alone cannot prove that a non-delete row still exists; a manual
  // deletion must remain observable instead of closing the outbox.
  if (row === undefined) {
    return postcondition(
      receipt !== undefined || !effect.payload.createIfMissing ? "changed" : "unapplied",
      absentValue(),
      absentValue(),
      receipt === undefined ? undefined : "receipt_target_missing",
    );
  }
  const current = currentHash(row, effect.payload.fields);
  if (current === effect.payload.targetVisibleHash) {
    if (receipt === undefined) {
      // The row already carries the target content, but without a receipt
      // there is no durable proof that this effect was applied by the
      // provider: the two-batch inline path can crash between the target-row
      // write and the receipt write and leave exactly this orphan. Closing
      // the outbox on row-hash evidence alone would turn that crash into a
      // false success, so stay fail-closed.
      return postcondition("unavailable", absentValue(), presentValue(current), "receipt_missing");
    }
    return postcondition("applied", presentValue(receipt.visibleRevision), presentValue(current));
  }
  const repairGuard = effect.repairGuardHash;
  if (
    current === effect.expectedVisibleHash ||
    (repairGuard.kind === PRESENCE_KINDS.PRESENT && current === repairGuard.value)
  ) {
    return postcondition("unapplied", presentValue(effect.expectedVisibleRevision), presentValue(current));
  }
  return postcondition("changed", absentValue(), presentValue(current));
}

function findProbeRow(
  context: PreflightContext,
  effect: SyncProjectionEffect,
): WorkingRow | undefined {
  const byAnchor = new Map<string, WorkingRow>();
  const byIdentity = new Map<string, WorkingRow>();
  for (const row of context.rows) {
    const working = toWorkingRow(row);
    if (working.anchor.kind === PRESENCE_KINDS.PRESENT) {
      byAnchor.set(working.anchor.value, working);
    }
    if (working.identity.kind === PRESENCE_KINDS.PRESENT) {
      byIdentity.set(working.identity.value, working);
    }
  }
  return findWorkingRow(byAnchor, byIdentity, effect.payload.targetAnchor, effect.targetId);
}

function postcondition(
  disposition: SyncEffectPostcondition["disposition"],
  visibleRevision: SyncEffectPostcondition["visibleRevision"],
  visibleHash: SyncEffectPostcondition["visibleHash"],
  reason?: string,
): SyncEffectPostcondition {
  const result: SyncEffectPostcondition = {
    disposition,
    visibleRevision,
    visibleHash,
    // The direct provider never computes a snapshot hash; recovery does not
    // need it and the Apps Script provider also returns null here.
    snapshotHash: absentValue(),
  };
  return reason === undefined ? result : { ...result, reason };
}
