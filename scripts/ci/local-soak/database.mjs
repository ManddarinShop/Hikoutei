/**
 * Runtime open/close deadline gating and resume authority (SQLite) checks.
 * No cycle with resume or execute.
 */
import { lstat } from "node:fs/promises";
import path from "node:path";
import { createTypedSheets } from "hikoutei";
import { SoakDeadlineExpiredError } from "./constants.mjs";
import { SOAK_FIELD_PLANS } from "./entities.mjs";
import { stableErrorTag } from "./errors.mjs";
import { rowValuesEqual } from "./executor.mjs";
import { matchAllowedPrefixRow } from "./replay.mjs";
import {
  inspectSqliteSchema,
  missingSchemaEntries,
  soakTableColumns,
} from "./schemaInspect.mjs";
import { closeRuntimeWithFinalRetry } from "./summary.mjs";
import { deadlineRemainingMs, sleep } from "./timing.mjs";

/**
 * Opens (or reopens) the public runtime with ONLY the active entity tokens.
 *
 * `--tables` scoping is enforced here: a subset run provisions, projects,
 * and verifies exactly the selected tables, never the full six.
 */
async function openRuntime(dbName, tokens) {
  return createTypedSheets({ dbName, entities: [...tokens] });
}

/**
 * Opens the runtime, then verifies the open finished inside the run's
 * deadline.
 *
 * MEDIUM 5: sync startup (live provisioning/lease claim) can consume a
 * large part of a short budget. When `createTypedSheets` returns AFTER the
 * epoch deadline expired, the runtime is closed (best effort, final retry)
 * and a stable `deadline_expired` failure is raised instead — the run must
 * never claim it stayed within budget. Used for BOTH the initial open and
 * the cycle-60 replacement open; deadline control lives in the runner
 * (test harness), never in the library's normal runtime semantics.
 *
 * HIGH 3: the opened runtime is ALWAYS carried on the thrown
 * `SoakDeadlineExpiredError` (`error.runtime`), and the deadline-gated
 * close's own failure is carried as `error.closeError` — so a caller can
 * track the handle and close it again with retry when the close attempt
 * failed. A late-open runtime is never leaked or silently discarded.
 *
 * @param {() => Promise<object>} open opens one runtime.
 * @param {number} deadlineAtMs epoch deadline (same clock as Date.now()).
 * @returns {Promise<object>} the opened runtime when still within budget.
 */
export async function openRuntimeWithinDeadline(open, deadlineAtMs) {
  const runtime = await open();
  if (deadlineAtMs !== undefined && Date.now() >= deadlineAtMs) {
    const closeError = await closeRuntimeWithFinalRetry(runtime);
    throw new SoakDeadlineExpiredError(runtime, closeError);
  }
  return runtime;
}

/**
 * Test-only injection: delays a runtime open so it resolves just past the
 * run's epoch deadline.
 *
 * The sleep is capped at `delayMs` but always extends at least 50ms past
 * the deadline, so the deadline-gated open path is exercised
 * deterministically regardless of machine speed (the deadline check inside
 * `openRuntimeWithinDeadline` then always fires). No-op when `delayMs` is
 * not a positive number.
 *
 * @param {number | undefined} delayMs configured injection delay.
 * @param {number} deadlineAtMs epoch deadline (same clock as Date.now()).
 * @returns {Promise<void>}
 */
async function delayOpenPastDeadline(delayMs, deadlineAtMs) {
  if (delayMs === undefined || delayMs <= 0) return;
  await sleep(Math.min(delayMs, deadlineRemainingMs(deadlineAtMs) + 50));
}

/**
 * The interrupted cycle named by an in-flight checkpoint marker.
 *
 * A stale in-flight marker (cycle == lastCompletedCycle) only lagged
 * behind the state; the REAL interrupted cycle is the in-flight marker
 * exactly one ahead of the checkpointed state.
 *
 * @returns {number | undefined}
 */
function inFlightCycleFromCheckpoint(checkpoint, state) {
  return checkpoint?.status === "in-flight" &&
    checkpoint.cycle === state.lastCompletedCycle + 1
    ? checkpoint.cycle
    : undefined;
}

/**
 * Reads one entity table's FULL row set through the public runtime and
 * normalizes it into plain field values (dates kept as Date instances).
 *
 * @returns {Promise<Map<string, object>>} rows by string id.
 */
async function readTableRows(hikoutei, tokenByEntity, entry) {
  const em = hikoutei.em.fork();
  const token = tokenByEntity.get(entry.name);
  const rows = await em.find(token, {});
  const fieldPlan = SOAK_FIELD_PLANS[entry.name];
  const observed = new Map();
  for (const row of rows) {
    const plain = {};
    for (const [field, spec] of Object.entries(fieldPlan)) {
      plain[field] = row[field] ?? null;
      if (spec.type === "date" && plain[field] instanceof Date === false) {
        plain[field] = plain[field] === null ? null : new Date(plain[field]);
      }
    }
    observed.set(String(plain.id), plain);
  }
  return observed;
}

/**
 * Reads EVERY active table's full row set once through the public runtime.
 *
 * The public runtime reads also prove the mapped schema exists (a dropped
 * table or column throws), so the failure is wrapped in the stable
 * `--resume failed: ...` schema reason. The same row set feeds BOTH the
 * DB-backed probe evidence (buildProbeEvidence) and the exact DB proof
 * (verifyResumeDatabaseContent), so a resumed run reads the authority
 * exactly once per resume path.
 *
 * @returns {Promise<Map<string, Map<string, object>>>} rows by table name.
 */
async function readObservedRows(hikoutei, activeEntities, tokenByEntity) {
  const observedByTable = new Map();
  for (const entry of activeEntities) {
    let observed;
    try {
      observed = await readTableRows(hikoutei, tokenByEntity, entry);
    } catch (error) {
      throw new Error(
        `--resume failed: soak.sqlite schema for table ${entry.tableName} could ` +
        `not be read (${stableErrorTag(error)}); the authority does not match ` +
        "the run's entities",
      );
    }
    observedByTable.set(entry.tableName, observed);
  }
  return observedByTable;
}

/**
 * MEDIUM 4: verifies the EXISTING authority's schema READ-ONLY before any
 * runtime opens.
 *
 * The runtime's open applies a NON-DESTRUCTIVE schema update (missing
 * tables/columns are recreated), so a dropped entity table or column would
 * be silently healed and then pass the row/content verification whenever
 * zero rows are expected for it. This inspection therefore opens the SQLite
 * file read-only (metadata only, never mutating) and fails the resume with
 * a stable reason when any active entity table or column is missing — the
 * operator starts a fresh run instead of resuming against a drifted
 * authority. Public runtime creation behavior is unchanged.
 *
 * @param {string} dbName absolute path of `soak.sqlite`.
 * @param {object[]} activeEntities resolved active entities in order.
 * @returns {Promise<void>} throws with a stable `--resume failed: ...`
 *   reason listing the missing tables/columns.
 */
async function validateResumeDatabaseSchema(dbName, activeEntities) {
  const expected = activeEntities.map((entry) => ({
    tableName: entry.tableName,
    columns: soakTableColumns(SOAK_FIELD_PLANS[entry.name]),
  }));
  const observed = inspectSqliteSchema(dbName);
  const missing = missingSchemaEntries(observed, expected);
  if (missing.tables.length === 0 && missing.columns.length === 0) return;
  const parts = [];
  if (missing.tables.length > 0) {
    parts.push(`table(s) ${missing.tables.join(", ")}`);
  }
  if (missing.columns.length > 0) {
    parts.push(`column(s) ${missing.columns.join(", ")}`);
  }
  throw new Error(
    `--resume failed: soak.sqlite schema is missing ${parts.join(" and ")}; ` +
    "the authority does not match the run's entities (start a fresh run without --resume)",
  );
}

/**
 * HIGH 1: verifies the SQLite authority FILE before the runtime opens.
 *
 * A resumed run must never silently recreate an empty authority: opening
 * a missing database file would create it, so this check runs BEFORE any
 * runtime opens. The file must exist, be a regular file, and be non-empty;
 * anything else fails the resume with a stable reason and the operator
 * starts a fresh run instead.
 *
 * Symlink safety (Luna review): the checks use `lstat`, so a symlinked
 * `soak.sqlite` is REJECTED before any inspection or open — the read-only
 * schema inspection and the runtime open must never follow the link onto
 * an external database. The WAL/journal/shm sidecars are checked the same
 * way: a symlinked sidecar would let SQLite read or write an external
 * file, so any symlinked sidecar rejects the resume too. The external
 * targets are never inspected, opened, or mutated.
 *
 * @param {string} dbName absolute path of `soak.sqlite`.
 * @returns {Promise<void>} throws with a stable `--resume failed: ...`
 *   reason when the authority file is missing, a symlink, non-regular,
 *   or empty, or when a sidecar is a symlink.
 */
async function validateResumeDatabaseFile(dbName) {
  const info = await lstat(dbName).catch(() => undefined);
  if (info === undefined) {
    throw new Error(
      "--resume failed: soak.sqlite does not exist; refusing to recreate an " +
      "empty authority (start a fresh run without --resume)",
    );
  }
  if (info.isSymbolicLink()) {
    throw new Error(
      "--resume failed: soak.sqlite is a symbolic link; refusing to inspect " +
      "or open an external database (start a fresh run without --resume)",
    );
  }
  if (!info.isFile()) {
    throw new Error("--resume failed: soak.sqlite is not a regular file");
  }
  if (info.size <= 0) {
    throw new Error(
      "--resume failed: soak.sqlite is empty; refusing to recreate an empty " +
      "authority (start a fresh run without --resume)",
    );
  }
  // Sidecars must not be symlinks either: SQLite could follow a
  // symlinked -wal/-journal/-shm onto an external file during the
  // read-only inspection or the runtime open.
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    const sidecarPath = `${dbName}${suffix}`;
    const sidecarInfo = await lstat(sidecarPath).catch(() => undefined);
    if (sidecarInfo?.isSymbolicLink()) {
      throw new Error(
        `--resume failed: ${path.basename(sidecarPath)} is a symbolic link; ` +
        "refusing to inspect or open an external database sidecar (start a " +
        "fresh run without --resume)",
      );
    }
  }
}

/** SQLite sidecar suffixes the runner owns next to `soak.sqlite`. */
const SQLITE_SIDECAR_SUFFIXES = Object.freeze(["-wal", "-journal", "-shm"]);

/**
 * HIGH 1: verifies the resumed authority's CONTENT via public runtime
 * reads, before any workload mutation.
 *
 * SQLite is the authority and the deterministic replay is the oracle of
 * what it MUST contain. The stored seed/params are replayed exactly
 * (prologue + up-front actor planning + deterministic final row sets), so
 * every row of every checkpointed cycle is verified by ID AND content:
 *
 * - completed cycles (records without an abort, plus reopen/deadline
 *   aborts whose FULL extent is provable) must be present EXACTLY — a
 *   missing, foreign, or same-count-mutated row fails the resume,
 * - an in-flight cycle WITH a recorded non-aborted record (the
 *   completed-cycle-checkpoint recovery) is treated as a COMPLETED cycle:
 *   its full deterministic row set (prologue rows plus every planned
 *   actor row) must be present with exact content — a missing, tampered,
 *   or partial row fails closed instead of passing as a plausible
 *   interrupted prefix (HIGH 1),
 * - an interrupted cycle (in-flight marker for lastCompletedCycle + 1
 *   without a record, or an ambiguous abort) may only contain rows from
 *   its deterministic planned set — prologue main/churn rows in one of
 *   their committed stages plus a subset of the planned actor rows — each
 *   with exact content; any other id is a foreign/impossible row. An
 *   actor row caught between an operation's own flushes is accepted only
 *   when it matches that exact operation's deterministic stage candidates
 *   (the two-flush forkIsolation op contributes its pre-patch AND
 *   post-patch rows; everything else exactly one row), so a crash after
 *   forkA.flush() but before forkB.flush() is a recoverable committed
 *   stage — never arbitrary content,
 * - per-table stage rules (a churn row only with its main row, a
 *   pre-patch main row implies the churn row, actor rows require the
 *   prologue completed) and the cross-table sequential-prefix rule bound
 *   the committed extent of an interrupted cycle,
 * - an abort cycle whose committed extent cannot be proven
 *   deterministically fails CLOSED — the `>=` escape hatch is gone.
 *
 * @param {object} state validated resume state.
 * @param {object[]} activeEntities resolved active entities in order.
 * @param {object} replay precomputed deterministic replay (pure function
 *   of the stored seed/params; never derived from SQLite), built with the
 *   same `observedByTable` the caller passes here as its probe evidence.
 * @param {Map<string, Map<string, object>>} observedByTable observed
 *   full row sets of every active table, read once by the caller (public
 *   runtime reads that also prove the mapped schema exists).
 * @returns {Promise<void>} throws with a stable `--resume failed: ...`
 *   reason on the first integrity violation.
 */
async function verifyResumeDatabaseContent(
  state,
  activeEntities,
  replay,
  observedByTable,
) {
  if (replay.ambiguousAbortCycles.length > 0) {
    throw new Error(
      `--resume failed: cycle ${replay.ambiguousAbortCycles[0]} has an abort ` +
      "record whose committed extent cannot be proven deterministically; the " +
      "authority integrity cannot be guaranteed (start a fresh run without --resume)",
    );
  }

  // The checkpointed state counters must equal the deterministic replay of
  // the checkpointed cycles exactly (SQLite is never silently reconciled
  // against a drifted state document). The replay snapshots the full row
  // count (main + actor rows) at the last checkpointed cycle. HIGH 2: a
  // zero-cycle state carries the initial EMPTY tableRows set, so every
  // table's checkpointed count is implicitly 0.
  for (const entry of activeEntities) {
    const replayed = replay.checkpointTableRows[entry.tableName];
    const recorded = state.lastCompletedCycle === 0
      ? 0
      : state.tableRows[entry.tableName];
    if (recorded !== replayed) {
      throw new Error(
        `--resume failed: state.tableRows for table ${entry.tableName} is ` +
        `${recorded}, but the deterministic replay of the checkpointed cycles ` +
        `implies ${replayed}; the state contradicts the recorded history`,
      );
    }
  }

  // The caller read every active table's full row set once (public
  // runtime reads that also prove the mapped schema exists — a dropped
  // table or column throws there) and derived the probe evidence from the
  // same rows, so this verification consumes them without a second read.
  // The observed row set was checked for probe evidence BEFORE this
  // function ran (requireProbeEvidenceOrFail), and the evidence-gated
  // replay above is exactly consistent with these rows.

  const prefixPlansByTable = new Map();
  for (const prefixCycle of replay.prefixCycles) {
    for (const [tableName, plan] of prefixCycle.byTable) {
      let list = prefixPlansByTable.get(tableName);
      if (list === undefined) {
        list = [];
        prefixPlansByTable.set(tableName, list);
      }
      list.push(plan);
    }
  }

  for (const entry of activeEntities) {
    const fieldPlan = SOAK_FIELD_PLANS[entry.name];
    const observed = observedByTable.get(entry.tableName);
    const exact = replay.exactRowsByTable.get(entry.tableName) ?? new Map();

    // Exact rows: every checkpointed row must exist with one of its
    // deterministic contents.
    for (const [id, contents] of exact) {
      const row = observed.get(id);
      if (row === undefined) {
        throw new Error(
          `--resume failed: soak.sqlite row set for table ${entry.tableName} is ` +
          `missing rows expected from state.tableRows (found ${observed.size} ` +
          `rows, expected ${exact.size} checkpointed rows)`,
        );
      }
      if (!contents.some((content) => rowValuesEqual(content, row, fieldPlan))) {
        throw new Error(
          `--resume failed: soak.sqlite row ${id} in table ${entry.tableName} has ` +
          "content that does not match the deterministic state; the authority " +
          "was modified (same-count mutation)",
        );
      }
    }

    // Interrupted-cycle rows: every observed row must be a deterministic
    // planned row with exact content; anything else is foreign/impossible.
    const prefixPlans = prefixPlansByTable.get(entry.tableName) ?? [];
    const allowedIds = new Set();
    for (const plan of prefixPlans) {
      allowedIds.add(String(plan.mainId));
      allowedIds.add(String(plan.churnId));
      for (const id of plan.actorRows.keys()) allowedIds.add(id);
    }
    for (const [id, row] of observed) {
      if (exact.has(id)) continue;
      if (!allowedIds.has(id)) {
        throw new Error(
          `--resume failed: soak.sqlite table ${entry.tableName} contains row ` +
          `${id} which no deterministic cycle of this run can produce; the ` +
          "authority contains a foreign or impossible row",
        );
      }
      if (!matchAllowedPrefixRow(prefixPlans, id, row, fieldPlan)) {
        throw new Error(
          `--resume failed: soak.sqlite row ${id} in table ${entry.tableName} has ` +
          "content that does not match the deterministic interrupted-cycle state",
        );
      }
    }

    // Per-table interrupted-cycle stage rules: a churn row exists only
    // with its main row, a pre-patch main row implies the churn row was
    // committed atomically with it, and actor rows require the prologue to
    // have fully completed for this table.
    for (const plan of prefixPlans) {
      const mainPresent = observed.has(String(plan.mainId));
      const churnPresent = observed.has(String(plan.churnId));
      const actorPresent = [...plan.actorRows.keys()].some((id) => observed.has(id));
      if (!mainPresent) {
        if (churnPresent) {
          throw new Error(
            `--resume failed: table ${entry.tableName} has an interrupted-cycle ` +
            "churn row without its main row; impossible committed state",
          );
        }
        if (actorPresent) {
          throw new Error(
            `--resume failed: table ${entry.tableName} has actor rows before its ` +
            "interrupted-cycle prologue completed; impossible committed state",
          );
        }
        continue;
      }
      const mainRow = observed.get(String(plan.mainId));
      if (rowValuesEqual(plan.mainPre, mainRow, fieldPlan)) {
        // Stage 1: inserted but not yet patched — the churn row was
        // committed in the same flush, so it must still exist.
        if (!churnPresent) {
          throw new Error(
            `--resume failed: table ${entry.tableName} has a pre-patch ` +
            "interrupted-cycle main row without its churn row; impossible " +
            "committed state",
          );
        }
      }
      if (actorPresent && churnPresent) {
        throw new Error(
          `--resume failed: table ${entry.tableName} has actor rows while the ` +
          "interrupted-cycle prologue is incomplete; impossible committed state",
        );
      }
    }
  }

  // Cross-table interrupted-cycle stage prefix: the prologue processes the
  // active tables sequentially, so committed stages must form a prefix
  // [done, ..., done, partial, untouched, ...], and ANY actor row implies
  // every table's prologue fully completed.
  for (const prefixCycle of replay.prefixCycles) {
    let partialSeen = false;
    let actorRowsSeen = false;
    for (const entry of activeEntities) {
      const plan = prefixCycle.byTable.get(entry.tableName);
      const observed = observedByTable.get(entry.tableName);
      const mainPresent = observed.has(String(plan.mainId));
      const churnPresent = observed.has(String(plan.churnId));
      const actorPresent = [...plan.actorRows.keys()].some((id) => observed.has(id));
      if (actorPresent) actorRowsSeen = true;
      // Stage 1/2 are both "partial": the cross-table rule only needs to
      // know whether the table's prologue fully completed.
      const stage = !mainPresent ? 0 : churnPresent ? 2 : 3;
      if (partialSeen && stage !== 0) {
        throw new Error(
          `--resume failed: interrupted cycle ${prefixCycle.cycle} committed ` +
          `table ${entry.tableName} while an earlier table's prologue was still ` +
          "unfinished; the committed extent is impossible",
        );
      }
      if (stage < 3) partialSeen = true;
    }
    if (actorRowsSeen && partialSeen) {
      throw new Error(
        `--resume failed: interrupted cycle ${prefixCycle.cycle} has actor rows ` +
        "but an incomplete prologue; impossible committed state",
      );
    }
  }
}

// Cross-module helpers split out of the monolithic runner.
// Database/open + resume-authority helpers consumed by execute and runner.
export {
  delayOpenPastDeadline,
  inFlightCycleFromCheckpoint,
  openRuntime,
  readObservedRows,
  validateResumeDatabaseFile,
  validateResumeDatabaseSchema,
  verifyResumeDatabaseContent,
};
