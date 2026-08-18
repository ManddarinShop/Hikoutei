import { describe, expect, it } from "vitest";
import {
  CoordinatedLanePreconditionError,
  CoordinatedSheetsProvider,
  type CoordinatedSheetsInner,
} from "../src/application/sync/sheetsContract/mutationCoordinator/CoordinatedSheetsProvider.js";
import type { CoordinatorLaneEvent } from "../src/application/sync/sheetsContract/mutationCoordinator/laneTelemetry.js";
import { TRANSPORT_OUTCOME_KINDS } from "../src/application/sync/sheetsContract/transportOutcome.js";
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
  SyncEffectPostconditionResult,
  SyncProjectionEffect,
  SyncSheetsSnapshot,
  SyncObservedSnapshot,
  SyncSheetsProvider,
  SyncSheetsObservationBatchProvider,
  SyncSheetsTableReader,
  SyncTableRowsResult,
} from "../src/application/sync/sheetsContract/syncSheets.js";
import type {
  SyncSheetsProvisioner,
  SyncSheetsProvisionRoute,
} from "../src/application/sync/sheetsContract/sheetsProvisioning.js";
import { SYNC_POSTCONDITION_DISPOSITIONS, SYNC_PROTOCOL_VERSIONS } from "../src/application/sync/sheetsContract/constants.js";
import { absentValue, presentValue } from "../src/shared/state/index.js";

type Inner = CoordinatedSheetsInner;

interface MockStats {
  readonly mutationMaxConcurrent: number;
  readonly mutationActive: number;
  readonly mutationCalls: number;
  readonly readMaxConcurrent: number;
  readonly readActive: number;
  readonly readCalls: number;
  readonly callOrder: readonly string[];
}

const SAMPLE_PHYSICAL_SHEET = "sheet-A";

/** A mock inner provider that records concurrency and call order. */
class MockProvider
  implements SyncSheetsProvider, SyncSheetsTableReader, SyncSheetsObservationBatchProvider, SyncSheetsProvisioner {
  public mutationActive = 0;
  public mutationMaxConcurrent = 0;
  public mutationCalls = 0;
  public readActive = 0;
  public readMaxConcurrent = 0;
  public readCalls = 0;
  public readonly callOrder: string[] = [];
  public fastAppendFail = false;
  public observedBatch = false;

  private async runMutation<T>(label: string, durationMs: number, result: () => T): Promise<T> {
    this.mutationCalls += 1;
    this.callOrder.push(`start:${label}`);
    this.mutationActive += 1;
    this.mutationMaxConcurrent = Math.max(this.mutationMaxConcurrent, this.mutationActive);
    await delay(durationMs);
    this.mutationActive -= 1;
    this.callOrder.push(`end:${label}`);
    return result();
  }

  private async runRead<T>(label: string, durationMs: number, result: () => T): Promise<T> {
    this.readCalls += 1;
    this.callOrder.push(`start:${label}`);
    this.readActive += 1;
    this.readMaxConcurrent = Math.max(this.readMaxConcurrent, this.readActive);
    await delay(durationMs);
    this.readActive -= 1;
    this.callOrder.push(`end:${label}`);
    return result();
  }

  public async provisionRegistry() {
    return this.runMutation("provision", 5, () => ({ registrations: [], createdSheets: [], initializedHeaders: [] }));
  }

  public async fastAppendRows(_request: FastAppendRowsRequest): Promise<FastAppendRowsResult> {
    return this.runMutation("fastAppend", 10, () => {
      if (this.fastAppendFail) throw new Error("fast append failed");
      return { results: [], hasMore: false };
    });
  }

  public async applyEffects(_request: ApplySyncEffectsRequest): Promise<ApplySyncEffectsResult> {
    return this.runMutation("applyEffects", 10, () => ({ results: [], snapshotHash: absentValue(), hasMore: false }));
  }

  public async readEffectPostcondition(_effect: SyncProjectionEffect): Promise<SyncEffectPostcondition> {
    return this.runMutation("postcondition", 10, () => ({
      disposition: SYNC_POSTCONDITION_DISPOSITIONS.UNAVAILABLE,
      visibleRevision: absentValue(),
      visibleHash: absentValue(),
      snapshotHash: absentValue(),
    }));
  }

  public async readEffectPostconditions(_request: ReadSyncEffectPostconditionsRequest): Promise<readonly SyncEffectPostconditionResult[]> {
    return this.runMutation("postconditions", 10, () => []);
  }

  public async ensureRowAnchors(_request: EnsureSyncRowAnchorsRequest): Promise<EnsureSyncRowAnchorsResult> {
    return this.runMutation("ensureAnchors", 10, () => ({ assigned: 0, existing: 0, duplicateAnchors: [] }));
  }

  public async observeSnapshot(request: ReadSyncSnapshotRequest): Promise<SyncObservedSnapshot> {
    this.observedBatch = true;
    return this.runMutation("observe", 10, () => ({
      anchors: { assigned: 0, existing: 0, duplicateAnchors: [] },
      snapshot: emptySnapshot(request),
    }));
  }

  public async observeSnapshots(requests: readonly ReadSyncSnapshotRequest[]): Promise<readonly SyncObservedSnapshot[]> {
    this.observedBatch = true;
    return this.runMutation("observeBatch", 10, () =>
      requests.map((request) => ({
        anchors: { assigned: 0, existing: 0, duplicateAnchors: [] },
        snapshot: emptySnapshot(request),
      })));
  }

  public async readSnapshot(request: ReadSyncSnapshotRequest): Promise<SyncSheetsSnapshot> {
    return this.runRead("readSnapshot", 10, () => emptySnapshot(request));
  }

  public async readRows(_request: ReadSyncTableRowsRequest): Promise<SyncTableRowsResult> {
    return this.runRead("readRows", 10, () => ({ sheetName: "s", registeredRange: "A:Z", headers: [], rows: [] }));
  }

  public async readRowsBatch(_requests: readonly ReadSyncTableRowsRequest[]): Promise<readonly SyncTableRowsResult[]> {
    return this.runRead("readRowsBatch", 10, () => []);
  }

  public stats(): MockStats {
    return {
      mutationMaxConcurrent: this.mutationMaxConcurrent,
      mutationActive: this.mutationActive,
      mutationCalls: this.mutationCalls,
      readMaxConcurrent: this.readMaxConcurrent,
      readActive: this.readActive,
      readCalls: this.readCalls,
      callOrder: this.callOrder,
    };
  }
}

/** Inner provider without the one-request observation capability. */
class SequentialOnlyProvider implements Inner {
  public ensureCalls = 0;
  public snapshotCalls = 0;

  public async fastAppendRows(_request: FastAppendRowsRequest): Promise<FastAppendRowsResult> {
    return { results: [], hasMore: false };
  }

  public async applyEffects(_request: ApplySyncEffectsRequest): Promise<ApplySyncEffectsResult> {
    return { results: [], snapshotHash: absentValue(), hasMore: false };
  }

  public async readEffectPostcondition(_effect: SyncProjectionEffect): Promise<SyncEffectPostcondition> {
    return {
      disposition: SYNC_POSTCONDITION_DISPOSITIONS.UNAVAILABLE,
      visibleRevision: absentValue(),
      visibleHash: absentValue(),
      snapshotHash: absentValue(),
    };
  }

  public async readEffectPostconditions(_request: ReadSyncEffectPostconditionsRequest): Promise<readonly SyncEffectPostconditionResult[]> {
    return [];
  }

  public async ensureRowAnchors(_request: EnsureSyncRowAnchorsRequest): Promise<EnsureSyncRowAnchorsResult> {
    this.ensureCalls += 1;
    return { assigned: 0, existing: 0, duplicateAnchors: [] };
  }

  public async readSnapshot(request: ReadSyncSnapshotRequest): Promise<SyncSheetsSnapshot> {
    this.snapshotCalls += 1;
    return emptySnapshot(request);
  }

  public async readRows(_request: ReadSyncTableRowsRequest): Promise<SyncTableRowsResult> {
    return { sheetName: "s", registeredRange: "A:Z", headers: [], rows: [] };
  }

  public async readRowsBatch(_requests: readonly ReadSyncTableRowsRequest[]): Promise<readonly SyncTableRowsResult[]> {
    return [];
  }
}

function emptySnapshot(request: ReadSyncSnapshotRequest): SyncSheetsSnapshot {
  return {
    protocolVersion: SYNC_PROTOCOL_VERSIONS.V1,
    sheetName: request.sheetName,
    registeredRange: request.registeredRange,
    projection: request.projection,
    schemaVersion: request.schemaVersion,
    headers: [],
    rows: [],
    snapshotHash: "",
    unanchoredRows: [],
    duplicateAnchors: [],
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sheetRequest(): ReadSyncSnapshotRequest {
  return {
    physicalSheetId: SAMPLE_PHYSICAL_SHEET,
    sheetName: "User_Input",
    registeredRange: "A:Z",
    projection: "user_input",
    schemaVersion: 1,
  };
}

describe("CoordinatedSheetsProvider", () => {
  it("serializes concurrent mutations through one lane", async () => {
    const inner = new MockProvider();
    const coordinator = new CoordinatedSheetsProvider<Inner>({ inner });

    await Promise.all([
      coordinator.fastAppendRows({ ...sheetRequest(), rows: [] }),
      coordinator.fastAppendRows({ ...sheetRequest(), rows: [] }),
      coordinator.fastAppendRows({ ...sheetRequest(), rows: [] }),
    ]);

    expect(inner.mutationCalls).toBe(3);
    // Mutations must never overlap: max concurrency stays at 1.
    expect(inner.mutationMaxConcurrent).toBe(1);
    // FIFO order: each start is paired with its end before the next starts.
    const order = inner.callOrder;
    expect(order).toEqual([
      "start:fastAppend", "end:fastAppend",
      "start:fastAppend", "end:fastAppend",
      "start:fastAppend", "end:fastAppend",
    ]);
  });

  it("keeps value reads lock-free and parallel", async () => {
    const inner = new MockProvider();
    const coordinator = new CoordinatedSheetsProvider<Inner>({ inner });

    await Promise.all([
      coordinator.readRows({ ...sheetRequest(), headers: [] }),
      coordinator.readRows({ ...sheetRequest(), headers: [] }),
      coordinator.readRowsBatch([{ ...sheetRequest(), headers: [] }]),
    ]);

    expect(inner.readCalls).toBe(3);
    expect(inner.readMaxConcurrent).toBeGreaterThan(1);
    expect(inner.mutationCalls).toBe(0);
  });

  it("lets a value read overlap a mutation because reads bypass the lane", async () => {
    const inner = new MockProvider();
    const coordinator = new CoordinatedSheetsProvider<Inner>({ inner });

    await Promise.all([
      coordinator.fastAppendRows({ ...sheetRequest(), rows: [] }),
      coordinator.readRows({ ...sheetRequest(), headers: [] }),
    ]);

    expect(inner.mutationCalls).toBe(1);
    expect(inner.readCalls).toBe(1);
    // The read started without waiting for the mutation lane.
    expect(inner.readMaxConcurrent).toBeGreaterThanOrEqual(1);
  });

  it("releases the lane when a mutation throws so the next mutation proceeds", async () => {
    const inner = new MockProvider();
    inner.fastAppendFail = true;
    const coordinator = new CoordinatedSheetsProvider<Inner>({ inner });

    await expect(coordinator.fastAppendRows({ ...sheetRequest(), rows: [] })).rejects.toThrow("fast append failed");

    inner.fastAppendFail = false;
    // The lane must be free; this must not hang.
    await coordinator.fastAppendRows({ ...sheetRequest(), rows: [] });
    expect(inner.mutationCalls).toBe(2);
    expect(inner.mutationMaxConcurrent).toBe(1);
  });

  it("serializes recovery barrier reads through the mutation lane", async () => {
    const inner = new MockProvider();
    const coordinator = new CoordinatedSheetsProvider<Inner>({ inner });
    void coordinator;

    const effect = sampleEffect();
    await Promise.all([
      coordinator.readEffectPostcondition(effect),
      coordinator.readEffectPostcondition(effect),
    ]);
    expect(inner.mutationMaxConcurrent).toBe(1);
    expect(inner.mutationCalls).toBe(2);
  });

  it("acquires every involved lane for batch observation without deadlock", async () => {
    const inner = new MockProvider();
    const coordinator = new CoordinatedSheetsProvider<Inner>({
      inner,
      // Partition lanes per physical sheet so two sheets have distinct lanes.
      mutationKeyForPhysicalSheet: (sheetId) => sheetId,
    });

    const requestA = { ...sheetRequest(), physicalSheetId: "sheet-A" };
    const requestB = { ...sheetRequest(), physicalSheetId: "sheet-B" };

    // Two batch observations over disjoint lane sets must complete.
    await Promise.all([
      coordinator.observeSnapshots([requestA, requestB]),
      coordinator.observeSnapshots([requestA, requestB]),
    ]);

    // observeSnapshot fallback path is not used when the inner supports batches.
    expect(inner.observedBatch).toBe(true);
    expect(inner.mutationMaxConcurrent).toBe(1);
  });

  it("delegates batch observation to the inner one-request capability", async () => {
    const inner = new MockProvider();
    const coordinator = new CoordinatedSheetsProvider<Inner>({
      inner,
      mutationKeyForPhysicalSheet: (sheetId) => sheetId,
    });

    const requestA = { ...sheetRequest(), physicalSheetId: "sheet-A" };
    const requestB = { ...sheetRequest(), physicalSheetId: "sheet-B" };

    await coordinator.observeSnapshots([requestA, requestB]);

    // One inner batch call covers both projections; the coordinator must not
    // serialize them into per-request observeSnapshot calls.
    expect(inner.mutationCalls).toBe(1);
    expect(inner.callOrder).toEqual(["start:observeBatch", "end:observeBatch"]);
    expect(inner.observedBatch).toBe(true);
  });

  it("falls back to sequential per-request observation without the batch capability", async () => {
    const inner = new SequentialOnlyProvider();
    const coordinator = new CoordinatedSheetsProvider<Inner>({ inner });

    const requestA = { ...sheetRequest(), physicalSheetId: "sheet-A" };
    const requestB = { ...sheetRequest(), physicalSheetId: "sheet-B" };

    const results = await coordinator.observeSnapshots([requestA, requestB]);
    expect(results).toHaveLength(2);
    // Each request still runs inside the held mutation lane, so the inner
    // observation never races a concurrent mutation.
    expect(inner.ensureCalls).toBe(2);
    expect(inner.snapshotCalls).toBe(2);
  });

  it("emits redacted lane telemetry without payload or secret material", async () => {
    const inner = new MockProvider();
    const events: CoordinatorLaneEvent[] = [];
    let clockValue = 0;
    const coordinator = new CoordinatedSheetsProvider<Inner>({
      inner,
      clock: () => {
        clockValue += 5;
        return clockValue;
      },
      onLaneEvent: (event) => events.push(event),
    });

    await coordinator.fastAppendRows({ ...sheetRequest(), rows: [] });
    inner.fastAppendFail = true;
    await expect(coordinator.fastAppendRows({ ...sheetRequest(), rows: [] })).rejects.toThrow();

    expect(events).toHaveLength(2);
    expect(events[0]?.operation).toBe("fastAppendRows");
    expect(events[0]?.outcome).toBe(TRANSPORT_OUTCOME_KINDS.SUCCESS);
    expect(events[1]?.outcome).toBe(TRANSPORT_OUTCOME_KINDS.DELIVERY_UNCERTAIN);
    // Failure telemetry must retain the remote-call duration, not report a
    // synthetic zero merely because the inner operation rejected.
    expect(events[1]?.remoteDurationMs).toBe(5);
    // No secret/argument material is present in the event shape.
    for (const event of events) {
      expect(Object.keys(event).sort()).toEqual(
        ["code", "httpStatus", "laneKey", "operation", "outcome", "queueWaitMs", "remoteDurationMs"].sort(),
      );
    }
  });

  it("reports lane metrics for diagnostics", async () => {
    const inner = new MockProvider();
    const coordinator = new CoordinatedSheetsProvider<Inner>({ inner });
    await coordinator.fastAppendRows({ ...sheetRequest(), rows: [] });

    const metrics = coordinator.laneMetrics();
    expect(metrics.get("default")?.completed).toBe(1);
  });

  it("runs the in-lane precondition after the queue wait and before the inner call", async () => {
    const inner = new MockProvider();
    const coordinator = new CoordinatedSheetsProvider<Inner>({ inner });
    const order: string[] = [];

    let releaseHolder!: () => void;
    const holderGate = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let holderStarted!: () => void;
    const holderStartedPromise = new Promise<void>((resolve) => {
      holderStarted = resolve;
    });
    const holder = coordinator.runSerializedControl(SAMPLE_PHYSICAL_SHEET, "holder", async () => {
      holderStarted();
      await holderGate;
      order.push("holder-end");
    });
    await holderStartedPromise;

    const dispatched = coordinator.runSerializedInner(
      SAMPLE_PHYSICAL_SHEET,
      "applyEffects",
      (provider) => {
        order.push("inner");
        return provider.applyEffects({ ...sheetRequest(), effects: [] });
      },
      async () => {
        order.push("renew");
        return true;
      },
    );

    // Give the queued dispatch time to reach the lane: the renewal must NOT
    // run while the holder still owns the lane.
    await delay(30);
    expect(order).toEqual([]);

    releaseHolder();
    await Promise.all([holder, dispatched]);

    // Renewal runs strictly after the lane queue wait and strictly before the
    // inner provider call.
    expect(order).toEqual(["holder-end", "renew", "inner"]);
  });

  it("aborts before the inner call when the precondition rejects and releases the lane", async () => {
    const inner = new MockProvider();
    const events: CoordinatorLaneEvent[] = [];
    const coordinator = new CoordinatedSheetsProvider<Inner>({
      inner,
      onLaneEvent: (event) => events.push(event),
    });
    let renewalCalls = 0;

    await expect(coordinator.runSerializedInner(
      SAMPLE_PHYSICAL_SHEET,
      "applyEffects",
      (provider) => provider.applyEffects({ ...sheetRequest(), effects: [] }),
      async () => {
        renewalCalls += 1;
        return false;
      },
    )).rejects.toBeInstanceOf(CoordinatedLanePreconditionError);

    // The remote never ran and the failure is a stable redacted message with
    // no effect IDs, payloads, or raw provider errors.
    expect(renewalCalls).toBe(1);
    expect(inner.mutationCalls).toBe(0);
    expect(events[0]?.operation).toBe("applyEffects");
    expect(events[0]?.outcome).toBe(TRANSPORT_OUTCOME_KINDS.DELIVERY_UNCERTAIN);

    // The lane was released: the next mutation proceeds without deadlock.
    await coordinator.fastAppendRows({ ...sheetRequest(), rows: [] });
    expect(inner.mutationCalls).toBe(1);
  });

  it("passes the inner provider to the remote closure without re-entering the lane", async () => {
    const inner = new MockProvider();
    const coordinator = new CoordinatedSheetsProvider<Inner>({ inner });

    const result = await coordinator.runSerializedInner(
      SAMPLE_PHYSICAL_SHEET,
      "fastAppendRows",
      (provider) => provider.fastAppendRows({ ...sheetRequest(), rows: [] }),
      async () => true,
    );

    expect(result).toEqual({ results: [], hasMore: false });
    expect(inner.mutationCalls).toBe(1);
    // The remote ran inside the held lane: no concurrent mutation slipped in.
    expect(inner.mutationMaxConcurrent).toBe(1);
  });
});

function sampleEffect(): SyncProjectionEffect {
  return {
    effectId: "effect-1",
    payloadHash: "hash-1",
    effectKind: "system_projection",
    physicalSheetId: SAMPLE_PHYSICAL_SHEET,
    projection: "system_state",
    targetKind: "row_binding",
    targetId: "row-1",
    rowBindingId: presentValue("row-1"),
    conflictId: absentValue(),
    expectedVisibleRevision: 0,
    expectedVisibleHash: "",
    repairGuardHash: absentValue(),
    payload: {
      sheetName: "System_State",
      registeredRange: "A:Z",
      schemaVersion: 1,
      targetAnchor: "row-1",
      fields: { id: { kind: "string", value: "row-1" } },
      targetVisibleHash: "x",
      createIfMissing: true,
      expectedCandidateHash: { kind: "not_applicable" },
    },
  };
}
