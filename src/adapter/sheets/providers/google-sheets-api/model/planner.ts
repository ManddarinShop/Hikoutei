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
 */

import { computeSyncVisibleHash, type SyncGatewayEffect } from "../../../../../application/sync/gateway/syncGateway.js";
import { EFFECT_KINDS } from "../../../../../domain/model/constants.js";
import type { ApplySyncEffectsRequest, SyncGatewayEffectResult } from "../../../../../application/sync/gateway/syncGateway.js";
import { SYNC_GATEWAY_EFFECT_RESULT_STATUSES, SYNC_GATEWAY_POSTCONDITION_STATUSES } from "../../../../../application/sync/gateway/constants.js";
import { APPLICABILITY_KINDS, PRESENCE_KINDS, type Presence } from "../../../../../shared/state/index.js";
import { presentValue, absentValue } from "../../../../../shared/state/index.js";
import { isNormalizedCell } from "../../../../../shared/encoding/index.js";
import { GOOGLE_SHEETS_API_EFFECT_REASONS, fullRowDeletionReason } from "../constants.js";
import { invalidProviderRequest } from "../errors.js";
import type { PreflightContext, PreflightReceipt, PreflightRow } from "./preflight.js";

/** Receipt evidence produced by the planner for one effect. */
export interface PlannedReceipt {
  readonly effectId: string;
  readonly payloadHash: string;
  readonly status: "applied";
  readonly visibleHash: string;
  readonly visibleRevision: number;
}

/** Terminal/non-terminal planner outcome for one effect. */
export type PlannedOutcome =
  | {
    readonly kind: "applied";
    readonly effect: SyncGatewayEffect;
    readonly rowNumber: Presence<number>;
    readonly receipt: PlannedReceipt;
    readonly created: boolean;
    readonly deletion: boolean;
  }
  | {
    readonly kind: "already_applied";
    readonly effect: SyncGatewayEffect;
    readonly rowNumber: Presence<number>;
    readonly receipt: PlannedReceipt;
  }
  | {
    readonly kind: "guard_mismatch";
    readonly effect: SyncGatewayEffect;
    readonly rowNumber: Presence<number>;
    readonly reason: string;
  }
  | {
    readonly kind: "repair_reobserve";
    readonly effect: SyncGatewayEffect;
    readonly rowNumber: Presence<number>;
    readonly reason: string;
  }
  | {
    readonly kind: "schema_error";
    readonly effect: SyncGatewayEffect;
    readonly rowNumber: Presence<number>;
    readonly reason: string;
  }
  | {
    readonly kind: "retryable_error";
    readonly effect: SyncGatewayEffect;
    readonly rowNumber: Presence<number>;
    readonly reason: string;
  };

/** Target mutation planned for one effect (only successful write outcomes). */
export type PlanMutation =
  | { readonly kind: "append"; readonly row: WorkingRow }
  | { readonly kind: "update"; readonly row: WorkingRow }
  | { readonly kind: "delete"; readonly row: WorkingRow };

/** Mutable working copy of one preflight row during planning. */
export interface WorkingRow {
  readonly rowNumber: number;
  readonly anchor: Presence<string>;
  readonly cells: Record<string, import("../../../../../domain/index.js").NormalizedCell>;
  readonly identity: Presence<string>;
  readonly appended: boolean;
  deleted: boolean;
  readonly writeFields: Record<string, import("../../../../../domain/index.js").NormalizedCell>;
}

/** Per-effect plan: outcome plus any mutation and receipt the batch needs. */
export interface EffectPlan {
  readonly outcome: PlannedOutcome;
  readonly mutation: PlanMutation | undefined;
  readonly receipt: PlannedReceipt | undefined;
  /** True when inline postcondition verification must re-read this write. */
  readonly verify: boolean;
}

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
    if (copy.anchor.kind === PRESENCE_KINDS.PRESENT) {
      byAnchor.set(copy.anchor.value, copy);
    }
    if (copy.identity.kind === PRESENCE_KINDS.PRESENT) {
      byIdentity.set(copy.identity.value, copy);
    }
  }
  const pendingReceipts = new Map<string, PlannedReceipt>();
  let nextAppendRow = context.nextAppendRow;

  for (const effect of request.effects) {
    requireGatewayEffect(effect, request, context);

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
export function requireGatewayEffect(
  effect: SyncGatewayEffect,
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

/** Receipt replay branch: a receipt already exists for this effect ID. */
function planReceiptReplay(
  effect: SyncGatewayEffect,
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

/** Validates the full-row deletion guard exactly like `validateDeletion_`. */
export function validateDeletion(
  context: PreflightContext,
  effect: SyncGatewayEffect,
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

/** Builds a receipt record exactly like `makeReceipt_`. */
export function makeReceipt(
  effect: SyncGatewayEffect,
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
  effect: SyncGatewayEffect,
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

function createWorkingRow(effect: SyncGatewayEffect, rowNumber: number): WorkingRow {
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

export function isDeletionEffect(effectKind: string): boolean {
  return effectKind === EFFECT_KINDS.RESOLUTION_DELETE ||
    effectKind === EFFECT_KINDS.USER_INPUT_DELETE;
}

function isSyncEffectKind(value: string): boolean {
  return value === "system_projection" ||
    value === "candidate_reconcile" ||
    value === "system_repair" ||
    value === "resolution_projection" ||
    value === EFFECT_KINDS.RESOLUTION_DELETE ||
    value === EFFECT_KINDS.USER_INPUT_DELETE;
}

/** Encodes a planned outcome as a gateway result (Apps Script `result_`). */
export function encodeOutcomeResult(outcome: PlannedOutcome): SyncGatewayEffectResult {
  switch (outcome.kind) {
    case "applied":
    case "already_applied":
      return {
        effectId: outcome.effect.effectId,
        payloadHash: outcome.effect.payloadHash,
        status: outcome.kind === "applied"
          ? SYNC_GATEWAY_EFFECT_RESULT_STATUSES.APPLIED
          : SYNC_GATEWAY_EFFECT_RESULT_STATUSES.ALREADY_APPLIED,
        visibleRevision: presentValue(outcome.receipt.visibleRevision),
        visibleHash: presentValue(outcome.receipt.visibleHash),
        snapshotHash: absentValue(),
        reason: absentValue(),
        postcondition: SYNC_GATEWAY_POSTCONDITION_STATUSES.VERIFIED,
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
        postcondition: SYNC_GATEWAY_POSTCONDITION_STATUSES.UNAVAILABLE,
      };
  }
}

/** Builds a schema_error result without any receipt-backed evidence. */
export function encodeSchemaErrorResult(
  effect: SyncGatewayEffect,
  reason: string,
): SyncGatewayEffectResult {
  return {
    effectId: effect.effectId,
    payloadHash: effect.payloadHash,
    status: SYNC_GATEWAY_EFFECT_RESULT_STATUSES.SCHEMA_ERROR,
    visibleRevision: absentValue(),
    visibleHash: absentValue(),
    snapshotHash: absentValue(),
    reason: presentValue(reason),
    postcondition: SYNC_GATEWAY_POSTCONDITION_STATUSES.UNAVAILABLE,
  };
}

/** Applies the deferred-mode postcondition relabeling for applied results. */
export function withDeferredPostcondition(
  result: SyncGatewayEffectResult,
): SyncGatewayEffectResult {
  if (
    (result.status === SYNC_GATEWAY_EFFECT_RESULT_STATUSES.APPLIED ||
      result.status === SYNC_GATEWAY_EFFECT_RESULT_STATUSES.ALREADY_APPLIED) &&
    result.postcondition === SYNC_GATEWAY_POSTCONDITION_STATUSES.VERIFIED
  ) {
    return { ...result, postcondition: SYNC_GATEWAY_POSTCONDITION_STATUSES.ACKNOWLEDGED };
  }
  return result;
}
