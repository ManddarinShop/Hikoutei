/**
 * Soak runner shared constants, recovery reasons, and stable error classes.
 * Leaf module: no dependency on any other soak module.
 */

/** Probe and reopen cadence from the approved plan. */
const PROBE_EVERY_CYCLES = 10;
const REOPEN_EVERY_CYCLES = 60;
/**
 * Minimum remaining budget before a reopen cycle may START.
 *
 * A reopen handoff (full scan + close + replacement open + verify) takes
 * tens of milliseconds; starting one when the budget is nearly exhausted
 * would cross the deadline mid-open and fail the run with the stable
 * `deadline_expired` class even though every mid-run reopen ran. The loop
 * therefore stops cleanly on the budget instead of starting a doomed
 * reopen — the run never claims the reopen ran, and it never fails for a
 * deadline it could not have met.
 */
const REOPEN_BUDGET_MARGIN_MS = 500;
/** Bounded retries for one operation before it counts as a failure. */
const OPERATION_ATTEMPTS = 3;
/** Live convergence budget per cycle. */
const CONVERGENCE_TIMEOUT_MS = 180_000;
export const CONVERGENCE_POLL_MS = 5_000;
/** Human-edit acceptance budget. */
const PROBE_ACCEPT_TIMEOUT_MS = 90_000;
export const PROBE_ACCEPT_POLL_MS = 3_000;
/** SQLite-only poll cadence of the System_State drain barrier (live mode). */
export const SYSTEM_STATE_READINESS_POLL_MS = 250;

/**
 * System_State tombstone header marking durable deleted-row history.
 *
 * System_State intentionally RETAINS deleted entities as rows whose
 * `__typed_sheets_deleted` cell displays boolean true; those rows are
 * history, not active projections, so convergence must exclude them from
 * the active id set instead of counting them as extra rows.
 */
const TOMBSTONE_HEADER = "__typed_sheets_deleted";

/** Version of the checkpoint marker schema (atomic, per-cycle). */
const CHECKPOINT_VERSION = 1;

/**
 * Grammar of generated run ids: `soak-` followed by lowercase base36
 * (the runner generates `soak-${Date.now().toString(36)}`). Resume
 * validation applies this grammar to state.runId AND checkpoint.runId so
 * secret-like, corrupt, or foreign run ids (tokens, URLs, emails, paths)
 * can never be accepted as the run identity of a resumed artifact set.
 */
const RUN_ID_PATTERN = /^soak-[0-9a-z]{4,32}$/;

/**
 * Stable recovery reasons recorded (redacted) in state/summary when a
 * resume repairs an interrupted run. Each reason is a fixed vocabulary
 * value, never derived from a path, id, or message.
 */
export const RECOVERY_REASONS = Object.freeze({
  /** The in-flight cycle's SQLite effects were reconciled by re-running it. */
  INTERRUPTED_CYCLE_RECONCILED: "interrupted-cycle-reconciled",
  /** The cycle fully completed but its state checkpoint never landed. */
  COMPLETED_CYCLE_CHECKPOINT: "completed-cycle-checkpoint",
  /** The completed marker lagged behind an already-checkpointed cycle. */
  STALE_IN_FLIGHT_MARKER: "stale-in-flight-marker",
});
const KNOWN_RECOVERY_REASONS = new Set(Object.values(RECOVERY_REASONS));

/**
 * Safe epoch-millis domain for `Date.prototype.toISOString()`: the ECMAScript
 * time range is +/- 8.64e15 ms (~ +/- 100 million days). A stored timestamp
 * outside this range would make `new Date(ms).toISOString()` throw at summary
 * build time, so resume validation rejects it before the runtime opens.
 */
const DATE_ISO_MIN_MS = -8_640_000_000_000_000;
const DATE_ISO_MAX_MS = 8_640_000_000_000_000;

/**
 * True when a value is a finite epoch-millis timestamp that
 * `new Date(value).toISOString()` can safely render.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSafeEpochTimestampMs(value) {
  return typeof value === "number" && Number.isFinite(value) &&
    value >= DATE_ISO_MIN_MS && value <= DATE_ISO_MAX_MS;
}

/**
 * Test-only sentinel for a SIMULATED PROCESS INTERRUPTION inside a cycle.
 *
 * Thrown by the `__testInterruptDuringCycle` injection after the cycle's
 * prologue SQLite work committed. Unlike a normal escaping exception, it
 * is NOT converted into an abort record: the runner leaves the in-flight
 * marker in place and stops without a cycle record, exactly like a
 * process that died mid-cycle. A subsequent --resume then exercises the
 * INTERRUPTED_CYCLE_RECONCILED recovery path.
 */
class SoakSimulatedInterruptionError extends Error {
  constructor() {
    super("soak-test-injected-interruption");
    this.name = "SoakSimulatedInterruptionError";
  }
}

/**
 * Marks a reopen-cycle cleanup failure: the previous runtime was closed (or
 * its close was attempted) but the replacement never became the current
 * runtime. No runtime remains to continue with, so the runner records the
 * abort and stops with a stable reason instead of looping against a closed
 * runtime or ever reporting success. The original error is carried only as
 * `cause`; diagnostics print the allowlisted class name, never the message.
 *
 * When the replacement runtime had ALREADY opened before the handoff
 * failed, it stays attached as `runtime`: the runner tracks it as an open
 * runtime and the outer finalizer closes it (with a final retry), so an
 * opened replacement can never leak silently.
 */
class SoakReopenCleanupError extends Error {
  constructor(cause, runtime) {
    super("soak reopen cleanup failed: previous runtime closed, replacement not opened");
    this.name = "SoakReopenCleanupError";
    this.cause = cause;
    this.runtime = runtime;
    // The wrapped failure's stable reason category (when it carries one,
    // e.g. `deadline-expired`) surfaces in the redacted abort record;
    // everything else keeps the fixed `reopen-cleanup-failed` category.
    this.reasonCode = cause !== null && typeof cause === "object" &&
      typeof cause?.reasonCode === "string"
      ? cause.reasonCode
      : "reopen-cleanup-failed";
  }
}

/**
 * Marks a startup/reopen that returned AFTER the run's epoch deadline.
 *
 * The runtime that finished opening past the budget is closed (best
 * effort, with the final retry) and this stable error is raised instead:
 * the run must never claim it stayed within budget when the sync startup
 * consumed the whole deadline. The `statusClass` is the allowlisted
 * `deadline_expired` category; the message is never printed.
 */
class SoakDeadlineExpiredError extends Error {
  /**
   * @param {object | undefined} runtime the runtime that finished opening
   *   past the budget (undefined when the open itself threw).
   * @param {Error | undefined} closeError the deadline-gated close's own
   *   persistent failure (both attempts failed), or undefined.
   */
  constructor(runtime, closeError) {
    super("soak startup finished after the run deadline expired");
    this.name = "SoakDeadlineExpiredError";
    this.statusClass = "deadline_expired";
    this.reasonCode = "deadline-expired";
    // HIGH 3: the opened runtime is ALWAYS carried (never discarded), so
    // the caller can track it even when the deadline-gated close attempt
    // failed — every late-open handle is closed again with retry before
    // the run exits, never a leaked lease and never a silent discard.
    this.runtime = runtime;
    // The deadline-gated close's persistent failure: when set, the runtime
    // may still be open, so the caller must close it again with retry.
    this.closeError = closeError;
  }
}


// Cross-module exports: the shared cadence constants, stable error classes,
// and recovery definitionals moved out of the monolithic runner. Several of
// these were plain module-local declarations in the original runner; they are
// exported here so the split runner modules can import them without cycles.
export {
  CHECKPOINT_VERSION,
  CONVERGENCE_TIMEOUT_MS,
  KNOWN_RECOVERY_REASONS,
  OPERATION_ATTEMPTS,
  PROBE_ACCEPT_TIMEOUT_MS,
  PROBE_EVERY_CYCLES,
  REOPEN_BUDGET_MARGIN_MS,
  REOPEN_EVERY_CYCLES,
  RUN_ID_PATTERN,
  SoakDeadlineExpiredError,
  SoakReopenCleanupError,
  SoakSimulatedInterruptionError,
  TOMBSTONE_HEADER,
};
