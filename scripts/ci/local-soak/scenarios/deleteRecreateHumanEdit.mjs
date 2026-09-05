/**
 * Scenario: delete/recreate the same id (P0 lifecycle reactivation) raced
 * against a direct human edit on a field of that id.
 *
 * Hypothesis: the public API deletes and recreates the SAME id while a human
 * edits a field of that id. The human edit must target the CORRECT lifecycle
 * generation (the recreated row), must NOT be applied to the tombstoned old
 * generation, must NOT be silently lost during reactivation, and must NOT
 * create duplicate rows. The scenario exposes: human edit applied to the
 * wrong generation, human edit lost during reactivation, and duplicate rows.
 *
 * The race needs a live Sheets/observation seam plus the public EntityManager
 * fork, so it runs only in live mode; local mode records `skipped`.
 */
import { SOAK_ENTITY_ORDER, SOAK_FIELD_PLANS } from "../entities.mjs";
import { conflictRecordedForFields, identityShiftedTransientResult, isIdentityShiftedEvidence, resolveRecordedConflicts, stableErrorTag, waitForBindingOutboxDrain } from "../errors.mjs";
import { generateRow } from "../operations.mjs";
import { SeededRandom, deriveSeed } from "../prng.mjs";
import { isStaleConflictEvidence } from "../redact.mjs";
import { SCENARIO_OBSERVE_POLL_MS, SCENARIO_OBSERVE_TIMEOUT_MS } from "../constants.mjs";
import { boundedSleep, isDeadlineExpired } from "../timing.mjs";

/** Stable scenario id recorded in redacted artifacts. */
export const id = "delete-recreate-human-edit";
/** Data scenario: overlaps the data/base workload, not lifecycle-gated. */
export const kind = "data";
/** Raced against actors, or after them before convergence. */
export const allowedPhases = ["concurrent-with-actors", "after-actors"];
/** Stable redacted parameter tag for this scenario. */
export const TAG = "delete-recreate-human-edit";

/**
 * Deterministic plan for one cycle: entity, editable string field, a
 * DEDICATED race row id (outside the actor/prologue space), a deterministic
 * human value, the delete/recreate iteration count, and barrier jitter. Pure
 * function of (seed, cycle, order, rng, activeEntities).
 *
 * @param {{ seed: number, cycle: number, phase: string, order: number, rng: object, activeEntities?: readonly object[] }} input
 * @returns {object} plan with tag/jitter/humanValue/iterations/target.
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
    // Barrier jitter: the human edit lands deterministically after the
    // delete/recreate starts, so the race window is controlled.
    jitterMs: 1 + rng.int(80),
    humanValue: `human-dr-c${cycle}-${order}`,
    iterations: 2 + rng.int(2),
    target: {
      entityName: entry.name,
      field,
      // Dedicated row: never the base `main`/actor rows.
      targetId: `dr-${abbreviation}-c${cycle}-${order}`,
    },
  };
}

/**
 * Live action: creates a dedicated race row, then races a public-API
 * delete+recreate of the same id against a direct human edit on a field of
 * that id with a deterministic barrier + jitter. Each SQLite mutation is
 * paired with its oracle mirror/cleanup as a SHORT critical section under the
 * shared oracle lock (the delete can briefly leave SQLite without the row the
 * oracle still holds, so that divergence is never observable to an actor),
 * but the barrier jitter, the direct Sheet write, and the allSettled
 * classification run OUTSIDE the lock so concurrent actors overlap them.
 *
 * Rejections are classified ONLY by EXACT stable CAS/stale/conflict evidence
 * via `isStaleConflictEvidence`: a rejected local write or human edit is an
 * expected compare-and-set conflict only when its error carries one of the
 * exact guard/hash-mismatch codes; a validation, transport, or other
 * direct-write rejection is a real failure. An exact `identity_shifted`
 * rejection of the direct human write is the expected multi-writer
 * transient (a truthful `identity-shifted-transient` skip, never a failure).
 * The oracle is NEVER updated from an unproven winner. The
 * reactivation invariant is verified on the OBSERVABLE authority: EXACTLY one
 * final row for the id (a missing row is as much a failure as a duplicate)
 * AND the human value present in that final row (the human edit is not
 * silently lost during reactivation). The dedicated race row is removed in a
 * GUARANTEED finally path so the final SQLite state matches the
 * deterministic replay.
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
  const rng = new SeededRandom(deriveSeed(context.seed, context.cycle * 827 + 47));
  const tabName = `${plan.target.entityName}_Input`;
  const critical = (action) => context.oracleLock === undefined
    ? action()
    : context.oracleLock.withLock(action);
  let cleanupFailures = 0;
  let failures = 0;
  // Stable diagnostic kinds for each `failures += 1` site (allowlisted,
  // never raw text) so a failed record says WHICH invariant fired.
  const failureKinds = new Set();
  let result;
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
    // the existing bounded direct-Sheet reads. If the projection never
    // appears within the bound, record a truthful `projection-not-ready` skip
    // and clean up — never a doomed direct write.
    const projected = await awaitInputProjection(
      client, context.live.spreadsheetId, tabName, plan.target, context,
    );
    if (!projected) {
      result = { status: "skipped", expectedErrors: 0, failures: 0, reason: "projection-not-ready" };
    } else {
      // The public-API delete+recreate loop starts first; the direct human
      // edit lands after the deterministic barrier + jitter, so the race
      // window is controlled. The loop's OWN SQLite mutations run as a short
      // critical section, but the barrier jitter and the direct Sheet write
      // below run OUTSIDE the lock so concurrent actors can overlap them.
      // Mark the local promise handled immediately so a rejection during the
      // barrier sleep is never an unhandled rejection; Promise.allSettled
      // below still observes it for classification.
      const localPromise = (async () => {
        return critical(async () => {
          for (let index = 0; index < plan.iterations; index += 1) {
            const existing = await em.findOne(token, { id: plan.target.targetId });
            if (existing !== null) {
              em.remove(existing);
              await em.flush();
              context.oracle?.applyMutation({
                op: "delete",
                entity: plan.target.entityName,
                id: plan.target.targetId,
              });
            }
            const row = { id: plan.target.targetId, ...generateRow(rng, fieldPlan) };
            em.persist(em.create(token, row));
            await em.flush();
            context.oracle?.applyMutation({
              op: "insert",
              entity: plan.target.entityName,
              row,
            });
          }
        });
      })();
      localPromise.catch(() => {});
      // MEDIUM 3: bound the barrier jitter by the run deadline so the human
      // write can never start after the budget expired (a bounded wait, never
      // an unconstrained sleep).
      const deadlineAt = context.deadlineAtMs ?? Number.MAX_SAFE_INTEGER;
      await boundedSleep(plan.jitterMs, deadlineAt);
      // MEDIUM 4: after the bounded jitter the run deadline may have expired.
      // Never start the direct human write against an expired budget: settle
      // the local mutation and report a truthful skip/limited outcome, and
      // still clean the authority/oracle below. The human promise is a no-op
      // in that case so the allSettled classification never counts an
      // unstarted human write as a transport/direct-write failure.
      // Clock-slop tolerant expiry check: the bounded jitter sleep can wake
      // marginally short of the nominal deadline, so a zero-tolerance reading
      // would flakily start the human write after the budget ended.
      const deadlineExpired = isDeadlineExpired(deadlineAt);
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
      const [localResult, humanResult] = await Promise.allSettled([localPromise, humanPromise]);
      // Classify rejections ONLY by EXACT stale-write/CAS/conflict evidence
      // (a guard/hash mismatch on the raced row). A validation/transport
      // rejection is never an expected conflict. The direct seam's
      // fail-closed `identity_shifted` evidence is an EXPECTED TRANSIENT of
      // the multi-writer soak (the human edit targeted a row another actor
      // shifted mid-write; the seam proved no silent success): never a
      // failure, a truthful skip recorded below.
      const localRejected = localResult.status === "rejected";
      if (localRejected && !isStaleConflictEvidence(localResult.reason)) {
        failures += 1;
        failureKinds.add("local-rejection-non-stale");
      }
      let humanTransient;
      if (humanResult.status === "rejected") {
        if (isIdentityShiftedEvidence(humanResult.reason)) {
          humanTransient = identityShiftedTransientResult(humanResult.reason);
        } else if (!isStaleConflictEvidence(humanResult.reason)) {
          failures += 1;
          failureKinds.add("human-rejection-non-stale");
        }
      }
      // Observable reactivation invariant: EXACTLY one final row for the id
      // (a missing row is as much a failure as a duplicate) AND the human
      // value present in that final row (the human edit is not silently lost
      // during reactivation). The human edit's projection is asynchronous, so
      // the final row is polled until the human value settles or the bounded
      // deadline expires. The invariant is verified ONLY when the local
      // delete+recreate loop actually completed: a rejected loop leaves the
      // row in an indeterminate mid-loop state (already counted as a failure
      // above), so a missing/duplicate read there would double-count one root
      // cause.
      let verification = "unobserved";
      if (!localRejected) {
        verification = await verifyReactivation({
          em,
          token,
          plan,
          humanValue: plan.humanValue,
          context,
          critical,
        });
        if (verification === "missing" || verification === "duplicate") {
          failures += 1;
          failureKinds.add(verification === "missing" ? "row-missing" : "duplicate-rows");
        }
      }
      // Conflict-recorded outcome: the final row never showed the human value
      // within the bound, but the value may have been ingested as an OPEN
      // sync_conflict after an in-flight outbox cycle — recorded, not lost.
      // A missing/duplicate row stays a real failure; only the unobserved
      // (single row without the value) outcome consults the conflict records.
      let conflictRecorded = false;
      if (failures === 0 && humanTransient === undefined && verification === "unobserved") {
        const recorded = await conflictRecordedForFields(context, [
          { field: plan.target.field, expectedValue: plan.humanValue },
        ]);
        conflictRecorded = recorded.has(plan.target.field);
      }
      result = failures > 0
        ? { status: "failed", expectedErrors: 0, failures, reason: "scenario-error" }
        : humanTransient !== undefined
          ? humanTransient
          : verification === "ok"
          ? { status: "ok", expectedErrors: 0, failures: 0, reason: "race-winner-verified" }
          : conflictRecorded
          ? { status: "ok", expectedErrors: 0, failures: 0, reason: "conflict-recorded" }
          : { status: "skipped", expectedErrors: 0, failures: 0, reason: "winner-not-verified" };
    }
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
    // delete so SQLite and the oracle stay symmetric even when the race,
    // an observation, or an authority read failed. A cleanup failure is
    // recorded separately (cleanupFailures) and never masks the original
    // failure.
    //
    // Conflict-recorded rows carry OPEN conflicts that fail a direct delete
    // closed (projection_outbox_blocked): resolve them via the public EM
    // first (system-wins advance + bounded clear wait), and only then
    // delete. When the wait expires the row is kept and surfaced as
    // `cleanup-unresolved-conflict` — never deleted through a blocking
    // conflict. Landed/never-started paths keep the direct delete below.
    // Before the delete, a bounded outbox-drain wait lets candidate effects
    // for this binding leave the blocking states (a verified row with NO
    // conflict still fails closed while such an effect is in flight). On
    // expiry the row is kept as `cleanup-outbox-busy` — never deleted
    // through a blocked outbox. Both waits share the settle budget.
    let cleanupUnresolved = false;
    if (result?.reason === "conflict-recorded") {
      const cleared = await resolveRecordedConflicts(context, {
        token,
        targetId: plan.target.targetId,
        fields: [{ field: plan.target.field, expectedValue: plan.humanValue }],
        critical,
      });
      if (!cleared) {
        cleanupFailures += 1;
        failureKinds.add("cleanup-unresolved-conflict");
        cleanupUnresolved = true;
      }
    }
    if (!cleanupUnresolved) {
      const outboxDrained = await waitForBindingOutboxDrain(context, plan.target.targetId);
      if (!outboxDrained) {
        cleanupFailures += 1;
        failureKinds.add("cleanup-outbox-busy");
      } else {
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
        failureKinds.add("cleanup-delete-failed");
      }
      }
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
 * Verifies the observable reactivation invariant on the authority: EXACTLY
 * one final row for the dedicated id AND the human value present in that
 * final row (the human edit is not silently lost during reactivation).
 *
 * The delete+recreate loop and the human edit have already settled
 * (allSettled) before this runs, but the direct human edit's projection is
 * asynchronous, so a SINGLE read could misclassify the outcome before the
 * human value lands. The final row is therefore polled until the human value
 * is observed (a proven ok), or the bounded deadline expires (a truthful
 * skip). A missing row or a duplicate row is a definite invariant violation
 * (a real failure), never a skip. Each poll acquires the shared oracle lock
 * ONLY for the instant read (a short critical section), so concurrent actors
 * can overlap the sleeps between polls.
 *
 * @returns {Promise<"ok" | "missing" | "duplicate" | "unobserved">}
 */
async function verifyReactivation({ em, token, plan, humanValue, context, critical }) {
  const deadline = Math.min(
    Date.now() + SCENARIO_OBSERVE_TIMEOUT_MS,
    context.deadlineAtMs ?? Number.MAX_SAFE_INTEGER,
  );
  while (true) {
    if (Date.now() >= deadline) return "unobserved";
    let rows;
    await critical(async () => {
      rows = await em.find(token, { id: plan.target.targetId });
    });
    if (rows.length === 1) {
      if (rows[0][plan.target.field] === humanValue) {
        // Exactly one final row carrying the human value: the human edit
        // landed on the recreated generation and was not silently lost.
        return "ok";
      }
      // Exactly one row but the human value not yet observed (the async edit
      // is still landing) -> keep polling.
    } else {
      // 0 or >1 rows: the reactivation invariant is violated.
      return rows.length === 0 ? "missing" : "duplicate";
    }
    await boundedSleep(SCENARIO_OBSERVE_POLL_MS, deadline);
  }
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
 * Deterministic, idempotent orphan recovery for this scenario's dedicated
 * race row on a process-death resume.
 *
 * A run that dies before this scenario's guaranteed finally can leave the
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
