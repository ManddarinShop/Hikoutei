/**
 * Keeps the bounded effect worker running until the durable outbox is idle.
 *
 * This supervisor owns only effect delivery liveness. Reconciliation and other
 * repair tasks are host application workers so the generic queue package does
 * not know their report or scheduling contracts.
 */

import { randomUUID } from "node:crypto";
import { runEffectWorkerWithAdapter } from "./worker.js";
import type { EffectWorkerWithAdapterOptions } from "./options.js";
import type { WorkerReport } from "./report.js";
import {
  AdaptiveEffectBatchController,
  type AdaptiveEffectBatchController as AdaptiveEffectBatchControllerType,
} from "./batch.js";

const DEFAULT_MAX_EFFECTS = 20;
const DEFAULT_IDLE_INTERVAL_MS = 1_000;
const DEFAULT_ERROR_BACKOFF_INITIAL_MS = 1_000;
const DEFAULT_ERROR_BACKOFF_MAX_MS = 30_000;
const DEFAULT_JITTER_MAX_MS = 1_000;

export type EffectWorkerSupervisorWait = (durationMs: number) => Promise<void>;
type RunPass = () => Promise<WorkerReport>;

/** Options for the effect-only runtime loop. */
export interface EffectWorkerSupervisorLoopOptions {
  readonly runPass: RunPass;
  readonly idleIntervalMs?: number;
  readonly errorBackoffInitialMs?: number;
  readonly errorBackoffMaxMs?: number;
  readonly random?: () => number;
  readonly wait?: EffectWorkerSupervisorWait;
  readonly onReport?: (report: WorkerReport) => void;
  readonly onError?: (error: unknown) => void;
}

/** Worker options with a clock supplied on every bounded pass. */
export type CreateEffectWorkerSupervisorOptions = Omit<
  EffectWorkerWithAdapterOptions,
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
  readonly wait?: EffectWorkerSupervisorWait;
  readonly onReport?: (report: WorkerReport) => void;
  readonly onError?: (error: unknown) => void;
};

/**
 * Runs one bounded effect pass at a time and waits for an active remote call
 * before stop resolves, allowing the host to close SQLite safely afterwards.
 */
export class EffectWorkerSupervisor {
  private readonly runPass: RunPass;
  private readonly idleIntervalMs: number;
  private readonly errorBackoffInitialMs: number;
  private readonly errorBackoffMaxMs: number;
  private readonly random: () => number;
  private readonly wait: EffectWorkerSupervisorWait;
  private readonly onReport: ((report: WorkerReport) => void) | undefined;
  private readonly onError: ((error: unknown) => void) | undefined;
  private running = false;
  private acceptingPasses = true;
  private loopPromise: Promise<void> | undefined;
  private inFlightPass: Promise<WorkerReport> | undefined;
  private stopPromise: Promise<void> | undefined;
  private drainRequested = false;
  private wakeWaiter: (() => void) | undefined;

  public constructor(options: EffectWorkerSupervisorLoopOptions) {
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
    this.onReport = options.onReport;
    this.onError = options.onError;
  }

  /** Starts the background drain loop; repeated calls are harmless. */
  public start(): void {
    if (this.running || !this.acceptingPasses) return;
    this.running = true;
    this.loopPromise = this.runLoop();
  }

  /** Returns whether the supervisor is accepting background work. */
  public isRunning(): boolean {
    return this.running;
  }

  /** Wakes an idle background loop so newly appended effects drain promptly. */
  public requestDrain(): void {
    if (!this.acceptingPasses) return;
    this.drainRequested = true;
    this.wakeWaiter?.();
  }

  /** Runs one pass or joins the pass already running in this process. */
  public runOnce(): Promise<WorkerReport> {
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
      this.loopPromise = undefined;
    })();
    return this.stopPromise;
  }

  private async runLoop(): Promise<void> {
    let errorBackoff = this.errorBackoffInitialMs;
    while (this.running) {
      try {
        const report = await this.runOnce();
        this.notifyReport(report);
        if (!this.running) break;
        if (this.drainRequested) {
          this.drainRequested = false;
          continue;
        }

        if (hasImmediateProgress(report)) {
          if (report.failed > 0 || isResponseLossRetryLoop(report)) {
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

  private notifyReport(report: WorkerReport): void {
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
    if (this.drainRequested) {
      this.drainRequested = false;
      return;
    }
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

  private clearInFlightPass(pass: Promise<WorkerReport>): void {
    if (this.inFlightPass === pass) this.inFlightPass = undefined;
  }
}

/** Creates a supervisor that supplies a fresh timestamp to every worker pass. */
export function createEffectWorkerSupervisor(
  options: CreateEffectWorkerSupervisorOptions,
): EffectWorkerSupervisor {
  const workerId = options.workerId ?? `sync-effect-worker:${randomUUID()}`;
  const maxEffects = options.maxEffects ?? DEFAULT_MAX_EFFECTS;
  const now = options.now ?? Date.now;

  validateWorkerOptions(
    workerId,
    maxEffects,
    options.maxFastAppendCandidates,
    options.appendDispatchIntervalMs,
  );
  const batchController = options.batchController ?? new AdaptiveEffectBatchController({
    ...(options.appendDispatchIntervalMs === undefined
      ? {}
      : { appendDispatchIntervalMs: options.appendDispatchIntervalMs }),
  });
  const workerOptions = {
    storage: options.storage,
    dispatcher: options.dispatcher,
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
  } satisfies EffectWorkerWithAdapterOptions;

  return new EffectWorkerSupervisor({
    ...options,
    runPass: () => runEffectWorkerWithAdapter({ ...workerOptions, now: now() }),
  });
}

function hasImmediateProgress(report: WorkerReport): boolean {
  return report.claimed > 0;
}

/** Returns whether a pass only requeued work after uncertain delivery. */
function isResponseLossRetryLoop(report: WorkerReport): boolean {
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
  if (workerId.length === 0) {
    throw new RangeError("sync effect supervisor worker ID is required");
  }
  if (!Number.isSafeInteger(maxEffects) || maxEffects < 1) {
    throw new RangeError("sync effect supervisor maxEffects must be a positive safe integer");
  }
  if (
    maxFastAppendCandidates !== undefined &&
    (!Number.isSafeInteger(maxFastAppendCandidates) || maxFastAppendCandidates < 1)
  ) {
    throw new RangeError(
      "sync effect supervisor maxFastAppendCandidates must be a positive safe integer",
    );
  }
  if (
    appendDispatchIntervalMs !== undefined &&
    (!Number.isSafeInteger(appendDispatchIntervalMs) || appendDispatchIntervalMs < 0)
  ) {
    throw new RangeError(
      "sync effect supervisor appendDispatchIntervalMs must be a non-negative safe integer",
    );
  }
}

function requirePositiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(name + " must be a positive safe integer");
  }
  return value;
}

function defaultWait(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}
