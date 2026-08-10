/**
 * @hikoutei/ikisaki — the Hikoutei consistency queue kernel.
 *
 * A delivery queue bound to the business transaction, with durability,
 * ordering, idempotency, and recovery contracts. The kernel owns its SQL
 * port, its schema DDL, and its errors; it never imports host application
 * code. Host applications consume it through their storage facade re-exports.
 *
 * The effect payload is opaque: the queue reasons only about route keys,
 * ordering keys, fencing, and lifecycle evidence.
 */

export {
  STORAGE_ERROR_CODES,
  StorageError,
  CoreErrorException,
  type CoreError,
  type StorageErrorCode,
} from "./errors.js";

export {
  APPLICABILITY_KINDS,
  LOOKUP_RESULT_KINDS,
  PRESENCE_KINDS,
  type Applicability,
  type LookupResult,
  type Presence,
} from "./state.js";

export {
  EFFECT_KINDS,
  EFFECT_STATUSES,
  EFFECT_TARGET_KINDS,
  type EffectKind,
  type EffectStatus,
  type EffectTargetKind,
} from "./constants.js";

export {
  isSemanticRevision,
  requireSemanticString,
  type OutboxEffectDedupeKey,
  type OutboxEffectId,
  type OutboxPayloadHash,
  type OutboxPhysicalSheetId,
  type OutboxRevision,
  type OutboxRowBindingId,
  type OutboxVisibleHash,
  type SemanticRevision,
  type SemanticString,
} from "./identity.js";

export {
  decodeSqlRow,
  decodeSqlRows,
  type SqlExecutor,
  type SqlGeneratedId,
  type SqlMutationResult,
  type SqlParameter,
  type SqlRow,
  type SqlRowDecoder,
  type SqlStorageAdapter,
  type SqlStorageContext,
} from "./sql.js";

export {
  fromSqlNullable,
  toSqlNullable,
} from "./sqlState.js";

export {
  rollbackSqlSavepoint,
  withSqlSavepoint,
} from "./sqlTransaction.js";

export {
  claimWriterLeaseWithAdapter,
  claimWriterLeaseWithSql,
  fenceParameters,
  FENCE_EXISTS_SQL,
  isFencingValidWithAdapter,
  isFencingValidWithSql,
  readWriterLeaseWithAdapter,
  readWriterLeaseWithSql,
  releaseWriterLeaseWithAdapter,
  releaseWriterLeaseWithSql,
  WRITER_LEASE_CLAIM_FAILURE_REASONS,
  WRITER_LEASE_CLAIM_RESULT_KINDS,
  type ClaimLeaseOptions,
  type FencingContext,
  type ReleaseWriterLeaseOptions,
  type WriterLease,
  type WriterLeaseClaimFailureReason,
  type WriterLeaseClaimResult,
  type WriterLeaseClaimResultKind,
} from "./writerLease.js";

export {
  SYNC_EFFECT_RECOVERY_ERROR_CODES,
  type AppliedEffectResultOptions,
  type ApplyResultOptions,
  type ClaimEffectOptions,
  type ClaimResult,
  type EffectProjectionConfirmation,
  type MarkDeliveryUncertainOptions,
  type NewEffect,
  type NonAppliedEffectResultOptions,
  type PendingEffect,
  type RenewEffectLeaseOptions,
  type RetryClaimedEffectOptions,
} from "./contracts.js";

export {
  applyEffectResultWithAdapter,
  applyEffectResultWithSql,
  appendPendingEffectsWithAdapter,
  appendPendingEffectsWithSql,
  claimEffectWithAdapter,
  claimEffectWithSql,
  findPendingEffectsByTargetWithAdapter,
  findPendingEffectsByTargetWithSql,
  hasPendingOrProcessingEffectsWithAdapter,
  hasPendingOrProcessingEffectsWithSql,
  listReadyEffectsWithAdapter,
  listReadyEffectsWithSql,
  listReadyFastAppendEffectsWithAdapter,
  listReadyFastAppendEffectsWithSql,
  markDeliveryUncertainWithAdapter,
  markDeliveryUncertainWithSql,
  recoverExpiredLeasesWithAdapter,
  recoverExpiredLeasesWithSql,
  releaseUnprocessedEffectWithAdapter,
  releaseUnprocessedEffectWithSql,
  renewEffectLeaseWithAdapter,
  renewEffectLeaseWithSql,
  retryClaimedEffectWithAdapter,
  retryClaimedEffectWithSql,
  supersedeAndReplanWithAdapter,
  supersedeAndReplanWithSql,
  supersedeEffectWithAdapter,
  supersedeEffectWithSql,
  RECOVERABLE_EFFECT_ERROR_CODES,
  isRecoverableEffectErrorCode,
} from "./outbox.js";

export {
  assertProjectionConfirmationTargetWithSql,
  decodePendingEffectRow,
  validateApplyResultOptions,
  validateProjectionConfirmation,
  writeProjectionConfirmationWithSql,
} from "./support.js";

export {
  EFFECT_OUTBOX_DDL,
  REQUIRED_V3_COLUMNS,
  REQUIRED_V5_COLUMNS,
  syncSchemaV5IndexesDdl,
  VISIBLE_STATE_TABLES_DDL,
  WRITER_LEASE_DDL,
} from "./schema.js";

export * from "./worker/index.js";
