/** Timing classification and diagnostics emission for one effect-worker pass. */

import type { PendingEffect } from "../../contract/contracts.js";
import { EFFECT_KINDS } from "../../contract/constants.js";
import type { ClaimedEffect } from "../contracts.js";
import type { EffectWorkerBaseOptions } from "../options.js";
import { isAbsent } from "../helpers.js";

/** Diagnostic scopes emitted by the worker. */
export const TIMING_SCOPES = {
  WORKER: "worker",
  PROVIDER: "provider",
} as const;

export type TimingScope =
  (typeof TIMING_SCOPES)[keyof typeof TIMING_SCOPES];

/** Lifecycle operation kinds counted by worker timing events. */
export const TIMING_OPERATION_KINDS = {
  APPEND: "append",
  UPDATE: "update",
  DELETE: "delete",
} as const;

export type TimingOperationKind =
  (typeof TIMING_OPERATION_KINDS)[keyof typeof TIMING_OPERATION_KINDS];

/** Count of lifecycle operations represented by one timing event. */
export interface TimingOperationCounts {
  readonly append: number;
  readonly update: number;
  readonly delete: number;
}

/** Optional phase timing returned by one remote provider operation. */
export interface ProviderTiming {
  readonly operationKinds: readonly TimingOperationKind[];
  readonly operationCounts: TimingOperationCounts;
  readonly durationMs: number;
  readonly phases: readonly ProviderTimingPhase[];
}

/** One measured implementation phase inside a remote provider operation. */
export interface ProviderTimingPhase {
  readonly phase: string;
  readonly durationMs: number;
}

/** One local or remote phase sent to the application's diagnostics sink. */
export interface TimingEvent {
  readonly scope: TimingScope;
  readonly phase: string;
  readonly durationMs: number;
  readonly operationKinds: readonly TimingOperationKind[];
  readonly operationCounts: TimingOperationCounts;
  /** Optional route/batch diagnostics used by adaptive outbound dispatch. */
  readonly routeKey?: string;
  readonly batchLimit?: number;
  readonly responseSucceeded?: boolean;
  /** True when the provider deferred a suffix past this batch (body budget). */
  readonly hasMore?: boolean;
  /** Effects requested for this dispatch batch. */
  readonly requestedEffects?: number;
  /** Effects acknowledged by the provider result for this dispatch batch. */
  readonly acknowledgedEffects?: number;
}

/** Optional observer used by servers and benchmarks to collect timings. */
export type TimingSink = (event: TimingEvent) => void;

export function emptyOperationCounts(): TimingOperationCounts {
  return { append: 0, update: 0, delete: 0 };
}

/** Classifies one pending effect's lifecycle operation from kernel fields only. */
export function timingOperationKindForPending(effect: PendingEffect): TimingOperationKind {
  if (
    effect.effect_kind === EFFECT_KINDS.RESOLUTION_DELETE ||
    effect.effect_kind === EFFECT_KINDS.USER_INPUT_DELETE
  ) {
    return TIMING_OPERATION_KINDS.DELETE;
  }
  if (
    effect.expected_visible_revision === 0 &&
    effect.expected_visible_hash === ""
  ) {
    return TIMING_OPERATION_KINDS.APPEND;
  }
  return TIMING_OPERATION_KINDS.UPDATE;
}

export function countsForOperationKinds(
  kinds: readonly TimingOperationKind[],
): TimingOperationCounts {
  return {
    append: kinds.filter((kind) => kind === TIMING_OPERATION_KINDS.APPEND).length,
    update: kinds.filter((kind) => kind === TIMING_OPERATION_KINDS.UPDATE).length,
    delete: kinds.filter((kind) => kind === TIMING_OPERATION_KINDS.DELETE).length,
  };
}

export function countsForItems(items: readonly ClaimedEffect[]): TimingOperationCounts {
  const kinds = items.flatMap((item) =>
    isAbsent(item.invalidPayloadError) ? [timingOperationKindForPending(item.pending)] : []);
  return countsForOperationKinds(kinds);
}

export function operationKindsForItems(
  items: readonly ClaimedEffect[],
): readonly TimingOperationKind[] {
  return operationKindsForCounts(countsForItems(items));
}

export function countsForPendingEffects(
  effects: readonly PendingEffect[],
): TimingOperationCounts {
  return countsForOperationKinds(effects.map(timingOperationKindForPending));
}

export function operationKindsForPendingEffects(
  effects: readonly PendingEffect[],
): readonly TimingOperationKind[] {
  return operationKindsForCounts(countsForPendingEffects(effects));
}

export function operationKindsForCounts(
  counts: TimingOperationCounts,
): readonly TimingOperationKind[] {
  return [
    ...(counts.append > 0 ? [TIMING_OPERATION_KINDS.APPEND] : []),
    ...(counts.update > 0 ? [TIMING_OPERATION_KINDS.UPDATE] : []),
    ...(counts.delete > 0 ? [TIMING_OPERATION_KINDS.DELETE] : []),
  ];
}

export function emitProviderTiming(
  options: EffectWorkerBaseOptions,
  timing: ProviderTiming | undefined,
): void {
  if (timing === undefined) return;
  for (const phase of timing.phases) {
    emitWorkerTiming(options, {
      scope: TIMING_SCOPES.PROVIDER,
      phase: phase.phase,
      durationMs: phase.durationMs,
      operationKinds: timing.operationKinds,
      operationCounts: timing.operationCounts,
    });
  }
}

export function emitWorkerTiming(
  options: EffectWorkerBaseOptions,
  event: TimingEvent,
): void {
  try {
    options.onTiming?.(event);
  } catch {
    // Diagnostics must never change worker state transitions.
  }
}
