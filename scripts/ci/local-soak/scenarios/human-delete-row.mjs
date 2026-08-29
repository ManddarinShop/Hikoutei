/**
 * Scenario: a human deletes a row from User_Input while the public API
 * updates that same row.
 *
 * Hypothesis: SQLite is the authority and User_Input is an asynchronous
 * human-facing projection, so a human deleting a row from the Sheet MUST NOT
 * destroy the authority row. The public API update of that same row must
 * still apply to the authority, and the row must be RETAINED in SQLite even
 * though its projection row was removed from the Sheet. The scenario exposes
 * authority data loss (the human sheet delete wrongly erases the SQLite row)
 * or a public update that fails to apply to the retained authority row.
 *
 * The race needs a live Sheets/observation seam plus the public EntityManager
 * fork, so it runs only in live mode; local mode records `skipped`.
 */
import { SOAK_ENTITY_ORDER, SOAK_FIELD_PLANS } from "../entities.mjs";
import { generateRow } from "../operations.mjs";
import { SeededRandom, deriveSeed } from "../prng.mjs";
import { isStaleConflictEvidence } from "../redact.mjs";
import { SCENARIO_OBSERVE_POLL_MS, SCENARIO_OBSERVE_TIMEOUT_MS, SCENARIO_RACE_WINNER_SETTLE_OBSERVATIONS } from "../constants.mjs";
import { boundedSleep, isDeadlineExpired } from "../timing.mjs";

/** Stable scenario id recorded in redacted artifacts. */
export const id = "human-delete-row";
/** Data scenario: overlaps the data/base workload, not lifecycle-gated. */
export const kind = "data";
/** Raced against actors, or after them before convergence. */
export const allowedPhases = ["concurrent-with-actors", "after-actors"];
/** Stable redacted parameter tag for this scenario. */
export const TAG = "human-delete-row";

/**
 * Deterministic plan for one cycle: entity, editable string field, a
 * DEDICATED row id (outside the actor/prologue space, so the race never
 * destabilizes the harness oracle's base rows), a deterministic public-update
 * value, and barrier jitter. Pure function of (seed, cycle).
 *
 * @param {{ seed: number, cycle: number, phase: string, order: number, rng: object, activeEntities?: readonly object[] }} input
 * @returns {object} plan with tag/jitter/updateValue/target.
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
    // Barrier jitter: the human delete lands deterministically after the
    // public update starts, so the race window is controlled.
    jitterMs: 1 + rng.int(80),
    // Deterministic public-update value the public API writes to the row.
    updateValue: `hdel-update-c${cycle}-${order}`,
    target: {
      entityName: entry.name,
      field,
      // Dedicated row: never the base `main`/actor rows.
      targetId: `hdel-${abbreviation}-c${cycle}-${order}`,
    },
  };
}

/**
 * Live action: creates a dedicated row, then races a public-API update of
 * that row against a direct human row delete on the same id with a
 * deterministic barrier + jitter. Each SQLite mutation is paired with its
 * oracle mirror/cleanup as a SHORT critical section under the shared oracle
 * lock, but the barrier jitter, the direct Sheet delete, and the allSettled
 * classification run OUTSIDE the lock so concurrent actors overlap them.
 *
 * Rejections are classified ONLY by EXACT stable stale/CAS/conflict
 * evidence: a rejected public update is an expected stale-write compare-and-
 * set conflict only when its error carries one of the exact guard/hash-
 * mismatch codes; a validation, transport, or direct-write rejection is a
 * real failure. A rejected human delete is expected only on the same exact
 * CAS/stale evidence; any other delete rejection (including the direct
 * client's `identity_shifted` fail-closed guard) is a real failure. The
 * oracle is NEVER updated from an unproven winner — the dedicated row is
 * removed (in a guaranteed finally path) so the final SQLite state matches
 * the deterministic replay.
 *
 * After the race settles, the scenario verifies the authority-retention
 * invariant: SQLite is the authority, so the human sheet delete must NOT
 * erase the authority row. The dedicated row must be RETAINED in the
 * authority, and the public update must apply to it (the row reflects the
 * update value). Authority data loss (the row disappears from SQLite) or a
 * public update that never lands on the retained row is a real failure.
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
  const rng = new SeededRandom(deriveSeed(context.seed, context.cycle * 839 + 61));
  const tabName = `${plan.target.entityName}_Input`;
  const critical = (action) => context.oracleLock === undefined
    ? action()
    : context.oracleLock.withLock(action);
  let cleanupFailures = 0;
  let failures = 0;
  let result;
  try {
    // Critical section: create the DEDICATED row and mirror it into the
    // oracle atomically against concurrent actor verification. The row keeps
    // the base actor/prologue rows and the harness oracle's expected state
    // untouched.
    await critical(async () => {
      const row = { id: plan.target.targetId, ...generateRow(rng, fieldPlan) };
      em.persist(em.create(token, row));
      await em.flush();
      context.oracle?.applyMutation({ op: "insert", entity: plan.target.entityName, row });
    });

    // Bounded projection readiness: do NOT start the direct Sheet delete
    // (the human delete) until the dedicated row's projection is observable
    // via the existing bounded direct-Sheet reads. If the projection never
    // appears within the bound, record a truthful `projection-not-ready`
    // skip and clean up — never a doomed direct delete.
    const projected = await awaitInputProjection(
      client, context.live.spreadsheetId, tabName, plan.target, context,
    );
    if (!projected) {
      result = { status: "skipped", expectedErrors: 0, failures: 0, reason: "projection-not-ready" };
    } else {
      // The public update starts first; the direct human delete lands after
      // the deterministic barrier + jitter, so the race window is controlled.
      // The public update's OWN SQLite mutation runs as a short critical
      // section, but the barrier jitter and the direct Sheet delete below run
      // OUTSIDE the lock so concurrent actors can overlap them. Mark the
      // public promise handled immediately so a rejection during the barrier
      // sleep is never an unhandled rejection; Promise.allSettled below still
      // observes it for classification.
      const updateValue = plan.updateValue;
      const publicPromise = (async () => {
        return critical(async () => {
          const current = await em.findOne(token, { id: plan.target.targetId });
          if (current === null) return;
          current[plan.target.field] = updateValue;
          await em.flush();
          // Mirror the committed public update into the oracle BEFORE
          // releasing the shared lock, so a concurrent actor verifying
          // against the oracle never sees the race row present in SQLite
          // but stale in the oracle (a stale-oracle comparison).
          context.oracle?.applyMutation({
            op: "update",
            entity: plan.target.entityName,
            id: plan.target.targetId,
            patch: { [plan.target.field]: updateValue },
          });
        });
      })();
      publicPromise.catch(() => {});
      // MEDIUM 3: bound the barrier jitter by the run deadline so the human
      // delete can never start after the budget expired (a bounded wait,
      // never an unconstrained sleep).
      const deadlineAt = context.deadlineAtMs ?? Number.MAX_SAFE_INTEGER;
      await boundedSleep(plan.jitterMs, deadlineAt);
      // MEDIUM 4: after the bounded jitter the run deadline may have expired.
      // Never start the direct human delete against an expired budget: settle
      // the public update and report a truthful skip/limited outcome, and
      // still clean the authority/oracle below. The human promise is a no-op
      // in that case so the allSettled classification never counts an
      // unstarted human delete as a transport/direct-write failure.
      // Clock-slop tolerant expiry check: the bounded jitter sleep can wake
      // marginally short of the nominal deadline, so a zero-tolerance reading
      // would flakily start the human delete after the budget ended.
      const deadlineExpired = isDeadlineExpired(deadlineAt);
      const humanPromise = deadlineExpired
        ? Promise.resolve(undefined)
        : client.deleteInputRow({
            spreadsheetId: context.live.spreadsheetId,
            tabName,
            identity: plan.target.targetId,
            deadlineAtMs: context.deadlineAtMs,
          });
      const [publicResult, humanResult] = await Promise.allSettled([publicPromise, humanPromise]);
      // Classify rejections ONLY by EXACT stale-write/CAS/conflict evidence
      // (a guard/hash mismatch on the raced row). A validation/transport/
      // direct-write rejection — including the direct client's
      // `identity_shifted` fail-closed guard — is never an expected conflict.
      if (publicResult.status === "rejected" && !isStaleConflictEvidence(publicResult.reason)) {
        failures += 1;
      }
      if (humanResult.status === "rejected" && !isStaleConflictEvidence(humanResult.reason)) {
        failures += 1;
      }
      // Verify the authority-retention invariant: SQLite is the authority,
      // so a human deleting the row from the Sheet projection MUST NOT erase
      // the SQLite row. The dedicated row must be retained in the authority
      // AND reflect the public update. Authority data loss (the row vanishes
      // from SQLite) or a public update that never lands on the retained row
      // is a real failure.
      const verdict = await verifyAuthorityRetained({
        em, token, plan, context, critical,
      });
      if (verdict === "lost") failures += 1;
      if (verdict === "unobserved") failures += 1;
      result = failures > 0
        ? { status: "failed", expectedErrors: 0, failures, reason: "scenario-error" }
        : verdict === "retained"
          ? { status: "ok", expectedErrors: 0, failures: 0, reason: "race-winner-verified" }
          : { status: "skipped", expectedErrors: 0, failures: 0, reason: "winner-not-verified" };
    }
  } catch (error) {
    result = { status: "failed", expectedErrors: 0, failures: 1, reason: "scenario-error" };
  } finally {
    // Guaranteed cleanup: remove the dedicated row and mirror the delete so
    // SQLite and the oracle stay symmetric even when the race, an
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
 * Verifies the authority-retention invariant after the race settles.
 *
 * Polls the public authority (EntityManager) for the dedicated row. SQLite is
 * the authority, so the row MUST be retained in SQLite even though the human
 * removed its projection row from the Sheet. Returns `retained` once the row
 * is present AND reflects the public update value across the settle-threshold
 * of consecutive separated reads; `lost` if the row ever becomes ABSENT from
 * the authority (a human sheet delete that erased the SQLite row — authority
 * data loss); `unobserved` if no state settled before the deadline.
 *
 * Each poll acquires the shared oracle lock ONLY for the instant read (a
 * short critical section), so concurrent actors can overlap the sleeps
 * between polls.
 *
 * @returns {Promise<"retained" | "lost" | "unobserved">}
 */
async function verifyAuthorityRetained({ em, token, plan, context, critical }) {
  const deadline = Math.min(
    Date.now() + SCENARIO_OBSERVE_TIMEOUT_MS,
    context.deadlineAtMs ?? Number.MAX_SAFE_INTEGER,
  );
  let retainedStreak = 0;
  while (true) {
    if (Date.now() >= deadline) return retainedStreak > 0 ? "retained" : "unobserved";
    let row = null;
    await critical(async () => {
      row = await em.findOne(token, { id: plan.target.targetId });
    });
    if (row === null) return "lost";
    // The public update applies to the retained authority row: the row's
    // editable field reflects the public update value.
    const landed = String(row[plan.target.field] ?? "") === String(plan.updateValue);
    if (landed) {
      retainedStreak += 1;
      if (retainedStreak >= SCENARIO_RACE_WINNER_SETTLE_OBSERVATIONS) return "retained";
    } else {
      retainedStreak = 0;
    }
    await boundedSleep(SCENARIO_OBSERVE_POLL_MS, deadline);
  }
}

/**
 * Reads the display value of one field cell of the dedicated row through the
 * direct-Sheet read seam.
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
 * dedicated row's projection is observable in the _Input tab.
 *
 * The human delete's direct mutation seam requires the identity row to
 * already exist in the tab; the row is created in the authority and projected
 * by the sync worker asynchronously. Returns `true` once the row is visible,
 * or `false` when it never appears within the bounded window (the caller
 * records a truthful `projection-not-ready` skip and never starts a doomed
 * direct Sheet delete).
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
 * row on a process-death resume.
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
