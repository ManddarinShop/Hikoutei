/**
 * Redacted finale/close helpers: the final summary builder and the
 * final-retry runtime close. Depends only on errors/redact/performance.
 */
import { performance } from "node:perf_hooks";
import { describeError } from "./errors.mjs";
import {
  sanitizeErrorClass,
  sanitizeReason,
  sanitizeStableCode,
} from "./redact.mjs";

/** Builds the redacted final summary object. */
function buildSummary({
  state,
  stopReason,
  startedClock,
  live,
  closeError,
  replacementCloseError,
  finalizationFailures = [],
}) {
  const status =
    stopReason === "max-consecutive-failures" ||
    stopReason === "reopen-failed" ||
    stopReason === "simulated-interruption" ||
    replacementCloseError !== undefined ||
    finalizationFailures.length > 0 ||
    state.cumulative.failures > 0
      ? "failed"
      : "passed";
  const described = closeError === undefined ? undefined : describeError(closeError);
  const replacementDescribed =
    replacementCloseError === undefined ? undefined : describeError(replacementCloseError);
  const finalizationDescribed =
    finalizationFailures.length === 0 ? undefined : describeError(finalizationFailures[0].error);
  return {
    scenario: "local-multitable-soak",
    scenarioVersion: 1,
    status,
    mode: live.mode,
    stopReason,
    seed: state.seed,
    startedAt: new Date(state.startedAtMs).toISOString(),
    finishedAt: new Date().toISOString(),
    elapsedMs: Math.round(performance.now() - startedClock),
    durationBudgetMs: state.params.durationMs,
    cyclesCompleted: state.lastCompletedCycle,
    operations: {
      total: state.cumulative.operations,
      ok: state.cumulative.operations - state.cumulative.expectedErrors - state.cumulative.failures,
      expectedErrors: state.cumulative.expectedErrors,
      failures: state.cumulative.failures,
      retries: state.cumulative.retries,
    },
    probes: state.cumulative.probes,
    convergence: {
      checks: state.cumulative.convergenceChecks,
      failed: state.cumulative.convergenceFailed,
    },
    tableRows: state.tableRows,
    // Recovery section: a resume reconciled an interrupted run. The reason
    // is a fixed vocabulary value and the cycle a number — never an id,
    // path, or message. Present only when the state records a recovery.
    ...(state.recovery === undefined ? {} : {
      recovery: {
        status: "recovered",
        cycle: state.recovery.cycle,
        reason: sanitizeReason(state.recovery.reason),
      },
    }),
    // Stable cleanup-failure section: a runtime close failure after the
    // loop ended makes the run failed with a fixed reason and the
    // allowlisted class/code — never the raw message.
    ...(described === undefined ? {} : {
      cleanup: {
        status: "failed",
        reason: "runtime-close-failed",
        errorClass: sanitizeErrorClass(described.errorClass),
        ...(described.code === undefined ? {} : { code: sanitizeStableCode(described.code) }),
      },
    }),
    // A replacement runtime that could not be closed after a failed
    // reopen handoff: the run is already failed (reopen-failed) and the
    // close failure is recorded here with a stable redacted reason — an
    // unclosable opened replacement is never reported silently.
    ...(replacementDescribed === undefined ? {} : {
      replacementCleanup: {
        status: "failed",
        reason: "replacement-close-failed",
        errorClass: sanitizeErrorClass(replacementDescribed.errorClass),
        ...(replacementDescribed.code === undefined ? {} : { code: sanitizeStableCode(replacementDescribed.code) }),
      },
    }),
    // A final artifact write/collection failure: the run is failed with
    // the stable failing step label and redacted error — never a silent
    // passed summary when finalization did not fully land.
    ...(finalizationDescribed === undefined ? {} : {
      finalization: {
        status: "failed",
        reason: "artifact-write-failed",
        step: finalizationFailures[0].label,
        errorClass: sanitizeErrorClass(finalizationDescribed.errorClass),
        ...(finalizationDescribed.code === undefined ? {} : { code: sanitizeStableCode(finalizationDescribed.code) }),
      },
    }),
  };
}

/**
 * Closes one runtime with a final second attempt on failure.
 *
 * A runtime that fails to close is never silently discarded: the first
 * failure triggers one final close attempt. Because Hikoutei close() is
 * retryable (a failed close leaves the runtime open), the retry genuinely
 * re-runs the provider cleanup instead of no-oping — a real first-attempt
 * close failure can therefore recover, and only a persistent failure is
 * returned so the caller records a stable cleanup failure and forces the
 * summary to failed.
 *
 * Failure tracking uses a BOOLEAN flag, never `error !== undefined`: a
 * close that rejects with a non-Error value (a hook or provider that
 * throws `undefined`) is still a FAILED close and is reported as such —
 * it must never masquerade as a successful close. When the thrown value
 * is not an Error, a stable synthetic Error is returned so every caller
 * can branch on `error !== undefined` without losing the failure.
 *
 * Test injection (`__test*` options): with `failClose`, the FIRST attempt
 * fails before the real close runs (a simulated provider cleanup failure)
 * and the final retry genuinely invokes the runtime close, so a run can
 * recover. With `failClosePersistent`, the first attempt fails before the
 * real close AND the retry — which genuinely ran the provider cleanup —
 * still reports failure, so a persistent close failure keeps failing the
 * run. `failClose` mirrors `__testCloseFail`; `failClosePersistent` mirrors
 * `__testCloseFailPersistent` and `__testFailReplacementClose`.
 *
 * @param {{ close(): Promise<unknown> }} runtime
 * @param {{ failClose?: boolean, failClosePersistent?: boolean }} [options]
 * @returns {Promise<Error | undefined>} the close error when both
 *   attempts failed, or `undefined` when a close succeeded.
 */
export async function closeRuntimeWithFinalRetry(runtime, options = {}) {
  const persistent = options.failClosePersistent === true;
  let failed = false;
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      if (persistent) {
        // Persistent injection: the FIRST attempt fails before the real
        // close (simulating a provider cleanup failure). The retry below
        // genuinely runs the real close and then reports the injected
        // failure, so a persistent close failure still fails the run while
        // the provider cleanup really was re-invoked (never a masked pass,
        // never a leaked runtime).
        if (attempt === 0) {
          throw new Error("soak-test-injected-close-failure");
        }
      } else if (options.failClose === true && attempt === 0) {
        // First-attempt injection: fail before the real close, leaving the
        // runtime open so the final retry genuinely re-invokes the runtime
        // close (provider cleanup) and can recover.
        throw new Error("soak-test-injected-close-failure");
      }
      await runtime.close();
      if (persistent) {
        // The retry genuinely ran the provider cleanup (the real close
        // succeeded) but the injected failure persists: the run must still
        // report a stable cleanup failure, never a masked pass.
        throw new Error("soak-test-injected-close-failure");
      }
      return undefined;
    } catch (error) {
      failed = true;
      lastError = error;
    }
  }
  if (!failed) return undefined;
  // A thrown non-Error value (including `undefined`) is still a failure;
  // normalize it so callers can branch on a defined error.
  return lastError instanceof Error
    ? lastError
    : new Error("runtime close failed with a non-Error rejection");
}

// Cross-module helpers split out of the monolithic runner.
// Final redacted summary builder consumed by runner.mjs.
export {
  buildSummary,
};
