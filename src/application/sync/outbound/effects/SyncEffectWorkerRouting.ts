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
  SyncGatewayAuthority,
  SyncGatewayEffect,
  SyncGatewayEffectResult,
  SyncProjection,
} from "../../gateway/syncGateway.js";
import { parseSyncProjectionEffectPayload } from "../../gateway/syncGateway.js";
import {
  SYNC_GATEWAY_POSTCONDITION_MODES,
  SYNC_GATEWAY_POSTCONDITION_STATUSES,
  SYNC_GATEWAY_PROJECTIONS,
} from "../../gateway/constants.js";
import {
  EFFECT_TARGET_KINDS,
  GATEWAY_EFFECT_BATCH_LIMIT,
  SYNC_EFFECT_KINDS,
} from "./SyncEffectWorkerConstants.js";
import {
  isPresent,
  lookupResult,
  throwWorkerError,
} from "./SyncEffectWorkerHelpers.js";
import type { ClaimedEffect } from "./SyncEffectWorker.js";

/** Accepts either inline read-back or a flushed-write acknowledgement. */
export function isSuccessfulGatewayPostcondition(
  status: SyncGatewayEffectResult["postcondition"],
): boolean {
  return status === SYNC_GATEWAY_POSTCONDITION_STATUSES.VERIFIED ||
    status === SYNC_GATEWAY_POSTCONDITION_STATUSES.ACKNOWLEDGED;
}

export function toGatewayEffect(effect: PendingEffect): SyncGatewayEffect {
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

export function groupByGatewayRequest(
  items: readonly ClaimedEffect[],
  authority?: SyncGatewayAuthority,
): readonly GatewayEffectGroup[] {
  const groups = new Map<string, { request: ApplySyncEffectsRequest; items: ClaimedEffect[] }>();
  for (const item of items) {
    const effect = item.gatewayEffect;
    if (!isPresent(effect)) continue;
    const key = gatewayRouteKey(effect.value);
    const existing = lookupResult(groups.get(key));
    if (existing.kind === LOOKUP_RESULT_KINDS.NOT_FOUND) {
      groups.set(key, {
        request: {
          physicalSheetId: effect.value.physicalSheetId,
          ...(authority === undefined ? {} : { authority }),
          sheetName: effect.value.payload.sheetName,
          registeredRange: effect.value.payload.registeredRange,
          projection: effect.value.projection,
          schemaVersion: effect.value.payload.schemaVersion,
          postconditionMode: SYNC_GATEWAY_POSTCONDITION_MODES.DEFERRED,
          effects: [effect.value],
        },
        items: [item],
      });
    } else {
      existing.value.request = {
        ...existing.value.request,
        postconditionMode: SYNC_GATEWAY_POSTCONDITION_MODES.DEFERRED,
        effects: [...existing.value.request.effects, effect.value],
      };
      existing.value.items.push(item);
    }
  }
  return [...groups.values()];
}

/** One append-only route paired with the claimed effects it represents. */
export interface FastAppendGatewayGroup {
  readonly request: FastAppendRowsRequest;
  readonly items: readonly ClaimedEffect[];
}

/** Groups append-only effects into one fast gateway request per route. */
export function groupByFastAppendRequest(
  items: readonly ClaimedEffect[],
  authority?: SyncGatewayAuthority,
): readonly FastAppendGatewayGroup[] {
  const groups = new Map<string, { request: FastAppendRowsRequest; items: ClaimedEffect[] }>();
  for (const item of items) {
    const effect = item.gatewayEffect;
    if (!isPresent(effect)) continue;
    const key = gatewayRouteKey(effect.value);
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
          ...(authority === undefined ? {} : { authority }),
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
  groups: readonly FastAppendGatewayGroup[],
  limit: number | ((group: FastAppendGatewayGroup) => number),
): readonly FastAppendGatewayGroup[] {
  const chunked: FastAppendGatewayGroup[] = [];
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
export function groupByGatewayPostconditionRequest(
  items: readonly ClaimedEffect[],
  authority?: SyncGatewayAuthority,
): readonly {
  readonly request: ReadSyncEffectPostconditionsRequest;
  readonly items: readonly ClaimedEffect[];
}[] {
  const groups = new Map<string, {
    request: ReadSyncEffectPostconditionsRequest;
    items: ClaimedEffect[];
  }>();
  for (const item of items) {
    const effect = item.gatewayEffect;
    if (!isPresent(effect)) continue;
    const key = gatewayRouteKey(effect.value);
    const existing = lookupResult(groups.get(key));
    if (existing.kind === LOOKUP_RESULT_KINDS.NOT_FOUND) {
      groups.set(key, {
        request: {
          physicalSheetId: effect.value.physicalSheetId,
          ...(authority === undefined ? {} : { authority }),
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

/** Builds the stable grouping key shared by all gateway operations on one route. */
export function gatewayRouteKey(
  route: SyncGatewayEffect | ApplySyncEffectsRequest | FastAppendRowsRequest,
): string {
  const sheetName = "payload" in route ? route.payload.sheetName : route.sheetName;
  const registeredRange = "payload" in route ? route.payload.registeredRange : route.registeredRange;
  const schemaVersion = "payload" in route ? route.payload.schemaVersion : route.schemaVersion;
  return [route.physicalSheetId, sheetName, registeredRange, route.projection, schemaVersion].join("\u0000");
}

function requireBatchLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < POSITIVE_SAFE_INTEGER_MINIMUM) {
    throwWorkerError("gateway effect batch limit must be a positive safe integer");
  }
}

/**
 * Splits each physical-route group into sub-batches no larger than the Apps
 * Script bounded effect batch so one `applyEffects` call returns a complete
 * result set instead of a `hasMore` partial prefix.
 *
 * The physical-route grouping and the per-target predecessor ordering of the
 * supplied items are preserved: every effect stays on its original route, and
 * each sub-batch keeps the order of the ready selection. Effects in one ready
 * selection target distinct logical targets (the outbox only marks the
 * earliest non-applied effect per target ready), so sub-batching never
 * reorders effects that depend on one another.
 */
export function chunkGatewayEffectGroups(
  groups: readonly GatewayEffectGroup[],
  limit: number | ((group: GatewayEffectGroup) => number) = GATEWAY_EFFECT_BATCH_LIMIT,
): readonly GatewayEffectGroup[] {
  if (groups.length === 0) return groups;
  const chunked: GatewayEffectGroup[] = [];
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
  const effects: SyncGatewayEffect[] = [];
  for (const item of items) {
    if (!isPresent(item.gatewayEffect)) {
      throwWorkerError("gateway effect batch item is missing its gateway effect");
    }
    effects.push(item.gatewayEffect.value);
  }
  return {
    physicalSheetId: request.physicalSheetId,
    ...(request.authority === undefined ? {} : { authority: request.authority }),
    sheetName: request.sheetName,
    registeredRange: request.registeredRange,
    projection: request.projection,
    schemaVersion: request.schemaVersion,
    postconditionMode: request.postconditionMode ?? SYNC_GATEWAY_POSTCONDITION_MODES.DEFERRED,
    effects,
  };
}

/** One physical route's effects paired with their gateway request. */
export interface GatewayEffectGroup {
  readonly request: ApplySyncEffectsRequest;
  readonly items: readonly ClaimedEffect[];
}

export function isSyncEffectKind(value: string): value is SyncGatewayEffect["effectKind"] {
  return value === SYNC_EFFECT_KINDS.SYSTEM_PROJECTION ||
    value === SYNC_EFFECT_KINDS.CANDIDATE_RECONCILE ||
    value === SYNC_EFFECT_KINDS.SYSTEM_REPAIR ||
    value === SYNC_EFFECT_KINDS.RESOLUTION_PROJECTION ||
    value === SYNC_EFFECT_KINDS.RESOLUTION_DELETE ||
    value === SYNC_EFFECT_KINDS.USER_INPUT_DELETE;
}

export function isCandidateProtectingUserInputEffect(effect: SyncGatewayEffect): boolean {
  return effect.effectKind === SYNC_EFFECT_KINDS.CANDIDATE_RECONCILE ||
    effect.effectKind === SYNC_EFFECT_KINDS.USER_INPUT_DELETE;
}

/** Selects only new System_State entity rows for the append-only fast path. */
export function isFastAppendCandidate(item: ClaimedEffect): boolean {
  if (!isPresent(item.gatewayEffect)) return false;
  const effect = item.gatewayEffect.value;
  const emptyVisibleBaseline = effect.payload.createIfMissing &&
    effect.expectedVisibleRevision === NON_NEGATIVE_SAFE_INTEGER_MINIMUM &&
    effect.expectedVisibleHash === "";
  if (!emptyVisibleBaseline) return false;
  return (
    effect.effectKind === SYNC_EFFECT_KINDS.SYSTEM_PROJECTION &&
      effect.projection === SYNC_GATEWAY_PROJECTIONS.SYSTEM_STATE &&
      effect.targetKind === EFFECT_TARGET_KINDS.ENTITY
  ) || (
    effect.effectKind === SYNC_EFFECT_KINDS.RESOLUTION_PROJECTION &&
      effect.projection === SYNC_GATEWAY_PROJECTIONS.SYNC_CONFLICTS &&
      effect.targetKind === EFFECT_TARGET_KINDS.CONFLICT
  );
}

export function isSyncProjection(value: string): value is SyncProjection {
  return value === SYNC_GATEWAY_PROJECTIONS.USER_INPUT ||
    value === SYNC_GATEWAY_PROJECTIONS.SYSTEM_STATE ||
    value === SYNC_GATEWAY_PROJECTIONS.SYNC_CONFLICTS;
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
