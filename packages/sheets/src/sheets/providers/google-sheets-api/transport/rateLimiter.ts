/**
 * Request-start interval limiter used by the direct Sheets provider.
 *
 * Google Sheets quota windows are per 100 seconds, so bursty request starts
 * can exhaust the budget before the worker's own latency/backoff reacts.
 * The provider keeps TWO independent limiters — one for reads and one for
 * writes — so reads serialize only against reads and writes only against
 * writes: at most one read (getSpreadsheet) or one write (batchUpdate) can
 * start per interval of its own class, while a read and a write may start
 * concurrently. An idle provider is never throttled; the limiter only
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

/** Read QoS classes sharing ONE request-start timeline inside the scheduler. */
export type ReadQoSClass = "polling" | "preflight";

/** One FIFO waiter queued on a read class inside the scheduler. */
interface ReadQoSQueued {
  readonly maxWaitMs: number;
  readonly resolve: (admission: RequestStartAdmission) => void;
}

/**
 * Internal read request-start scheduler with weighted read-class fairness.
 *
 * All read starts (polling values/observation/safety reads AND outbound
 * preflight reads) share ONE pacing timeline and interval. When BOTH classes
 * have queued work the scheduler applies the weighted fairness policy
 * `polling 2:1 preflight` — two polling starts, then one preflight start —
 * with FIFO inside each class and no preflight starvation (a preflight is
 * served at least every three picks while both queues are non-empty, and an
 * idle class never blocks the other). The separate WRITE lane stays on the
 * plain `RequestStartLimiter`, so reads and writes still pace independently.
 *
 * Bounded admission matches the single-class limiter: a caller whose
 * predicted slot lies more than `maxWaitMs` out is refused WITHOUT reserving
 * anything, and a refusal never advances the shared horizon (so a later
 * caller is still admitted once time passes the open slot). Queued waiters
 * are served in weighted-FIFO batches and every waiter is either admitted or
 * refused before transport, so a burst of concurrent callers can never pile
 * up an arbitrarily long reservation line.
 */
export class ReadQoSScheduler {
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Shared request-start horizon for BOTH read classes. */
  private lastStartAt: number | undefined;
  /** Consecutive polling picks since the last preflight pick (fairness state). */
  private pollingSincePreflight = 0;
  /** True while the single admission-loop coroutine is running. */
  private draining = false;
  private readonly pollingQueue: ReadQoSQueued[] = [];
  private readonly preflightQueue: ReadQoSQueued[] = [];

  public constructor(options: RequestStartLimiterOptions) {
    if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 0) {
      throw new RangeError("request-start interval must be a non-negative safe integer");
    }
    this.intervalMs = options.intervalMs;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? DEFAULT_SLEEP;
  }

  /** Returns the last recorded shared request start, when one exists. */
  public lastStart(): number | undefined {
    return this.lastStartAt;
  }

  /**
   * Bounded admission on one read class, sharing ONE timeline with the other
   * class. Returns `admitted` after sleeping to the reserved slot or `refused`
   * (reserving nothing and never advancing the horizon) when the predicted
   * wait exceeds `maxWaitMs`. Decisions are made synchronously per enqueue, so
   * concurrent callers can never double-reserve one slot.
   */
  public waitForSlot(
    pacing: ReadQoSClass,
    maxWaitMs: number,
  ): Promise<RequestStartAdmission> {
    if (!Number.isSafeInteger(maxWaitMs) || maxWaitMs < 0) {
      throw new RangeError("maximum request-start wait must be a non-negative safe integer");
    }
    const queue = pacing === "polling" ? this.pollingQueue : this.preflightQueue;
    return new Promise<RequestStartAdmission>((resolve) => {
      queue.push({ maxWaitMs, resolve });
      void this.drain();
    });
  }

  /**
   * Single serialized admission-loop coroutine.
   *
   * Every concurrent caller enqueues its waiter and, when a drain is already
   * running, returns immediately; the running loop picks the waiter up on its
   * next `serveBatch` pass. Each pass reserves the shared slots for ALL
   * currently-queued waiters in weighted-FIFO order with the clock frozen for
   * that pass, so a burst of callers arriving in one synchronous tick is
   * scheduled against the SAME horizon — deep reservations beyond `maxWaitMs`
   * are refused without advancing it, exactly like the single-class limiter —
   * while the 2:1 weighted fairness is applied whenever both read classes are
   * queued together.
   */
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.serveBatch()) {
        // Yield to the microtask queue so waiters enqueued by concurrent
        // callers in the same synchronous burst join the next batch before the
        // horizon advances.
        await Promise.resolve();
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * Reserves the next shared slots for every currently-queued waiter, in
   * weighted-FIFO order, synchronously (the clock is frozen for the pass). An
   * admitted waiter sleeps before it is released; a refused waiter is released
   * immediately WITHOUT reserving or advancing the shared horizon. Returns
   * whether any waiter was served (admitted or refused).
   */
  private serveBatch(): boolean {
    let served = false;
    for (;;) {
      const pacing = this.pickClass();
      if (pacing === undefined) return served;
      const queue = pacing === "polling" ? this.pollingQueue : this.preflightQueue;
      const waiter = queue.shift();
      if (waiter === undefined) return served;
      served = true;
      const now = this.now();
      const nextStart = this.lastStartAt === undefined
        ? now
        : Math.max(now, this.lastStartAt + this.intervalMs);
      const waited = Math.max(0, nextStart - now);
      if (waited > waiter.maxWaitMs) {
        // Refused without reserving: the shared horizon stays untouched so a
        // later bounded caller is still admitted once time passes the slot.
        waiter.resolve({ status: "refused", waitedMs: waited, nextStartAt: nextStart });
        continue;
      }
      this.lastStartAt = nextStart;
      if (pacing === "polling") this.pollingSincePreflight += 1;
      else this.pollingSincePreflight = 0;
      void this.sleep(waited).then(() => {
        waiter.resolve({ status: "admitted", waitedMs: waited });
      });
    }
  }

  /**
   * Picks the next class to serve: FIFO within a class, and the weighted 2:1
   * polling:preflight policy only when BOTH classes have queued work so an
   * idle class never blocks or starves the other.
   */
  private pickClass(): ReadQoSClass | undefined {
    const pollingEmpty = this.pollingQueue.length === 0;
    const preflightEmpty = this.preflightQueue.length === 0;
    if (pollingEmpty && preflightEmpty) return undefined;
    if (pollingEmpty) return "preflight";
    if (preflightEmpty) return "polling";
    // Both classes have work: force a preflight after two consecutive polling
    // picks so preflight reads are never starved behind an endless polling
    // burst (2 polling starts then 1 preflight start).
    return this.pollingSincePreflight >= 2 ? "preflight" : "polling";
  }
}
