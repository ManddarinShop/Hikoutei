/**
 * Scenario: rapidly delete/recreate the same id.
 *
 * Hypothesis: deleting and recreating the same primary id in quick
 * succession must project exactly one final row with no stale/tombstone
 * residue or extra-row duplication. The scenario exposes stale rows,
 * tombstone leaks, or extra projection rows for the recreated id.
 *
 * The action uses only the public EntityManager; the projection observation
 * uses the direct-Sheet seam, so it runs only in live mode.
 */
import { SOAK_ENTITY_ORDER, SOAK_FIELD_PLANS } from "../entities.mjs";
import { stableErrorTag } from "../errors.mjs";
import { generateRow } from "../operations.mjs";
import { SeededRandom, deriveSeed } from "../prng.mjs";
import { sleep } from "../timing.mjs";

/** Stable scenario id recorded in redacted artifacts. */
export const id = "delete-recreate-race";
/** Data scenario: overlaps the data/base workload, not lifecycle-gated. */
export const kind = "data";
/** Raced against actors, or after them before convergence. */
export const allowedPhases = ["concurrent-with-actors", "after-actors"];
/** Stable redacted parameter tag for this scenario. */
export const TAG = "delete-recreate-race";

/**
 * Deterministic plan for one cycle: entity, a dedicated race id, and the
 * delete/recreate iteration count. Pure function of (seed, cycle).
 *
 * @param {{ seed: number, cycle: number, phase: string, order: number, rng: object, activeEntities?: readonly object[] }} input
 * @returns {object} plan with tag/jitter/raceId/iterations.
 */
export function plan({ cycle, order, rng, activeEntities }) {
  // MEDIUM 2: the plan's target entity must be in the ACTIVE subset (a
  // --tables run activates only some entities), so a plan never points at an
  // inactive entity. Falls back to the full entity order when no subset is
  // given (full run / standalone tests). Same (seed, cycle, subset)
  // reproduces the same plan; a different subset may differ.
  const pool = activeEntities !== undefined && activeEntities.length > 0
    ? activeEntities
    : SOAK_ENTITY_ORDER;
  const entry = pool[rng.int(pool.length)];
  const abbreviation = entry.name.replace(/^Soak/, "").toLowerCase();
  return {
    tag: TAG,
    jitterMs: 1 + rng.int(50),
    // A dedicated id outside the actor/prologue space, deterministic per
    // (seed, cycle): never a raw or secret value.
    raceId: `race-${abbreviation}-c${cycle}-${order}`,
    iterations: 2 + rng.int(2),
    entityName: entry.name,
  };
}

/**
 * Live action: rapidly deletes and recreates the dedicated race id through
 * the public EntityManager, mirroring each committed mutation into the
 * harness oracle under the SHARED oracle lock so concurrent actor
 * verification never observes an intermediate delete/recreate state. It
 * then verifies the OBSERVABLE authority invariant (EXACTLY one row for
 * the id — a missing row is as much a failure as a duplicate). The
 * projection residue (stale/tombstone/duplicate rows in the System tab) is
 * DEFERRED to the cycle's convergence check, which already knows the id
 * through the oracle and excludes durable tombstones — a single immediate
 * projection read here would be unsettled and is never judged. The
 * dedicated race row is removed in a GUARANTEED finally path so the final
 * SQLite state matches the deterministic replay.
 *
 * @param {{ plan: object, context: object }} input plan + live context.
 * @returns {Promise<object>} { status, expectedErrors, failures, cleanupFailures?, reason? }.
 */
export async function execute({ plan, context }) {
  const em = context.em.fork();
  const token = context.tokenByEntity.get(plan.entityName);
  const expected = new Set(context.activeEntities.map((entry) => entry.name));
  if (token === undefined || !expected.has(plan.entityName)) {
    return { status: "skipped", expectedErrors: 0, failures: 0, reason: "local-mode" };
  }
  const fieldPlan = SOAK_FIELD_PLANS[plan.entityName];
  const rng = new SeededRandom(deriveSeed(context.seed, context.cycle * 811 + 29));
  const critical = (action) => context.oracleLock === undefined
    ? action()
    : context.oracleLock.withLock(action);
  let failures = 0;
  let cleanupFailures = 0;
  // Stable diagnostic kinds for the row-count invariant check (allowlisted,
  // never raw text) so a failed record says WHICH invariant fired.
  const failureKinds = new Set();
  let result;
  try {
    for (let index = 0; index < plan.iterations; index += 1) {
      // Each flush + oracle mirror pair is atomic under the shared lock so
      // an actor never sees the dedicated row in only one store. The
      // deterministic jitter between iterations stays outside the lock.
      await critical(async () => {
        const existing = await em.findOne(token, { id: plan.raceId });
        if (existing !== null) {
          em.remove(existing);
          await em.flush();
          context.oracle?.applyMutation({ op: "delete", entity: plan.entityName, id: plan.raceId });
        }
        const row = { id: plan.raceId, ...generateRow(rng, fieldPlan) };
        em.persist(em.create(token, row));
        await em.flush();
        context.oracle?.applyMutation({ op: "insert", entity: plan.entityName, row });
      });
      if (plan.jitterMs > 0) {
        // Deterministic short pause between delete and recreate cycles.
        await sleep(plan.jitterMs);
      }
    }
    // Observable authority invariant: EXACTLY one row for the race id after
    // the delete/recreate. A MISSING row (lost by the projection/authority)
    // is as much a failure as a duplicate — the delete/recreate must leave
    // exactly one final row.
    const rows = await em.find(token, { id: plan.raceId });
    failures = rows.length !== 1 ? 1 : 0;
    if (rows.length === 0) failureKinds.add("row-missing");
    else if (rows.length > 1) failureKinds.add("duplicate-rows");
    result = {
      status: failures > 0 ? "failed" : "ok",
      expectedErrors: 0,
      failures,
      reason: "projection-residue-deferred",
    };
  } catch (error) {
    result = {
      status: "failed",
      expectedErrors: 0,
      failures: 1,
      reason: "scenario-error",
      reasonTag: stableErrorTag(error),
    };
  } finally {
    // Guaranteed cleanup: remove the dedicated race row and mirror the
    // delete so SQLite and the oracle stay symmetric even when the loop or
    // an authority read failed. A cleanup failure is recorded separately
    // (cleanupFailures) and never masks the original failure.
    try {
      await critical(async () => {
        const rows = await em.find(token, { id: plan.raceId });
        for (const raceRow of rows) {
          em.remove(raceRow);
        }
        await em.flush();
        context.oracle?.applyMutation({ op: "delete", entity: plan.entityName, id: plan.raceId });
      });
    } catch {
      cleanupFailures += 1;
      failureKinds.add("cleanup-delete-failed");
    }
  }
  const kinds = [...failureKinds].sort();
  if (cleanupFailures > 0) {
    return {
      status: "failed",
      expectedErrors: result?.expectedErrors ?? 0,
      failures: (result?.failures ?? 0) + cleanupFailures,
      cleanupFailures,
      reason: result?.reason ?? "scenario-error",
      ...(result?.reasonTag !== undefined ? { reasonTag: result.reasonTag } : {}),
      ...(kinds.length > 0 ? { failureKinds: kinds } : {}),
    };
  }
  return {
    ...result,
    cleanupFailures: 0,
    ...(kinds.length > 0 ? { failureKinds: kinds } : {}),
  };
}

/**
 * Deterministic, idempotent orphan recovery for this scenario's dedicated
 * race row on a process-death resume.
 *
 * A run that dies before this scenario's guaranteed finally can leave the
 * deterministic dedicated `raceId` row in the authority; the resume replay
 * would reject it as a foreign id. This hook removes that exact planned row
 * (and only it) through the public EntityManager, so a resume of an
 * interrupted in-flight cycle never fails the DB proof over an orphan. It is
 * derived solely from the persisted seed/cycle plan (same inputs -> same
 * orphan id), is idempotent (removing a missing row is a no-op), and is
 * restart-safe. Never touches internal storage/outbox.
 *
 * @param {{ plan: object, context: object }} input the deterministic plan
 *   and a recovery context exposing the public seams (`em`, `tokenByEntity`,
 *   `activeEntities`).
 * @returns {Promise<{ removed: number }>}
 */
export async function recover({ plan, context }) {
  const token = context.tokenByEntity.get(plan.entityName);
  const active = new Set(context.activeEntities.map((entry) => entry.name));
  if (token === undefined || !active.has(plan.entityName)) return { removed: 0 };
  const em = context.em.fork();
  const rows = await em.find(token, { id: plan.raceId });
  let removed = 0;
  for (const row of rows) {
    em.remove(row);
    removed += 1;
  }
  if (removed > 0) await em.flush();
  return { removed };
}
