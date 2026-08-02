/** Effect conversion, request grouping, and routing predicates. */

import { NON_NEGATIVE_SAFE_INTEGER_MINIMUM } from "../../../../domain/index.js";
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
import { EFFECT_TARGET_KINDS, SYNC_EFFECT_KINDS } from "./SyncEffectWorkerConstants.js";
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

export function groupByGatewayRequest(items: readonly ClaimedEffect[]): readonly {
  readonly request: ApplySyncEffectsRequest;
  readonly items: readonly ClaimedEffect[];
}[] {
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

/** Groups append-only system effects into one fast gateway request per route. */
export function groupByFastAppendRequest(items: readonly ClaimedEffect[]): readonly {
  readonly request: FastAppendRowsRequest;
  readonly items: readonly ClaimedEffect[];
}[] {
  const groups = new Map<string, { request: FastAppendRowsRequest; items: ClaimedEffect[] }>();
  for (const item of items) {
    const effect = item.gatewayEffect;
    if (!isPresent(effect)) continue;
    const key = gatewayRouteKey(effect.value);
    const row = {
      effectId: effect.value.effectId,
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

/** Groups postcondition reads so each group performs one remote Sheet scan. */
export function groupByGatewayPostconditionRequest(items: readonly ClaimedEffect[]): readonly {
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
function gatewayRouteKey(effect: SyncGatewayEffect): string {
  return [
    effect.physicalSheetId,
    effect.payload.sheetName,
    effect.payload.registeredRange,
    effect.projection,
    effect.payload.schemaVersion,
  ].join("\u0000");
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
  return effect.effectKind === SYNC_EFFECT_KINDS.SYSTEM_PROJECTION &&
    effect.projection === SYNC_GATEWAY_PROJECTIONS.SYSTEM_STATE &&
    effect.targetKind === EFFECT_TARGET_KINDS.ENTITY &&
    effect.payload.createIfMissing &&
    effect.expectedVisibleRevision === NON_NEGATIVE_SAFE_INTEGER_MINIMUM &&
    effect.expectedVisibleHash === "";
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
