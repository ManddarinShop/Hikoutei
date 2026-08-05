/**
 * Shared timing(소요 시간) contracts for the SQLite-to-Sheets write pipeline.
 *
 * Timing is diagnostic only: a sink failure must never change persistence or
 * provider behavior. The operation kinds describe the public lifecycle while
 * phases describe implementation boundaries that can be compared in a trace.
 */

export const SYNC_TIMING_SCOPES = {
  ORM_FLUSH: "orm_flush",
  WORKER: "worker",
  PROVIDER: "provider",
  /** Inbound User_Input polling phases; diagnostic only and never root-facing. */
  POLLING: "polling",
} as const;

export type SyncTimingScope =
  (typeof SYNC_TIMING_SCOPES)[keyof typeof SYNC_TIMING_SCOPES];

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
export interface SyncSheetsTimingPhase {
  readonly phase: string;
  readonly durationMs: number;
}

/** Timing returned by one remote provider operation. */
export interface SyncSheetsTiming {
  readonly operationKinds: readonly SyncTimingOperationKind[];
  readonly operationCounts: SyncTimingOperationCounts;
  readonly durationMs: number;
  readonly phases: readonly SyncSheetsTimingPhase[];
}

/** One local or remote phase sent to the application's diagnostics sink. */
export interface SyncTimingEvent {
  readonly scope: SyncTimingScope;
  readonly phase: string;
  readonly durationMs: number;
  readonly operationKinds: readonly SyncTimingOperationKind[];
  readonly operationCounts: SyncTimingOperationCounts;
  /** Optional route/batch diagnostics used by adaptive outbound dispatch. */
  readonly routeKey?: string;
  readonly batchLimit?: number;
  readonly responseSucceeded?: boolean;
}

/** Optional observer used by servers and benchmarks to collect timings. */
export type SyncTimingSink = (event: SyncTimingEvent) => void;

/** Creates a zeroed operation count without sharing mutable state. */
export function emptySyncTimingOperationCounts(): SyncTimingOperationCounts {
  return { append: 0, update: 0, delete: 0 };
}
