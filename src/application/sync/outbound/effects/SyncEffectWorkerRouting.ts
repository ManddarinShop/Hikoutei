/** Effect conversion, request grouping, and routing predicates. */

import {
  NON_NEGATIVE_SAFE_INTEGER_MINIMUM,
  POSITIVE_SAFE_INTEGER_MINIMUM,
} from "../../../../domain/index.js";
import type { EffectTargetKind } from "../../../../domain/index.js";
import { fromSqlNullable } from "../../../../infrastructure/storage/sqlite/sqlState.js";
import type {
  PendingEffect,
  WriterLease,
  FencingContext,
} from "../../../../infrastructure/storage/index.js";
import { LOOKUP_RESULT_KINDS } from "../../../../shared/state/constants.js";
import type {
  ApplySyncEffectsRequest,
  FastAppendRowsRequest,
  ReadSyncEffectPostconditionsRequest,
  SyncProjectionEffect,
  SyncEffectResult,
  SyncProjection,
} from "../../sheets/syncSheets.js";
import { parseSyncProjectionEffectPayload } from "../../sheets/syncSheets.js";
import {
  SYNC_POSTCONDITION_MODES,
  SYNC_POSTCONDITION_STATUSES,
  SYNC_PROJECTIONS,
} from "../../sheets/constants.js";
import {
  EFFECT_TARGET_KINDS,
  EFFECT_BATCH_LIMIT,
  OUTBOX_EFFECT_STATUSES,
  SYNC_EFFECT_KINDS,
} from "./SyncEffectWorkerConstants.js";
import {
  isPresent,
  lookupResult,
  throwWorkerError,
} from "./SyncEffectWorkerHelpers.js";
import type { ClaimedEffect } from "./SyncEffectWorker.js";

/** Accepts either inline read-back or a flushed-write acknowledgement. */
export function isSuccessfulPostcondition(
  status: SyncEffectResult["postcondition"],
): boolean {
  return status === SYNC_POSTCONDITION_STATUSES.VERIFIED ||
    status === SYNC_POSTCONDITION_STATUSES.ACKNOWLEDGED;
}

export function toProviderEffect(effect: PendingEffect): SyncProjectionEffect {
  if (!isSyncEffectKind(effect.effect_kind)) {
    throwWorkerError("unsupported sync effect kind: " + effect.effect_kind);
  }
  if (!isSyncProjection(effect.projection)) {
    throwWorkerError("unsupported sync projection: " + effect.projection);
  }
  if (!isEffectTargetKind(effect.target_kind)) {
    throwWorkerError("unsupported sync effect target kind: " + effect.target_kind);
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

export function groupByProviderRequest(
  items: readonly ClaimedEffect[],
): readonly ProviderEffectGroup[] {
  const groups = new Map<string, { request: ApplySyncEffectsRequest; items: ClaimedEffect[] }>();
  for (const item of items) {
    const effect = item.providerEffect;
    if (!isPresent(effect)) continue;
    const key = routeKey(effect.value);
    const existing = lookupResult(groups.get(key));
    if (existing.kind === LOOKUP_RESULT_KINDS.NOT_FOUND) {
      groups.set(key, {
        request: {
          physicalSheetId: effect.value.physicalSheetId,
          sheetName: effect.value.payload.sheetName,
          registeredRange: effect.value.payload.registeredRange,
          projection: effect.value.projection,
          schemaVersion: effect.value.payload.schemaVersion,
          postconditionMode: SYNC_POSTCONDITION_MODES.DEFERRED,
          effects: [effect.value],
        },
        items: [item],
      });
    } else {
      existing.value.request = {
        ...existing.value.request,
        postconditionMode: SYNC_POSTCONDITION_MODES.DEFERRED,
        effects: [...existing.value.request.effects, effect.value],
      };
      existing.value.items.push(item);
    }
  }
  return [...groups.values()];
}

/** One append-only route paired with the claimed effects it represents. */
export interface FastAppendProviderGroup {
  readonly request: FastAppendRowsRequest;
  readonly items: readonly ClaimedEffect[];
}

/** Groups append-only effects into one fast provider request per route. */
export function groupByFastAppendRequest(
  items: readonly ClaimedEffect[],
): readonly FastAppendProviderGroup[] {
  const groups = new Map<string, { request: FastAppendRowsRequest; items: ClaimedEffect[] }>();
  for (const item of items) {
    const effect = item.providerEffect;
    if (!isPresent(effect)) continue;
    const key = routeKey(effect.value);
    const row = {
      effectId: effect.value.effectId,
      payloadHash: effect.value.payloadHash,
      anchor: effect.value.payload.targetAnchor,
      fields: effect.value.payload.fields,
    };
    const existing = lookupResult(groups.get(key));
    if (existing.kind === LOOKUP_RESULT_KINDS.NOT_FOUND) {
      groups.set(key, {
        request: {
          physicalSheetId: effect.value.physicalSheetId,
          sheetName: effect.value.payload.sheetName,
          registeredRange: effect.value.payload.registeredRange,
          projection: effect.value.projection,
          schemaVersion: effect.value.payload.schemaVersion,
          rows: [row],
        },
        items: [item],
      });
    } else {
      existing.value.request = {
        ...existing.value.request,
        rows: [...existing.value.request.rows, row],
      };
      existing.value.items.push(item);
    }
  }
  return [...groups.values()];
}

/** Splits append groups using the same adaptive route limit as regular effects. */
export function chunkFastAppendGroups(
  groups: readonly FastAppendProviderGroup[],
  limit: number | ((group: FastAppendProviderGroup) => number),
): readonly FastAppendProviderGroup[] {
  const chunked: FastAppendProviderGroup[] = [];
  for (const group of groups) {
    const groupLimit = typeof limit === "function" ? limit(group) : limit;
    requireBatchLimit(groupLimit);
    if (group.items.length <= groupLimit) {
      chunked.push(group);
      continue;
    }
    for (let start = 0; start < group.items.length; start += groupLimit) {
      const items = group.items.slice(start, start + groupLimit);
      chunked.push({
        request: {
          ...group.request,
          rows: group.request.rows.slice(start, start + groupLimit),
        },
        items,
      });
    }
  }
  return chunked;
}

/** Groups postcondition reads so each group performs one remote Sheet scan. */
export function groupByPostconditionRequest(
  items: readonly ClaimedEffect[],
): readonly {
  readonly request: ReadSyncEffectPostconditionsRequest;
  readonly items: readonly ClaimedEffect[];
}[] {
  const groups = new Map<string, {
    request: ReadSyncEffectPostconditionsRequest;
    items: ClaimedEffect[];
  }>();
  for (const item of items) {
    const effect = item.providerEffect;
    if (!isPresent(effect)) continue;
    const key = routeKey(effect.value);
    const existing = lookupResult(groups.get(key));
    if (existing.kind === LOOKUP_RESULT_KINDS.NOT_FOUND) {
      groups.set(key, {
        request: {
          physicalSheetId: effect.value.physicalSheetId,
          sheetName: effect.value.payload.sheetName,
          registeredRange: effect.value.payload.registeredRange,
          projection: effect.value.projection,
          schemaVersion: effect.value.payload.schemaVersion,
          effects: [effect.value],
        },
        items: [item],
      });
    } else {
      existing.value.request = {
        ...existing.value.request,
        effects: [...existing.value.request.effects, effect.value],
      };
      existing.value.items.push(item);
    }
  }
  return [...groups.values()];
}

/** Builds the stable grouping key shared by all provider operations on one route. */
export function routeKey(
  route: SyncProjectionEffect | ApplySyncEffectsRequest | FastAppendRowsRequest,
): string {
  const sheetName = "payload" in route ? route.payload.sheetName : route.sheetName;
  const registeredRange = "payload" in route ? route.payload.registeredRange : route.registeredRange;
  const schemaVersion = "payload" in route ? route.payload.schemaVersion : route.schemaVersion;
  return [route.physicalSheetId, sheetName, registeredRange, route.projection, schemaVersion].join("\u0000");
}

function requireBatchLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < POSITIVE_SAFE_INTEGER_MINIMUM) {
    throwWorkerError("provider effect batch limit must be a positive safe integer");
  }
}

/**
 * Splits each physical-route group into sub-batches no larger than the
 * provider's bounded effect batch (`EFFECT_BATCH_LIMIT` in the worker
 * constants, matching `MAX_EFFECTS_PER_REQUEST` in the Google Sheets API
 * provider constants) so one `applyEffects` call returns a complete result
 * set instead of a `hasMore` partial prefix.
 *
 * The physical-route grouping and the per-target predecessor ordering of the
 * supplied items are preserved: every effect stays on its original route, and
 * each sub-batch keeps the order of the ready selection. Effects in one ready
 * selection target distinct logical targets (the outbox only marks the
 * earliest non-applied effect per target ready), so sub-batching never
 * reorders effects that depend on one another.
 */
export function chunkProviderEffectGroups(
  groups: readonly ProviderEffectGroup[],
  limit: number | ((group: ProviderEffectGroup) => number) = EFFECT_BATCH_LIMIT,
): readonly ProviderEffectGroup[] {
  if (groups.length === 0) return groups;
  const chunked: ProviderEffectGroup[] = [];
  for (const group of groups) {
    const groupLimit = typeof limit === "function" ? limit(group) : limit;
    requireBatchLimit(groupLimit);
    if (group.items.length <= groupLimit) {
      chunked.push(group);
      continue;
    }
    for (let start = 0; start < group.items.length; start += groupLimit) {
      const batchItems = group.items.slice(start, start + groupLimit);
      chunked.push({ request: sliceApplyEffectsRequest(group.request, batchItems), items: batchItems });
    }
  }
  return chunked;
}

/** Builds a sub-batch request carrying only the supplied effect evidence. */
function sliceApplyEffectsRequest(
  request: ApplySyncEffectsRequest,
  items: readonly ClaimedEffect[],
): ApplySyncEffectsRequest {
  const effects: SyncProjectionEffect[] = [];
  for (const item of items) {
    if (!isPresent(item.providerEffect)) {
      throwWorkerError("provider effect batch item is missing its provider effect");
    }
    effects.push(item.providerEffect.value);
  }
  return {
    physicalSheetId: request.physicalSheetId,
    sheetName: request.sheetName,
    registeredRange: request.registeredRange,
    projection: request.projection,
    schemaVersion: request.schemaVersion,
    postconditionMode: request.postconditionMode ?? SYNC_POSTCONDITION_MODES.DEFERRED,
    effects,
  };
}

/** One physical route's effects paired with their provider request. */
export interface ProviderEffectGroup {
  readonly request: ApplySyncEffectsRequest;
  readonly items: readonly ClaimedEffect[];
}

export function isSyncEffectKind(value: string): value is SyncProjectionEffect["effectKind"] {
  return value === SYNC_EFFECT_KINDS.SYSTEM_PROJECTION ||
    value === SYNC_EFFECT_KINDS.CANDIDATE_RECONCILE ||
    value === SYNC_EFFECT_KINDS.SYSTEM_REPAIR ||
    value === SYNC_EFFECT_KINDS.RESOLUTION_PROJECTION ||
    value === SYNC_EFFECT_KINDS.RESOLUTION_DELETE ||
    value === SYNC_EFFECT_KINDS.USER_INPUT_DELETE;
}

export function isCandidateProtectingUserInputEffect(effect: SyncProjectionEffect): boolean {
  return effect.effectKind === SYNC_EFFECT_KINDS.CANDIDATE_RECONCILE ||
    effect.effectKind === SYNC_EFFECT_KINDS.USER_INPUT_DELETE;
}

/** Selects only new System_State entity rows for the append-only fast path. */
export function isFastAppendCandidate(item: ClaimedEffect): boolean {
  if (!isPresent(item.providerEffect)) return false;
  return isFastAppendEffect(item.providerEffect.value);
}

/** Classifies one converted provider effect as an append-only fast candidate. */
export function isFastAppendEffect(effect: SyncProjectionEffect): boolean {
  const emptyVisibleBaseline = effect.payload.createIfMissing &&
    effect.expectedVisibleRevision === NON_NEGATIVE_SAFE_INTEGER_MINIMUM &&
    effect.expectedVisibleHash === "";
  if (!emptyVisibleBaseline) return false;
  return (
    effect.effectKind === SYNC_EFFECT_KINDS.SYSTEM_PROJECTION &&
      effect.projection === SYNC_PROJECTIONS.SYSTEM_STATE &&
      effect.targetKind === EFFECT_TARGET_KINDS.ENTITY
  ) || (
    effect.effectKind === SYNC_EFFECT_KINDS.RESOLUTION_PROJECTION &&
      effect.projection === SYNC_PROJECTIONS.SYNC_CONFLICTS &&
      effect.targetKind === EFFECT_TARGET_KINDS.CONFLICT
  );
}

/**
 * Pending-level fast-append classification used to bound a bulk claim window
 * before conversion. Recovery-status effects are excluded because the claim
 * loop diverts them to recovery regardless of their append shape.
 */
export function isFastAppendPendingEffect(pending: PendingEffect): boolean {
  if (
    pending.status === OUTBOX_EFFECT_STATUSES.FAILED ||
    pending.status === OUTBOX_EFFECT_STATUSES.DELIVERY_UNCERTAIN
  ) {
    return false;
  }
  try {
    return isFastAppendEffect(toProviderEffect(pending));
  } catch {
    return false;
  }
}

export function isSyncProjection(value: string): value is SyncProjection {
  return value === SYNC_PROJECTIONS.USER_INPUT ||
    value === SYNC_PROJECTIONS.SYSTEM_STATE ||
    value === SYNC_PROJECTIONS.SYNC_CONFLICTS;
}

export function isEffectTargetKind(value: string): value is EffectTargetKind {
  return value === EFFECT_TARGET_KINDS.ENTITY ||
    value === EFFECT_TARGET_KINDS.ROW_BINDING ||
    value === EFFECT_TARGET_KINDS.PROJECTION_ROW ||
    value === EFFECT_TARGET_KINDS.CONFLICT;
}

export function fenceFromLease(lease: WriterLease, now: number): FencingContext {
  return {
    role: lease.role,
    writerEpoch: lease.writerEpoch,
    fencingToken: lease.fencingToken,
    now,
  };
}
