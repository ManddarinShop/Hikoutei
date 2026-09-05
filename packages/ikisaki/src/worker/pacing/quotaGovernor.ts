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

import { PRESENCE_KINDS, type Presence } from "../../contract/state.js";
import {
  RATE_LIMIT_OPTIONS_ERROR_CODES,
  RateLimitOptionsError, } from "./rateLimiter.js";

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

/**
 * Quota/backoff markers the governor paces against.
 *
 * The Sheets provider owns these numbers and passes its own defaults at
 * construction; the inlined fallback matches those defaults so direct
 * constructions behave identically.
 */
export interface QuotaGovernorTimingDefaults {
  /** Multiplicative decrease factor applied per observed quota event. */
  readonly backoffGrowthFactor: number;
  /** Ceiling for the AIMD pacing multiplier, as a multiple of base. */
  readonly backoffMaxMultiplier: number;
  /** Additive increase divisor per recovery step. */
  readonly recoveryStepFactor: number;
  /** Successful starts of quiet before one recovery step. */
  readonly recoverySuccessThreshold: number;
  /** Elapsed ms since the last quota event that alone earns a recovery step. */
  readonly recoveryQuietMs: number;
  /** HTTP status that marks a quota-limited response. */
  readonly quotaLimitHttpStatus: number;
  /** Remote code that marks a quota-limited response without a status. */
  readonly quotaLimitRemoteCode: string;
}

/** Fallback markers matching the Sheets provider defaults. */
export const DEFAULT_QUOTA_GOVERNOR_TIMING: QuotaGovernorTimingDefaults = {
  backoffGrowthFactor: 2,
  backoffMaxMultiplier: 4,
  recoveryStepFactor: 2,
  recoverySuccessThreshold: 25,
  recoveryQuietMs: 10_000,
  quotaLimitHttpStatus: 429,
  quotaLimitRemoteCode: "RESOURCE_EXHAUSTED",
};

export interface QuotaPacingGovernorOptions {
  /** Configured base pacing interval for both lanes. */
  readonly baseIntervalMs: number;
  /**
   * Quota/backoff markers; the Sheets provider passes its own defaults at
   * construction. Omitted falls back to the matching inlined markers.
   */
  readonly timingDefaults?: QuotaGovernorTimingDefaults;
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
  private readonly timing: QuotaGovernorTimingDefaults;
  private readonly now: () => number;
  private readonly lanes: Record<QuotaGovernorLane, LaneState>;

  public constructor(options: QuotaPacingGovernorOptions) {
    this.baseIntervalMs = options.baseIntervalMs;
    this.timing = options.timingDefaults ?? DEFAULT_QUOTA_GOVERNOR_TIMING;
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
      state.multiplier * this.timing.backoffGrowthFactor,
      this.timing.backoffMaxMultiplier,
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
      state.quietStarts < this.timing.recoverySuccessThreshold &&
      quietElapsed < this.timing.recoveryQuietMs
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
      this.timing.recoveryQuietMs
    ) {
      this.stepDown(state);
    }
  }

  /** One additive-increase step: ~10% down, clamped at nominal (1x). */
  private stepDown(state: LaneState): void {
    state.multiplier = Math.max(
      state.multiplier / this.timing.recoveryStepFactor,
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
}, timing: QuotaGovernorTimingDefaults = DEFAULT_QUOTA_GOVERNOR_TIMING): boolean {
  const byStatus =
    outcome.httpStatus.kind === PRESENCE_KINDS.PRESENT &&
    outcome.httpStatus.value === timing.quotaLimitHttpStatus;
  const byCode =
    outcome.code.kind === PRESENCE_KINDS.PRESENT &&
    outcome.code.value === timing.quotaLimitRemoteCode;
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
 * Opaque handle for ONE provisional budget reservation returned by
 * `waitForSlot`. Passed back to {@link RollingQuotaBudget.rollback} when a
 * downstream admission gate refuses after the budget already reserved, so a
 * refused request never keeps consuming budget. The token is matched by
 * OBJECT IDENTITY, never by its timestamp, so a rollback can never release
 * a different (live) reservation, and a repeated rollback is a no-op.
 */
export interface BudgetReservation {
  /** Internal: the reserved start time, read only by the owning budget. */
  readonly reservedAt: number;
}

/** Admitted result of `RollingQuotaBudget.waitForSlot` (adds the rollback token). */
export type RollingQuotaBudgetAdmission =
  | { readonly status: "admitted"; readonly waitedMs: number; readonly reservation: BudgetReservation }
  | { readonly status: "refused"; readonly waitedMs: number; readonly nextStartAt: number };

/**
 * Sliding-window per-minute request-start budget for ONE lane.
 *
 * Reservations, not completed requests, occupy the window: an admitted
 * caller records the slot it will start at, so a burst of concurrent
 * callers arriving in the same tick each consumes one of the remaining
 * budget slots and the deep ones are refused by the bounded wait, exactly
 * like the interval limiters. A budget refusal records NOTHING, so the
 * window can never be poisoned forward by refused callers.
 *
 * A budget ADMISSION reserves provisionally: a caller that later has to
 * refuse on a downstream gate (e.g. the pacing lane) hands the reservation
 * token to `rollback`, which removes exactly that entry. Rollback never
 * advances (or otherwise touches) the window and can never free a live
 * reservation belonging to another caller.
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
  /**
   * Reserved start times, kept in chronological (non-decreasing `reservedAt`)
   * order at all times. Rollback splices its own entry out (order survives)
   * and every new reservation is inserted at its sorted position rather than
   * blindly appended: a rolled-back older slot must never let a later caller
   * land BEHIND a queued future reservation, or the prefix expiry scan would
   * stop at the future entry and retain the trailing expired one forever,
   * leaking budget capacity.
   */
  private starts: BudgetReservation[] = [];

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
  public async waitForSlot(maxWaitMs: number): Promise<RollingQuotaBudgetAdmission> {
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
      if (candidate === undefined || candidate.reservedAt > cutoff) break;
      firstLive += 1;
    }
    if (firstLive > 0) {
      this.starts = this.starts.slice(firstLive);
    }
    let nextStart = now;
    if (this.starts.length >= this.maxStartsPerWindow) {
      // Window holds its full budget: the earliest legal start is the moment
      // the OLDEST still-counted reservation ages out of the trailing window.
      // The index is in range (length >= max >= 1); the fallback arm only
      // answers `noUncheckedIndexedAccess` and is unreachable.
      const anchor = this.starts[this.starts.length - this.maxStartsPerWindow];
      nextStart = Math.max(now, (anchor?.reservedAt ?? now) + this.windowMs);
    }
    const waited = Math.max(0, nextStart - now);
    if (waited > maxWaitMs) {
      // Refused WITHOUT reserving: the window keeps only admitted slots.
      return { status: "refused", waitedMs: waited, nextStartAt: nextStart };
    }
    const reservation: BudgetReservation = { reservedAt: nextStart };
    this.insertReservation(reservation);
    if (waited > 0) {
      await this.sleep(waited);
    }
    return { status: "admitted", waitedMs: waited, reservation };
  }

  /**
   * Inserts one reservation keeping {@link starts} chronologically ordered.
   * The common case (slot at or after every existing entry) is a plain push;
   * only an out-of-order arrival after a rollback walks back from the tail,
   * which is bounded by the window budget (a few hundred entries per minute).
   */
  private insertReservation(reservation: BudgetReservation): void {
    let index = this.starts.length;
    while (index > 0 && this.starts[index - 1]!.reservedAt > reservation.reservedAt) {
      index -= 1;
    }
    this.starts.splice(index, 0, reservation);
  }

  /**
   * Rolls back one PROVISIONAL budget reservation returned by `waitForSlot`
   * whose caller never reached request start (e.g. a downstream pacing-lane
   * refusal). Invariants: the removal is matched by object identity, so it
   * can never release a different live reservation; a token that was already
   * rolled back or aged out of the window is a no-op (no double release);
   * rollback never advances the window (remaining reservations and their
   * timestamps are untouched).
   */
  public rollback(reservation: BudgetReservation): void {
    const index = this.starts.indexOf(reservation);
    if (index !== -1) {
      this.starts.splice(index, 1);
    }
  }
}
