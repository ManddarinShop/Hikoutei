/**
 * Apply-effects operations for the Google Sheets API sync provider.
 *
 * Applies regular update/delete/create effects through one atomic batch:
 * schema-error effects sit before the included run, rejected plans
 * (guard/schema/repair outcomes) contribute no requests, inline mode
 * verifies written rows with a re-read, and deferred mode relies on the
 * atomic target+receipt batch. Response-loss recovery classifies effects
 * through a scoped band read of the probed rows plus the cursor-banded
 * receipts, falling back to the historical whole-table + full-receipt read
 * whenever the band evidence cannot decide (see
 * `readEffectPostconditions`).
 *
 * The flow is split into a `preflightApplyEffects` read+plan stage and an
 * `applyPreparedEffects` write+verify stage so a read-ahead worker can run
 * one route's preflight concurrently with another route's write. The legacy
 * `applyEffects` wrapper keeps calling the two stages in order, so its
 * behavior is byte-identical to a single combined call.
 */

import type {
  ApplySyncEffectsRequest,
  ApplySyncEffectsResult,
  PreparedApplyEffects,
  ReadSyncEffectPostconditionsRequest,
  SyncEffectPostcondition,
  SyncEffectPostconditionResult,
  SyncEffectResult,
  SyncProjectionEffect,
} from "@hikoutei/contracts/sheets/syncSheets.js";
import { SYNC_POSTCONDITION_MODES } from "@hikoutei/contracts/sheets/constants.js";
import {
  SYNC_INVALID_PROVIDER_OPERATIONS,
  SYNC_INVALID_PROVIDER_REASONS,
} from "@hikoutei/contracts/sheets/errors.js";
import type { RegisteredSyncProjectionDefinition } from "@hikoutei/contracts/sheets/sheetsProvisioning.js";
import type { Presence } from "@hikoutei/contracts/state/index.js";
import { presentValue, absentValue, PRESENCE_KINDS } from "@hikoutei/contracts/state/index.js";
import { GOOGLE_SHEETS_API_DEFAULTS, GOOGLE_SHEETS_API_EFFECT_REASONS } from "../constants.js";
import { GOOGLE_SHEETS_API_PREFLIGHT_BASE_FIELDS, GOOGLE_SHEETS_API_PREFLIGHT_FIELDS } from "../model/preflightFields.js";
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
import { classifyPostcondition, probeTargetRowNumber } from "../model/postcondition.js";
import {
  definitionForPhysicalSheet,
  effectRouteOptions,
  requireValidBatchUpdateReply,
  runWrite,
  validateRoute,
  type GoogleSheetsApiProviderDeps,
} from "./shared.js";
import {
  enumeratePreflightSheets,
  readPreflight,
  readPreflightDataForEnumeratedRoutes,
  readPreflightForRoutes,
  refreshReceiptForWrite,
  verifyPreflightContexts,
  type PreflightRouteInput,
  type PreflightVerifyPass,
} from "./preflightOp.js";

/**
 * Derived per-route identity of one provider effect so effects spanning
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

/**
 * Read+plan state for a SINGLE-route batch, produced by the preflight stage.
 *
 * Carries every validated route/plan/context/evidence the write+verify stage
 * needs so `applyPreparedEffects` never re-reads the sheet. The `kind`
 * discriminant is shared with the provider boundary; the rest is provider
 * internal and never crosses the dispatcher boundary. The `spreadsheetId`
 * binds this prepared state to the exact provider instance/spreadsheet that
 * produced it so a foreign or stale token is rejected before any write.
 */
export interface PreparedSingleRouteApply extends PreparedApplyEffects {
  readonly kind: "single";
  readonly spreadsheetId: string;
  /** Per-instance provider nonce that produced this state (see deps). */
  readonly providerNonce: string;
  readonly request: ApplySyncEffectsRequest;
  readonly postconditionMode: "inline" | "deferred";
  readonly bounded: readonly SyncProjectionEffect[];
  readonly definition: RegisteredSyncProjectionDefinition;
  readonly routeOptions: {
    readonly identityField: Presence<string>;
    readonly checkboxHeaders: readonly string[];
  };
  readonly context: PreflightContext;
  readonly includeCount: number;
  readonly schemaErrorIndices: readonly number[];
  /** Plans for the included prefix, re-planned against the preflight context. */
  readonly included: readonly EffectPlan[];
  /** Receipt timestamp resolved at preflight so budget and write agree. */
  readonly updatedAt: string;
}

/**
 * Read+plan state for a MULTI-route (combined-tab) batch, produced by the
 * preflight phase. The multi-route path supports only deferred receipts.
 * The `spreadsheetId` binds this prepared state to the exact provider
 * instance/spreadsheet that produced it.
 */
export interface PreparedMultiRouteApply extends PreparedApplyEffects {
  readonly kind: "multi";
  readonly spreadsheetId: string;
  /** Per-instance provider nonce that produced this state (see deps). */
  readonly providerNonce: string;
  readonly request: ApplySyncEffectsRequest;
  readonly postconditionMode: "deferred";
  readonly bounded: readonly SyncProjectionEffect[];
  readonly combinedRoutes: readonly CombinedApplyRoute[];
  readonly includeCount: number;
  readonly schemaErrorIndices: readonly number[];
  /** Included routes re-planned against each tab's context for the write. */
  readonly included: readonly CombinedApplyRoute[];
  /** Receipt timestamp written at preflight time so budget and write agree. */
  readonly updatedAt: string;
}

/** Concrete prepared-apply state narrowed by the runtime `kind` guard. */
export type PreparedApplyEffectsState = PreparedSingleRouteApply | PreparedMultiRouteApply;

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

/** Validates and bounds one apply request into its per-route groups. */
function prepareApplyRequest(
  deps: GoogleSheetsApiProviderDeps,
  request: ApplySyncEffectsRequest,
): {
  readonly postconditionMode: "inline" | "deferred";
  readonly bounded: readonly SyncProjectionEffect[];
  readonly groups: readonly (readonly SyncProjectionEffect[])[];
} {
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
  return { postconditionMode, bounded, groups };
}

/**
 * Read+plan stage of one apply request. Performs the paced reads and the
 * planner/budget work and returns opaque prepared state that
 * `applyPreparedEffects` consumes. No remote mutation happens here.
 */
export async function preflightApplyEffects(
  deps: GoogleSheetsApiProviderDeps,
  request: ApplySyncEffectsRequest,
): Promise<PreparedApplyEffects> {
  const prepared = prepareApplyRequest(deps, request);
  let state: PreparedApplyEffects;
  if (prepared.groups.length === 1) {
    state = await preflightSingleRoute(deps, request, prepared);
  } else {
    state = await preflightMultiRoute(deps, request, prepared);
  }
  // Register the exact produced state so the write+verify stage can reject a
  // forged or replaced nested plan by identity before any remote call.
  deps.preparedStateRegistry.add(state);
  return state;
}

/** Write+verify stage of one apply batch, consuming preflight prepared state. */
export async function applyPreparedEffects(
  deps: GoogleSheetsApiProviderDeps,
  prepared: PreparedApplyEffects,
): Promise<ApplySyncEffectsResult> {
  const state = asPreparedApplyState(prepared);
  // Bind the prepared state to the exact provider instance/spreadsheet that
  // produced it: a token prepared by a different spreadsheet (or a stale
  // token replayed after the provider was re-pointed) must fail closed before
  // any write.
  if (state.spreadsheetId !== deps.spreadsheetId) {
    invalidProviderState("prepared apply effects state is bound to a different spreadsheet");
  }
  if (state.providerNonce !== deps.providerNonce) {
    invalidProviderState("prepared apply effects state is bound to a different provider instance");
  }
  if (!deps.preparedStateRegistry.has(state)) {
    invalidProviderState("prepared apply effects state was not produced by this provider");
  }
  // One-shot consumption: remove the state from the registry on first apply so
  // a replayed or concurrently reused prepared token cannot re-run the same
  // stale plan (duplicate append or delete the next row). The has+delete pair
  // is synchronous, so two concurrent applies cannot both pass the check.
  deps.preparedStateRegistry.delete(state);
  if (state.kind === "single") {
    return applyPreparedSingleRoute(deps, state);
  }
  return applyPreparedMultiRoute(deps, state);
}

/**
 * Runtime-narrows an opaque `PreparedApplyEffects` to the concrete provider
 * state over `unknown` with a type predicate (no untyped double cast).
 * Validates the `kind` discriminant and the essential nested state each kind
 * must carry so a malformed, stale, or foreign prepared token fails closed
 * before any write. The `spreadsheetId` binding is checked by the caller
 * against the active provider instance.
 */
function asPreparedApplyState(value: unknown): PreparedApplyEffectsState {
  if (isPreparedSingleRouteApply(value)) return value;
  if (isPreparedMultiRouteApply(value)) return value;
  invalidProviderState("unrecognized prepared apply effects state");
}

/** Type predicate for the concrete single-route prepared-apply state. */
function isPreparedSingleRouteApply(value: unknown): value is PreparedSingleRouteApply {
  return isRecord(value) &&
    value.kind === "single" &&
    typeof value.spreadsheetId === "string" &&
    typeof value.providerNonce === "string" &&
    isRecord(value.request) &&
    Array.isArray(value.bounded) &&
    isRecord(value.context) &&
    Array.isArray(value.included) &&
    typeof value.updatedAt === "string";
}

/** Type predicate for the concrete multi-route prepared-apply state. */
function isPreparedMultiRouteApply(value: unknown): value is PreparedMultiRouteApply {
  return isRecord(value) &&
    value.kind === "multi" &&
    typeof value.spreadsheetId === "string" &&
    typeof value.providerNonce === "string" &&
    isRecord(value.request) &&
    Array.isArray(value.bounded) &&
    Array.isArray(value.combinedRoutes) &&
    Array.isArray(value.included) &&
    typeof value.updatedAt === "string";
}

/** True for a non-array object value. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Applies regular update/delete/create effects through one atomic batch. */
export async function applyEffects(
  deps: GoogleSheetsApiProviderDeps,
  request: ApplySyncEffectsRequest,
): Promise<ApplySyncEffectsResult> {
  return applyPreparedEffects(deps, await preflightApplyEffects(deps, request));
}

/** Read+plan stage for a single-tab batch. */
async function preflightSingleRoute(
  deps: GoogleSheetsApiProviderDeps,
  request: ApplySyncEffectsRequest,
  prepared: {
    readonly postconditionMode: "inline" | "deferred";
    readonly bounded: readonly SyncProjectionEffect[];
  },
): Promise<PreparedSingleRouteApply> {
  const definition = definitionForPhysicalSheet(deps, request.physicalSheetId);
  validateRoute(request, definition);
  const routeOptions = effectRouteOptions(definition);
  // Historical single paced data read (enumeration + one whole-table
  // full-evidence read): the apply path keeps the committed request budget.
  // The only steady-state reduction here is the receipt tab, read through
  // the provider's tail-band cursor inside the SAME request (see
  // `ReceiptReadCursor` and the cumulative receipt memo).
  const context = await readPreflight(deps, request, definition, routeOptions);
  const plans = planEffectBatch({ ...request, effects: prepared.bounded }, context);
  const includeReceipts = prepared.postconditionMode === SYNC_POSTCONDITION_MODES.DEFERRED;
  const updatedAt = new Date(deps.now()).toISOString();
  const resolution = resolveApplyBatchBudget(context, plans, {
    maxBatchBytes: deps.maxBatchBytes,
    includeReceipts,
    updatedAt,
  });
  const includedStart = resolution.schemaErrorIndices.length;
  const includedEffects = prepared.bounded.slice(includedStart, resolution.includeCount);
  const included = planEffectBatch({ ...request, effects: includedEffects }, context);
  return {
    kind: "single",
    spreadsheetId: deps.spreadsheetId,
    providerNonce: deps.providerNonce,
    request,
    postconditionMode: prepared.postconditionMode,
    bounded: prepared.bounded,
    definition,
    routeOptions,
    context,
    includeCount: resolution.includeCount,
    schemaErrorIndices: resolution.schemaErrorIndices,
    included,
    updatedAt,
  };
}

/** Write+verify stage for a single-tab batch. */
async function applyPreparedSingleRoute(
  deps: GoogleSheetsApiProviderDeps,
  prepared: PreparedSingleRouteApply,
): Promise<ApplySyncEffectsResult> {
  const {
    request,
    postconditionMode,
    bounded,
    definition,
    routeOptions,
    context,
    includeCount,
    schemaErrorIndices,
    included,
    updatedAt,
  } = prepared;
  const includeReceipts = postconditionMode === SYNC_POSTCONDITION_MODES.DEFERRED;
  // Writes one target+receipt batch against `ctx`. Extracted so the shared
  // receipt-tab initialization guard (see below) can wrap refresh+write as
  // one atomic unit.
  const writeTarget = async (ctx: PreflightContext): Promise<void> => {
    if (included.length === 0) return;
    const batch = buildApplyBatchRequests(ctx, included, { updatedAt, includeReceipts });
    if (batch.requests.length === 0) return;
    const response = await runWrite(deps, () =>
      deps.transport.batchUpdate({
        spreadsheetId: deps.spreadsheetId,
        requests: batch.requests,
      }), {
      requestCount: batch.requests.length,
      bodyBytes: batch.bytes,
      requestedEffects: request.effects.length,
      includedEffects: included.length,
    });
    requireValidBatchUpdateReply(response, batch.requests.length);
  };
  // A read-ahead preflight may have observed the shared receipt tab before a
  // concurrent write created it. Two stale preflights (possibly on different
  // routes of the same spreadsheet) would otherwise both re-read the tab as
  // absent and both emit a duplicate addSheet. Serialize refresh + the batch
  // that creates the tab on the per-spreadsheet receipt-init lock so the
  // first writer creates it and later writers refresh to see it present and
  // append instead. Steady state (receipt present at preflight) never takes
  // this lock.
  // Runs the target write, the inline verify read, and the inline receipt
  // follow-up against `ctx`, returning the context used for receipt writes
  // and the set of verified plan indices. Extracted so the shared
  // receipt-tab initialization guard (below) can wrap refresh + EVERY
  // receipt-creating write (target and follow-up) as one atomic unit: in
  // inline mode the follow-up is the only write that creates the receipt tab,
  // so it must run under the same lock as the refresh that re-checks it.
  const writeAndVerify = async (ctx: PreflightContext): Promise<{
    readonly writeContext: PreflightContext;
    readonly verified: ReadonlySet<number>;
  }> => {
    await writeTarget(ctx);
    const verified = new Set<number>();
    // The inline verify read is the tail of the write: it re-reads the
    // just-written row, so it is paced on the WRITE limiter (serializes
    // against writes) rather than competing with the read burst. It only runs
    // when at least one included plan needs verification (a non-deletion
    // write); a deletion-only batch skips the read entirely.
    if (postconditionMode === SYNC_POSTCONDITION_MODES.INLINE && included.some((plan) => plan.verify)) {
      // The inline verify is the historical whole-table full-evidence read
      // (paced on the WRITE lane, receipt tab still read through the cursor
      // in the same request): the just-written row's values and both
      // number-format sources come from one snapshot, exactly like before
      // the payload-reduction work.
      const verifyContext = await readPreflight(deps, request, definition, routeOptions, "write");
      included.forEach((plan, index) => {
        if (!plan.verify || plan.mutation === undefined || plan.mutation.kind === "delete") return;
        const row = findProbeRowInContext(verifyContext, plan);
        const current = row === undefined ? undefined : currentHash(row, plan.outcome.effect.payload.fields);
        if (current === plan.outcome.effect.payload.targetVisibleHash) {
          verified.add(index);
        }
      });
    }
    // Receipt handling still runs for deletion receipts even when no plan needs
    // verification: deletions don't verify but still persist their receipt.
    if (postconditionMode === SYNC_POSTCONDITION_MODES.INLINE && included.length > 0) {
      const verifyReceipts: PlannedReceipt[] = [];
      included.forEach((plan, index) => {
        if (plan.receipt === undefined) return;
        if (ctx.receipts.has(plan.receipt.effectId)) return;
        if (plan.outcome.kind === "applied" && !plan.outcome.deletion && !verified.has(index)) return;
        verifyReceipts.push(plan.receipt);
      });
      if (verifyReceipts.length > 0) {
        const receiptBatch = buildAppendBatchRequests(ctx, [], verifyReceipts, { updatedAt });
        const response = await runWrite(deps, () =>
          deps.transport.batchUpdate({
            spreadsheetId: deps.spreadsheetId,
            requests: receiptBatch.requests,
          }), {
          requestCount: receiptBatch.requests.length,
          bodyBytes: receiptBatch.bytes,
          requestedEffects: 0,
          includedEffects: verifyReceipts.length,
        });
        requireValidBatchUpdateReply(response, receiptBatch.requests.length);
      }
    }
    return { writeContext: ctx, verified };
  };
  // A read-ahead preflight may have observed the shared receipt tab before a
  // concurrent write created it. Two stale preflights (possibly on different
  // routes of the same spreadsheet) would otherwise both re-read the tab as
  // absent and both emit a duplicate addSheet. Serialize refresh + the batch
  // that creates the tab on the per-spreadsheet receipt-init lock so the
  // first writer creates it and later writers refresh to see it present and
  // append instead. Steady state (receipt present at preflight) never takes
  // this lock.
  //
  // Applying the prepared plans from the preflight-time context is safe by
  // construction for provider-mediated writes:
  // - Same route: the write stage runs under one coordinator mutation lane
  //   (`runSerializedInner` for the dispatcher, and
  //   `CoordinatedSheetsProvider.applyPreparedEffects` acquires the lanes
  //   itself for direct callers), and the worker never preflights a same-route
  //   unit ahead of an in-flight same-route write, so a same-route context
  //   cannot be invalidated between preflight and write.
  // - Different routes: provisioning forbids two definitions on one tab
  //   (duplicate tab names are rejected), so concurrent cross-route writes
  //   target DISJOINT tabs and cannot shift this route's target rows; the only
  //   shared structure is the receipt tab, whose appends reserve rows with
  //   insertDimension (shift, not overwrite) so an out-of-order cross-route
  //   receipt append cannot destroy an earlier receipt.
  // - Shared receipt tab absent at preflight: handled by the refresh under
  //   this lock, and the receipt-dedup below (`ctx.receipts.has`) honors the
  //   refreshed receipt state before any receipt write.
  // A stale plan can therefore only diverge through an OUT-OF-BAND sheet edit
  // (a human editing the tab directly), which races identically in the legacy
  // sequential `applyEffects` path (its preflight-to-write window exists
  // there too) and is classified after the fact by the deferred
  // postcondition/receipt evidence; a fresh in-lane re-read per write would
  // double write-path remote reads and break the counted lease-headroom
  // bound, so it is deliberately not added here.
  // If no included plan can write (every bounded effect was a schema error),
  // there is no receipt-producing write to protect: skip the receipt-init
  // refresh and lock entirely and return the per-effect schema-error results
  // below without any write-side refresh. The same guard covers a
  // deterministic no-op included set (every plan is a guard mismatch or
  // repair-reobserve: no mutation and no receipt): the refresh's write-lane
  // admission can be REFUSED under saturation, and that refusal must not
  // turn a deterministic no-op into a delivery-uncertain requeue.
  const persistsReceiptOrWrite = included.some((plan) =>
    plan.mutation !== undefined || plan.receipt !== undefined);
  const { writeContext, verified } =
    included.length > 0 &&
      persistsReceiptOrWrite &&
      context.receiptSheetId.kind === PRESENCE_KINDS.ABSENT
      ? await deps.receiptInitLock.run(async () => {
          const refreshed = await refreshReceiptForWrite(deps, context);
          return writeAndVerify(refreshed);
        })
      : await writeAndVerify(context);

  const schemaErrorIndexSet = new Set(schemaErrorIndices);
  const results: SyncEffectResult[] = [];
  let includedCursor = 0;
  bounded.forEach((effect, index) => {
    if (schemaErrorIndexSet.has(index)) {
      results.push(
        encodeSchemaErrorResult(effect, GOOGLE_SHEETS_API_EFFECT_REASONS.EFFECT_PAYLOAD_TOO_LARGE),
      );
      return;
    }
    if (index >= includeCount) return;
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

/** Read+plan stage for a multi-tab batch. */
async function preflightMultiRoute(
  deps: GoogleSheetsApiProviderDeps,
  request: ApplySyncEffectsRequest,
  prepared: {
    readonly postconditionMode: "inline" | "deferred";
    readonly bounded: readonly SyncProjectionEffect[];
    readonly groups: readonly (readonly SyncProjectionEffect[])[];
  },
): Promise<PreparedMultiRouteApply> {
  if (prepared.postconditionMode === SYNC_POSTCONDITION_MODES.INLINE) {
    // The multi-route path cannot verify written rows or persist receipts
    // (it writes one atomic batch across tabs and has no single-tab re-read
    // loop). Accepting inline would acknowledge writes that were never
    // verified, so reject the unsafe path before any mutation or read.
    invalidProviderRequest(
      "apply effects",
      "multi-route apply does not support inline postcondition mode; use deferred",
    );
  }
  const { postconditionMode } = prepared;
  const includeReceipts = postconditionMode === SYNC_POSTCONDITION_MODES.DEFERRED;
  const updatedAt = new Date(deps.now()).toISOString();
  const routeSpecs = prepared.groups.map((group) => {
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
  const routeArgs = routeSpecs.map((spec) => ({
    sheetName: spec.subRequest.sheetName,
    registeredRange: spec.subRequest.registeredRange,
    definition: spec.definition,
    routeOptions: spec.routeOptions,
  }));
  // Historical shared whole-table full-evidence read (enumeration + ONE
  // ranged data read); the receipt tab rides the provider's tail-band
  // cursor inside the same request.
  const contexts = await readPreflightForRoutes(deps, routeArgs);
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
  return {
    kind: "multi",
    spreadsheetId: deps.spreadsheetId,
    providerNonce: deps.providerNonce,
    request,
    postconditionMode: "deferred",
    bounded: prepared.bounded,
    combinedRoutes,
    includeCount: resolution.includeCount,
    schemaErrorIndices: resolution.schemaErrorIndices,
    included,
    updatedAt,
  };
}

/** Write+verify stage for a multi-tab batch. */
async function applyPreparedMultiRoute(
  deps: GoogleSheetsApiProviderDeps,
  prepared: PreparedMultiRouteApply,
): Promise<ApplySyncEffectsResult> {
  const { request, bounded, combinedRoutes, includeCount, schemaErrorIndices, included, updatedAt } = prepared;
  // The shared receipt tab may have been created by a concurrent route's
  // write after this multi-route preflight observed it absent. When the
  // first tab's preflight saw the tab absent, serialize refresh + the
  // combined batch (which creates or appends to the tab) on the
  // per-spreadsheet receipt-init lock so two stale preflights on the same
  // spreadsheet cannot both emit a duplicate addSheet; steady state (the tab
  // present at preflight) never takes this lock.
  // Same deterministic-no-op guard as the single-route stage: a combined
  // batch whose included plans carry no mutation and no receipt writes
  // nothing, so it must not take the receipt-init refresh (whose write-lane
  // admission can be refused) or its lock.
  const persistsReceiptOrWrite = included.some((route) =>
    route.plans.some((plan) => plan.mutation !== undefined || plan.receipt !== undefined));
  const needsReceiptInit = included[0]?.context.receiptSheetId.kind === PRESENCE_KINDS.ABSENT &&
    persistsReceiptOrWrite;
  const writeIncluded = needsReceiptInit
    ? await deps.receiptInitLock.run(() =>
        refreshMultiRouteReceiptAndWrite(deps, included, updatedAt, true, request.effects.length))
    : await refreshMultiRouteReceiptAndWrite(deps, included, updatedAt, false, request.effects.length);

  const results: SyncEffectResult[] = [];
  // The combined budget and schema-error indices are in the flat GROUPED
  // plan order (route by route), not the original request order. Build the
  // result set by walking that grouped list so each result carries its own
  // effectId (the worker matches results byId, so order does not matter).
  const schemaErrorIndicesSet = new Set(schemaErrorIndices);
  let flatIndex = 0;
  for (const route of combinedRoutes) {
    for (const plan of route.plans) {
      if (schemaErrorIndicesSet.has(flatIndex)) {
        results.push(
          encodeSchemaErrorResult(plan.outcome.effect, GOOGLE_SHEETS_API_EFFECT_REASONS.EFFECT_PAYLOAD_TOO_LARGE),
        );
      } else if (flatIndex < includeCount) {
        results.push(withDeferredPostcondition(encodeOutcomeResult(plan.outcome)));
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

/**
 * Classifies a recovery batch with ONE scoped target-band + receipt-band read.
 *
 * The probe consumer (`classifyPostcondition`) only ever inspects the row
 * `findProbeRow` locates by anchor/identity, and that row's receipt. So the
 * read is scoped like the steady-state fast-append base: header + tab-wide
 * key-column bands (single ranged, cursor-banded receipt request), then ONE
 * format-evidenced row-band verification read for the located rows. The
 * historical whole-table full-evidence + FULL-receipt read runs unchanged
 * whenever the band evidence cannot decide:
 * - the receipt coverage of THIS dispatch is genuinely unknown: the cursor
 *   was live before the base read but went absent DURING it (the memo
 *   over-capacity drop is the only such path, and it leaves this dispatch's
 *   parsed receipts partial). A live cursor after the read proves COMPLETE
 *   coverage — the append-only tab plus the sentinel-trusted band merged
 *   into the cumulative memo, or an untrusted band was already settled by
 *   the model's own in-read full receipt parse — so a missing receipt is
 *   provable and classifies `unapplied` from the band alone. A cold cursor
 *   is provable too: its base read ran the full receipt parse. Deciding a
 *   provable miss through the full fallback was the drain blocker: the
 *   whole-table read is what times out at scale, the timeout does not reset
 *   the cursor, and every redrive probe repeated it, leaving
 *   delivery-uncertain heads permanently blocking;
 * - any route deferred its identity duplicate/format evidence to the
 *   verification pass (`identityNeedsFormatEvidence`): a landed create could
 *   be located under a format-dependent identity string and hashed from
 *   partial base cells, which only the whole-table read resolves exactly;
 * - a route's band plan overflows the shared range budget (handled INSIDE
 *   `verifyPreflightContexts` by one consolidated whole-table full-evidence
 *   read from the same enumeration).
 * At scale the whole-table fallback read is what times out today (target tabs
 * past ~80k rows / ~110k receipts exceeded the 10s read budget with the
 * full-evidence mask); it stays the correctness answer for the unknown-
 * coverage gaps above, the scoped bands are the throughput fix.
 */
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
  const routeInputs: readonly PreflightRouteInput[] = routes.map((route) => ({
    sheetName: route.subRequest.sheetName,
    registeredRange: route.subRequest.registeredRange,
    definition: route.definition,
    routeOptions: route.routeOptions,
  }));
  // Capture the cursor posture BEFORE any probe read. A live pre-read cursor
  // that is ABSENT again after the base read means the dispatch lost its
  // cumulative memo mid-read (the over-capacity drop), so this dispatch's
  // parsed receipts are partial and only the full fallback may decide a
  // miss. Every other posture is complete: a cold base read performed the
  // historical full receipt parse, and a still-live cursor means the
  // sentinel-trusted band merged into (or the model already settled with) a
  // full parse — under append-only growth the memo then covers every row.
  const coverageIsBanded = deps.receiptReadCursor.bandStartRow() !== undefined;
  // The probe verifies a just-written row, so every read is paced on the
  // WRITE limiter (serializes against writes), exactly like the historical
  // probe read. ONE enumeration is shared by the base read, the band
  // verification, and any whole-table fallback so a fallback can never stack
  // a second enumeration onto the leased request budget.
  const sheets = await enumeratePreflightSheets(deps, "write");
  const baseContexts = await readPreflightDataForEnumeratedRoutes(
    deps,
    sheets,
    routeInputs,
    SYNC_INVALID_PROVIDER_OPERATIONS.POSTCONDITION_READ,
    "write",
    GOOGLE_SHEETS_API_PREFLIGHT_BASE_FIELDS,
    { scoped: true },
  );
  const probeContexts = routes.map((route) => requireProbeContext(baseContexts, route));
  // A pre-read band that lost its cursor mid-read (capacity drop) leaves
  // genuinely unknown coverage: a receipt miss may simply sit below the
  // dropped memo. Anything else has complete coverage, so a miss is
  // provable and the band decides it (see the docblock above).
  const receiptMissIsProvable =
    !coverageIsBanded || deps.receiptReadCursor.bandStartRow() !== undefined;
  const bandEvidenceSufficient =
    !probeContexts.some((context) => context.identityNeedsFormatEvidence) &&
    (receiptMissIsProvable || routes.every((route, index) =>
      route.group.every((effect) => probeContexts[index]!.receipts.has(effect.effectId))));
  let contexts: readonly PreflightContext[];
  if (bandEvidenceSufficient) {
    contexts = await verifyPreflightContexts(
      deps,
      routes.map((route, index): PreflightVerifyPass => ({
        context: probeContexts[index]!,
        // Locate each effect's row against the base key-column indexes; the
        // verification read re-fetches those rows full-width WITH formats so
        // every hashed cell's value and both format sources share one
        // snapshot (same contract as the steady-state scoped base read).
        targetRowNumbers: route.group
          .map((effect) => probeTargetRowNumber(probeContexts[index]!, effect))
          .filter((row): row is number => row !== undefined),
        route: routeInputs[index]!,
      })),
      sheets,
      "write",
    );
  } else {
    // Band evidence cannot decide (see the gate above): run the historical
    // probe read UNCHANGED — whole-table full-evidence target ranges plus
    // the FULL `A1:F1048576` receipt read (no cursor), paced on the write
    // lane and built from the SAME enumeration.
    const fullContexts = await readPreflightDataForEnumeratedRoutes(
      deps,
      sheets,
      routeInputs,
      SYNC_INVALID_PROVIDER_OPERATIONS.POSTCONDITION_READ,
      "write",
      GOOGLE_SHEETS_API_PREFLIGHT_FIELDS,
      { scoped: false, receiptCursor: false },
    );
    contexts = routes.map((route) => requireProbeContext(fullContexts, route));
  }
  const results: SyncEffectPostconditionResult[] = [];
  for (const [index, route] of routes.entries()) {
    const context = contexts[index]!;
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

/** Resolves one route's probe context, failing closed on a missing tab. */
function requireProbeContext(
  contexts: ReadonlyMap<string, PreflightContext>,
  route: { readonly subRequest: { readonly sheetName: string } },
): PreflightContext {
  const context = contexts.get(route.subRequest.sheetName);
  if (context === undefined) {
    invalidProviderState(
      `preflight context is missing for ${route.subRequest.sheetName}`,
      {
        operation: SYNC_INVALID_PROVIDER_OPERATIONS.POSTCONDITION_READ,
        reason: SYNC_INVALID_PROVIDER_REASONS.MISSING_TAB,
      },
    );
  }
  return context;
}

/**
 * Refreshes the shared receipt tab (when a preflight observed it absent) and
 * writes the combined multi-tab batch. Called under the per-spreadsheet
 * receipt-init lock so concurrent writes on the same spreadsheet cannot both
 * emit a duplicate addSheet. Returns the routes with their refreshed
 * contexts (the first tab's context now carries the receipt when present).
 */
async function refreshMultiRouteReceiptAndWrite(
  deps: GoogleSheetsApiProviderDeps,
  included: readonly CombinedApplyRoute[],
  updatedAt: string,
  // Passed from the caller's receipt-init decision so a deterministic no-op
  // batch skips the write-lane refresh entirely (see applyPreparedMultiRoute).
  needsReceiptInit: boolean,
  // Effects requested for the whole apply request (the original request
  // length, not the budget-fitting included prefix).
  requestedEffects: number,
): Promise<readonly CombinedApplyRoute[]> {
  const first = included[0];
  let writeIncluded = included;
  if (first !== undefined && needsReceiptInit) {
    const refreshed = await refreshReceiptForWrite(deps, first.context);
    writeIncluded = included.map((route, index) => (index === 0 ? { ...route, context: refreshed } : route));
  }
  if (writeIncluded.length === 0) return writeIncluded;
  const batch = buildCombinedApplyRequests(writeIncluded, { updatedAt, includeReceipts: true });
  if (batch.requests.length === 0) return writeIncluded;
  const response = await runWrite(deps, () =>
    deps.transport.batchUpdate({
      spreadsheetId: deps.spreadsheetId,
      requests: batch.requests,
    }), {
    requestCount: batch.requests.length,
    bodyBytes: batch.bytes,
    requestedEffects,
    includedEffects: writeIncluded.reduce((total, route) => total + route.plans.length, 0),
  });
  requireValidBatchUpdateReply(response, batch.requests.length);
  return writeIncluded;
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
