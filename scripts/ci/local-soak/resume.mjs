/**
 * Resume state/history validation, the recovery planner, and recorded
 * bookkeeping (cycle/operation/resource) for the soak runner.
 *
 * Facade re-exporting the split resume modules — state/checkpoint
 * validation and the recovery planner (`resumeState.mjs`), JSONL history
 * validation (`resumeHistory.mjs`), and recorded bookkeeping
 * (`resumeRecording.mjs`) — so `scripts/ci/local-soak/resume.mjs` remains
 * the import path used by runner/execute and the Vitest suite.
 */
export {
  checkpointMarker,
  planResumeRecovery,
  readCheckpointOrUndefined,
  validateResumeState,
} from "./resumeState.mjs";
export { validateResumeHistory } from "./resumeHistory.mjs";
export {
  completeRecordedCycle,
  createRecordingTracker,
  recordCycleIfAbsent,
  recordOperationIfAbsent,
  recordResourceIfAbsent,
} from "./resumeRecording.mjs";