/** Public options, reports, and internal storage contracts for the effect worker. */

import type { Presence } from "../../../../domain/index.js";
import type { SqlStorageAdapter } from "../../../../adapter/persistence/contracts/sql.js";
import type {
  ApplyResultOptions,
  ClaimEffectOptions,
  ClaimLeaseOptions,
  ClaimResult,
  FencingContext,
  NewEffect,
  PendingEffect,
  RetryClaimedEffectOptions,
  WriterLease,
  WriterLeaseClaimResult,
} from "../../../../infrastructure/storage/index.js";
import type {
  SyncEffectPostcondition,
  SyncGatewayEffect,
  SyncGatewayEffectResult,
  SyncEffectWorkerGateway,
  SyncEffectWorkerFullGateway,
} from "../../gateway/syncGateway.js";
import type { SyncTimingSink } from "../../telemetry/syncTiming.js";

/** An effect plus evidence supplied to a writer-owned repair replanner. */
export interface RepairReplanRequest {
  readonly effect: PendingEffect;
  readonly gatewayResult: Presence<SyncGatewayEffectResult>;
  readonly postcondition: Presence<SyncEffectPostcondition>;
}

/** Callback that creates a fresh effect without mutating old evidence. */
export type RepairReplanFactory = (request: RepairReplanRequest) => Presence<NewEffect>;

/** Shared construction options for a bounded effect-worker pass. */
export interface SyncEffectWorkerBaseOptions {
  readonly gateway: SyncEffectWorkerGateway;
  readonly workerId: string;
  readonly now: number;
  readonly maxEffects: number;
  readonly writerRole?: string;
  readonly writerLeaseDurationMs?: number;
  readonly effectLeaseDurationMs?: number;
  readonly makeRepairReplan?: RepairReplanFactory;
  /** Optional diagnostics sink for worker and gateway phases. */
  readonly onTiming?: SyncTimingSink;
}

export type SyncEffectWorkerFullOptions = Omit<SyncEffectWorkerBaseOptions, "gateway"> & {
  readonly gateway: SyncEffectWorkerFullGateway;
};

/** Construction options for a worker running through an async storage adapter. */
export interface SyncEffectWorkerWithAdapterOptions extends SyncEffectWorkerBaseOptions {
  readonly storage: SqlStorageAdapter;
}

/** Counters that make partial results and recovery visible to callers. */
export interface SyncEffectWorkerReport {
  readonly lease: Presence<WriterLease>;
  readonly expiredLeasesRecovered: number;
  readonly selected: number;
  readonly claimed: number;
  readonly applied: number;
  readonly blockedCandidate: number;
  readonly superseded: number;
  readonly conflicted: number;
  readonly failed: number;
  readonly deferred: number;
  readonly requeued: number;
  readonly replanned: number;
  readonly responseLossRecovered: number;
}

/** One claimed effect and its promoted gateway payload, if valid. */
export interface ClaimedEffect {
  readonly pending: PendingEffect;
  readonly claimToken: string;
  readonly gatewayEffect: Presence<SyncGatewayEffect>;
  readonly invalidPayloadError: Presence<string>;
}

/** Persistence operations required by the shared effect-worker state machine. */
export interface EffectWorkerStorage {
  claimWriterLease(options: ClaimLeaseOptions): Promise<WriterLeaseClaimResult>;
  recoverExpiredLeases(fence: FencingContext): Promise<number>;
  listReadyEffects(limit: number): Promise<readonly PendingEffect[]>;
  claimEffect(options: ClaimEffectOptions): Promise<ClaimResult>;
  applyEffectResult(options: ApplyResultOptions): Promise<boolean>;
  releaseUnprocessedEffect(
    options: Pick<FencingContext, "role" | "writerEpoch" | "fencingToken" | "now"> & {
      readonly effectId: string;
      readonly claimToken: string;
    },
  ): Promise<boolean>;
  retryClaimedEffect(options: RetryClaimedEffectOptions): Promise<boolean>;
  supersedeAndReplan(
    fence: FencingContext,
    oldEffectId: string,
    newEffect: NewEffect,
  ): Promise<void>;
  isUserInputCandidateBlocked(item: ClaimedEffect): Promise<boolean>;
}

/** Mutable counters used while one worker pass is in progress. */
export interface MutableReport {
  lease: Presence<WriterLease>;
  expiredLeasesRecovered: number;
  selected: number;
  claimed: number;
  applied: number;
  blockedCandidate: number;
  superseded: number;
  conflicted: number;
  failed: number;
  deferred: number;
  requeued: number;
  replanned: number;
  responseLossRecovered: number;
}
