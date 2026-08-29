/**
 * Resume STATE/CHECKPOINT validation and the recovery planner for the
 * soak runner. Split from the resume facade (validation/history/
 * recording) so each module stays review-sized; `resume.mjs` re-exports
 * the shared surface. Uses the redaction allowlists, never runtime
 * values. No cycle with execute or probe.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { MAX_DURATION_HOURS } from "./args.mjs";
import {
  CHECKPOINT_VERSION,
  isSafeEpochTimestampMs,
  KNOWN_RECOVERY_REASONS,
  RECOVERY_REASONS,
  RUN_ID_PATTERN,
} from "./constants.mjs";
import { KNOWN_TABLE_NAMES } from "./redact.mjs";

export function validateResumeState(stored, mode) {
  const fail = (message) => {
    throw new Error(`--resume failed: ${message}`);
  };
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) {
    fail("state.json must contain a single JSON object");
  }
  const record = stored;
  const topLevelFields = new Set([
    "version", "runId", "seed", "mode", "startedAtMs", "params",
    "lastCompletedCycle", "cumulative", "tableRows",
    "recovery", "finalization", "cleanup", "replacementCleanup",
  ]);
  for (const key of Object.keys(record)) {
    if (!topLevelFields.has(key)) fail(`unknown top-level field "${key}"`);
  }
  if (record.version !== 1) {
    fail(`state version ${record.version ?? "missing"} is not supported`);
  }
  if (typeof record.runId !== "string" || record.runId.length === 0) {
    fail("state.runId must be a non-empty string");
  }
  // MEDIUM 7: run ids follow the generated grammar (`soak-<base36>`); a
  // secret-like or corrupt run id (a token, URL, email, or path that
  // merely parses as a string) must never be accepted as the run identity.
  if (!RUN_ID_PATTERN.test(record.runId)) {
    fail("state.runId does not match the generated soak run id grammar");
  }
  // The PRNG contract: seeds are 32-bit integers in [0, 2^32-1].
  if (!Number.isSafeInteger(record.seed) || record.seed < 0 || record.seed > 0xffffffff) {
    fail("state.seed must be an integer in [0, 4294967295]");
  }
  if (record.mode !== "local" && record.mode !== "live") {
    fail('state.mode must be "local" or "live"');
  }
  if (record.mode !== mode) {
    fail(`state.mode "${record.mode}" does not match the current environment (${mode})`);
  }
  // buildSummary renders `new Date(startedAtMs).toISOString()`; a timestamp
  // outside the ECMAScript date range would throw there, so it is rejected
  // here before any runtime opens.
  if (!isSafeEpochTimestampMs(record.startedAtMs)) {
    fail("state.startedAtMs must be a finite epoch timestamp within the ISO date range");
  }
  if (!Number.isInteger(record.lastCompletedCycle) || record.lastCompletedCycle < 0) {
    fail("state.lastCompletedCycle must be a non-negative integer");
  }
  validateResumeParams(record.params, fail);
  validateResumeCumulative(record.cumulative, fail);
  validateResumeTableRows(record.tableRows, record.params, record.lastCompletedCycle, fail);
  validateResumeRecovery(record.recovery, fail);
  validateResumeFinalization(record.finalization, fail);
  validateResumeCleanupMarker(record.cleanup, "cleanup", "runtime-close-failed", fail);
  validateResumeCleanupMarker(
    record.replacementCleanup,
    "replacementCleanup",
    "replacement-close-failed",
    fail,
  );
  if (record.seed !== record.params.seed) {
    fail("state.seed must equal state.params.seed");
  }
  // Cross-field bounds: every completed cycle contributes at least one
  // operation, at most one probe, and at most one convergence check, so
  // cumulative counters can never exceed the completed cycles.
  if (record.cumulative.operations < record.lastCompletedCycle) {
    fail("state.cumulative.operations cannot be smaller than lastCompletedCycle");
  }
  if (record.cumulative.probes.total > record.lastCompletedCycle) {
    fail("state.cumulative.probes.total cannot exceed lastCompletedCycle");
  }
  if (record.cumulative.convergenceChecks > record.lastCompletedCycle) {
    fail("state.cumulative.convergenceChecks cannot exceed lastCompletedCycle");
  }
}

/** Validates the params section of a resume state. */
function validateResumeParams(params, fail) {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    fail("state.params must be an object");
  }
  const knownParams = new Set([
    "seed", "durationMs", "intervalSeconds", "actors",
    "operationsPerActor", "resolvedTables", "maxConsecutiveFailures",
  ]);
  for (const key of Object.keys(params)) {
    if (!knownParams.has(key)) fail(`unknown state.params field "${key}"`);
  }
  if (!Number.isSafeInteger(params.seed) || params.seed < 0 || params.seed > 0xffffffff) {
    fail("state.params.seed must be an integer in [0, 4294967295]");
  }
  // CLI parity: --duration-hours and --interval-seconds accept ANY finite
  // numeric form (fractions included), and resume validation must accept
  // exactly those forms with the same bounds — never reject a state a CLI
  // run produced, and never coerce/round the stored values on resume.
  if (!Number.isFinite(params.durationMs) || params.durationMs <= 0 ||
      params.durationMs > MAX_DURATION_HOURS * 3_600_000) {
    fail("state.params.durationMs must be a positive number of at most 24 hours");
  }
  if (!Number.isFinite(params.intervalSeconds) || params.intervalSeconds < 0) {
    fail("state.params.intervalSeconds must be a non-negative number");
  }
  // CLI parity with EXACT ceilings: --actors caps at 64, and
  // --operations-per-actor and --max-consecutive-failures cap at 1000
  // (see args.mjs parsePositiveInt). Resume validation must reject a state
  // whose params exceed what the CLI could ever have produced — never
  // coerce or silently accept an out-of-range workload.
  if (!Number.isInteger(params.actors) || params.actors < 1 || params.actors > 64) {
    fail("state.params.actors must be an integer in [1, 64]");
  }
  if (!Number.isInteger(params.operationsPerActor) || params.operationsPerActor < 1 ||
      params.operationsPerActor > 1000) {
    fail("state.params.operationsPerActor must be an integer in [1, 1000]");
  }
  if (!Number.isInteger(params.maxConsecutiveFailures) || params.maxConsecutiveFailures < 1 ||
      params.maxConsecutiveFailures > 1000) {
    fail("state.params.maxConsecutiveFailures must be an integer in [1, 1000]");
  }
  const { resolvedTables } = params;
  if (!Array.isArray(resolvedTables) || resolvedTables.length === 0) {
    fail("state.params.resolvedTables must name at least one table");
  }
  const knownTables = new Set(KNOWN_TABLE_NAMES);
  for (const table of resolvedTables) {
    if (typeof table !== "string" || !knownTables.has(table)) {
      fail("state.params.resolvedTables contains an unknown table");
    }
  }
  if (new Set(resolvedTables).size !== resolvedTables.length) {
    fail("state.params.resolvedTables must not repeat a table");
  }
}

/** Validates the cumulative counters section of a resume state. */
function validateResumeCumulative(cumulative, fail) {
  if (cumulative === null || typeof cumulative !== "object" || Array.isArray(cumulative)) {
    fail("state.cumulative must be an object");
  }
  const knownCounters = new Set([
    "operations", "expectedErrors", "failures", "retries", "probes",
    "convergenceChecks", "convergenceFailed",
    "scenarioExpectedErrors", "scenarioFailures",
  ]);
  for (const key of Object.keys(cumulative)) {
    if (!knownCounters.has(key)) fail(`unknown state.cumulative field "${key}"`);
  }
  for (const key of ["operations", "expectedErrors", "failures", "retries",
    "convergenceChecks", "convergenceFailed"]) {
    if (!Number.isInteger(cumulative[key]) || cumulative[key] < 0) {
      fail(`state.cumulative.${key} must be a non-negative integer`);
    }
  }
  // Scenario counters are OPTIONAL (a legacy state predating scenario
  // accounting omits them and defaults to zero); when present they must be
  // non-negative integers.
  for (const key of ["scenarioExpectedErrors", "scenarioFailures"]) {
    if (cumulative[key] !== undefined &&
        (!Number.isInteger(cumulative[key]) || cumulative[key] < 0)) {
      fail(`state.cumulative.${key} must be a non-negative integer`);
    }
  }
  // Consistency bounds: ok = operations - expectedErrors - failures can
  // never be negative, and failed convergence checks never exceed checks.
  if (cumulative.expectedErrors + cumulative.failures > cumulative.operations) {
    fail("state.cumulative.operations cannot be smaller than expectedErrors + failures");
  }
  if (cumulative.convergenceFailed > cumulative.convergenceChecks) {
    fail("state.cumulative.convergenceFailed cannot exceed convergenceChecks");
  }
  const probes = cumulative.probes;
  if (probes === null || typeof probes !== "object" || Array.isArray(probes)) {
    fail("state.cumulative.probes must be an object");
  }
  const knownProbeCounters = new Set(["total", "ok", "skipped", "failed"]);
  for (const key of Object.keys(probes)) {
    if (!knownProbeCounters.has(key)) fail(`unknown state.cumulative.probes field "${key}"`);
  }
  for (const key of knownProbeCounters) {
    if (!Number.isInteger(probes[key]) || probes[key] < 0) {
      fail(`state.cumulative.probes.${key} must be a non-negative integer`);
    }
  }
  // The probe counters must balance EXACTLY — every probe is ok, skipped,
  // or failed, no other outcome exists — and each counter must be a
  // non-negative integer. An unbalanced or fractional counter set is a
  // malformed state, not a merely-improbable one.
  if (probes.ok + probes.skipped + probes.failed !== probes.total) {
    fail("state.cumulative.probes.ok + skipped + failed must equal probes.total");
  }
}

/**
 * Validates the tableRows section of a resume state.
 *
 * HIGH 2: a zero-cycle state (lastCompletedCycle 0 — a run interrupted
 * during its FIRST cycle, or crashed before its first state checkpoint)
 * legitimately carries the initial empty tableRows set; demanding full
 * table coverage there would reject exactly the state the deterministic
 * reconciliation must recover. For any checkpointed run the row-count
 * section must cover EXACTLY the tables the run resolves.
 */
function validateResumeTableRows(tableRows, params, lastCompletedCycle, fail) {
  if (tableRows === null || typeof tableRows !== "object" || Array.isArray(tableRows)) {
    fail("state.tableRows must be an object");
  }
  const knownTables = new Set(KNOWN_TABLE_NAMES);
  for (const [table, count] of Object.entries(tableRows)) {
    if (!knownTables.has(table)) fail("state.tableRows contains an unknown table");
    if (!Number.isInteger(count) || count < 0) {
      fail("state.tableRows counts must be non-negative integers");
    }
  }
  if (lastCompletedCycle === 0) {
    if (Object.keys(tableRows).length !== 0) {
      fail("state.tableRows must be empty when lastCompletedCycle is 0");
    }
    return;
  }
  // The row-count section must cover EXACTLY the tables the run resolves:
  // a subset run tracks only its selection, never the full six.
  const expected = new Set(params.resolvedTables);
  const actual = new Set(Object.keys(tableRows));
  if (actual.size !== expected.size ||
      [...actual].some((table) => !expected.has(table))) {
    fail("state.tableRows must cover exactly the tables in state.params.resolvedTables");
  }
}

/**
 * Validates the optional recovery section of a resume state.
 *
 * The recovery record is written only by resume reconciliation; its cycle
 * must be a positive integer and its reason one of the fixed recovery
 * vocabulary values (never free text). Missing is fine (an uninterrupted
 * run has no recovery history).
 */
function validateResumeRecovery(recovery, fail) {
  if (recovery === undefined) return;
  if (recovery === null || typeof recovery !== "object" || Array.isArray(recovery)) {
    fail("state.recovery must be an object");
  }
  const knownRecoveryFields = new Set(["cycle", "reason"]);
  for (const key of Object.keys(recovery)) {
    if (!knownRecoveryFields.has(key)) fail(`unknown state.recovery field "${key}"`);
  }
  if (!Number.isInteger(recovery.cycle) || recovery.cycle < 1) {
    fail("state.recovery.cycle must be a positive integer");
  }
  if (typeof recovery.reason !== "string" || !KNOWN_RECOVERY_REASONS.has(recovery.reason)) {
    fail("state.recovery.reason must be a known recovery reason");
  }
}

/**
 * Validates the optional finalization section of a resume state.
 *
 * The ONLY finalization marker is the redacted failed one: it is persisted
 * (best effort) when the final artifact collection failed, and a state that
 * carries it must NEVER resume into a passed run. Resume therefore rejects
 * it with a stable reason — the operator starts a fresh run instead of a
 * later resume silently overwriting the failed finalization.
 */
function validateResumeFinalization(finalization, fail) {
  if (finalization === undefined) return;
  if (finalization === null || typeof finalization !== "object" || Array.isArray(finalization)) {
    fail("state.finalization must be an object");
  }
  const knownFinalizationFields = new Set(["status", "reason", "step"]);
  for (const key of Object.keys(finalization)) {
    if (!knownFinalizationFields.has(key)) {
      fail(`unknown state.finalization field "${key}"`);
    }
  }
  if (finalization.status !== "failed") {
    fail('state.finalization.status must be "failed"');
  }
  if (finalization.reason !== "artifact-write-failed") {
    fail('state.finalization.reason must be "artifact-write-failed"');
  }
  if (typeof finalization.step !== "string" || finalization.step.length === 0) {
    fail("state.finalization.step must be a non-empty string");
  }
  fail(
    "state.finalization marks the previous run as failed (final artifact " +
    "collection failed); start a fresh run instead of resuming",
  );
}

/**
 * Validates one optional close-failure marker section of a resume state.
 *
 * The cleanup/replacementCleanup markers are persisted (best effort) when
 * the final runtime close failed after the loop ended. A state that
 * carries either marker must NEVER resume into a passed run: resume
 * rejects it with a stable reason, exactly like the finalization marker —
 * the operator starts a fresh run instead of silently continuing a run
 * whose close (and cleanup-failure totals) never landed.
 */
function validateResumeCleanupMarker(marker, fieldName, expectedReason, fail) {
  if (marker === undefined) return;
  if (marker === null || typeof marker !== "object" || Array.isArray(marker)) {
    fail(`state.${fieldName} must be an object`);
  }
  const knownFields = new Set(["status", "reason", "errorClass", "code"]);
  for (const key of Object.keys(marker)) {
    if (!knownFields.has(key)) fail(`unknown state.${fieldName} field "${key}"`);
  }
  if (marker.status !== "failed") {
    fail(`state.${fieldName}.status must be "failed"`);
  }
  if (marker.reason !== expectedReason) {
    fail(`state.${fieldName}.reason must be "${expectedReason}"`);
  }
  if (typeof marker.errorClass !== "string" || marker.errorClass.length === 0) {
    fail(`state.${fieldName}.errorClass must be a non-empty string`);
  }
  if (marker.code !== undefined &&
      (typeof marker.code !== "string" || marker.code.length === 0)) {
    fail(`state.${fieldName}.code must be a non-empty string`);
  }
  fail(
    `state.${fieldName} marks the previous run as failed (the final runtime ` +
    "close failed); start a fresh run instead of resuming",
  );
}

/**
 * Loads and validates the atomic checkpoint marker for a resume.
 *
 * A missing marker is a normal uninterrupted resume. A present marker must
 * satisfy the exact schema (version, runId matching the state, cycle, and
 * status), otherwise resume fails with a stable reason before any runtime
 * opens — a corrupted marker means the recovery contract cannot be trusted.
 *
 * @returns {Promise<object | undefined>} validated marker, or undefined.
 */
export async function readCheckpointOrUndefined(artifacts, state) {
  if (!existsSync(artifacts.paths.checkpoint)) return undefined;
  let parsed;
  try {
    parsed = JSON.parse(await readFile(artifacts.paths.checkpoint, "utf8"));
  } catch {
    throw new Error("--resume failed: checkpoint.json is not valid JSON");
  }
  const fail = (message) => {
    throw new Error(`--resume failed: ${message}`);
  };
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail("checkpoint.json must contain a single JSON object");
  }
  const checkpoint = parsed;
  const knownCheckpointFields = new Set(["version", "runId", "cycle", "status"]);
  for (const key of Object.keys(checkpoint)) {
    if (!knownCheckpointFields.has(key)) fail(`unknown checkpoint field "${key}"`);
  }
  if (checkpoint.version !== CHECKPOINT_VERSION) {
    fail(`checkpoint version ${checkpoint.version ?? "missing"} is not supported`);
  }
  if (typeof checkpoint.runId !== "string" || checkpoint.runId.length === 0) {
    fail("checkpoint.runId must be a non-empty string");
  }
  // MEDIUM 7: the marker's run id must follow the generated grammar too;
  // a secret-like/corrupt id can never masquerade as the run identity.
  if (!RUN_ID_PATTERN.test(checkpoint.runId)) {
    fail("checkpoint.runId does not match the generated soak run id grammar");
  }
  if (checkpoint.runId !== state.runId) {
    fail("checkpoint.json belongs to a different run than state.json");
  }
  if (!Number.isInteger(checkpoint.cycle) || checkpoint.cycle < 1) {
    fail("checkpoint.cycle must be a positive integer");
  }
  if (checkpoint.status !== "in-flight" && checkpoint.status !== "completed") {
    fail('checkpoint.status must be "in-flight" or "completed"');
  }
  if (checkpoint.status === "completed" && checkpoint.cycle !== state.lastCompletedCycle) {
    fail("checkpoint.cycle must equal state.lastCompletedCycle for a completed checkpoint");
  }
  if (checkpoint.status === "in-flight" && checkpoint.cycle > state.lastCompletedCycle + 1) {
    fail("checkpoint.cycle cannot be ahead of state.lastCompletedCycle + 1");
  }
  // MEDIUM 6: an in-flight marker whose cycle is OLDER than the
  // checkpointed state can only be a leftover from an abandoned cycle; it
  // is rejected instead of ever being rewritten as completed. Only the
  // current completed marker (cycle == lastCompletedCycle, lagged behind
  // the state) or the next cycle's in-flight marker is accepted.
  if (checkpoint.status === "in-flight" && checkpoint.cycle < state.lastCompletedCycle) {
    fail("checkpoint.cycle cannot be older than state.lastCompletedCycle for an in-flight checkpoint");
  }
  return checkpoint;
}

/** Builds one checkpoint marker record (never contains run values). */
export function checkpointMarker(runId, cycle, status) {
  return { version: CHECKPOINT_VERSION, runId, cycle, status };
}

/**
 * Plans the resume recovery from the validated checkpoint.
 *
 * @param {object | undefined} checkpoint validated marker or undefined.
 * @param {object} state validated resume state.
 * @param {Map<number, object>} cycleRecords recorded cycle records by cycle.
 * @returns {{ cycle: number, reason: string } | undefined} the recovery to
 *   perform, or undefined when the checkpoint shows a clean handoff.
 */
export function planResumeRecovery(checkpoint, state, cycleRecords) {
  if (checkpoint === undefined || checkpoint.status === "completed") {
    return undefined;
  }
  const cycle = checkpoint.cycle;
  if (cycle <= state.lastCompletedCycle) {
    // State already checkpointed this cycle; only the marker lagged.
    return { cycle, reason: RECOVERY_REASONS.STALE_IN_FLIGHT_MARKER };
  }
  // cycle === lastCompletedCycle + 1: the interrupted cycle's SQLite work
  // may have committed. Its cycle record is the completion proof: present
  // means the cycle fully finished (only the state checkpoint lagged);
  // absent means it was interrupted mid-cycle and must be reconciled.
  return cycleRecords.has(cycle)
    ? { cycle, reason: RECOVERY_REASONS.COMPLETED_CYCLE_CHECKPOINT }
    : { cycle, reason: RECOVERY_REASONS.INTERRUPTED_CYCLE_RECONCILED };
}
