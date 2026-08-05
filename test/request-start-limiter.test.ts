/**
 * Credential-free unit coverage for the request-start interval limiter used
 * by the direct Google Sheets provider (reads and writes share one limiter
 * class each; concurrent callers must never start within one interval).
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
});
