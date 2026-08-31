/**
 * Worker pass reports: the immutable result, its mutable accumulator,
 * and report-judgement helpers consumed by the supervisor loop.
 */

import type { Presence } from "../contract/state.js";
import type { WriterLease } from "../outbox/writerLease.js";

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

export function freezeReport(report: MutableReport): WorkerReport {
  return { ...report };
}

/** A pass claimed work and made forward progress (applied/superseded/etc.). */
export function hasImmediateProgress(report: WorkerReport): boolean {
  return report.claimed > 0;
}

/**
 * True when the pass claimed work but produced no terminal outcome and only
 * requeued effects — a response-loss or postcondition-unapplied retry loop
 * against the remote.
 */
export function isResponseLossRetryLoop(report: WorkerReport): boolean {
  return report.claimed > 0 &&
    report.requeued > 0 &&
    !hasForwardProgress(report);
}

function hasForwardProgress(report: WorkerReport): boolean {
  return report.applied > 0 ||
    report.superseded > 0 ||
    report.conflicted > 0 ||
    report.blockedCandidate > 0 ||
    report.replanned > 0 ||
    report.failed > 0;
}
