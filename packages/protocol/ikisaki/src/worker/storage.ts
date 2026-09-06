/**
 * Persistence port and adapter implementation for the shared
 * effect-worker state machine.
 */

import type { SqlStorageAdapter } from "../sql/sql.js";
import type {
  ApplyResultOptions,
  ClaimEffectOptions,
  ClaimResult,
  MarkDeliveryUncertainOptions,
  NewEffect,
  PendingEffect,
  RenewEffectLeaseOptions,
  RetryClaimedEffectOptions,
} from "../contract/contracts.js";
import type {
  ClaimLeaseOptions,
  FencingContext,
  WriterLeaseClaimResult,
} from "../outbox/writerLease.js";
import {
  claimEffectWithAdapter,
  applyEffectResultWithAdapter,
  markDeliveryUncertainWithAdapter,
  renewEffectLeaseWithAdapter,
  recoverExpiredLeasesWithAdapter,
  listReadyEffectsWithAdapter,
  listReadyFastAppendEffectsWithAdapter,
  releaseUnprocessedEffectWithAdapter,
  retryClaimedEffectWithAdapter,
  supersedeAndReplanWithAdapter,
} from "../outbox/outbox.js";
import {
  claimWriterLeaseWithAdapter,
} from "../outbox/writerLease.js";

/** Persistence operations used by the shared effect-worker state machine. */
export interface EffectWorkerStorage {
  claimWriterLease(options: ClaimLeaseOptions): Promise<WriterLeaseClaimResult>;
  recoverExpiredLeases(fence: FencingContext): Promise<number>;
  listReadyEffects(limit: number, now?: number): Promise<readonly PendingEffect[]>;
  listReadyFastAppendEffects(limit: number, now?: number): Promise<readonly PendingEffect[]>;
  claimEffect(options: ClaimEffectOptions): Promise<ClaimResult>;
  markDeliveryUncertain(options: MarkDeliveryUncertainOptions): Promise<boolean>;
  renewEffectLease(options: RenewEffectLeaseOptions): Promise<boolean>;
  applyEffectResult(options: ApplyResultOptions): Promise<boolean>;
  releaseUnprocessedEffect(
    options: Pick<FencingContext, "role" | "writerEpoch" | "fencingToken" | "now"> & {
      readonly effectId: string;
      readonly claimToken: string;
      readonly reason?: "provider_batch" | "lease_recovered";
    },
  ): Promise<boolean>;
  retryClaimedEffect(options: RetryClaimedEffectOptions): Promise<boolean>;
  supersedeAndReplan(
    fence: FencingContext,
    oldEffectId: string,
    newEffect: NewEffect,
  ): Promise<void>;
}

/**
 * Creates an `EffectWorkerStorage` backed by an adapter-owned SQL connection.
 *
 * This is the adapter-compatible storage boundary used by the worker pipeline;
 * it never opens its own database beside a host connection.
 */
export function createAdapterEffectWorkerStorage(storage: SqlStorageAdapter): EffectWorkerStorage {
  return {
    claimWriterLease: (options) => claimWriterLeaseWithAdapter(storage, options),
    recoverExpiredLeases: (fence) => recoverExpiredLeasesWithAdapter(storage, fence),
    listReadyEffects: (limit, now) => listReadyEffectsWithAdapter(storage, limit, now),
    listReadyFastAppendEffects: (limit, now) => listReadyFastAppendEffectsWithAdapter(storage, limit, now),
    claimEffect: (options) => claimEffectWithAdapter(storage, options),
    markDeliveryUncertain: (options) => markDeliveryUncertainWithAdapter(storage, options),
    renewEffectLease: (options) => renewEffectLeaseWithAdapter(storage, options),
    applyEffectResult: (options) => applyEffectResultWithAdapter(storage, options),
    releaseUnprocessedEffect: (options) => releaseUnprocessedEffectWithAdapter(storage, options),
    retryClaimedEffect: (options) => retryClaimedEffectWithAdapter(storage, options),
    supersedeAndReplan: (fence, oldEffectId, newEffect) => {
      return supersedeAndReplanWithAdapter(storage, fence, oldEffectId, newEffect);
    },
  };
}
