import { describe, expect, it } from "vitest";

import {
  AppsScriptOperationSyncGateway,
} from "../src/adapter/sheets/providers/apps-script-gateway/transport/operationSyncGateway.js";
import type {
  AnyAppsScriptOperationDefinition,
  AppsScriptOperationGateway,
  AppsScriptOperationResults,
} from "../src/adapter/sheets/providers/apps-script-gateway/transport/operationClient.js";
import type {
  ApplySyncEffectsRequest,
  SyncGatewayEffect,
} from "../src/application/sync/gateway/syncGateway.js";
import { computeSyncVisibleHash } from "../src/application/sync/gateway/syncGateway.js";
import type {
  RegisteredSyncProjectionDefinition,
  SyncGatewayProvisionRoute,
} from "../src/application/sync/gateway/SyncGatewayBootstrap.js";

describe("AppsScriptOperationSyncGateway", () => {
  it("moves provisioning and fast append behind the library adapter", async () => {
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
    ]);
    const adapter = new AppsScriptOperationSyncGateway({
      operationGateway,
      definitions: [createDefinition()],
    });

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

    expect(provisioned.createdSheets).toEqual(["Orders"]);
    expect(appended.results[0]?.status).toBe("applied");
    expect(operationGateway.calls).toHaveLength(2);
    expect(operationGateway.calls[0]?.args).toMatchObject({
      registrations: [{
        sheetName: "Orders",
        registeredRange: "A:B",
        projection: "system_state",
        schemaVersion: 1,
        headers: ["id", "status"],
      }],
    });
    expect(operationGateway.calls[1]?.args).toMatchObject({
      sheetName: "Orders",
      headers: ["id", "status"],
      rows: [{
        effectId: "effect-1",
        fields: {
          id: { kind: "string", value: "order-1" },
          status: { kind: "string", value: "paid" },
        },
      }],
    });
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
          reason: null,
          postcondition: "acknowledged",
        }],
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
      },
      {
        results: [{
          effectId: effect.effectId,
          payloadHash: effect.payloadHash,
          postcondition: {
            disposition: "applied",
            visibleRevision: 2,
            visibleHash: effect.payload.targetVisibleHash,
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
    expect(operationGateway.calls[0]?.args).toMatchObject({
      mode: "applyEffects",
      effects: [effect],
    });
    expect(operationGateway.calls[1]?.args).toMatchObject({
      mode: "readEffectPostcondition",
      effect,
    });
    expect(operationGateway.calls[2]?.args).toMatchObject({
      mode: "readEffectPostconditions",
      effects: [effect],
    });
  });

  it("routes normalized ID-based snapshots through typed operations", async () => {
    const operationGateway = new StubOperationGateway([
      {
        protocolVersion: "typed-sheets-sync-v1",
        sheetName: "Orders",
        registeredRange: "A:B",
        projection: "system_state",
        schemaVersion: 1,
        headers: ["id", "status"],
        rows: [{
          rowNumber: 2,
          cells: {
            id: {
              cellKind: "literal",
              normalizedCell: { kind: "string", value: "order-1" },
            },
            status: {
              cellKind: "blank",
              normalizedCell: null,
            },
          },
        }],
      },
    ]);
    const adapter = new AppsScriptOperationSyncGateway({
      operationGateway,
      definitions: [createDefinition()],
    });

    const snapshot = await adapter.readSnapshot({
      physicalSheetId: "orders-state",
      sheetName: "Orders",
      registeredRange: "A:B",
      projection: "system_state",
      schemaVersion: 1,
    });

    expect(snapshot.rows[0]?.cells.id?.normalizedCell).toEqual({
      kind: "string",
      value: "order-1",
    });
    expect(operationGateway.calls).toHaveLength(1);
    expect(operationGateway.calls[0]?.args).toMatchObject({
      mode: "readSnapshot",
      physicalSheetId: "orders-state",
      sheetName: "Orders",
    });
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
    expect(operationGateway.batches[0]?.[0]?.args).toMatchObject({
      mode: "observeSnapshot",
      physicalSheetId: "orders-state",
    });
    expect(operationGateway.batches[0]?.[1]?.args).toMatchObject({
      mode: "observeSnapshot",
      physicalSheetId: "orders-input",
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
      anchorMode: "business_key",
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
      anchorMode: "business_key",
    },
    headers: ["id", "status"],
  };
}

function createObservedSnapshot(
  sheetName: string,
  projection: "system_state" | "user_input",
): unknown {
  return {
    snapshot: {
      protocolVersion: "typed-sheets-sync-v1",
      sheetName,
      registeredRange: "A:B",
      projection,
      schemaVersion: 1,
      headers: ["id", "status"],
      rows: [],
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
    expectedVisibleRevision: 1,
    expectedVisibleHash: computeSyncVisibleHash({
      status: { kind: "string", value: "pending" },
    }),
    repairGuardHash: { kind: "absent" },
    payload: {
      sheetName: "Orders",
      registeredRange: "A:B",
      schemaVersion: 1,
      fields,
      targetVisibleHash: computeSyncVisibleHash(fields),
      createIfMissing: false,
      expectedCandidateHash: { kind: "not_applicable" },
    },
  };
}
