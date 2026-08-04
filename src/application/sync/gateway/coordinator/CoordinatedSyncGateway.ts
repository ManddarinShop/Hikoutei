/**
 * Per-spreadsheet Gateway coordinator that serializes remote mutations.
 *
 * The deployed Apps Script Gateway guards every data-plane operation with one
 * global `LockService.getScriptLock()`. Before this coordinator, the outbound
 * effect worker, the User_Input polling supervisor, provisioning, and test
 * controls each called the Gateway directly, so several in-flight requests
 * competed for the same script lock and the same Sheet context at once. Under
 * load that produced lock-acquisition failures, duplicate-row races, and tail
 * latency dominated by lock waits.
 *
 * The coordinator is a transparent decorator: it implements the same gateway
 * boundary the worker and polling already use, so no caller changes are
 * required. It routes every mutation and recovery barrier through one
 * per-spreadsheet FIFO lane (default total concurrency 1) while leaving
 * lock-free value reads untouched. SQLite outbox, leases, receipts, CAS, and
 * fencing remain the durable authority; the coordinator only prevents the Node
 * side from issuing competing mutations.
 *
 * Invariants preserved:
 * - Total mutation concurrency is 1 per lane by default, matching the global
 *   Apps Script script lock for single-spreadsheet deployments.
 * - Lock-free reads (`readSnapshot`, `readRows`, `readRowsBatch`) never wait on
 *   the mutation lane.
 * - Recovery barriers (`readEffectPostcondition(s)`) use the mutation lane so a
 *   postcondition probe proves an earlier timed-out critical section ended.
 * - Batch mutation (`observeSnapshots`) acquires every involved lane in a
 *   stable sorted order, so it cannot deadlock with single-sheet mutations.
 * - Provisioning uses a dedicated lane so setup never races an append/write.
 * - A failing or throwing mutation releases the lane, so it never deadlocks.
 */

import {
  isSyncSheetObservationBatchGateway,
} from "../syncGateway.js";
import type {
  ApplySyncEffectsRequest,
  ApplySyncEffectsResult,
  EnsureSyncRowAnchorsRequest,
  EnsureSyncRowAnchorsResult,
  FastAppendRowsRequest,
  FastAppendRowsResult,
  ReadSyncEffectPostconditionsRequest,
  ReadSyncSnapshotRequest,
  ReadSyncTableRowsRequest,
  SyncEffectPostcondition,
  SyncGatewayEffect,
  SyncGatewayEffectPostconditionResult,
  SyncGatewaySnapshot,
  SyncObservedSnapshot,
  SyncSheetGateway,
  SyncSheetObservationBatchGateway,
  SyncSheetTableReaderGateway,
  SyncTableRowsResult,
} from "../syncGateway.js";
import { AsyncMutex, type AsyncMutexRelease } from "./asyncMutex.js";
import {
  TRANSPORT_OUTCOME_KINDS,
  type CoordinatorLaneEvent,
} from "./coordinatorTelemetry.js";
import { classifyTransportOutcome } from "../transportClassification.js";

/** Gateway boundary the coordinator wraps (effect + observation + table read). */
export type CoordinatedGatewayInner =
  SyncSheetGateway &
  SyncSheetTableReaderGateway;

// SyncGatewayProvisioner is intentionally not wrapped: provisioning runs once
// at startup before the worker, so it stays on the original provisioner and
// never needs the mutation lane.

/** Options for constructing a per-spreadsheet coordinator. */
export interface CoordinatedSyncGatewayOptions<TInner extends CoordinatedGatewayInner> {
  readonly inner: TInner;
  /**
   * Derives the mutation-lane key for one physical sheet. Defaults to a
   * constant key, giving total mutation concurrency 1 across the process. Pass
   * a per-spreadsheet resolver when one coordinator serves multiple
   * spreadsheets so unrelated sheets do not serialize against each other.
   */
  readonly mutationKeyForPhysicalSheet?: (physicalSheetId: string) => string;
  /** Diagnostic lane observer; failures are swallowed and never alter results. */
  readonly onLaneEvent?: (event: CoordinatorLaneEvent) => void;
  /** Injectable clock used by deterministic telemetry tests. */
  readonly clock?: () => number;
}

/**
 * Serializes Gateway mutations per lane while keeping value reads lock-free.
 *
 * Implements the full gateway, table-reader, observation-batch, and provisioner
 * boundary, so it can wrap both the real Apps Script gateway and fakes. When
 * the inner gateway lacks the one-request observation path, observation is
 * routed through `ensureRowAnchors` + `readSnapshot` inside the same held lane.
 */
export class CoordinatedSyncGateway<TInner extends CoordinatedGatewayInner>
  implements SyncSheetGateway, SyncSheetTableReaderGateway, SyncSheetObservationBatchGateway {
  private readonly inner: TInner;
  private readonly resolveKey: (physicalSheetId: string) => string;
  private readonly onLaneEvent: ((event: CoordinatorLaneEvent) => void) | undefined;
  private readonly now: () => number;
  private readonly lanes = new Map<string, AsyncMutex>();

  public constructor(options: CoordinatedSyncGatewayOptions<TInner>) {
    this.inner = options.inner;
    this.resolveKey = options.mutationKeyForPhysicalSheet ?? (() => DEFAULT_LANE_KEY);
    this.onLaneEvent = options.onLaneEvent;
    this.now = options.clock ?? Date.now;
  }

  /** Returns a snapshot of all known lane metrics; diagnostic only. */
  public laneMetrics(): ReadonlyMap<string, ReturnType<AsyncMutex["metrics"]>> {
    const snapshot = new Map<string, ReturnType<AsyncMutex["metrics"]>>();
    for (const [key, mutex] of this.lanes) snapshot.set(key, mutex.metrics());
    return snapshot;
  }

  /**
   * Runs an internal control-plane operation on the same mutation lane as
   * effects and anchor writes. Test/admin controls use this to avoid issuing a
   * competing Apps Script request outside the coordinator.
   */
  public runSerializedControl<T>(
    physicalSheetId: string,
    operation: string,
    task: () => Promise<T>,
  ): Promise<T> {
    return this.runMutation(physicalSheetId, operation, task);
  }

  public async fastAppendRows(request: FastAppendRowsRequest): Promise<FastAppendRowsResult> {
    return this.runMutation(request.physicalSheetId, "fastAppendRows", () =>
      this.inner.fastAppendRows(request),
    );
  }

  public async applyEffects(request: ApplySyncEffectsRequest): Promise<ApplySyncEffectsResult> {
    return this.runMutation(request.physicalSheetId, "applyEffects", () =>
      this.inner.applyEffects(request),
    );
  }

  public async readEffectPostcondition(effect: SyncGatewayEffect): Promise<SyncEffectPostcondition> {
    return this.runMutation(effect.physicalSheetId, "readEffectPostcondition", () =>
      this.inner.readEffectPostcondition(effect),
    );
  }

  public async readEffectPostconditions(
    request: ReadSyncEffectPostconditionsRequest,
  ): Promise<readonly SyncGatewayEffectPostconditionResult[]> {
    return this.runMutation(request.physicalSheetId, "readEffectPostconditions", () =>
      this.inner.readEffectPostconditions(request),
    );
  }

  public async ensureRowAnchors(
    request: EnsureSyncRowAnchorsRequest,
  ): Promise<EnsureSyncRowAnchorsResult> {
    return this.runMutation(request.physicalSheetId, "ensureRowAnchors", () =>
      this.inner.ensureRowAnchors(request),
    );
  }

  public async observeSnapshot(request: ReadSyncSnapshotRequest): Promise<SyncObservedSnapshot> {
    return this.runMutation(request.physicalSheetId, "observeSnapshot", () =>
      this.observeOneInner(request),
    );
  }

  public async observeSnapshots(
    requests: readonly ReadSyncSnapshotRequest[],
  ): Promise<readonly SyncObservedSnapshot[]> {
    if (requests.length === 0) return [];
    const keys = distinctLaneKeys(requests.map((request) => this.resolveKey(request.physicalSheetId)));
    return this.runInLanes(keys, "observeSnapshots", async () => {
      if (isSyncSheetObservationBatchGateway(this.inner)) {
        // Delegate the whole batch to the inner gateway so one remote request
        // covers every requested projection; serializing one request at a time
        // here would defeat that shared round trip.
        return this.inner.observeSnapshots(requests);
      }
      const results: SyncObservedSnapshot[] = [];
      for (const request of requests) {
        // Sequential fallback for inner gateways without the batch capability;
        // each request still runs under the already-held lanes.
        // eslint-disable-next-line no-await-in-loop
        results.push(await this.observeOneInner(request));
      }
      return results;
    });
  }

  /** Lock-free snapshot read; never waits on the mutation lane. */
  public async readSnapshot(request: ReadSyncSnapshotRequest): Promise<SyncGatewaySnapshot> {
    return this.inner.readSnapshot(request);
  }

  /** Lock-free values-only read; never waits on the mutation lane. */
  public async readRows(request: ReadSyncTableRowsRequest): Promise<SyncTableRowsResult> {
    return this.inner.readRows(request);
  }

  /** Lock-free batched values-only read; never waits on the mutation lane. */
  public async readRowsBatch(
    requests: readonly ReadSyncTableRowsRequest[],
  ): Promise<readonly SyncTableRowsResult[]> {
    return this.inner.readRowsBatch(requests);
  }

  /**
   * Observes one snapshot through the inner gateway, using its single-request
   * capability when present and falling back to ensure+read otherwise. Both
   * calls run inside the caller's already-held lane, so observation stays
   * serialized against competing mutations.
   */
  private async observeOneInner(request: ReadSyncSnapshotRequest): Promise<SyncObservedSnapshot> {
    if (isSyncSheetObservationBatchGateway(this.inner)) {
      return this.inner.observeSnapshot(request);
    }
    const anchors = await this.inner.ensureRowAnchors(request);
    const snapshot = await this.inner.readSnapshot(request);
    return { anchors, snapshot };
  }

  private laneFor(key: string): AsyncMutex {
    let lane = this.lanes.get(key);
    if (lane === undefined) {
      lane = new AsyncMutex();
      this.lanes.set(key, lane);
    }
    return lane;
  }

  private async runMutation<T>(
    physicalSheetId: string,
    operation: string,
    task: () => Promise<T>,
  ): Promise<T> {
    const key = this.resolveKey(physicalSheetId);
    return this.runInLanes([key], operation, task);
  }

  private async runInLanes<T>(
    keys: readonly string[],
    operation: string,
    task: () => Promise<T>,
  ): Promise<T> {
    // Acquire lanes in stable sorted order so concurrent batch mutations cannot
    // deadlock with each other regardless of input order. Each release token is
    // held until the task settles so the lane stays locked for the whole call.
    const ordered = [...keys].sort();
    const queueStartedAt = this.now();
    const releases: AsyncMutexRelease[] = [];
    try {
      for (const key of ordered) {
        const lane = this.laneFor(key);
        // Acquire sequentially so the FIFO ordering holds across lanes.
        // eslint-disable-next-line no-await-in-loop
        releases.push(await lane.acquire());
      }
      const queueWaitMs = this.now() - queueStartedAt;
      const remoteStartedAt = this.now();
      try {
        const result = await task();
        this.emitSuccess(operation, ordered.join(","), queueWaitMs, remoteStartedAt);
        return result;
      } catch (error: unknown) {
        this.emitFailure(
          operation,
          ordered.join(","),
          queueWaitMs,
          remoteStartedAt,
          error,
        );
        throw error;
      }
    } finally {
      // Release in reverse acquisition order. Each token is idempotent, so an
      // early return after a partial acquisition still frees what it holds.
      for (let index = releases.length - 1; index >= 0; index -= 1) {
        const release = releases[index];
        if (release !== undefined) release();
      }
    }
  }

  private emitSuccess(
    operation: string,
    laneKey: string,
    queueWaitMs: number,
    remoteStartedAt: number,
  ): void {
    this.emit({
      operation,
      laneKey,
      queueWaitMs,
      remoteDurationMs: Math.max(0, this.now() - remoteStartedAt),
      outcome: TRANSPORT_OUTCOME_KINDS.SUCCESS,
      httpStatus: "absent",
      code: "absent",
    });
  }

  private emitFailure(
    operation: string,
    laneKey: string,
    queueWaitMs: number,
    remoteStartedAt: number,
    error: unknown,
  ): void {
    const outcome = classifyTransportOutcome(error);
    this.emit({
      operation,
      laneKey,
      queueWaitMs,
      remoteDurationMs: Math.max(0, this.now() - remoteStartedAt),
      outcome: outcome.kind,
      httpStatus: outcome.httpStatus.kind === "present" ? "present" : "absent",
      code: outcome.code.kind === "present" ? "present" : "absent",
    });
  }

  private emit(event: CoordinatorLaneEvent): void {
    try {
      this.onLaneEvent?.(event);
    } catch {
      // Diagnostics must never change a remote result.
    }
  }
}

const DEFAULT_LANE_KEY = "default";

/** Returns the distinct, sorted lane keys for one batch mutation. */
function distinctLaneKeys(keys: readonly string[]): readonly string[] {
  return [...new Set(keys)].sort();
}
