/**
 * Sheets boundary adapter over the neutral CAS-evidence postcondition
 * classifier.
 *
 * Recovery probes classify one effect against a fresh target+receipt read.
 * The Sheets context model (anchor/identity row lookup, working-row hashes,
 * deletion-ness, route validation) stays provider-owned here; the
 * applied/unapplied/changed/unavailable decision lives in the kernel
 * (`@hikoutei/ikisaki` `evidence/postcondition.ts`). This module builds the
 * neutral evidence views from the context and maps the verdict onto the
 * Sheets postcondition contract.
 */

import type { SyncEffectPostcondition, SyncProjectionEffect } from "@hikoutei/contracts/sheets/syncSheets.js";
import { PRESENCE_KINDS } from "@hikoutei/contracts/state/index.js";
import { presentValue, absentValue } from "@hikoutei/contracts/state/index.js";
import {
  classifyCasPostcondition,
  type CasClassifyInput,
} from "@hikoutei/ikisaki";
import type { PreflightContext, PreflightReceipt } from "./preflightContext.js";
import {
  currentHash,
  findWorkingRow,
  toWorkingRow,
} from "./plannerWorkingRow.js";
import { isDeletionEffect } from "./plannerDeletion.js";
import { requireProviderEffect } from "./planner.js";
import type { WorkingRow } from "./plannerContracts.js";

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
  const row = findProbeRow(context, effect);
  const verdict = classifyCasPostcondition(toClassifyInput(effect, receipt, row));
  return {
    disposition: verdict.disposition,
    visibleRevision: verdict.visibleRevision === undefined
      ? absentValue()
      : presentValue(verdict.visibleRevision),
    visibleHash: verdict.visibleHash === undefined
      ? absentValue()
      : presentValue(verdict.visibleHash),
    // The direct provider never computes a snapshot hash; recovery does not
    // need it and the Apps Script provider also returns null here.
    snapshotHash: absentValue(),
    ...(verdict.reason === undefined ? {} : { reason: verdict.reason }),
  };
}

/**
 * Locates the row number the probe's `findProbeRow` will classify for one
 * effect, against a preflight context (anchor first, then identity, then the
 * targetId tail). Returns `undefined` when the context holds no candidate
 * row. The recovery probe uses this to build its scoped row-band read: a row
 * that cannot be located needs no band (its absence is itself the evidence
 * `classifyPostcondition` consumes).
 */
export function probeTargetRowNumber(
  context: PreflightContext,
  effect: SyncProjectionEffect,
): number | undefined {
  const row = findProbeRow(context, effect);
  return row === undefined ? undefined : row.rowNumber;
}

/** Projects one effect plus its read-back evidence onto the neutral input. */
function toClassifyInput(
  effect: SyncProjectionEffect,
  receipt: PreflightReceipt | undefined,
  row: WorkingRow | undefined,
): CasClassifyInput {
  return {
    isDeletion: isDeletionEffect(effect.effectKind),
    expectedVisibleHash: effect.expectedVisibleHash,
    expectedVisibleRevision: effect.expectedVisibleRevision,
    targetVisibleHash: effect.payload.targetVisibleHash,
    createIfMissing: effect.payload.createIfMissing,
    repairGuardHash: effect.repairGuardHash.kind === PRESENCE_KINDS.PRESENT
      ? effect.repairGuardHash.value
      : null,
    effectPayloadHash: effect.payloadHash,
    receipt: receipt === undefined
      ? undefined
      : {
        payloadHash: receipt.payloadHash,
        visibleRevision: receipt.visibleRevision,
        visibleHash: receipt.visibleHash,
      },
    observedRow: row === undefined
      ? undefined
      : {
        rowNumber: row.rowNumber,
        currentHash: currentHash(row, effect.payload.fields),
      },
  };
}

function findProbeRow(
  context: PreflightContext,
  effect: SyncProjectionEffect,
): WorkingRow | undefined {
  const byAnchor = new Map<string, WorkingRow>();
  const byIdentity = new Map<string, WorkingRow>();
  for (const row of context.rows) {
    const working = toWorkingRow(row);
    // Mirrors indexRows: only the FIRST row per anchor value enters the
    // index (duplicated anchors are evidence, never rewritten).
    if (working.anchor.kind === PRESENCE_KINDS.PRESENT && !byAnchor.has(working.anchor.value)) {
      byAnchor.set(working.anchor.value, working);
    }
    if (working.identity.kind === PRESENCE_KINDS.PRESENT) {
      byIdentity.set(working.identity.value, working);
    }
  }
  return findWorkingRow(byAnchor, byIdentity, effect.payload.targetAnchor, effect.targetId);
}
