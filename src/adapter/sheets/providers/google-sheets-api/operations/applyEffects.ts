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
} from "../../../../../application/sync/sheetsContract/syncSheets.js";
import { SYNC_POSTCONDITION_MODES } from "../../../../../application/sync/sheetsContract/constants.js";
import { presentValue, absentValue } from "../../../../../shared/state/index.js";
import { GOOGLE_SHEETS_API_DEFAULTS, GOOGLE_SHEETS_API_EFFECT_REASONS } from "../constants.js";
import { invalidProviderRequest, invalidProviderState } from "../errors.js";
import type { PreflightContext, PreflightRow } from "../model/preflightContext.js";
import { planEffectBatch } from "../model/planner.js";
import { currentHash } from "../model/plannerWorkingRow.js";
import {
  encodeOutcomeResult,
  encodeSchemaErrorResult,
  withDeferredPostcondition,
} from "../model/plannerReceipt.js";
import type { EffectPlan, PlannedReceipt } from "../model/plannerContracts.js";
import {
  buildAppendBatchRequests,
  buildApplyBatchRequests,
  buildCombinedApplyRequests,
  resolveApplyBatchBudget,
  resolveCombinedApplyBudget,
  type CombinedApplyRoute,
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
import { readPreflight, readPreflightForRoutes } from "./preflightOp.js";

/**
 * Derives the per-route identity of one provider effect so effects spanning
 * multiple tabs can be grouped and planned against their own tab context.
 */
export function effectRouteKey(effect: SyncProjectionEffect): string {
  return [
    effect.physicalSheetId,
    effect.projection,
    effect.payload.sheetName,
    effect.payload.registeredRange,
    effect.payload.schemaVersion,
  ].join("\u0000");
}

/** Applies regular update/delete/create effects through one atomic batch. */
export async function applyEffects(
  deps: GoogleSheetsApiProviderDeps,
  request: ApplySyncEffectsRequest,
): Promise<ApplySyncEffectsResult> {
  if (request.effects.length === 0) {
    invalidProviderRequest("apply effects", "effects must not be empty");
  }
  const postconditionMode = request.postconditionMode ?? SYNC_POSTCONDITION_MODES.INLINE;
  if (
    postconditionMode !== SYNC_POSTCONDITION_MODES.INLINE &&
    postconditionMode !== SYNC_POSTCONDITION_MODES.DEFERRED
  ) {
    invalidProviderRequest("apply effects", "postconditionMode must be inline or deferred");
  }
  const bounded = request.effects.slice(0, GOOGLE_SHEETS_API_DEFAULTS.MAX_EFFECTS_PER_REQUEST);
  const groups = groupEffectsByRoute(bounded);
  if (groups.length === 1) {
    return applyEffectsSingleRoute(deps, request, bounded, postconditionMode);
  }
  return applyEffectsMultiRoute(deps, request, bounded, groups, postconditionMode);
}

/** Groups effects by their own route, preserving per-route order. */
function groupEffectsByRoute(
  effects: readonly SyncProjectionEffect[],
): readonly (readonly SyncProjectionEffect[])[] {
  const groups = new Map<string, SyncProjectionEffect[]>();
  for (const effect of effects) {
    const key = effectRouteKey(effect);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [effect]);
    } else {
      group.push(effect);
    }
  }
  return [...groups.values()];
}

/**
 * Applies effects that all target ONE route (the common single-tab path),
 * byte-identical to the pre-batching provider.
 */
async function applyEffectsSingleRoute(
  deps: GoogleSheetsApiProviderDeps,
  request: ApplySyncEffectsRequest,
  bounded: readonly SyncProjectionEffect[],
  postconditionMode: "inline" | "deferred",
): Promise<ApplySyncEffectsResult> {
  const definition = definitionForPhysicalSheet(deps, request.physicalSheetId);
  validateRoute(request, definition);
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
  const includedStart = resolution.schemaErrorIndices.length;
  const includedEffects = bounded.slice(includedStart, resolution.includeCount);
  const included = planEffectBatch({ ...request, effects: includedEffects }, context);
  if (included.length > 0) {
    const batch = buildApplyBatchRequests(context, included, { updatedAt, includeReceipts });
    if (batch.requests.length > 0) {
      const response = await runWrite(deps, () =>
        deps.transport.batchUpdate({
          spreadsheetId: deps.spreadsheetId,
          requests: batch.requests,
        }));
      requireValidBatchUpdateReply(response, batch.requests.length);
    }
  }

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

/**
 * Applies effects spanning MULTIPLE tabs in ONE atomic batch: one sheet
 * enumeration, one ranged read across all needed tabs, one batchUpdate whose
 * requests target the different tabs' sheetIds. Each tab's effects are
 * planned and CAS-guarded against that tab's own preflight context.
 */
async function applyEffectsMultiRoute(
  deps: GoogleSheetsApiProviderDeps,
  request: ApplySyncEffectsRequest,
  bounded: readonly SyncProjectionEffect[],
  groups: readonly (readonly SyncProjectionEffect[])[],
  postconditionMode: "inline" | "deferred",
): Promise<ApplySyncEffectsResult> {
  if (postconditionMode === SYNC_POSTCONDITION_MODES.INLINE) {
    // The multi-route path cannot verify written rows or persist receipts
    // (it writes one atomic batch across tabs and has no single-tab re-read
    // loop). Accepting inline would acknowledge writes that were never
    // verified, so reject the unsafe path before any mutation or read.
    invalidProviderRequest(
      "apply effects",
      "multi-route apply does not support inline postcondition mode; use deferred",
    );
  }
  const includeReceipts = postconditionMode === SYNC_POSTCONDITION_MODES.DEFERRED;
  const updatedAt = new Date(deps.now()).toISOString();
  const routeSpecs = groups.map((group) => {
    const first = group[0]!;
    const definition = definitionForPhysicalSheet(deps, first.physicalSheetId);
    const subRequest: ApplySyncEffectsRequest = {
      physicalSheetId: first.physicalSheetId,
      sheetName: first.payload.sheetName,
      registeredRange: first.payload.registeredRange,
      projection: first.projection,
      schemaVersion: first.payload.schemaVersion,
      postconditionMode,
      effects: group,
    };
    validateRoute(subRequest, definition);
    return {
      subRequest,
      definition,
      routeOptions: effectRouteOptions(definition),
      group,
    };
  });
  const contexts = await readPreflightForRoutes(
    deps,
    routeSpecs.map((spec) => ({
      sheetName: spec.subRequest.sheetName,
      registeredRange: spec.subRequest.registeredRange,
      definition: spec.definition,
      routeOptions: spec.routeOptions,
    })),
  );
  const combinedRoutes: CombinedApplyRoute[] = routeSpecs.map((spec) => {
    const context = contexts.get(spec.subRequest.sheetName);
    if (context === undefined) {
      invalidProviderState(`preflight context is missing for ${spec.subRequest.sheetName}`);
    }
    return { context, plans: planEffectBatch(spec.subRequest, context) };
  });
  const resolution = resolveCombinedApplyBudget(combinedRoutes, {
    maxBatchBytes: deps.maxBatchBytes,
    includeReceipts,
    updatedAt,
  });
  // Schema-error effects sit before the included run; the included effects
  // are RE-PLANNED against each tab's context so they start at the first
  // free row instead of inheriting the oversized effect's skipped slot.
  const included = includedCombinedRoutes(
    combinedRoutes,
    routeSpecs,
    resolution.schemaErrorIndices.length,
    resolution.includeCount,
  );
  if (included.length > 0) {
    const batch = buildCombinedApplyRequests(included, { updatedAt, includeReceipts });
    if (batch.requests.length > 0) {
      const response = await runWrite(deps, () =>
        deps.transport.batchUpdate({
          spreadsheetId: deps.spreadsheetId,
          requests: batch.requests,
        }));
      requireValidBatchUpdateReply(response, batch.requests.length);
    }
  }

  const results: SyncEffectResult[] = [];
  // The combined budget and schema-error indices are in the flat GROUPED
  // plan order (route by route), not the original request order. Build the
  // result set by walking that grouped list so each result carries its own
  // effectId (the worker matches results byId, so order does not matter).
  const schemaErrorIndices = new Set(resolution.schemaErrorIndices);
  let flatIndex = 0;
  for (const route of combinedRoutes) {
    for (const plan of route.plans) {
      if (schemaErrorIndices.has(flatIndex)) {
        results.push(
          encodeSchemaErrorResult(plan.outcome.effect, GOOGLE_SHEETS_API_EFFECT_REASONS.EFFECT_PAYLOAD_TOO_LARGE),
        );
      } else if (flatIndex < resolution.includeCount) {
        let result = encodeOutcomeResult(plan.outcome);
        if (postconditionMode === SYNC_POSTCONDITION_MODES.DEFERRED) {
          result = withDeferredPostcondition(result);
        }
        results.push(result);
      }
      flatIndex += 1;
    }
  }
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
  if (request.effects.length === 0) {
    invalidProviderRequest("postcondition reads", "effects must not be empty");
  }
  const groups = groupEffectsByRoute(request.effects);
  const routes = groups.map((group) => {
    const first = group[0]!;
    const definition = definitionForPhysicalSheet(deps, first.physicalSheetId);
    const subRequest: ReadSyncEffectPostconditionsRequest = {
      physicalSheetId: first.physicalSheetId,
      sheetName: first.payload.sheetName,
      registeredRange: first.payload.registeredRange,
      projection: first.projection,
      schemaVersion: first.payload.schemaVersion,
      effects: group,
    };
    validateRoute(subRequest, definition);
    return { subRequest, definition, routeOptions: effectRouteOptions(definition), group };
  });
  const contexts = await readPreflightForRoutes(
    deps,
    routes.map((route) => ({
      sheetName: route.subRequest.sheetName,
      registeredRange: route.subRequest.registeredRange,
      definition: route.definition,
      routeOptions: route.routeOptions,
    })),
  );
  const results: SyncEffectPostconditionResult[] = [];
  for (const route of routes) {
    const context = contexts.get(route.subRequest.sheetName);
    if (context === undefined) {
      invalidProviderState(`preflight context is missing for ${route.subRequest.sheetName}`);
    }
    for (const effect of route.group) {
      results.push({
        effectId: effect.effectId,
        payloadHash: effect.payloadHash,
        postcondition: classifyPostcondition(context, effect, context.receipts),
      });
    }
  }
  return results;
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

/**
 * Builds the included route groups for a flat `[start, end)` window of
 * plans, re-planning each tab's included effects against its context so
 * schema-error effects that sit before the included run are excluded and
 * the included writes start at the first free row.
 */
function includedCombinedRoutes(
  combinedRoutes: readonly CombinedApplyRoute[],
  routeSpecs: ReadonlyArray<{
    readonly subRequest: ApplySyncEffectsRequest;
    readonly group: readonly SyncProjectionEffect[];
  }>,
  start: number,
  end: number,
): readonly CombinedApplyRoute[] {
  const result: CombinedApplyRoute[] = [];
  let flat = 0;
  for (let index = 0; index < combinedRoutes.length; index += 1) {
    const route = combinedRoutes[index]!;
    const routeEnd = flat + route.plans.length;
    const lo = Math.max(start, flat);
    const hi = Math.min(end, routeEnd);
    if (hi > lo) {
      const spec = routeSpecs[index]!;
      const subRequest: ApplySyncEffectsRequest = {
        ...spec.subRequest,
        effects: spec.group.slice(lo - flat, hi - flat),
      };
      result.push({ context: route.context, plans: planEffectBatch(subRequest, route.context) });
    }
    flat = routeEnd;
  }
  return result;
}
