/**
 * Timing helpers for mapped persistence diagnostics.
 *
 * Timing callbacks are deliberately best-effort: observability failures must
 * never abort the entity transaction they describe.
 */

import {
  SYNC_TIMING_OPERATION_KINDS,
  type SyncTimingOperationCounts,
  type SyncTimingOperationKind,
  type SyncTimingSink,
} from "../../runtime/telemetry/syncTiming.js";
import {
  TYPED_SHEETS_ENTITY_CHANGE_KINDS,
  type TypedSheetsEntityChange,
} from "../api/contracts.js";
import type {
  MappedChangePlan,
  ResolvedWriterOptions,
} from "./contracts.js";

/** Converts public entity lifecycle kinds into timing operation kinds. */
export function timingOperationKind(
  value: TypedSheetsEntityChange["kind"],
): SyncTimingOperationKind {
  if (value === TYPED_SHEETS_ENTITY_CHANGE_KINDS.CREATE) {
    return SYNC_TIMING_OPERATION_KINDS.APPEND;
  }
  if (value === TYPED_SHEETS_ENTITY_CHANGE_KINDS.UPDATE) {
    return SYNC_TIMING_OPERATION_KINDS.UPDATE;
  }
  return SYNC_TIMING_OPERATION_KINDS.DELETE;
}

/** Counts one lifecycle operation for aggregate diagnostics. */
export function countsForOperationKind(
  operationKind: SyncTimingOperationKind,
): SyncTimingOperationCounts {
  return {
    append: operationKind === SYNC_TIMING_OPERATION_KINDS.APPEND ? 1 : 0,
    update: operationKind === SYNC_TIMING_OPERATION_KINDS.UPDATE ? 1 : 0,
    delete: operationKind === SYNC_TIMING_OPERATION_KINDS.DELETE ? 1 : 0,
  };
}

/** Counts all mapped lifecycle plans in one flush. */
export function countsForPlans(plans: readonly MappedChangePlan[]): SyncTimingOperationCounts {
  return plans.reduce<SyncTimingOperationCounts>((counts, plan) => {
    const operationKind = timingOperationKind(plan.change.kind);
    return {
      append: counts.append + (operationKind === SYNC_TIMING_OPERATION_KINDS.APPEND ? 1 : 0),
      update: counts.update + (operationKind === SYNC_TIMING_OPERATION_KINDS.UPDATE ? 1 : 0),
      delete: counts.delete + (operationKind === SYNC_TIMING_OPERATION_KINDS.DELETE ? 1 : 0),
    };
  }, { append: 0, update: 0, delete: 0 });
}

/** Lists only operation kinds represented by the supplied aggregate counts. */
export function operationKindsForCounts(
  counts: SyncTimingOperationCounts,
): readonly SyncTimingOperationKind[] {
  return [
    ...(counts.append > 0 ? [SYNC_TIMING_OPERATION_KINDS.APPEND] : []),
    ...(counts.update > 0 ? [SYNC_TIMING_OPERATION_KINDS.UPDATE] : []),
    ...(counts.delete > 0 ? [SYNC_TIMING_OPERATION_KINDS.DELETE] : []),
  ];
}

/** Emits diagnostics without allowing a faulty sink to affect persistence. */
export function emitTiming(
  writer: ResolvedWriterOptions,
  event: Parameters<SyncTimingSink>[0],
): void {
  try {
    writer.onTiming?.(event);
  } catch {
    // Diagnostics must never abort the entity transaction.
  }
}
