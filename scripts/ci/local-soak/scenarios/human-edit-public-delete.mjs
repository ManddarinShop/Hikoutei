/**
 * Scenario: a direct human edit raced against a public-API delete of the
 * same row.
 *
 * Hypothesis: a human edits a field of a row, then the public API deletes
 * that row. The delete must win cleanly — the human edit is correctly
 * discarded or recorded as a conflict, the row is NEVER resurrected, and no
 * stale projection is left behind. The scenario exposes: a human edit that
 * resurrects a deleted row, a delete-aware baseline that mishandles the
 * identity shift, and a stale projection.
 *
 * The race needs a live Sheets/observation seam plus the public EntityManager
 * fork, so it runs only in live mode; local mode records `skipped`.
 */
import { SOAK_ENTITY_ORDER, SOAK_FIELD_PLANS } from "../entities.mjs";
import { generateRow } from "../operations.mjs";
import { SeededRandom, deriveSeed } from "../prng.mjs";
import { isStaleConflictEvidence } from "../redact.mjs";
import { SCENARIO_OBSERVE_POLL_MS, SCENARIO_OBSERVE_TIMEOUT_MS, SCENARIO_RACE_WINNER_SETTLE_OBSERVATIONS } from "../constants.mjs";
import { boundedSleep } from "../timing.mjs";

/** Stable scenario id recorded in redacted artifacts. */
export const id = "human-edit-public-delete";
/** Data scenario: overlaps the data/base workload, not lifecycle-gated. */
export const kind = "data";
/** Raced against actors, or after them before convergence. */
export const allowedPhases = ["concurrent-with-actors", "after-actors"];
/** Stable redacted parameter tag for this scenario. */
export const TAG = "human-edit-public-delete";

/**
 * Deterministic plan for one cycle: entity, editable string field, a
 * DEDICATED race row id (outside the actor/prologue space, so the race
 * never destabilizes the harness oracle's base rows), a deterministic human
 * value, and barrier jitter. Pure function of (seed, cycle, order, rng,
 * activeEntities).
 *
 * @param {{ seed: number, cycle: number, phase: string, order: number, rng: object, activeEntities?: readonly object[] }} input
 * @returns {object} plan with tag/jitter/humanValue/target.
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
  const fieldPlan = SOAK_FIELD_PLANS[entry.name];
  const editable = Object.entries(fieldPlan).filter(([name, spec]) => !spec.primary && spec.type === "string");
  const [field] = editable.length > 0
    ? editable[rng.int(editable.length)]
    : Object.entries(fieldPlan).find(([name, spec]) => !spec.primary) ?? ["id", {}];
  const abbreviation = entry.name.replace(/^Soak/, "").toLowerCase();
  return {
    tag: TAG,
    // Barrier jitter: the direct human edit lands deterministically after
    // the public delete starts, so the race window is controlled.
    jitterMs: 1 + rng.int(80),
    humanValue: `human-delete-c${cycle}-${order}`,
    target: {
      entityName: entry.name,
      field,
      // Dedicated row: never the base `main`/actor rows.
      targetId: `hd-${abbreviation}-c${cycle}-${order}`,
    },
  };
}

/**
 * Live action: creates a dedicated race row, then races a direct human edit
 * against a public-API delete of the same row with a deterministic barrier +
 * jitter. The delete's OWN SQLite mutation runs as a short critical section
 * under the shared oracle lock (so a concurrent actor never sees the race
 * row present in SQLite but stale in the oracle), but the barrier jitter, the
 * direct Sheet write, and the allSettled classification run OUTSIDE the lock
 * so concurrent actors overlap them.
 *
 * Rejections are classified ONLY by EXACT stable CAS/stale/conflict
 * evidence: a rejected delete (or human edit) is an expected compare-and-set
 * conflict only when its error carries one of the exact guard/hash-mismatch
 * codes; a validation, transport, direct-write, or `identity_shifted`
 * rejection is a real failure (an identity shift is the delete-aware baseline
 * mishandling this scenario hunts — a collateral write is never silently
 * accepted). The core invariant is that the delete WINS: the dedicated row
 * must be ABSENT from the authority after the race (never resurrected by the
 * human edit). The stale-projection residue is DEFERRED to the cycle's
 * convergence check (which already knows the id through the oracle and
 * excludes durable tombstones) — a single immediate projection read here
 * would be unsettled and is never judged. The dedicated row is removed in a
 * GUARANTEED finally path so the final SQLite state matches the deterministic
 * replay.
 *
 * @param {{ plan: object, context: object }} input plan + live context.
 * @returns {Promise<object>} { status, expectedErrors, failures, cleanupFailures?, reason? }.
 */
export async function execute({ plan, context }) {
  const client = context.live.client;
  const em = context.em.fork();
  const token = context.tokenByEntity.get(plan.target.entityName);
  const expected = new Set(context.activeEntities.map((entry) => entry.name));
  if (token === undefined || !expected.has(plan.target.entityName)) {
    return { status: "skipped", expectedErrors: 0, failures: 0, reason: "local-mode" };
  }
  const fieldPlan = SOAK_FIELD_PLANS[plan.target.entityName];
  const rng = new SeededRandom(deriveSeed(context.seed, context.cycle * 839 + 71));
  const tabName = `${plan.target.entityName}_Input`;
  const critical = (action) => context.oracleLock === undefined
    ? action()
    : context.oracleLock.withLock(action);
  let cleanupFailures = 0;
  let failures = 0;
  let result;
  // True once the public delete actually committed to SQLite AND was mirrored
  // into the oracle. Used to prove the delete won (only our committed delete
  // removes the dedicated row).
  let deleteCommitted = false;
  try {
    // Critical section: create the DEDICATED race row and mirror it into the
    // oracle atomically against concurrent actor verification. The row keeps
    // the base actor/prologue rows and the harness oracle's expected state
    // untouched.
    await critical(async () => {
      const row = { id: plan.target.targetId, ...generateRow(rng, fieldPlan) };
      em.persist(em.create(token, row));
      await em.flush();
      context.oracle?.applyMutation({ op: "insert", entity: plan.target.entityName, row });
    });

    // Bounded projection readiness: do NOT start the direct Sheet mutation
    // (the human edit) until the dedicated row's projection is observable via
    // the existing bounded direct-Sheet reads. The public delete is
    // independent of the projection and may proceed, but the human write
    // targets the projected row and must not begin against a not-yet-projected
    // row. If the projection never appears within the bound, record a
    // truthful `projection-not-ready` skip and clean up — never a doomed
    // direct write.
    const projected = await awaitInputProjection(
      client, context.live.spreadsheetId, tabName, plan.target, context,
    );
    if (!projected) {
      // The projection never became observable: never start a doomed direct
      // Sheet write. The dedicated row is cleaned up in the finally below.
      result = { status: "skipped", expectedErrors: 0, failures: 0, reason: "projection-not-ready" };
    } else {
      // The public delete starts first; the direct human edit lands after the
      // deterministic barrier + jitter, so the race window is controlled. The
      // delete's OWN SQLite mutation runs as a short critical section, but the
      // barrier jitter and the direct Sheet write below run OUTSIDE the lock
      // so concurrent actors can overlap them. Mark the delete promise handled
      // immediately so a rejection during the barrier sleep is never an
      // unhandled rejection; Promise.allSettled below still observes it for
      // classification.
      const deletePromise = (async () => {
        return critical(async () => {
          const current = await em.findOne(token, { id: plan.target.targetId });
          if (current === null) return;
          em.remove(current);
          await em.flush();
          // Mirror the committed delete before releasing the lock so the
          // oracle never lags the authority by this committed row.
          context.oracle?.applyMutation({
            op: "delete",
            entity: plan.target.entityName,
            id: plan.target.targetId,
          });
          deleteCommitted = true;
        });
      })();
      deletePromise.catch(() => {});
      // Bound the barrier jitter by the run deadline so the human write can
      // never start after the budget expired (a bounded wait, never an
      // unconstrained sleep).
      const deadlineAt = context.deadlineAtMs ?? Number.MAX_SAFE_INTEGER;
      await boundedSleep(plan.jitterMs, deadlineAt);
      // After the bounded jitter the run deadline may have expired. Never
      // start the direct human write against an expired budget: settle the
      // delete and report a truthful skip/limited outcome, and still clean the
      // authority/oracle below. The human promise is a no-op in that case so
      // the allSettled classification never counts an unstarted human write as
      // a transport/direct-write failure.
      const deadlineExpired = Date.now() >= deadlineAt;
      const humanPromise = deadlineExpired
        ? Promise.resolve(undefined)
        : client.mutateInputCell({
            spreadsheetId: context.live.spreadsheetId,
            tabName,
            identity: plan.target.targetId,
            headerName: plan.target.field,
            value: plan.humanValue,
            deadlineAtMs: context.deadlineAtMs,
          });
      const [deleteResult, humanResult] = await Promise.allSettled([deletePromise, humanPromise]);
      // Classify rejections ONLY by EXACT stale-write/CAS/conflict evidence
      // (a guard/hash mismatch on the raced row). A validation/transport/
      // direct-write/`identity_shifted` rejection is never an expected
      // conflict — an identity shift is the delete-aware baseline mishandling
      // this scenario hunts (a collateral write is never silently accepted).
      if (deleteResult.status === "rejected" && !isStaleConflictEvidence(deleteResult.reason)) {
        failures += 1;
      }
      if (humanResult.status === "rejected" && !isStaleConflictEvidence(humanResult.reason)) {
        failures += 1;
      }
      // Core invariant: the delete must WIN — the dedicated row must STAY
      // ABSENT from the authority across the settle threshold. The sync
      // worker applies the direct human edit asynchronously, so a SINGLE
      // immediate read could report ok before a late edit resurrects the
      // deleted row. The bounded settled polling below closes that race: a
      // row that reappears in a later poll (resurrection) is a failure, and
      // a row that is never absent means the delete never won (also a
      // failure).
      const verdict = await verifyStaysAbsent({ em, token, plan, context, critical });
      if (verdict === "resurrected" || verdict === "never-absent") failures += 1;
      // The stale-projection residue is deferred to the cycle's convergence
      // check (which excludes durable tombstones); a single immediate
      // projection read here would be unsettled and is never judged. The
      // authority invariant (row stays absent = delete wins) is verified above.
      result = failures > 0
        ? { status: "failed", expectedErrors: 0, failures, reason: "scenario-error" }
        : { status: "ok", expectedErrors: 0, failures: 0, reason: "projection-residue-deferred" };
    }
  } catch (error) {
    result = { status: "failed", expectedErrors: 0, failures: 1, reason: "scenario-error" };
  } finally {
    // Guaranteed cleanup: remove the dedicated race row and mirror the
    // delete so SQLite and the oracle stay symmetric even when the race, an
    // observation, or an authority read failed. A cleanup failure is recorded
    // separately (cleanupFailures) and never masks the original failure.
    try {
      await critical(async () => {
        const rows = await em.find(token, { id: plan.target.targetId });
        for (const raceRow of rows) {
          em.remove(raceRow);
        }
        await em.flush();
        context.oracle?.applyMutation({ op: "delete", entity: plan.target.entityName, id: plan.target.targetId });
      });
    } catch {
      cleanupFailures += 1;
    }
  }
  if (cleanupFailures > 0) {
    // A cleanup failure is a real failure: the original status is preserved
    // in `reason` while the failure counter grows by the cleanup failures.
    return {
      status: "failed",
      expectedErrors: result?.expectedErrors ?? 0,
      failures: (result?.failures ?? 0) + cleanupFailures,
      cleanupFailures,
      reason: result?.reason ?? "scenario-error",
    };
  }
  return { ...result, cleanupFailures: 0 };
}

/**
 * Reads the display value of one field cell of the dedicated race row
 * through the direct-Sheet read seam.
 *
 * Returns `undefined` when the row's projection (or the header) is not yet
 * present in the tab, so callers can distinguish "not projected yet" from a
 * real empty cell.
 *
 * @returns {Promise<string | undefined>}
 */
async function readInputCell(client, spreadsheetId, tabName, target, context) {
  const rows = await client.readTabRows(spreadsheetId, tabName, {
    deadlineAtMs: context.deadlineAtMs,
  });
  const headers = rows[0] ?? [];
  const idColumn = headers.indexOf("id");
  const fieldColumn = headers.indexOf(target.field);
  if (idColumn < 0 || fieldColumn < 0) return undefined;
  const cells = rows.find((entry, index) => index > 0 && entry[idColumn] === target.targetId);
  if (cells === undefined) return undefined;
  return cells[fieldColumn] ?? "";
}

/**
 * Bounded projection readiness: polls the direct-Sheet read seam until the
 * dedicated race row's projection is observable in the _Input tab.
 *
 * The human write's direct mutation seam requires the identity row to already
 * exist in the tab; the row is created in the authority and projected by the
 * sync worker asynchronously. Returns `true` once the row is visible, or
 * `false` when it never appears within the bounded window (the caller records
 * a truthful `projection-not-ready` skip and never starts a doomed direct
 * Sheet write).
 *
 * @returns {Promise<boolean>}
 */
async function awaitInputProjection(client, spreadsheetId, tabName, target, context) {
  const deadline = Math.min(
    Date.now() + SCENARIO_OBSERVE_TIMEOUT_MS,
    context.deadlineAtMs ?? Number.MAX_SAFE_INTEGER,
  );
  while (true) {
    if (Date.now() >= deadline) return false;
    const value = await readInputCell(client, spreadsheetId, tabName, target, context);
    if (value !== undefined) return true;
    await boundedSleep(SCENARIO_OBSERVE_POLL_MS, deadline);
  }
}

/**
 * Verifies the delete-wins invariant: the dedicated row must STAY ABSENT
 * from the authority across the settle-threshold of consecutive separated
 * reads.
 *
 * The sync worker applies the direct human edit asynchronously, so a single
 * immediate authority read could report ok before a late edit resurrects the
 * deleted row. This bounded poll converges that race: once the row is ABSENT
 * across `SCENARIO_RACE_WINNER_SETTLE_OBSERVATIONS` consecutive separated
 * reads the delete is confirmed to have won (`absent`); if the row reappears
 * after being absent (a late human edit resurrected it) it returns
 * `resurrected`; if the row is never absent by the deadline the delete never
 * won (`never-absent`). Each poll acquires the shared oracle lock ONLY for
 * the instant read (a short critical section), so concurrent actors overlap
 * the sleeps between polls.
 *
 * @returns {Promise<"absent" | "resurrected" | "never-absent">}
 */
async function verifyStaysAbsent({ em, token, plan, context, critical }) {
  const deadline = Math.min(
    Date.now() + SCENARIO_OBSERVE_TIMEOUT_MS,
    context.deadlineAtMs ?? Number.MAX_SAFE_INTEGER,
  );
  let absentStreak = 0;
  let sawAbsent = false;
  while (true) {
    if (Date.now() >= deadline) return sawAbsent ? "resurrected" : "never-absent";
    let absent = false;
    await critical(async () => {
      const rows = await em.find(token, { id: plan.target.targetId });
      absent = rows.length === 0;
    });
    if (absent) {
      sawAbsent = true;
      absentStreak += 1;
      if (absentStreak >= SCENARIO_RACE_WINNER_SETTLE_OBSERVATIONS) return "absent";
    } else {
      // The row reappeared after being absent -> a late human edit
      // resurrected the deleted row.
      if (sawAbsent) return "resurrected";
      absentStreak = 0;
    }
    await boundedSleep(SCENARIO_OBSERVE_POLL_MS, deadline);
  }
}

/**
 * Deterministic, idempotent orphan recovery for this scenario's dedicated
 * race row on a process-death resume.
 *
 * A run that dies before this scenario's guaranteed finally can leave the
 * deterministic dedicated `targetId` row in the authority; the resume replay
 * deterministic dedicated `targetId` row in the authority; the resume replay
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
  const token = context.tokenByEntity.get(plan.target.entityName);
  const active = new Set(context.activeEntities.map((entry) => entry.name));
  if (token === undefined || !active.has(plan.target.entityName)) return { removed: 0 };
  const em = context.em.fork();
  const rows = await em.find(token, { id: plan.target.targetId });
  let removed = 0;
  for (const row of rows) {
    em.remove(row);
    removed += 1;
  }
  if (removed > 0) await em.flush();
  return { removed };
}
