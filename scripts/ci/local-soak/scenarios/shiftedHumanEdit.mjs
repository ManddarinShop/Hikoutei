/**
 * Scenario: direct human edit raced against a concurrent User_Input row
 * delete that shifts the tab (#364).
 *
 * Hypothesis: a direct human edit (`client.mutateInputCell`) raced with a
 * concurrent User_Input row insert/delete must NEVER land on the wrong
 * identity. The sheet provider's fail-closed identity-shift guard (#366)
 * rejects with the stable `identity_shifted` status class whenever the
 * raced row shift would place the write on a different identity; the
 * scenario verifies that invariant at the direct-Sheet seam, so it runs
 * only in live mode; local mode records `skipped`.
 *
 * The race: a DEDICATED shifter row is created through the public
 * EntityManager BEFORE the dedicated race row (projection appends land in
 * commit order, so the shifter row sits above the race row), then a direct
 * human row delete of the shifter row is fired CONCURRENTLY with the human
 * edit of the race row. If the delete's row shift lands before the edit's
 * write, the edit's stale write coordinate would hit a different row; the
 * edit must then either land on the intended identity (proven by a
 * post-race snapshot) or be rejected fail-closed as `identity_shifted`
 * (an EXPECTED error, never a failure). A resolved edit whose value is NOT
 * observable on the intended identity is the wrong-identity write this
 * scenario hunts and is ALWAYS a failure.
 */
import { SOAK_ENTITY_ORDER, SOAK_FIELD_PLANS } from "../entities.mjs";
import { generateRow } from "../operations.mjs";
import { SeededRandom, deriveSeed } from "../prng.mjs";
import { SCENARIO_OBSERVE_POLL_MS, SCENARIO_OBSERVE_TIMEOUT_MS } from "../constants.mjs";
import { boundedSleep } from "../timing.mjs";
import { classifyDirectError } from "../sheetsDirect.mjs";

/** Stable scenario id recorded in redacted artifacts. */
export const id = "shifted-human-edit";
/** Data scenario: overlaps the data/base workload, not lifecycle-gated. */
export const kind = "data";
/** Raced against actors (worker mid-flight), or after them before convergence. */
export const allowedPhases = ["concurrent-with-actors", "after-actors"];
/** Stable redacted parameter tag for this scenario. */
export const TAG = "shifted-human-edit";

/**
 * Deterministic plan for one cycle: entity, editable field, a DEDICATED
 * race id and its DEDICATED shifter id (both outside the actor/prologue
 * space), the human edit value, and the race jitter. Pure function of
 * (seed, cycle) — reads no external run state.
 *
 * @param {{ seed: number, cycle: number, phase: string, order: number, rng: object, activeEntities?: readonly object[] }} input
 * @returns {object} plan with tag/jitter/humanValue/target.
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
  const fieldPlan = SOAK_FIELD_PLANS[entry.name];
  // Prefer an editable string field (the human edit writes a plain string
  // that the observation parser round-trips); fall back to any non-primary
  // field when an entity has none.
  const editable = Object.entries(fieldPlan).filter(([name, spec]) => !spec.primary && spec.type === "string");
  const [field] = editable.length > 0
    ? editable[rng.int(editable.length)]
    : Object.entries(fieldPlan).find(([name, spec]) => !spec.primary) ?? ["id", {}];
  const abbreviation = entry.name.replace(/^Soak/, "").toLowerCase();
  return {
    tag: TAG,
    // Race jitter: the edit and the shifter delete land while the worker
    // and actors are mid-flight rather than at a fixed point.
    jitterMs: 1 + rng.int(80),
    // Deterministic human edit value (never a raw or secret value).
    humanValue: `shift-${abbreviation}-c${cycle}-${order}-edit`,
    target: {
      entityName: entry.name,
      field,
      // Dedicated ids: never the base `main`/actor rows, and never the
      // actor/prologue id space.
      targetId: `sh-${abbreviation}-c${cycle}-${order}`,
      shifterId: `sh-${abbreviation}-c${cycle}-${order}-shift`,
    },
  };
}

/**
 * True when a rejected direct-Sheet call is the FAIL-CLOSED identity-shift
 * guard: the write's postcondition could not verify the value on the
 * intended identity (a row insert/delete shifted the tab and the stale
 * coordinate would have hit a different row), so the direct client
 * rejected with the stable `identity_shifted` status class. Such a
 * rejection is an EXPECTED race outcome — the harness never writes to the
 * wrong identity and never compensates — so it is counted as an expected
 * error, never a failure.
 *
 * @param {unknown} error a rejected promise's reason.
 * @returns {boolean}
 */
export function isIdentityShiftedRejection(error) {
  return classifyDirectError(error).statusClass === "identity_shifted" ||
    (error !== null && typeof error === "object" && error?.statusClass === "identity_shifted");
}

/**
 * Classifies the race outcome against the identity invariant (pure-ish
 * unit, exported so tests can drive it directly).
 *
 * - edit rejected with `identity_shifted` -> expected error, never a failure;
 * - edit rejected otherwise -> failure;
 * - edit resolved -> the value MUST be observable on the intended identity
 *   row (scenario-level proof that a "successful" edit never wrote to the
 *   wrong identity — the #364 invariant); a missing/wrong cell is a failure;
 * - shifter delete rejected with `identity_shifted` -> expected (its own
 *   guard failed closed); rejected otherwise -> failure.
 *
 * @param {object} input the settled race results plus the direct-Sheet
 *   seams for the post-race snapshot.
 * @returns {Promise<{ status: string, expectedErrors: number, failures: number, reason: string }>}
 */
export async function classifyRaceOutcome({ plan, editResult, shiftResult, client, spreadsheetId, tabName, context }) {
  let expectedErrors = 0;
  let failures = 0;
  if (editResult.status === "rejected") {
    if (isIdentityShiftedRejection(editResult.reason)) expectedErrors += 1;
    else failures += 1;
  } else {
    const landed = await verifyEditLanded(client, spreadsheetId, tabName, plan, context);
    if (!landed) failures += 1;
  }
  if (shiftResult.status === "rejected") {
    if (isIdentityShiftedRejection(shiftResult.reason)) expectedErrors += 1;
    else failures += 1;
  }
  return failures > 0
    ? { status: "failed", expectedErrors, failures, reason: "scenario-error" }
    : { status: "ok", expectedErrors, failures: 0, reason: "guard-invariant-verified" };
}

/**
 * Live action: creates a DEDICATED shifter row then a DEDICATED race row
 * (each mirrored into the oracle under the shared lock), waits for BOTH
 * projections to be observable in the _Input tab, then races the human
 * edit of the race row against a direct human DELETE of the shifter row.
 * The race outcome is classified by the identity invariant
 * ({@link classifyRaceOutcome}); both dedicated rows are removed in a
 * GUARANTEED finally path so the final SQLite state matches the
 * deterministic replay. Only ever touches the direct-Sheet
 * observation/human-input seam and the public EntityManager — never
 * internal storage.
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
  const spreadsheetId = context.live.spreadsheetId;
  const tabName = `${plan.target.entityName}_Input`;
  const critical = (action) => context.oracleLock === undefined
    ? action()
    : context.oracleLock.withLock(action);
  let cleanupFailures = 0;
  let result;
  try {
    // DEDICATED shifter row FIRST so its projection appends ABOVE the race
    // row (projection appends land in commit order at the end of the tab):
    // deleting it concurrently with the edit is what shifts the race row's
    // index.
    await critical(async () => {
      const shifterRow = { id: plan.target.shifterId, ...generateRow(rng, fieldPlan) };
      em.persist(em.create(token, shifterRow));
      await em.flush();
      context.oracle?.applyMutation({ op: "insert", entity: plan.target.entityName, row: shifterRow });
    });
    // The DEDICATED race row the human edit targets.
    await critical(async () => {
      const raceRow = { id: plan.target.targetId, ...generateRow(rng, fieldPlan) };
      em.persist(em.create(token, raceRow));
      await em.flush();
      context.oracle?.applyMutation({ op: "insert", entity: plan.target.entityName, row: raceRow });
    });

    // Bounded projection readiness: BOTH dedicated rows must be observable
    // in the _Input tab before the race starts (the direct write and delete
    // seams require the identity rows to exist). If either never appears,
    // record a truthful `projection-not-ready` skip and never start a
    // doomed race.
    const projected = await awaitBothProjected(client, spreadsheetId, tabName, plan.target, context);
    if (!projected) {
      result = { status: "skipped", expectedErrors: 0, failures: 0, reason: "projection-not-ready" };
    } else {
      // Deterministic jitter so the race lands while the worker/actors are
      // mid-flight, bounded by the run deadline (never an unconstrained
      // sleep).
      await boundedSleep(plan.jitterMs ?? 0, context.deadlineAtMs ?? Number.MAX_SAFE_INTEGER);
      if (Date.now() >= (context.deadlineAtMs ?? Number.MAX_SAFE_INTEGER)) {
        // Never start the race against an expired budget: a truthful skip
        // instead of a doomed write.
        result = { status: "skipped", expectedErrors: 0, failures: 0, reason: "deadline-expired" };
      } else {
        // THE RACE: the human edit and the row-delete shifter run
        // concurrently through the same direct client. Whichever write
        // lands first decides whether the edit sees a shifted tab; both
        // outcomes are judged by the identity invariant in
        // {@link classifyRaceOutcome}.
        const editPromise = client.mutateInputCell({
          spreadsheetId,
          tabName,
          identity: plan.target.targetId,
          headerName: plan.target.field,
          value: plan.humanValue,
          deadlineAtMs: context.deadlineAtMs,
        });
        const shiftPromise = client.deleteInputRow({
          spreadsheetId,
          tabName,
          identity: plan.target.shifterId,
          deadlineAtMs: context.deadlineAtMs,
        });
        const [editResult, shiftResult] = await Promise.allSettled([editPromise, shiftPromise]);
        result = await classifyRaceOutcome({
          plan, editResult, shiftResult,
          client, spreadsheetId, tabName, context,
        });
      }
    }
  } catch (error) {
    result = { status: "failed", expectedErrors: 0, failures: 1, reason: "scenario-error" };
  } finally {
    // GUARANTEED cleanup: remove BOTH dedicated rows (race + shifter) and
    // mirror the deletes so SQLite and the oracle stay symmetric even when
    // the race or an observation failed. A cleanup failure is recorded
    // separately (cleanupFailures) and never masks the original failure.
    try {
      await critical(async () => {
        const ids = [plan.target.targetId, plan.target.shifterId];
        for (const id of ids) {
          const rows = await em.find(token, { id });
          for (const row of rows) em.remove(row);
        }
        await em.flush();
        for (const id of ids) {
          context.oracle?.applyMutation({ op: "delete", entity: plan.target.entityName, id });
        }
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
 * Scenario-level proof that a resolved human edit landed on the INTENDED
 * identity: reads the _Input tab and requires the dedicated race row to
 * display the human value in the target field. A resolved edit whose value
 * is not observable on the intended identity row (or whose row is absent)
 * is the wrong-identity write the #366 guard must never allow — always a
 * failure, never forgiven by the client's own postcondition.
 *
 * @returns {Promise<boolean>} true only when the intended identity row
 *   displays the human value.
 */
export async function verifyEditLanded(client, spreadsheetId, tabName, plan, context) {
  const rows = await client.readTabRows(spreadsheetId, tabName, {
    deadlineAtMs: context.deadlineAtMs,
  });
  const headers = rows[0] ?? [];
  const idColumn = headers.indexOf("id");
  const fieldColumn = headers.indexOf(plan.target.field);
  if (idColumn < 0 || fieldColumn < 0) return false;
  const cells = rows.find((row, index) => index > 0 && row[idColumn] === plan.target.targetId);
  if (cells === undefined) return false;
  return (cells[fieldColumn] ?? "") === plan.humanValue;
}

/**
 * Bounded projection readiness: polls the direct-Sheet read seam until BOTH
 * dedicated rows (race + shifter) are observable in the _Input tab.
 *
 * Returns `true` once both ids are visible, or `false` when either never
 * appears within the bounded window (the caller records a truthful skip
 * and never starts a doomed race).
 *
 * @returns {Promise<boolean>}
 */
async function awaitBothProjected(client, spreadsheetId, tabName, target, context) {
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
    if (idColumn < 0) return false;
    const ids = new Set();
    for (let index = 1; index < rows.length; index += 1) {
      const id = rows[index]?.[idColumn];
      if (typeof id === "string" && id.length > 0) ids.add(id);
    }
    if (ids.has(target.targetId) && ids.has(target.shifterId)) return true;
    await boundedSleep(SCENARIO_OBSERVE_POLL_MS, deadline);
  }
}

/**
 * Deterministic, idempotent orphan recovery for this scenario's dedicated
 * rows (race + shifter) on a process-death resume.
 *
 * A run that dies before this scenario's guaranteed finally can leave the
 * deterministic dedicated ids in the authority; the resume replay would
 * reject them as foreign ids. This hook removes exactly those planned rows
 * (and only them) through the public EntityManager, so a resume of an
 * interrupted in-flight cycle never fails the DB proof over an orphan. It
 * is derived solely from the persisted seed/cycle plan (same inputs ->
 * same orphan ids), is idempotent (removing missing rows is a no-op), and
 * is restart-safe. Never touches internal storage/outbox.
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
  const ids = [plan.target.targetId, plan.target.shifterId];
  let removed = 0;
  for (const id of ids) {
    const rows = await em.find(token, { id });
    for (const row of rows) {
      em.remove(row);
      removed += 1;
    }
  }
  if (removed > 0) await em.flush();
  return { removed };
}
