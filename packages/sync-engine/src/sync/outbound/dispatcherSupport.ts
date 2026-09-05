/**
 * Dispatcher support helpers extracted from `SheetsEffectDispatcher.ts`.
 *
 * Pure mechanical move: the priority/route-key/validation classification
 * helpers, the `PreparedDispatchError` class, and the pending-effect to
 * provider-effect conversion predicates. All behavior, comments, and export
 * visibility are unchanged; `SheetsEffectDispatcher.ts` re-exports the
 * symbols that were exported from there before the extraction.
 */

import {
  NON_NEGATIVE_SAFE_INTEGER_MINIMUM,
} from "@hikoutei/contracts/constants.js";
import type {
  PendingEffect,
  Presence,
} from "@hikoutei/ikisaki";
import {
  EFFECT_KINDS,
  EFFECT_TARGET_KINDS,
} from "@hikoutei/contracts/domain/model/constants.js";
import type { EffectTargetKind } from "@hikoutei/contracts/domain/model/constants.js";
import {
  absentValue,
  presentValue,
} from "@hikoutei/contracts/state/index.js";
import { fromSqlNullable } from "@hikoutei/storage/storage/sqlite/sqlState.js";
import { parseSyncProjectionEffectPayload, type SyncProjectionEffect } from "@hikoutei/contracts/sheets/syncSheets.js";
import {
  SYNC_PROJECTIONS,
} from "@hikoutei/contracts/sheets/constants.js";
import {
  SYNC_EFFECT_CONTRACT_ERROR_CODES,
  SyncEffectContractError,
} from "./errors.js";

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

/** Classified, safe error for an invalid or foreign prepared-apply token. */
export class PreparedDispatchError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PreparedDispatchError";
  }
}

/** Validates and converts one durable outbox row into a provider effect. */
export function toProviderEffect(effect: PendingEffect): SyncProjectionEffect {
  if (!isSyncEffectKind(effect.effect_kind)) {
    throw new SyncEffectContractError(
      SYNC_EFFECT_CONTRACT_ERROR_CODES.UNSUPPORTED_SYNC_EFFECT_KIND,
      effect.effect_kind,
    );
  }
  if (!isSyncProjection(effect.projection)) {
    throw new SyncEffectContractError(
      SYNC_EFFECT_CONTRACT_ERROR_CODES.UNSUPPORTED_SYNC_PROJECTION,
      effect.projection,
    );
  }
  if (!isEffectTargetKind(effect.target_kind)) {
    throw new SyncEffectContractError(
      SYNC_EFFECT_CONTRACT_ERROR_CODES.UNSUPPORTED_SYNC_EFFECT_TARGET_KIND,
      effect.target_kind,
    );
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

export function safeProviderErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : "unknown sync provider failure";
}