/** Internal liveness loop for User_Input polling. */

const DEFAULT_POLL_INTERVAL_MS = 30_000;
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
  readonly onReport?: (report: Report) => void;
  readonly onError?: (error: unknown) => void;
}

/**
 * Coalesces polling passes and stops only after an active gateway call returns.
 * The service can therefore close the shared SQLite adapter safely.
 */
export class SyncPollingSupervisor<Report = unknown> {
  private readonly runPass: PollPass<Report>;
  private readonly intervalMs: number;
  private readonly errorBackoffInitialMs: number;
  private readonly errorBackoffMaxMs: number;
  private readonly wait: SyncPollingWait;
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
    this.intervalMs = requirePositive(options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS, "poll interval");
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
    this.onReport = options.onReport;
    this.onError = options.onError;
  }

  /** Starts the immediate-then-periodic polling loop. */
  public start(): void {
    if (this.running || !this.acceptingPasses) return;
    this.running = true;
    this.loopPromise = this.runLoop();
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
