/**
 * Type declarations for `scripts/ci/local-soak/execute.mjs`.
 *
 * Hand-written ESM helper consumed by the soak runner and Vitest; these
 * declarations give the TypeScript test suite full type checking without
 * adding `scripts/**` to a `tsconfig` `include` set.
 */

/** Builds the abort summary for a cycle that ended in an unrecovered error. */
export function abortedCycleResult(
  cycle: number,
  error: unknown,
  hikoutei: unknown,
  partialScenarioRecords?: readonly Record<string, unknown>[],
): {
  hikoutei: unknown;
  reopened: false;
  summary: {
    durationMs: number;
    tablesTouched: readonly string[];
    operations: {
      total: number;
      ok: number;
      expectedErrors: number;
      failures: number;
      retries: number;
    };
    scenarioTotals: { expectedErrors: number; failures: number };
    scenarios?: readonly Record<string, unknown>[];
    abort: { reason: string; errorClass: string; code?: string };
  };
};

/**
 * Explicit abort envelope thrown by {@link runOneCycle}: carries the original
 * thrown value plus the partial scenario records collected before the abort.
 */
export class SoakCycleAbortError extends Error {
  constructor(cause: unknown, scenarioRecords: readonly object[]);
  cause: unknown;
  scenarioRecords: readonly object[];
}

/**
 * Unwraps an abort envelope back into the original error and its records.
 * A value that is not an envelope is returned as-is with no records.
 */
export function unwrapSoakAbort(caught: unknown): {
  original: unknown;
  records: readonly object[];
};

/**
 * Plans one cycle's full actor stream up front. The exact planning pass
 * the cycle executor uses, extracted so production, replay continuity,
 * and the actor-freeze tests exercise the same loop. On replay the stream
 * comes from the pure deterministic replay (`replayCycleOps`); otherwise
 * every op is planned against the given oracle state.
 */
export function planActorStream(input: {
  seed: number;
  cycle: number;
  options: { actors: number; operationsPerActor: number };
  activeEntities: readonly object[];
  oracle: object;
  reconcile: boolean;
  replayCycleOps?: Map<number, object[]>;
}): object[][];

/**
 * Settles one cycle's actor stream and its already-started concurrent
 * scenario phase. Every actor and the scenario phase settle; the first actor
 * rejection wins (a scenario-phase rejection is thrown only when no actor
 * rejected); fulfilled actors are consumed only on the success path.
 */
export function settleCycleWorkload(input: {
  actorTasks: readonly (Promise<object>)[];
  scenarioPhase: Promise<unknown>;
  consumeActor: (actor: object, index: number) => Promise<void>;
}): Promise<void>;
