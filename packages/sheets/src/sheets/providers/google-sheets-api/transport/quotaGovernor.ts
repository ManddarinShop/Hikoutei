/**
 * Adaptive quota governor layered ON TOP of the request-start limiters.
 *
 * The interval limiters (`RequestStartLimiter`, `ReadQoSScheduler`) space
 * request STARTS but have no notion of the per-minute quota budget, and a
 * remote 429 never feeds back into their pacing. This module adds the two
 * missing pieces, both of which gate request STARTS only and never touch
 * CAS/fencing, prepared-state, batch building, or result encoding:
 *
 * 1. `RollingQuotaBudget` — a sliding-window per-minute TOTAL request-start
 *    budget per lane (reads vs writes). It composes with (does not replace)
 *    the interval limiters: a start must pass BOTH the budget and its lane's
 *    interval pacing. Admission is BOUNDED with the same semantics as the
 *    interval limiters: a refused caller reserves nothing, so a refusal can
 *    never advance the budget window or the pacing horizon.
 *
 * 2. `QuotaPacingGovernor` — AIMD pacing feedback. When a transport response
 *    is classified as quota-limited (HTTP 429 / `RESOURCE_EXHAUSTED`), the
 *    offending lane's pacing interval doubles (multiplicative decrease,
 *    capped at a multiple of the base). After a sustained quiet period
 *    (enough successful request starts, or enough elapsed time since the
 *    last quota event), the interval steps back down ~10% at a time
 *    (additive increase) and never falls below the base. With no 429 ever
 *    observed the governor stays `nominal` at 1x and pacing is byte-for-byte
 *    the pre-governor behavior.
 *
 * Why a per-minute budget at all: the binding Google quota for our
 * deployment is the per-user READ rate (60/min); a measured 30k-effect
 * burst peaked near 69/min of reads, producing 429s and a delivery-uncertain
 * requeue spiral. The interval pacing alone (75/min at the 800 ms default)
 * cannot hold a per-minute ceiling because concurrent lock-free readers each
 * reserve successive interval slots without any rate cap per window.
 */

import { GOOGLE_SHEETS_API_DEFAULTS } from "@hikoutei/contracts/sheets/googleSheetsApi.js";
import { PRESENCE_KINDS, type Presence } from "@hikoutei/contracts/state/index.js";
import {
  RATE_LIMIT_OPTIONS_ERROR_CODES,
  RateLimitOptionsError,
  type RequestStartAdmission,
} from "./rateLimiter.js";

/** Lanes the governor paces: the shared read timeline and the write lane. */
export const QUOTA_GOVERNOR_LANES = {
  READ: "read",
  WRITE: "write",
} as const;

/** Union type derived from the governor lane table. */
export type QuotaGovernorLane =
  (typeof QUOTA_GOVERNOR_LANES)[keyof typeof QUOTA_GOVERNOR_LANES];

/** Lifecycle states of one lane's AIMD pacing. */
export const QUOTA_PACING_STATES = {
  NOMINAL: "nominal",
  BACKOFF: "backoff",
  RECOVERY: "recovery",
} as const;

/**
 * Discriminated AIMD pacing state of ONE lane.
 *
 * `nominal` — never backed off (or fully recovered); multiplier is exactly 1.
 * `backoff` — at least one quota event, no recovery step taken yet.
 * `recovery` — at least one recovery step taken, still above the base.
 * The state carries the counters the next transition reads; there is no
 * sentinel `null` for "not backed off" — `nominal` is its own variant.
 */
export type QuotaPacingState =
  | { readonly status: typeof QUOTA_PACING_STATES.NOMINAL; readonly multiplier: 1 }
  | {
    readonly status: typeof QUOTA_PACING_STATES.BACKOFF;
    readonly multiplier: number;
    /** Clock instant of the most recent quota-limited response. */
    readonly lastQuotaEventAt: number;
    /** Successful request starts recorded since that event. */
    readonly quietStarts: number;
  }
  | {
    readonly status: typeof QUOTA_PACING_STATES.RECOVERY;
    readonly multiplier: number;
    readonly lastQuotaEventAt: number;
    readonly quietStarts: number;
  };

/** Per-lane bookkeeping kept private by the governor. */
interface LaneState {
  multiplier: number;
  lastQuotaEventAt: number;
  quietStarts: number;
  /** True once a recovery step has been taken at the current multiplier. */
  steppedDown: boolean;
}

export interface QuotaPacingGovernorOptions {
  /** Configured base pacing interval for both lanes. */
  readonly baseIntervalMs: number;
  /** Injectable clock for deterministic tests; defaults to Date.now. */
  readonly now?: () => number;
}

/**
 * AIMD pacing feedback for the two request-start lanes.
 *
 * `intervalMsFor(lane)` is polled by the lane's limiter at each reservation,
 * so a doubled multiplier doubles the effective spacing on the NEXT start
 * without reconstructing the limiter. `recordRequestStart` and
 * `recordQuotaLimited` are the only state inputs; both are fire-and-forget
 * bookkeeping that can never throw out of the admission path.
 */
export class QuotaPacingGovernor {
  private readonly baseIntervalMs: number;
  private readonly now: () => number;
  private readonly lanes: Record<QuotaGovernorLane, LaneState>;

  public constructor(options: QuotaPacingGovernorOptions) {
    this.baseIntervalMs = options.baseIntervalMs;
    this.now = options.now ?? Date.now;
    this.lanes = {
      [QUOTA_GOVERNOR_LANES.READ]: {
        multiplier: 1,
        lastQuotaEventAt: 0,
        quietStarts: 0,
        steppedDown: false,
      },
      [QUOTA_GOVERNOR_LANES.WRITE]: {
        multiplier: 1,
        lastQuotaEventAt: 0,
        quietStarts: 0,
        steppedDown: false,
      },
    };
  }

  /** Effective pacing interval for one lane: base x AIMD multiplier. */
  public intervalMsFor(lane: QuotaGovernorLane): number {
    // Lazy time-based recovery: a lane with zero traffic never reaches
    // recordRequestStart, so the quiet window is also advanced wherever the
    // interval is OBSERVED (the lane reservation path polls this).
    this.recoverByElapsed(lane);
    const multiplier = this.lanes[lane].multiplier;
    return multiplier === 1
      ? this.baseIntervalMs
      : Math.round(this.baseIntervalMs * multiplier);
  }

  /**
   * Multiplicative decrease: one quota-limited (429) response doubles this
   * lane's multiplier, capped at `QUOTA_BACKOFF_MAX_MULTIPLIER` of base.
   */
  public recordQuotaLimited(lane: QuotaGovernorLane): void {
    const state = this.lanes[lane];
    state.multiplier = Math.min(
      state.multiplier * GOOGLE_SHEETS_API_DEFAULTS.QUOTA_BACKOFF_GROWTH_FACTOR,
      GOOGLE_SHEETS_API_DEFAULTS.QUOTA_BACKOFF_MAX_MULTIPLIER,
    );
    state.lastQuotaEventAt = this.now();
    state.quietStarts = 0;
    state.steppedDown = false;
  }

  /**
   * Additive increase: one successful request start on this lane. After a
   * sustained quiet period (RECOVERY_SUCCESS_THRESHOLD starts, or
   * RECOVERY_QUIET_MS elapsed since the last quota event) the multiplier
   * steps down by ~10% and needs a FRESH quiet period before the next step,
   * so recovery is gradual and a single 429 cannot be answered with a
   * immediate undo. Landing on exactly 1x returns the lane to `nominal`.
   */
  public recordRequestStart(lane: QuotaGovernorLane): void {
    const state = this.lanes[lane];
    if (state.multiplier === 1) return;
    state.quietStarts += 1;
    const quietElapsed = this.now() - state.lastQuotaEventAt;
    if (
      state.quietStarts < GOOGLE_SHEETS_API_DEFAULTS.QUOTA_RECOVERY_SUCCESS_THRESHOLD &&
      quietElapsed < GOOGLE_SHEETS_API_DEFAULTS.QUOTA_RECOVERY_QUIET_MS
    ) {
      return;
    }
    this.stepDown(state);
  }

  /**
   * Elapsed-time-only quiet recovery, applied lazily at every state
   * observation: with no traffic on the lane, `recordRequestStart` never
   * runs, so a backed-off lane would otherwise stay in backoff forever.
   */
  private recoverByElapsed(lane: QuotaGovernorLane): void {
    const state = this.lanes[lane];
    if (state.multiplier === 1) return;
    if (
      this.now() - state.lastQuotaEventAt >=
      GOOGLE_SHEETS_API_DEFAULTS.QUOTA_RECOVERY_QUIET_MS
    ) {
      this.stepDown(state);
    }
  }

  /** One additive-increase step: ~10% down, clamped at nominal (1x). */
  private stepDown(state: LaneState): void {
    state.multiplier = Math.max(
      state.multiplier / GOOGLE_SHEETS_API_DEFAULTS.QUOTA_RECOVERY_STEP_FACTOR,
      1,
    );
    state.lastQuotaEventAt = this.now();
    state.quietStarts = 0;
    state.steppedDown = state.multiplier > 1;
  }

  /** Read-only snapshot of one lane's pacing state (for telemetry/tests). */
  public stateFor(lane: QuotaGovernorLane): QuotaPacingState {
    this.recoverByElapsed(lane);
    const state = this.lanes[lane];
    if (state.multiplier <= 1 && !state.steppedDown) {
      return { status: QUOTA_PACING_STATES.NOMINAL, multiplier: 1 };
    }
    return {
      status: state.steppedDown
        ? QUOTA_PACING_STATES.RECOVERY
        : QUOTA_PACING_STATES.BACKOFF,
      multiplier: state.multiplier,
      lastQuotaEventAt: state.lastQuotaEventAt,
      quietStarts: state.quietStarts,
    };
  }
}

/**
 * Returns true when a classified transport outcome proves the request was
 * quota-limited remotely (HTTP 429 or the allowlisted `RESOURCE_EXHAUSTED`
 * google.rpc code; either marker alone is sufficient because a proxy-emitted
 * 429 can carry no body and a body can omit the status line evidence).
 */
export function isQuotaLimitedOutcome(outcome: {
  readonly httpStatus: Presence<number>;
  readonly code: Presence<string>;
}): boolean {
  const byStatus =
    outcome.httpStatus.kind === PRESENCE_KINDS.PRESENT &&
    outcome.httpStatus.value === GOOGLE_SHEETS_API_DEFAULTS.QUOTA_LIMIT_HTTP_STATUS;
  const byCode =
    outcome.code.kind === PRESENCE_KINDS.PRESENT &&
    outcome.code.value === GOOGLE_SHEETS_API_DEFAULTS.QUOTA_LIMIT_REMOTE_CODE;
  return byStatus || byCode;
}

export interface RollingQuotaBudgetOptions {
  /**
   * Maximum admitted request starts per window for this lane.
   * `Number.POSITIVE_INFINITY` disables the budget (used by tests that pin
   * pacing separately and simulate high rates over near-zero wall time).
   */
  readonly maxStartsPerWindow: number;
  /** Sliding window length in ms (Google quotas are per-minute). */
  readonly windowMs: number;
  /** Injectable clock for deterministic tests; defaults to Date.now. */
  readonly now?: () => number;
  /** Injectable sleep used while waiting for the next budget slot. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_SLEEP = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Sliding-window per-minute request-start budget for ONE lane.
 *
 * Reservations, not completed requests, occupy the window: an admitted
 * caller records the slot it will start at, so a burst of concurrent
 * callers arriving in the same tick each consumes one of the remaining
 * budget slots and the deep ones are refused by the bounded wait, exactly
 * like the interval limiters. A refusal records NOTHING, so the window can
 * never be poisoned forward by refused callers.
 *
 * The earliest legal start when the window already holds `max` reservations
 * is `starts[n - max] + windowMs`: at that instant all but the `max - 1`
 * newest reservations have aged out, so admitting keeps the count at `max`.
 */
export class RollingQuotaBudget {
  private readonly maxStartsPerWindow: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Reserved start times, kept non-decreasing. */
  private starts: number[] = [];

  public constructor(options: RollingQuotaBudgetOptions) {
    const validRate =
      options.maxStartsPerWindow === Number.POSITIVE_INFINITY ||
      (Number.isSafeInteger(options.maxStartsPerWindow) && options.maxStartsPerWindow > 0);
    if (!validRate) {
      throw new RateLimitOptionsError(
        RATE_LIMIT_OPTIONS_ERROR_CODES.BUDGET_POSITIVE_INTEGER_REQUIRED,
      );
    }
    if (!Number.isSafeInteger(options.windowMs) || options.windowMs <= 0) {
      throw new RateLimitOptionsError(
        RATE_LIMIT_OPTIONS_ERROR_CODES.BUDGET_POSITIVE_INTEGER_REQUIRED,
      );
    }
    this.maxStartsPerWindow = options.maxStartsPerWindow;
    this.windowMs = options.windowMs;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? DEFAULT_SLEEP;
  }

  /** Number of reservations (admitted, possibly still sleeping) in window. */
  public reservedCount(): number {
    return this.starts.length;
  }

  /**
   * Bounded admission to one budget slot: waits only when the predicted
   * slot is at most `maxWaitMs` out, otherwise returns `refused` having
   * reserved nothing. The decision and the reservation happen synchronously
   * before any await, so concurrent callers can never double-book one slot.
   */
  public async waitForSlot(maxWaitMs: number): Promise<RequestStartAdmission> {
    if (!Number.isSafeInteger(maxWaitMs) || maxWaitMs < 0) {
      throw new RateLimitOptionsError(
        RATE_LIMIT_OPTIONS_ERROR_CODES.MAX_WAIT_NON_NEGATIVE_REQUIRED,
      );
    }
    const now = this.now();
    // Age out every reservation that has left the trailing window.
    const cutoff = now - this.windowMs;
    let firstLive = 0;
    for (;;) {
      const candidate = this.starts[firstLive];
      if (candidate === undefined || candidate > cutoff) break;
      firstLive += 1;
    }
    if (firstLive > 0) {
      this.starts = this.starts.slice(firstLive);
    }
    let nextStart = now;
    if (this.starts.length >= this.maxStartsPerWindow) {
      // Window holds its full budget: the earliest legal start is the moment
      // the OLDEST still-counted reservation ages out of the trailing window.
      // The index is in range (length >= max >= 1); the `?? now` arm only
      // answers `noUncheckedIndexedAccess` and is unreachable.
      const anchor = this.starts[this.starts.length - this.maxStartsPerWindow] ?? now;
      nextStart = Math.max(now, anchor + this.windowMs);
    }
    const waited = Math.max(0, nextStart - now);
    if (waited > maxWaitMs) {
      // Refused WITHOUT reserving: the window keeps only admitted slots.
      return { status: "refused", waitedMs: waited, nextStartAt: nextStart };
    }
    this.starts.push(nextStart);
    if (waited > 0) {
      await this.sleep(waited);
    }
    return { status: "admitted", waitedMs: waited };
  }
}
