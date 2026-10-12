/**
 * Tests for the adaptive effect batch controller that sizes per-route outbound batches.
 *
 * Covers the starting limit, halving on unhealthy (high-latency) observations, growth on
 * consecutive healthy observations, short-burst coalescing without buffering effect rows in
 * memory, and constructor validation that rejects an inverted minimum/maximum with a coded error.
 */

import { describe, expect, it, vi } from "vitest";

import {
  AdaptiveBatchOptionsError,
  AdaptiveEffectBatchController,
} from "@hikoutei/ikisaki";

// Covers adaptive effect batch controller.
describe("adaptive effect batch controller", () => {
  // Verifies starts at one hundred, halves unhealthy routes, and grows stable routes.
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

  // Verifies coalesces only a short burst without holding effect rows in memory.
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

  // Verifies throws AdaptiveBatchOptionsError with code for invalid limits.
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
