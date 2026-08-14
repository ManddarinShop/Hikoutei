/** Generic liveness loop shared by in-process sync workers. */

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_ERROR_BACKOFF_INITIAL_MS = 1_000;
const DEFAULT_ERROR_BACKOFF_MAX_MS = 30_000;

export type SyncTaskWait = (durationMs: number) => Promise<void>;
export type SyncTaskPass<Report> = () => Promise<Report>;

export interface SyncTaskSupervisorOptions<Report = unknown> {
  readonly runPass: SyncTaskPass<Report>;
  readonly name?: string;
  /** Optional lifecycle error name when it differs from option labels. */
  readonly stoppedName?: string;
  readonly intervalMs?: number;
  readonly errorBackoffInitialMs?: number;
  readonly errorBackoffMaxMs?: number;
  readonly wait?: SyncTaskWait;
  readonly onReport?: (report: Report) => void;
  readonly onError?: (error: unknown) => void;
}

/**
 * Runs one asynchronous task at a time, retries failures with bounded
 * backoff, coalesces manual/background passes, and drains in-flight work on
 * stop so callers can safely close the shared SQLite adapter afterwards.
 */
export class SyncTaskSupervisor<Report = unknown> {
  private readonly runPass: SyncTaskPass<Report>;
  private readonly name: string;
  private readonly stoppedName: string;
  private readonly intervalMs: number;
  private readonly errorBackoffInitialMs: number;
  private readonly errorBackoffMaxMs: number;
  private readonly wait: SyncTaskWait;
  private readonly onReport: ((report: Report) => void) | undefined;
  private readonly onError: ((error: unknown) => void) | undefined;
  private running = false;
  private acceptingPasses = true;
  private loopPromise: Promise<void> | undefined;
  private inFlight: Promise<Report> | undefined;
  private stopPromise: Promise<void> | undefined;
  private runRequested = false;
  private wakeWaiter: (() => void) | undefined;

  public constructor(options: SyncTaskSupervisorOptions<Report>) {
    this.runPass = options.runPass;
    this.name = options.name ?? "task";
    this.stoppedName = options.stoppedName ?? this.name;
    this.intervalMs = requirePositive(options.intervalMs ?? DEFAULT_INTERVAL_MS, `${this.name} interval`);
    this.errorBackoffInitialMs = requirePositive(
      options.errorBackoffInitialMs ?? DEFAULT_ERROR_BACKOFF_INITIAL_MS,
      `${this.name} error backoff`,
    );
    this.errorBackoffMaxMs = requirePositive(
      options.errorBackoffMaxMs ?? DEFAULT_ERROR_BACKOFF_MAX_MS,
      `${this.name} maximum error backoff`,
    );
    if (this.errorBackoffMaxMs < this.errorBackoffInitialMs) {
      throw new RangeError(
        `${this.name} maximum error backoff must be at least the initial backoff`,
      );
    }
    this.wait = options.wait ?? defaultWait;
    this.onReport = options.onReport;
    this.onError = options.onError;
  }

  /** Starts the immediate-then-periodic task loop. */
  public start(): void {
    if (this.running || !this.acceptingPasses) return;
    this.running = true;
    this.loopPromise = this.runLoop();
  }

  /** Returns whether the background loop is currently running. */
  public isRunning(): boolean {
    return this.running;
  }

  /** Requests an additional pass without making correctness depend on it. */
  public requestRun(): void {
    if (!this.acceptingPasses) return;
    this.runRequested = true;
    this.wakeWaiter?.();
  }

  /** Runs one pass or joins the pass already in flight. */
  public runOnce(): Promise<Report> {
    if (!this.acceptingPasses) {
      return Promise.reject(new Error(`sync ${this.stoppedName} supervisor is stopped`));
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

  /** Stops scheduling work and waits for the current pass to settle. */
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
        if (this.runRequested) {
          this.runRequested = false;
          continue;
        }
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
    if (this.runRequested) {
      this.runRequested = false;
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
      // Diagnostics must not terminate a worker loop.
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
