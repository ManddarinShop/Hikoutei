/** Internal liveness loop for User_Input polling. */

import { SYNC_POLLING_INTERVAL_MS } from "./cadence.js";

const DEFAULT_ERROR_BACKOFF_INITIAL_MS = 1_000;
const DEFAULT_ERROR_BACKOFF_MAX_MS = 30_000;

type PollPass<Report> = () => Promise<Report>;
export type SyncPollingWait = (durationMs: number) => Promise<void>;

export interface SyncPollingSupervisorOptions<Report = unknown> {
  readonly runPass: PollPass<Report>;
  readonly intervalMs?: number;
  readonly errorBackoffInitialMs?: number;
  readonly errorBackoffMaxMs?: number;
  readonly wait?: SyncPollingWait;
  /**
   * Deferral gate applied ONLY to the loop's FIRST pass (default: no gate).
   *
   * The first scheduled pass waits for this promise before any remote
   * read starts, so a host can keep the first polling pass out of an
   * initial drain on a shared request limiter. The gate is consulted once:
   * after it resolves, passes keep the normal interval cadence. A gate
   * that throws surfaces through the normal polling error path and is
   * retried (with backoff) before any pass runs. Manual `runOnce()` calls
   * are deliberately NOT gated: they are explicit caller-driven passes.
   */
  readonly waitForFirstPass?: () => Promise<void>;
  readonly onReport?: (report: Report) => void;
  readonly onError?: (error: unknown) => void;
}

/**
 * Coalesces polling passes and stops only after an active provider call returns.
 * The service can therefore close the shared SQLite adapter safely.
 */
export class SyncPollingSupervisor<Report = unknown> {
  private readonly runPass: PollPass<Report>;
  private readonly intervalMs: number;
  private readonly errorBackoffInitialMs: number;
  private readonly errorBackoffMaxMs: number;
  private readonly wait: SyncPollingWait;
  private readonly waitForFirstPass: (() => Promise<void>) | undefined;
  private firstPassPending = false;
  private readonly onReport: ((report: Report) => void) | undefined;
  private readonly onError: ((error: unknown) => void) | undefined;
  private running = false;
  private acceptingPasses = true;
  private loopPromise: Promise<void> | undefined;
  private inFlight: Promise<Report> | undefined;
  private stopPromise: Promise<void> | undefined;
  private wakeWaiter: (() => void) | undefined;

  public constructor(options: SyncPollingSupervisorOptions<Report>) {
    this.runPass = options.runPass;
    this.intervalMs = requirePositive(options.intervalMs ?? SYNC_POLLING_INTERVAL_MS, "poll interval");
    this.errorBackoffInitialMs = requirePositive(
      options.errorBackoffInitialMs ?? DEFAULT_ERROR_BACKOFF_INITIAL_MS,
      "poll error backoff",
    );
    this.errorBackoffMaxMs = requirePositive(
      options.errorBackoffMaxMs ?? DEFAULT_ERROR_BACKOFF_MAX_MS,
      "poll maximum error backoff",
    );
    if (this.errorBackoffMaxMs < this.errorBackoffInitialMs) {
      throw new RangeError("poll maximum error backoff must be at least the initial backoff");
    }
    this.wait = options.wait ?? defaultWait;
    this.waitForFirstPass = options.waitForFirstPass;
    this.firstPassPending = options.waitForFirstPass !== undefined;
    this.onReport = options.onReport;
    this.onError = options.onError;
  }

  /** Starts the immediate-then-periodic polling loop. */
  public start(): void {
    if (this.running || !this.acceptingPasses) return;
    this.running = true;
    // A stopped-and-restarted supervisor re-arms the first-pass gate: the
    // loop never restarts (stop() is terminal for the accepting flag), but
    // the flag is re-derived here so a fresh supervisor with a gate always
    // consults it exactly once.
    this.firstPassPending = this.waitForFirstPass !== undefined;
    this.loopPromise = this.runLoop();
  }

  /** Returns whether a stop has been requested; used to interrupt gates. */
  public isStopping(): boolean {
    return !this.acceptingPasses || !this.running;
  }

  /** Runs one pass or joins the pass already in flight. */
  public runOnce(): Promise<Report> {
    if (!this.acceptingPasses) {
      return Promise.reject(new Error("sync polling supervisor is stopped"));
    }
    if (this.inFlight !== undefined) return this.inFlight;
    const pass = Promise.resolve().then(() => this.runPass());
    this.inFlight = pass;
    void pass.then(
      () => this.clearInFlight(pass),
      () => this.clearInFlight(pass),
    );
    return pass;
  }

  /** Stops scheduling new polls and waits for the current remote read. */
  public stop(): Promise<void> {
    if (this.stopPromise !== undefined) return this.stopPromise;
    this.acceptingPasses = false;
    this.running = false;
    this.wakeWaiter?.();
    this.stopPromise = (async () => {
      const loop = this.loopPromise;
      if (loop !== undefined) await loop.catch(() => undefined);
      const inFlight = this.inFlight;
      if (inFlight !== undefined) await inFlight.catch(() => undefined);
      this.loopPromise = undefined;
    })();
    return this.stopPromise;
  }

  private async runLoop(): Promise<void> {
    let errorBackoff = this.errorBackoffInitialMs;
    while (this.running) {
      try {
        if (this.firstPassPending && this.waitForFirstPass !== undefined) {
          // The FIRST pass is deferred until the host gate resolves (for
          // example the System_State drain readiness check). The flag is
          // cleared only AFTER the gate resolves, so a throwing gate keeps
          // the first pass pending through the normal error backoff; a
          // stop() requested while the gate waits is honored right here.
          await this.waitForFirstPass();
          this.firstPassPending = false;
          if (!this.running) break;
        }
        const report = await this.runOnce();
        this.notifyReport(report);
        errorBackoff = this.errorBackoffInitialMs;
        await this.waitWhileRunning(this.intervalMs);
      } catch (error: unknown) {
        this.notifyError(error);
        if (!this.running) break;
        await this.waitWhileRunning(Math.min(errorBackoff, this.errorBackoffMaxMs));
        errorBackoff = Math.min(this.errorBackoffMaxMs, errorBackoff * 2);
      }
    }
  }

  private async waitWhileRunning(durationMs: number): Promise<void> {
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

  private clearInFlight(pass: Promise<Report>): void {
    if (this.inFlight === pass) this.inFlight = undefined;
  }

  private notifyReport(report: Report): void {
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
      // Diagnostics must not terminate the polling loop.
    }
  }
}

function requirePositive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function defaultWait(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}
