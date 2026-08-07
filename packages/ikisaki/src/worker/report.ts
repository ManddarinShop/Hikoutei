/** Worker pass reports: the immutable result and its mutable accumulator. */

import type { Presence } from "../state.js";
import type { WriterLease } from "../writerLease.js";

/** Counters that make partial results and recovery visible to callers. */
export interface WorkerReport {
  readonly lease: Presence<WriterLease>;
  readonly expiredLeasesRecovered: number;
  readonly selected: number;
  readonly claimed: number;
  readonly applied: number;
  readonly blockedCandidate: number;
  readonly superseded: number;
  readonly conflicted: number;
  readonly failed: number;
  readonly deferred: number;
  readonly requeued: number;
  readonly replanned: number;
  readonly responseLossRecovered: number;
}

/** Mutable accumulator behind one worker pass report. */
export interface MutableReport {
  lease: Presence<WriterLease>;
  expiredLeasesRecovered: number;
  selected: number;
  claimed: number;
  applied: number;
  blockedCandidate: number;
  superseded: number;
  conflicted: number;
  failed: number;
  deferred: number;
  requeued: number;
  replanned: number;
  responseLossRecovered: number;
}
