/**
 * Scenario: local write raced against a direct human edit on the same id.
 *
 * Hypothesis: a public-API local update/delete of the same id/field raced
 * with a direct human edit (deterministic barrier + jitter) must never
 * silently lose the human value, loop forever retrying, or produce
 * duplicates. The scenario exposes silent loss, endless retry, or duplicate
 * projection rows.
 *
 * The race needs a live Sheets/observation seam plus the public EntityManager
 * fork, so it runs only in live mode; local mode records `skipped`.
 */
import { SOAK_ENTITY_ORDER, SOAK_FIELD_PLANS } from "../entities.mjs";
import { identityShiftedTransientResult, isIdentityShiftedEvidence, stableErrorTag } from "../errors.mjs";
import { generateRow } from "../operations.mjs";
import { SeededRandom, deriveSeed } from "../prng.mjs";
import { isStaleConflictEvidence } from "../redact.mjs";
import { SCENARIO_OBSERVE_POLL_MS, SCENARIO_OBSERVE_TIMEOUT_MS, SCENARIO_RACE_WINNER_SETTLE_OBSERVATIONS } from "../constants.mjs";
import { boundedSleep, isDeadlineExpired } from "../timing.mjs";

/** Stable scenario id recorded in redacted artifacts. */
export const id = "local-human-write-race";
/** Data scenario: overlaps the data/base workload, not lifecycle-gated. */
export const kind = "data";
/** Raced against actors, or after them before convergence. */
export const allowedPhases = ["concurrent-with-actors", "after-actors"];
/** Stable redacted parameter tag for this scenario. */
export const TAG = "local-vs-human-race";

const WORDS = Object.freeze(["amber", "basalt", "cobalt", "dune", "ember", "fjord", "garnet", "indigo"]);

/**
 * Deterministic plan for one cycle: entity, editable string field, a
 * DEDICATED race row id (outside the actor/prologue space, so the race
 * never destabilizes the harness oracle's base rows), race variant and
 * barrier jitter. Pure function of (seed, cycle).
 *
 * @param {{ seed: number, cycle: number, phase: string, order: number, rng: object, activeEntities?: readonly object[] }} input
 * @returns {object} plan with tag/jitter/race/target.
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
    // local write starts, so the race window is controlled.
    jitterMs: 1 + rng.int(80),
    race: rng.chance(0.5) ? "update" : "delete",
    humanValue: `human-race-c${cycle}-${order}`,
    target: {
      entityName: entry.name,
      field,
      // Dedicated row: never the base `main`/actor rows.
      targetId: `local-race-${abbreviation}-c${cycle}-${order}`,
    },
  };
}

/**
 * Live action: creates a dedicated race row, then races a public-API local
 * mutation against a direct human edit on the same id/field with a
 * deterministic barrier + jitter. Each SQLite mutation is paired with its
 * oracle mirror/cleanup as a SHORT critical section under the shared oracle
 * lock (the local delete can briefly leave SQLite without the row the oracle
 * still holds, so that divergence is never observable to an actor), but the
 * barrier jitter, the direct Sheet write, and the allSettled classification
 * run OUTSIDE the lock so concurrent actors overlap them. The dedicated row's
 * SQLite mutations and its oracle mirror/cleanup run atomically against
 * concurrent actor verification.
 *
 * Rejections are classified ONLY by EXACT stable CAS/stale/conflict
 * evidence: a rejected local write is an expected stale-write compare-and-
 * set conflict only when its error carries one of the exact guard/hash-
 * mismatch codes; a validation, transport, or direct-write rejection is a
 * real failure. A rejected delete human edit is expected only on the same
 * exact CAS/stale evidence (the edit targeted a row the local delete
 * already removed); any other delete rejection is a real failure. The
 * oracle is NEVER updated from an unproven winner — the dedicated race row
 * is removed (in a guaranteed finally path) so the final SQLite state
 * matches the deterministic replay.
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
  // never raw text); recorded on the result as `failureKinds` so a
  // `scenario-error` record says WHICH invariant fired.
  const failureKinds = new Set();
  let result;
  // True once the local mutation (update or delete) actually committed to
  // SQLite AND was mirrored into the oracle. Used by the winner resolution
  // to prove a delete winner (only our committed delete removes the row).
  let localCommitted = false;
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

    // Bounded projection readiness (finding 2): do NOT start the direct Sheet
    // mutation (the human edit) until the dedicated row's projection is
    // observable via the existing bounded direct-Sheet reads. The local
    // SQLite mutation is independent of the projection and may proceed, but
    // the human write targets the projected row and must not begin against a
    // not-yet-projected row. If the projection never appears within the bound,
    // record a truthful `projection-not-ready` skip and clean up — never a
    // doomed direct write.
    const projected = await awaitInputProjection(
      client, context.live.spreadsheetId, tabName, plan.target, context,
    );
    if (!projected) {
      // The projection never became observable: never start a doomed direct
      // Sheet write. The dedicated row is cleaned up in the finally below.
      result = { status: "skipped", expectedErrors: 0, failures: 0, reason: "projection-not-ready" };
    } else {
      // Local mutation starts first; the direct human edit lands after the
    // deterministic barrier + jitter, so the race window is controlled. The
    // local mutation's OWN SQLite mutation runs as a short critical section,
    // but the barrier jitter and the direct Sheet write below run OUTSIDE the
    // lock so concurrent actors can overlap them. Mark the local promise
    // handled immediately so a rejection during the barrier sleep is never an
    // unhandled rejection; Promise.allSettled below still observes it for
    // classification.
    const localValue = `local-${context.cycle}`;
    const localPromise = (async () => {
      return critical(async () => {
        const current = await em.findOne(token, { id: plan.target.targetId });
        if (current === null) return;
        if (plan.race === "update") {
          current[plan.target.field] = localValue;
          await em.flush();
          // Mirror the committed local update into the oracle BEFORE
          // releasing the shared lock, so a concurrent actor verifying
          // against the oracle never sees the race row present in SQLite
          // but stale in the oracle (a stale-oracle comparison).
          context.oracle?.applyMutation({
            op: "update",
            entity: plan.target.entityName,
            id: plan.target.targetId,
            patch: { [plan.target.field]: localValue },
          });
          localCommitted = true;
        } else {
          em.remove(current);
          await em.flush();
          // Mirror the committed local delete before releasing the lock so
          // the oracle never lags the authority by this committed row.
          context.oracle?.applyMutation({
            op: "delete",
            entity: plan.target.entityName,
            id: plan.target.targetId,
          });
          localCommitted = true;
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
    // Never start the direct human write against an expired budget: settle the
    // local mutation and report a truthful skip/limited outcome, and still
    // clean the authority/oracle below. The human promise is a no-op in that
    // case so the allSettled classification never counts an unstarted human
    // write as a transport/direct-write failure.
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
    // rejection is a real failure. The direct seam's fail-closed
    // `identity_shifted` evidence is an EXPECTED TRANSIENT of the
    // multi-writer soak (never counted as a failure): the seam proved no
    // silent success and the race outcome is unobservable, so the scenario
    // records a truthful skip below.
    if (localResult.status === "rejected" && !isStaleConflictEvidence(localResult.reason)) {
      failures += 1;
      failureKinds.add("local-rejection-non-stale");
    }
    let humanTransient;
    if (humanResult.status === "rejected") {
      if (isIdentityShiftedEvidence(humanResult.reason)) {
        humanTransient = identityShiftedTransientResult(humanResult.reason);
      } else if (plan.race === "update") {
        // A rejected direct human write on an update race is a real
        // transport/direct-write failure, never expected.
        failures += 1;
        failureKinds.add("human-write-rejected");
      } else if (!isStaleConflictEvidence(humanResult.reason)) {
        // On a delete race the human edit may target a row the local
        // delete already removed — only exact CAS/stale evidence is
        // expected; any other delete rejection is a real failure.
        failures += 1;
        failureKinds.add("human-rejection-non-stale");
      }
    }
    // Resolve the ACTUAL public-authority winner with a bounded observation
    // of the dedicated row, and reconcile the oracle to the PROVEN winner —
    // never from an assumed/unproven human edit. The winner is whichever
    // value the authority committed after both the local mutation and the
    // human edit settled. Only a concrete observed value (or a provably
    // committed delete) is a proven winner; anything else reports a truthful
    // skipped/limited outcome.
    const winner = await resolveRaceWinner({
      em,
      token,
      plan,
      localValue,
      humanValue: plan.humanValue,
      localCommitted,
      context,
      critical,
    });
    // Observable invariant: no duplicate rows for the race id (the race
    // must never produce duplicate projection rows).
    const rows = await em.find(token, { id: plan.target.targetId });
    if (rows.length > 1) {
      failures += 1;
      failureKinds.add("duplicate-rows");
    }
    // A proven winner (a concrete value in the authority, or a provably
    // committed delete) with no duplicates and no silent loss is a verified
    // ok; an unprovable winner is a truthful skip (never an unobserved ok).
    // An identity-shifted transient rejection outranks the ok/skip winner
    // verdict (a truthful transient skip), but NEVER outranks real failures
    // counted earlier in this cycle.
    result = failures > 0
      ? { status: "failed", expectedErrors: 0, failures, reason: "scenario-error" }
      : humanTransient !== undefined
        ? humanTransient
        : winner !== "unobserved"
        ? { status: "ok", expectedErrors: 0, failures: 0, reason: "race-winner-verified" }
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
  const kinds = [...failureKinds].sort();
  if (cleanupFailures > 0) {
    // A cleanup failure is a real failure: the original status is preserved
    // in `reason` while the failure counter grows by the cleanup failures.
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
 * Resolves the ACTUAL public-authority winner of the race via BOUNDED
 * deadline-aware polling of the dedicated row, and reconciles the oracle to
 * the PROVEN winner — never from an assumed/unproven human edit.
 *
 * Each poll acquires the shared oracle lock ONLY for the instant read (a
 * short critical section), so concurrent actors can overlap the sleeps
 * between polls. The field is compared to the two known candidates:
 *
 * - update race: field is the local value -> "local" won; field is the
 *   human value -> "human" won (proven by authority observation).
 * - delete race: the row is absent AND our delete provably committed
 *   (`localCommitted`) -> "delete" won; the row is present with the human
 *   value -> "human" won.
 *
 * The local transition has already settled (allSettled) before this runs, but
 * the direct human edit's projection is asynchronous, so a SINGLE read could
 * misclassify the winner before the human value lands — a delayed human value
 * that lands a moment after a premature "local" read is the exact race this
 * guard closes. The poll therefore requires the SAME observed winner across
 * `SCENARIO_RACE_WINNER_SETTLE_OBSERVATIONS` separated reads; if the observed
 * winner ever changes (local -> human as the delayed edit lands) the streak
 * resets and the later winner wins. If no single winner settles before the
 * deadline the caller records a truthful skip (never a premature local/delete
 * winner from one authority read). The oracle is reconciled ONLY once a
 * winner is settled (replace with the observed authority row, or delete), so
 * a transient early observation never mutates the oracle.
 *
 * @returns {Promise<"local" | "human" | "delete" | "unobserved">}
 */
async function resolveRaceWinner({ em, token, plan, localValue, humanValue, localCommitted, context, critical }) {
  const deadline = Math.min(
    Date.now() + SCENARIO_OBSERVE_TIMEOUT_MS,
    context.deadlineAtMs ?? Number.MAX_SAFE_INTEGER,
  );
  let lastWinner;
  let streak = 0;
  while (true) {
    if (Date.now() >= deadline) return "unobserved";
    let observedWinner = "unobserved";
    let observedRow;
    await critical(async () => {
      const row = await em.findOne(token, { id: plan.target.targetId });
      if (plan.race === "delete") {
        if (row === null) {
          // Row gone: only OUR committed delete removes the dedicated row.
          if (localCommitted) observedWinner = "delete";
          return;
        }
        if (row[plan.target.field] === humanValue) {
          observedWinner = "human";
          observedRow = row;
        }
        return;
      }
      // update race
      if (row === null) return;
      if (row[plan.target.field] === localValue) {
        observedWinner = "local";
        observedRow = row;
      } else if (row[plan.target.field] === humanValue) {
        observedWinner = "human";
        observedRow = row;
      }
    });
    if (observedWinner === "unobserved") {
      // A foreign/absent row: not evidence of any winner. Reset the streak so
      // a transient gap can never fabricate a settled winner.
      lastWinner = undefined;
      streak = 0;
    } else if (observedWinner === lastWinner) {
      streak += 1;
    } else {
      lastWinner = observedWinner;
      streak = 1;
    }
    // Only a winner seen on the settle-threshold of consecutive separated
    // reads is proven. The human value is the async edit landing, so once it
    // settles it is the winner; a local/delete winner is never reported from a
    // single read right after the Sheet write.
    if (streak >= SCENARIO_RACE_WINNER_SETTLE_OBSERVATIONS) {
      await critical(async () => {
        if (observedWinner === "delete") {
          context.oracle?.applyMutation({ op: "delete", entity: plan.target.entityName, id: plan.target.targetId });
        } else {
          context.oracle?.applyMutation({ op: "replace", entity: plan.target.entityName, id: plan.target.targetId, row: observedRow });
        }
      });
      return observedWinner;
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
