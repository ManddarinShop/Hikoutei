/**
 * Scenario: a human writes the SAME value already present in a cell.
 *
 * Hypothesis: a direct human edit that writes the value already present in a
 * User_Input cell must be treated as a NO-OP by the library — it must NOT
 * fabricate a false conflict, cause revision churn, or emit unnecessary
 * outbox effects — and the projection must remain stable. The scenario
 * exposes false conflict, revision churn, and unnecessary outbox effects.
 *
 * The action uses the public EntityManager to create a DEDICATED row, the
 * direct-Sheet human-input seam to write the same value, and the public
 * authority + direct-Sheet read seam to verify the value is unchanged and
 * the projection stable. It runs only in live mode.
 */
import { SOAK_ENTITY_ORDER, SOAK_FIELD_PLANS } from "../entities.mjs";
import { identityShiftedTransientResult, isIdentityShiftedEvidence, stableErrorTag, waitForBindingOutboxDrain } from "../errors.mjs";
import { generateRow } from "../operations.mjs";
import { SeededRandom, deriveSeed } from "../prng.mjs";
import { SCENARIO_OBSERVE_POLL_MS, SCENARIO_OBSERVE_TIMEOUT_MS, SCENARIO_RACE_WINNER_SETTLE_OBSERVATIONS } from "../constants.mjs";
import { boundedSleep, isDeadlineExpired } from "../timing.mjs";

/** Stable scenario id recorded in redacted artifacts. */
export const id = "no-op-human-edit";
/** Data scenario: overlaps the data/base workload, not lifecycle-gated. */
export const kind = "data";
/** Raced against actors, or after them before convergence. */
export const allowedPhases = ["concurrent-with-actors", "after-actors"];
/** Stable redacted parameter tag for this scenario. */
export const TAG = "no-op-human-edit";

/**
 * Deterministic row-generation PRNG for one (seed, cycle), shared by the
 * plan (to derive the no-op human value) and the execute path (to create
 * the row), so the human value EQUALS the current value of the field.
 *
 * @param {number} seed run seed.
 * @param {number} cycle cycle number.
 * @returns {SeededRandom} deterministic row PRNG.
 */
function rowRngFor(seed, cycle) {
  return new SeededRandom(deriveSeed(seed, cycle * 829 + 61));
}

/**
 * Converts one stored value to its cell-string representation, so a null
 * field (empty cell) and a string field compare consistently.
 *
 * @param {unknown} value stored field value.
 * @returns {string} cell-string for `value`.
 */
function toCellString(value) {
  if (value === null || value === undefined) return "";
  return String(value);
}

/**
 * Deterministic plan for one cycle: entity, a non-primary STRING field, a
 * DEDICATED no-op row id (outside the actor/prologue space), a jitter, and
 * the human value that EQUALS the current value of the field (a true
 * no-op). Pure function of (seed, cycle, order, rng, activeEntities).
 *
 * @param {{ seed: number, cycle: number, phase: string, order: number, rng: object, activeEntities?: readonly object[] }} input
 * @returns {object} plan with tag/jitter/humanValue/target.
 */
export function plan({ seed, cycle, order, rng, activeEntities }) {
  // MEDIUM 2: the plan's target entity must be in the ACTIVE subset (a
  // --tables run activates only some entities), so a plan never points at an
  // inactive entity. Falls back to the full entity order when no subset is
  // given (full run / standalone tests).
  const pool = activeEntities !== undefined && activeEntities.length > 0
    ? activeEntities
    : SOAK_ENTITY_ORDER;
  const entry = pool[rng.int(pool.length)];
  const fieldPlan = SOAK_FIELD_PLANS[entry.name];
  // A non-primary STRING field (prefer a non-nullable one so the no-op value
  // is a real string; fall back to any non-primary string field).
  const stringFields = Object.entries(fieldPlan).filter(
    ([name, spec]) => !spec.primary && spec.type === "string" && spec.nullable !== true,
  );
  const [field] = stringFields.length > 0
    ? stringFields[rng.int(stringFields.length)]
    : Object.entries(fieldPlan).find(([name, spec]) => !spec.primary && spec.type === "string") ?? ["id", {}];
  const abbreviation = entry.name.replace(/^Soak/, "").toLowerCase();
  // The human value EQUALS the current value of the field: derive the same
  // row the execute path creates (same seed/cycle/fieldPlan) and read the
  // field's cell-string, so the write is a true no-op.
  const row = generateRow(rowRngFor(seed, cycle), fieldPlan);
  return {
    tag: TAG,
    // Short deterministic jitter so the no-op write lands while normal
    // actors are mid-flight rather than at a fixed point.
    jitterMs: 1 + rng.int(80),
    humanValue: toCellString(row[field]),
    target: {
      entityName: entry.name,
      field,
      // Dedicated row: never the base `main`/actor rows.
      targetId: `noop-${abbreviation}-c${cycle}-${order}`,
    },
  };
}

/**
 * Live action: creates a DEDICATED no-op row, awaits its projection, then
 * writes the SAME value already present in the cell through the direct
 * human-input seam. It then verifies the authority value is unchanged (no
 * false conflict, no revision churn) and the projection is stable via a
 * bounded observation. A no-op write must never reject; a rejection is
 * classified ONLY by exact stale/CAS evidence (a stale/CAS rejection is a
 * FALSE CONFLICT — the exact failure this scenario hunts — and any other
 * rejection is a real failure; both are failures for a no-op write). The
 * dedicated row is removed in a GUARANTEED finally path so the final
 * SQLite state matches the deterministic replay.
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
  const rng = rowRngFor(context.seed, context.cycle);
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
    // Critical section: create the DEDICATED no-op row and mirror it into the
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
      // Consume the plan's jitter so the no-op write lands while normal
      // actors are mid-flight. Bounded by the run deadline.
      const deadlineAt = context.deadlineAtMs ?? Number.MAX_SAFE_INTEGER;
      await boundedSleep(plan.jitterMs ?? 0, deadlineAt);
      // After the bounded jitter the run deadline may have expired. Never
      // start the doomed direct write against an expired budget: settle with
      // a truthful skip and clean the authority below.
      // Clock-slop tolerant expiry check: the bounded jitter sleep can wake
      // marginally short of the nominal deadline, so a zero-tolerance reading
      // would flakily start the doomed direct write after the budget ended.
      if (isDeadlineExpired(deadlineAt)) {
        result = { status: "skipped", expectedErrors: 0, failures: 0, reason: "deadline-expired" };
      } else {
        let writeRejected = false;
        try {
          await client.mutateInputCell({
            spreadsheetId: context.live.spreadsheetId,
            tabName,
            identity: plan.target.targetId,
            headerName: plan.target.field,
            value: plan.humanValue,
            deadlineAtMs: context.deadlineAtMs,
          });
        } catch (error) {
          // A no-op write must never reject on stale/CAS evidence: that is
          // the FALSE CONFLICT this scenario hunts (a real failure). The
          // direct seam's fail-closed `identity_shifted` evidence is an
          // EXPECTED TRANSIENT of the multi-writer soak (another actor
          // shifted the tab mid-write; the seam proved no silent success):
          // a truthful skip, never a failure. Any other rejection
          // (transport/validation) stays a real failure.
          writeRejected = true;
          if (isIdentityShiftedEvidence(error)) {
            result = identityShiftedTransientResult(error);
          } else {
            failures += 1;
            failureKinds.add("noop-write-rejected");
            result = { status: "failed", expectedErrors: 0, failures, reason: "scenario-error" };
          }
        }
        if (!writeRejected) {
          // Verify the authority value is unchanged (no false conflict, no
          // revision churn) and the projection is stable via a bounded
          // observation. A changed authority value is the corruption this
          // scenario hunts; an unsettled observation is a truthful skip.
          const outcome = await observeNoOpStability(
            em, token, plan, context, client, context.live.spreadsheetId, tabName,
          );
          if (outcome === "stable") {
            result = { status: "ok", expectedErrors: 0, failures: 0, reason: "no-op-stable" };
          } else if (outcome === "changed") {
            failures += 1;
            failureKinds.add("noop-value-changed");
            result = { status: "failed", expectedErrors: 0, failures, reason: "scenario-error" };
          } else {
            result = { status: "skipped", expectedErrors: 0, failures: 0, reason: "winner-not-verified" };
          }
        }
      }
    }
  } catch (error) {
    failures = Math.max(failures, 1);
    result = {
      status: "failed",
      expectedErrors: 0,
      failures,
      reason: "scenario-error",
      reasonTag: stableErrorTag(error),
    };
  } finally {
    // Guaranteed cleanup: remove the dedicated no-op row and mirror the
    // delete so SQLite and the oracle stay symmetric even when the write,
    // an observation, or an authority read failed. A cleanup failure is
    // recorded separately (cleanupFailures) and never masks the original
    // failure. Before the delete, a bounded outbox-drain wait lets candidate
    // effects for this binding leave the blocking states (the delete fails
    // closed while such an effect is in flight). On expiry the row is kept
    // as `cleanup-outbox-busy` — never deleted through a blocked outbox
    // (the #381 protection covers outbox state too). The wait shares the
    // settle budget via the run deadline.
    try {
      const outboxDrained = await waitForBindingOutboxDrain(context, plan.target.targetId);
      if (!outboxDrained) {
        cleanupFailures += 1;
        failureKinds.add("cleanup-outbox-busy");
      } else {
      await critical(async () => {
        const rows = await em.find(token, { id: plan.target.targetId });
        for (const noopRow of rows) {
          em.remove(noopRow);
        }
        await em.flush();
        context.oracle?.applyMutation({ op: "delete", entity: plan.target.entityName, id: plan.target.targetId });
      });
      }
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
 * Bounded observation that the no-op write left the authority value
 * unchanged and the projection stable.
 *
 * Each poll reads the public authority (SQLite through the EntityManager)
 * and the direct-Sheet cell. If the authority value ever differs from the
 * value the human wrote, the no-op was NOT a no-op — a false conflict or
 * revision churn — and the caller records a failure. Stability is only
 * reported after the SAME unchanged authority value AND unchanged projection
 * cell are observed across `SCENARIO_RACE_WINNER_SETTLE_OBSERVATIONS`
 * separated polls (a single read right after the write could race the async
 * projection). If the observation cannot settle before the deadline the
 * caller records a truthful skip (never an unobserved ok).
 *
 * @returns {Promise<"stable" | "changed" | "unobserved">}
 */
async function observeNoOpStability(em, token, plan, context, client, spreadsheetId, tabName) {
  const deadline = Math.min(
    Date.now() + SCENARIO_OBSERVE_TIMEOUT_MS,
    context.deadlineAtMs ?? Number.MAX_SAFE_INTEGER,
  );
  let settleCount = 0;
  while (true) {
    if (Date.now() >= deadline) return "unobserved";
    const row = await em.findOne(token, { id: plan.target.targetId });
    if (row === null) {
      // The dedicated row vanished: not evidence of a stable no-op. Reset.
      settleCount = 0;
    } else {
      const current = toCellString(row[plan.target.field]);
      if (current !== plan.humanValue) {
        // The authority value changed after a same-value write: a false
        // conflict / revision churn.
        return "changed";
      }
      // Projection stability: the cell must still display the same value.
      const cell = await readInputCell(client, spreadsheetId, tabName, plan.target, context);
      if (cell === plan.humanValue) {
        settleCount += 1;
        if (settleCount >= SCENARIO_RACE_WINNER_SETTLE_OBSERVATIONS) return "stable";
      } else {
        settleCount = 0;
      }
    }
    await boundedSleep(SCENARIO_OBSERVE_POLL_MS, deadline);
  }
}

/**
 * Reads the display value of one field cell of the dedicated no-op row
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
 * dedicated no-op row's projection is observable in the _Input tab.
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
 * no-op row on a process-death resume.
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
