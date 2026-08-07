/**
 * Working-row lifecycle for the effect planner.
 *
 * Preflight rows are copied into mutable working rows the batch can mutate;
 * created rows start at the next append position and are keyed by their full
 * targetId. `planReceiptReplay` handles the receipt-replay branch (a receipt
 * already exists for this effect ID), `currentHash` computes the visible hash
 * restricted to the effect's fields, and `rejectionPlan` builds rejection
 * plans with no mutation and no receipt.
 */

import { computeSyncVisibleHash, type SyncProjectionEffect } from "../../../../../application/sync/sheetsContract/syncSheets.js";
import { EFFECT_KINDS } from "../../../../../domain/model/constants.js";
import { PRESENCE_KINDS, type Presence } from "../../../../../shared/state/index.js";
import { presentValue, absentValue } from "../../../../../shared/state/index.js";
import { GOOGLE_SHEETS_API_EFFECT_REASONS } from "../constants.js";
import type { PreflightContext, PreflightRow } from "./preflight.js";
import type { EffectPlan, PlannedReceipt, WorkingRow } from "./planner.js";
import { isDeletionEffect } from "./plannerDeletion.js";

/** Receipt replay branch: a receipt already exists for this effect ID. */
export function planReceiptReplay(
  effect: SyncProjectionEffect,
  receipt: PlannedReceipt,
  context: PreflightContext,
  byAnchor: ReadonlyMap<string, WorkingRow>,
  byIdentity: ReadonlyMap<string, WorkingRow>,
): EffectPlan {
  if (receipt.payloadHash !== effect.payloadHash) {
    return rejectionPlan(effect, "schema_error",
      GOOGLE_SHEETS_API_EFFECT_REASONS.EFFECT_ID_REUSED_WITH_DIFFERENT_PAYLOAD);
  }
  const receiptRow = findWorkingRow(byAnchor, byIdentity, effect.payload.targetAnchor, effect.targetId);
  if (isDeletionEffect(effect.effectKind)) {
    if (receiptRow === undefined) {
      return {
        outcome: {
          kind: "already_applied",
          effect,
          rowNumber: absentValue(),
          receipt,
        },
        mutation: undefined,
        receipt,
        verify: false,
      };
    }
    return rejectionPlan(
      effect,
      "guard_mismatch",
      GOOGLE_SHEETS_API_EFFECT_REASONS.RECEIPT_TARGET_REAPPEARED,
      presentValue(receiptRow.rowNumber),
    );
  }
  if (receiptRow === undefined) {
    const repair = effect.effectKind === EFFECT_KINDS.SYSTEM_REPAIR;
    return rejectionPlan(
      effect,
      repair ? "repair_reobserve" : "guard_mismatch",
      GOOGLE_SHEETS_API_EFFECT_REASONS.RECEIPT_TARGET_MISSING,
    );
  }
  const receiptCurrentHash = currentHash(receiptRow, effect.payload.fields);
  if (receiptCurrentHash === effect.payload.targetVisibleHash) {
    return {
      outcome: {
        kind: "already_applied",
        effect,
        rowNumber: presentValue(receiptRow.rowNumber),
        receipt,
      },
      mutation: undefined,
      receipt,
      verify: false,
    };
  }
  const repair = effect.effectKind === EFFECT_KINDS.SYSTEM_REPAIR;
  return rejectionPlan(
    effect,
    repair ? "repair_reobserve" : "guard_mismatch",
    GOOGLE_SHEETS_API_EFFECT_REASONS.RECEIPT_POSTCONDITION_CHANGED,
    presentValue(receiptRow.rowNumber),
  );
}

/** Computes the visible hash of a row restricted to the effect's fields. */
export function currentHash(
  row: WorkingRow | PreflightRow,
  fields: Readonly<Record<string, import("../../../../../domain/index.js").NormalizedCell>>,
): string {
  const values: Record<string, import("../../../../../domain/index.js").NormalizedCell> = {};
  for (const fieldName of Object.keys(fields)) {
    values[fieldName] = row.cells[fieldName] ?? null;
  }
  return computeSyncVisibleHash(values);
}

/** Finds a row by anchor first, then visible identity, then the targetId tail. */
export function findWorkingRow(
  byAnchor: ReadonlyMap<string, WorkingRow>,
  byIdentity: ReadonlyMap<string, WorkingRow>,
  anchor: string,
  targetId: string,
): WorkingRow | undefined {
  const anchored = byAnchor.get(anchor);
  if (anchored !== undefined) return anchored;
  const direct = byIdentity.get(targetId);
  if (direct !== undefined) return direct;
  const separator = targetId.lastIndexOf(":");
  if (separator < 0) return undefined;
  const visibleIdentity = targetId.slice(separator + 1);
  if (visibleIdentity.length === 0) return undefined;
  return byIdentity.get(visibleIdentity);
}

/** Builds a rejection plan (no mutation, no receipt). */
function rejectionPlan(
  effect: SyncProjectionEffect,
  kind: "guard_mismatch" | "repair_reobserve" | "schema_error",
  reason: string,
  rowNumber: Presence<number> = absentValue(),
): EffectPlan {
  return {
    outcome: { kind, effect, rowNumber, reason },
    mutation: undefined,
    receipt: undefined,
    verify: false,
  };
}

/** Converts one preflight row into a working row for planning/probing. */
export function toWorkingRow(row: PreflightRow): WorkingRow {
  return {
    rowNumber: row.rowNumber,
    anchor: row.physicalAnchor,
    cells: { ...row.cells },
    identity: row.identity,
    appended: false,
    deleted: false,
    writeFields: {},
  };
}

export function createWorkingRow(effect: SyncProjectionEffect, rowNumber: number): WorkingRow {
  const cells: Record<string, import("../../../../../domain/index.js").NormalizedCell> = {};
  return {
    rowNumber,
    anchor: presentValue(effect.payload.targetAnchor),
    cells,
    // Key the created row by its full targetId (Apps Script `createRow_`
    // registers byIdentity[targetId] when targetId is non-empty) so a later
    // effect in the same request that targets the same entity finds this row
    // through findWorkingRow's direct targetId lookup instead of creating a
    // second physical row. The caller registers it in byIdentity under
    // effect.targetId via the identity value below.
    identity: effect.targetId.length > 0 ? presentValue(effect.targetId) : absentValue(),
    appended: true,
    deleted: false,
    writeFields: {},
  };
}
