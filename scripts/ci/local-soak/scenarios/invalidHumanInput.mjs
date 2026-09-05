/**
 * Scenario: invalid human input to a required User_Input cell.
 *
 * Hypothesis: a direct human edit that violates scalar/required validation
 * (an empty required string cell, or a non-conforming literal on a
 * numeric/date/boolean cell) must be clearly rejected while normal work
 * continues, and the projection must recover once a valid value is restored.
 *
 * The failure this scenario exposes is NON-recovery or corruption: an
 * invalid cell that is silently accepted, poisons the projection, or cannot
 * be restored. A clear validation rejection is EXPECTED, not a failure.
 */
import { SOAK_ENTITY_ORDER, SOAK_FIELD_PLANS } from "../entities.mjs";
import { identityShiftedTransientResult, isIdentityShiftedEvidence, stableErrorTag } from "../errors.mjs";
import { generateRow } from "../operations.mjs";
import { SeededRandom, deriveSeed } from "../prng.mjs";
import { SCENARIO_OBSERVE_POLL_MS, SCENARIO_OBSERVE_TIMEOUT_MS, SCENARIO_REJECTION_SETTLE_OBSERVATIONS } from "../constants.mjs";
import { boundedSleep } from "../timing.mjs";
/** Stable scenario id recorded in redacted artifacts. */
export const id = "invalid-human-input";
/** Data scenario: overlaps the data/base workload, not lifecycle-gated. */
export const kind = "data";
/** Allowed execution windows within a cycle. */
export const allowedPhases = ["after-prologue", "concurrent-with-actors", "after-actors"];
/** Stable redacted parameter tag for this scenario. */
export const TAG = "invalid-required-input";

const WORDS = Object.freeze(["amber", "cobalt", "dune", "fjord", "kelp", "onyx", "slate", "zephyr"]);

/**
 * Builds the deterministic plan for one cycle: entity, field, injected
 * invalid value, the restore value, and a short jitter. Pure function of
 * (seed, cycle) — reads no external run state.
 *
 * @param {{ seed: number, cycle: number, phase: string, order: number, rng: object, activeEntities?: readonly object[] }} input
 * @returns {object} plan with tag/jitter/target/invalid/restore.
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
  // Only select a field whose injected invalid value is ACTUALLY invalid:
  // a scalar field (a non-conforming literal is always invalid) or a
  // NON-nullable string field (an empty required string is invalid). A
  // nullable string field accepts an empty value, so it is never selected.
  const candidates = Object.entries(fieldPlan).filter(([name, spec]) =>
    !spec.primary &&
    (spec.type === "number" || spec.type === "date" || spec.type === "boolean" ||
     (spec.type === "string" && spec.nullable !== true)));
  const [field, spec] = candidates[rng.int(candidates.length)];
  const isScalar = spec.type === "number" || spec.type === "date" || spec.type === "boolean";
  return {
    tag: TAG,
    // Short deterministic jitter so the invalid write lands while normal
    // actors are mid-flight rather than at a fixed point.
    jitterMs: 1 + rng.int(60),
    target: {
      entityName: entry.name,
      field,
      // A DEDICATED invalid-input row (outside the actor/prologue space), so
      // the invalid write, restore, and observation never touch an actor-
      // owned row and never need synchronization with the concurrent actors.
      targetId: `invalid-${abbreviation}-c${cycle}-${order}`,
    },
    // The field plan metadata lets the live action encode the restored
    // value back into the cell string the observation parser expects.
    fieldSpec: { type: spec.type, primary: spec.primary === true, nullable: spec.nullable === true },
    // invalid: a non-conforming literal (scalar field) or an empty value on
    // a required string. restore: the prior value is captured live and
    // written back so the row always returns to the pre-injection state.
    invalid: isScalar
      ? spec.type === "number" ? "not-a-number"
        : spec.type === "date" ? "not-a-date"
          : "not-a-boolean"
      : "",
    restore: isScalar
      ? spec.type === "number" ? "123"
        : spec.type === "date" ? "2024-01-01T00:00:00Z"
          : "true"
      : `${WORDS[rng.int(WORDS.length)]}-${rng.int(1000)}`,
  };
}

/**
 * Converts one stored value to the cell-string the observation parser
 * accepts, so the restore write returns the cell to its exact prior value
 * (dates and booleans are stored as objects in the authority).
 *
 * @param {unknown} value stored field value.
 * @param {{ type: string }} spec field plan metadata.
 * @returns {string} cell-string for `value`.
 */
function toCellString(value, spec) {
  if (value === null || value === undefined) return "";
  if (spec.type === "date") return value instanceof Date ? value.toISOString() : String(value);
  if (spec.type === "boolean") return value === true ? "true" : "false";
  return String(value);
}

/**
 * Live action: creates a DEDICATED invalid-input row (isolated from the
 * actor/prologue rows), writes the invalid value to its required User_Input
 * cell, then POLLS the public authority (SQLite through the EntityManager)
 * for a bounded window to observe whether the invalid value was rejected.
 * Only a rejection observed in the authority is counted as an expected
 * error; a value that silently reaches the authority is the corruption
 * failure this scenario hunts; a poll that cannot settle is recorded as a
 * truthful `skipped` (rejection-not-observable) rather than an unobserved
 * ok. The prior cell value is restored and the dedicated row removed in a
 * GUARANTEED finally path so the row always returns to its pre-injection
 * state. Only ever touches the direct-Sheet observation/human-input seam and
 * the public EntityManager read — never internal storage.
 *
 * @param {{ plan: object, context: object }} input the plan and the live
 *   execution context (public seams + direct client).
 * @returns {Promise<object>} { status, expectedErrors, failures, cleanupFailures?, reason? }.
 */
export async function execute({ plan, context }) {
  const client = context.live.client;
  const spreadsheetId = context.live.spreadsheetId;
  const tabName = `${plan.target.entityName}_Input`;
  const token = context.tokenByEntity.get(plan.target.entityName);
  const expected = new Set(context.activeEntities.map((entry) => entry.name));
  if (token === undefined || !expected.has(plan.target.entityName)) {
    return { status: "skipped", expectedErrors: 0, failures: 0, reason: "local-mode" };
  }
  const fieldPlan = SOAK_FIELD_PLANS[plan.target.entityName];
  const em = context.em.fork();
  const rng = new SeededRandom(deriveSeed(context.seed, context.cycle * 823 + 53));
  const critical = (action) => context.oracleLock === undefined
    ? action()
    : context.oracleLock.withLock(action);
  let cleanupFailures = 0;
  // Stable diagnostic kinds for every failure site (allowlisted, never raw
  // text) so a failed record says WHICH invariant fired.
  const failureKinds = new Set();
  let result;
  let prior;
  // True once the invalid value was actually attempted on the Sheet. The
  // cell restore in the guaranteed finally is skipped when the projection
  // never became ready (the invalid write was never attempted), so a row
  // that never reached the Sheet is never "restored" to a cell that was
  // never touched; the authority/oracle row cleanup is independent.
  let invalidWriteAttempted = false;
  try {
    // A DEDICATED invalid-input row, created through the public API and
    // mirrored into the oracle under the shared lock, so the invalid write,
    // restore, and observation never touch an actor-owned row and never
    // need synchronization with the concurrent actors.
    const row = { id: plan.target.targetId, ...generateRow(rng, fieldPlan) };
    await critical(async () => {
      em.persist(em.create(token, row));
      await em.flush();
      context.oracle?.applyMutation({ op: "insert", entity: plan.target.entityName, row });
    });
    // Capture the CURRENT value so the restore returns the cell to exactly
    // the pre-injection state.
    prior = toCellString(row[plan.target.field], plan.fieldSpec);
    // Bounded projection readiness: the invalid write targets a cell in the
    // _Input tab, and the dedicated row must first be projected there (the
    // direct-Sheet mutation seam requires the identity row to exist). Poll
    // the direct-Sheet read seam until the row is observable; if it never
    // appears, record a truthful skip and never attempt a doomed write.
    const projectionReady = await awaitInputProjection(
      client, spreadsheetId, tabName, plan.target, context,
    );
    let sheetObservable = false;
    // Narrowed transient scope: ONLY a rejection of the direct
    // `mutateInputCell` write below may classify as the expected
    // `identity-shifted-transient` (via `writeTransient`). Reads (projection
    // readiness, post-write, observation) and authority work rethrow to the
    // normal failure path — a read error is never a transient.
    let writeTransient;
    if (projectionReady) {
      invalidWriteAttempted = true;
      // Consume the plan's jitter so the invalid write lands while normal
      // actors are mid-flight rather than immediately. Bounded by the run
      // deadline so it can never outlive the run budget.
      await boundedSleep(plan.jitterMs ?? 0, context.deadlineAtMs);
      try {
        await client.mutateInputCell({
          spreadsheetId,
          tabName,
          identity: plan.target.targetId,
          headerName: plan.target.field,
          value: plan.invalid,
          deadlineAtMs: context.deadlineAtMs,
        });
      } catch (error) {
        // The direct seam's fail-closed `identity_shifted` evidence on the
        // invalid write is an EXPECTED TRANSIENT of the multi-writer soak (a
        // concurrent actor shifted the tab mid-write; the seam proved no
        // silent success): a truthful skip, never a failure. Any other write
        // rejection rethrows to the normal failure path.
        if (isIdentityShiftedEvidence(error)) {
          writeTransient = identityShiftedTransientResult(error);
        } else {
          throw error;
        }
      }
      if (writeTransient === undefined) {
        // Explicit Sheet-side post-write evidence: the invalid value must be
        // OBSERVABLE in the cell before an unchanged authority can be called a
        // rejection. Without this proof the edit may never have landed, so an
        // unchanged authority proves nothing.
        const cell = await readInputCell(
          client, spreadsheetId, tabName, plan.target, context,
        );
        sheetObservable = cell !== undefined && cell === plan.invalid;
      }
    }
    if (writeTransient !== undefined) {
      result = writeTransient;
    } else if (!projectionReady) {
      // The row projection never appeared: the invalid write was never
      // attempted, so there is no rejection to classify.
      result = { status: "skipped", expectedErrors: 0, failures: 0, reason: "projection-not-ready" };
    } else if (!sheetObservable) {
      // The invalid value could not be observed on the Sheet: the edit was
      // not provably observable, so an unchanged authority is NOT a proven
      // rejection. Truthful skip, never an unobserved ok.
      result = { status: "skipped", expectedErrors: 0, failures: 0, reason: "sheet-evidence-unavailable" };
    } else {
      // Observe the rejection in the public authority BEFORE restoring, so
      // the expected-error classification is evidence-backed, never assumed.
      // The observer requires POSITIVE settling evidence (the invalid edit
      // still observable on the Sheet while the authority keeps the prior
      // value) — never a rejection claimed from a first unchanged read.
      const outcome = await observeInvalidRejection(
        em, token, plan, prior, context,
        client, spreadsheetId, tabName,
      );
      if (outcome === "accepted") {
        // The invalid value silently reached the authority: the corruption/
        // non-recovery failure this scenario hunts.
        failureKinds.add("invalid-accepted");
        result = { status: "failed", expectedErrors: 0, failures: 1, reason: "invalid-accepted" };
      } else if (outcome === "rejected") {
        // The invalid value was rejected by scalar/required validation
        // (observed in the authority) AND the invalid edit was provably
        // observable on the Sheet. Recovery was not directly observed, so
        // the narrow limitation is recorded rather than claiming verified
        // recovery.
        result = { status: "ok", expectedErrors: 1, failures: 0, reason: "recovery-not-observed" };
      } else {
        // The poll could not settle on accepted or rejected within the bounded
        // window: a truthful skip, never an unobserved ok.
        result = { status: "skipped", expectedErrors: 0, failures: 0, reason: "rejection-not-observable" };
      }
    }
  } catch (error) {
    // Only the direct `mutateInputCell` write above may classify as the
    // expected transient (handled inline); every other throw — reads,
    // observation, authority work, setup — is a real scenario error, never
    // a transient.
    result = {
      status: "failed",
      expectedErrors: 0,
      failures: 1,
      reason: "scenario-error",
      reasonTag: stableErrorTag(error),
    };
  } finally {
    // GUARANTEED cleanup, split into INDEPENDENT guarded steps so a failure
    // in one never prevents the other: the cell restoration and the dedicated
    // authority-row/oracle removal are each attempted separately, and each
    // cleanup failure is counted exactly once. The original scenario error is
    // preserved (the failure counter only grows by the cleanup failures).
    // Step 1: restore the prior cell value, but ONLY when the invalid write
    // was actually attempted. A projection-timeout skip never wrote the
    // invalid value, so there is nothing to restore (restoring a never-touched
    // cell would be a needless / misdirected write).
    try {
      if (invalidWriteAttempted && prior !== undefined) {
        await client.mutateInputCell({
          spreadsheetId,
          tabName,
          identity: plan.target.targetId,
          headerName: plan.target.field,
          value: prior,
          deadlineAtMs: context.deadlineAtMs,
        });
      }
    } catch {
      cleanupFailures += 1;
      failureKinds.add("cleanup-delete-failed");
    }
    // Step 2: remove the dedicated row + oracle mirror, attempted even when
    // the restoration above failed, so SQLite and the oracle stay symmetric.
    try {
      await critical(async () => {
        const rows = await em.find(token, { id: plan.target.targetId });
        for (const invalidRow of rows) em.remove(invalidRow);
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
 * Polls the public authority AND the direct-Sheet seam over a bounded window
 * to observe whether the injected invalid value was accepted or rejected.
 *
 * The authority is read through the public EntityManager. If it shows the
 * invalid value the edit was silently ACCEPTED (the corruption failure). A
 * rejection is NEVER claimed from a single unchanged authority read — an
 * unchanged authority could simply mean the worker has not processed the
 * edit yet (or is slow to accept). Rejection requires POSITIVE settling
 * evidence: the invalid value must remain observable on the Sheet cell
 * WHILE the authority keeps the prior value across
 * `SCENARIO_REJECTION_SETTLE_OBSERVATIONS` separated polls (the edit is
 * provably present and the authority kept rejecting it, not merely
 * unprocessed). Only that settled combination is a positive rejection;
 * anything else that cannot settle returns `unobserved` so the caller
 * records a truthful `rejection-not-observable` skip (never an expected
 * error from repeated absence or one unchanged read).
 *
 * @returns {Promise<"accepted" | "rejected" | "unobserved">}
 */
async function observeInvalidRejection(em, token, plan, prior, context, client, spreadsheetId, tabName) {
  const deadline = Math.min(
    Date.now() + SCENARIO_OBSERVE_TIMEOUT_MS,
    context.deadlineAtMs ?? Number.MAX_SAFE_INTEGER,
  );
  let settleCount = 0;
  while (true) {
    if (Date.now() >= deadline) break;
    const row = await em.findOne(token, { id: plan.target.targetId });
    if (row !== null) {
      const current = toCellString(row[plan.target.field], plan.fieldSpec);
      if (current === plan.invalid) return "accepted";
      if (current === prior) {
        // Positive settling evidence: the invalid edit is STILL observable on
        // the Sheet while the authority keeps the prior value. Accumulate the
        // settle count; only a sustained combo across separated polls is a
        // proven rejection. If the sheet evidence is lost (cell reverts), the
        // streak resets and the scenario truthfully cannot settle.
        const cell = await readInputCell(client, spreadsheetId, tabName, plan.target, context);
        if (cell === plan.invalid) {
          settleCount += 1;
          if (settleCount >= SCENARIO_REJECTION_SETTLE_OBSERVATIONS) return "rejected";
        } else {
          settleCount = 0;
        }
      } else {
        settleCount = 0;
      }
    } else {
      settleCount = 0;
    }
    await boundedSleep(SCENARIO_OBSERVE_POLL_MS, deadline);
  }
  return "unobserved";
}

/**
 * Reads the display value of one field cell of the dedicated row through
 * the direct-Sheet read seam.
 *
 * Returns `undefined` when the row's projection (or the header) is not yet
 * present in the tab, so callers can distinguish "not projected yet" from a
 * real empty cell (an empty required string reads back as `""`).
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
 * The invalid write's mutation seam requires the identity row to already
 * exist in the tab; the row is created in the authority and projected by the
 * sync worker asynchronously. Returns `true` once the row is visible, or
 * `false` when it never appears within the bounded window (the caller
 * records a truthful skip and never attempts a doomed write).
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
 * would then reject it as a foreign id. This hook removes that exact planned
 * row (and only it) through the public EntityManager, so a resume of an
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
