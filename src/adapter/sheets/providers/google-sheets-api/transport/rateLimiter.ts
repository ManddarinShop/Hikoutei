/**
 * Request-start interval limiter used by the direct Sheets provider.
 *
 * Google Sheets quota windows are per 100 seconds, so bursty request starts
 * can exhaust a class's budget before the worker's own latency/backoff reacts.
 * The provider keeps two independent limiters (reads, writes) that only wait
 * the time remaining since that class's last request START; an idle class is
 * never throttled and concurrent classes never serialize against each other.
 */

const DEFAULT_SLEEP = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface RequestStartLimiterOptions {
  /** Minimum interval between two request starts of this limiter class. */
  readonly intervalMs: number;
  /** Injectable clock for deterministic tests; defaults to Date.now. */
  readonly now?: () => number;
  /** Injectable sleep used while waiting for the next slot. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Waits only the remaining interval since the previous request start.
 *
 * Returns the number of milliseconds actually waited. A limiter with a zero
 * interval never waits and records every start.
 */
export class RequestStartLimiter {
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private lastStartAt: number | undefined;

  public constructor(options: RequestStartLimiterOptions) {
    if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 0) {
      throw new RangeError("request-start interval must be a non-negative safe integer");
    }
    this.intervalMs = options.intervalMs;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? DEFAULT_SLEEP;
  }

  /** Returns the last recorded request start, when one exists. */
  public lastStart(): number | undefined {
    return this.lastStartAt;
  }

  /**
   * Waits for the next request-start slot and records the start time.
   *
   * Returns the number of milliseconds actually waited. A limiter with a zero
   * interval never waits and records every start.
   *
   * The slot reservation happens SYNCHRONOUSLY before any await: each caller
   * reserves the NEXT slot (`nextStart = max(now, lastStartAt + intervalMs)`)
   * and records it immediately, so two concurrent waiters can never compute
   * the same remaining time from the same `lastStartAt`, sleep together, and
   * start at the same instant. A caller that arrives after its reserved slot
   * has already passed waits zero (its reservation collapses to now).
   */
  public async waitForSlot(): Promise<number> {
    const now = this.now();
    const nextStart = this.lastStartAt === undefined
      ? now
      : Math.max(now, this.lastStartAt + this.intervalMs);
    this.lastStartAt = nextStart;
    const waited = Math.max(0, nextStart - now);
    if (waited > 0) {
      await this.sleep(waited);
    }
    return waited;
  }
}
