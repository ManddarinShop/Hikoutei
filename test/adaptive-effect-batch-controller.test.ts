import { describe, expect, it, vi } from "vitest";

import {
  AdaptiveBatchOptionsError,
  AdaptiveEffectBatchController,
} from "@hikoutei/ikisaki";

describe("adaptive effect batch controller", () => {
  it("starts at one hundred, halves unhealthy routes, and grows stable routes", () => {
    const controller = new AdaptiveEffectBatchController({ coalesceWindowMs: 0 });

    expect(controller.limitFor("route-a")).toBe(100);
    // Latency above the high-latency threshold (120s) is UNHEALTHY: the
    // batch halves. 30s of cycle time alone no longer shrinks a batch —
    // a healthy-at-scale cycle must not be punished for being slow.
    controller.observe("route-a", {
      durationMs: 121_000,
      responseSucceeded: true,
      responseLoss: false,
    });
    expect(controller.limitFor("route-a")).toBe(50);

    // Stable successes grow +25 per 2 consecutive healthy observations.
    controller.observe("route-a", { durationMs: 100, responseSucceeded: true, responseLoss: false });
    controller.observe("route-a", { durationMs: 100, responseSucceeded: true, responseLoss: false });
    expect(controller.limitFor("route-a")).toBe(150);
  });

  it("coalesces only a short burst without holding effect rows in memory", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AdaptiveEffectBatchController({ coalesceWindowMs: 500 });
      controller.beginDispatch("route-a", 1_000);
      const wait = controller.waitForCoalescing(1_100);
      await vi.advanceTimersByTimeAsync(400);
      await expect(wait).resolves.toBe(400);
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws AdaptiveBatchOptionsError with code for invalid limits", () => {
    try {
      new AdaptiveEffectBatchController({ minimum: 20, maximum: 5 });
      expect.fail("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AdaptiveBatchOptionsError);
      expect((error as AdaptiveBatchOptionsError).code).toBe("adaptive_limit_order_invalid");
    }
  });
});
