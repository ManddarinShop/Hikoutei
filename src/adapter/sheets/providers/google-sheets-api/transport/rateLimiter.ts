/**
 * Request-start interval limiter used by the direct Sheets provider.
 *
 * Google Sheets quota windows are per 100 seconds, so bursty request starts
 * can exhaust the budget before the worker's own latency/backoff reacts. The
 * provider keeps ONE shared limiter for reads AND writes, so combined
 * read+write request starts are serialized: at most one transport call
 * (getSpreadsheet or batchUpdate) can start per interval no matter how many
 * operations race. An idle provider is never throttled; the limiter only
 * waits the time remaining since the previous request START. Admission is
 * BOUNDED: a caller whose slot lies more than `maxWaitMs` out is refused
 * without reserving anything, so a burst of concurrent callers can never
 * queue an arbitrarily long line of future reservations.
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
 * Result of one BOUNDED `waitForSlot(maxWaitMs)` admission attempt.
 *
 * An admitted caller owns the reserved slot and waits `waitedMs`; a refused
 * caller reserved NOTHING (the future slot stays available to later callers)
 * and the limiter's `lastStartAt` is left untouched, so a refusal can never
 * push the pacing horizon forward.
 */
export type RequestStartAdmission =
  | { readonly status: "admitted"; readonly waitedMs: number }
  | {
    readonly status: "refused";
    /** The wait the refused slot WOULD have required. */
    readonly waitedMs: number;
    /** The slot that was NOT reserved; still open to later callers. */
    readonly nextStartAt: number;
  };

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
  public waitForSlot(): Promise<number>;
  /**
   * Bounded admission: waits for the next slot only when the predicted wait
   * is at most `maxWaitMs`, otherwise returns a REFUSED result without
   * reserving or advancing the future slot.
   *
   * The bound keeps an unbounded queue of concurrent callers from each
   * reserving a distant future slot: with `maxWaitMs` equal to `intervalMs`
   * the immediate caller and the one exactly one interval out are admitted
   * and every later reservation is refused up front. A refusal never records
   * a start, so the pacing horizon is unchanged and a later caller can still
   * be admitted once time advances past the reserved slot.
   */
  public waitForSlot(maxWaitMs: number): Promise<RequestStartAdmission>;
  public async waitForSlot(
    maxWaitMs?: number,
  ): Promise<number | RequestStartAdmission> {
    if (
      maxWaitMs !== undefined &&
      (!Number.isSafeInteger(maxWaitMs) || maxWaitMs < 0)
    ) {
      throw new RangeError("maximum request-start wait must be a non-negative safe integer");
    }
    const now = this.now();
    const nextStart = this.lastStartAt === undefined
      ? now
      : Math.max(now, this.lastStartAt + this.intervalMs);
    const waited = Math.max(0, nextStart - now);
    if (maxWaitMs !== undefined && waited > maxWaitMs) {
      // Refused WITHOUT reserving: lastStartAt stays untouched, so a later
      // bounded caller can still be admitted once the queue drains. The
      // decision and the horizon read happen in the same synchronous tick
      // as an admitted caller's reservation, so concurrent callers can never
      // both see the same stale horizon and double-reserve a slot.
      return { status: "refused", waitedMs: waited, nextStartAt: nextStart };
    }
    this.lastStartAt = nextStart;
    if (waited > 0) {
      await this.sleep(waited);
    }
    return maxWaitMs === undefined
      ? waited
      : { status: "admitted", waitedMs: waited };
  }
}
