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
} from "../sheetsContract/mutationCoordinator/CoordinatedSheetsProvider.js";
import {
  parseSyncProjectionEffectPayload,
  type ApplySyncEffectsRequest,
  type FastAppendRowsRequest,
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
 * Builds the stable grouping key for all provider operations on one route.
 *
 * Phase 1 of the batch-merge work: the route is coarsened to the spreadsheet
 * scope. A dispatcher wraps exactly one provider bound to one spreadsheet, so
 * every effect routed through it belongs to that spreadsheet; grouping by a
 * spreadsheet-level key puts all tabs' effects into one dispatch group. The
 * worker splits fast-append vs regular by `isFastAppendCandidate` and takes
 * the MIN priority over a mixed-content group, so dropping the per-tab fields
 * is safe. Chunking (EFFECT_BATCH_LIMIT) is a later phase and stays separate.
 */
export const SHEETS_SPREADSHEET_ROUTE_KEY = "spreadsheet-scope";

export function sheetsRouteKeyFor(_effect: PendingEffect): string {
  return SHEETS_SPREADSHEET_ROUTE_KEY;
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
    const providerRequest: ApplySyncEffectsRequest = {
      physicalSheetId: effects[0]!.physicalSheetId,
      sheetName: effects[0]!.payload.sheetName,
      registeredRange: effects[0]!.payload.registeredRange,
      projection: effects[0]!.projection,
      schemaVersion: effects[0]!.payload.schemaVersion,
      postconditionMode: SYNC_POSTCONDITION_MODES.DEFERRED,
      effects,
    };
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
   * waits cannot outlive the effect lease. Bare providers without the hook
   * get the renewal directly before the call. A failed renewal aborts with a
   * classified delivery-uncertain error before any remote request so the
   * worker requeues the batch through the durable outbox.
   */
  private async dispatchBeforeRemote<T>(
    physicalSheetIds: readonly string[],
    operation: string,
    beforeRemoteDispatch: (() => Promise<boolean>) | undefined,
    remote: (provider: SyncEffectWorkerProvider) => Promise<T>,
  ): Promise<T> {
    if (beforeRemoteDispatch === undefined) return remote(this.provider);
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
    if (!(await beforeRemoteDispatch())) {
      throw new CoordinatedLanePreconditionError();
    }
    return remote(this.provider);
  }
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

function safeProviderErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : "unknown sync provider failure";
}
