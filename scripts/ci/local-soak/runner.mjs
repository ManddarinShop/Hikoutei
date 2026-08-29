/**
 * Local multi-table soak runner — thin compatibility facade.
 *
 * All orchestration lives in `runnerOrchestration.mjs` (public run
 * entrypoint, run/state setup, main cycle loop) and `runnerStartup.mjs`
 * (live/local detection, resume/fresh state loading). This file only
 * re-exports the public/helper surface so
 * `scripts/ci/local-soak/runner.mjs` remains the single import path used
 * by the CLI and the Vitest suite; see `runner.d.mts` for the contract.
 */

// Re-exports preserved for the CLI and the Vitest suite (PRs #261/#262).
export { CONVERGENCE_POLL_MS, CONVERGENCE_TIMEOUT_MS, isSafeEpochTimestampMs, PROBE_ACCEPT_POLL_MS, RECOVERY_REASONS, resolveCycleDeadlineAtMs, SYSTEM_STATE_READINESS_POLL_MS } from "./constants.mjs";
export { boundedSleep, deadlineRemainingMs } from "./timing.mjs";
export { parseSpreadsheetIdFromUrl } from "./spreadsheetUrl.mjs";
export { isExpectedPlainNodeTsLoaderFailure, shouldFallBackToDistOnSourceFailure } from "./distFallback.mjs";
export { resolveSystemStateReadinessReader } from "./systemStateReadiness.mjs";
export { stableErrorTag } from "./errors.mjs";
export { closeRuntimeWithFinalRetry } from "./summary.mjs";
export { openRuntimeWithinDeadline } from "./database.mjs";
export { planResumeRecovery } from "./resume.mjs";
export { replayDeterministicHistory } from "./replay.mjs";
export { checkSheetsConvergence, evaluateInputReadiness, extractProjectionIds, runHumanEditProbe, waitForRuntimeSystemStateReadiness } from "./probe.mjs";
export { runLocalMultiTableSoak } from "./runnerOrchestration.mjs";
