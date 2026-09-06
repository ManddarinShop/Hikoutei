/**
 * Step-1 compatibility shim: the canonical provider-timing contract moved to
 * the kernel (`@hikoutei/ikisaki`); this module re-exports it so existing
 * importers keep working. Deleted in Step 2.
 */
export {
  SYNC_TIMING_OPERATION_KINDS,
  type SyncProviderTiming,
  type SyncProviderTimingPhase,
  type SyncTimingOperationCounts,
  type SyncTimingOperationKind,
} from "@hikoutei/ikisaki";
