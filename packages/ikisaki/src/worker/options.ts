/** Construction options for a bounded effect-worker pass. */

import type { SqlStorageAdapter } from "../sql/sql.js";
import type { Dispatcher, RepairReplanFactory } from "./dispatcher.js";
import type { TimingSink } from "./pacing/timing.js";

/** Shared construction options for a bounded effect-worker pass. */
export interface EffectWorkerBaseOptions {
  readonly dispatcher: Dispatcher;
  readonly workerId: string;
  readonly now: number;
  readonly maxEffects: number;
  readonly writerRole?: string;
  readonly writerLeaseDurationMs?: number;
  /**
   * Stale-heartbeat takeover evidence bound in ms (feeds
   * `ClaimLeaseOptions.heartbeatStaleBeforeMs`). Defaults to
   * `DEFAULT_WRITER_LEASE_HEARTBEAT_STALE_MS`: a writer lease whose owner
   * last heartbeated more than this long ago (while `lease_until` is still
   * in the future) is presumed dead and may be taken over by this worker.
   */
  readonly writerLeaseHeartbeatStaleMs?: number;
  readonly effectLeaseDurationMs?: number;
  /** Internal transport timeout used to validate lease headroom. */
  readonly requestTimeoutMs?: number;
  readonly batchController?: AdaptiveEffectBatchControllerLike;
  /**
   * Internal bulk-append claim window for the real provider runtime. When
   * set, a pass claims up to this many append candidates through a dedicated
   * ready fast-append selection (so a regular/recovery backlog ahead of them
   * cannot starve appends), and keeps the regular/recovery claim window at
   * the bounded 100-effect limit. Direct workers and fake dispatchers omit it
   * and keep the 100-item window.
   */
  readonly maxFastAppendCandidates?: number;
  /**
   * Internal minimum interval between fast-append request starts. Only the
   * full provider runtime sets it; the batch controller owns the actual wait.
   */
  readonly appendDispatchIntervalMs?: number;
  /** Shared supervisor clock used to refresh fencing timestamps after remote I/O. */
  readonly clock?: () => number;
  readonly makeRepairReplan?: RepairReplanFactory;
  /** Optional diagnostics sink for worker and provider phases. */
  readonly onTiming?: TimingSink;
}

/** Construction options for a worker running through an async storage adapter. */
export interface EffectWorkerWithAdapterOptions extends EffectWorkerBaseOptions {
  readonly storage: SqlStorageAdapter;
}

/** Structural slice of the adaptive batch controller used by the worker. */
export interface AdaptiveEffectBatchControllerLike {
  limitFor(routeKey: string): number;
  beginDispatch(routeKey: string, now?: number): number;
  observe(routeKey: string, observation: {
    readonly durationMs: number;
    readonly responseSucceeded: boolean;
    readonly responseLoss: boolean;
  }): void;
  /** Records one read-ahead preflight outcome so slow/failed reads back off. */
  observePreflight?(routeKey: string, observation: {
    readonly durationMs: number;
    readonly succeeded: boolean;
  }): void;
  /** Drops a route's buffered preflight latency when its prepared unit is abandoned. */
  abandonPreflight?(routeKey: string): void;
  waitForCoalescing(now?: number): Promise<number>;
  beginAppendDispatch(now?: number): void;
  waitForAppendThrottle(now?: number): Promise<number>;
}
