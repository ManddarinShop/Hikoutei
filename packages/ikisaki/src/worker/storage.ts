/** Persistence port used by the shared effect-worker state machine. */

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
