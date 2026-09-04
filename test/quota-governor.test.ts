/**
 * Credential-free unit coverage for the adaptive quota governor layered on
 * top of the request-start limiters:
 *
 * - `RollingQuotaBudget`: a sliding-window per-minute request-start budget
 *   per lane with the SAME bounded-admission contract as the interval
 *   limiters — a refusal reserves nothing and can never advance the horizon.
 * - `QuotaPacingGovernor`: AIMD pacing feedback. A quota-limited (429 /
 *   RESOURCE_EXHAUSTED) response doubles that lane's pacing interval (capped
 *   at 4x base); sustained quiet (successful starts or elapsed time) steps
 *   the interval back down ~10% at a time and never below the base.
 * - Composition: the governor drives a limiter's interval through
 *   `getIntervalMs` WITHOUT replacing its pacing or refusal semantics.
 *
 * The budget is a per-lane CEILING on request STARTS; the interval limiters
 * stay in front of the transport unchanged.
 */

import { describe, expect, it } from "vitest";
import { GOOGLE_SHEETS_API_DEFAULTS } from "@hikoutei/contracts/sheets/googleSheetsApi.js";
import { presentValue, absentValue } from "@hikoutei/contracts/state/index.js";
import {
  RATE_LIMIT_OPTIONS_ERROR_CODES,
  RateLimitOptionsError,
  RequestStartLimiter,
} from "@hikoutei/sheets/sheets/providers/google-sheets-api/transport/rateLimiter.js";
import {
  isQuotaLimitedOutcome,
  QUOTA_GOVERNOR_LANES,
  QUOTA_PACING_STATES,
  QuotaPacingGovernor,
  RollingQuotaBudget,
} from "@hikoutei/sheets/sheets/providers/google-sheets-api/transport/quotaGovernor.js";

describe("RollingQuotaBudget", () => {
  it("refuses starts beyond the window budget WITHOUT reserving", async () => {
    let now = 1_000_000;
    const budget = new RollingQuotaBudget({
      maxStartsPerWindow: 3,
      windowMs: 60_000,
      now: () => now,
      sleep: async () => undefined,
    });

    expect(await budget.waitForSlot(0)).toEqual({ status: "admitted", waitedMs: 0 });
    expect(await budget.waitForSlot(0)).toEqual({ status: "admitted", waitedMs: 0 });
    expect(await budget.waitForSlot(0)).toEqual({ status: "admitted", waitedMs: 0 });
    // Window holds its full budget: the fourth start is refused a slot a
    // whole window out, and the refusal reserves NOTHING.
    expect(await budget.waitForSlot(0)).toEqual({
      status: "refused",
      waitedMs: 60_000,
      nextStartAt: 1_060_000,
    });
    expect(budget.reservedCount()).toBe(3);
  });

  it("makes a budget violation impossible under concurrent admission", async () => {
    // Frozen clock + no-op sleep: every concurrent caller decides against the
    // SAME window state within one synchronous tick.
    const budget = new RollingQuotaBudget({
      maxStartsPerWindow: 4,
      windowMs: 60_000,
      now: () => 500,
      sleep: async () => undefined,
    });
    const results = await Promise.all(
      Array.from({ length: 12 }, () => budget.waitForSlot(1_000)),
    );
    const admitted = results.filter((entry) => entry.status === "admitted");
    expect(admitted).toHaveLength(4);
    expect(budget.reservedCount()).toBe(4);
    // Deep reservations are refused up front, never booked: a whole window
    // of wait exceeds the 1 s bound even though the sliding window would
    // legally reopen at 60_500.
    for (const entry of results.slice(4)) {
      expect(entry).toEqual({
        status: "refused",
        waitedMs: 60_000,
        nextStartAt: 60_500,
      });
    }
  });

  it("slides the window: refused slots stay open and admit once budget frees", async () => {
    let now = 0;
    const budget = new RollingQuotaBudget({
      maxStartsPerWindow: 2,
      windowMs: 60_000,
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
    });
    await budget.waitForSlot(0); // reservation @0
    await budget.waitForSlot(0); // reservation @0
    expect((await budget.waitForSlot(1_000)).status).toBe("refused");

    // Half a window later the budget is still full: the earliest legal start
    // is when the OLDEST admission ages out (t=60_000), still beyond the bound.
    now = 30_000;
    expect((await budget.waitForSlot(1_000)).status).toBe("refused");
    expect(budget.reservedCount()).toBe(2);

    // At t=60_000 the first reservation has left the trailing window (the
    // window bound is exclusive), so a fresh caller is admitted immediately
    // despite the earlier refusals: refusals poisoned nothing.
    now = 60_000;
    expect(await budget.waitForSlot(0)).toEqual({ status: "admitted", waitedMs: 0 });
  });

  it("waits for the window slot when the bounded wait covers it", async () => {
    let now = 0;
    const budget = new RollingQuotaBudget({
      maxStartsPerWindow: 1,
      windowMs: 1_000,
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
    });
    expect(await budget.waitForSlot(2_000)).toEqual({ status: "admitted", waitedMs: 0 });
    // Second caller: its slot is the moment the first ages out.
    expect(await budget.waitForSlot(2_000)).toEqual({ status: "admitted", waitedMs: 1_000 });
    expect(now).toBe(1_000);
  });

  it("treats an Infinity budget as unlimited and rejects invalid rates", async () => {
    const unlimited = new RollingQuotaBudget({
      maxStartsPerWindow: Number.POSITIVE_INFINITY,
      windowMs: 60_000,
      now: () => 7,
      sleep: async () => undefined,
    });
    for (let i = 0; i < 100; i += 1) {
      expect((await unlimited.waitForSlot(0)).status).toBe("admitted");
    }
    for (const rate of [0, -1, 1.5, Number.NaN]) {
      expect(
        () => new RollingQuotaBudget({ maxStartsPerWindow: rate, windowMs: 60_000 }),
      ).toThrow(RateLimitOptionsError);
    }
    await expect(
      new RollingQuotaBudget({ maxStartsPerWindow: 5, windowMs: 60_000 }).waitForSlot(-1),
    ).rejects.toThrow(RateLimitOptionsError);
  });

  it("exposes the budget error code for invalid constructor rates", () => {
    expect.assertions(2);
    try {
      new RollingQuotaBudget({ maxStartsPerWindow: 0, windowMs: 0 });
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(RateLimitOptionsError);
      expect((error as RateLimitOptionsError).code).toBe(
        RATE_LIMIT_OPTIONS_ERROR_CODES.BUDGET_POSITIVE_INTEGER_REQUIRED,
      );
    }
  });
});

describe("QuotaPacingGovernor", () => {
  it("stays nominal at 1x (base interval) until a 429 is observed", () => {
    const governor = new QuotaPacingGovernor({ baseIntervalMs: 800, now: () => 0 });
    expect(governor.intervalMsFor(QUOTA_GOVERNOR_LANES.READ)).toBe(800);
    expect(governor.stateFor(QUOTA_GOVERNOR_LANES.READ)).toEqual({
      status: QUOTA_PACING_STATES.NOMINAL,
      multiplier: 1,
    });
    // Successful starts on a nominal lane never move the multiplier.
    governor.recordRequestStart(QUOTA_GOVERNOR_LANES.READ);
    expect(governor.stateFor(QUOTA_GOVERNOR_LANES.READ).status).toBe(
      QUOTA_PACING_STATES.NOMINAL,
    );
  });

  it("grows the interval x2 per 429, capped at 4x base, per lane", () => {
    let now = 1_000;
    const governor = new QuotaPacingGovernor({ baseIntervalMs: 1_000, now: () => now });
    governor.recordQuotaLimited(QUOTA_GOVERNOR_LANES.READ);
    expect(governor.intervalMsFor(QUOTA_GOVERNOR_LANES.READ)).toBe(2_000);
    expect(governor.stateFor(QUOTA_GOVERNOR_LANES.READ).status).toBe(
      QUOTA_PACING_STATES.BACKOFF,
    );
    governor.recordQuotaLimited(QUOTA_GOVERNOR_LANES.READ);
    expect(governor.intervalMsFor(QUOTA_GOVERNOR_LANES.READ)).toBe(4_000);
    // Capped: a third 429 cannot push past QUOTA_BACKOFF_MAX_MULTIPLIER.
    governor.recordQuotaLimited(QUOTA_GOVERNOR_LANES.READ);
    expect(governor.intervalMsFor(QUOTA_GOVERNOR_LANES.READ)).toBe(
      1_000 * GOOGLE_SHEETS_API_DEFAULTS.QUOTA_BACKOFF_MAX_MULTIPLIER,
    );
    // The WRITE lane is untouched by READ-quota evidence.
    expect(governor.intervalMsFor(QUOTA_GOVERNOR_LANES.WRITE)).toBe(1_000);
  });

  it("recovers by halving per quiet window after the success threshold and never below base", () => {
    let now = 0;
    const governor = new QuotaPacingGovernor({ baseIntervalMs: 1_000, now: () => now });
    // TWO 429s put the lane at the 4x cap: recovery must pass through an
    // intermediate (recovery) step before landing on nominal.
    governor.recordQuotaLimited(QUOTA_GOVERNOR_LANES.READ);
    governor.recordQuotaLimited(QUOTA_GOVERNOR_LANES.READ);
    expect(governor.intervalMsFor(QUOTA_GOVERNOR_LANES.READ)).toBe(4_000);

    // Fewer than the threshold of successes (and no quiet elapsed time): no
    // step yet — one 429 cannot be answered by an immediate undo.
    for (let i = 0; i < GOOGLE_SHEETS_API_DEFAULTS.QUOTA_RECOVERY_SUCCESS_THRESHOLD - 1; i += 1) {
      governor.recordRequestStart(QUOTA_GOVERNOR_LANES.READ);
    }
    expect(governor.intervalMsFor(QUOTA_GOVERNOR_LANES.READ)).toBe(4_000);
    governor.recordRequestStart(QUOTA_GOVERNOR_LANES.READ);
    expect(governor.intervalMsFor(QUOTA_GOVERNOR_LANES.READ)).toBe(2_000);
    expect(governor.stateFor(QUOTA_GOVERNOR_LANES.READ).status).toBe(
      QUOTA_PACING_STATES.RECOVERY,
    );

    // Each further quiet batch of successes halves again until the base,
    // and the floor is exact: recovery lands on nominal at 1x, never below.
    for (let i = 0; i < 1_000; i += 1) {
      governor.recordRequestStart(QUOTA_GOVERNOR_LANES.READ);
    }
    expect(governor.intervalMsFor(QUOTA_GOVERNOR_LANES.READ)).toBe(1_000);
    expect(governor.stateFor(QUOTA_GOVERNOR_LANES.READ)).toEqual({
      status: QUOTA_PACING_STATES.NOMINAL,
      multiplier: 1,
    });
  });

  it("steps down after elapsed quiet time alone", () => {
    let now = 10_000;
    const governor = new QuotaPacingGovernor({ baseIntervalMs: 1_000, now: () => now });
    governor.recordQuotaLimited(QUOTA_GOVERNOR_LANES.WRITE);
    // A stalled lane that resumes after the quiet window steps down on its
    // FIRST successful start. With QUOTA_RECOVERY_STEP_FACTOR = 2, a single
    // 429's 2x backoff recovers fully to nominal in ONE step.
    now = 10_000 + GOOGLE_SHEETS_API_DEFAULTS.QUOTA_RECOVERY_QUIET_MS + 1;
    governor.recordRequestStart(QUOTA_GOVERNOR_LANES.WRITE);
    expect(governor.intervalMsFor(QUOTA_GOVERNOR_LANES.WRITE)).toBe(1_000);
    expect(governor.stateFor(QUOTA_GOVERNOR_LANES.WRITE)).toEqual({
      status: QUOTA_PACING_STATES.NOMINAL,
      multiplier: 1,
    });
  });

  it("recovers lazily on observation with NO request starts at all", () => {
    let now = 10_000;
    const governor = new QuotaPacingGovernor({ baseIntervalMs: 1_000, now: () => now });
    governor.recordQuotaLimited(QUOTA_GOVERNOR_LANES.READ);
    expect(governor.intervalMsFor(QUOTA_GOVERNOR_LANES.READ)).toBe(2_000);
    // A lane with ZERO traffic never reaches recordRequestStart: advancing
    // the clock past the quiet window must still recover it when the
    // interval/state is merely OBSERVED (the lane reservation path).
    now += GOOGLE_SHEETS_API_DEFAULTS.QUOTA_RECOVERY_QUIET_MS + 1;
    expect(governor.intervalMsFor(QUOTA_GOVERNOR_LANES.READ)).toBeLessThan(2_000);
    // Fully back to nominal after enough quiet windows elapse, with the
    // backoff state cleared.
    for (let i = 0; i < 100; i += 1) {
      now += GOOGLE_SHEETS_API_DEFAULTS.QUOTA_RECOVERY_QUIET_MS + 1;
      governor.stateFor(QUOTA_GOVERNOR_LANES.READ);
    }
    expect(governor.intervalMsFor(QUOTA_GOVERNOR_LANES.READ)).toBe(1_000);
    expect(governor.stateFor(QUOTA_GOVERNOR_LANES.READ)).toEqual({
      status: QUOTA_PACING_STATES.NOMINAL,
      multiplier: 1,
    });
  });
});

describe("quota governor composition with the interval limiters", () => {
  it("paces through the governor interval and never advances the horizon on refusal under backoff", async () => {
    let now = 1_000_000;
    const governor = new QuotaPacingGovernor({ baseIntervalMs: 1_000, now: () => now });
    const limiter = new RequestStartLimiter({
      intervalMs: 1_000,
      getIntervalMs: () => governor.intervalMsFor(QUOTA_GOVERNOR_LANES.WRITE),
      now: () => now,
      sleep: async () => undefined,
    });

    expect(await limiter.waitForSlot(1_000)).toEqual({ status: "admitted", waitedMs: 0 });
    // A 429 doubles the pacing for the NEXT reservation without
    // reconstructing the limiter.
    governor.recordQuotaLimited(QUOTA_GOVERNOR_LANES.WRITE);
    const refused = await limiter.waitForSlot(1_000);
    expect(refused).toEqual({
      status: "refused",
      waitedMs: 2_000,
      nextStartAt: 1_002_000,
    });
    // Refusal under backoff: the pacing horizon is the ADMITTED start only.
    expect(limiter.lastStart()).toBe(1_000_000);
    // Time advances past the open slot: admission resumes on the doubled
    // (backoff) interval, proving the governor paces reservations, not just
    // refusals.
    now = 1_002_000;
    expect(await limiter.waitForSlot(1_000)).toEqual({ status: "admitted", waitedMs: 0 });
    expect(await limiter.waitForSlot(3_000)).toEqual({ status: "admitted", waitedMs: 2_000 });
    expect(limiter.lastStart()).toBe(1_004_000);
  });

  it("isQuotaLimitedOutcome matches 429 status or RESOURCE_EXHAUSTED code only", () => {
    expect(isQuotaLimitedOutcome({
      httpStatus: presentValue(GOOGLE_SHEETS_API_DEFAULTS.QUOTA_LIMIT_HTTP_STATUS),
      code: absentValue(),
    })).toBe(true);
    expect(isQuotaLimitedOutcome({
      httpStatus: absentValue(),
      code: presentValue(GOOGLE_SHEETS_API_DEFAULTS.QUOTA_LIMIT_REMOTE_CODE),
    })).toBe(true);
    expect(isQuotaLimitedOutcome({
      httpStatus: presentValue(503),
      code: presentValue("UNAVAILABLE"),
    })).toBe(false);
    expect(isQuotaLimitedOutcome({ httpStatus: absentValue(), code: absentValue() })).toBe(false);
    // A sanitized `unknown` code must not be mistaken for quota evidence.
    expect(isQuotaLimitedOutcome({
      httpStatus: absentValue(),
      code: presentValue("RESOURCE_EXHAUSTED-ish"),
    })).toBe(false);
  });
});
