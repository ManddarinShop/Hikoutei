/**
 * Deterministic replay facade: re-exports the replay planning surface
 * (pure functions of the stored seed/params) and the replay verification
 * surface (DB-backed evidence checks), so consumers import one module.
 */
export {
  expectedTablesTouchedForCycle,
  hasEditableProbeField,
  operationIdentityKey,
  probeEvidenceKey,
  probeOverrideCandidates,
  replayDeterministicHistory,
} from "./replayPlan.mjs";
export {
  buildProbeEvidence,
  matchAllowedPrefixRow,
  rebuildOracleFromSqlite,
  requireProbeEvidenceOrFail,
} from "./replayVerify.mjs";
