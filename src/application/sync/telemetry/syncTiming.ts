/**
 * Shared timing contracts for the SQLite-to-Sheets write pipeline.
 *
 * The outbox package owns the core timing shapes (events, operation kinds,
 * counts, provider timing, and the worker/provider scopes); this host module
 * re-exports them under the host names and adds the host-only `orm_flush`
 * and `polling` scopes. Timing is diagnostic only: a sink failure must never
 * change persistence or provider behavior. The operation kinds describe the
 * public lifecycle while phases describe implementation boundaries that can
 * be compared in a trace.
 */

import {
  TIMING_OPERATION_KINDS,
  TIMING_SCOPES,
  emptyOperationCounts,
  type ProviderTiming,
  type ProviderTimingPhase,
  type TimingEvent,
  type TimingOperationCounts,
  type TimingOperationKind,
} from "@hikoutei/ikisaki";

/** Host diagnostic scopes: the package worker/provider scopes plus host-only phases. */
export const SYNC_TIMING_SCOPES = {
  ORM_FLUSH: "orm_flush",
  ...TIMING_SCOPES,
  /** Inbound User_Input polling phases; diagnostic only and never root-facing. */
  POLLING: "polling",
} as const;

export type SyncTimingScope =
  (typeof SYNC_TIMING_SCOPES)[keyof typeof SYNC_TIMING_SCOPES];

/** Lifecycle operation kinds counted by timing events (package-owned). */
export const SYNC_TIMING_OPERATION_KINDS = TIMING_OPERATION_KINDS;

export type SyncTimingOperationKind = TimingOperationKind;

/** Count of lifecycle operations represented by one timing event. */
export type SyncTimingOperationCounts = TimingOperationCounts;

/** One measured implementation phase inside a remote provider operation. */
export type SyncSheetsTimingPhase = ProviderTimingPhase;

/** Timing returned by one remote provider operation. */
export type SyncSheetsTiming = ProviderTiming;

/** One local or remote phase sent to the application's diagnostics sink. */
export type SyncTimingEvent = Omit<TimingEvent, "scope"> & {
  readonly scope: SyncTimingScope;
};

/** Optional observer used by servers and benchmarks to collect timings. */
export type SyncTimingSink = (event: SyncTimingEvent) => void;

/** Creates a zeroed operation count without sharing mutable state. */
export function emptySyncTimingOperationCounts(): SyncTimingOperationCounts {
  return emptyOperationCounts();
}
