/**
 * Sheets dispatcher: the host implementation of the package worker's
 * `Dispatcher` boundary over the Google Sheets sync provider.
 *
 * The worker owns selection, claiming, grouping, lease refresh, transitions,
 * and recovery. This dispatcher owns every payload-derived decision: route
 * keys, fast-append candidacy, payload validation, the User_Input candidate
 * gate (via the active-candidate guard SQL), remote evidence validation
 * against effect targets, and transport-outcome classification.
 */

import { randomUUID } from "node:crypto";
import {
  NON_NEGATIVE_SAFE_INTEGER_MINIMUM,
} from "../../../shared/constants.js";
import type {
  FencingContext,
  PendingEffect,
  Presence,
} from "@hikoutei/ikisaki";
import {
  DispatchTransportError,
  type ApplyEffectResult,
  type ApplyOutcome,
  type CandidateGateResult,
  type ClaimedEffect,
  type Dispatcher,
  type DispatchRequest,
  type FastAppendEffectResult,
  type FastAppendOutcome,
  type Postcondition,
  type PostconditionOutcome,
  type PreparedDispatch,
} from "@hikoutei/ikisaki";
import type { SqlStorageAdapter } from "../../../adapter/persistence/contracts/sql.js";
import {
  CONFLICT_STATUSES,
  EFFECT_KINDS,
  EFFECT_TARGET_KINDS,
} from "../../../domain/model/constants.js";
import {
  absentValue,
  presentValue,
} from "../../../shared/state/index.js";
import { stableHash } from "../../../shared/encoding/stableEncode.js";
import {
  hasActiveUserInputCandidateWithSql,
} from "../../../infrastructure/storage/sync/outbound/effectWorkerSql.js";
import {
  ensureSpreadsheetAuthorityWithAdapter,
} from "../../../infrastructure/storage/sync/shared/spreadsheetAuthority.js";
import {
  hasCoordinatedSerializedInner,
  hasCoordinatedSerializedInnerForRoutes,
  CoordinatedLanePreconditionError,
  CoordinatedSplitApplyUnsupportedError,
} from "../sheetsContract/mutationCoordinator/CoordinatedSheetsProvider.js";
import {
  parseSyncProjectionEffectPayload,
  type ApplySyncEffectsRequest,
  type ApplySyncEffectsResult,
  type FastAppendRowsRequest,
  type PreparedApplyEffects,
  type ReadSyncEffectPostconditionsRequest,
  type SyncEffectPostcondition,
  type SyncEffectResult,
  type SyncProjectionEffect,
  type SyncEffectWorkerProvider,
} from "../sheetsContract/syncSheets.js";
import {
  SYNC_EFFECT_RESULT_STATUSES,
  SYNC_FAST_APPEND_STATUSES,
  SYNC_POSTCONDITION_DISPOSITIONS,
  SYNC_POSTCONDITION_MODES,
  SYNC_POSTCONDITION_STATUSES,
  SYNC_PROJECTIONS,
} from "../sheetsContract/constants.js";
import {
  classifyTransportOutcome,
  TRANSPORT_OUTCOME_KINDS,
} from "../sheetsContract/transportOutcome.js";
import {
  SYNC_SHEETS_ERROR_CODES,
  SyncSheetsContractError,
} from "../sheetsContract/errors.js";
import { fromSqlNullable } from "../../../infrastructure/storage/sqlite/sqlState.js";
import type { EffectTargetKind } from "../../../domain/model/constants.js";

/**
 * Dispatch-priority classes for ready projection effects.
 *
 * The worker runs ready effects in ascending declared priority across both
 * dispatch buckets, so System_State converges ahead of unrelated work within
 * the bounded soak convergence deadline. Only the dispatch sequence changes:
 * claim windows, leases, fencing, per-target predecessor ordering, the
 * limiter, and bounded fairness are untouched, and unready predecessors are
 * never forced.
 */
export const SYNC_DISPATCH_PRIORITIES = {
  /** New System_State entity rows appended through the fast path first. */
  SYSTEM_STATE_FAST_APPEND: 0,
  /** System_State update/delete/tombstone followers through the CAS path. */
  SYSTEM_STATE_REGULAR: 1,
  /** New Sync_Conflicts resolution rows appended through the fast path. */
  SYNC_CONFLICTS_FAST_APPEND: 2,
  /** User_Input and every other regular effect (repairs, deletes, resolves). */
  OTHER_REGULAR: 3,
} as const;

/**
 * Declares the dispatch-priority class of one pending effect.
 *
 * No-throw contract like the other classification predicates: a malformed
 * payload degrades to the neutral `OTHER_REGULAR` priority instead of
 * aborting the pass.
 */
export function sheetsDispatchPriorityFor(effect: PendingEffect): number {
  try {
    const converted = toProviderEffect(effect);
    if (
      converted.effectKind === EFFECT_KINDS.SYSTEM_PROJECTION &&
      converted.projection === SYNC_PROJECTIONS.SYSTEM_STATE
    ) {
      return isFastAppendEffect(converted)
        ? SYNC_DISPATCH_PRIORITIES.SYSTEM_STATE_FAST_APPEND
        : SYNC_DISPATCH_PRIORITIES.SYSTEM_STATE_REGULAR;
    }
    if (
      converted.effectKind === EFFECT_KINDS.RESOLUTION_PROJECTION &&
      converted.projection === SYNC_PROJECTIONS.SYNC_CONFLICTS &&
      isFastAppendEffect(converted)
    ) {
      return SYNC_DISPATCH_PRIORITIES.SYNC_CONFLICTS_FAST_APPEND;
    }
  } catch {
    // Malformed payloads keep the neutral class; the worker's own
    // payload validation fails them through the invalid-payload path.
  }
  return SYNC_DISPATCH_PRIORITIES.OTHER_REGULAR;
}

/**
 * Builds the worker-visible route identity for one provider effect.
 *
 * The key covers every route-defining field the provider re-derives from a
 * request (physical sheet, projection, tab, registered range, schema).
 * Distinct physical-sheet routes therefore group separately, which lets the
 * worker's read-ahead pipeline overlap one route's preflight (a read) with
 * another route's write. Effects sharing all five fields stay in one group so
 * same-route ordering and per-route write serialization are preserved.
 */
function dispatcherRouteKey(effect: SyncProjectionEffect): string {
  return [
    effect.physicalSheetId,
    effect.projection,
    effect.payload.sheetName,
    effect.payload.registeredRange,
    effect.payload.schemaVersion,
  ].join("\u0000");
}

/**
 * Legacy spreadsheet-scope route label, kept for direct multi-tab callers and
 * tests that pass an explicit routeKey into the dispatcher (the worker groups
 * production effects through `sheetsRouteKeyFor`, which now distinguishes
 * physical routes instead of this constant).
 */
export const SHEETS_SPREADSHEET_ROUTE_KEY = "spreadsheet-scope";

/**
 * Worker-visible route identity for one pending effect.
 *
 * No-throw contract: a malformed payload degrades to an effect-specific
 * invalid key (the worker's own payload validation then fails it through the
 * invalid-payload path) instead of aborting route grouping.
 */
export function sheetsRouteKeyFor(effect: PendingEffect): string {
  try {
    return dispatcherRouteKey(toProviderEffect(effect));
  } catch {
    return `invalid-route:${effect.effect_id}`;
  }
}

/** Validates the opaque payload of one pending effect for the worker. */
export function sheetsPayloadValidationError(effect: PendingEffect): Presence<string> {
  try {
    toProviderEffect(effect);
    return absentValue();
  } catch (error: unknown) {
    return presentValue(safeProviderErrorMessage(error));
  }
}

/**
 * Classifies one pending effect as an append-only fast candidate.
 *
 * A fast append requires an empty visible baseline (`createIfMissing` with
 * revision 0 and an empty visible hash) plus a new System_State entity row or
 * a new Sync_Conflicts resolution row.
 */
export function isSheetsFastAppendCandidate(effect: PendingEffect): boolean {
  try {
    return isFastAppendEffect(toProviderEffect(effect));
  } catch {
    return false;
  }
}

/** Classifies one converted provider effect as an append-only fast candidate. */
export function isFastAppendEffect(effect: SyncProjectionEffect): boolean {
  const emptyVisibleBaseline = effect.payload.createIfMissing &&
    effect.expectedVisibleRevision === NON_NEGATIVE_SAFE_INTEGER_MINIMUM &&
    effect.expectedVisibleHash === "";
  if (!emptyVisibleBaseline) return false;
  return (
    effect.effectKind === EFFECT_KINDS.SYSTEM_PROJECTION &&
      effect.projection === SYNC_PROJECTIONS.SYSTEM_STATE &&
      effect.targetKind === EFFECT_TARGET_KINDS.ENTITY
  ) || (
    effect.effectKind === EFFECT_KINDS.RESOLUTION_PROJECTION &&
      effect.projection === SYNC_PROJECTIONS.SYNC_CONFLICTS &&
      effect.targetKind === EFFECT_TARGET_KINDS.CONFLICT
  );
}

/**
 * Dispatcher over a `SyncEffectWorkerProvider` and the host storage adapter.
 *
 * The storage adapter backs the candidate gate and the dispatch authority
 * claim; both are optional host extensions the worker may skip.
 */
export class SheetsEffectDispatcher implements Dispatcher {
  private readonly provider: SyncEffectWorkerProvider;
  private readonly storage: SqlStorageAdapter;
  /**
   * Per-instance identity bound into every prepared token this dispatcher
   * produces, so a token from another dispatcher instance fails validation
   * before any remote call.
   */
  private readonly dispatcherId: string = "dispatcher:" + randomUUID();
  /**
   * Identity registry of the exact provider prepared-apply state objects this
   * dispatcher produced. `preflight` registers each provider-produced state;
   * `applyPrepared` rejects any nested state not in this registry, so a
   * same-dispatcher token whose nested plan was mutated or replaced fails
   * before any remote call even when the request fingerprint still matches.
   */
  private readonly preparedStates = new WeakSet<object>();
  /**
   * Identity registry of the exact outer legacy fallback tokens this
   * dispatcher produced in `preflight`. `preflight` registers each legacy
   * token; `applyPrepared` consumes it on first apply, so reusing a legacy
   * token (sequential or concurrent) cannot re-run `applyEffects` and risk a
   * duplicate write. Kept separate from `preparedStates` (which tracks nested
   * provider states) because legacy tokens carry no nested provider state.
   */
  private readonly consumedLegacyTokens = new WeakSet<object>();

  public constructor(options: {
    readonly provider: SyncEffectWorkerProvider;
    readonly storage: SqlStorageAdapter;
  }) {
    this.provider = options.provider;
    this.storage = options.storage;
  }

  public routeKeyFor(effect: PendingEffect): string {
    return sheetsRouteKeyFor(effect);
  }

  /**
   * Fast-append grouping key, spreadsheet-scoped for this dispatcher's single
   * provider.
   *
   * The Google Sheets provider appends rows across every tab of one
   * spreadsheet in a single atomic `batchUpdate`. Returning a spreadsheet-wide
   * route label lets the worker send the whole multi-route fast-append batch
   * as ONE `fastAppend` call (so a later tab's failure cannot leave an earlier
   * tab's rows committed by an already-issued separate call), while the
   * route-specific `routeKeyFor` stays for the regular read-ahead pipeline.
   */
  public fastAppendRouteKeyFor(_effect: PendingEffect): string {
    return SHEETS_SPREADSHEET_ROUTE_KEY;
  }

  public isFastAppendCandidate(effect: PendingEffect): boolean {
    return isSheetsFastAppendCandidate(effect);
  }

  public dispatchPriorityFor(effect: PendingEffect): number {
    return sheetsDispatchPriorityFor(effect);
  }

  public payloadValidationError(effect: PendingEffect): Presence<string> {
    return sheetsPayloadValidationError(effect);
  }

  /** Dispatches append-only rows through the idempotent provider batch operation. */
  public async fastAppend(request: DispatchRequest): Promise<FastAppendOutcome> {
    const providerRequest = buildFastAppendRowsRequest(request.effects);
    const physicalSheetIds = request.effects.map((effect) => effect.physical_sheet_id);
    let response: Awaited<ReturnType<SyncEffectWorkerProvider["fastAppendRows"]>>;
    try {
      response = await this.dispatchBeforeRemote(
        physicalSheetIds,
        "fastAppendRows",
        request.beforeRemoteDispatch,
        (provider) => provider.fastAppendRows(providerRequest),
      );
    } catch (error: unknown) {
      throw toDispatchTransportError(error);
    }
    const byEffect = new Map<string, PendingEffect>(
      request.effects.map((effect) => [effect.effect_id, effect]),
    );
    const results: FastAppendEffectResult[] = [];
    for (const result of response.results) {
      const pending = byEffect.get(result.effectId);
      if (pending === undefined) continue;
      const effect = toProviderEffect(pending);
      const evidence = receiptEvidence(result);
      if (evidence === undefined) {
        results.push({
          effectId: result.effectId,
          status: "delivery_uncertain",
          reason: presentValue("Fast append did not return receipt-backed visible evidence."),
        });
        continue;
      }
      if (evidence.visibleHash !== effect.payload.targetVisibleHash) {
        // The append receipt did not match the effect target: the remote row
        // does not carry the acknowledged state, so the worker closes the
        // effect as failed rather than trusting the receipt.
        results.push({ effectId: result.effectId, status: "applied_target_mismatch" });
        continue;
      }
      results.push({
        effectId: result.effectId,
        status: "applied",
        visibleRevision: evidence.visibleRevision,
        visibleHash: evidence.visibleHash,
        fieldHashes: fieldHashesFor(effect),
      });
    }
    return { results, hasMore: response.hasMore, ...(response.timing === undefined ? {} : { timing: response.timing }) };
  }

  /** Dispatches one regular effect batch through the provider. */
  public async apply(request: DispatchRequest): Promise<ApplyOutcome> {
    const effects = request.effects.map((pending) => toProviderEffect(pending));
    const providerRequest = buildApplyEffectsRequest(effects);
    let response: Awaited<ReturnType<SyncEffectWorkerProvider["applyEffects"]>>;
    try {
      response = await this.dispatchBeforeRemote(
        effects.map((effect) => effect.physicalSheetId),
        "applyEffects",
        request.beforeRemoteDispatch,
        (provider) => provider.applyEffects(providerRequest),
      );
    } catch (error: unknown) {
      throw toDispatchTransportError(error);
    }
    const byEffect = new Map(effects.map((effect) => [effect.effectId, effect]));
    const results: ApplyEffectResult[] = [];
    for (const result of response.results) {
      results.push(translateApplyResult(result, byEffect.get(result.effectId)));
    }
    return { results, hasMore: response.hasMore, ...(response.timing === undefined ? {} : { timing: response.timing }) };
  }

  /**
   * Split-dispatch preflight: read+plan stage for one regular batch.
   *
   * Delegates to the provider's `preflightApplyEffects`, which performs the
   * paced reads and planner/budget work but NO remote mutation and NO effect
   * lease renewal. The returned opaque `PreparedDispatch` carries the
   * validated route/plan/context/evidence state that `applyPrepared` needs;
   * the worker may run this read concurrently with another route's write.
   */
  public async preflight(request: DispatchRequest): Promise<PreparedDispatch> {
    const effects = request.effects.map((pending) => toProviderEffect(pending));
    const providerRequest = buildApplyEffectsRequest(effects);
    // Split apply is only usable when the provider exposes BOTH optional
    // stages. A provider (or coordinator wrapping a partial inner) exposing
    // only one stage must use the single legacy `applyEffects` path, never
    // fail inside `applyPrepared`.
    if (
      this.provider.preflightApplyEffects === undefined ||
      this.provider.applyPreparedEffects === undefined
    ) {
      return this.makeLegacyToken(request.routeKey, providerRequest);
    }
    // Call the method on the provider instance (not as a detached function)
    // so the provider keeps its `this` deps binding during the paced reads.
    let state: PreparedApplyEffects;
    try {
      state = await this.provider.preflightApplyEffects(providerRequest);
    } catch (error: unknown) {
      if (error instanceof CoordinatedSplitApplyUnsupportedError) {
        // A coordinated provider wrapping a partial inner (e.g. a fake)
        // signals no split support; fall back to the single `applyEffects`.
        return this.makeLegacyToken(request.routeKey, providerRequest);
      }
      // Classify the preflight failure so the worker can distinguish a bounded
      // transport refusal/timeout and an unverified remote-state problem (safe
      // requeue) from a proven local request/contract failure (terminal).
      // Remote-state errors are raised as `SyncSheetsContractError` with the
      // `INVALID_PROVIDER_RESPONSE` code and stay delivery-uncertain;
      // transport errors keep their own delivery-uncertain classification.
      throw toPreflightDispatchError(error);
    }
    // Freeze the nested state so it cannot be mutated in place between
    // preflight and apply; the provider's write+verify stage only reads it.
    deepFreeze(state);
    // Register the exact produced state so `applyPrepared` can reject a forged
    // or replaced nested plan by identity before any remote call.
    this.preparedStates.add(state);
    return makePreparedToken("split", this.dispatcherId, request.routeKey, providerRequest, state);
  }

  /**
   * Builds and registers one one-shot legacy fallback token.
   *
   * The legacy token is added to `consumedLegacyTokens` so `applyPrepared`
   * can reject a replay (sequential or concurrent) before it re-runs the
   * provider's single `applyEffects` call.
   */
  private makeLegacyToken(
    routeKey: string,
    request: ApplySyncEffectsRequest,
  ): PreparedDispatch {
    const token = makePreparedToken("legacy", this.dispatcherId, routeKey, request);
    // Freeze the token and its nested request so the legacy path cannot
    // dispatch a request that differs from the fingerprinted one. Without
    // this, a caller could mutate `token.request.effects` after preflight and
    // still pass validation (the fingerprint was computed from the original
    // request) while `applyEffects` dispatches the mutated request.
    deepFreeze(token);
    this.consumedLegacyTokens.add(token);
    return token;
  }

  /**
   * Split-dispatch write+verify stage, consuming `preflight` prepared state.
   *
   * Delegates to the provider's `applyPreparedEffects` under the same
   * mutation-lane and effect-lease-renewal safety boundary as `apply`: the
   * before-remote renewal runs immediately before the write and a failed
   * renewal aborts the whole batch as delivery-uncertain.
   */
  public async applyPrepared(
    request: DispatchRequest,
    prepared: PreparedDispatch,
  ): Promise<ApplyOutcome> {
    // Runtime-validate the opaque token against this dispatcher instance and
    // the request route BEFORE any remote call so a stale or cross-dispatcher
    // (or cross-route, or cross-request) token fails safely instead of
    // reaching the provider.
    const currentEffects = request.effects.map((pending) => toProviderEffect(pending));
    const currentRequest = buildApplyEffectsRequest(currentEffects);
    const state = this.requirePreparedState(prepared, request.routeKey, currentRequest);
    const physicalSheetIds = request.effects.map((effect) => effect.physical_sheet_id);
    let response: ApplySyncEffectsResult;
    try {
      response = await this.dispatchBeforeRemote(
        physicalSheetIds,
        "applyPreparedEffects",
        request.beforeRemoteDispatch,
        async (provider) => {
          if (state.kind === "legacy") {
            // Legacy fallback: the provider has no split write+verify stage,
            // so the preflight produced a legacy token carrying the request.
            // Apply through the provider's single `applyEffects` call
            // (identical to the pre-split `apply` path).
            return provider.applyEffects(state.request);
          }
          if (provider.applyPreparedEffects === undefined) {
            return provider.applyEffects(state.request);
          }
          try {
            // Call as a method so the provider keeps its `this` deps binding.
            return await provider.applyPreparedEffects(state.preparedState);
          } catch (error: unknown) {
            if (error instanceof CoordinatedSplitApplyUnsupportedError) {
              // A coordinator whose inner lost split support after preflight
              // must still write through the legacy `applyEffects` path
              // instead of failing the batch mid-write.
              return provider.applyEffects(state.request);
            }
            throw error;
          }
        },
      );
    } catch (error: unknown) {
      throw toDispatchTransportError(error);
    }
    const byEffect = new Map(request.effects.map((pending) => {
      const effect = toProviderEffect(pending);
      return [effect.effectId, effect] as const;
    }));
    const results: ApplyEffectResult[] = [];
    for (const result of response.results) {
      results.push(translateApplyResult(result, byEffect.get(result.effectId)));
    }
    return { results, hasMore: response.hasMore, ...(response.timing === undefined ? {} : { timing: response.timing }) };
  }


  /** Reads back response-loss effects so the worker can settle them safely. */
  public async readPostconditions(request: DispatchRequest): Promise<PostconditionOutcome> {
    const effects = request.effects.map((pending) => toProviderEffect(pending));
    const providerRequest: ReadSyncEffectPostconditionsRequest = {
      physicalSheetId: effects[0]!.physicalSheetId,
      sheetName: effects[0]!.payload.sheetName,
      registeredRange: effects[0]!.payload.registeredRange,
      projection: effects[0]!.projection,
      schemaVersion: effects[0]!.payload.schemaVersion,
      effects,
    };
    let response: Awaited<ReturnType<SyncEffectWorkerProvider["readEffectPostconditions"]>>;
    try {
      response = await this.dispatchBeforeRemote(
        effects.map((effect) => effect.physicalSheetId),
        "readEffectPostconditions",
        request.beforeRemoteDispatch,
        (provider) => provider.readEffectPostconditions(providerRequest),
      );
    } catch (error: unknown) {
      throw toDispatchTransportError(error);
    }
    const byEffect = new Map(effects.map((effect) => [effect.effectId, effect]));
    const results = response.map((result) => ({
      effectId: result.effectId,
      payloadHash: result.payloadHash,
      postcondition: translatePostcondition(
        result.postcondition,
        byEffect.get(result.effectId),
      ),
    }));
    return { results };
  }

  /**
   * Preserves active User_Input candidates before remote dispatch: reconcile
   * or delete effects that would overwrite a candidate-owned field are
   * blocked locally before any remote compare-and-set runs.
   */
  public async gate(items: readonly ClaimedEffect[]): Promise<CandidateGateResult> {
    const allowed: string[] = [];
    const blocked: string[] = [];
    for (const item of items) {
      let effect: SyncProjectionEffect;
      try {
        effect = toProviderEffect(item.pending);
      } catch {
        allowed.push(item.pending.effect_id);
        continue;
      }
      if (!isCandidateProtectingUserInputEffect(effect)) {
        allowed.push(item.pending.effect_id);
        continue;
      }
      const rowBinding = effect.rowBindingId;
      if (rowBinding.kind !== "present") {
        allowed.push(item.pending.effect_id);
        continue;
      }
      const fieldNames = Object.keys(effect.payload.fields);
      const blockedByCandidate = await this.storage.read(({ sql }) =>
        hasActiveUserInputCandidateWithSql(sql, {
          physicalSheetId: effect.physicalSheetId,
          projection: SYNC_PROJECTIONS.USER_INPUT,
          rowBindingId: rowBinding.value,
          fieldNames,
          openConflictStatus: CONFLICT_STATUSES.OPEN,
          rebasedConflictStatus: CONFLICT_STATUSES.NEEDS_REBASE,
        }));
      if (blockedByCandidate) blocked.push(item.pending.effect_id);
      else allowed.push(item.pending.effect_id);
    }
    return { allowed, blocked };
  }

  /** Refreshes the dispatch authority claim for one physical sheet. */
  public async ensureAuthority(
    fence: FencingContext,
    physicalSheetId: string,
    ownerId: string,
  ): Promise<boolean> {
    const result = await ensureSpreadsheetAuthorityWithAdapter(this.storage, {
      ...fence,
      physicalSheetId,
      ownerId,
    });
    return result.kind === "claimed";
  }

  /**
   * Runs one provider remote call with the worker's before-remote renewal.
   *
   * When the provider exposes the coordinator's `runSerializedInner`, the
   * renewal hook runs AFTER the physical-sheet mutation lane is acquired and
   * BEFORE the inner provider call, so lane queue time and shared limiter
   * waits cannot dominate the effect lease. Bare providers without the hook
   * get the renewal directly before the call. A failed renewal aborts with a
   * classified delivery-uncertain error before any remote request so the
   * worker requeues the batch through the durable outbox.
   *
   * Direct dispatcher calls (no `beforeRemoteDispatch`, e.g. non-worker
   * callers or tests) ALSO route a coordinated provider through the same
   * lane, so a coordinated provider's `applyPreparedEffects`/`applyEffects`
   * never bypasses mutation serialization just because no renewal hook is
   * present. The `remote` closure receives the INNER provider and calls it
   * directly, so it never re-enters the coordinator's lane (no deadlock, no
   * double entry).
   */
  /**
   * Narrows one worker-opaque `PreparedDispatch` back to the dispatcher token
   * this dispatcher stored in `preflight`.
   *
   * The value is validated as `unknown` with runtime predicates, never an
   * untyped double cast: the brand, the producing dispatcher instance, the
   * bound route, the token `kind`, the nested provider prepared-state `kind`,
   * and the exact nested state identity (this dispatcher's private registry)
   * are all checked before the write+verify stage. A stale, foreign,
   * cross-route, cross-request, or forged/replaced nested plan fails here with
   * a classified `PreparedDispatchError` before any remote call.
   */
  private requirePreparedState(
    prepared: PreparedDispatch,
    routeKey: string,
    currentRequest: ApplySyncEffectsRequest,
  ): DispatcherPreparedState {
    const candidate: unknown = prepared;
    if (candidate === null || typeof candidate !== "object") {
      throw new PreparedDispatchError("prepared apply dispatch is not an object");
    }
    const record = candidate as Record<string, unknown>;
    if (record.__preparedDispatch !== DISPATCHER_PREPARED_BRAND) {
      throw new PreparedDispatchError("prepared apply dispatch has an unrecognized brand");
    }
    if (record.dispatcherId !== this.dispatcherId) {
      throw new PreparedDispatchError("prepared apply dispatch was produced by another dispatcher");
    }
    if (record.routeKey !== routeKey) {
      throw new PreparedDispatchError("prepared apply dispatch is bound to a different route");
    }
    const request = record.request;
    if (!isValidApplyRequest(request)) {
      throw new PreparedDispatchError("prepared apply dispatch request is invalid");
    }
    // The token must be bound to the EXACT request the caller is now about to
    // dispatch, not merely the same route. A stale or cross-request token with
    // a matching dispatcher/route but different effects or request fields fails
    // closed here, before any remote call.
    if (record.fingerprint !== preparedFingerprint(routeKey, currentRequest)) {
      throw new PreparedDispatchError("prepared apply dispatch is bound to a different request");
    }
    if (record.kind === "split") {
      const preparedState = record.preparedState;
      if (!isPreparedApplyEffects(preparedState)) {
        throw new PreparedDispatchError("prepared apply state has an unrecognized kind");
      }
      // Bind the nested provider state to the EXACT request this token was
      // created for. The provider's prepared state carries the request it was
      // preflighted from, so its fingerprint must match the token's
      // fingerprint; a nested state whose request was swapped or mutated fails
      // here even when the token's own request field still matches.
      const nestedRequest = preparedState.request;
      if (!isValidApplyRequest(nestedRequest)) {
        throw new PreparedDispatchError("prepared apply state request is invalid");
      }
      if (preparedFingerprint(routeKey, nestedRequest) !== record.fingerprint) {
        throw new PreparedDispatchError("prepared apply state is bound to a different request");
      }
      // The nested plan must be the EXACT object this dispatcher produced in
      // `preflight`, not a forged or replaced copy that happens to carry the
      // same request fingerprint. Identity-checked through the private registry
      // so a mutated/replaced nested plan fails before any write.
      if (!this.preparedStates.has(preparedState)) {
        throw new PreparedDispatchError("prepared apply state was not produced by this dispatcher");
      }
      // One-shot consumption: remove the nested state from the registry on
      // first apply so a replayed or concurrently reused token cannot re-run
      // the same stale plan. The has+delete pair is synchronous, so two
      // concurrent applies cannot both pass the check.
      this.preparedStates.delete(preparedState);
      return {
        __preparedDispatch: DISPATCHER_PREPARED_BRAND,
        kind: "split",
        dispatcherId: this.dispatcherId,
        routeKey,
        fingerprint: record.fingerprint,
        request,
        preparedState,
      };
    }
    if (record.kind === "legacy") {
      // One-shot consumption for the outer legacy token: it must be the exact
      // object this dispatcher produced in `preflight` AND not yet applied.
      // The has+delete pair is synchronous, so two concurrent applies cannot
      // both pass the check; a replayed or concurrently reused legacy token
      // fails closed here, immediately before the legacy `applyEffects` call.
      if (!this.consumedLegacyTokens.has(candidate)) {
        throw new PreparedDispatchError(
          "prepared legacy dispatch was already consumed or was not produced by this dispatcher",
        );
      }
      this.consumedLegacyTokens.delete(candidate);
      return {
        __preparedDispatch: DISPATCHER_PREPARED_BRAND,
        kind: "legacy",
        dispatcherId: this.dispatcherId,
        routeKey,
        fingerprint: record.fingerprint,
        request,
      };
    }
    throw new PreparedDispatchError("prepared apply dispatch has an unrecognized kind");
  }

  /**
   * Runs one provider remote call with the worker's before-remote renewal.
   *
   * When the provider exposes the coordinator's `runSerializedInner`, the
   * renewal hook runs AFTER the physical-sheet mutation lane is acquired and
   * BEFORE the inner provider call, so lane queue time and shared limiter
   * waits cannot dominate the effect lease. Bare providers without the hook
   * get the renewal directly before the call. A failed renewal aborts with a
   * classified delivery-uncertain error before any remote request so the
   * worker requeues the batch through the durable outbox.
   *
   * Direct dispatcher calls (no `beforeRemoteDispatch`, e.g. non-worker
   * callers or tests) ALSO route a coordinated provider through the same
   * lane, so a coordinated provider's `applyPreparedEffects`/`applyEffects`
   * never bypasses mutation serialization just because no renewal hook is
   * present. The `remote` closure receives the INNER provider and calls it
   * directly, so it never re-enters the coordinator's lane (no deadlock, no
   * double entry).
   */
  private async dispatchBeforeRemote<T>(
    physicalSheetIds: readonly string[],
    operation: string,
    beforeRemoteDispatch: (() => Promise<boolean>) | undefined,
    remote: (provider: SyncEffectWorkerProvider) => Promise<T>,
  ): Promise<T> {
    if (hasCoordinatedSerializedInner(this.provider)) {
      const distinct = [...new Set(physicalSheetIds)];
      if (distinct.length === 1) {
        // Single-route call: keep the single-lane path byte-identical.
        return this.provider.runSerializedInner(
          distinct[0]!,
          operation,
          (inner) => remote(inner),
          beforeRemoteDispatch,
        );
      }
      // Multi-tab call: acquire EVERY distinct route lane so no other writer
      // can interleave on any tab during the combined preflight/write or
      // recovery read.
      if (hasCoordinatedSerializedInnerForRoutes(this.provider)) {
        return this.provider.runSerializedInnerForRoutes(
          distinct,
          operation,
          (inner) => remote(inner),
          beforeRemoteDispatch,
        );
      }
      // Legacy coordinator that predates the multi-route hook exposes only
      // `runSerializedInner`, which cannot acquire every lane in one call.
      // Fall back to the first route's lane so the combined multi-tab call
      // still runs under coordinator serialization without crashing on a
      // missing method.
      return this.provider.runSerializedInner(
        distinct[0]!,
        operation,
        (inner) => remote(inner),
        beforeRemoteDispatch,
      );
    }
    if (beforeRemoteDispatch === undefined) return remote(this.provider);
    if (!(await beforeRemoteDispatch())) {
      throw new CoordinatedLanePreconditionError();
    }
    return remote(this.provider);
  }
}

/** Builds the provider apply-effects request for one dispatcher batch. */
function buildApplyEffectsRequest(
  effects: readonly SyncProjectionEffect[],
): ApplySyncEffectsRequest {
  return {
    physicalSheetId: effects[0]!.physicalSheetId,
    sheetName: effects[0]!.payload.sheetName,
    registeredRange: effects[0]!.payload.registeredRange,
    projection: effects[0]!.projection,
    schemaVersion: effects[0]!.payload.schemaVersion,
    postconditionMode: SYNC_POSTCONDITION_MODES.DEFERRED,
    effects,
  };
}

/**
 * Dispatcher-owned brand carried by the prepared token. The worker treats the
 * value as opaque; this dispatcher uses the brand to revalidate the token it
 * produced before handing the state to the provider write stage.
 */
const DISPATCHER_PREPARED_BRAND = "hikoutei/dispatcher/prepared" as const;

/**
 * Concrete prepared-apply token this dispatcher produces and consumes: the
 * worker-opaque brand plus either the typed split provider state or a legacy
 * token that re-applies through the provider's single `applyEffects` call.
 *
 * Both kinds carry the producing dispatcher instance id and the route key so
 * the token is bound to the exact request/provider/route that created it.
 */
type DispatcherPreparedState =
  | {
      readonly __preparedDispatch: typeof DISPATCHER_PREPARED_BRAND;
      readonly kind: "split";
      readonly dispatcherId: string;
      readonly routeKey: string;
      /** Deterministic fingerprint of the exact request this token was bound to. */
      readonly fingerprint: string;
      readonly request: ApplySyncEffectsRequest;
      readonly preparedState: PreparedApplyEffects;
    }
  | {
      readonly __preparedDispatch: typeof DISPATCHER_PREPARED_BRAND;
      readonly kind: "legacy";
      readonly dispatcherId: string;
      readonly routeKey: string;
      /** Deterministic fingerprint of the exact request this token was bound to. */
      readonly fingerprint: string;
      readonly request: ApplySyncEffectsRequest;
    };

/** Classified, safe error for an invalid or foreign prepared-apply token. */
export class PreparedDispatchError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PreparedDispatchError";
  }
}

/**
 * Builds one worker-opaque prepared token bound to a dispatcher instance and
 * route. The concrete `DispatcherPreparedState` is returned as the nominal
 * `PreparedDispatch`; the consumer re-validates every field over `unknown`.
 *
 * The token carries a deterministic fingerprint of the exact request it was
 * created from (route + effect ids/payload hashes + relevant request fields)
 * so `applyPrepared` can reject a stale or cross-request token even when the
 * dispatcher instance and route happen to match.
 */
function makePreparedToken(
  kind: "split" | "legacy",
  dispatcherId: string,
  routeKey: string,
  request: ApplySyncEffectsRequest,
  preparedState?: PreparedApplyEffects,
): PreparedDispatch {
  const fingerprint = preparedFingerprint(routeKey, request);
  const token: DispatcherPreparedState = preparedState === undefined
    ? { __preparedDispatch: DISPATCHER_PREPARED_BRAND, kind: "legacy", dispatcherId, routeKey, fingerprint, request }
    : { __preparedDispatch: DISPATCHER_PREPARED_BRAND, kind: "split", dispatcherId, routeKey, fingerprint, request, preparedState };
  return token;
}

/**
 * Deterministic fingerprint of one apply request for prepared-token binding.
 *
 * Covers the route key, every route-defining request field, and each effect's
 * id and payload hash (plus target identity fields), so a token created for a
 * different request cannot be replayed against the write stage even when its
 * dispatcher instance and route match. Order-stable because the worker keeps
 * the effect list in a stable claimed order.
 */
function preparedFingerprint(routeKey: string, request: ApplySyncEffectsRequest): string {
  return stableHash({
    routeKey,
    physicalSheetId: request.physicalSheetId,
    sheetName: request.sheetName,
    registeredRange: request.registeredRange,
    projection: request.projection,
    schemaVersion: request.schemaVersion,
    postconditionMode: request.postconditionMode ?? "undefined",
    effects: request.effects.map((effect) => ({
      effectId: effect.effectId,
      payloadHash: effect.payloadHash,
      effectKind: effect.effectKind,
      physicalSheetId: effect.physicalSheetId,
      projection: effect.projection,
      targetKind: effect.targetKind,
      targetId: effect.targetId,
      rowBindingId: effect.rowBindingId,
      conflictId: effect.conflictId,
      expectedVisibleRevision: effect.expectedVisibleRevision,
      expectedVisibleHash: effect.expectedVisibleHash,
      repairGuardHash: effect.repairGuardHash,
      payload: {
        sheetName: effect.payload.sheetName,
        registeredRange: effect.payload.registeredRange,
        schemaVersion: effect.payload.schemaVersion,
        targetAnchor: effect.payload.targetAnchor,
        fields: effect.payload.fields,
        targetVisibleHash: effect.payload.targetVisibleHash,
        createIfMissing: effect.payload.createIfMissing,
        expectedCandidateHash: effect.payload.expectedCandidateHash,
      },
    })),
  });
}

/** Runtime predicate for the shared request shape a prepared token must carry. */
function isValidApplyRequest(value: unknown): value is ApplySyncEffectsRequest {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (typeof record.physicalSheetId !== "string") return false;
  if (!Array.isArray(record.effects) || record.effects.length === 0) return false;
  return true;
}

/** Runtime predicate for the shared prepared-apply state discriminant. */
function isPreparedApplyEffects(value: unknown): value is PreparedApplyEffects {
  if (value === null || typeof value !== "object") return false;
  const kind = (value as { readonly kind?: unknown }).kind;
  return kind === "single" || kind === "multi";
}

function buildFastAppendRowsRequest(
  effects: readonly PendingEffect[],
): FastAppendRowsRequest {
  const converted = effects.map((pending) => toProviderEffect(pending));
  const first = converted[0]!;
  return {
    physicalSheetId: first.physicalSheetId,
    sheetName: first.payload.sheetName,
    registeredRange: first.payload.registeredRange,
    projection: first.projection,
    schemaVersion: first.payload.schemaVersion,
    rows: converted.map((effect) => ({
      effectId: effect.effectId,
      payloadHash: effect.payloadHash,
      anchor: effect.payload.targetAnchor,
      fields: effect.payload.fields,
      physicalSheetId: effect.physicalSheetId,
      projection: effect.projection,
      sheetName: effect.payload.sheetName,
      registeredRange: effect.payload.registeredRange,
      schemaVersion: effect.payload.schemaVersion,
    })),
  };
}

function translateApplyResult(
  result: SyncEffectResult,
  effect: SyncProjectionEffect | undefined,
): ApplyEffectResult {
  const base = {
    effectId: result.effectId,
    payloadHash: result.payloadHash,
  };
  if (
    (result.status === SYNC_EFFECT_RESULT_STATUSES.APPLIED ||
      result.status === SYNC_EFFECT_RESULT_STATUSES.ALREADY_APPLIED)
  ) {
    const evidence = verifiedSuccessEvidence(result, effect);
    if (evidence !== undefined) {
      return {
        ...base,
        status: result.status,
        visibleRevision: evidence.visibleRevision,
        visibleHash: evidence.visibleHash,
        fieldHashes: evidence.fieldHashes,
      };
    }
    // A success label without the acknowledged target state is not enough to
    // close a durable effect; the worker treats it like a lost response and
    // reads back first.
    return {
      ...base,
      status: "delivery_uncertain",
      reason: presentValue("Provider applied result did not include receipt-backed visible evidence."),
    };
  }
  if (result.status === SYNC_EFFECT_RESULT_STATUSES.SUPERSEDED) {
    return { ...base, status: "superseded", reason: result.reason };
  }
  if (result.status === SYNC_EFFECT_RESULT_STATUSES.GUARD_MISMATCH) {
    return { ...base, status: "guard_mismatch", reason: result.reason };
  }
  if (result.status === SYNC_EFFECT_RESULT_STATUSES.REPAIR_REOBSERVE) {
    return { ...base, status: "repair_reobserve", reason: result.reason };
  }
  return {
    ...base,
    status: result.status === SYNC_EFFECT_RESULT_STATUSES.SCHEMA_ERROR
      ? "schema_error"
      : "retryable_error",
    reason: result.reason,
  };
}

function translatePostcondition(
  postcondition: SyncEffectPostcondition,
  effect: SyncProjectionEffect | undefined,
): Postcondition {
  if (
    postcondition.disposition === SYNC_POSTCONDITION_DISPOSITIONS.APPLIED &&
    postcondition.visibleRevision.kind === "present" &&
    postcondition.visibleHash.kind === "present" &&
    effect !== undefined &&
    postcondition.visibleHash.value === effect.payload.targetVisibleHash
  ) {
    return {
      disposition: "applied",
      visibleRevision: postcondition.visibleRevision.value,
      visibleHash: postcondition.visibleHash.value,
      fieldHashes: fieldHashesFor(effect),
    };
  }
  if (postcondition.disposition === SYNC_POSTCONDITION_DISPOSITIONS.APPLIED) {
    if (
      effect !== undefined &&
      postcondition.visibleRevision.kind === "present" &&
      postcondition.visibleHash.kind === "present"
    ) {
      return { disposition: "applied_target_mismatch" };
    }
    return { disposition: "applied_without_visible_state" };
  }
  if (postcondition.disposition === SYNC_POSTCONDITION_DISPOSITIONS.CHANGED) {
    return {
      disposition: "changed",
      ...(postcondition.reason === undefined ? {} : { reason: postcondition.reason }),
    };
  }
  if (postcondition.disposition === SYNC_POSTCONDITION_DISPOSITIONS.UNAPPLIED) {
    return {
      disposition: "unapplied",
      ...(postcondition.reason === undefined ? {} : { reason: postcondition.reason }),
    };
  }
  return {
    disposition: "unavailable",
    ...(postcondition.reason === undefined ? {} : { reason: postcondition.reason }),
  };
}

/**
 * Returns verified success evidence only when the provider's success label
 * carries the acknowledged target state: a verified/acknowledged postcondition
 * plus a visible revision and hash that match the effect target.
 */
function verifiedSuccessEvidence(
  result: SyncEffectResult,
  effect: SyncProjectionEffect | undefined,
): {
  readonly visibleRevision: number;
  readonly visibleHash: string;
  readonly fieldHashes: Readonly<Record<string, string>>;
} | undefined {
  if (
    result.postcondition !== SYNC_POSTCONDITION_STATUSES.VERIFIED &&
    result.postcondition !== SYNC_POSTCONDITION_STATUSES.ACKNOWLEDGED
  ) {
    return undefined;
  }
  if (
    result.visibleRevision.kind !== "present" ||
    result.visibleHash.kind !== "present"
  ) {
    return undefined;
  }
  if (
    effect === undefined ||
    result.visibleHash.value !== effect.payload.targetVisibleHash
  ) {
    return undefined;
  }
  return {
    visibleRevision: result.visibleRevision.value,
    visibleHash: result.visibleHash.value,
    fieldHashes: fieldHashesFor(effect),
  };
}

function receiptEvidence(
  result: Awaited<ReturnType<SyncEffectWorkerProvider["fastAppendRows"]>>["results"][number],
): { readonly visibleRevision: number; readonly visibleHash: string } | undefined {
  if (
    result.status !== SYNC_FAST_APPEND_STATUSES.APPLIED ||
    typeof result.visibleRevision !== "number" ||
    !Number.isSafeInteger(result.visibleRevision) ||
    result.visibleRevision < 1 ||
    typeof result.visibleHash !== "string" ||
    result.visibleHash.length === 0
  ) {
    return undefined;
  }
  return { visibleRevision: result.visibleRevision, visibleHash: result.visibleHash };
}

function fieldHashesFor(effect: SyncProjectionEffect): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(effect.payload.fields)
      .map(([fieldName, value]) => [fieldName, stableHash(value)]),
  );
}

function isCandidateProtectingUserInputEffect(effect: SyncProjectionEffect): boolean {
  return effect.effectKind === EFFECT_KINDS.CANDIDATE_RECONCILE ||
    effect.effectKind === EFFECT_KINDS.USER_INPUT_DELETE;
}

/** Validates and converts one durable outbox row into a provider effect. */
function toProviderEffect(effect: PendingEffect): SyncProjectionEffect {
  if (!isSyncEffectKind(effect.effect_kind)) {
    throw new Error("unsupported sync effect kind: " + effect.effect_kind);
  }
  if (!isSyncProjection(effect.projection)) {
    throw new Error("unsupported sync projection: " + effect.projection);
  }
  if (!isEffectTargetKind(effect.target_kind)) {
    throw new Error("unsupported sync effect target kind: " + effect.target_kind);
  }
  return {
    effectId: effect.effect_id,
    payloadHash: effect.payload_hash,
    effectKind: effect.effect_kind,
    physicalSheetId: effect.physical_sheet_id,
    projection: effect.projection,
    targetKind: effect.target_kind,
    targetId: effect.target_id,
    rowBindingId: fromSqlNullable(effect.row_binding_id),
    conflictId: fromSqlNullable(effect.conflict_id),
    expectedVisibleRevision: effect.expected_visible_revision,
    expectedVisibleHash: effect.expected_visible_hash,
    repairGuardHash: fromSqlNullable(effect.repair_guard_hash),
    payload: parseSyncProjectionEffectPayload(effect.payload_json),
  };
}

function isSyncEffectKind(value: string): value is SyncProjectionEffect["effectKind"] {
  return value === EFFECT_KINDS.SYSTEM_PROJECTION ||
    value === EFFECT_KINDS.CANDIDATE_RECONCILE ||
    value === EFFECT_KINDS.SYSTEM_REPAIR ||
    value === EFFECT_KINDS.RESOLUTION_PROJECTION ||
    value === EFFECT_KINDS.RESOLUTION_DELETE ||
    value === EFFECT_KINDS.USER_INPUT_DELETE;
}

function isSyncProjection(value: string): value is SyncProjectionEffect["projection"] {
  return value === SYNC_PROJECTIONS.USER_INPUT ||
    value === SYNC_PROJECTIONS.SYSTEM_STATE ||
    value === SYNC_PROJECTIONS.SYNC_CONFLICTS;
}

function isEffectTargetKind(value: string): value is EffectTargetKind {
  return value === EFFECT_TARGET_KINDS.ENTITY ||
    value === EFFECT_TARGET_KINDS.ROW_BINDING ||
    value === EFFECT_TARGET_KINDS.PROJECTION_ROW ||
    value === EFFECT_TARGET_KINDS.CONFLICT;
}

function toDispatchTransportError(error: unknown): DispatchTransportError {
  if (error instanceof CoordinatedLanePreconditionError) {
    // A failed in-lane lease renewal proves no remote request was sent, but
    // the effects were already requeued through the durable outbox; keep the
    // batch retryable (delivery_uncertain) instead of closing it as an
    // explicit remote failure. The message is static and redacted.
    return new DispatchTransportError("delivery_uncertain", error.message);
  }
  const outcome = classifyTransportOutcome(error);
  return new DispatchTransportError(
    outcome.kind === TRANSPORT_OUTCOME_KINDS.EXPLICIT_REMOTE_FAILURE
      ? "explicit_remote_failure"
      : "delivery_uncertain",
    outcome.message,
  );
}

/**
 * Classifies a failed preflight (read+plan) stage for the worker.
 *
 * A preflight is read-only, so the effect can always be requeued safely; the
 * question is only whether the failure proves a terminal local/request problem
 * or leaves the remote state unverified. A `SyncSheetsContractError` with the
 * `INVALID_PROVIDER_RESPONSE` code is raised by `invalidProviderState` for a
 * malformed provider reply, missing tab, receipt-schema drift, or duplicate
 * anchor/identity: the remote state is unverified, so it is classified as
 * `delivery_uncertain` and the worker requeues the effects for a later probe
 * rather than closing them on unverified evidence. Only a proven local
 * request/config/contract failure (invalid effect payload, provisioning, or
 * client options) is terminal and keeps the existing `explicit_remote_failure`
 * classification. Transport failures keep their own delivery-uncertain
 * classification. The message is redacted and static-safe.
 */
function toPreflightDispatchError(error: unknown): DispatchTransportError {
  if (error instanceof SyncSheetsContractError) {
    // A remote provider-response/state problem is unverified evidence; a proven
    // local request/config failure is terminal. Distinguish by stable code.
    const kind = error.code === SYNC_SHEETS_ERROR_CODES.INVALID_PROVIDER_RESPONSE
      ? "delivery_uncertain"
      : "explicit_remote_failure";
    return new DispatchTransportError(kind, safeProviderErrorMessage(error));
  }
  const outcome = classifyTransportOutcome(error);
  return new DispatchTransportError(
    outcome.kind === TRANSPORT_OUTCOME_KINDS.EXPLICIT_REMOTE_FAILURE
      ? "explicit_remote_failure"
      : "delivery_uncertain",
    outcome.message,
  );
}

/**
 * Recursively freezes an object graph so a prepared token's nested state
 * cannot be mutated in place between preflight and apply. The provider's
 * write+verify stage only reads the prepared state, so freezing is safe.
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    deepFreeze(record[key]);
  }
  return Object.freeze(value) as T;
}

function safeProviderErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : "unknown sync provider failure";
}
