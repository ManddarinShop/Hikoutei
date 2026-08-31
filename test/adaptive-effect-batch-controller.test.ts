import { describe, expect, it, vi } from "vitest";

import {
  AdaptiveBatchOptionsError,
  AdaptiveEffectBatchController,
} from "@hikoutei/ikisaki";

describe("adaptive effect batch controller", () => {
  it("starts at fifty-one, halves unhealthy routes, and grows stable routes", () => {
    const controller = new AdaptiveEffectBatchController({ coalesceWindowMs: 0 });

    expect(controller.limitFor("route-a")).toBe(100);
    controller.observe("route-a", {
      durationMs: 31_000,
      responseSucceeded: true,
      responseLoss: false,
    });
    expect(controller.limitFor("route-a")).toBe(50);

    controller.observe("route-a", { durationMs: 100, responseSucceeded: true, responseLoss: false });
    controller.observe("route-a", { durationMs: 100, responseSucceeded: true, responseLoss: false });
    controller.observe("route-a", { durationMs: 100, responseSucceeded: true, responseLoss: false });
    expect(controller.limitFor("route-a")).toBe(55);
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
