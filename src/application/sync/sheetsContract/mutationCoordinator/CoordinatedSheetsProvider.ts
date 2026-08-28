/**
 * Per-spreadsheet provider coordinator that serializes remote mutations.
 *
 * The Google Sheets API is not transactional across requests, and concurrent
 * in-flight requests to one spreadsheet can race (duplicate-row appends,
 * interleaved update/delete batches) and burn quota with lock-style retries.
 * Before this coordinator, the outbound effect worker, the User_Input polling
 * supervisor, provisioning, and test controls each called the provider
 * directly, so several in-flight requests competed for the same Sheet context
 * at once. Under load that produced write races and tail latency dominated by
 * retries.
 *
 * The coordinator is a transparent decorator: it implements the same provider
 * boundary the worker and polling already use, so no caller changes are
 * required. It routes every mutation and recovery barrier through one
 * per-spreadsheet FIFO lane (default total concurrency 1) while leaving
 * lock-free value reads untouched. SQLite outbox, leases, receipts, CAS, and
 * fencing remain the durable authority; the coordinator only prevents the Node
 * side from issuing competing mutations.
 *
 * Invariants preserved:
 * - Total mutation concurrency is 1 per lane by default, giving one in-flight
 *   write per spreadsheet at a time.
 * - Lock-free reads (`readSnapshot`, `readRows`, `readRowsBatch`) never wait on
 *   the mutation lane.
 * - Recovery barriers (`readEffectPostcondition(s)`) use the mutation lane so a
 *   postcondition probe proves an earlier timed-out critical section ended.
 * - Batch mutation (`observeSnapshots`) acquires every involved lane in a
 *   stable sorted order, so it cannot deadlock with single-sheet mutations.
 * - Provisioning uses a dedicated lane so setup never races an append/write.
 * - A failing or throwing mutation releases the lane, so it never deadlocks.
 * - `runSerializedInner` runs an optional in-lane precondition (the effect
 *   lease renewal) after the lane is acquired and before the inner provider
 *   call, so queue time plus limiter waits cannot outlive the lease.
 */

import {
  isSyncSheetsObservationBatchProvider,
} from "../syncSheets.js";
import type {
  ApplySyncEffectsRequest,
  ApplySyncEffectsResult,
  EnsureSyncRowAnchorsRequest,
  EnsureSyncRowAnchorsResult,
  FastAppendRowsRequest,
  FastAppendRowsResult,
  PreparedApplyEffects,
  ReadSyncEffectPostconditionsRequest,
  ReadSyncSnapshotRequest,
  ReadSyncTableRowsRequest,
  SyncEffectPostcondition,
  SyncProjectionEffect,
  SyncEffectPostconditionResult,
  SyncSheetsSnapshot,
  SyncObservedSnapshot,
  SyncSheetsProvider,
  SyncSheetsObservationBatchProvider,
  SyncSheetsTableReader,
  SyncTableRowsResult,
  SyncEffectWorkerProvider,
} from "../syncSheets.js";
import { AsyncMutex, type AsyncMutexRelease } from "./asyncMutex.js";
import {
  TRANSPORT_OUTCOME_KINDS,
  type CoordinatorLaneEvent,
} from "./laneTelemetry.js";
import { classifyTransportOutcome } from "../transportOutcome.js";

/** Provider boundary the coordinator wraps (effect + observation + table read). */
export type CoordinatedSheetsInner =
  SyncSheetsProvider &
  SyncSheetsTableReader;

/**
 * Redacted, stable diagnostic for an aborted in-lane precondition.
 *
 * Static by design: it never embeds effect IDs, payloads, sheet names, or
 * provider errors, so it is safe to persist on outbox rows and logs.
 */
const COORDINATED_LANE_PRECONDITION_MESSAGE =
  "Mutation lane precondition failed before the remote call; the request was not sent.";

/**
 * Thrown when an in-lane precondition callback rejects before the remote
 * call. Carries only the static redacted message above.
 */
export class CoordinatedLanePreconditionError extends Error {
  public constructor() {
    super(COORDINATED_LANE_PRECONDITION_MESSAGE);
    this.name = "CoordinatedLanePreconditionError";
  }
}

/**
 * Raised when a coordinated provider wraps an inner provider that does not
 * implement the split apply stages. The dispatcher catches this and falls
 * back to the inner's single legacy `applyEffects` path.
 */
export class CoordinatedSplitApplyUnsupportedError extends Error {
  public constructor() {
    super("the inner provider does not support split apply preflight");
    this.name = "CoordinatedSplitApplyUnsupportedError";
  }
}

// SyncSheetsProvisioner is intentionally not wrapped: provisioning runs once
// at startup before the worker, so it stays on the original provisioner and
// never needs the mutation lane.

/** Options for constructing a per-spreadsheet coordinator. */
export interface CoordinatedSheetsProviderOptions<TInner extends CoordinatedSheetsInner> {
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
 * Serializes provider mutations per lane while keeping value reads lock-free.
 *
 * Implements the full provider, table-reader, observation-batch, and provisioner
 * boundary, so it can wrap both the real Google Sheets API provider and fakes.
 * When the inner provider lacks the one-request observation path, observation is
 * routed through `ensureRowAnchors` + `readSnapshot` inside the same held lane.
 */
export class CoordinatedSheetsProvider<TInner extends CoordinatedSheetsInner>
  implements SyncSheetsProvider, SyncSheetsTableReader, SyncSheetsObservationBatchProvider {
  private readonly inner: TInner;
  private readonly resolveKey: (physicalSheetId: string) => string;
  private readonly onLaneEvent: ((event: CoordinatorLaneEvent) => void) | undefined;
  private readonly now: () => number;
  private readonly lanes = new Map<string, AsyncMutex>();

  public constructor(options: CoordinatedSheetsProviderOptions<TInner>) {
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
   * competing provider request outside the coordinator.
   */
  public runSerializedControl<T>(
    physicalSheetId: string,
    operation: string,
    task: () => Promise<T>,
  ): Promise<T> {
    return this.runMutation(physicalSheetId, operation, task);
  }

  /**
   * Runs one internal remote task on the mutation lane with an optional
   * in-lane precondition hook.
   *
   * The effect dispatcher uses this so the worker's lease-renewal callback
   * runs AFTER the lane is acquired (covering queue wait time) but BEFORE the
   * inner provider's remote call (covering shared limiter waits and the call
   * itself). The `remote` closure receives the INNER provider and must call
   * it directly, so the call never re-enters this coordinator's lane and
   * cannot deadlock. When `beforeRemote` resolves false (or throws), a
   * `CoordinatedLanePreconditionError` is raised before any remote request
   * and the lane is released normally; lane telemetry still records the
   * aborted dispatch with a delivery-uncertain outcome.
   */
  public runSerializedInner<T>(
    physicalSheetId: string,
    operation: string,
    remote: (inner: TInner) => Promise<T>,
    beforeRemote?: () => Promise<boolean>,
  ): Promise<T> {
    return this.runMutation(physicalSheetId, operation, () => remote(this.inner), beforeRemote);
  }

  /**
   * Runs one internal remote task across ALL distinct mutation lanes for a
   * multi-tab batch, with the same optional in-lane precondition hook as
   * `runSerializedInner`. Acquiring every involved lane (in stable sorted
   * order) prevents another writer from interleaving on any tab while the
   * combined preflight/write or recovery read runs. Single-route callers keep
   * the single-lane `runSerializedInner` path.
   */
  public runSerializedInnerForRoutes<T>(
    physicalSheetIds: readonly string[],
    operation: string,
    remote: (inner: TInner) => Promise<T>,
    beforeRemote?: () => Promise<boolean>,
  ): Promise<T> {
    const keys = distinctLaneKeys(physicalSheetIds.map((id) => this.resolveKey(id)));
    return this.runInLanes(keys, operation, () => remote(this.inner), beforeRemote);
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

  /**
   * Lock-free read+plan stage of one apply request.
   *
   * Preflight is a read-only stage (sheet enumeration plus a ranged data
   * read) and must NOT hold the mutation lane: a read-ahead worker wants to
   * run another route's preflight concurrently with a write. The subsequent
   * write+verify stage is serialized under the lanes (by the dispatcher via
   * `runSerializedInner`, and by this coordinator's own `applyPreparedEffects`
   * for direct callers), and the CAS guards already make a stale read safe.
   */
  public async preflightApplyEffects(
    request: ApplySyncEffectsRequest,
  ): Promise<PreparedApplyEffects> {
    if (
      this.inner.preflightApplyEffects === undefined ||
      this.inner.applyPreparedEffects === undefined
    ) {
      // The inner is a legacy provider (e.g. a fake or an older provider) or
      // exposes only ONE of the two split stages. Split apply is only valid
      // when BOTH exist; a partial inner must use the single `applyEffects`
      // path. Signal unsupported so the dispatcher falls back to the inner's
      // single `applyEffects` call.
      throw new CoordinatedSplitApplyUnsupportedError();
    }
    return this.inner.preflightApplyEffects(request);
  }

  /**
   * Write+verify stage of one apply request, serialized under the mutation
   * lanes derived from the prepared state's own effect routes.
   *
   * The write stage is a REMOTE MUTATION, so unlike the lock-free preflight
   * above it must never bypass the lanes: a direct consumer of this
   * coordinator that calls `applyPreparedEffects` itself (instead of going
   * through the effect dispatcher) previously reached the inner provider
   * unserialized and could interleave with a concurrent fast append or
   * regular write on the same spreadsheet. The call therefore acquires every
   * involved lane (stable sorted order, same as `observeSnapshots`) before
   * delegating.
   *
   * The dispatcher path cannot deadlock on this: it dispatches through
   * `runSerializedInner`/`runSerializedInnerForRoutes`, whose `remote` closure
   * receives the INNER provider and calls it directly, so it never re-enters
   * this method while its lanes are already held. No caller may invoke this
   * method from inside a `runSerializedControl`/`runSerializedInner` task (the
   * lanes are not reentrant); the only production writer path is the
   * dispatcher's out-of-lane preflight plus in-lane write, which this change
   * keeps byte-identical.
   */
  public async applyPreparedEffects(
    prepared: PreparedApplyEffects,
  ): Promise<ApplySyncEffectsResult> {
    if (
      this.inner.preflightApplyEffects === undefined ||
      this.inner.applyPreparedEffects === undefined
    ) {
      // A partial inner must never be driven into `applyPrepared`; signal
      // unsupported so the dispatcher falls back to the inner's single
      // `applyEffects` call.
      throw new CoordinatedSplitApplyUnsupportedError();
    }
    const innerApplyPrepared = this.inner.applyPreparedEffects;
    // Derive the lanes from the prepared state's own per-effect route fields
    // so a multi-tab prepared state holds every involved lane, exactly like
    // the dispatcher's `runSerializedInnerForRoutes` multi-tab dispatch. The
    // token crosses an opaque boundary, so an unusable shape fails closed
    // before any lane is acquired or any remote call is made.
    const keys = distinctLaneKeys(
      preparedLanePhysicalSheetIds(prepared).map((id) => this.resolveKey(id)),
    );
    return this.runInLanes(keys, "applyPreparedEffects", () =>
      innerApplyPrepared.call(this.inner, prepared),
    );
  }

  public async readEffectPostcondition(effect: SyncProjectionEffect): Promise<SyncEffectPostcondition> {
    return this.runMutation(effect.physicalSheetId, "readEffectPostcondition", () =>
      this.inner.readEffectPostcondition(effect),
    );
  }

  public async readEffectPostconditions(
    request: ReadSyncEffectPostconditionsRequest,
  ): Promise<readonly SyncEffectPostconditionResult[]> {
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
      if (isSyncSheetsObservationBatchProvider(this.inner)) {
        // Delegate the whole batch to the inner provider so one remote request
        // covers every requested projection; serializing one request at a time
        // here would defeat that shared round trip.
        return this.inner.observeSnapshots(requests);
      }
      const results: SyncObservedSnapshot[] = [];
      for (const request of requests) {
        // Sequential fallback for inner providers without the batch capability;
        // each request still runs under the already-held lanes.
        // eslint-disable-next-line no-await-in-loop
        results.push(await this.observeOneInner(request));
      }
      return results;
    });
  }

  /** Lock-free snapshot read; never waits on the mutation lane. */
  public async readSnapshot(request: ReadSyncSnapshotRequest): Promise<SyncSheetsSnapshot> {
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
   * Observes one snapshot through the inner provider, using its single-request
   * capability when present and falling back to ensure+read otherwise. Both
   * calls run inside the caller's already-held lane, so observation stays
   * serialized against competing mutations.
   */
  private async observeOneInner(request: ReadSyncSnapshotRequest): Promise<SyncObservedSnapshot> {
    if (isSyncSheetsObservationBatchProvider(this.inner)) {
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
    beforeRemote?: () => Promise<boolean>,
  ): Promise<T> {
    const key = this.resolveKey(physicalSheetId);
    return this.runInLanes([key], operation, task, beforeRemote);
  }

  private async runInLanes<T>(
    keys: readonly string[],
    operation: string,
    task: () => Promise<T>,
    beforeRemote?: () => Promise<boolean>,
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
        // The in-lane precondition runs after the queue wait but before any
        // remote request; a false result aborts the dispatch with a redacted
        // classified error instead of sending a write with an expired lease.
        if (beforeRemote !== undefined && !(await beforeRemote())) {
          throw new CoordinatedLanePreconditionError();
        }
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

/** The in-lane dispatch capability the effect dispatcher detects on a provider. */
export type CoordinatedSerializedInnerProvider = Pick<
  CoordinatedSheetsProvider<CoordinatedSheetsInner>,
  "runSerializedInner"
> & {
  /** Multi-route variant; absent on legacy coordinators that predate it. */
  runSerializedInnerForRoutes?: CoordinatedSheetsProvider<CoordinatedSheetsInner>["runSerializedInnerForRoutes"];
};

/**
 * Returns whether a provider exposes the coordinator's in-lane dispatch hook.
 *
 * The effect dispatcher uses this to route its `beforeRemoteDispatch` lease
 * renewal through the acquired mutation lane; providers without the hook
 * (bare fakes and test doubles) keep the direct call path and simply ignore
 * the hook.
 */
export function hasCoordinatedSerializedInner(
  provider: SyncEffectWorkerProvider,
): provider is SyncEffectWorkerProvider & CoordinatedSerializedInnerProvider {
  return typeof (provider as Partial<CoordinatedSerializedInnerProvider>).runSerializedInner === "function";
}

/**
 * Returns whether a provider exposes the coordinator's multi-route in-lane
 * dispatch hook (`runSerializedInnerForRoutes`).
 *
 * The effect dispatcher uses this to decide whether a multi-tab call can
 * acquire every involved mutation lane in one serialized pass. Legacy
 * coordinators that predate the multi-route hook expose only
 * `runSerializedInner`; the dispatcher falls back to that single-lane path
 * instead of crashing on a missing method.
 */
export function hasCoordinatedSerializedInnerForRoutes(
  provider: SyncEffectWorkerProvider,
): provider is SyncEffectWorkerProvider &
  Pick<CoordinatedSheetsProvider<CoordinatedSheetsInner>, "runSerializedInnerForRoutes"> {
  return typeof (provider as Partial<CoordinatedSerializedInnerProvider>).runSerializedInnerForRoutes === "function";
}

/** Returns the distinct, sorted lane keys for one batch mutation. */
function distinctLaneKeys(keys: readonly string[]): readonly string[] {
  return [...new Set(keys)].sort();
}

/**
 * Collects the physical sheet ids one prepared apply state would mutate, from
 * its own per-effect route fields.
 *
 * The prepared token crosses an opaque boundary, so its route shape is
 * validated here: a token without the request effects it was preflighted from
 * cannot be mapped to mutation lanes and fails closed before any lane is
 * acquired or any remote call is made.
 */
function preparedLanePhysicalSheetIds(prepared: PreparedApplyEffects): readonly string[] {
  const effects: unknown = prepared.request?.effects;
  if (!Array.isArray(effects) || effects.length === 0) {
    throw new TypeError("prepared apply state carries no effect routes");
  }
  const ids: string[] = [];
  for (const effect of effects) {
    const physicalSheetId = (effect as SyncProjectionEffect | undefined)?.physicalSheetId;
    if (typeof physicalSheetId !== "string" || physicalSheetId.length === 0) {
      throw new TypeError("prepared apply state carries an effect without a physical sheet id");
    }
    ids.push(physicalSheetId);
  }
  return ids;
}
