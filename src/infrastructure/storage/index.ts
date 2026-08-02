/**
 * Internal adapter-backed storage surface.
 *
 * The application and worker layers use caller-owned SQL or an explicit
 * SqlStorageAdapter transaction. Every exported storage operation is async
 * and adapter-backed; provider-specific SQL details stay behind this barrel.
 */

export {
  CANONICAL_COMMIT_RESULT_KINDS,
  CANONICAL_COMMIT_STALE_TARGETS,
  commitCanonicalChangesWithAdapter,
  commitCanonicalChangesWithSql,
} from "./state/canonical/canonicalCommit.js";
export type {
  CanonicalCommitInput,
  CanonicalCommitResult,
  CanonicalEffectsFactory,
  CanonicalFieldWrite,
  CanonicalFieldCommitInput,
  CanonicalInsertCommitInput,
  CanonicalUpdateCommitInput,
  CanonicalDeleteCommitInput,
} from "./state/canonical/canonicalCommit.js";

export {
  claimWriterLeaseWithAdapter,
  claimWriterLeaseWithSql,
  readWriterLeaseWithAdapter,
  readWriterLeaseWithSql,
  isFencingValidWithAdapter,
  isFencingValidWithSql,
  WRITER_LEASE_CLAIM_FAILURE_REASONS,
  WRITER_LEASE_CLAIM_RESULT_KINDS,
} from "./sync/shared/writerLease.js";
export type {
  WriterLease,
  ClaimLeaseOptions,
  FencingContext,
  WriterLeaseClaimFailureReason,
  WriterLeaseClaimResult,
  WriterLeaseClaimResultKind,
} from "./sync/shared/writerLease.js";

export {
  claimEffectWithAdapter,
  claimEffectWithSql,
  applyEffectResultWithAdapter,
  applyEffectResultWithSql,
  supersedeAndReplanWithAdapter,
  supersedeAndReplanWithSql,
  recoverExpiredLeasesWithAdapter,
  recoverExpiredLeasesWithSql,
  releaseUnprocessedEffectWithAdapter,
  releaseUnprocessedEffectWithSql,
  retryClaimedEffectWithAdapter,
  retryClaimedEffectWithSql,
  findPendingEffectsByTargetWithAdapter,
  findPendingEffectsByTargetWithSql,
  listReadyEffectsWithAdapter,
  listReadyEffectsWithSql,
  hasPendingOrProcessingEffectsWithAdapter,
  hasPendingOrProcessingEffectsWithSql,
  appendPendingEffectsWithAdapter,
  appendPendingEffectsWithSql,
  SYNC_EFFECT_RECOVERY_ERROR_CODES,
} from "./sync/outbound/effectOutbox.js";
export type {
  AppliedEffectResultOptions,
  ClaimResult,
  ClaimEffectOptions,
  ApplyResultOptions,
  NonAppliedEffectResultOptions,
  EffectProjectionConfirmation,
  NewEffect,
  PendingEffect,
  RetryClaimedEffectOptions,
} from "./sync/outbound/effectOutbox.js";

export {
  persistObservedRowWithAdapter,
  persistObservedRowWithSql,
} from "./state/observation/observationWriter.js";
export {
  OBSERVED_PROJECTION_EVIDENCE_SOURCES,
} from "./state/observation/observationTypes.js";
export type {
  ObservationAttemptInput,
  EventIdentityInput,
  BusinessKeyChange,
  CanonicalRowMutation,
  ObservedProjectionEvidence,
  PersistObservedRowInput,
  PersistObservedRowResult,
} from "./state/observation/observationWriter.js";
export type {
  ObservedProjectionBaseline,
  ObservedProjectionEvidenceSource,
} from "./state/observation/observationTypes.js";
export {
  persistPollingQuarantineWithSql,
  POLLING_QUARANTINE_WRITE_RESULT_KINDS,
} from "./state/observation/observationQuarantine.js";
export type {
  PollingQuarantineInput,
  PollingQuarantineWriteResult,
} from "./state/observation/observationQuarantine.js";

export {
  persistResolutionCommandWithAdapter,
  persistResolutionCommandWithSql,
} from "./state/resolution/resolutionWriter.js";
export type {
  PersistResolutionCommandInput,
  PersistResolutionCommandResult,
} from "./state/resolution/resolutionWriter.js";

export {
  registerSyncSheetWithAdapter,
  registerSyncSheetWithSql,
  requireRegisteredSyncSheetWithAdapter,
  requireRegisteredSyncSheetWithSql,
} from "./sync/shared/syncRegistry.js";
export type {
  RegisteredProjection,
  RegisterSyncSheetInput,
  RegisteredSyncSheet,
  RegisterSyncSheetResult,
} from "./sync/shared/syncRegistry.js";

export {
  readMappedRowBindingWithSql,
  insertMappedActiveRowBindingWithSql,
  tombstoneMappedActiveRowBindingWithSql,
  readMappedActiveCanonicalEntityWithSql,
  readMappedCanonicalFieldsWithSql,
  readMappedCanonicalFieldRevisionsWithSql,
  readMappedActiveBusinessKeyWithSql,
  readMappedBusinessKeyOwnerWithSql,
  insertMappedActiveBusinessKeyWithSql,
  retireMappedActiveBusinessKeyWithSql,
  retireMappedEntityBusinessKeysWithSql,
  readMappedVisibleProjectionStateWithSql,
  readMappedLatestProjectionEffectWithSql,
} from "./state/mapped/mappedPersistenceSql.js";
export type {
  MappedRowBindingSqlRow,
  MappedCanonicalEntitySqlRow,
  MappedCanonicalFieldValueSqlRow,
  MappedCanonicalFieldRevisionSqlRow,
  MappedActiveBusinessKeySqlRow,
  MappedBusinessKeyOwnerSqlRow,
  MappedVisibleProjectionSqlRow,
  MappedLatestProjectionEffectSqlRow,
} from "./state/mapped/mappedPersistenceSql.js";
export {
  createTypedSheetsPersistenceContext,
  registerTypedSheetsPersistenceRoutesWithAdapter,
} from "./state/mapped/mappedPersistenceContext.js";
export type {
  TypedSheetsPersistenceBusinessKey,
  TypedSheetsPersistenceContext,
  TypedSheetsPersistenceFieldRevision,
  TypedSheetsPersistenceLatestEffect,
  TypedSheetsPersistenceRegistrationResult,
  TypedSheetsPersistenceRowBinding,
  TypedSheetsPersistenceVisibleState,
} from "./state/mapped/mappedPersistenceContext.js";

export {
  readReconciliationCorrectionStateWithAdapter,
  readReconciliationDesiredSystemStateWithAdapter,
  readReconciliationDesiredSystemStateWithSql,
  readReconciliationVisibleStateWithSql,
  readReconciliationLatestEffectWithSql,
} from "./sync/outbound/reconciliationSql.js";
export type {
  ReconciliationCorrectionState,
  ReconciliationDesiredSystemStateRow,
  ReconciliationLatestEffect,
  ReconciliationVisibleState,
} from "./sync/outbound/reconciliationSql.js";

export {
  hasActiveUserInputCandidateWithAdapter,
  hasActiveUserInputCandidateWithSql,
} from "./sync/outbound/effectWorkerSql.js";
export type { UserInputCandidateGuardQuery } from "./sync/outbound/effectWorkerSql.js";
