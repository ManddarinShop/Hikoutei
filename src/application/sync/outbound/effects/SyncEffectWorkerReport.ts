/** Construction helpers for mutable and immutable effect-worker reports. */

import type { Presence } from "../../../../domain/index.js";
import type { WriterLease } from "../../../../infrastructure/storage/index.js";
import type {
  MutableReport,
  SyncEffectWorkerReport,
} from "./SyncEffectWorkerContracts.js";

/** Creates the zeroed counters for one worker pass. */
export function mutableReport(lease: Presence<WriterLease>): MutableReport {
  return {
    lease,
    expiredLeasesRecovered: 0,
    selected: 0,
    claimed: 0,
    applied: 0,
    blockedCandidate: 0,
    superseded: 0,
    conflicted: 0,
    failed: 0,
    deferred: 0,
    requeued: 0,
    replanned: 0,
    responseLossRecovered: 0,
  };
}

/** Freezes the mutable pass counters into the public report shape. */
export function freezeReport(report: MutableReport): SyncEffectWorkerReport {
  return { ...report };
}
