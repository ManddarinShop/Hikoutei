/**
 * Kernel-owned provider-timing contract.
 *
 * Provider-neutral timing vocabulary for one remote provider operation:
 * lifecycle operation kinds, per-kind counts, and measured phases. The
 * contracts leaf (`@hikoutei/contracts` `sheets/timing.ts`) re-exports this
 * module one-way so existing importers keep working; the canonical tables
 * live here. Timing is diagnostic only: a sink failure must never change
 * persistence or provider behavior.
 */

/** Lifecycle operation kinds counted by one timing event. */
export const SYNC_TIMING_OPERATION_KINDS = {
  APPEND: "append",
  UPDATE: "update",
  DELETE: "delete",
} as const;

export type SyncTimingOperationKind =
  (typeof SYNC_TIMING_OPERATION_KINDS)[keyof typeof SYNC_TIMING_OPERATION_KINDS];

/** Count of lifecycle operations represented by one timing event. */
export interface SyncTimingOperationCounts {
  readonly append: number;
  readonly update: number;
  readonly delete: number;
}

/** One measured implementation phase inside a remote provider operation. */
export interface SyncProviderTimingPhase {
  readonly phase: string;
  readonly durationMs: number;
}

/** Optional phase timing returned by one remote provider operation. */
export interface SyncProviderTiming {
  readonly operationKinds: readonly SyncTimingOperationKind[];
  readonly operationCounts: SyncTimingOperationCounts;
  readonly durationMs: number;
  readonly phases: readonly SyncProviderTimingPhase[];
}