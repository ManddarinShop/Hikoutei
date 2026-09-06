/**
 * TypeScript planner: the Apps Script effect judgment semantics in TS.
 *
 * This module ports `effectOperationScript.ts`'s `requireEffect_`,
 * `findRow_`, `currentHash_`, `validateDeletion_`, `result_`,
 * `makeReceipt_`, and the apply-effects planning loop. Every decision that
 * the Code.gs source makes before mutation (receipt replay, row lookup,
 * create-if-missing, visible/candidate/repair guards, deletion shape) is
 * reproduced here against the typed preflight context. Outcomes are
 * discriminated unions, never nullable status markers.
 *
 * The module is split into focused files; this entry keeps the planner core
 * (`planEffectBatch`, `requireProviderEffect`). The shared plan/outcome/row
 * types live in `plannerContracts`, and the moved helpers live in:
 *
 * - `plannerWorkingRow` — working-row lifecycle, replay, hashing, lookup
 * - `plannerDeletion` — full-row deletion guard and kind predicates
 * - `plannerReceipt` — receipt construction and result encoding
 */

import { computeSyncVisibleHash, type SyncProjectionEffect, type ApplySyncEffectsRequest } from "@hikoutei/contracts/sheets/syncSheets.js";
import { EFFECT_KINDS } from "@hikoutei/contracts/domain/model/constants.js";
import { APPLICABILITY_KINDS, PRESENCE_KINDS } from "@hikoutei/contracts/state/index.js";
import { presentValue, absentValue } from "@hikoutei/contracts/state/index.js";
import { isNormalizedCell } from "@hikoutei/contracts/encoding/index.js";
import { GOOGLE_SHEETS_API_EFFECT_REASONS } from "../constants.js";
import { invalidProviderRequest } from "../errors.js";
import type { PreflightContext } from "./preflightContext.js";
import type {
  EffectPlan,
  PlannedReceipt,
  WorkingRow,
} from "./plannerContracts.js";
import {
  createWorkingRow,
  currentHash,
  findWorkingRow,
  planReceiptReplay,
  toWorkingRow,
} from "./plannerWorkingRow.js";
import {
  isDeletionEffect,
  isSyncEffectKind,
  validateDeletion,
} from "./plannerDeletion.js";
import { makeReceipt } from "./plannerReceipt.js";

/**
 * Plans one applyEffects request against a preflight context.
 *
 * All effects are planned (including beyond the transport byte budget); the
 * batch builder decides which prefix is actually sent. Deleted working rows
 * are removed from the anchor/identity indexes so later effects in the same
 * batch observe the mutations of earlier ones.
 */
export function planEffectBatch(
  request: ApplySyncEffectsRequest,
  context: PreflightContext,
): readonly EffectPlan[] {
  const plans: EffectPlan[] = [];
  const working = new Map<number, WorkingRow>();
  const byAnchor = new Map<string, WorkingRow>();
  const byIdentity = new Map<string, WorkingRow>();
  for (const row of context.rows) {
    const copy = toWorkingRow(row);
    working.set(copy.rowNumber, copy);
    // Mirrors indexRows: only the FIRST row per anchor value enters the
    // index (duplicated anchors are evidence, never rewritten), so a
    // duplicated anchor resolves deterministically instead of drifting to
    // the last row carrying it.
    if (copy.anchor.kind === PRESENCE_KINDS.PRESENT && !byAnchor.has(copy.anchor.value)) {
      byAnchor.set(copy.anchor.value, copy);
    }
    if (copy.identity.kind === PRESENCE_KINDS.PRESENT) {
      byIdentity.set(copy.identity.value, copy);
    }
  }
  const pendingReceipts = new Map<string, PlannedReceipt>();
  let nextAppendRow = context.nextAppendRow;

  for (const effect of request.effects) {
    requireProviderEffect(effect, request, context);

    const existingReceipt = pendingReceipts.get(effect.effectId) ?? context.receipts.get(effect.effectId);
    if (existingReceipt !== undefined) {
      plans.push(planReceiptReplay(effect, existingReceipt, context, byAnchor, byIdentity));
      continue;
    }

    let row = findWorkingRow(byAnchor, byIdentity, effect.payload.targetAnchor, effect.targetId);
    let created = false;
    if (row === undefined) {
      if (!effect.payload.createIfMissing) {
        plans.push({
          outcome: {
            kind: "guard_mismatch",
            effect,
            rowNumber: absentValue(),
            reason: GOOGLE_SHEETS_API_EFFECT_REASONS.TARGET_ANCHOR_MISSING,
          },
          mutation: undefined,
          receipt: undefined,
          verify: false,
        });
        continue;
      }
      if (effect.expectedVisibleRevision !== 0 || effect.expectedVisibleHash !== "") {
        plans.push({
          outcome: {
            kind: "guard_mismatch",
            effect,
            rowNumber: absentValue(),
            reason: GOOGLE_SHEETS_API_EFFECT_REASONS.INSERT_REQUIRES_EMPTY_VISIBLE_BASELINE,
          },
          mutation: undefined,
          receipt: undefined,
          verify: false,
        });
        continue;
      }
      row = createWorkingRow(effect, nextAppendRow);
      nextAppendRow += 1;
      working.set(row.rowNumber, row);
      if (row.anchor.kind === PRESENCE_KINDS.PRESENT) {
        byAnchor.set(row.anchor.value, row);
      }
      if (row.identity.kind === PRESENCE_KINDS.PRESENT) {
        byIdentity.set(row.identity.value, row);
      }
      created = true;
    }

    if (isDeletionEffect(effect.effectKind)) {
      const deletionError = validateDeletion(context, effect);
      if (deletionError !== null) {
        plans.push({
          outcome: {
            kind: "schema_error",
            effect,
            rowNumber: presentValue(row.rowNumber),
            reason: deletionError,
          },
          mutation: undefined,
          receipt: undefined,
          verify: false,
        });
        continue;
      }
      const deletionHash = currentHash(row, effect.payload.fields);
      if (deletionHash !== effect.expectedVisibleHash) {
        plans.push({
          outcome: {
            kind: "guard_mismatch",
            effect,
            rowNumber: presentValue(row.rowNumber),
            reason: GOOGLE_SHEETS_API_EFFECT_REASONS.VISIBLE_GUARD_MISMATCH,
          },
          mutation: undefined,
          receipt: undefined,
          verify: false,
        });
        continue;
      }
      const receipt = makeReceipt(effect, deletionHash, effect.expectedVisibleRevision);
      row.deleted = true;
      if (row.anchor.kind === PRESENCE_KINDS.PRESENT) {
        byAnchor.delete(row.anchor.value);
      }
      if (row.identity.kind === PRESENCE_KINDS.PRESENT) {
        byIdentity.delete(row.identity.value);
      }
      pendingReceipts.set(receipt.effectId, receipt);
      plans.push({
        outcome: {
          kind: "applied",
          effect,
          rowNumber: absentValue(),
          receipt,
          created: false,
          deletion: true,
        },
        mutation: { kind: "delete", row },
        receipt,
        verify: false,
      });
      continue;
    }

    // A newly created row is still the empty visible baseline. Its in-memory
    // cells are blank, so hashing them would incorrectly turn the first
    // candidate reconcile into a guard mismatch before the requested fields
    // are written.
    const current = created
      ? effect.expectedVisibleHash
      : currentHash(row, effect.payload.fields);
    if (
      effect.effectKind === EFFECT_KINDS.CANDIDATE_RECONCILE &&
      !created &&
      effect.payload.expectedCandidateHash.kind === APPLICABILITY_KINDS.APPLICABLE &&
      current !== effect.expectedVisibleHash
    ) {
      plans.push({
        outcome: {
          kind: "guard_mismatch",
          effect,
          rowNumber: presentValue(row.rowNumber),
          reason: GOOGLE_SHEETS_API_EFFECT_REASONS.CANDIDATE_GUARD_MISMATCH,
        },
        mutation: undefined,
        receipt: undefined,
        verify: false,
      });
      continue;
    }
    if (current === effect.payload.targetVisibleHash) {
      const receipt = makeReceipt(effect, current, effect.expectedVisibleRevision + 1);
      pendingReceipts.set(receipt.effectId, receipt);
      plans.push({
        outcome: {
          kind: created ? "applied" : "already_applied",
          effect,
          rowNumber: presentValue(row.rowNumber),
          receipt,
          created,
          deletion: false,
        },
        mutation: created ? { kind: "append", row } : undefined,
        receipt,
        verify: false,
      });
      continue;
    }
    if (effect.effectKind === EFFECT_KINDS.SYSTEM_REPAIR) {
      if (
        effect.repairGuardHash.kind !== PRESENCE_KINDS.PRESENT ||
        current !== effect.repairGuardHash.value
      ) {
        plans.push({
          outcome: {
            kind: "repair_reobserve",
            effect,
            rowNumber: presentValue(row.rowNumber),
            reason: GOOGLE_SHEETS_API_EFFECT_REASONS.REPAIR_GUARD_MISMATCH,
          },
          mutation: undefined,
          receipt: undefined,
          verify: false,
        });
        continue;
      }
    } else if (current !== effect.expectedVisibleHash) {
      plans.push({
        outcome: {
          kind: "guard_mismatch",
          effect,
          rowNumber: presentValue(row.rowNumber),
          reason: GOOGLE_SHEETS_API_EFFECT_REASONS.VISIBLE_GUARD_MISMATCH,
        },
        mutation: undefined,
        receipt: undefined,
        verify: false,
      });
      continue;
    }

    for (const [fieldName, cell] of Object.entries(effect.payload.fields)) {
      row.cells[fieldName] = cell;
      if (!row.appended) {
        row.writeFields[fieldName] = cell;
      }
    }
    const receipt = makeReceipt(effect, effect.payload.targetVisibleHash, effect.expectedVisibleRevision + 1);
    // Register the receipt for same-request replays: a duplicate effect ID
    // later in this request must replay against it (payload-hash mismatch
    // becomes schema_error, a matching payload becomes already_applied with
    // this same receipt), exactly like the Apps Script queueReceipt_.
    pendingReceipts.set(receipt.effectId, receipt);
    plans.push({
      outcome: {
        kind: "applied",
        effect,
        rowNumber: presentValue(row.rowNumber),
        receipt,
        created,
        deletion: false,
      },
      mutation: created ? { kind: "append", row } : { kind: "update", row },
      receipt,
      // Inline mode re-reads every non-deletion write (created rows included),
      // exactly like the Apps Script postcondition phase.
      verify: true,
    });
  }
  return plans;
}

/** Runtime validation of one effect against its request route (fail closed). */
export function requireProviderEffect(
  effect: SyncProjectionEffect,
  request: ApplySyncEffectsRequest,
  context: PreflightContext,
): void {
  if (effect.effectId.length === 0) {
    invalidProviderRequest("apply effects", "effectId is required");
  }
  if (effect.payloadHash.length === 0) {
    invalidProviderRequest("apply effects", "payloadHash is required");
  }
  if (!isSyncEffectKind(effect.effectKind)) {
    invalidProviderRequest("apply effects", "effectKind is unsupported");
  }
  if (effect.physicalSheetId !== request.physicalSheetId) {
    invalidProviderRequest("apply effects", "effect does not target the requested physical sheet");
  }
  if (effect.projection !== request.projection) {
    invalidProviderRequest("apply effects", "effect projection is not registered for this request");
  }
  if (
    effect.effectKind === EFFECT_KINDS.RESOLUTION_DELETE &&
    request.projection !== "sync_conflicts"
  ) {
    invalidProviderRequest("apply effects", "resolution_delete is only allowed on sync_conflicts");
  }
  if (
    effect.effectKind === EFFECT_KINDS.USER_INPUT_DELETE &&
    request.projection !== "user_input"
  ) {
    invalidProviderRequest("apply effects", "user_input_delete is only allowed on user_input");
  }
  const payload = effect.payload;
  if (
    payload.sheetName !== request.sheetName ||
    payload.registeredRange !== request.registeredRange ||
    payload.schemaVersion !== request.schemaVersion
  ) {
    invalidProviderRequest("apply effects", "effect payload does not match the registered projection");
  }
  if (payload.targetAnchor.length === 0) {
    invalidProviderRequest("apply effects", "effect targetAnchor is required");
  }
  const fieldNames = Object.keys(payload.fields);
  if (fieldNames.length === 0) {
    invalidProviderRequest("apply effects", "effect fields must contain a field");
  }
  for (const fieldName of fieldNames) {
    if (!context.positions.has(fieldName)) {
      invalidProviderRequest("apply effects", `effect field is not a registered header: ${fieldName}`);
    }
    if (!isNormalizedCell(payload.fields[fieldName])) {
      invalidProviderRequest("apply effects", "effect fields contain an invalid normalized cell");
    }
  }
  if (computeSyncVisibleHash(payload.fields) !== payload.targetVisibleHash) {
    invalidProviderRequest("apply effects", "effect targetVisibleHash does not match fields");
  }
  if (typeof payload.createIfMissing !== "boolean") {
    invalidProviderRequest("apply effects", "effect createIfMissing must be boolean");
  }
  if (
    !Number.isSafeInteger(effect.expectedVisibleRevision) ||
    effect.expectedVisibleRevision < 0
  ) {
    invalidProviderRequest("apply effects", "effect expectedVisibleRevision must be a non-negative integer");
  }
  if (typeof effect.expectedVisibleHash !== "string") {
    invalidProviderRequest("apply effects", "effect expectedVisibleHash must be a string");
  }
  if (
    effect.expectedVisibleHash.length === 0 &&
    !(effect.expectedVisibleRevision === 0 && payload.createIfMissing === true)
  ) {
    invalidProviderRequest("apply effects", "empty expectedVisibleHash is only valid for a new row");
  }
  if (effect.repairGuardHash.kind !== PRESENCE_KINDS.PRESENT &&
      effect.repairGuardHash.kind !== PRESENCE_KINDS.ABSENT) {
    invalidProviderRequest("apply effects", "effect repairGuardHash is invalid");
  }
  if (effect.payload.expectedCandidateHash.kind !== APPLICABILITY_KINDS.APPLICABLE &&
      effect.payload.expectedCandidateHash.kind !== APPLICABILITY_KINDS.NOT_APPLICABLE) {
    invalidProviderRequest("apply effects", "effect expectedCandidateHash is invalid");
  }
}