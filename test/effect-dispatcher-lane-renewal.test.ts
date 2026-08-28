/**
 * End-to-end tests for the before-remote effect-lease renewal.
 *
 * The worker splits its pre-dispatch refresh: the writer fence and dispatch
 * authority are prepared before the mutation lane, while the effect-lease
 * renewal runs inside the coordinated provider's acquired lane immediately
 * before the inner provider call. These tests hold the coordinator lane (and
 * in one case let the lease expire while queued) to prove the renewal happens
 * after the queue wait and before any remote request, and that a failed
 * renewal never sends a write and recovers durably.
 */

import {
  defineEntity,
  MikroORM,
  NodeSqliteDialect,
  p,
  SqliteDriver,
} from "@mikro-orm/sql";
import { afterEach, describe, expect, it } from "vitest";

import { APPLICABILITY_KINDS, PRESENCE_KINDS } from "../src/shared/state/constants.js";
import {
  appendPendingEffectsWithAdapter,
  claimWriterLeaseWithAdapter,
  runEffectWorkerWithAdapter,
  type DispatchRequest,
  type NewEffect,
  type OutboxPayloadHash,
  type PendingEffect,
  type PreparedDispatch,
} from "@hikoutei/ikisaki";
import {
  computeSyncVisibleHash,
  serializeSyncProjectionEffectPayload,
  type ApplySyncEffectsRequest,
  type ApplySyncEffectsResult,
  type FastAppendRowsRequest,
  type FastAppendRowsResult,
  type ReadSyncEffectPostconditionsRequest,
  type SyncEffectPostconditionResult,
  type PreparedApplyEffects,
} from "../src/application/sync/sheetsContract/syncSheets.js";
import { absentValue } from "../src/shared/state/index.js";
import { TRANSPORT_OUTCOME_KINDS } from "../src/application/sync/sheetsContract/transportOutcome.js";
import {
  SYNC_SHEETS_ERROR_CODES,
  SyncSheetsContractError,
} from "../src/application/sync/sheetsContract/errors.js";
import type { CoordinatorLaneEvent } from "../src/application/sync/sheetsContract/mutationCoordinator/laneTelemetry.js";
import {
  CoordinatedSheetsProvider,
} from "../src/application/sync/sheetsContract/mutationCoordinator/CoordinatedSheetsProvider.js";
import {
  SheetsEffectDispatcher,
  SHEETS_SPREADSHEET_ROUTE_KEY,
  PreparedDispatchError,
} from "../src/application/sync/outbound/SheetsEffectDispatcher.js";
import type { SqlStorageAdapter } from "../src/adapter/persistence/contracts/sql.js";
import { FakeSyncSheetsProvider, type FakeSyncSheetInput } from "./support/FakeSyncSheetsProvider.js";
import { MikroOrmSqliteAdapter } from "../src/adapter/persistence/providers/mikro-orm/storage/MikroOrmSqliteAdapter.js";
import { migrateSqliteSchema } from "../src/infrastructure/storage/sqlite/migrateSchema.js";
import {
  GoogleSheetsApiSyncProvider,
} from "../src/adapter/sheets/providers/google-sheets-api/index.js";
import {
  StubSheetsTransport,
  StubSpreadsheet,
} from "./support/StubSheetsTransport.js";
import type { RegisteredSyncProjectionDefinition } from "../src/application/sync/sheetsContract/sheetsProvisioning.js";
import { SYNC_PROJECTIONS } from "../src/application/sync/sheetsContract/constants.js";

const EntitySchema = defineEntity({
  name: "LaneRenewalEntity",
  tableName: "lane_renewal_entity",
  properties: { id: p.string().primary() },
});

class Entity extends EntitySchema.class {}

EntitySchema.setClass(Entity);

const PHYSICAL_SHEET = "physical-lane";
const PHYSICAL_SHEET_A = "physical-lane-a";
const PHYSICAL_SHEET_B = "physical-lane-b";
const LOGICAL_SHEET = "logical-lane";
const WORKER_ID = "lane-renewal-worker";

/** Fake provider that records the provider-call entry instant and the durable lease state at that instant. */
class LaneProbeProvider extends FakeSyncSheetsProvider {
  public appendEntryAt: number | undefined;
  public leaseUntilAtEntry: number | undefined;

  public constructor(
    inputs: readonly FakeSyncSheetInput[],
    private readonly readLeaseUntil: (effectId: string) => Promise<number | undefined>,
    private readonly probedEffectId: string,
  ) {
    super(inputs);
  }

  public override async fastAppendRows(
    request: FastAppendRowsRequest,
  ): Promise<FastAppendRowsResult> {
    this.appendEntryAt = Date.now();
    this.leaseUntilAtEntry = await this.readLeaseUntil(this.probedEffectId);
    return super.fastAppendRows(request);
  }
}

/** Fake provider that records when the combined multi-tab append call starts. */
class MultiTabProbeProvider extends FakeSyncSheetsProvider {
  public entryAt: number | undefined;

  public override async fastAppendRows(
    request: FastAppendRowsRequest,
  ): Promise<FastAppendRowsResult> {
    this.entryAt = Date.now();
    return super.fastAppendRows(request);
  }
}

/** Fake provider that records when the combined multi-tab regular apply call starts. */
class MultiTabApplyProbeProvider extends FakeSyncSheetsProvider {
  public entryAt: number | undefined;

  public override async applyEffects(
    request: ApplySyncEffectsRequest,
  ): Promise<ApplySyncEffectsResult> {
    this.entryAt = Date.now();
    return super.applyEffects(request);
  }
}

/** Fake provider that records when the combined multi-tab recovery read starts. */
class MultiTabPostconditionProbeProvider extends FakeSyncSheetsProvider {
  public entryAt: number | undefined;

  public override async readEffectPostconditions(
    request: ReadSyncEffectPostconditionsRequest,
  ): Promise<readonly SyncEffectPostconditionResult[]> {
    this.entryAt = Date.now();
    return super.readEffectPostconditions(request);
  }
}

/**
 * Legacy coordinator that exposes only the single-lane in-lane hook
 * (`runSerializedInner`), predating `runSerializedInnerForRoutes`.
 */
class LegacyCoordinatedProvider extends FakeSyncSheetsProvider {
  public runSerializedInnerCalls = 0;

  public async runSerializedInner<T>(
    _physicalSheetId: string,
    _operation: string,
    remote: (inner: FakeSyncSheetsProvider) => Promise<T>,
    beforeRemote?: () => Promise<boolean>,
  ): Promise<T> {
    this.runSerializedInnerCalls += 1;
    if (beforeRemote !== undefined && !(await beforeRemote())) {
      throw new Error("precondition failed");
    }
    return remote(this);
  }
}

/** Storage the dispatcher never touches on the apply/readPostconditions path. */
const UNUSED_STORAGE: SqlStorageAdapter = {
  read: async () => {
    throw new Error("storage must not be used on the apply/readPostconditions path");
  },
  transaction: async () => {
    throw new Error("storage must not be used on the apply/readPostconditions path");
  },
};

describe("effect dispatcher before-remote lease renewal", () => {
  const openOrms: Array<Awaited<ReturnType<typeof createOrm>>> = [];

  afterEach(async () => {
    await Promise.all(openOrms.splice(0).map((orm) => orm.close(true)));
  });

  it("renews the effect lease inside the held coordinator lane before the provider call", async () => {
    const orm = await createOrm();
    openOrms.push(orm);
    const adapter = new MikroOrmSqliteAdapter(orm);
    await migrateSqliteSchema(adapter);
    await registerProjection(adapter);

    const now = Date.now();
    const fence = await claimTestFence(adapter, now);
    const effect = createAppendEffect("lane-renewal");
    await expect(appendPendingEffectsWithAdapter(adapter, fence, [effect])).resolves.toBe(true);

    const inner = new LaneProbeProvider([sheetInput()], (effectId) => readLeaseUntil(adapter, effectId), effect.effectId);
    const laneEvents: CoordinatorLaneEvent[] = [];
    const coordinator = new CoordinatedSheetsProvider({
      inner,
      onLaneEvent: (event) => laneEvents.push(event),
    });
    const dispatcher = new SheetsEffectDispatcher({ provider: coordinator, storage: adapter });

    // Hold the mutation lane for 800ms: the worker's dispatch queues behind
    // this holder, so the effect lease MUST be renewed after the queue wait
    // and immediately before the inner call, never at claim time.
    let releaseHolder!: () => void;
    const holderGate = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let holderStarted!: () => void;
    const holderStartedPromise = new Promise<void>((resolve) => {
      holderStarted = resolve;
    });
    let holderEndedAt = 0;
    const holder = coordinator.runSerializedControl(effect.physicalSheetId, "lane-holder", async () => {
      holderStarted();
      await holderGate;
      holderEndedAt = Date.now();
    });
    await holderStartedPromise;

    const pass = runEffectWorkerWithAdapter({
      storage: adapter,
      dispatcher,
      workerId: WORKER_ID,
      now,
      maxEffects: 1,
      effectLeaseDurationMs: 60_000,
    });

    // Keep the lane held while the worker claims and queues: the dispatch
    // must wait out the full hold before its in-lane renewal runs.
    await delay(800);
    releaseHolder();
    const report = await pass;
    await holder;

    expect(report).toMatchObject({ selected: 1, claimed: 1, applied: 1, failed: 0 });
    expect(inner.fastAppendCalls).toBe(1);
    // The provider call started only after the lane holder finished.
    expect(inner.appendEntryAt).toBeGreaterThanOrEqual(holderEndedAt);
    // The lease was renewed inside the acquired lane: nearly the full 60s
    // lease remained at the provider call. A claim-time-only renewal would
    // leave only ~59.2s (the 800ms queue wait already consumed) and fail.
    expect(inner.leaseUntilAtEntry! - inner.appendEntryAt!).toBeGreaterThan(59_500);
    await expect(readStatus(adapter, effect.effectId)).resolves.toBe("applied");
    // Lane telemetry still flows for the successful in-lane dispatch.
    expect(laneEvents.at(-1)?.outcome).toBe(TRANSPORT_OUTCOME_KINDS.SUCCESS);
  });

  it("acquires ALL distinct route lanes for a multi-tab fast append", async () => {
    const orm = await createOrm();
    openOrms.push(orm);
    const adapter = new MikroOrmSqliteAdapter(orm);
    await migrateSqliteSchema(adapter);
    await registerProjection(adapter, PHYSICAL_SHEET_A, "OrdersA");
    await registerProjection(adapter, PHYSICAL_SHEET_B, "OrdersB");    const now = Date.now();
    const fence = await claimTestFence(adapter, now);
    const effectA = createAppendEffectFor("lane-a", PHYSICAL_SHEET_A, "OrdersA");
    const effectB = createAppendEffectFor("lane-b", PHYSICAL_SHEET_B, "OrdersB");
    await expect(appendPendingEffectsWithAdapter(adapter, fence, [effectA, effectB])).resolves.toBe(true);

    const inner = new MultiTabProbeProvider([
      sheetInputFor(PHYSICAL_SHEET_A, "OrdersA"),
      sheetInputFor(PHYSICAL_SHEET_B, "OrdersB"),
    ]);
    // Per-sheet lane resolver: each physical sheet gets its own mutation lane,
    // so a multi-tab dispatch MUST acquire every involved lane to prevent a
    // concurrent writer on any tab from interleaving during the combined call.
    const coordinator = new CoordinatedSheetsProvider({
      inner,
      mutationKeyForPhysicalSheet: (id) => id,
    });
    const dispatcher = new SheetsEffectDispatcher({ provider: coordinator, storage: adapter });

    // Hold the SECOND tab's lane: a multi-tab dispatch must acquire it too, so
    // the provider call waits for this holder instead of running on the first
    // lane alone.
    let releaseHolder!: () => void;
    const holderGate = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let holderStarted!: () => void;
    const holderStartedPromise = new Promise<void>((resolve) => {
      holderStarted = resolve;
    });
    let holderEndedAt = 0;
    const holder = coordinator.runSerializedControl(PHYSICAL_SHEET_B, "lane-holder", async () => {
      holderStarted();
      await holderGate;
      holderEndedAt = Date.now();
    });
    await holderStartedPromise;

    const pass = runEffectWorkerWithAdapter({
      storage: adapter,
      dispatcher,
      workerId: WORKER_ID,
      now,
      maxEffects: 2,
      effectLeaseDurationMs: 60_000,
    });

    // Keep the second lane held while the worker claims and queues: the
    // multi-tab dispatch must wait out the full hold before its provider call.
    await delay(300);
    releaseHolder();
    const report = await pass;
    await holder;

    expect(report).toMatchObject({ selected: 2, claimed: 2, applied: 2, failed: 0 });
    // The two effects share one spreadsheet, so the dispatcher's
    // spreadsheet-scoped fast-append grouping keeps them in ONE atomic call
    // spanning both routes (never split per-route, so a later tab failure
    // cannot leave the earlier tab's rows already committed).
    expect(inner.fastAppendCalls).toBe(1);
    // The combined call acquires BOTH distinct route lanes: the route-B call
    // waits out the holder on the B lane, proving every distinct route lane is
    // acquired before the atomic multi-route write.
    expect(inner.entryAt).toBeGreaterThanOrEqual(holderEndedAt);
    await expect(readStatus(adapter, effectA.effectId)).resolves.toBe("applied");
    await expect(readStatus(adapter, effectB.effectId)).resolves.toBe("applied");
  });

  it("acquires ALL distinct route lanes for a multi-tab apply", async () => {
    const effectA = createAppendEffectFor("lane-apply-a", PHYSICAL_SHEET_A, "OrdersA");
    const effectB = createAppendEffectFor("lane-apply-b", PHYSICAL_SHEET_B, "OrdersB");

    const inner = new MultiTabApplyProbeProvider([
      sheetInputFor(PHYSICAL_SHEET_A, "OrdersA"),
      sheetInputFor(PHYSICAL_SHEET_B, "OrdersB"),
    ]);
    const coordinator = new CoordinatedSheetsProvider({
      inner,
      mutationKeyForPhysicalSheet: (id) => id,
    });
    const dispatcher = new SheetsEffectDispatcher({ provider: coordinator, storage: UNUSED_STORAGE });

    // Hold the SECOND tab's lane: a multi-tab apply must acquire it too, so
    // the combined applyEffects call waits for this holder instead of running
    // on the first lane alone.
    let releaseHolder!: () => void;
    const holderGate = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let holderStarted!: () => void;
    const holderStartedPromise = new Promise<void>((resolve) => {
      holderStarted = resolve;
    });
    let holderEndedAt = 0;
    const holder = coordinator.runSerializedControl(PHYSICAL_SHEET_B, "lane-holder", async () => {
      holderStarted();
      await holderGate;
      holderEndedAt = Date.now();
    });
    await holderStartedPromise;

    const applyPromise = dispatcher.apply({
      routeKey: SHEETS_SPREADSHEET_ROUTE_KEY,
      effects: [pendingFrom(effectA), pendingFrom(effectB)],
      beforeRemoteDispatch: async () => true,
    });

    await delay(300);
    releaseHolder();
    const outcome = await applyPromise;
    await holder;

    // Both effects route through ONE combined applyEffects call.
    expect(inner.applyEffectsCalls).toBe(1);
    // The provider call started only after the second lane's holder finished,
    // proving the multi-tab apply acquired BOTH distinct route lanes.
    expect(inner.entryAt!).toBeGreaterThanOrEqual(holderEndedAt);
    expect(outcome.results.map((r) => r.effectId).sort()).toEqual(
      [effectA.effectId, effectB.effectId].sort(),
    );
  });

  it("acquires ALL distinct route lanes for a multi-tab postcondition read", async () => {
    const effectA = createAppendEffectFor("lane-read-a", PHYSICAL_SHEET_A, "OrdersA");
    const effectB = createAppendEffectFor("lane-read-b", PHYSICAL_SHEET_B, "OrdersB");

    const inner = new MultiTabPostconditionProbeProvider([
      sheetInputFor(PHYSICAL_SHEET_A, "OrdersA"),
      sheetInputFor(PHYSICAL_SHEET_B, "OrdersB"),
    ]);
    const coordinator = new CoordinatedSheetsProvider({
      inner,
      mutationKeyForPhysicalSheet: (id) => id,
    });
    const dispatcher = new SheetsEffectDispatcher({ provider: coordinator, storage: UNUSED_STORAGE });

    // Hold the SECOND tab's lane: a multi-tab recovery read must acquire it
    // too so no writer can interleave on any tab during the combined probe.
    let releaseHolder!: () => void;
    const holderGate = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let holderStarted!: () => void;
    const holderStartedPromise = new Promise<void>((resolve) => {
      holderStarted = resolve;
    });
    let holderEndedAt = 0;
    const holder = coordinator.runSerializedControl(PHYSICAL_SHEET_B, "lane-holder", async () => {
      holderStarted();
      await holderGate;
      holderEndedAt = Date.now();
    });
    await holderStartedPromise;

    const readPromise = dispatcher.readPostconditions({
      routeKey: SHEETS_SPREADSHEET_ROUTE_KEY,
      effects: [pendingFrom(effectA), pendingFrom(effectB)],
      beforeRemoteDispatch: async () => true,
    });

    await delay(300);
    releaseHolder();
    const outcome = await readPromise;
    await holder;

    expect(inner.postconditionBatchReads).toBe(1);
    expect(inner.entryAt!).toBeGreaterThanOrEqual(holderEndedAt);
    expect(outcome.results.map((r) => r.effectId).sort()).toEqual(
      [effectA.effectId, effectB.effectId].sort(),
    );
  });

  it("routes multi-tab calls through a legacy single-lane coordinator without crashing", async () => {
    const effectA = createAppendEffectFor("lane-legacy-a", PHYSICAL_SHEET_A, "OrdersA");
    const effectB = createAppendEffectFor("lane-legacy-b", PHYSICAL_SHEET_B, "OrdersB");

    // A legacy coordinator exposes only `runSerializedInner` (no
    // `runSerializedInnerForRoutes`): a multi-tab call must fall back to that
    // single-lane hook instead of crashing on a missing method.
    const inner = new LegacyCoordinatedProvider([
      sheetInputFor(PHYSICAL_SHEET_A, "OrdersA"),
      sheetInputFor(PHYSICAL_SHEET_B, "OrdersB"),
    ]);
    const dispatcher = new SheetsEffectDispatcher({ provider: inner, storage: UNUSED_STORAGE });

    const outcome = await dispatcher.apply({
      routeKey: SHEETS_SPREADSHEET_ROUTE_KEY,
      effects: [pendingFrom(effectA), pendingFrom(effectB)],
      beforeRemoteDispatch: async () => true,
    });

    expect(inner.runSerializedInnerCalls).toBe(1);
    expect(inner.applyEffectsCalls).toBe(1);
    expect(outcome.results.map((r) => r.effectId).sort()).toEqual(
      [effectA.effectId, effectB.effectId].sort(),
    );
  });

  it("never sends a write when the lease expires while queued on the lane and recovers durably", async () => {
    const orm = await createOrm();
    openOrms.push(orm);
    const adapter = new MikroOrmSqliteAdapter(orm);
    await migrateSqliteSchema(adapter);
    await registerProjection(adapter);

    const now = Date.now();
    const fence = await claimTestFence(adapter, now);
    const effect = createAppendEffect("lane-expired");
    await expect(appendPendingEffectsWithAdapter(adapter, fence, [effect])).resolves.toBe(true);

    const inner = new LaneProbeProvider([sheetInput()], (effectId) => readLeaseUntil(adapter, effectId), effect.effectId);
    const laneEvents: CoordinatorLaneEvent[] = [];
    const coordinator = new CoordinatedSheetsProvider({
      inner,
      onLaneEvent: (event) => laneEvents.push(event),
    });
    const dispatcher = new SheetsEffectDispatcher({ provider: coordinator, storage: adapter });

    // The lane is held well past the 300ms effect lease, so by the time the
    // worker acquires the lane the lease has expired and the in-lane renewal
    // must fail BEFORE any remote request.
    let releaseHolder!: () => void;
    const holderGate = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let holderStarted!: () => void;
    const holderStartedPromise = new Promise<void>((resolve) => {
      holderStarted = resolve;
    });
    const holder = coordinator.runSerializedControl(effect.physicalSheetId, "lane-holder", async () => {
      holderStarted();
      await holderGate;
    });
    await holderStartedPromise;

    const pass = runEffectWorkerWithAdapter({
      storage: adapter,
      dispatcher,
      workerId: WORKER_ID,
      now,
      maxEffects: 1,
      effectLeaseDurationMs: 300,
    });

    // Keep the lane held past the 300ms effect lease: the worker claims at
    // pass start and queues, so by the time it acquires the lane the lease
    // has expired and the in-lane renewal must fail before any remote call.
    await delay(800);
    releaseHolder();
    const report = await pass;
    await holder;

    // No remote write and no remote read happened in this pass: the expired
    // lease aborted the dispatch inside the lane, and the recovery probe was
    // aborted the same way before its remote read.
    expect(report).toMatchObject({ selected: 1, claimed: 1, applied: 0, failed: 0 });
    expect(inner.fastAppendCalls).toBe(0);
    expect(inner.postconditionBatchReads).toBe(0);
    // The aborted in-lane dispatch is visible in lane telemetry with a
    // delivery-uncertain outcome, never as a success.
    expect(laneEvents.some((event) =>
      event.operation === "fastAppendRows" &&
      event.outcome === TRANSPORT_OUTCOME_KINDS.DELIVERY_UNCERTAIN)).toBe(true);
    // Durable recovery: the expired claim is now a due delivery-uncertain
    // probe with the stable lease-expired code (no raw error or id text).
    await expect(readOutboxRow(adapter, effect.effectId)).resolves.toMatchObject({
      status: "delivery_uncertain",
      last_error_code: "lease_expired_requires_postcondition",
      last_error_message: "Read the remote postcondition before retrying this effect.",
    });

    // Pass 2 (probe due): the probe runs through the same protected lane and
    // proves the effect was never applied, returning it to pending.
    const probeReport = await runEffectWorkerWithAdapter({
      storage: adapter,
      dispatcher,
      workerId: WORKER_ID,
      now: Date.now() + 2_000,
      maxEffects: 1,
      effectLeaseDurationMs: 60_000,
    });
    expect(probeReport).toMatchObject({ applied: 0, failed: 0, requeued: 1, deferred: 1 });
    expect(inner.postconditionBatchReads).toBe(1);
    await expect(readStatus(adapter, effect.effectId)).resolves.toBe("pending");

    // Pass 3 (redrive due): the requeued effect dispatches with a fresh
    // in-lane renewal and applies. `now` must advance past the requeue's
    // 1s next-attempt delay recorded at the end of pass 2.
    const applyReport = await runEffectWorkerWithAdapter({
      storage: adapter,
      dispatcher,
      workerId: WORKER_ID,
      now: Date.now() + 4_000,
      maxEffects: 1,
      effectLeaseDurationMs: 60_000,
    });
    expect(applyReport).toMatchObject({ applied: 1, failed: 0 });
    expect(inner.fastAppendCalls).toBe(1);
    await expect(readStatus(adapter, effect.effectId)).resolves.toBe("applied");
  });

  it("refuses the in-lane write through the bounded limiter even after a successful lease renewal, then recovers when the queue drains", async () => {
    const orm = await createOrm();
    openOrms.push(orm);
    const adapter = new MikroOrmSqliteAdapter(orm);
    await migrateSqliteSchema(adapter);
    await registerProjection(adapter);

    const workerNow = Date.now();
    const fence = await claimTestFence(adapter, workerNow);
    const effect = createAppendEffect("lane-busy");
    await expect(appendPendingEffectsWithAdapter(adapter, fence, [effect])).resolves.toBe(true);

    // Real provider over the stub spreadsheet with a FROZEN pacing clock
    // while concurrent lock-free polling reads pile up: the shared limiter
    // horizon sits two intervals ahead of the clock, exactly the Luna High
    // queue the bounded admission must refuse instead of waiting out.
    let providerNow = 1_000_000;
    let advanceClockOnSleep = false;
    const spreadsheet = new StubSpreadsheet();
    spreadsheet.addTab("Orders", { headers: ["id", "status"] });
    const transport = new StubSheetsTransport(spreadsheet);
    transport.now = () => providerNow;
    const provider = new GoogleSheetsApiSyncProvider({
      spreadsheetId: "spreadsheet-busy-lane",
      definitions: [busyLaneDefinition()],
      transport,
      requestTimeoutMs: 60_000,
      rateLimitIntervalMs: 1_100,
      // Keep the admission bound at one interval so the frozen-clock queue
      // (two intervals ahead) is deterministically refused.
      requestStartMaxWaitMs: 1_100,
      now: () => providerNow,
      sleep: async (ms: number) => {
        if (advanceClockOnSleep) providerNow += ms;
      },
    });
    const laneEvents: CoordinatorLaneEvent[] = [];
    const coordinator = new CoordinatedSheetsProvider({
      inner: provider,
      onLaneEvent: (event) => laneEvents.push(event),
    });
    const dispatcher = new SheetsEffectDispatcher({ provider: coordinator, storage: adapter });

    // Prime the shared limiter with three concurrent lock-free polling reads:
    // two are admitted (slots t0 and t0+I), the third is already refused.
    const readRequest = {
      physicalSheetId: PHYSICAL_SHEET,
      sheetName: "Orders",
      registeredRange: "A:B",
      projection: SYNC_PROJECTIONS.SYSTEM_STATE,
      schemaVersion: 1,
      headers: ["id", "status"],
    };
    const primed = await Promise.allSettled([
      provider.readRows(readRequest),
      provider.readRows(readRequest),
      provider.readRows(readRequest),
    ]);
    expect(primed.map((result) => result.status)).toEqual([
      "fulfilled",
      "fulfilled",
      "rejected",
    ]);
    expect(transport.getSpreadsheetCalls).toBe(2);

    // Pass 1 with the frozen clock: the worker renews the effect lease
    // INSIDE the acquired lane (it succeeds — 60s lease), then the provider
    // admission is refused because the horizon is two intervals ahead. Zero
    // remote calls from the dispatch; the postcondition probe is paced on the
    // WRITE limiter (idle), so it succeeds and the effect is requeued as
    // pending rather than parked as delivery_uncertain.
    const pass1 = await runEffectWorkerWithAdapter({
      storage: adapter,
      dispatcher,
      workerId: WORKER_ID,
      now: workerNow,
      maxEffects: 1,
      effectLeaseDurationMs: 60_000,
    });
    expect(pass1).toMatchObject({ selected: 1, claimed: 1, applied: 0, failed: 0 });
    // The dispatch's preflight reads are refused on the saturated READ
    // limiter, so no remote write is attempted. The postcondition probe,
    // however, is paced on the WRITE limiter (idle), so it performs its two
    // reads and succeeds — it is no longer refused by read-side contention.
    expect(transport.getSpreadsheetCalls).toBe(4); // 2 priming + 2 probe reads
    expect(transport.batchUpdateCalls).toBe(0); // no remote write was attempted
    // The refused dispatch is visible in lane telemetry as delivery-uncertain;
    // the postcondition probe now succeeds on the write limiter.
    expect(laneEvents.some((event) =>
      event.operation === "fastAppendRows" &&
      event.outcome === TRANSPORT_OUTCOME_KINDS.DELIVERY_UNCERTAIN)).toBe(true);
    expect(laneEvents.some((event) =>
      event.operation === "readEffectPostconditions" &&
      event.outcome === TRANSPORT_OUTCOME_KINDS.SUCCESS)).toBe(true);
    // The probe confirms the write never landed, so the effect is requeued
    // as pending (retryable) instead of being parked as delivery-uncertain.
    await expect(readOutboxRow(adapter, effect.effectId)).resolves.toMatchObject({
      status: "pending",
    });

    // The queue drains: the clock jumps past the open horizon and pacing
    // sleeps advance it again. Because the pass-1 probe already confirmed the
    // write never landed (and requeued the effect as pending), pass 2
    // dispatches with fresh in-lane renewals and applies directly.
    advanceClockOnSleep = true;
    providerNow = 1_002_800; // t0 + 2.5 intervals: past the open slot
    const pass2 = await runEffectWorkerWithAdapter({
      storage: adapter,
      dispatcher,
      workerId: WORKER_ID,
      now: workerNow + 2_000,
      maxEffects: 1,
      effectLeaseDurationMs: 60_000,
    });
    expect(pass2).toMatchObject({ applied: 1, failed: 0 });
    await expect(readStatus(adapter, effect.effectId)).resolves.toBe("applied");
    expect(transport.batchUpdateCalls).toBe(1);

    const pass3 = await runEffectWorkerWithAdapter({
      storage: adapter,
      dispatcher,
      workerId: WORKER_ID,
      now: workerNow + 4_000,
      maxEffects: 1,
      effectLeaseDurationMs: 60_000,
    });
    expect(pass3).toMatchObject({ applied: 0, failed: 0 });
    await expect(readStatus(adapter, effect.effectId)).resolves.toBe("applied");
  });

  it("routes a DIRECT dispatcher call (no before-remote hook) through the same mutation lane", async () => {
    // A direct dispatcher call with NO `beforeRemoteDispatch` must still be
    // serialized through the coordinated provider's mutation lane. The
    // provider's `applyPreparedEffects`/`fastAppendRows` forwards to the inner
    // provider, so if the dispatcher bypassed the lane on the hookless path,
    // a concurrent holder on the same route could interleave with the write.
    const now = Date.now();
    const effect = createAppendEffectFor("direct-lane", PHYSICAL_SHEET_A, "OrdersA");
    const inner = new MultiTabProbeProvider([
      sheetInputFor(PHYSICAL_SHEET_A, "OrdersA"),
    ]);
    const coordinator = new CoordinatedSheetsProvider({ inner });
    const dispatcher = new SheetsEffectDispatcher({ provider: coordinator, storage: UNUSED_STORAGE });

    // Hold the mutation lane so a direct hookless call must wait for it.
    let releaseHolder!: () => void;
    const holderGate = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let holderStarted!: () => void;
    const holderStartedPromise = new Promise<void>((resolve) => {
      holderStarted = resolve;
    });
    let holderEndedAt = 0;
    const holder = coordinator.runSerializedControl(PHYSICAL_SHEET_A, "lane-holder", async () => {
      holderStarted();
      await holderGate;
      holderEndedAt = Date.now();
    });
    await holderStartedPromise;

    const call = dispatcher.fastAppend({
      routeKey: "spreadsheet-scope",
      effects: [pendingFrom(effect)],
      // No beforeRemoteDispatch hook: a direct non-worker dispatcher call.
    });

    await delay(200);
    releaseHolder();
    await call;
    await holder;

    // The direct hookless call waited out the lane holder before reaching the
    // inner provider, proving it did NOT bypass mutation serialization.
    expect(inner.entryAt).toBeGreaterThanOrEqual(holderEndedAt);
    expect(inner.fastAppendCalls).toBe(1);
  });
});

describe("SheetsEffectDispatcher split apply token and capability", () => {
  const splitRequest = (routeKey = "route-a"): DispatchRequest => ({
    routeKey,
    effects: [pendingFrom(createAppendEffectFor("token", PHYSICAL_SHEET_A, "OrdersA"))],
    beforeRemoteDispatch: async () => true,
  });

  /** Fake provider that optionally exposes the split stages. */
  class SplitProbeProvider extends FakeSyncSheetsProvider {
    public preflightCalls = 0;
    public applyPreparedCalls = 0;
    public constructor(inputs: readonly FakeSyncSheetInput[]) {
      super(inputs);
    }
    public async preflightApplyEffects(
      request: ApplySyncEffectsRequest,
    ): Promise<PreparedApplyEffects> {
      this.preflightCalls += 1;
      // Carry the exact request so the dispatcher's nested-state binding check
      // (request fingerprint) can validate the token it produces.
      return { kind: "single", request } as PreparedApplyEffects;
    }
    public async applyPreparedEffects(
      _prepared: PreparedApplyEffects,
    ): Promise<ApplySyncEffectsResult> {
      this.applyPreparedCalls += 1;
      return { results: [], snapshotHash: absentValue(), hasMore: false };
    }
  }

  /** Provider exposing ONLY the preflight stage (no applyPrepared). */
  class PreflightOnlyProvider extends FakeSyncSheetsProvider {
    public constructor(inputs: FakeSyncSheetInput[]) {
      super(inputs);
    }
    public async preflightApplyEffects(
      request: ApplySyncEffectsRequest,
    ): Promise<PreparedApplyEffects> {
      return { kind: "single", request };
    }
  }

  /** Provider whose preflight (read+plan) stage throws a fixed contract error. */
  class PreflightContractErrorProvider extends SplitProbeProvider {
    constructor(inputs: readonly FakeSyncSheetInput[], private readonly error: SyncSheetsContractError) {
      super(inputs);
    }
    public override async preflightApplyEffects(_request: ApplySyncEffectsRequest): Promise<PreparedApplyEffects> {
      throw this.error;
    }
  }

  it("falls back to legacy applyEffects when the provider exposes only preflight", async () => {
    const inner = new PreflightOnlyProvider([
      sheetInputFor(PHYSICAL_SHEET_A, "OrdersA"),
    ]);
    const dispatcher = new SheetsEffectDispatcher({ provider: inner, storage: UNUSED_STORAGE });
    const request = splitRequest();
    const token = await dispatcher.preflight(request);
    // A provider with only one split stage must use the single applyEffects
    // path, never fail during applyPrepared.
    const outcome = await dispatcher.applyPrepared(request, token);
    expect(outcome).toMatchObject({ hasMore: false });
    expect(inner.applyEffectsCalls).toBe(1);
  });

  it("falls back to legacy applyEffects when a coordinator wraps a partial inner", async () => {
    const inner = new PreflightOnlyProvider([
      sheetInputFor(PHYSICAL_SHEET_A, "OrdersA"),
    ]);
    const coordinator = new CoordinatedSheetsProvider({ inner });
    const dispatcher = new SheetsEffectDispatcher({ provider: coordinator, storage: UNUSED_STORAGE });
    const request = splitRequest();
    const token = await dispatcher.preflight(request);
    const outcome = await dispatcher.applyPrepared(request, token);
    expect(outcome).toMatchObject({ hasMore: false });
    expect(inner.applyEffectsCalls).toBe(1);
  });

  it("rejects sequential reuse of a legacy fallback token with no second write", async () => {
    const inner = new PreflightOnlyProvider([
      sheetInputFor(PHYSICAL_SHEET_A, "OrdersA"),
    ]);
    const dispatcher = new SheetsEffectDispatcher({ provider: inner, storage: UNUSED_STORAGE });
    const request = splitRequest();
    const token = await dispatcher.preflight(request);
    const first = await dispatcher.applyPrepared(request, token);
    expect(first).toMatchObject({ hasMore: false });
    expect(inner.applyEffectsCalls).toBe(1);
    // Reusing the same legacy fallback token must fail closed before any
    // remote call so a stale plan cannot replay a duplicate write.
    await expect(dispatcher.applyPrepared(request, token)).rejects.toBeInstanceOf(
      PreparedDispatchError,
    );
    expect(inner.applyEffectsCalls).toBe(1);
  });

  it("rejects concurrent reuse of a legacy fallback token with exactly one write", async () => {
    const inner = new PreflightOnlyProvider([
      sheetInputFor(PHYSICAL_SHEET_A, "OrdersA"),
    ]);
    const dispatcher = new SheetsEffectDispatcher({ provider: inner, storage: UNUSED_STORAGE });
    const request = splitRequest();
    const token = await dispatcher.preflight(request);
    const [first, second] = await Promise.allSettled([
      dispatcher.applyPrepared(request, token),
      dispatcher.applyPrepared(request, token),
    ]);
    const fulfilled = first.status === "fulfilled" ? first : second;
    const rejected = first.status === "rejected" ? first : second;
    expect(fulfilled.status).toBe("fulfilled");
    expect(rejected.status).toBe("rejected");
    // Exactly one `applyEffects` ran; the rejected concurrent reuse performed
    // no second remote mutation.
    expect(inner.applyEffectsCalls).toBe(1);
  });

  it("rejects in-place mutation of a legacy fallback token request before any write", async () => {
    const inner = new PreflightOnlyProvider([
      sheetInputFor(PHYSICAL_SHEET_A, "OrdersA"),
    ]);
    const dispatcher = new SheetsEffectDispatcher({ provider: inner, storage: UNUSED_STORAGE });
    const request = splitRequest();
    const token = await dispatcher.preflight(request);
    // The legacy token's request is deep-frozen, so a caller cannot mutate its
    // effects in place to dispatch a different request than the fingerprinted
    // one: the mutation must fail closed before `applyEffects` runs.
    const mutableEffects = (token as unknown as {
      readonly request: { readonly effects: Array<{ payloadHash: string }> };
    }).request.effects;
    expect(() => {
      mutableEffects[0]!.payloadHash = "mutated-in-place";
    }).toThrow(TypeError);
    expect(inner.applyEffectsCalls).toBe(0);
    // The frozen token still applies the ORIGINAL request exactly once.
    const outcome = await dispatcher.applyPrepared(request, token);
    expect(outcome).toMatchObject({ hasMore: false });
    expect(inner.applyEffectsCalls).toBe(1);
  });

  it("rejects a legacy fallback token bound to a DIFFERENT request without consuming it", async () => {
    const inner = new PreflightOnlyProvider([
      sheetInputFor(PHYSICAL_SHEET_A, "OrdersA"),
    ]);
    const dispatcher = new SheetsEffectDispatcher({ provider: inner, storage: UNUSED_STORAGE });
    const original = splitRequest("route-a");
    const token = await dispatcher.preflight(original);
    // A mismatched caller request (different effect payload hash on the same
    // route) must fail closed before any write AND must not consume the token,
    // so the same token can still be applied against its original request.
    const effects = splitRequest("route-a").effects.slice();
    effects[0] = {
      ...effects[0]!,
      payload_hash: "different-payload-hash" as OutboxPayloadHash,
    };
    const mismatched: DispatchRequest = { ...splitRequest("route-a"), effects };
    await expect(dispatcher.applyPrepared(mismatched, token)).rejects.toBeInstanceOf(
      PreparedDispatchError,
    );
    expect(inner.applyEffectsCalls).toBe(0);
    // The rejected mismatch did not consume the legacy token.
    const outcome = await dispatcher.applyPrepared(original, token);
    expect(outcome).toMatchObject({ hasMore: false });
    expect(inner.applyEffectsCalls).toBe(1);
  });

  it("classifies an unverified remote provider state during preflight as delivery_uncertain", async () => {
    // A malformed provider response / missing tab / receipt-schema drift during
    // the read+plan stage is raised as `SyncSheetsContractError` with the
    // `INVALID_PROVIDER_RESPONSE` code. It leaves the remote state unverified,
    // so the worker must requeue (delivery_uncertain), never close the effect
    // terminally as an explicit remote failure.
    const inner = new PreflightContractErrorProvider(
      [sheetInputFor(PHYSICAL_SHEET_A, "OrdersA")],
      new SyncSheetsContractError(
        SYNC_SHEETS_ERROR_CODES.INVALID_PROVIDER_RESPONSE,
        "receipt sheet contains an invalid receipt",
      ),
    );
    const dispatcher = new SheetsEffectDispatcher({ provider: inner, storage: UNUSED_STORAGE });
    await expect(dispatcher.preflight(splitRequest())).rejects.toMatchObject({
      kind: "delivery_uncertain",
    });
  });

  it("keeps a proven local invalid request during preflight as explicit_remote_failure", async () => {
    // A proven local request/config failure (invalid effect payload) is
    // terminal and keeps its existing explicit-remote-failure classification.
    const inner = new PreflightContractErrorProvider(
      [sheetInputFor(PHYSICAL_SHEET_A, "OrdersA")],
      new SyncSheetsContractError(
        SYNC_SHEETS_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
        "apply effects request is invalid",
      ),
    );
    const dispatcher = new SheetsEffectDispatcher({ provider: inner, storage: UNUSED_STORAGE });
    await expect(dispatcher.preflight(splitRequest())).rejects.toMatchObject({
      kind: "explicit_remote_failure",
    });
  });

  it("accepts a valid single-route prepared value and applies it", async () => {
    const inner = new SplitProbeProvider([sheetInputFor(PHYSICAL_SHEET_A, "OrdersA")]);
    const dispatcher = new SheetsEffectDispatcher({ provider: inner, storage: UNUSED_STORAGE });
    const request = splitRequest("route-a");
    const token = await dispatcher.preflight(request);
    // A valid single-route prepared value (kind "single" carrying the request
    // it was preflighted from) is accepted and applied through the split
    // write+verify stage, never the legacy fallback.
    const outcome = await dispatcher.applyPrepared(request, token);
    expect(outcome).toMatchObject({ hasMore: false });
    expect(inner.applyPreparedCalls).toBe(1);
    expect(inner.applyEffectsCalls).toBe(0);
  });

  it("rejects a token produced by a different dispatcher instance before any remote call", async () => {
    const inner = new SplitProbeProvider([sheetInputFor(PHYSICAL_SHEET_A, "OrdersA")]);
    const dispatcherA = new SheetsEffectDispatcher({ provider: inner, storage: UNUSED_STORAGE });
    const dispatcherB = new SheetsEffectDispatcher({ provider: inner, storage: UNUSED_STORAGE });
    const request = splitRequest();
    const foreignToken = await dispatcherA.preflight(request);
    await expect(dispatcherB.applyPrepared(request, foreignToken)).rejects.toBeInstanceOf(
      PreparedDispatchError,
    );
    expect(inner.applyPreparedCalls).toBe(0);
    expect(inner.applyEffectsCalls).toBe(0);
  });

  it("rejects a token bound to a different route before any remote call", async () => {
    const inner = new SplitProbeProvider([sheetInputFor(PHYSICAL_SHEET_A, "OrdersA")]);
    const dispatcher = new SheetsEffectDispatcher({ provider: inner, storage: UNUSED_STORAGE });
    const token = await dispatcher.preflight(splitRequest("route-a"));
    await expect(dispatcher.applyPrepared(splitRequest("route-b"), token)).rejects.toBeInstanceOf(
      PreparedDispatchError,
    );
    expect(inner.applyPreparedCalls).toBe(0);
    expect(inner.applyEffectsCalls).toBe(0);
  });

  it("rejects a token bound to a DIFFERENT request on the same dispatcher and route", async () => {
    const inner = new SplitProbeProvider([sheetInputFor(PHYSICAL_SHEET_A, "OrdersA")]);
    const dispatcher = new SheetsEffectDispatcher({ provider: inner, storage: UNUSED_STORAGE });
    // A token prepared for one effect must not be reusable for another effect
    // that shares the same dispatcher instance and route (stale/cross-request
    // replay protection) even though both effects target the same tab.
    const original = splitRequest("route-a");
    const token = await dispatcher.preflight(original);
    // Force a different effect payload hash on the same route: the fingerprint
    // must catch it and fail closed before any remote call.
    const effects = splitRequest("route-a").effects.slice();
    effects[0] = {
      ...effects[0]!,
      payload_hash: "different-payload-hash" as OutboxPayloadHash,
    };
    const tampered: DispatchRequest = { ...splitRequest("route-a"), effects };
    await expect(dispatcher.applyPrepared(tampered, token)).rejects.toBeInstanceOf(
      PreparedDispatchError,
    );
    expect(inner.applyPreparedCalls).toBe(0);
    expect(inner.applyEffectsCalls).toBe(0);
  });

  it("rejects a token whose nested prepared plan was replaced before any remote call", async () => {
    const inner = new SplitProbeProvider([sheetInputFor(PHYSICAL_SHEET_A, "OrdersA")]);
    const dispatcher = new SheetsEffectDispatcher({ provider: inner, storage: UNUSED_STORAGE });
    const request = splitRequest("route-a");
    const token = await dispatcher.preflight(request);
    // Replace the nested provider prepared state with a forged object that
    // carries the same dispatcher/route/request fingerprint: the private
    // identity registry must reject the replaced nested plan before any
    // remote call.
    const forged = {
      ...(token as unknown as Record<string, unknown>),
      preparedState: { kind: "single" },
    };
    await expect(dispatcher.applyPrepared(request, forged as unknown as PreparedDispatch)).rejects.toBeInstanceOf(
      PreparedDispatchError,
    );
    expect(inner.applyPreparedCalls).toBe(0);
    expect(inner.applyEffectsCalls).toBe(0);
  });

  it("rejects a prepared token applied twice (sequential reuse) with no second write", async () => {
    const inner = new SplitProbeProvider([sheetInputFor(PHYSICAL_SHEET_A, "OrdersA")]);
    const dispatcher = new SheetsEffectDispatcher({ provider: inner, storage: UNUSED_STORAGE });
    const request = splitRequest("route-a");
    const token = await dispatcher.preflight(request);
    const first = await dispatcher.applyPrepared(request, token);
    expect(first).toMatchObject({ hasMore: false });
    const callsAfterFirst = inner.applyPreparedCalls;
    // Reusing the same prepared token must fail closed before any remote call
    // so a stale plan cannot replay a duplicate append or delete.
    await expect(dispatcher.applyPrepared(request, token)).rejects.toBeInstanceOf(
      PreparedDispatchError,
    );
    expect(inner.applyPreparedCalls).toBe(callsAfterFirst);
    expect(inner.applyEffectsCalls).toBe(0);
  });

  it("rejects concurrent reuse of one prepared token with no second write", async () => {
    const inner = new SplitProbeProvider([sheetInputFor(PHYSICAL_SHEET_A, "OrdersA")]);
    const dispatcher = new SheetsEffectDispatcher({ provider: inner, storage: UNUSED_STORAGE });
    const request = splitRequest("route-a");
    const token = await dispatcher.preflight(request);
    const [first, second] = await Promise.allSettled([
      dispatcher.applyPrepared(request, token),
      dispatcher.applyPrepared(request, token),
    ]);
    const fulfilled = first.status === "fulfilled" ? first : second;
    const rejected = first.status === "rejected" ? first : second;
    expect(fulfilled.status).toBe("fulfilled");
    expect(rejected.status).toBe("rejected");
    // Exactly one write ran; the rejected concurrent reuse performed no second
    // write.
    expect(inner.applyPreparedCalls).toBe(1);
    expect(inner.applyEffectsCalls).toBe(0);
  });

  it("rejects a token whose nested state is bound to a different request", async () => {
    const inner = new SplitProbeProvider([sheetInputFor(PHYSICAL_SHEET_A, "OrdersA")]);
    const dispatcher = new SheetsEffectDispatcher({ provider: inner, storage: UNUSED_STORAGE });
    // Two preflights on the same route produce two distinct nested states, both
    // registered with this dispatcher. Swapping the nested state of token A for
    // token B's state (which IS in the registry) must still fail: the nested
    // state is bound to the exact request fingerprint, not just to the
    // dispatcher instance.
    const requestA: DispatchRequest = {
      routeKey: "route-a",
      effects: [pendingFrom(createAppendEffectFor("token", PHYSICAL_SHEET_A, "OrdersA"))],
      beforeRemoteDispatch: async () => true,
    };
    const requestB: DispatchRequest = {
      routeKey: "route-a",
      effects: [pendingFrom(createAppendEffectFor("other", PHYSICAL_SHEET_A, "OrdersA"))],
      beforeRemoteDispatch: async () => true,
    };
    const tokenA = await dispatcher.preflight(requestA);
    const tokenB = await dispatcher.preflight(requestB);
    const forged = {
      ...(tokenA as unknown as Record<string, unknown>),
      preparedState: (tokenB as unknown as Record<string, unknown>).preparedState,
    };
    await expect(dispatcher.applyPrepared(requestA, forged as unknown as PreparedDispatch)).rejects.toBeInstanceOf(
      PreparedDispatchError,
    );
    expect(inner.applyPreparedCalls).toBe(0);
    expect(inner.applyEffectsCalls).toBe(0);
  });

  it("rejects a malformed nested prepared state before any remote call", async () => {
    const inner = new SplitProbeProvider([sheetInputFor(PHYSICAL_SHEET_A, "OrdersA")]);
    const dispatcher = new SheetsEffectDispatcher({ provider: inner, storage: UNUSED_STORAGE });
    const request = splitRequest("route-a");
    const token = await dispatcher.preflight(request);
    // A nested state that is not a record (or carries no request) must fail
    // closed before any remote call.
    const forged = {
      ...(token as unknown as Record<string, unknown>),
      preparedState: { kind: "single" },
    };
    await expect(dispatcher.applyPrepared(request, forged as unknown as PreparedDispatch)).rejects.toBeInstanceOf(
      PreparedDispatchError,
    );
    expect(inner.applyPreparedCalls).toBe(0);
    expect(inner.applyEffectsCalls).toBe(0);
  });

  it("freezes the nested prepared state so in-place mutation is rejected", async () => {
    const inner = new SplitProbeProvider([sheetInputFor(PHYSICAL_SHEET_A, "OrdersA")]);
    const dispatcher = new SheetsEffectDispatcher({ provider: inner, storage: UNUSED_STORAGE });
    const request = splitRequest("route-a");
    const token = await dispatcher.preflight(request);
    const nested = (token as unknown as Record<string, unknown>).preparedState as Record<string, unknown>;
    // The nested state is deep-frozen at preflight time, so an in-place
    // mutation attempt must throw (strict mode) rather than silently changing
    // the plan the write stage will apply.
    expect(() => {
      (nested as { kind?: unknown }).kind = "multi";
    }).toThrow();
  });
});

async function createOrm() {
  const orm = await MikroORM.init({
    driver: SqliteDriver,
    dbName: ":memory:",
    driverOptions: new NodeSqliteDialect(":memory:"),
    entities: [Entity],
  });
  await orm.schema.create();
  return orm;
}

async function claimTestFence(
  adapter: MikroOrmSqliteAdapter,
  now: number,
): Promise<{ readonly role: string; readonly writerEpoch: number; readonly fencingToken: string; readonly now: number }> {
  const claim = await claimWriterLeaseWithAdapter(adapter, {
    role: "sync-effect-worker",
    writerId: WORKER_ID,
    leaseDurationMs: 60_000,
    now,
  });
  if (claim.kind !== "claimed") throw new Error("Expected a writer lease");
  return {
    role: claim.lease.role,
    writerEpoch: claim.lease.writerEpoch,
    fencingToken: claim.lease.fencingToken,
    now,
  };
}

function sheetInput(): FakeSyncSheetInput {
  return sheetInputFor(PHYSICAL_SHEET, "Orders");
}

function sheetInputFor(physicalSheetId: string, sheetName: string): FakeSyncSheetInput {
  return {
    physicalSheetId,
    sheetName,
    registeredRange: "A:B",
    projection: "system_state",
    schemaVersion: 1,
    headers: ["id", "status"],
    identityField: "id",
  };
}

/** A create-if-missing append effect matching the fake sheet above. */
function createAppendEffect(suffix: string): NewEffect {
  return createAppendEffectFor(suffix, PHYSICAL_SHEET, "Orders");
}

/** A create-if-missing append effect for one physical sheet/tab. */
function createAppendEffectFor(suffix: string, physicalSheetId: string, sheetName: string): NewEffect {
  const targetId = `order-${suffix}`;
  const fields = {
    id: { kind: "string" as const, value: targetId },
    status: { kind: "string" as const, value: "paid" },
  };
  return {
    effectId: `effect-${suffix}`,
    effectKind: "system_projection",
    commitId: `commit-${suffix}`,
    logicalSheetId: LOGICAL_SHEET,
    physicalSheetId,
    projection: "system_state",
    rowBindingId: { kind: PRESENCE_KINDS.ABSENT },
    conflictId: { kind: PRESENCE_KINDS.ABSENT },
    targetKind: "entity",
    targetId,
    targetEntityRevision: { kind: APPLICABILITY_KINDS.APPLICABLE, value: 1 },
    targetFieldRevisionHash: { kind: APPLICABILITY_KINDS.NOT_APPLICABLE },
    targetCanonicalCommitId: { kind: APPLICABILITY_KINDS.NOT_APPLICABLE },
    expectedVisibleRevision: 0,
    expectedVisibleHash: "",
    repairGuardHash: { kind: PRESENCE_KINDS.ABSENT },
    sourceQuarantineId: { kind: PRESENCE_KINDS.ABSENT },
    payloadJson: serializeSyncProjectionEffectPayload({
      sheetName,
      registeredRange: "A:B",
      schemaVersion: 1,
      targetAnchor: `${suffix}-anchor`,
      fields,
      targetVisibleHash: computeSyncVisibleHash(fields),
      createIfMissing: true,
      expectedCandidateHash: { kind: APPLICABILITY_KINDS.NOT_APPLICABLE },
    }),
    payloadHash: `payload-${suffix}`,
    effectDedupeKey: `dedupe-${suffix}`,
    streamSequence: 1,
  };
}

/** Lifts a durable outbox row into the pending shape used by dispatcher requests. */
function pendingFrom(effect: NewEffect): PendingEffect {
  return {
    effect_id: effect.effectId,
    effect_kind: effect.effectKind,
    commit_id: effect.commitId,
    logical_sheet_id: effect.logicalSheetId,
    physical_sheet_id: effect.physicalSheetId,
    projection: effect.projection,
    row_binding_id: effect.rowBindingId.kind === PRESENCE_KINDS.PRESENT ? effect.rowBindingId.value : null,
    conflict_id: effect.conflictId.kind === PRESENCE_KINDS.PRESENT ? effect.conflictId.value : null,
    target_kind: effect.targetKind,
    target_id: effect.targetId,
    target_entity_revision: effect.targetEntityRevision.kind === APPLICABILITY_KINDS.APPLICABLE ? effect.targetEntityRevision.value : null,
    target_field_revision_hash: effect.targetFieldRevisionHash.kind === APPLICABILITY_KINDS.APPLICABLE ? effect.targetFieldRevisionHash.value : null,
    target_canonical_commit_id: effect.targetCanonicalCommitId.kind === APPLICABILITY_KINDS.APPLICABLE ? effect.targetCanonicalCommitId.value : null,
    expected_visible_revision: effect.expectedVisibleRevision,
    expected_visible_hash: effect.expectedVisibleHash,
    repair_guard_hash: effect.repairGuardHash.kind === PRESENCE_KINDS.PRESENT ? effect.repairGuardHash.value : null,
    source_quarantine_id: effect.sourceQuarantineId.kind === PRESENCE_KINDS.PRESENT ? effect.sourceQuarantineId.value : null,
    payload_json: effect.payloadJson,
    payload_hash: effect.payloadHash,
    effect_dedupe_key: effect.effectDedupeKey,
    stream_sequence: effect.streamSequence,
    created_at: 0,
    next_attempt_at: null,
    uncertain_since: null,
    next_probe_at: null,
    dispatch_id: null,
    status: "pending",
  } as unknown as PendingEffect;
}

async function registerProjection(
  adapter: MikroOrmSqliteAdapter,
  physicalSheetId: string = PHYSICAL_SHEET,
  sheetName: string = "Orders",
): Promise<void> {
  await adapter.transaction(async ({ sql }) => {
    await sql.run(
      "INSERT OR IGNORE INTO sheet_registry (sheet_id, schema_version, ownership_manifest_json, business_key_field) VALUES (?, ?, ?, ?)",
      [LOGICAL_SHEET, 1, "{}", "id"],
    );
    await sql.run(
      "INSERT INTO physical_sheet_registry (physical_sheet_id, logical_sheet_id, spreadsheet_id, tab_name, registered_range, projection, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [physicalSheetId, LOGICAL_SHEET, "spreadsheet", sheetName, "A:B", "system_state", 1],
    );
  });
}

async function readStatus(adapter: MikroOrmSqliteAdapter, effectId: string): Promise<string | undefined> {
  const row = await adapter.read(({ sql }) => sql.get<{ status: string }>(
    "SELECT status FROM sheet_effect_outbox WHERE effect_id = ?",
    [effectId],
  ));
  return row?.status;
}

async function readLeaseUntil(adapter: MikroOrmSqliteAdapter, effectId: string): Promise<number | undefined> {
  const row = await adapter.read(({ sql }) => sql.get<{ lease_until: number | null }>(
    "SELECT lease_until FROM sheet_effect_outbox WHERE effect_id = ?",
    [effectId],
  ));
  return row?.lease_until ?? undefined;
}

async function readOutboxRow(
  adapter: MikroOrmSqliteAdapter,
  effectId: string,
): Promise<{ readonly status: string; readonly last_error_code: string | null; readonly last_error_message: string | null } | undefined> {
  const row = await adapter.read(({ sql }) => sql.get<{
    readonly status: string;
    readonly last_error_code: string | null;
    readonly last_error_message: string | null;
  }>(
    "SELECT status, last_error_code, last_error_message FROM sheet_effect_outbox WHERE effect_id = ?",
    [effectId],
  ));
  return row ?? undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Registered definition for the real provider's Orders route in the busy-lane test. */
function busyLaneDefinition(): RegisteredSyncProjectionDefinition {
  return {
    sheet: {
      logicalSheetId: LOGICAL_SHEET,
      physicalSheetId: PHYSICAL_SHEET,
      spreadsheetId: "spreadsheet-busy-lane",
      tabName: "Orders",
      registeredRange: "A:B",
      projection: "system_state",
      schemaVersion: 1,
      ownershipManifestJson: "{}",
      businessKeyField: "id",
      anchorMode: "business_key",
    },
    headers: ["id", "status"],
  };
}
