/**
 * Offline unit tests for the soak timing module's clock-slop deadline
 * helper (`isDeadlineExpired`).
 *
 * The helper backs the invariant "a deadline-bounded sleep has ended => the
 * deadline expired": a bounded sleep can wake with `Date.now()` reading up
 * to ~1-2ms short of the nominal deadline (libuv timer jitter, coarse CI VM
 * clocks under load), so the expiry check carries a small tolerance. These
 * tests are pure-function checks with no timers, mocks, or I/O.
 */
import { describe, expect, it } from "vitest";
import { CLOCK_SLOP_MS, isDeadlineExpired } from "../scripts/ci/local-soak/timing.mjs";

describe("isDeadlineExpired clock-slop semantics", () => {
  it("reports expired exactly at the deadline", () => {
    expect(isDeadlineExpired(1_000, 1_000)).toBe(true);
  });

  it("treats a 1ms-short clock reading as expired via the slop", () => {
    // A bounded sleep waking marginally short of the deadline must still
    // read expired, or a doomed write starts against an expired budget.
    expect(isDeadlineExpired(1_000, 1_000 - 1)).toBe(true);
  });

  it("reports not expired for a clearly-future deadline", () => {
    expect(isDeadlineExpired(1_000, 1_000 - 10)).toBe(false);
  });

  it("does not misfire when the budget is far from expiring", () => {
    // Far-future deadlines never read expired under the default slop.
    expect(isDeadlineExpired(1_000, 1_000 - 1_000)).toBe(false);
    expect(isDeadlineExpired(Number.MAX_SAFE_INTEGER)).toBe(false);
  });

  it("allows an explicit zero slop for exact zero-tolerance semantics", () => {
    expect(isDeadlineExpired(1_000, 1_000, 0)).toBe(true);
    expect(isDeadlineExpired(1_000, 1_000 - 1, 0)).toBe(false);
  });

  it("proves the exact slop boundary with fixed nowMs values", () => {
    // Fixed-clock pure-function proof of the boundary: exactly-at-deadline
    // and up-to-CLOCK_SLOP_MS-short read expired; anything further short
    // does not.
    const deadline = 1_000;
    expect(isDeadlineExpired(deadline, deadline)).toBe(true);
    expect(isDeadlineExpired(deadline, deadline - CLOCK_SLOP_MS)).toBe(true);
    expect(isDeadlineExpired(deadline, deadline - CLOCK_SLOP_MS - 1)).toBe(false);
    expect(isDeadlineExpired(deadline, deadline - 10)).toBe(false);
    // Pin the concrete contract, not just the constant-derived boundary: if
    // CLOCK_SLOP_MS ever changes, these literal assertions fail loudly so
    // the production race-protection window is never widened silently.
    expect(CLOCK_SLOP_MS).toBe(2);
    expect(isDeadlineExpired(deadline, deadline - 2)).toBe(true);
    expect(isDeadlineExpired(deadline, deadline - 3)).toBe(false);
  });

  it("defaults nowMs to Date.now() and slopMs to CLOCK_SLOP_MS", () => {
    // Deterministic defaults-path check purely via the relative distance to
    // any real now: a deadline epoch far in the past is always expired (no
    // slop can rescue it), and a deadline far in the future is never
    // expired under the default slop.
    expect(isDeadlineExpired(0)).toBe(true);
    expect(isDeadlineExpired(Number.MAX_SAFE_INTEGER)).toBe(false);
  });
});