/**
 * Apply-effects operation for the Google Sheets API sync provider.
 *
 * Applies regular update/delete/create effects through one atomic batch:
 * schema-error effects sit before the included run, rejected plans
 * (guard/schema/repair outcomes) contribute no requests, inline mode
 * verifies written rows with a re-read, and deferred mode relies on the
 * atomic target+receipt batch. Response-loss recovery classifies effects
 * through a fresh target+receipt read.
 */

import type {
  ApplySyncEffectsRequest,
  ApplySyncEffectsResult,
  ReadSyncEffectPostconditionsRequest,
  SyncEffectPostcondition,
  SyncEffectPostconditionResult,
  SyncEffectResult,
  SyncProjectionEffect,
} from "../../../../../application/sync/sheets/syncSheets.js";
import { SYNC_POSTCONDITION_MODES } from "../../../../../application/sync/sheets/constants.js";
import { presentValue, absentValue } from "../../../../../shared/state/index.js";
import { GOOGLE_SHEETS_API_DEFAULTS, GOOGLE_SHEETS_API_EFFECT_REASONS } from "../constants.js";
import { invalidProviderRequest, invalidProviderState } from "../errors.js";
import type { PreflightContext, PreflightRow } from "../model/preflight.js";
import {
  currentHash,
  encodeOutcomeResult,
  encodeSchemaErrorResult,
  planEffectBatch,
  withDeferredPostcondition,
  type EffectPlan,
  type PlannedReceipt,
} from "../model/planner.js";
import {
  buildAppendBatchRequests,
  buildApplyBatchRequests,
  resolveApplyBatchBudget,
} from "../model/batchBuilder.js";
import { classifyPostcondition } from "../model/postcondition.js";
import {
  definitionForPhysicalSheet,
  effectRouteOptions,
  requireValidBatchUpdateReply,
  runWrite,
  validateRoute,
  type GoogleSheetsApiProviderDeps,
} from "./shared.js";
import { readPreflight } from "./preflightOp.js";

/** Applies regular update/delete/create effects through one atomic batch. */
export async function applyEffects(
  deps: GoogleSheetsApiProviderDeps,
  request: ApplySyncEffectsRequest,
): Promise<ApplySyncEffectsResult> {
  const definition = definitionForPhysicalSheet(deps, request.physicalSheetId);
  validateRoute(request, definition);
  if (request.effects.length === 0) {
    invalidProviderRequest("apply effects", "effects must not be empty");
  }
  const bounded = request.effects.slice(0, GOOGLE_SHEETS_API_DEFAULTS.MAX_EFFECTS_PER_REQUEST);
  const postconditionMode = request.postconditionMode ?? SYNC_POSTCONDITION_MODES.INLINE;
  if (
    postconditionMode !== SYNC_POSTCONDITION_MODES.INLINE &&
    postconditionMode !== SYNC_POSTCONDITION_MODES.DEFERRED
  ) {
    invalidProviderRequest("apply effects", "postconditionMode must be inline or deferred");
  }
  const routeOptions = effectRouteOptions(definition);
  const context = await readPreflight(deps, request, definition, routeOptions);
  const plans = planEffectBatch({ ...request, effects: bounded }, context);
  const includeReceipts = postconditionMode === SYNC_POSTCONDITION_MODES.DEFERRED;
  const updatedAt = new Date(deps.now()).toISOString();
  const resolution = resolveApplyBatchBudget(context, plans, {
    maxBatchBytes: deps.maxBatchBytes,
    includeReceipts,
    updatedAt,
  });
  const schemaErrorIndices = new Set(resolution.schemaErrorIndices);
  // Schema-error effects sit BEFORE the included run; the batch only carries
  // the plans after them, up to the resolved include count. The included
  // effects are re-planned so appended rows start at the sheet's first free
  // row (the full-plan row numbers would leave blank gaps for excluded
  // effects). The planner is deterministic over the unchanged context, so
  // outcomes and receipts are identical to the budget-resolution plans.
  const includedStart = resolution.schemaErrorIndices.length;
  const includedEffects = bounded.slice(includedStart, resolution.includeCount);
  const included = planEffectBatch({ ...request, effects: includedEffects }, context);
  if (included.length > 0) {
    const batch = buildApplyBatchRequests(context, included, { updatedAt, includeReceipts });
    // Rejected plans (guard/schema/repair outcomes) contribute no requests;
    // never send an empty batchUpdate for an all-rejected prefix.
    if (batch.requests.length > 0) {
      const response = await runWrite(deps, () =>
        deps.transport.batchUpdate({
          spreadsheetId: deps.spreadsheetId,
          requests: batch.requests,
        }));
      requireValidBatchUpdateReply(response, batch.requests.length);
    }
  }

  // Inline verification reads the written rows back and demotes any hash
  // mismatch to retryable_error, mirroring the Apps Script inline path. The
  // worker always uses deferred mode, where the atomic batch already carries
  // target mutations and receipts together.
  const verified = new Set<number>();
  if (postconditionMode === SYNC_POSTCONDITION_MODES.INLINE && included.length > 0) {
    const verifyContext = await readPreflight(deps, request, definition, routeOptions);
    included.forEach((plan, index) => {
      if (!plan.verify || plan.mutation === undefined || plan.mutation.kind === "delete") return;
      const row = findProbeRowInContext(verifyContext, plan);
      const current = row === undefined ? undefined : currentHash(row, plan.outcome.effect.payload.fields);
      if (current === plan.outcome.effect.payload.targetVisibleHash) {
        verified.add(index);
      }
    });
    const verifyReceipts: PlannedReceipt[] = [];
    included.forEach((plan, index) => {
      if (plan.receipt === undefined) return;
      // Replay receipts are already stored in the sheet; never rewrite them.
      if (context.receipts.has(plan.receipt.effectId)) return;
      if (plan.outcome.kind === "applied" && !plan.outcome.deletion && !verified.has(index)) return;
      verifyReceipts.push(plan.receipt);
    });
    if (verifyReceipts.length > 0) {
      const receiptBatch = buildAppendBatchRequests(context, [], verifyReceipts, { updatedAt });
      const response = await runWrite(deps, () =>
        deps.transport.batchUpdate({
          spreadsheetId: deps.spreadsheetId,
          requests: receiptBatch.requests,
        }));
      requireValidBatchUpdateReply(response, receiptBatch.requests.length);
    }
  }

  const results: SyncEffectResult[] = [];
  let includedCursor = 0;
  bounded.forEach((effect, index) => {
    if (schemaErrorIndices.has(index)) {
      results.push(
        encodeSchemaErrorResult(effect, GOOGLE_SHEETS_API_EFFECT_REASONS.EFFECT_PAYLOAD_TOO_LARGE),
      );
      return;
    }
    if (index >= resolution.includeCount) return;
    const planIndex = includedCursor;
    includedCursor += 1;
    const plan = included[planIndex];
    if (plan === undefined) return;
    let result = encodeOutcomeResult(plan.outcome);
    if (
      postconditionMode === SYNC_POSTCONDITION_MODES.INLINE &&
      plan.outcome.kind === "applied" &&
      !plan.outcome.deletion &&
      !verified.has(planIndex)
    ) {
      result = {
        ...result,
        status: "retryable_error",
        visibleRevision: absentValue(),
        visibleHash: absentValue(),
        reason: presentValue(GOOGLE_SHEETS_API_EFFECT_REASONS.POSTCONDITION_HASH_MISMATCH),
        postcondition: "unavailable",
      };
    } else if (postconditionMode === SYNC_POSTCONDITION_MODES.DEFERRED) {
      result = withDeferredPostcondition(result);
    }
    results.push(result);
  });
  return {
    results,
    snapshotHash: absentValue(),
    hasMore: bounded.length < request.effects.length || results.length < bounded.length,
  };
}

/** Classifies one response-loss effect through a fresh target+receipt read. */
export async function readEffectPostcondition(
  deps: GoogleSheetsApiProviderDeps,
  effect: SyncProjectionEffect,
): Promise<SyncEffectPostcondition> {
  const [result] = await readEffectPostconditions(deps, {
    physicalSheetId: effect.physicalSheetId,
    sheetName: effect.payload.sheetName,
    registeredRange: effect.payload.registeredRange,
    projection: effect.projection,
    schemaVersion: effect.payload.schemaVersion,
    effects: [effect],
  });
  if (result === undefined) {
    invalidProviderState("postcondition read returned no result");
  }
  return result.postcondition;
}

/** Classifies a recovery batch with one shared target+receipt read. */
export async function readEffectPostconditions(
  deps: GoogleSheetsApiProviderDeps,
  request: ReadSyncEffectPostconditionsRequest,
): Promise<readonly SyncEffectPostconditionResult[]> {
  const definition = definitionForPhysicalSheet(deps, request.physicalSheetId);
  validateRoute(request, definition);
  if (request.effects.length === 0) {
    invalidProviderRequest("postcondition reads", "effects must not be empty");
  }
  const routeOptions = effectRouteOptions(definition);
  const context = await readPreflight(deps, request, definition, routeOptions);
  return request.effects.map((effect) => ({
    effectId: effect.effectId,
    payloadHash: effect.payloadHash,
    postcondition: classifyPostcondition(context, effect, context.receipts),
  }));
}

/** Locates one planned write's row in a fresh verification context. */
function findProbeRowInContext(context: PreflightContext, plan: EffectPlan): PreflightRow | undefined {
  const mutation = plan.mutation;
  if (mutation === undefined) return undefined;
  if (mutation.kind === "append") {
    return context.rows.find((row) => row.rowNumber === mutation.row.rowNumber);
  }
  const anchor = mutation.row.anchor;
  if (anchor.kind === "present") {
    return context.rows.find((row) =>
      row.physicalAnchor.kind === "present" && row.physicalAnchor.value === anchor.value);
  }
  const identity = mutation.row.identity;
  if (identity.kind === "present") {
    return context.rows.find((row) =>
      row.identity.kind === "present" && row.identity.value === identity.value);
  }
  return undefined;
}
