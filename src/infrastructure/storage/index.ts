export { CURRENT_SCHEMA_VERSION, migrateSchema, schemaDdl } from "./sqlite/schema.js";
export type { SchemaMigrationResult } from "./sqlite/schema.js";
export {
  CANONICAL_COMMIT_RESULT_KINDS,
  CANONICAL_COMMIT_STALE_TARGETS,
  commitCanonicalChanges,
  commitCanonicalChangesWithAdapter,
  commitCanonicalChangesWithSql,
} from "./state/canonical/canonicalCommit.js";
export type {
  CanonicalCommitInput,
  CanonicalCommitResult,
  CanonicalFieldWrite,
  CanonicalFieldCommitInput,
  CanonicalInsertCommitInput,
  CanonicalUpdateCommitInput,
  CanonicalDeleteCommitInput,
} from "./state/canonical/canonicalCommit.js";
export {
  openDatabase,
  openReadOnlyDatabase,
  getDatabaseSync,
  withImmediateTransaction,
} from "./sqlite/sqliteBridge.js";
export type { DatabaseSyncLike, StatementLike } from "./sqlite/sqliteBridge.js";
export {
  claimWriterLease,
  claimWriterLeaseWithAdapter,
  claimWriterLeaseWithSql,
  readWriterLease,
  readWriterLeaseWithAdapter,
  readWriterLeaseWithSql,
  isFencingValid,
  isFencingValidWithAdapter,
  isFencingValidWithSql,
} from "./sync/shared/writerLease.js";
export {
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
  claimEffect,
  claimEffectWithAdapter,
  claimEffectWithSql,
  applyEffectResult,
  applyEffectResultWithAdapter,
  applyEffectResultWithSql,
  supersedeAndReplan,
  supersedeAndReplanWithAdapter,
  supersedeAndReplanWithSql,
  recoverExpiredLeases,
  recoverExpiredLeasesWithAdapter,
  recoverExpiredLeasesWithSql,
  releaseUnprocessedEffect,
  releaseUnprocessedEffectWithAdapter,
  releaseUnprocessedEffectWithSql,
  retryClaimedEffect,
  retryClaimedEffectWithAdapter,
  retryClaimedEffectWithSql,
  findPendingEffectsByTarget,
  findPendingEffectsByTargetWithAdapter,
  findPendingEffectsByTargetWithSql,
  listReadyEffects,
  listReadyEffectsWithAdapter,
  listReadyEffectsWithSql,
  hasPendingOrProcessingEffects,
  hasPendingOrProcessingEffectsWithAdapter,
  hasPendingOrProcessingEffectsWithSql,
  appendPendingEffects,
  appendPendingEffectsWithAdapter,
  appendPendingEffectsWithSql,
} from "./sync/outbound/effectOutbox.js";
export type {
  ClaimResult,
  ClaimEffectOptions,
  ApplyResultOptions,
  EffectProjectionConfirmation,
  NewEffect,
  PendingEffect,
  RetryClaimedEffectOptions,
} from "./sync/outbound/effectOutbox.js";
export { SYNC_EFFECT_RECOVERY_ERROR_CODES } from "./sync/outbound/effectOutbox.js";
export {
  persistObservedRow,
  persistObservedRowWithAdapter,
  persistObservedRowWithSql,
} from "./state/observation/observationWriter.js";
export type {
  ObservationAttemptInput,
  EventIdentityInput,
  BusinessKeyChange,
  CanonicalRowMutation,
  PersistObservedRowInput,
  PersistObservedRowResult,
} from "./state/observation/observationWriter.js";
export {
  persistResolutionCommand,
  persistResolutionCommandWithAdapter,
  persistResolutionCommandWithSql,
} from "./state/resolution/resolutionWriter.js";
export type {
  PersistResolutionCommandInput,
  PersistResolutionCommandResult,
} from "./state/resolution/resolutionWriter.js";
export {
  registerSyncSheet,
  registerSyncSheetWithAdapter,
  registerSyncSheetWithSql,
  requireRegisteredSyncSheet,
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
  persistReadOnlySnapshotObservation,
  persistReadOnlySnapshotObservationWithAdapter,
  persistReadOnlySnapshotObservationWithSql,
} from "./state/readonly/readOnlyObservation.js";
export type {
  ReadOnlySnapshotObservationInput,
  ReadOnlySnapshotObservationResult,
} from "./state/readonly/readOnlyObservation.js";
export {
  inspectRestoredBackup,
  beginRestoreReconciliation,
  completeRestoreReconciliation,
  requireRestoreAllowsSheetWrites,
} from "./recovery/restoreRecovery.js";
export type {
  RestoreInspection,
  BeginRestoreReconciliationOptions,
  RestoreReconciliation,
  RestoreEffectDisposition,
  RestoreEffectReconciliation,
  CompleteRestoreReconciliationOptions,
  ReadyRestore,
} from "./recovery/restoreRecovery.js";
