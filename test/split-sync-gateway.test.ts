import { describe, expect, it, vi } from "vitest";
import {
  SplitSyncGateway,
  type ApplySyncEffectsRequest,
  type FastAppendRowsRequest,
  type ReadSyncEffectPostconditionsRequest,
  type ReadSyncSnapshotRequest,
  type SyncEffectPostcondition,
  type SyncGatewaySnapshot,
  type SyncSheetGateway,
} from "../src/application/sync/gateway/syncGateway.js";
import { SYNC_GATEWAY_PROJECTIONS } from "../src/application/sync/gateway/constants.js";

function requestBase() {
  return {
    physicalSheetId: "sheet-1",
    sheetName: "System_State",
    registeredRange: "A:B",
    projection: SYNC_GATEWAY_PROJECTIONS.SYSTEM_STATE,
    schemaVersion: 1,
  } as const;
}

function snapshot(): SyncGatewaySnapshot {
  return {
    protocolVersion: "typed-sheets-sync-v1",
    ...requestBase(),
    headers: ["id", "name"],
    rows: [],
  };
}

function fullGateway(): SyncSheetGateway {
  return {
    ensureRowAnchors: vi.fn(async () => ({ assigned: 0, existing: 0, duplicateAnchors: [] })),
    readSnapshot: vi.fn(async () => snapshot()),
    applyEffects: vi.fn(async () => ({ results: [], hasMore: false })),
    readEffectPostcondition: vi.fn(async (): Promise<SyncEffectPostcondition> => ({
      disposition: "unavailable",
      visibleRevision: { kind: "absent" },
      visibleHash: { kind: "absent" },
    })),
    readEffectPostconditions: vi.fn(async () => []),
    fastAppendRows: vi.fn(async () => ({ results: [], hasMore: false })),
  };
}

describe("SplitSyncGateway", () => {
  it("routes fast appends to the fast gateway and full operations to the full gateway", async () => {
    const fastGateway = {
      fastAppendRows: vi.fn(async () => ({ results: [], hasMore: false })),
    };
    const full = fullGateway();
    const gateway = new SplitSyncGateway({ fastGateway, fullGateway: full });
    const base = requestBase();
    const appendRequest: FastAppendRowsRequest = { ...base, rows: [] };
    const applyRequest: ApplySyncEffectsRequest = { ...base, effects: [] };
    const snapshotRequest: ReadSyncSnapshotRequest = base;
    const postconditionRequest: ReadSyncEffectPostconditionsRequest = { ...base, effects: [] };

    await gateway.fastAppendRows(appendRequest);
    await gateway.applyEffects(applyRequest);
    await gateway.readSnapshot(snapshotRequest);
    await gateway.ensureRowAnchors(snapshotRequest);
    await gateway.readEffectPostconditions(postconditionRequest);

    expect(fastGateway.fastAppendRows).toHaveBeenCalledWith(appendRequest);
    expect(full.applyEffects).toHaveBeenCalledWith(applyRequest);
    expect(full.readSnapshot).toHaveBeenCalledWith(snapshotRequest);
    expect(full.ensureRowAnchors).toHaveBeenCalledWith(snapshotRequest);
    expect(full.readEffectPostconditions).toHaveBeenCalledWith(postconditionRequest);
  });

  it("does not expose the full delegate's append method as the fast path", async () => {
    const fastGateway = {
      fastAppendRows: vi.fn(async () => ({ results: [], hasMore: false })),
    };
    const full = fullGateway();
    const gateway = new SplitSyncGateway({ fastGateway, fullGateway: full });

    await gateway.fastAppendRows({ ...requestBase(), rows: [] });

    expect(fastGateway.fastAppendRows).toHaveBeenCalledOnce();
    expect(full.fastAppendRows).not.toHaveBeenCalled();
  });
});
