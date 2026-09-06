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
  KERNEL_INPUT_ERROR_CODES,
  KernelInputError,
  STORAGE_ERROR_CODES,
  StorageError,
  CoreErrorException,
  type CoreError,
  type KernelInputErrorCode,
  type StorageErrorCode,
} from "./contract/errors.js";

export {
  APPLICABILITY_KINDS,
  LOOKUP_RESULT_KINDS,
  PRESENCE_KINDS,
  type Applicability,
  type LookupResult,
  type Presence,
} from "./contract/state.js";

/**
 * Protocol-owned persisted outbox vocabulary (kernel table values; the
 * entity-owned canonical tables live in `@hikoutei/contracts`).
 */
export {
  OUTBOX_EFFECT_KINDS,
  OUTBOX_EFFECT_STATUSES,
  OUTBOX_EFFECT_TARGET_KINDS,
  type OutboxEffectKind,
  type OutboxEffectStatus,
  type OutboxEffectTargetKind,
} from "./outbox/effectVocabulary.js";

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
} from "./contract/identity.js";

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
} from "./sql/sql.js";

export {
  fromSqlNullable,
  toSqlNullable,
} from "./sql/sqlState.js";

export {
  rollbackSqlSavepoint,
  withSqlSavepoint,
} from "./sql/sqlTransaction.js";

export {
  awaitTakeoverableWriterLeaseWithAdapter,
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
  renewWriterLeaseWithAdapter,
  renewWriterLeaseWithSql,
  writerLeaseHeartbeatStaleBoundMs,
  DEFAULT_WRITER_LEASE_HEARTBEAT_INTERVAL_MS,
  DEFAULT_WRITER_LEASE_HEARTBEAT_STALE_MS,
  DEFAULT_WRITER_LEASE_STARTUP_WAIT_MS,
  WRITER_LEASE_CLAIM_FAILURE_REASONS,
  WRITER_LEASE_CLAIM_RESULT_KINDS,
  WRITER_LEASE_RENEW_RESULT_KINDS,
  WRITER_LEASE_STARTUP_WAIT_FAILURE_REASONS,
  WRITER_LEASE_STARTUP_WAIT_RESULT_KINDS,
  type AwaitTakeoverableWriterLeaseOptions,
  type ClaimLeaseOptions,
  type FencingContext,
  type ReleaseWriterLeaseOptions,
  type RenewLeaseOptions,
  type WriterLease,
  type WriterLeaseClaimFailureReason,
  type WriterLeaseClaimResult,
  type WriterLeaseClaimResultKind,
  type WriterLeaseRenewResult,
  type WriterLeaseRenewResultKind,
  type WriterLeaseStartupWaitFailureReason,
  type WriterLeaseStartupWaitResult,
  type WriterLeaseStartupWaitResultKind,
} from "./outbox/writerLease.js";

export {
  SYNC_EFFECT_RECOVERY_ERROR_CODES,
  type AppliedEffectResultOptions,
  type ApplyResultOptions,
  type ClaimEffectOptions,
  type ClaimResult,
  type DispatchClass,
  type EffectProjectionConfirmation,
  type MarkDeliveryUncertainOptions,
  type NewEffect,
  type NonAppliedEffectResultOptions,
  type PendingEffect,
  type RenewEffectLeaseOptions,
  type RetryClaimedEffectOptions,
} from "./contract/contracts.js";

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
  readOutboxScanReadinessWithAdapter,
  readOutboxScanReadinessWithSql,
  readSystemStateDrainReadinessWithAdapter,
  readSystemStateDrainReadinessWithSql,
  type SystemStateDrainReadiness,
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
} from "./outbox/outbox.js";

export {
  decodePendingEffectRow,
} from "./outbox/effectRow.js";

export {
  assertProjectionConfirmationTargetWithSql,
  validateApplyResultOptions,
  validateProjectionConfirmation,
  writeProjectionConfirmationWithSql,
} from "./outbox/confirmation.js";

export {
  AsyncFenceLostError,
} from "./outbox/writerLease.js";

export {
  EFFECT_OUTBOX_DDL,
  REQUIRED_V3_COLUMNS,
  REQUIRED_V5_COLUMNS,
  REQUIRED_V9_COLUMNS,
  syncSchemaV5IndexesDdl,
  VISIBLE_STATE_TABLES_DDL,
  WRITER_LEASE_DDL,
} from "./sql/schema.js";

/** Protocol surface: neutral banded-read planning and execution. */
export {
  MAX_READ_CELLS_PER_RANGE,
  MAX_READ_RANGES_PER_REQUEST,
  READ_BYTES_PER_CELL,
  READ_HARD_MAX_BYTES,
  READ_SOFT_TARGET_BYTES,
  authoritativeRowBound,
  createReadCalibration,
  estimatedRangeBytes,
  packReadRequests,
  planRowBands,
  rowsPerBand,
  type BandEvidence,
  type BandRange,
  type BandSheetBound,
  type BandedDocument,
  type BandedGet,
  type EngineRuntime,
  type ReadCalibration,
  type RowBandPlan,
} from "./bands/readPlan.js";

export {
  createBandExecutor,
  createEngineRuntime,
  ensureBandRowBounds,
  type BandBoundEnumeration,
  type BandEngineHooks,
  type BandFetchResult,
} from "./bands/readEngine.js";

/** Protocol surface: neutral write-batch execution. */
export {
  executeBatchUpdate,
  executePreparedWrite,
  groupByRouteKey,
  receiptInitNeeded,
  refreshFirstRouteContext,
  type BatchWriteHooks,
  type BuiltBatch,
  type WriteBatchTelemetry,
} from "./batches/writeEngine.js";

/** Protocol surface: neutral CAS evidence (postconditions, receipts, cursors). */
export {
  classifyCasPostcondition,
  type CasClassifyInput,
  type CasDisposition,
  type CasObservedRow,
  type CasPostcondition,
  type CasReceiptEvidence,
} from "./evidence/postcondition.js";

export {
  encodeOutcomeResultEvidence,
  encodeSchemaErrorResultEvidence,
  makeReceiptEvidence,
  withDeferredPostconditionEvidence,
  type CodedEffectResult,
  type PlannedOutcomeEvidence,
  type PlannedReceiptEvidence,
} from "./evidence/plannerReceipt.js";

export {
  MAX_MEMO_RECEIPTS,
  ReceiptReadCursor,
  type CursorReceiptEvidence,
} from "./evidence/receiptCursor.js";

/** Step-1 protocol surface: provider-neutral transport error parsers. */
export {
  parseRawErrorRecord,
  parseRawErrorText,
  parseRawHttpStatus,
} from "./transport/rawErrorSchemas.js";

/** Protocol surface: provider-timing contract (contracts shim target). */
export {
  SYNC_TIMING_OPERATION_KINDS,
  type SyncProviderTiming,
  type SyncProviderTimingPhase,
  type SyncTimingOperationCounts,
  type SyncTimingOperationKind,
} from "./timing/providerTiming.js";

export * from "./worker/index.js";
