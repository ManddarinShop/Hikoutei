/** Public façade for durable effect outbox mutations and queries. */

export { SYNC_EFFECT_RECOVERY_ERROR_CODES } from "./effectOutboxContracts.js";
export type {
  ApplyResultOptions,
  ClaimEffectOptions,
  ClaimResult,
  EffectProjectionConfirmation,
  NewEffect,
  PendingEffect,
  RetryClaimedEffectOptions,
} from "./effectOutboxContracts.js";

export {
  appendPendingEffectsWithAdapter,
  appendPendingEffectsWithSql,
  applyEffectResultWithAdapter,
  applyEffectResultWithSql,
  claimEffectWithAdapter,
  claimEffectWithSql,
  recoverExpiredLeasesWithAdapter,
  recoverExpiredLeasesWithSql,
  releaseUnprocessedEffectWithAdapter,
  releaseUnprocessedEffectWithSql,
  retryClaimedEffectWithAdapter,
  retryClaimedEffectWithSql,
  supersedeAndReplanWithAdapter,
  supersedeAndReplanWithSql,
} from "./effectOutboxMutations.js";
export {
  findPendingEffectsByTargetWithAdapter,
  findPendingEffectsByTargetWithSql,
  hasPendingOrProcessingEffectsWithAdapter,
  hasPendingOrProcessingEffectsWithSql,
  listReadyEffectsWithAdapter,
  listReadyEffectsWithSql,
} from "./effectOutboxQueries.js";
