/** Adaptive route batch sizing for the durable outbound effect worker. */

import {
  ADAPTIVE_BATCH_ERROR_CODES,
  AdaptiveBatchOptionsError,
} from "../errors.js";

export const ADAPTIVE_EFFECT_BATCH_LIMITS = {
  MINIMUM: 5,
  INITIAL: 100,
  MAXIMUM: 300,
} as const;

export const DEFAULT_EFFECT_BATCH_COALESCE_WINDOW_MS = 500;
export const EFFECT_BATCH_HIGH_LATENCY_THRESHOLD_MS = 30_000;
export const EFFECT_BATCH_STABLE_SUCCESSES_TO_GROW = 3;
export const EFFECT_BATCH_GROWTH_STEP = 5;
export interface AdaptiveEffectBatchObservation {
  readonly durationMs: number;
  readonly responseSucceeded: boolean;
  readonly responseLoss: boolean;
}

interface RouteState {
  limit: number;
  stableSuccesses: number;
}
/**
 * Keeps a small, process-local batch policy while SQLite remains the durable
 * queue. A failed or slow route backs off without changing effect evidence;
 * repeated healthy responses grow the route back toward the safe maximum.
 */
export class AdaptiveEffectBatchController {
  private readonly minimum: number;
  private readonly maximum: number;
  private readonly initial: number;
  private readonly coalesceWindowMs: number;
  private readonly highLatencyThresholdMs: number;
  private readonly stableSuccessesToGrow: number;
  private readonly growthStep: number;
  private readonly appendDispatchIntervalMs: number;
  private readonly routes = new Map<string, RouteState>();
  /** Pending read-ahead preflight latency per route, added to the next write observation. */
  private readonly routeReadMs = new Map<string, number>();
  private lastDispatchAt: number | undefined;
  private lastAppendDispatchAt: number | undefined;

  public constructor(options: {
    readonly minimum?: number;
    readonly initial?: number;
    readonly maximum?: number;
    readonly coalesceWindowMs?: number;
    readonly highLatencyThresholdMs?: number;
    readonly stableSuccessesToGrow?: number;
    readonly growthStep?: number;
    /** Minimum interval between fast-append request starts; 0 disables the throttle. */
    readonly appendDispatchIntervalMs?: number;
  } = {}) {
    this.minimum = requirePositiveInteger(options.minimum ?? ADAPTIVE_EFFECT_BATCH_LIMITS.MINIMUM, "minimum");
    this.initial = requirePositiveInteger(options.initial ?? ADAPTIVE_EFFECT_BATCH_LIMITS.INITIAL, "initial");
    this.maximum = requirePositiveInteger(options.maximum ?? ADAPTIVE_EFFECT_BATCH_LIMITS.MAXIMUM, "maximum");
    if (this.minimum > this.initial || this.initial > this.maximum) {
      throw new AdaptiveBatchOptionsError(ADAPTIVE_BATCH_ERROR_CODES.LIMIT_ORDER_INVALID);
    }
    this.coalesceWindowMs = requireNonNegativeInteger(
      options.coalesceWindowMs ?? DEFAULT_EFFECT_BATCH_COALESCE_WINDOW_MS,
      "coalesceWindowMs",
    );
    this.highLatencyThresholdMs = requirePositiveInteger(
      options.highLatencyThresholdMs ?? EFFECT_BATCH_HIGH_LATENCY_THRESHOLD_MS,
      "highLatencyThresholdMs",
    );
    this.stableSuccessesToGrow = requirePositiveInteger(
      options.stableSuccessesToGrow ?? EFFECT_BATCH_STABLE_SUCCESSES_TO_GROW,
      "stableSuccessesToGrow",
    );
    this.growthStep = requirePositiveInteger(
      options.growthStep ?? EFFECT_BATCH_GROWTH_STEP,
      "growthStep",
    );
    this.appendDispatchIntervalMs = requireNonNegativeInteger(
      options.appendDispatchIntervalMs ?? 0,
      "appendDispatchIntervalMs",
    );
  }

  /** Returns the current route limit without touching durable effect state. */
  public limitFor(routeKey: string): number {
    return this.routeState(routeKey).limit;
  }

  /**
   * Read-only snapshot of the current per-route limits (telemetry only).
   *
   * Never creates route state and never changes policy: an untouched route
   * is simply absent from the snapshot. The returned object is a copy, so
   * mutating it cannot affect the controller.
   */
  public limitsSnapshot(): Record<string, number> {
    const snapshot: Record<string, number> = {};
    for (const [routeKey, state] of this.routes) snapshot[routeKey] = state.limit;
    return snapshot;
  }

  /** Marks a route dispatch so the next selection can coalesce a short burst. */
  public beginDispatch(routeKey: string, now: number = Date.now()): number {
    this.routeState(routeKey);
    this.lastDispatchAt = now;
    return this.limitFor(routeKey);
  }

  /** Updates only the process-local limit from the completed provider attempt. */
  public observe(routeKey: string, observation: AdaptiveEffectBatchObservation): void {
    const state = this.routeState(routeKey);
    // A read-ahead preflight runs before the write it feeds; fold its latency
    // into the dispatch total so a slow read cannot hide behind a fast write
    // and falsely grow the batch limit.
    const accumulatedReadMs = this.routeReadMs.get(routeKey) ?? 0;
    this.routeReadMs.delete(routeKey);
    const durationMs = observation.durationMs + accumulatedReadMs;
    const unhealthy = observation.responseLoss ||
      !observation.responseSucceeded ||
      durationMs > this.highLatencyThresholdMs;
    if (unhealthy) {
      state.limit = Math.max(this.minimum, Math.floor(state.limit / 2));
      state.stableSuccesses = 0;
      return;
    }
    state.stableSuccesses += 1;
    if (state.stableSuccesses >= this.stableSuccessesToGrow) {
      state.limit = Math.min(this.maximum, state.limit + this.growthStep);
      state.stableSuccesses = 0;
    }
  }

  /**
   * Records one read-ahead preflight outcome for a route.
   *
   * A failed preflight backs the route off immediately (a read that keeps
   * failing must not let later write successes grow the limit). A successful
   * preflight accumulates its latency so the next write observation includes
   * it; a slow read then contributes to backoff instead of being masked.
   */
  public observePreflight(
    routeKey: string,
    observation: { readonly durationMs: number; readonly succeeded: boolean },
  ): void {
    const state = this.routeState(routeKey);
    if (!observation.succeeded) {
      state.limit = Math.max(this.minimum, Math.floor(state.limit / 2));
      state.stableSuccesses = 0;
      return;
    }
    this.routeReadMs.set(routeKey, (this.routeReadMs.get(routeKey) ?? 0) + observation.durationMs);
  }

  /**
   * Drops a route's buffered read-ahead latency when a prepared unit is
   * abandoned before its write (e.g. fence/authority loss after the read).
   *
   * `observePreflight` folds the read latency into the NEXT write observation
   * for the route. If that prepared unit is dropped before any write runs, the
   * buffered latency would otherwise stay charged to a future write that never
   * produced that read. Settling it here keeps the next genuine write's timing
   * honest without backing the route off for a read whose write never
   * happened.
   */
  public abandonPreflight(routeKey: string): void {
    this.routeReadMs.delete(routeKey);
  }

  /** Waits at most the configured short coalescing window before selection. */
  public async waitForCoalescing(now: number = Date.now()): Promise<number> {
    if (this.lastDispatchAt === undefined || this.coalesceWindowMs === 0) return 0;
    const remaining = this.lastDispatchAt + this.coalesceWindowMs - now;
    if (remaining <= 0) return 0;
    await new Promise<void>((resolve) => setTimeout(resolve, remaining));
    return remaining;
  }

  /**
   * Records the start of one fast-append request so the next append request
   * waits only the remaining throttle interval. The marker is process-local
   * and survives supervisor passes because the controller outlives one pass.
   */
  public beginAppendDispatch(now: number = Date.now()): void {
    this.lastAppendDispatchAt = now;
  }

  /**
   * Waits only the time remaining since the last fast-append request started.
   * Regular apply dispatch never waits on this throttle; when the interval is
   * 0 (direct workers and fake dispatchers) this returns immediately.
   */
  public async waitForAppendThrottle(now: number = Date.now()): Promise<number> {
    if (this.appendDispatchIntervalMs === 0 || this.lastAppendDispatchAt === undefined) {
      return 0;
    }
    const remaining = this.lastAppendDispatchAt + this.appendDispatchIntervalMs - now;
    if (remaining <= 0) return 0;
    await new Promise<void>((resolve) => setTimeout(resolve, remaining));
    return remaining;
  }

  private routeState(routeKey: string): RouteState {
    const existing = this.routes.get(routeKey);
    if (existing !== undefined) return existing;
    const state: RouteState = { limit: this.initial, stableSuccesses: 0 };
    this.routes.set(routeKey, state);
    return state;
  }
}

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AdaptiveBatchOptionsError(ADAPTIVE_BATCH_ERROR_CODES.POSITIVE_INTEGER_REQUIRED, label);
  }
  return value;
}

function requireNonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AdaptiveBatchOptionsError(ADAPTIVE_BATCH_ERROR_CODES.NON_NEGATIVE_INTEGER_REQUIRED, label);
  }
  return value;
}
