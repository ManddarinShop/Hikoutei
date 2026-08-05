/** Timing classification and diagnostics emission for one effect-worker pass. */

import { NON_NEGATIVE_SAFE_INTEGER_MINIMUM } from "../../../../domain/index.js";
import type { PendingEffect } from "../../../../infrastructure/storage/index.js";
import type { SyncProjectionEffect } from "../../sheets/syncSheets.js";
import {
  SYNC_TIMING_OPERATION_KINDS,
  SYNC_TIMING_SCOPES,
  type SyncSheetsTiming,
  type SyncTimingEvent,
  type SyncTimingOperationCounts,
  type SyncTimingOperationKind,
} from "../../telemetry/syncTiming.js";
import { SYNC_EFFECT_KINDS } from "./SyncEffectWorkerConstants.js";
import { isPresent } from "./SyncEffectWorkerHelpers.js";
import type {
  ClaimedEffect,
  SyncEffectWorkerBaseOptions,
} from "./SyncEffectWorker.js";

export function emptyOperationCounts(): SyncTimingOperationCounts {
  return { append: 0, update: 0, delete: 0 };
}

export function timingOperationKindForEffect(effect: SyncProjectionEffect): SyncTimingOperationKind {
  if (
    effect.effectKind === SYNC_EFFECT_KINDS.RESOLUTION_DELETE ||
    effect.effectKind === SYNC_EFFECT_KINDS.USER_INPUT_DELETE
  ) {
    return SYNC_TIMING_OPERATION_KINDS.DELETE;
  }
  if (
    effect.payload.createIfMissing &&
    effect.expectedVisibleRevision === NON_NEGATIVE_SAFE_INTEGER_MINIMUM &&
    effect.expectedVisibleHash === ""
  ) {
    return SYNC_TIMING_OPERATION_KINDS.APPEND;
  }
  return SYNC_TIMING_OPERATION_KINDS.UPDATE;
}

export function timingOperationKindForPending(effect: PendingEffect): SyncTimingOperationKind {
  if (
    effect.effect_kind === SYNC_EFFECT_KINDS.RESOLUTION_DELETE ||
    effect.effect_kind === SYNC_EFFECT_KINDS.USER_INPUT_DELETE
  ) {
    return SYNC_TIMING_OPERATION_KINDS.DELETE;
  }
  if (
    effect.expected_visible_revision === NON_NEGATIVE_SAFE_INTEGER_MINIMUM &&
    effect.expected_visible_hash === ""
  ) {
    return SYNC_TIMING_OPERATION_KINDS.APPEND;
  }
  return SYNC_TIMING_OPERATION_KINDS.UPDATE;
}

export function countsForOperationKinds(
  kinds: readonly SyncTimingOperationKind[],
): SyncTimingOperationCounts {
  return {
    append: kinds.filter((kind) => kind === SYNC_TIMING_OPERATION_KINDS.APPEND).length,
    update: kinds.filter((kind) => kind === SYNC_TIMING_OPERATION_KINDS.UPDATE).length,
    delete: kinds.filter((kind) => kind === SYNC_TIMING_OPERATION_KINDS.DELETE).length,
  };
}

export function countsForItems(items: readonly ClaimedEffect[]): SyncTimingOperationCounts {
  const kinds = items.flatMap((item) =>
    isPresent(item.providerEffect) ? [timingOperationKindForEffect(item.providerEffect.value)] : []);
  return countsForOperationKinds(kinds);
}

export function operationKindsForItems(items: readonly ClaimedEffect[]): readonly SyncTimingOperationKind[] {
  return operationKindsForCounts(countsForItems(items));
}

export function countsForPendingEffects(effects: readonly PendingEffect[]): SyncTimingOperationCounts {
  return countsForOperationKinds(effects.map(timingOperationKindForPending));
}

export function operationKindsForPendingEffects(
  effects: readonly PendingEffect[],
): readonly SyncTimingOperationKind[] {
  return operationKindsForCounts(countsForPendingEffects(effects));
}

export function operationKindsForCounts(
  counts: SyncTimingOperationCounts,
): readonly SyncTimingOperationKind[] {
  return [
    ...(counts.append > 0 ? [SYNC_TIMING_OPERATION_KINDS.APPEND] : []),
    ...(counts.update > 0 ? [SYNC_TIMING_OPERATION_KINDS.UPDATE] : []),
    ...(counts.delete > 0 ? [SYNC_TIMING_OPERATION_KINDS.DELETE] : []),
  ];
}

export function emitProviderTiming(
  options: SyncEffectWorkerBaseOptions,
  timing: SyncSheetsTiming | undefined,
): void {
  if (timing === undefined) return;
  for (const phase of timing.phases) {
    emitWorkerTiming(options, {
      scope: SYNC_TIMING_SCOPES.PROVIDER,
      phase: phase.phase,
      durationMs: phase.durationMs,
      operationKinds: timing.operationKinds,
      operationCounts: timing.operationCounts,
    });
  }
}

export function emitWorkerTiming(
  options: SyncEffectWorkerBaseOptions,
  event: SyncTimingEvent,
): void {
  try {
    options.onTiming?.(event);
  } catch {
    // Diagnostics must never change worker state transitions.
  }
}
