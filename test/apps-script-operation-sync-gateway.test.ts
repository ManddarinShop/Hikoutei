import { describe, expect, it } from "vitest";

import {
  AppsScriptOperationSyncGateway,
  type AppsScriptOperationProjectionStatus,
} from "../src/adapter/apps-script-gateway/operationSyncGateway.js";
import type {
  AnyAppsScriptOperationDefinition,
  AppsScriptOperationGateway,
  AppsScriptOperationResults,
} from "../src/adapter/apps-script-gateway/operationClient.js";
import type {
  ApplySyncEffectsRequest,
  SyncGatewayEffect,
} from "../src/runtime/gateway/syncGateway.js";
import { computeSyncVisibleHash } from "../src/runtime/gateway/syncGateway.js";
import type {
  RegisteredSyncProjectionDefinition,
  SyncGatewayProvisionRoute,
} from "../src/runtime/gateway/SyncGatewayBootstrap.js";
import type { SyncEffectWorkerGateway } from "../src/runtime/gateway/syncGateway.js";

describe("AppsScriptOperationSyncGateway", () => {
  it("moves provisioning, fast append, and projection reads behind the library adapter", async () => {
    const operationGateway = new StubOperationGateway([
      {
        registrations: [{
          sheetName: "Orders",
          registeredRange: "A:B",
          projection: "system_state",
          schemaVersion: 1,
          identityField: "id",
        }],
        createdSheets: ["Orders"],
        initializedHeaders: ["Orders"],
      },
      {
        results: [{ effectId: "effect-1", status: "applied" }],
        hasMore: false,
      },
      {
        sheetName: "Orders",
        headers: ["id", "status"],
        rowCount: 1,
        ids: ["order-1"],
      } satisfies AppsScriptOperationProjectionStatus,
    ]);
    const adapter = new AppsScriptOperationSyncGateway({
      operationGateway,
      definitions: [createDefinition()],
    });
    const fastGateway: SyncEffectWorkerGateway = adapter;

    const provisioned = await adapter.provisionRegistry([createRoute()]);
    const appended = await adapter.fastAppendRows({
      physicalSheetId: "orders-state",
      sheetName: "Orders",
      registeredRange: "A:B",
      projection: "system_state",
      schemaVersion: 1,
      rows: [{
        effectId: "effect-1",
        fields: {
          id: { kind: "string", value: "order-1" },
          status: { kind: "string", value: "paid" },
        },
      }],
    });
    const projection = await adapter.readProjection("Orders");

    expect(provisioned.createdSheets).toEqual(["Orders"]);
    expect(fastGateway.fastAppendRows).toBeTypeOf("function");
    expect(appended.results[0]?.status).toBe("applied");
    expect(projection.rowCount).toBe(1);
    expect(operationGateway.calls).toHaveLength(3);
    expect(operationGateway.calls[0]?.fn).toContain("operational provisioning");
    expect(operationGateway.calls[1]?.fn).toContain("setValues");
    expect(operationGateway.calls[1]?.fn).not.toContain("getDeveloperMetadata");
    expect(operationGateway.calls[2]?.fn).toContain("getLastRow");
  });

  it("rejects a route mismatch before sending a fast append", async () => {
    const operationGateway = new StubOperationGateway([]);
    const adapter = new AppsScriptOperationSyncGateway({
      operationGateway,
      definitions: [createDefinition()],
    });

    await expect(adapter.fastAppendRows({
      physicalSheetId: "orders-state",
      sheetName: "WrongTab",
      registeredRange: "A:B",
      projection: "system_state",
      schemaVersion: 1,
      rows: [],
    })).rejects.toMatchObject({
      name: "SyncGatewayContractError",
      code: "invalid_sync_effect_payload",
    });
    expect(operationGateway.calls).toHaveLength(0);
  });

  it("reads table values without metadata, locks, or snapshot hashing", async () => {
    const operationGateway = new StubOperationGateway([{
      sheetName: "Orders",
      registeredRange: "A:B",
      headers: ["id", "status"],
      rows: [{
        rowNumber: 2,
        fields: {
          id: { kind: "string", value: "order-1" },
          status: { kind: "string", value: "paid" },
        },
      }],
    }]);
    const adapter = new AppsScriptOperationSyncGateway({
      operationGateway,
      definitions: [createDefinition()],
    });

    const [result] = await adapter.readRowsBatch([{
      physicalSheetId: "orders-state",
      sheetName: "Orders",
      registeredRange: "A:B",
      projection: "system_state",
      schemaVersion: 1,
      headers: ["id", "status"],
    }]);

    expect(result?.rows[0]?.fields.id).toEqual({ kind: "string", value: "order-1" });
    expect(operationGateway.calls).toHaveLength(1);
    expect(operationGateway.calls[0]?.fn).toContain("getValues");
    expect(operationGateway.calls[0]?.fn).not.toContain("LockService");
    expect(operationGateway.calls[0]?.fn).not.toContain("DeveloperMetadata");
    expect(operationGateway.calls[0]?.fn).not.toContain("computeDigest");
  });

  it("routes regular effects and recovery reads through typed operations", async () => {
    const effect = createEffect();
    const operationGateway = new StubOperationGateway([
      {
        results: [{
          effectId: effect.effectId,
          payloadHash: effect.payloadHash,
          status: "applied",
          visibleRevision: 2,
          visibleHash: effect.payload.targetVisibleHash,
          snapshotHash: null,
          reason: null,
          postcondition: "acknowledged",
        }],
        snapshotHash: null,
        hasMore: false,
        timing: {
          operationKinds: ["update"],
          operationCounts: { append: 0, update: 1, delete: 0 },
          durationMs: 7,
          phases: [{ phase: "effect_plan", durationMs: 3 }],
        },
      },
      {
        disposition: "applied",
        visibleRevision: 2,
        visibleHash: effect.payload.targetVisibleHash,
        snapshotHash: null,
      },
      {
        results: [{
          effectId: effect.effectId,
          payloadHash: effect.payloadHash,
          postcondition: {
            disposition: "applied",
            visibleRevision: 2,
            visibleHash: effect.payload.targetVisibleHash,
            snapshotHash: null,
          },
        }],
      },
    ]);
    const adapter = new AppsScriptOperationSyncGateway({
      operationGateway,
      definitions: [createDefinition()],
    });

    const applyRequest: ApplySyncEffectsRequest = {
      physicalSheetId: "orders-state",
      sheetName: "Orders",
      registeredRange: "A:B",
      projection: "system_state",
      schemaVersion: 1,
      postconditionMode: "deferred",
      effects: [effect],
    };
    const applied = await adapter.applyEffects(applyRequest);
    const one = await adapter.readEffectPostcondition(effect);
    const many = await adapter.readEffectPostconditions({
      ...applyRequest,
      effects: [effect],
    });

    expect(applied.results[0]?.status).toBe("applied");
    expect(applied.timing?.phases[0]?.phase).toBe("effect_plan");
    expect(one.disposition).toBe("applied");
    expect(many[0]?.postcondition.disposition).toBe("applied");
    expect(operationGateway.calls).toHaveLength(3);
    expect(operationGateway.calls[0]?.fn).toContain("deleteRow");
    expect(operationGateway.calls[0]?.fn).toContain("getDeveloperMetadata");
    expect(operationGateway.calls[0]?.fn).toContain("postcondition_hash_mismatch");
  });

  it("routes anchor assignment and normalized snapshots through typed operations", async () => {
    const operationGateway = new StubOperationGateway([
      {
        assigned: 1,
        existing: 2,
        duplicateAnchors: [{ anchor: "anchor-duplicate", rowNumbers: [2, 4] }],
      },
      {
        protocolVersion: "typed-sheets-sync-v1",
        sheetName: "Orders",
        registeredRange: "A:B",
        projection: "system_state",
        schemaVersion: 1,
        headers: ["id", "status"],
        rows: [{
          rowNumber: 2,
          physicalAnchor: "anchor-1",
          visibleRevision: null,
          visibleHash: null,
          cells: {
            id: {
              cellKind: "literal",
              normalizedCell: { kind: "string", value: "order-1" },
              formulaHash: null,
              mergeRange: null,
              errorCode: null,
              stableHash: "cell-hash",
            },
            status: {
              cellKind: "blank",
              normalizedCell: null,
              formulaHash: null,
              mergeRange: null,
              errorCode: null,
              stableHash: "blank-hash",
            },
          },
        }],
        snapshotHash: "snapshot-hash",
        unanchoredRows: [],
        duplicateAnchors: [],
      },
    ]);
    const adapter = new AppsScriptOperationSyncGateway({
      operationGateway,
      definitions: [createDefinition()],
    });

    const anchors = await adapter.ensureRowAnchors({
      physicalSheetId: "orders-state",
      sheetName: "Orders",
      registeredRange: "A:B",
      projection: "system_state",
      schemaVersion: 1,
    });
    const snapshot = await adapter.readSnapshot({
      physicalSheetId: "orders-state",
      sheetName: "Orders",
      registeredRange: "A:B",
      projection: "system_state",
      schemaVersion: 1,
    });

    expect(anchors.assigned).toBe(1);
    expect(anchors.duplicateAnchors[0]?.rowNumbers).toEqual([2, 4]);
    expect(snapshot.rows[0]?.cells.id.normalizedCell).toEqual({
      kind: "string",
      value: "order-1",
    });
    expect(snapshot.rows[0]?.physicalAnchor.kind).toBe("present");
    expect(operationGateway.calls).toHaveLength(2);
    expect(operationGateway.calls[0]?.fn).toContain("addDeveloperMetadata");
    expect(operationGateway.calls[0]?.fn).toContain("createDeveloperMetadataFinder");
    expect(operationGateway.calls[0]?.fn).toContain("getLocation().getRow");
    expect(operationGateway.calls[1]?.fn).toContain("getMergedRanges");
    expect(operationGateway.calls[1]?.fn).toContain("getFormulas");
    expect(operationGateway.calls[1]?.fn).toContain("createDeveloperMetadataFinder");
    expect(operationGateway.calls[1]?.fn).not.toContain("getDeveloperMetadata");
  });

  it("combines several projection observations into one Apps Script request", async () => {
    const operationGateway = new StubOperationGateway([
      createObservedSnapshot("Orders", "system_state"),
      createObservedSnapshot("Orders_Input", "user_input"),
    ], { allowBatches: true });
    const adapter = new AppsScriptOperationSyncGateway({
      operationGateway,
      definitions: [createDefinition(), createUserInputDefinition()],
    });

    const results = await adapter.observeSnapshots([
      {
        physicalSheetId: "orders-state",
        sheetName: "Orders",
        registeredRange: "A:B",
        projection: "system_state",
        schemaVersion: 1,
        readMode: "full",
      },
      {
        physicalSheetId: "orders-input",
        sheetName: "Orders_Input",
        registeredRange: "A:B",
        projection: "user_input",
        schemaVersion: 1,
        readMode: "user_input",
      },
    ]);

    expect(results).toHaveLength(2);
    expect(operationGateway.batches).toHaveLength(1);
    expect(operationGateway.batches[0]).toHaveLength(2);
    expect(operationGateway.batches[0]?.[0]?.fn).toContain("observeSnapshot");
    expect(operationGateway.batches[0]?.[1]?.args).toMatchObject({
      mode: "observeSnapshot",
      readMode: "user_input",
    });
  });

});

class StubOperationGateway implements AppsScriptOperationGateway {
  public readonly calls: AnyAppsScriptOperationDefinition[] = [];
  public readonly batches: AnyAppsScriptOperationDefinition[][] = [];
  private readonly responses: unknown[];
  private readonly allowBatches: boolean;

  public constructor(
    responses: readonly unknown[],
    options: { readonly allowBatches?: boolean } = {},
  ) {
    this.responses = [...responses];
    this.allowBatches = options.allowBatches ?? false;
  }

  public async applyOperations<
    Operations extends readonly AnyAppsScriptOperationDefinition[],
  >(
    operations: Operations,
  ): Promise<AppsScriptOperationResults<Operations>> {
    if (operations.length !== 1 && !this.allowBatches) {
      throw new Error("stub expects one operation");
    }
    const batch = [...operations] as AnyAppsScriptOperationDefinition[];
    this.batches.push(batch);
    const results = batch.map((operation) => {
      this.calls.push(operation);
      const response = this.responses.shift();
      return operation.decode === undefined
        ? response
        : operation.decode(response);
    });
    return results as unknown as AppsScriptOperationResults<Operations>;
  }
}

function createDefinition(): RegisteredSyncProjectionDefinition {
  return {
    sheet: {
      logicalSheetId: "orders",
      physicalSheetId: "orders-state",
      spreadsheetId: "spreadsheet-1",
      tabName: "Orders",
      registeredRange: "A:B",
      projection: "system_state",
      schemaVersion: 1,
      ownershipManifestJson: "{}",
      businessKeyField: "id",
      anchorMode: "developer_metadata",
    },
    headers: ["id", "status"],
  };
}

function createRoute(): SyncGatewayProvisionRoute {
  return {
    sheetName: "Orders",
    registeredRange: "A:B",
    projection: "system_state",
    schemaVersion: 1,
    headers: ["id", "status"],
    identityField: "id",
  };
}

function createUserInputDefinition(): RegisteredSyncProjectionDefinition {
  return {
    sheet: {
      logicalSheetId: "orders",
      physicalSheetId: "orders-input",
      spreadsheetId: "spreadsheet-1",
      tabName: "Orders_Input",
      registeredRange: "A:B",
      projection: "user_input",
      schemaVersion: 1,
      ownershipManifestJson: "{}",
      businessKeyField: "id",
      anchorMode: "developer_metadata",
    },
    headers: ["id", "status"],
  };
}

function createObservedSnapshot(
  sheetName: string,
  projection: "system_state" | "user_input",
): unknown {
  return {
    anchors: { assigned: 0, existing: 1, duplicateAnchors: [] },
    snapshot: {
      protocolVersion: "typed-sheets-sync-v1",
      sheetName,
      registeredRange: "A:B",
      projection,
      schemaVersion: 1,
      headers: ["id", "status"],
      rows: [],
      snapshotHash: "snapshot-hash-" + projection,
      unanchoredRows: [],
      duplicateAnchors: [],
    },
  };
}

function createEffect(): SyncGatewayEffect {
  const fields = {
    status: { kind: "string" as const, value: "paid" },
  };
  return {
    effectId: "effect-1",
    payloadHash: "payload-hash-1",
    effectKind: "system_projection",
    physicalSheetId: "orders-state",
    projection: "system_state",
    targetKind: "entity",
    targetId: "order-1",
    rowBindingId: { kind: "present", value: "row-1" },
    conflictId: { kind: "absent" },
    expectedVisibleRevision: 1,
    expectedVisibleHash: computeSyncVisibleHash({
      status: { kind: "string", value: "pending" },
    }),
    repairGuardHash: { kind: "absent" },
    payload: {
      sheetName: "Orders",
      registeredRange: "A:B",
      schemaVersion: 1,
      targetAnchor: "sync-anchor:order-1",
      fields,
      targetVisibleHash: computeSyncVisibleHash(fields),
      createIfMissing: false,
      expectedCandidateHash: { kind: "not_applicable" },
    },
  };
}
