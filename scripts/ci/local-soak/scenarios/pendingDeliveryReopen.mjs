/**
 * Scenario: pending-delivery burst followed by close/reopen of the same
 * runtime/SQLite.
 *
 * Hypothesis: a burst of public writes whose outbound delivery is still
 * pending, followed by a close and reopen of the SAME runtime and SQLite
 * file, must preserve only public data and converge to the final Sheet
 * projection — never lose or duplicate the burst, and never surface
 * internal outbox state to the application.
 *
 * The burst and the public read-back use only the public EntityManager. The
 * close/reopen step requires a runtime-reopen seam owned by the runner
 * (closing and replacing the runtime mid-cycle changes the runner's runtime
 * ownership, which is internal orchestration). When the runner does not
 * provide that seam, the whole scenario is recorded as a genuine `skipped`
 * (non-mutating) with the stable `reopen-skipped` reason — it never creates
 * burst rows and never claims durability was verified.
 */
import { SOAK_ENTITY_ORDER } from "../entities.mjs";

/** Stable scenario id recorded in redacted artifacts. */
export const id = "pending-delivery-reopen";
/** Lifecycle scenario: must not overlap another lifecycle scenario. */
export const kind = "lifecycle";
/** Runs after actors before final convergence (owns the runtime window). */
export const allowedPhases = ["after-actors"];
/** Stable redacted parameter tag for this scenario. */
export const TAG = "pending-delivery-reopen";

/**
 * Deterministic plan for one cycle: entity and burst count. Pure function
 * of (seed, cycle).
 *
 * @param {{ seed: number, cycle: number, phase: string, order: number, rng: object, activeEntities?: readonly object[] }} input
 * @returns {object} plan with tag/jitter/burstCount/entityName.
 */
export function plan({ cycle, order, rng, activeEntities }) {
  // MEDIUM 2: the plan's target entity must be in the ACTIVE subset (a
  // --tables run activates only some entities), so a plan never points at an
  // inactive entity. Falls back to the full entity order when no subset is
  // given (full run / standalone tests).
  const pool = activeEntities !== undefined && activeEntities.length > 0
    ? activeEntities
    : SOAK_ENTITY_ORDER;
  const entry = pool[rng.int(pool.length)];
  return {
    tag: TAG,
    jitterMs: 1 + rng.int(40),
    burstCount: 8 + rng.int(9),
    entityName: entry.name,
    burstPrefix: `burst-c${cycle}-${order}`,
  };
}

/**
 * Live action: the full hypothesis is a pending-delivery burst followed by
 * a close/reopen of the SAME runtime and SQLite file. The close/reopen
 * step needs a runner-owned runtime-replacement seam (closing and replacing
 * the runtime mid-cycle is internal orchestration the scenario must not
 * own); the harness does not expose one in scenario scope, so the reopen
 * step — and therefore the whole scenario — is recorded as a genuine
 * `skipped` with the stable `reopen-skipped` reason. The action is
 * NON-MUTATING: it never creates burst rows, never touches SQLite, the
 * oracle, or any runtime state, and never claims durability was verified.
 * A stale manager is never reused after a close, and internal outbox state
 * is never read or written.
 *
 * @param {{ plan: object, context: object }} input the plan and the live
 *   execution context (public seams + direct client).
 * @returns {Promise<object>} { status, expectedErrors, failures, reason? }.
 */
export async function execute({ plan, context }) {
  const token = context.tokenByEntity.get(plan.entityName);
  const expected = new Set(context.activeEntities.map((entry) => entry.name));
  if (token === undefined || !expected.has(plan.entityName)) {
    return { status: "skipped", expectedErrors: 0, failures: 0, reason: "local-mode" };
  }
  // The close/reopen step cannot run without a runner-owned reopen seam,
  // so the whole scenario is skipped (non-mutating) with the stable reason.
  // No burst rows are created and no durability claim is made.
  return { status: "skipped", expectedErrors: 0, failures: 0, reason: "reopen-skipped" };
}
