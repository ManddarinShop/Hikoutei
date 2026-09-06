/**
 * Compatibility shim: the canonical provider-timing contract lives in the
 * kernel (`@hikoutei/ikisaki` `timing/providerTiming.ts`); this module
 * re-exports it one-way so existing importers keep working.
 */
export {
  SYNC_TIMING_OPERATION_KINDS,
  type SyncProviderTiming,
  type SyncProviderTimingPhase,
  type SyncTimingOperationCounts,
  type SyncTimingOperationKind,
} from "@hikoutei/ikisaki";
