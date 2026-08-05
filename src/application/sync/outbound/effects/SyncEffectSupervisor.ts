/**
 * Keeps the bounded effect worker running until the durable outbox is idle.
 *
 * The supervisor provides liveness around `runSyncEffectWorker*()`: one pass
 * still handles a bounded batch, while this loop starts the next pass and
 * backs off after failures. It also coalesces manual and background triggers so
 * one process cannot run two effect passes concurrently.
 */

import { randomUUID } from "node:crypto";
import {
  NON_NEGATIVE_SAFE_INTEGER_MINIMUM,
  POSITIVE_SAFE_INTEGER_MINIMUM,
} from "../../../../domain/index.js";
import type { ReconciliationScanReport } from "../reconciliation/ReconciliationScanner.js";
import {
  runSyncEffectWorkerWithAdapter,
  type SyncEffectWorkerReport,
  type SyncEffectWorkerWithAdapterOptions,
} from "./SyncEffectWorker.js";
import {
  AdaptiveEffectBatchController,
  type AdaptiveEffectBatchController as AdaptiveEffectBatchControllerType,
} from "./AdaptiveEffectBatchController.js";

const DEFAULT_MAX_EFFECTS = 20;
const DEFAULT_IDLE_INTERVAL_MS = 1_000;
const DEFAULT_ERROR_BACKOFF_INITIAL_MS = 1_000;
const DEFAULT_ERROR_BACKOFF_MAX_MS = 30_000;
const DEFAULT_JITTER_MAX_MS = 1_000;
const DEFAULT_RECONCILIATION_INTERVAL_MS = 60_000;

export type SyncEffectWorkerSupervisorWait = (durationMs: number) => Promise<void>;
type RunPass = () => Promise<SyncEffectWorkerReport>;

/** Periodic reconciliation(불일치 보정) task attached to the effect loop. */
export interface SyncEffectWorkerSupervisorReconciliationOptions {
  /** Minimum delay between scan attempts. The first scan runs immediately. */
  readonly intervalMs?: number;
  /** Confirms that no pending or processing outbox work remains before scanning. */
  readonly isOutboxIdle?: () => Promise<boolean>;
  /** Runs one scan and enqueues corrections into the durable outbox. */
  readonly run: () => Promise<ReconciliationScanReport>;
  /** Receives a completed scan without being allowed to stop the loop. */
  readonly onReport?: (report: ReconciliationScanReport) => void;
  /** Receives scan failures; the effect worker continues independently. */
  readonly onError?: (error: unknown) => void;
}

/** Options for the runtime loop; `runPass` is injectable for deterministic tests. */
export interface SyncEffectWorkerSupervisorLoopOptions {
  readonly runPass: RunPass;
  readonly idleIntervalMs?: number;
  readonly errorBackoffInitialMs?: number;
  readonly errorBackoffMaxMs?: number;
  readonly random?: () => number;
  readonly wait?: SyncEffectWorkerSupervisorWait;
  readonly now?: () => number;
  readonly reconciliation?: SyncEffectWorkerSupervisorReconciliationOptions;
  readonly onReport?: (report: SyncEffectWorkerReport) => void;
  readonly onError?: (error: unknown) => void;
}

/** Worker options with a clock supplied by the supervisor on every pass. */
export type CreateSyncEffectWorkerSupervisorOptions = Omit<
  SyncEffectWorkerWithAdapterOptions,
  "now" | "workerId" | "maxEffects" | "writerLeaseDurationMs" | "effectLeaseDurationMs" | "requestTimeoutMs"
> & {
  readonly workerId?: string;
  readonly maxEffects?: number;
  readonly writerLeaseDurationMs?: number;
  readonly effectLeaseDurationMs?: number;
  readonly requestTimeoutMs?: number;
  readonly batchController?: AdaptiveEffectBatchControllerType;
  readonly now?: () => number;
  readonly idleIntervalMs?: number;
  readonly errorBackoffInitialMs?: number;
  readonly errorBackoffMaxMs?: number;
  readonly random?: () => number;
  readonly wait?: SyncEffectWorkerSupervisorWait;
  readonly reconciliation?: SyncEffectWorkerSupervisorReconciliationOptions;
  readonly onReport?: (report: SyncEffectWorkerReport) => void;
  readonly onError?: (error: unknown) => void;
};

/**
 * Runs one bounded effect pass at a time and continues while work is making
 * progress. `stop()` waits for the current remote call to finish before the
 * loop exits, so the caller does not close SQLite underneath an active pass.
 */
export class SyncEffectWorkerSupervisor {
  private readonly runPass: RunPass;
  private readonly idleIntervalMs: number;
  private readonly errorBackoffInitialMs: number;
  private readonly errorBackoffMaxMs: number;
  private readonly random: () => number;
  private readonly wait: SyncEffectWorkerSupervisorWait;
  private readonly now: () => number;
  private readonly reconciliation: SyncEffectWorkerSupervisorReconciliationOptions | undefined;
  private readonly reconciliationIntervalMs: number;
  private readonly onReport: ((report: SyncEffectWorkerReport) => void) | undefined;
  private readonly onError: ((error: unknown) => void) | undefined;
  private running = false;
  private acceptingPasses = true;
  private loopPromise: Promise<void> | undefined;
  private inFlightPass: Promise<SyncEffectWorkerReport> | undefined;
  private inFlightReconciliation: Promise<ReconciliationScanReport> | undefined;
  private stopPromise: Promise<void> | undefined;
  private nextReconciliationAt = 0;
  private wakeWaiter: (() => void) | undefined;

  public constructor(options: SyncEffectWorkerSupervisorLoopOptions) {
    this.runPass = options.runPass;
    this.idleIntervalMs = requirePositiveSafeInteger(
      options.idleIntervalMs ?? DEFAULT_IDLE_INTERVAL_MS,
      "sync effect supervisor idle interval",
    );
    this.errorBackoffInitialMs = requirePositiveSafeInteger(
      options.errorBackoffInitialMs ?? DEFAULT_ERROR_BACKOFF_INITIAL_MS,
      "sync effect supervisor error backoff",
    );
    this.errorBackoffMaxMs = requirePositiveSafeInteger(
      options.errorBackoffMaxMs ?? DEFAULT_ERROR_BACKOFF_MAX_MS,
      "sync effect supervisor maximum error backoff",
    );
    if (this.errorBackoffMaxMs < this.errorBackoffInitialMs) {
      throw new RangeError(
        "sync effect supervisor maximum error backoff must be at least the initial backoff",
      );
    }
    this.random = options.random ?? Math.random;
    this.wait = options.wait ?? defaultWait;
    this.now = options.now ?? Date.now;
    this.reconciliation = options.reconciliation;
    this.reconciliationIntervalMs = requirePositiveSafeInteger(
      options.reconciliation?.intervalMs ?? DEFAULT_RECONCILIATION_INTERVAL_MS,
      "sync effect supervisor reconciliation interval",
    );
    this.onReport = options.onReport;
    this.onError = options.onError;
  }

  /** Starts the background drain loop; repeated calls are harmless. */
  public start(): void {
    if (this.running || !this.acceptingPasses) return;
    this.running = true;
    this.nextReconciliationAt = this.now();
    this.loopPromise = this.runLoop();
  }

  /** Returns whether the supervisor is accepting background work. */
  public isRunning(): boolean {
    return this.running;
  }

  /**
   * Runs one pass or joins the pass already running in this process.
   * Manual HTTP triggers therefore cannot create a second concurrent worker.
   */
  public runOnce(): Promise<SyncEffectWorkerReport> {
    if (!this.acceptingPasses) {
      return Promise.reject(new Error("sync effect supervisor is stopped"));
    }
    if (this.inFlightPass !== undefined) return this.inFlightPass;
    const pass = Promise.resolve().then(() => this.runPass());
    this.inFlightPass = pass;
    void pass.then(
      () => this.clearInFlightPass(pass),
      () => this.clearInFlightPass(pass),
    );
    return pass;
  }

  /** Stops scheduling new passes and waits for the active pass to finish. */
  public stop(): Promise<void> {
    if (this.stopPromise !== undefined) return this.stopPromise;
    this.acceptingPasses = false;
    this.running = false;
    this.wakeWaiter?.();
    this.stopPromise = (async () => {
      const loop = this.loopPromise;
      if (loop !== undefined) await loop.catch(() => undefined);
      const inFlightPass = this.inFlightPass;
      if (inFlightPass !== undefined) await inFlightPass.catch(() => undefined);
      const inFlightReconciliation = this.inFlightReconciliation;
      if (inFlightReconciliation !== undefined) {
        await inFlightReconciliation.catch(() => undefined);
      }
      this.loopPromise = undefined;
    })();
    return this.stopPromise;
  }

  private async runLoop(): Promise<void> {
    let errorBackoff = this.errorBackoffInitialMs;
    while (this.running) {
      try {
        let report = await this.runOnce();
        this.notifyReport(report);
        if (!this.running) break;

        const reconciliation = await this.runScheduledReconciliation(report);
        if (reconciliation !== undefined && reconciliation.effectsEnqueued > 0 && this.running) {
          // The scan only enqueues corrections. Drain those corrections before
          // sleeping so a discovered drift does not wait for another tick.
          report = await this.runOnce();
          this.notifyReport(report);
        }
        if (!this.running) break;

        if (
          hasImmediateProgress(report) ||
          (reconciliation !== undefined && reconciliation.effectsEnqueued > 0)
        ) {
          if (report.failed > 0 || isResponseLossRetryLoop(report)) {
            // Back off when the pass only requeued work (a response-loss or
            // postcondition-unapplied loop) or failed outright, so a struggling
            // remote is not retried in a tight immediate loop. The backoff is
            // bounded by errorBackoffMaxMs and resets as soon as forward
            // progress resumes; lease expiry and recovery still keep effects
            // live.
            const delay = withJitter(errorBackoff, this.random);
            await this.waitFor(Math.min(this.errorBackoffMaxMs, delay));
            errorBackoff = nextBackoff(errorBackoff, this.errorBackoffMaxMs);
          } else {
            errorBackoff = this.errorBackoffInitialMs;
          }
          continue;
        }

        errorBackoff = this.errorBackoffInitialMs;
        await this.waitFor(this.idleIntervalMs);
      } catch (error: unknown) {
        this.notifyError(error);
        if (!this.running) break;
        const delay = withJitter(errorBackoff, this.random);
        await this.waitFor(Math.min(this.errorBackoffMaxMs, delay));
        errorBackoff = nextBackoff(errorBackoff, this.errorBackoffMaxMs);
      }
    }
  }

  /** Runs the reconciliation task when its interval has elapsed. */
  private async runScheduledReconciliation(
    workerReport: SyncEffectWorkerReport,
  ): Promise<ReconciliationScanReport | undefined> {
    const reconciliation = this.reconciliation;
    if (reconciliation === undefined || this.now() < this.nextReconciliationAt) return undefined;

    // Reconciliation is a safety net, not part of the normal write path. Wait
    // until the just-completed worker pass reports no remaining ready work.
    if (!isWorkerPassIdle(workerReport)) return undefined;

    this.nextReconciliationAt = this.now() + this.reconciliationIntervalMs;
    try {
      if (reconciliation.isOutboxIdle !== undefined && !(await reconciliation.isOutboxIdle())) {
        return undefined;
      }
      const report = await this.runReconciliationOnce(reconciliation);
      this.notifyReconciliationReport(reconciliation, report);
      return report;
    } catch (error: unknown) {
      this.notifyReconciliationError(reconciliation, error);
      return undefined;
    }
  }

  /** Coalesces a manual/scheduled reconciliation call in this process. */
  private runReconciliationOnce(
    reconciliation: SyncEffectWorkerSupervisorReconciliationOptions,
  ): Promise<ReconciliationScanReport> {
    if (this.inFlightReconciliation !== undefined) return this.inFlightReconciliation;
    const pass = Promise.resolve().then(() => reconciliation.run());
    this.inFlightReconciliation = pass;
    void pass.then(
      () => this.clearInFlightReconciliation(pass),
      () => this.clearInFlightReconciliation(pass),
    );
    return pass;
  }

  private notifyReconciliationReport(
    reconciliation: SyncEffectWorkerSupervisorReconciliationOptions,
    report: ReconciliationScanReport,
  ): void {
    try {
      reconciliation.onReport?.(report);
    } catch (error: unknown) {
      this.notifyError(error);
    }
  }

  private notifyReconciliationError(
    reconciliation: SyncEffectWorkerSupervisorReconciliationOptions,
    error: unknown,
  ): void {
    if (reconciliation.onError === undefined) {
      this.notifyError(error);
      return;
    }
    try {
      reconciliation.onError(error);
    } catch (callbackError: unknown) {
      this.notifyError(callbackError);
    }
  }

  private notifyReport(report: SyncEffectWorkerReport): void {
    try {
      this.onReport?.(report);
    } catch (error: unknown) {
      this.notifyError(error);
    }
  }

  private notifyError(error: unknown): void {
    try {
      this.onError?.(error);
    } catch {
      // Observability callbacks must not terminate the drain loop.
    }
  }

  private async waitFor(durationMs: number): Promise<void> {
    if (!this.running) return;
    if (this.wait !== defaultWait) {
      await this.wait(durationMs);
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (this.wakeWaiter === wake) this.wakeWaiter = undefined;
        resolve();
      }, durationMs);
      const wake = () => {
        clearTimeout(timer);
        if (this.wakeWaiter === wake) this.wakeWaiter = undefined;
        resolve();
      };
      this.wakeWaiter = wake;
    });
  }

  private clearInFlightPass(pass: Promise<SyncEffectWorkerReport>): void {
    if (this.inFlightPass === pass) this.inFlightPass = undefined;
  }

  private clearInFlightReconciliation(pass: Promise<ReconciliationScanReport>): void {
    if (this.inFlightReconciliation === pass) this.inFlightReconciliation = undefined;
  }
}

/** Creates a supervisor that supplies a fresh timestamp to every worker pass. */
export function createSyncEffectWorkerSupervisor(
  options: CreateSyncEffectWorkerSupervisorOptions,
): SyncEffectWorkerSupervisor {
  const workerId = options.workerId ?? `sync-effect-worker:${randomUUID()}`;
  const maxEffects = options.maxEffects ?? DEFAULT_MAX_EFFECTS;
  const now = options.now ?? Date.now;

  validateWorkerOptions(workerId, maxEffects, options.maxFastAppendCandidates, options.appendDispatchIntervalMs);
  const batchController = options.batchController ?? new AdaptiveEffectBatchController({
    ...(options.appendDispatchIntervalMs === undefined
      ? {}
      : { appendDispatchIntervalMs: options.appendDispatchIntervalMs }),
  });
  const workerOptions = {
    storage: options.storage,
    provider: options.provider,
    batchController,
    clock: now,
    workerId,
    maxEffects,
    now: now(),
    ...(options.writerRole === undefined ? {} : { writerRole: options.writerRole }),
    ...(options.writerLeaseDurationMs === undefined
      ? {}
      : { writerLeaseDurationMs: options.writerLeaseDurationMs }),
    ...(options.effectLeaseDurationMs === undefined
      ? {}
      : { effectLeaseDurationMs: options.effectLeaseDurationMs }),
    ...(options.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: options.requestTimeoutMs }),
    ...(options.maxFastAppendCandidates === undefined
      ? {}
      : { maxFastAppendCandidates: options.maxFastAppendCandidates }),
    ...(options.appendDispatchIntervalMs === undefined
      ? {}
      : { appendDispatchIntervalMs: options.appendDispatchIntervalMs }),
    ...(options.makeRepairReplan === undefined
      ? {}
      : { makeRepairReplan: options.makeRepairReplan }),
    ...(options.onTiming === undefined ? {} : { onTiming: options.onTiming }),
  } satisfies SyncEffectWorkerWithAdapterOptions;

  return new SyncEffectWorkerSupervisor({
    ...options,
    now,
    runPass: () => runSyncEffectWorkerWithAdapter({ ...workerOptions, now: now() }),
  });
}

function hasImmediateProgress(report: SyncEffectWorkerReport): boolean {
  return report.claimed > 0;
}

/**
 * A pass claimed work but reached no terminal state and only requeued it is a
 * response-loss / postcondition-unapplied retry loop against the remote.
 * `requeued` always implies `deferred` in the worker, so it covers both the
 * fast-append and regular recovery paths. Forward progress elsewhere (an
 * applied/superseded/conflicted/blocked/replanned/failed effect) keeps the
 * drain loop running immediately.
 */
function isResponseLossRetryLoop(report: SyncEffectWorkerReport): boolean {
  return report.claimed > 0 &&
    report.requeued > 0 &&
    !hasForwardProgress(report);
}

function hasForwardProgress(report: SyncEffectWorkerReport): boolean {
  return report.applied > 0 ||
    report.superseded > 0 ||
    report.conflicted > 0 ||
    report.blockedCandidate > 0 ||
    report.replanned > 0 ||
    report.failed > 0;
}

function isWorkerPassIdle(report: SyncEffectWorkerReport): boolean {
  return report.selected === 0 &&
    report.claimed === 0 &&
    report.expiredLeasesRecovered === 0 &&
    report.deferred === 0 &&
    report.requeued === 0 &&
    report.replanned === 0;
}

function nextBackoff(current: number, maximum: number): number {
  return Math.min(maximum, current * 2);
}

function withJitter(durationMs: number, random: () => number): number {
  const sample = random();
  const normalized = Number.isFinite(sample) ? Math.max(0, Math.min(1, sample)) : 0;
  return durationMs + Math.floor(normalized * DEFAULT_JITTER_MAX_MS);
}

function validateWorkerOptions(
  workerId: string,
  maxEffects: number,
  maxFastAppendCandidates?: number,
  appendDispatchIntervalMs?: number,
): void {
  if (workerId.length === NON_NEGATIVE_SAFE_INTEGER_MINIMUM) {
    throw new RangeError("sync effect supervisor worker ID is required");
  }
  if (!Number.isSafeInteger(maxEffects) || maxEffects < POSITIVE_SAFE_INTEGER_MINIMUM) {
    throw new RangeError("sync effect supervisor maxEffects must be a positive safe integer");
  }
  if (
    maxFastAppendCandidates !== undefined &&
    (!Number.isSafeInteger(maxFastAppendCandidates) ||
      maxFastAppendCandidates < POSITIVE_SAFE_INTEGER_MINIMUM)
  ) {
    throw new RangeError(
      "sync effect supervisor maxFastAppendCandidates must be a positive safe integer",
    );
  }
  if (
    appendDispatchIntervalMs !== undefined &&
    (!Number.isSafeInteger(appendDispatchIntervalMs) ||
      appendDispatchIntervalMs < NON_NEGATIVE_SAFE_INTEGER_MINIMUM)
  ) {
    throw new RangeError(
      "sync effect supervisor appendDispatchIntervalMs must be a non-negative safe integer",
    );
  }
}

function requirePositiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < POSITIVE_SAFE_INTEGER_MINIMUM) {
    throw new RangeError(name + " must be a positive safe integer");
  }
  return value;
}

function defaultWait(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}
