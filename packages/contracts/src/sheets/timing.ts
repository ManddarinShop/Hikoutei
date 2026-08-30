/**
 * Mirror of the kernel (`@hikoutei/ikisaki`) provider-timing contract.
 *
 * The contracts leaf must stay independent of the kernel (the kernel keeps
 * its own `as const` tables and the mirror direction is fixed: contracts
 * mirrors kernel, never the reverse — same pattern as the persisted string
 * tables pinned by `test/outbox-contract-drift.test.ts`). The host's
 * `src/application/sync/telemetry/syncTiming.ts` keeps aliasing the kernel
 * `ProviderTiming` under `SyncSheetsTiming`; the two are structurally
 * identical and the drift guard pins the mirrored kind table key-by-key.
 *
 * Timing is diagnostic only: a sink failure must never change persistence or
 * provider behavior.
 */

/** Lifecycle operation kinds counted by one timing event (kernel mirror). */
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