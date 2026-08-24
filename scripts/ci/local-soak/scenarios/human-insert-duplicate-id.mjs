/**
 * Scenario: a human inserts a new row with an ALREADY-EXISTING id.
 *
 * Hypothesis: a direct human row-insert into User_Input whose id already
 * exists must be detected as an identity conflict and fail closed (the
 * library records a conflict), must NEVER silently overwrite the existing
 * row, and must NEVER create a duplicate projection. The scenario exposes
 * an undetected identity conflict, a silent overwrite of an existing row,
 * or a duplicate projection row.
 *
 * The direct insert seam (`insertInputRow`) rejects an already-existing id
 * with the stable `identity_shifted` status class BEFORE writing (the
 * pre-write validation rejects a duplicate identity and never writes), so
 * the fail-closed rejection is EXPECTED evidence (expectedErrors 1); any
 * OTHER rejection (transport/validation) or a non-rejected insert is a real
 * failure. The action uses the public EntityManager for the dedicated row
 * and the direct-Sheet seam for the insert, so it runs only in live mode.
 */
import { SOAK_ENTITY_ORDER, SOAK_FIELD_PLANS } from "../entities.mjs";
import { generateRow } from "../operations.mjs";
import { SeededRandom, deriveSeed } from "../prng.mjs";
import { SCENARIO_OBSERVE_POLL_MS, SCENARIO_OBSERVE_TIMEOUT_MS } from "../constants.mjs";
import { boundedSleep } from "../timing.mjs";

/** Stable scenario id recorded in redacted artifacts. */
export const id = "human-insert-duplicate-id";
/** Data scenario: overlaps the data/base workload, not lifecycle-gated. */
export const kind = "data";
/** Raced against actors, or after them before convergence. */
export const allowedPhases = ["concurrent-with-actors", "after-actors"];
/** Stable redacted parameter tag for this scenario. */
export const TAG = "human-insert-duplicate-id";

/**
 * Deterministic plan for one cycle: entity, a DEDICATED existing row id
 * (outside the actor/prologue space), a deterministic duplicate-insert
 * value set (the SAME id with different field values), and a jitter. Pure
 * function of (seed, cycle).
 *
 * @param {{ seed: number, cycle: number, phase: string, order: number, rng: object, activeEntities?: readonly object[] }} input
 * @returns {object} plan with tag/jitter/target/dupRow.
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
  const abbreviation = entry.name.replace(/^Soak/, "").toLowerCase();
  const targetId = `dup-${abbreviation}-c${cycle}-${order}`;
  return {
    tag: TAG,
    // Short deterministic jitter so the duplicate insert lands while normal
    // actors are mid-flight rather than at a fixed point.
    jitterMs: 1 + rng.int(60),
    target: { entityName: entry.name, targetId },
    // Deterministic duplicate-insert value set: the SAME id with different
    // field values, so a silent overwrite or duplicate projection is
    // distinguishable from the original row.
    dupRow: { id: targetId, ...generateRow(rng, fieldPlan) },
  };
}

/**
 * Live action: creates a DEDICATED existing row, awaits its projection, then
 * attempts a direct human row-insert with the SAME id. The seam rejects the
 * duplicate with `identity_shifted` BEFORE writing (fail closed), which is
 * EXPECTED evidence (expectedErrors 1); a non-rejected insert or a
 * non-identity rejection is a real failure. It then verifies the existing row
 * was NOT overwritten and NO duplicate row appeared via a bounded authority
 * observation. The dedicated row is removed in a GUARANTEED finally path so
 * the final SQLite state matches the deterministic replay.
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
  const rng = new SeededRandom(deriveSeed(context.seed, context.cycle * 829 + 61));
  const tabName = `${plan.target.entityName}_Input`;
  const critical = (action) => context.oracleLock === undefined
    ? action()
    : context.oracleLock.withLock(action);
  let cleanupFailures = 0;
  let failures = 0;
  let result;
  let originalRow;
  try {
    // Critical section: create the DEDICATED existing row and mirror it into
    // the oracle atomically against concurrent actor verification, so an
    // actor never sees the row in only one store.
    await critical(async () => {
      originalRow = { id: plan.target.targetId, ...generateRow(rng, fieldPlan) };
      em.persist(em.create(token, originalRow));
      await em.flush();
      context.oracle?.applyMutation({ op: "insert", entity: plan.target.entityName, row: originalRow });
    });

    // Bounded projection readiness: the direct insert targets the _Input tab,
    // and the dedicated row must first be projected there. If it never
    // appears, record a truthful skip and never attempt a doomed insert.
    const projected = await awaitInputProjection(
      client, context.live.spreadsheetId, tabName, plan.target, context,
    );
    if (!projected) {
      result = { status: "skipped", expectedErrors: 0, failures: 0, reason: "projection-not-ready" };
    } else {
      // Consume the plan's jitter (bounded by the run deadline) so the
      // duplicate insert lands while actors are mid-flight.
      await boundedSleep(plan.jitterMs ?? 0, context.deadlineAtMs);
      // Attempt the direct insert with the SAME id. The seam rejects an
      // already-existing id with `identity_shifted` BEFORE writing (fail
      // closed); a non-rejected insert or a non-identity rejection is a real
      // failure.
      let insertRejected = false;
      let identityShifted = false;
      try {
        await client.insertInputRow({
          spreadsheetId: context.live.spreadsheetId,
          tabName,
          row: plan.dupRow,
          deadlineAtMs: context.deadlineAtMs,
        });
      } catch (error) {
        insertRejected = true;
        identityShifted = isIdentityShiftedRejection(error);
      }
      if (!insertRejected) {
        // The seam did NOT reject the duplicate: a duplicate projection or
        // silent overwrite was created — the corruption failure this scenario
        // hunts.
        failures += 1;
        result = { status: "failed", expectedErrors: 0, failures, reason: "scenario-error" };
      } else if (!identityShifted) {
        // A non-identity_shifted rejection (transport/validation) is a real
        // failure, never an expected fail-closed conflict.
        failures += 1;
        result = { status: "failed", expectedErrors: 0, failures, reason: "scenario-error" };
      } else {
        // The identity conflict was rejected (fail-closed evidence). Verify
        // the existing row was NOT overwritten and NO duplicate row appeared
        // via a bounded authority observation.
        const outcome = await observeNoDuplicate({ em, token, plan, originalRow, context });
        if (outcome === "ok") {
          result = { status: "ok", expectedErrors: 1, failures: 0 };
        } else if (outcome === "duplicate" || outcome === "overwritten") {
          failures += 1;
          result = { status: "failed", expectedErrors: 1, failures, reason: "scenario-error" };
        } else {
          // The authority could not settle on a single unchanged row within
          // the bound: a truthful skip, never an unobserved ok.
          result = { status: "skipped", expectedErrors: 1, failures: 0, reason: "winner-not-verified" };
        }
      }
    }
  } catch (error) {
    result = { status: "failed", expectedErrors: 0, failures: 1, reason: "scenario-error" };
  } finally {
    // Guaranteed cleanup: remove the dedicated row and mirror the delete so
    // SQLite and the oracle stay symmetric even when the insert, an
    // observation, or an authority read failed. A cleanup failure is recorded
    // separately (cleanupFailures) and never masks the original failure.
    try {
      await critical(async () => {
        const rows = await em.find(token, { id: plan.target.targetId });
        for (const row of rows) em.remove(row);
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
 * True when a rejected direct insert carries the stable `identity_shifted`
 * fail-closed evidence (the pre-write validation rejected a duplicate
 * identity). The real seam surfaces it as `statusClass`; the fake seam in
 * tests surfaces it as `code`, so both are accepted.
 *
 * @param {unknown} error a rejected promise's reason.
 * @returns {boolean}
 */
function isIdentityShiftedRejection(error) {
  return error !== null && typeof error === "object" &&
    (error?.statusClass === "identity_shifted" || error?.code === "identity_shifted");
}

/**
 * Bounded authority observation that the dedicated row is EXACTLY one row
 * with its ORIGINAL values after the (rejected) duplicate insert.
 *
 * A duplicate projection would surface as more than one row for the id
 * (`duplicate`); a silent overwrite would surface as one row whose values
 * differ from the original (`overwritten`); a single unchanged row is the
 * verified fail-closed outcome (`ok`). If the authority cannot settle within
 * the bound the caller records a truthful skip (`unobserved`).
 *
 * @returns {Promise<"ok" | "duplicate" | "overwritten" | "unobserved">}
 */
async function observeNoDuplicate({ em, token, plan, originalRow, context }) {
  const deadline = Math.min(
    Date.now() + SCENARIO_OBSERVE_TIMEOUT_MS,
    context.deadlineAtMs ?? Number.MAX_SAFE_INTEGER,
  );
  while (true) {
    if (Date.now() >= deadline) return "unobserved";
    const rows = await em.find(token, { id: plan.target.targetId });
    if (rows.length > 1) return "duplicate";
    if (rows.length === 1) {
      return rowsMatch(rows[0], originalRow) ? "ok" : "overwritten";
    }
    // 0 rows: the dedicated row is not yet observable; keep polling.
    await boundedSleep(SCENARIO_OBSERVE_POLL_MS, deadline);
  }
}

/**
 * True when one authority row carries the same non-id field values as the
 * originally-created row (the existing row was NOT overwritten).
 *
 * @param {object} row the observed authority row.
 * @param {object} originalRow the originally-created row.
 * @returns {boolean}
 */
function rowsMatch(row, originalRow) {
  for (const [field, value] of Object.entries(originalRow)) {
    if (field === "id") continue;
    if (!sameValue(row[field], value)) return false;
  }
  return true;
}

/** Value equality that treats Date instances by their epoch time. */
function sameValue(a, b) {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return a === b;
}

/**
 * Bounded projection readiness: polls the direct-Sheet read seam until the
 * dedicated row's projection is observable in the _Input tab.
 *
 * The direct insert seam requires the identity row to already exist in the
 * tab; the row is created in the authority and projected by the sync worker
 * asynchronously. Returns `true` once the row is visible, or `false` when it
 * never appears within the bounded window (the caller records a truthful
 * `projection-not-ready` skip and never starts a doomed direct insert).
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
    const rows = await client.readTabRows(spreadsheetId, tabName, {
      deadlineAtMs: context.deadlineAtMs,
    });
    const headers = rows[0] ?? [];
    const idColumn = headers.indexOf("id");
    if (idColumn >= 0 && rows.some((entry, index) => index > 0 && entry[idColumn] === target.targetId)) {
      return true;
    }
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
