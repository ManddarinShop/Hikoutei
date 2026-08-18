/**
 * Resume JSONL HISTORY validation for the soak runner.
 *
 * Thin facade re-exporting the split history modules — per-record
 * schema validation (`resumeHistorySchema.mjs`) and the cross-file
 * integrity proof (`resumeHistoryProof.mjs`) — so
 * `scripts/ci/local-soak/resumeHistory.mjs` remains the import path used
 * by `resume.mjs` and `resumeRecording.mjs`.
 */
export { isProvableFullCycleAbort, validateResumeHistory } from "./resumeHistoryProof.mjs";
