import { describe, expect, it, vi } from "vitest";

import {
  AdaptiveEffectBatchController,
} from "@hikoutei/outbox";

describe("adaptive effect batch controller", () => {
  it("starts at ten, halves unhealthy routes, and grows stable routes", () => {
    const controller = new AdaptiveEffectBatchController({ coalesceWindowMs: 0 });

    expect(controller.limitFor("route-a")).toBe(10);
    controller.observe("route-a", {
      durationMs: 31_000,
      responseSucceeded: true,
      responseLoss: false,
    });
    expect(controller.limitFor("route-a")).toBe(5);

    controller.observe("route-a", { durationMs: 100, responseSucceeded: true, responseLoss: false });
    controller.observe("route-a", { durationMs: 100, responseSucceeded: true, responseLoss: false });
    controller.observe("route-a", { durationMs: 100, responseSucceeded: true, responseLoss: false });
    expect(controller.limitFor("route-a")).toBe(10);
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
});
