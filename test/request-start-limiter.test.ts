/**
 * Credential-free unit coverage for the GENERIC single-lane
 * `RequestStartLimiter` primitive: concurrent callers of one lane must never
 * start within one interval. This is NOT a test of the current provider's
 * read/write architecture — the provider composes SEPARATE instances of this
 * primitive (a shared read QoS scheduler and a write limiter) plus an
 * independent bounded admission wait (`requestStartMaxWaitMs`), so a read
 * and a write can start concurrently there.
 */

import { describe, expect, it } from "vitest";
import { RequestStartLimiter } from "../src/adapter/sheets/providers/google-sheets-api/transport/rateLimiter.js";

describe("RequestStartLimiter", () => {
  it("waits only the remaining interval since the previous start", async () => {
    let now = 1_000_000;
    const limiter = new RequestStartLimiter({
      intervalMs: 1_100,
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
    });

    expect(await limiter.waitForSlot()).toBe(0);
    expect(await limiter.waitForSlot()).toBe(1_100);
    // A caller arriving after the reserved slot has passed starts immediately.
    now += 5_000;
    expect(await limiter.waitForSlot()).toBe(0);
  });

  it("keeps two concurrent callers at least intervalMs apart", async () => {
    let now = 1_000_000;
    const limiter = new RequestStartLimiter({
      intervalMs: 1_100,
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
    });

    // Both callers compute from the SAME clock instant. The first reserves
    // the slot at `now`; the second must reserve the NEXT slot instead of
    // reusing the same lastStartAt, sleeping concurrently, and starting
    // together with the first.
    const [first, second] = await Promise.all([
      limiter.waitForSlot(),
      limiter.waitForSlot(),
    ]);
    expect(first).toBe(0);
    expect(second).toBe(1_100);
    expect(limiter.lastStart()).toBe(1_001_100);

    // A third caller arriving exactly at the second slot's instant waits one
    // full interval again (its reservation lands one interval after it).
    const third = await limiter.waitForSlot();
    expect(third).toBe(1_100);
    expect(limiter.lastStart()).toBe(1_002_200);
  });

  it("never waits with a zero interval and records every start", async () => {
    let now = 42;
    const limiter = new RequestStartLimiter({
      intervalMs: 0,
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
    });

    const [first, second] = await Promise.all([
      limiter.waitForSlot(),
      limiter.waitForSlot(),
    ]);
    expect(first).toBe(0);
    expect(second).toBe(0);
    expect(limiter.lastStart()).toBe(42);
  });

  it("refuses a bounded wait beyond the maximum WITHOUT reserving the slot", async () => {
    // A NO-OP sleep models concurrent callers arriving in the same clock
    // tick while an earlier reservation sleeps: the queue never drains by
    // itself, which is exactly the burst the bounded admission must refuse.
    const limiter = new RequestStartLimiter({
      intervalMs: 1_100,
      now: () => 1_000_000,
      sleep: async () => undefined,
    });

    // First caller: immediate slot.
    expect(await limiter.waitForSlot(1_100)).toEqual({ status: "admitted", waitedMs: 0 });
    // Second caller in the same tick: exactly one interval of wait, admitted.
    expect(await limiter.waitForSlot(1_100)).toEqual({ status: "admitted", waitedMs: 1_100 });
    // Third caller: two intervals out — refused, and the horizon is NOT
    // advanced past the second caller's slot. The refused slot stays open.
    const refused = await limiter.waitForSlot(1_100);
    expect(refused).toEqual({
      status: "refused",
      waitedMs: 2_200,
      nextStartAt: 1_002_200,
    });
    expect(limiter.lastStart()).toBe(1_001_100);
  });

  it("still admits after time advances past the refused slot (no poisoning)", async () => {
    let now = 1_000_000;
    const limiter = new RequestStartLimiter({
      intervalMs: 1_100,
      now: () => now,
      sleep: async () => undefined,
    });

    await limiter.waitForSlot(1_100); // admitted at t0
    await limiter.waitForSlot(1_100); // admitted at t0+1,100
    expect((await limiter.waitForSlot(1_100)).status).toBe("refused");
    expect(limiter.lastStart()).toBe(1_001_100);

    // Time advances only HALF an interval past the reserved slot: a
    // poisoned horizon (advanced by the refusal) would still be beyond the
    // bound, but the untouched horizon admits the caller with the remaining
    // 600 ms wait.
    now = 1_001_600;
    expect(await limiter.waitForSlot(1_100)).toEqual({
      status: "admitted",
      waitedMs: 600,
    });
    expect(limiter.lastStart()).toBe(1_002_200);
  });

  it("refuses every queued reservation beyond one interval under concurrency", async () => {
    let now = 1_000_000;
    const limiter = new RequestStartLimiter({
      intervalMs: 1_100,
      now: () => now,
      sleep: async () => undefined,
    });

    // Four callers arrive at the SAME instant: the immediate slot and the
    // slot exactly one interval out are admitted; the third and fourth
    // reservations (two and three intervals out) are refused up front
    // without advancing the horizon. The slot reservation stays synchronous
    // before any await, so no two callers can share one slot.
    const results = await Promise.all([
      limiter.waitForSlot(1_100),
      limiter.waitForSlot(1_100),
      limiter.waitForSlot(1_100),
      limiter.waitForSlot(1_100),
    ]);
    expect(results[0]).toEqual({ status: "admitted", waitedMs: 0 });
    expect(results[1]).toEqual({ status: "admitted", waitedMs: 1_100 });
    expect(results[2]).toEqual({
      status: "refused",
      waitedMs: 2_200,
      nextStartAt: 1_002_200,
    });
    expect(results[3]).toEqual({
      status: "refused",
      waitedMs: 2_200,
      nextStartAt: 1_002_200,
    });
    expect(limiter.lastStart()).toBe(1_001_100);

    // The queue drains: once time passes the open slot, a fresh bounded
    // caller is admitted again with no wait (its reservation collapses to
    // now because the open slot is already in the past).
    now = 1_003_000;
    expect(await limiter.waitForSlot(1_100)).toEqual({
      status: "admitted",
      waitedMs: 0,
    });
  });

  it("rejects an invalid maximum wait bound and admits every zero-interval caller", async () => {
    const limiter = new RequestStartLimiter({ intervalMs: 0 });
    expect(await limiter.waitForSlot(0)).toEqual({ status: "admitted", waitedMs: 0 });

    const bounded = new RequestStartLimiter({ intervalMs: 1_100 });
    await expect(bounded.waitForSlot(-1)).rejects.toThrow(RangeError);
    await expect(bounded.waitForSlot(1.5)).rejects.toThrow(RangeError);
    await expect(bounded.waitForSlot(Number.NaN)).rejects.toThrow(RangeError);
    // The validation never touches the horizon.
    expect(bounded.lastStart()).toBeUndefined();
  });
});
