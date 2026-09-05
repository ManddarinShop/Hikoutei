/**
 * Credential-free unit coverage for the internal read QoS scheduler used by
 * the direct Google Sheets provider.
 *
 * The scheduler keeps ONE shared request-start timeline for BOTH read classes
 * (polling values/observation/safety reads and outbound preflight read-ahead)
 * and applies the weighted `polling 2:1 preflight` fairness policy when both
 * classes have queued work, while the separate WRITE lane stays on the plain
 * `RequestStartLimiter`. Admission is BOUNDED like the single-class limiter:
 * a caller whose predicted slot exceeds `maxWaitMs` is refused without
 * reserving or advancing the shared horizon.
 */

import { describe, expect, it } from "vitest";
import {
  RATE_LIMIT_OPTIONS_ERROR_CODES,
  RateLimitOptionsError,
  ReadQoSScheduler,
  RequestStartLimiter,
} from "@hikoutei/ikisaki";

describe("ReadQoSScheduler", () => {
  it("shares ONE timeline and interval across both read classes", async () => {
    let now = 1_000_000;
    const scheduler = new ReadQoSScheduler({
      intervalMs: 1_100,
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
    });
    // Only one class queued at a time: each start is paced on the SHARED
    // horizon, so a polling start and a preflight start never double the
    // effective read rate.
    await scheduler.waitForSlot("polling", 5_000);
    await scheduler.waitForSlot("preflight", 5_000);
    expect(now).toBe(1_001_100);
  });

  it("applies the 2:1 polling:preflight policy when both classes are queued", async () => {
    let now = 1_000_000;
    const scheduler = new ReadQoSScheduler({
      intervalMs: 1_100,
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
    });
    // One preflight plus two pollings arrive in the SAME synchronous burst so
    // both classes are queued together; the scheduler must schedule two
    // polling starts then one preflight start (2:1), not preflight-first.
    const recorded: Array<"polling" | "preflight"> = [];
    async function admit(pacing: "polling" | "preflight"): Promise<void> {
      await scheduler.waitForSlot(pacing, 5_000);
      recorded.push(pacing);
    }
    await Promise.all([admit("polling"), admit("preflight"), admit("polling")]);
    expect(recorded).toEqual(["polling", "polling", "preflight"]);
    // All three starts reserved exactly two intervals on the ONE shared
    // timeline (polling@t0, polling@t0+1100, preflight@t0+2200).
    expect(scheduler.lastStart()).toBe(1_002_200);
  });

  it("never starves preflight behind a continuous polling burst", async () => {
    let now = 1_000_000;
    const scheduler = new ReadQoSScheduler({
      intervalMs: 1_100,
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
    });
    // Six pollings and two preflights queued together: the fairness policy
    // must serve each preflight (every third pick) instead of letting the
    // polling burst dominate the whole window.
    const admitted: Array<"polling" | "preflight"> = [];
    const admit = async (pacing: "polling" | "preflight"): Promise<void> => {
      await scheduler.waitForSlot(pacing, 20_000);
      admitted.push(pacing);
    };
    await Promise.all([
      admit("polling"), admit("polling"), admit("polling"),
      admit("polling"), admit("polling"), admit("polling"),
      admit("preflight"), admit("preflight"), admit("preflight"),
    ]);
    expect(admitted.filter((entry) => entry === "preflight")).toHaveLength(3);
    expect(admitted.filter((entry) => entry === "polling")).toHaveLength(6);
    // 2:1 ratio is preserved over the window.
    const firstPre = admitted.indexOf("preflight");
    expect(firstPre).toBe(2); // after exactly two polling starts
  });

  it("refuses a deep reservation WITHOUT advancing the shared horizon", async () => {
    const scheduler = new ReadQoSScheduler({
      intervalMs: 1_100,
      now: () => 1_000_000,
      // A NO-OP sleep models callers arriving in one frozen tick while earlier
      // reservations sleep, so the burst's deep reservations are refused.
      sleep: async () => undefined,
    });
    const settled = await Promise.allSettled([
      scheduler.waitForSlot("polling", 1_100),
      scheduler.waitForSlot("polling", 1_100),
      scheduler.waitForSlot("preflight", 1_100),
      scheduler.waitForSlot("preflight", 1_100),
    ]);
    // A refusal is a fulfilled admission value with `status: "refused"`.
    for (const index of [0, 1]) {
      const value = (settled[index] as PromiseFulfilledResult<{ status: string }>).value;
      expect(value.status).toBe("admitted");
    }
    for (const index of [2, 3]) {
      const value = (settled[index] as PromiseFulfilledResult<{ status: string }>).value;
      expect(value.status).toBe("refused");
    }
    // The two refusals never advanced the horizon (only the two pollings did).
    expect(scheduler.lastStart()).toBe(1_001_100);
  });

  it("still admits after time passes the refused slot (no horizon poisoning)", async () => {
    let now = 1_000_000;
    const scheduler = new ReadQoSScheduler({
      intervalMs: 1_100,
      now: () => now,
      // The clock advances only when a sleep RESOLVES (real-world behavior),
      // so a same-tick burst's deep reservations are computed at the frozen
      // instant and the third caller is refused.
      sleep: async (ms: number) => {
        await Promise.resolve();
        now += ms;
      },
    });
    const burst = await Promise.all([
      scheduler.waitForSlot("polling", 1_100),
      scheduler.waitForSlot("polling", 1_100),
      scheduler.waitForSlot("polling", 1_100),
    ]);
    expect(burst[0]?.status).toBe("admitted");
    expect(burst[1]?.status).toBe("admitted");
    expect(burst[2]?.status).toBe("refused");
    expect(scheduler.lastStart()).toBe(1_001_100);
    // Time advances only HALF an interval past the reserved slot: a poisoned
    // horizon (advanced by the refusal) would still be beyond the bound, but
    // the untouched horizon admits the caller with the remaining wait.
    now = 1_001_600;
    const late = await scheduler.waitForSlot("polling", 1_100);
    expect(late.status).toBe("admitted");
    expect(scheduler.lastStart()).toBe(1_002_200);
  });

  it("admits every caller with a zero interval", async () => {
    let now = 42;
    const scheduler = new ReadQoSScheduler({
      intervalMs: 0,
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
    });
    const results = await Promise.all([
      scheduler.waitForSlot("polling", 0),
      scheduler.waitForSlot("preflight", 0),
      scheduler.waitForSlot("polling", 0),
    ]);
    for (const result of results) {
      expect(result).toEqual({ status: "admitted", waitedMs: 0 });
    }
  });

  it("rejects an invalid maximum wait bound", async () => {
    const scheduler = new ReadQoSScheduler({ intervalMs: 1_100 });
    expect(() => scheduler.waitForSlot("polling", -1)).toThrow(RangeError);
    expect(() => scheduler.waitForSlot("preflight", 1.5)).toThrow(RangeError);
  });

  it("keeps the WRITE lane independent on its own RequestStartLimiter", async () => {
    let now = 1_000_000;
    const scheduler = new ReadQoSScheduler({
      intervalMs: 1_100,
      now: () => now,
      sleep: async (ms: number) => {
        await Promise.resolve();
        now += ms;
      },
    });
    const writeLimiter = new RequestStartLimiter({
      intervalMs: 1_100,
      now: () => now,
      sleep: async (ms: number) => {
        await Promise.resolve();
        now += ms;
      },
    });
    // A four-read BURST saturates the read QoS timeline (only two admitted,
    // two refused), but a WRITE start uses the independent write limiter and
    // is NOT refused behind the reads.
    const reads = await Promise.all([
      scheduler.waitForSlot("polling", 1_100),
      scheduler.waitForSlot("polling", 1_100),
      scheduler.waitForSlot("polling", 1_100),
      scheduler.waitForSlot("polling", 1_100),
    ]);
    expect(reads.filter((entry) => entry.status === "admitted")).toHaveLength(2);
    const writeAdmission = await writeLimiter.waitForSlot(1_100);
    expect(writeAdmission.status).toBe("admitted");
    // The write did not consume a read timeline slot.
    expect(scheduler.lastStart()).toBe(1_001_100);
  });

  it("throws RateLimitOptionsError with INTERVAL_NON_NEGATIVE_REQUIRED for invalid constructor intervalMs", () => {
    expect.assertions(3);
    try {
      new ReadQoSScheduler({ intervalMs: -1 });
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(RateLimitOptionsError);
      expect((error as RateLimitOptionsError).code).toBe(
        RATE_LIMIT_OPTIONS_ERROR_CODES.INTERVAL_NON_NEGATIVE_REQUIRED,
      );
      expect((error as Error).message).toBe(
        "request-start interval must be a non-negative safe integer",
      );
    }
  });

  it("throws RateLimitOptionsError with MAX_WAIT_NON_NEGATIVE_REQUIRED for invalid maxWaitMs", async () => {
    expect.assertions(3);
    const scheduler = new ReadQoSScheduler({ intervalMs: 1_100 });
    try {
      await scheduler.waitForSlot("polling", -1);
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(RateLimitOptionsError);
      expect((error as RateLimitOptionsError).code).toBe(
        RATE_LIMIT_OPTIONS_ERROR_CODES.MAX_WAIT_NON_NEGATIVE_REQUIRED,
      );
      expect((error as Error).message).toBe(
        "maximum request-start wait must be a non-negative safe integer",
      );
    }
  });
});
