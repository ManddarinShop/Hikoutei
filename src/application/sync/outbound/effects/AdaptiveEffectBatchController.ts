/** Adaptive route batch sizing for the durable outbound effect worker. */

export const ADAPTIVE_EFFECT_BATCH_LIMITS = {
  MINIMUM: 5,
  INITIAL: 10,
  MAXIMUM: 20,
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
    this.minimum = requireBatchLimit(options.minimum ?? ADAPTIVE_EFFECT_BATCH_LIMITS.MINIMUM, "minimum");
    this.initial = requireBatchLimit(options.initial ?? ADAPTIVE_EFFECT_BATCH_LIMITS.INITIAL, "initial");
    this.maximum = requireBatchLimit(options.maximum ?? ADAPTIVE_EFFECT_BATCH_LIMITS.MAXIMUM, "maximum");
    if (this.minimum > this.initial || this.initial > this.maximum) {
      throw new RangeError("adaptive effect batch limits must satisfy minimum <= initial <= maximum");
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

  /** Marks a route dispatch so the next selection can coalesce a short burst. */
  public beginDispatch(routeKey: string, now: number = Date.now()): number {
    this.routeState(routeKey);
    this.lastDispatchAt = now;
    return this.limitFor(routeKey);
  }

  /** Updates only the process-local limit from the completed Gateway attempt. */
  public observe(routeKey: string, observation: AdaptiveEffectBatchObservation): void {
    const state = this.routeState(routeKey);
    const unhealthy = observation.responseLoss ||
      !observation.responseSucceeded ||
      observation.durationMs > this.highLatencyThresholdMs;
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
   * Regular applyEffects dispatch never waits on this throttle; when the
   * interval is 0 (direct workers and fake gateways) this returns immediately.
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

function requireBatchLimit(value: number, label: string): number {
  return requirePositiveInteger(value, label);
}

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`adaptive ${label} must be a positive safe integer`);
  return value;
}

function requireNonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`adaptive ${label} must be a non-negative safe integer`);
  return value;
}
