/**
 * Live human-edit probe, Sheets convergence check, and System_State
 * readiness barrier for the soak runner.
 * Depends only on leaf modules.
 */
import {
  CONVERGENCE_POLL_MS,
  CONVERGENCE_TIMEOUT_MS,
  PROBE_ACCEPT_POLL_MS,
  PROBE_ACCEPT_TIMEOUT_MS,
  PROBE_EVERY_CYCLES,
  SYSTEM_STATE_READINESS_POLL_MS,
  TOMBSTONE_HEADER,
} from "./constants.mjs";
import { SOAK_FIELD_PLANS } from "./entities.mjs";
import { sharedEntityId } from "./operations.mjs";
import { SeededRandom, deriveSeed } from "./prng.mjs";
import {
  sanitizeRecordFields,
  sanitizeStatusClass,
  sanitizeTableName,
} from "./redact.mjs";
import { readRuntimeSystemStateReadiness } from "./systemStateReadiness.mjs";
import { boundedSleep } from "./timing.mjs";
import { DirectSheetsError, evaluateInputPreWrite } from "./sheetsDirect.mjs";

/**
 * Evaluates a User_Input readiness snapshot for one intended identity
 * BEFORE the probe's single direct write.
 *
 * Delegates to the SHARED pre-write evaluator (`evaluateInputPreWrite`) so
 * the readiness barrier applies the exact same full header/row-shape
 * validation the direct write performs: a missing/duplicate/whitespace
 * header, a non-empty row with a blank or non-string identity, or a
 * duplicated nonblank identity (intended or not) fails closed with the
 * fixed class; a structurally valid tab that lacks the intended identity is
 * `missing` (the caller may reread); and exactly one intended identity is
 * `ready`. No id or value ever leaks.
 *
 * @param {readonly unknown[][]} rows data rows including the header row.
 * @param {string} identity the intended main-row identity.
 * @param {string} headerName the target field the probe will write.
 * @returns {{status:"ready"} | {status:"missing"} | {status:"fail", statusClass:string}}
 */
export function evaluateInputReadiness(rows, identity, headerName) {
  const verdict = evaluateInputPreWrite({ rows, identity, headerName });
  if (verdict.status === "ready") return { status: "ready" };
  return verdict;
}

/**
 * Paced User_Input readiness barrier before the probe's single write.
 *
 * System_State convergence does not prove the editable User_Input row is
 * already observable, so the probe polls the target tab until it has the
 * intended identity visible within the phase deadline. Missing target
 * identity is the ONLY retryable condition (bounded sleep then reread);
 * a malformed header/identity fails closed immediately, and a transient
 * Direct Sheets transport failure propagates (never retried here) to the
 * probe's existing error classification. The write is never started
 * post-deadline: the deadline is rechecked before every read, and a
 * persistent absence or deadline expiry raises the allowlisted
 * `missing_identity` class so the outer handler records a stable redacted
 * probe failure.
 *
 * A present identity is NOT a current writable baseline: the target row on
 * the User_Input tab can be a stale projection of a canonical row the
 * scenario cleanup already deleted (its binding is being tombstoned), so a
 * human edit written there would never be accepted. Before returning ready
 * the barrier therefore ALSO requires the existing canonical row to still
 * be readable through the application authority (`findOne`) AND to be
 * coherent with the User_Input displayed baseline (the canonical field
 * values match the editable cells the probe is about to write against), so
 * the probe never issues a doomed write against a deleted or stale
 * baseline. The canonical baseline is retryable like a missing identity; if
 * it never appears the probe fails with the stable `missing_identity` class
 * instead of writing.
 *
 * @param {object} context the live probe context (provides `hikoutei` and
 *   `tokenByEntity` for the canonical baseline read).
 * @param {{name:string}} entry the probe entity entry.
 * @param {string} identity the intended main-row identity.
 * @param {string} headerName the target field the probe will write.
 * @param {readonly string[]} editableFields the editable string fields the
 *   coherent baseline must match.
 * @param {number} phaseDeadline epoch deadline (same clock as Date.now()).
 * @returns {Promise<void>} resolves when the identity is ready AND the
 *   canonical baseline is current and coherent.
 */
async function waitForInputReadiness(context, entry, identity, headerName, editableFields, phaseDeadline) {
  const { live } = context;
  while (true) {
    if (Date.now() >= phaseDeadline) {
      throw new DirectSheetsError("input identity never became ready", "missing_identity");
    }
    const rows = await live.client.readTabRows(
      live.spreadsheetId,
      `${entry.name}_Input`,
      { deadlineAtMs: phaseDeadline },
    );
    // A slow readiness read can resolve after the phase deadline (a request
    // started just before it): a value observed only after the deadline must
    // never be treated as ready. Recheck immediately before evaluating the
    // snapshot, and never start a fresh read once expired.
    if (Date.now() >= phaseDeadline) {
      throw new DirectSheetsError("input identity never became ready", "missing_identity");
    }
    const verdict = evaluateInputReadiness(rows, identity, headerName);
    if (verdict.status === "fail") {
      throw new DirectSheetsError("input readiness invalid", verdict.statusClass);
    }
    if (verdict.status === "ready") {
      // A present identity is not a current writable baseline: the target
      // row may be a stale projection of a canonical row the scenario
      // cleanup already deleted (or is deleting). Require the canonical
      // SQLite row to still exist AND to be coherent with the User_Input
      // displayed baseline before writing; otherwise the human edit lands
      // against a tombstoned or stale binding and is never accepted. This
      // stays retryable (`missing`) so the probe either converges to a
      // current baseline or fails with the stable `missing_identity` class.
      const baseline = extractInputBaseline(rows, identity);
      if (await canonicalBaselineReady(context, entry, identity, baseline, editableFields)) return;
    }
    await boundedSleep(PROBE_ACCEPT_POLL_MS, phaseDeadline);
  }
}

/**
 * Extracts the target row's displayed cells keyed by header name.
 *
 * Returns `undefined` when the id header or the intended identity row is
 * absent, so callers can distinguish "no baseline to compare" from a real
 * stale baseline. Purely structural: cells are compared as displayed values
 * and never echoed into any artifact.
 *
 * @param {readonly unknown[][]} rows data rows including the header row.
 * @param {string} identity the intended main-row identity.
 * @returns {Record<string, unknown> | undefined}
 */
function extractInputBaseline(rows, identity) {
  const headers = rows[0] ?? [];
  const idColumn = headers.indexOf("id");
  if (idColumn < 0) return undefined;
  const cells = rows.find((entry, index) => index > 0 && entry[idColumn] === identity);
  if (cells === undefined) return undefined;
  const baseline = {};
  for (let index = 0; index < headers.length; index += 1) {
    baseline[headers[index]] = cells[index];
  }
  return baseline;
}

/**
 * True while the canonical row for the intended identity exists AND is
 * coherent with the User_Input displayed baseline.
 *
 * Reads the application authority (SQLite through the public EntityManager)
 * for the intended identity. A null row means the canonical entity was
 * deleted (its binding tombstoned) and the User_Input row is a stale
 * baseline, so the probe must not write. A present row whose editable field
 * values DIFFER from the User_Input displayed cells is a stale projection
 * (the canonical row was updated but the projection has not caught up), so
 * the probe must not write against it either. A missing runtime/token fails
 * closed to `false` so the probe never writes without canonical evidence.
 *
 * @param {object} context the live probe context.
 * @param {{name:string}} entry the probe entity entry.
 * @param {string} identity the intended main-row identity.
 * @param {Record<string, unknown> | undefined} baseline the User_Input
 *   displayed cells for the intended identity, or undefined when no
 *   baseline could be extracted.
 * @param {readonly string[]} editableFields the editable string fields the
 *   coherent baseline must match.
 * @returns {Promise<boolean>}
 */
async function canonicalBaselineReady(context, entry, identity, baseline, editableFields) {
  const token = context?.tokenByEntity?.get(entry.name);
  const runtime = context?.hikoutei;
  if (token === undefined || runtime?.em === undefined) return false;
  const row = await runtime.em.fork().findOne(token, { id: identity });
  if (row === null || row === undefined) return false;
  // Coherent baseline: the canonical row's editable field values must match
  // the User_Input displayed cells. A mismatch means the projection is stale
  // (the canonical row was updated but the projection has not caught up), so
  // the probe must not write. When no baseline could be extracted, fall back
  // to the existence check (defensive; the readiness verdict already proved
  // the identity is present and unique).
  if (baseline === undefined) return true;
  for (const field of editableFields) {
    const displayed = baseline[field];
    const canonical = row[field];
    if (String(canonical ?? "") !== String(displayed ?? "")) return false;
  }
  return true;
}

/**
 * Re-reads the User_Input tab and re-checks the coherent canonical baseline
 * immediately before the probe's single write.
 *
 * The readiness loop may have resolved a coherent baseline a moment ago, but
 * a concurrent scenario cleanup or public update can shift the projection
 * between that read and the write. This performs ONE fresh readiness read
 * plus the canonical coherence check, honoring the phase deadline (a
 * post-deadline read or a value observed only after the deadline is never
 * accepted). Returns true only when the baseline is still ready and
 * coherent, so the caller issues its single write against a current
 * baseline; otherwise the caller fails with the stable `missing_identity`
 * class and zero writes.
 *
 * @param {object} context the live probe context.
 * @param {{name:string}} entry the probe entity entry.
 * @param {string} identity the intended main-row identity.
 * @param {string} headerName the target field the probe will write.
 * @param {readonly string[]} editableFields the editable string fields the
 *   coherent baseline must match.
 * @param {number} phaseDeadline epoch deadline (same clock as Date.now()).
 * @returns {Promise<boolean>}
 */
async function revalidateBaselineBeforeWrite(
  context, entry, identity, headerName, editableFields, phaseDeadline,
) {
  if (Date.now() >= phaseDeadline) return false;
  const rows = await context.live.client.readTabRows(
    context.live.spreadsheetId,
    `${entry.name}_Input`,
    { deadlineAtMs: phaseDeadline },
  );
  if (Date.now() >= phaseDeadline) return false;
  const verdict = evaluateInputReadiness(rows, identity, headerName);
  if (verdict.status !== "ready") return false;
  const baseline = extractInputBaseline(rows, identity);
  return canonicalBaselineReady(context, entry, identity, baseline, editableFields);
}

/**
 * Human-edit/CAS/conflict probe (live only): overwrites one editable string
 * field of the cycle's main row through the User_Input tab and waits for
 * SQLite to accept the human value through the polling pipeline. The wait
 * is bounded by both the probe budget and the run's hard deadline, so a
 * live convergence wait can never silently exceed the requested duration.
 * Returns the redacted record plus the applied edit for the projection
 * check.
 */
export async function runHumanEditProbe(context, tablesTouched) {
  const { cycle, oracle, tokenByEntity, activeEntities, live, seed } = context;
  const entry = activeEntities[Math.floor(cycle / PROBE_EVERY_CYCLES) % activeEntities.length];
  tablesTouched.add(entry.tableName);
  if (live.mode !== "live") {
    return { record: { status: "skipped", reason: "local-mode" }, applied: undefined };
  }
  const fieldPlan = SOAK_FIELD_PLANS[entry.name];
  const editableFields = Object.entries(fieldPlan)
    .filter(([, spec]) => !spec.primary && spec.type === "string")
    .map(([field]) => field);
  if (editableFields.length === 0) {
    return { record: { status: "skipped", reason: "no-string-field" }, applied: undefined };
  }
  const rng = new SeededRandom(deriveSeed(seed, cycle * 31 + 7));
  const field = editableFields[rng.int(editableFields.length)];
  const targetId = sharedEntityId(entry.name, cycle, "main");
  const humanValue = `human-edit-c${cycle}`;
  // MEDIUM: the probe phase has its OWN operation deadline — the earlier
  // of the accept budget and the run deadline. Every direct Sheets request
  // of the probe (tab read, sheet-id lookup, write) is asserted against
  // this effective deadline before it starts, so a slow request can never
  // outlive the phase timeout just because the run budget is larger.
  const phaseDeadline = Math.min(Date.now() + PROBE_ACCEPT_TIMEOUT_MS, context.deadlineAtMs);
  try {
    // NEW: the probe's single direct write must not start until exactly
    // one intended identity is observable on the User_Input tab — a
    // System_State convergence pass does not prove the editable row has
    // projected. `waitForInputReadiness` returns only when the target is
    // ready, raises `missing_identity` on persistent absence/deadline
    // expiry, and raises the allowlisted malformed class on a bad header
    // or duplicate identity, all BEFORE any write. Exactly one
    // `mutateInputCell` is issued below and is never retried or
    // compensated.
    await waitForInputReadiness(context, entry, targetId, field, editableFields, phaseDeadline);
    // The readiness read can resolve just AT the phase deadline; the write
    // must never start after it. Recheck immediately before the single
    // `mutateInputCell` and fail with the stable `missing_identity` class,
    // zero writes.
    if (Date.now() >= phaseDeadline) {
      return {
        record: {
          status: "failed",
          reason: "probe-error",
          statusClass: "missing_identity",
          table: sanitizeTableName(entry.tableName),
        },
        applied: undefined,
      };
    }
    // Revalidate the coherent baseline immediately before the single write:
    // the canonical row or the User_Input projection may have changed between
    // the readiness loop and now (a concurrent scenario cleanup could have
    // deleted the row or a public update could have shifted the projection).
    // A stale baseline must never be written to, so the probe re-reads the
    // User_Input tab and re-checks the canonical coherence once more, still
    // honoring the phase deadline and issuing at most one write.
    if (!(await revalidateBaselineBeforeWrite(
      context, entry, targetId, field, editableFields, phaseDeadline,
    ))) {
      return {
        record: {
          status: "failed",
          reason: "probe-error",
          statusClass: "missing_identity",
          table: sanitizeTableName(entry.tableName),
        },
        applied: undefined,
      };
    }
    // Final atomic deadline check: the canonical revalidation read may have
    // resolved after the phase deadline (a slow canonical read that began just
    // before it). The single write must never start after the deadline, so
    // recheck immediately before `mutateInputCell` and fail with the stable
    // `missing_identity` class, zero writes.
    if (Date.now() >= phaseDeadline) {
      return {
        record: {
          status: "failed",
          reason: "probe-error",
          statusClass: "missing_identity",
          table: sanitizeTableName(entry.tableName),
        },
        applied: undefined,
      };
    }
    await live.client.mutateInputCell({
      spreadsheetId: live.spreadsheetId,
      tabName: `${entry.name}_Input`,
      identity: targetId,
      headerName: field,
      value: humanValue,
      deadlineAtMs: phaseDeadline,
    });
    const token = tokenByEntity.get(entry.name);
    const deadline = phaseDeadline;
    while (Date.now() < deadline) {
      await boundedSleep(PROBE_ACCEPT_POLL_MS, deadline);
      // Luna: the bounded sleep can overshoot the deadline (timer
      // granularity), so the deadline is rechecked IMMEDIATELY before the
      // poll read — a post-deadline findOne must never run, and a value
      // observed only after the deadline must never be accepted as
      // success (the phase records failed instead, never a post-deadline
      // ok).
      if (Date.now() >= deadline) break;
      const row = await context.hikoutei.em.fork().findOne(token, { id: targetId });
      if (row !== null && row[field] === humanValue) {
        // The poll read may have resolved after the deadline (a slow
        // query started just before it): accepting it now would report a
        // success the phase deadline had already expired.
        if (Date.now() >= deadline) break;
        oracle.applyMutation({
          op: "update",
          entity: entry.name,
          id: targetId,
          patch: { [field]: humanValue },
        });
        return {
          record: { status: "ok", table: sanitizeTableName(entry.tableName) },
          applied: { entityName: entry.name, field, value: humanValue, targetId },
        };
      }
    }
    return {
      record: {
        status: "failed",
        reason: "human-edit-not-accepted",
        table: sanitizeTableName(entry.tableName),
      },
      applied: undefined,
    };
  } catch (error) {
    const isDirect = error?.name === "DirectSheetsError";
    return {
      record: {
        status: "failed",
        reason: "probe-error",
        // The DirectSheetsError status class is preserved (allowlisted
        // only) so a live probe failure keeps a useful stable category;
        // arbitrary status text collapses to `unknown`.
        ...(isDirect ? { statusClass: sanitizeStatusClass(error.statusClass) } : {}),
        table: sanitizeTableName(entry.tableName),
      },
      applied: undefined,
    };
  }
}

/**
 * One convergence read with a single bounded retry for transient
 * transport failures.
 *
 * Only convergence GET/read operations retry, at most once, and only
 * while the active phase deadline has not expired. Retryable classes are
 * timeout, network, and HTTP 408/429/5xx (the `retryable` flag on
 * DirectSheetsError). Writes, cleanup, harness invariants, missing
 * tab/header/identity, unknown, permanent 4xx, and deadline expiry never
 * retry. A second transient failure propagates as-is (bounded to one
 * retry) so the cycle aborts with the stable status class.
 *
 * @param {() => Promise<unknown>} read the convergence read to run.
 * @param {number} phaseDeadline epoch deadline (same clock as Date.now()).
 * @returns {Promise<unknown>} the read result.
 */
async function readConvergenceRows(read, phaseDeadline) {
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof DirectSheetsError) || !error.retryable) throw error;
    if (Date.now() >= phaseDeadline) throw error;
    return await read();
  }
}

/**
 * Live convergence check: the observed projection id set must match the
 * oracle EXACTLY — missing ids, duplicate ids, and extra stale rows all
 * fail with redacted counts. Durable System_State tombstone rows
 * (`__typed_sheets_deleted` displayed boolean true on a non-blank-id
 * row) are retained deleted-entity history and are excluded from the
 * active id set before the comparisons run.
 *
 * MEDIUM: the convergence phase has its OWN operation deadline — the
 * earlier of the phase timeout and the run hard deadline. Every request
 * (`readTabsRows` batch or `readTabRows` fallback) is asserted against
 * this effective deadline BEFORE it starts and timeouts at
 * `min(default, effective remaining)`, so a slow Sheets request can
 * never outlive the phase timeout just because the run budget is larger.
 *
 * Observation is batched when the client provides `readTabsRows`: one
 * `spreadsheets.get` per round reads EVERY active System tab (one range
 * per tab) under a single pacing slot, replacing the per-tab reads the
 * loop used before. This changes only the observation request count —
 * the workload, poll cadence, and every comparison below are unchanged.
 * Clients that only implement the old per-tab `readTabRows` method keep
 * the previous per-entity request behavior unchanged.
 *
 * Phase 4 barrier: before the FIRST batched convergence read the runner
 * waits for the runtime's own System_State drain readiness (an internal
 * SQLite-only check keyed to the runtime object). The barrier keeps the
 * soak's convergence reads from competing with the initial System_State
 * drain on the shared limiter; it honors the same phase deadline, so a
 * drain that never finishes produces the normal redacted failed check
 * (zero counts) instead of an unbounded wait. Local-only runtimes and
 * unit-test contexts without a runtime report ready immediately.
 */
export async function checkSheetsConvergence(context, appliedProbe) {
  const { cycle, oracle, activeEntities, live } = context;
  const phaseDeadline = Math.min(Date.now() + CONVERGENCE_TIMEOUT_MS, context.deadlineAtMs);
  await waitForRuntimeSystemStateReadiness(context, phaseDeadline);
  let lastMissing = 0;
  let lastDuplicate = 0;
  let lastExtra = 0;
  let projectionMismatch = false;
  while (Date.now() < phaseDeadline) {
    lastMissing = 0;
    lastDuplicate = 0;
    lastExtra = 0;
    projectionMismatch = false;
    let converged = true;
    // Luna: the batched read covers every active System tab in ONE
    // request, so a convergence round issues one Sheets GET instead of
    // one GET per entity; the request count changes, never the checks.
    let rowsByTab;
    if (typeof live.client.readTabsRows === "function") {
      // Luna: never start a post-deadline read — the phase deadline must
      // be rechecked before the batched request like any other, and the
      // FINAL read of an iteration must never start after it.
      if (Date.now() >= phaseDeadline) {
        converged = false;
        break;
      }
      rowsByTab = await readConvergenceRows(
        () => live.client.readTabsRows(
          live.spreadsheetId,
          activeEntities.map((entry) => `${entry.name}_System`),
          { deadlineAtMs: phaseDeadline },
        ),
        phaseDeadline,
      );
    }
    for (const entry of activeEntities) {
      let rows;
      if (rowsByTab !== undefined) {
        rows = rowsByTab[`${entry.name}_System`] ?? [];
      } else {
        // Fallback for clients that only implement the old per-tab
        // method: never start a post-deadline read — a multi-entity
        // iteration can cross the phase deadline mid-loop, and the FINAL
        // read must be rechecked like every other one.
        if (Date.now() >= phaseDeadline) {
          converged = false;
          break;
        }
        rows = await readConvergenceRows(
          () => live.client.readTabRows(
            live.spreadsheetId,
            `${entry.name}_System`,
            { deadlineAtMs: phaseDeadline },
          ),
          phaseDeadline,
        );
      }
      const headers = rows[0] ?? [];
      const idColumn = headers.indexOf("id");
      if (idColumn < 0) {
        converged = false;
        break;
      }
      // System_State retains deleted entities as durable tombstone rows;
      // the tombstone header index makes extraction exclude them from the
      // active id set. A missing header (never for soak entities) keeps
      // the previous non-tombstone behavior.
      const tombstoneColumn = headers.indexOf(TOMBSTONE_HEADER);
      const { ids, blankIdRows } = extractProjectionIds(
        rows.slice(1),
        idColumn,
        tombstoneColumn >= 0 ? tombstoneColumn : undefined,
      );
      const idSet = new Set(ids);
      if (idSet.size !== ids.length) {
        lastDuplicate += ids.length - idSet.size;
        converged = false;
      }
      // Physical rows with a blank id cell but real content are rows the
      // oracle never planned: count them as extra rows so a partially
      // cleared projection fails convergence instead of hiding the rows.
      if (blankIdRows > 0) {
        lastExtra += blankIdRows;
        converged = false;
      }
      const expectedIds = oracle.ids(entry.name);
      const expectedSet = new Set(expectedIds);
      for (const id of expectedIds) {
        if (!idSet.has(id)) {
          lastMissing += 1;
          converged = false;
        }
      }
      // Extra stale rows: observed ids that the oracle no longer knows.
      // Redacted count only — never the ids themselves.
      for (const id of idSet) {
        if (!expectedSet.has(id)) {
          lastExtra += 1;
          converged = false;
        }
      }
      // Silent-overwrite check: the accepted human edit must eventually be
      // visible in the System projection for the probe's entity.
      if (appliedProbe !== undefined && appliedProbe.entityName === entry.name) {
        const fieldColumn = headers.indexOf(appliedProbe.field);
        const targetRow = rows.slice(1).find((row) => row[idColumn] === appliedProbe.targetId);
        if (fieldColumn < 0 || targetRow?.[fieldColumn] !== appliedProbe.value) {
          projectionMismatch = true;
          converged = false;
        }
      }
    }
    if (converged) {
      // Luna: never report success when the phase deadline expired before
      // the last read resolved — a slow final read can return converging
      // data after the deadline, and that must be a failed check, never a
      // post-deadline ok.
      if (Date.now() >= phaseDeadline) break;
      return { status: "ok", cycle };
    }
    await boundedSleep(CONVERGENCE_POLL_MS, phaseDeadline);
  }
  // Counts are numeric by construction; the record walker re-sanitizes the
  // section at the artifact boundary anyway.
  const failure = {
    status: "failed",
    missingRows: lastMissing,
    duplicateRows: lastDuplicate,
    ...(lastExtra > 0 ? { extraRows: lastExtra } : {}),
    ...(projectionMismatch ? { projectionMismatch: true } : {}),
  };
  return sanitizeRecordFields(failure);
}

/**
 * Phase 4 System_State drain barrier for one runtime.
 *
 * Waits (SQLite-only, through the internal controller) until the runtime's
 * System_State outbox drain reports ready, or until the phase deadline
 * expires — whichever comes first. A runtime without a registered sync
 * service (local-only mode, already closed, or a unit-test context that
 * omits `hikoutei`) reports ready immediately, so this is a no-op there.
 * When the deadline expires the caller's read loop exits with the normal
 * redacted failed convergence record; the barrier itself never throws and
 * never emits anything.
 *
 * @param {object} context cycle context (may omit `hikoutei`).
 * @param {number} phaseDeadline epoch deadline (same clock as Date.now()).
 * @returns {Promise<void>}
 */
export async function waitForRuntimeSystemStateReadiness(context, phaseDeadline) {
  const runtime = context?.hikoutei;
  if (runtime === undefined) return;
  while (Date.now() < phaseDeadline) {
    const readiness = await readRuntimeSystemStateReadiness(runtime);
    if (readiness.status === "ready") return;
    await boundedSleep(SYSTEM_STATE_READINESS_POLL_MS, phaseDeadline);
  }
}

/**
 * Extracts the projected id list and counts non-empty physical rows whose
 * id cell is blank (rows the oracle never planned). Purely structural: ids
 * are compared as cell values and never echoed into any artifact.
 *
 * When `tombstoneColumn` is given, rows with a non-blank id whose
 * tombstone cell displays boolean true are durable deleted-entity history
 * (System_State intentionally retains them) and are excluded from the
 * active id set, so they can never count as duplicate or extra rows.
 * Blank-id rows with real content STILL count as extra rows even when
 * their tombstone cell looks set: a tombstone without an id is malformed
 * and must never hide a row. Without `tombstoneColumn` the behavior is
 * unchanged — every non-blank id is active.
 *
 * @param {readonly unknown[][]} rows data rows below the header.
 * @param {number} idColumn header index of the id column.
 * @param {number | undefined} [tombstoneColumn] header index of the
 *   `__typed_sheets_deleted` tombstone column, or undefined to disable
 *   tombstone exclusion.
 * @returns {{ ids: unknown[], blankIdRows: number }}
 */
export function extractProjectionIds(rows, idColumn, tombstoneColumn) {
  const ids = [];
  let blankIdRows = 0;
  for (const row of rows) {
    const id = row[idColumn];
    const nonEmpty = row.some(
      (cell) => cell !== "" && cell !== null && cell !== undefined,
    );
    if (id === "" || id === null || id === undefined) {
      // A fully empty trailing row (the range read's padding) is not a
      // physical row; a row with real content but no id is — including a
      // malformed tombstone row, which must surface as extra instead of
      // being hidden by its tombstone cell.
      if (nonEmpty) blankIdRows += 1;
      continue;
    }
    // Durable history: a deleted entity stays in System_State as a row
    // with a displayed boolean-true tombstone. Such rows are NOT active
    // projections and never enter the active id set.
    if (tombstoneColumn !== undefined &&
        isDisplayedBooleanTrue(row[tombstoneColumn])) {
      continue;
    }
    ids.push(id);
  }
  return { ids, blankIdRows };
}

/**
 * True when a cell displays an explicit boolean-true value.
 *
 * Conservative display check for the `__typed_sheets_deleted` tombstone:
 * only an actual `true` value or a string equal to `TRUE` (case-
 * insensitive) counts. Never a broad truthiness check — a non-empty
 * string such as `"FALSE"`, `"yes"`, or `"1"` is NOT a boolean-true
 * display and must not mark a row as deleted.
 *
 * @param {unknown} cell the tombstone cell's displayed value.
 * @returns {boolean} true only for explicit boolean-true displays.
 */
function isDisplayedBooleanTrue(cell) {
  if (cell === true) return true;
  return typeof cell === "string" && cell.toUpperCase() === "TRUE";
}
