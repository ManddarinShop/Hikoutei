import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  AppsScriptOperationSyncGateway,
  type AppsScriptOperationProjectionStatus,
} from "../src/adapter/sheets/providers/apps-script-gateway/transport/operationSyncGateway.js";
import {
  createApplyEffectsOperation,
  createReadEffectPostconditionOperation,
  createReadEffectPostconditionsOperation,
} from "../src/adapter/sheets/providers/apps-script-gateway/operations/effect/effectOperation.js";
import {
  createObserveSnapshotOperation,
  createReadSnapshotOperation,
} from "../src/adapter/sheets/providers/apps-script-gateway/operations/observation/observationOperation.js";
import type {
  AnyAppsScriptOperationDefinition,
  AppsScriptOperationGateway,
  AppsScriptOperationResults,
} from "../src/adapter/sheets/providers/apps-script-gateway/transport/operationClient.js";
import type {
  ApplySyncEffectsRequest,
  SyncGatewayEffect,
} from "../src/application/sync/gateway/syncGateway.js";
import {
  computeSyncVisibleHash,
  type SyncGatewaySnapshot,
} from "../src/application/sync/gateway/syncGateway.js";
import type {
  RegisteredSyncProjectionDefinition,
  SyncGatewayProvisionRoute,
} from "../src/application/sync/gateway/SyncGatewayBootstrap.js";
import type { SyncEffectWorkerGateway } from "../src/application/sync/gateway/syncGateway.js";

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
        results: [{ effectId: "effect-1", status: "applied", visibleHash: "hash-1", visibleRevision: 1 }],
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
        payloadHash: "payload-1",
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
    expect(operationGateway.calls[1]?.fn).toContain("SpreadsheetApp.flush");
    expect(operationGateway.calls[1]?.fn).not.toContain("Sheets.Spreadsheets");
    expect(operationGateway.calls[1]?.fn).toContain("__typed_sheets_internal_effect_receipts");
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
    expect(operationGateway.calls[0]?.fn).toContain("deleteRows");
    expect(operationGateway.calls[0]?.fn).not.toContain("Sheets.Spreadsheets");
    expect(operationGateway.calls[0]?.fn).not.toContain("deleteDimension");
    expect(operationGateway.calls[0]?.fn).toContain("getDeveloperMetadata");
    expect(operationGateway.calls[0]?.fn).toContain("postcondition_hash_mismatch");
    expect(operationGateway.calls[0]?.fn).toContain("LockService");
    expect(operationGateway.calls[1]?.fn).toContain("LockService");
    expect(operationGateway.calls[2]?.fn).toContain("LockService");
  });

  it("keeps the effect operation source on built-in Apps Script services only", () => {
    const operation = createApplyEffectsOperation({
      physicalSheetId: "orders-state",
      sheetName: "Orders",
      registeredRange: "A:B",
      projection: "system_state",
      schemaVersion: 1,
      effects: [createEffect()],
    });

    // Delete/receipt/materialization must never regress to the Advanced
    // Sheets service; the default append path already avoids it.
    for (const banned of [
      "Sheets.Spreadsheets",
      "insertDimension",
      "updateCells",
      "deleteDimension",
      "batchUpdate",
    ]) {
      expect(operation.fn).not.toContain(banned);
    }
    expect(operation.fn).toContain("LockService.getScriptLock");
    expect(operation.fn).toContain("SpreadsheetApp.flush");
    expect(operation.fn).toContain("deleteRows");
    expect(operation.fn).toContain("insertRowsAfter");
    expect(operation.fn).toContain("setValues");
    expect(operation.fn).toContain('phase_("delete_and_receipt_batch"');
    expect(operation.fn).toContain("script_lock");
  });

  it("executes built-in row deletion and deletion receipts under SpreadsheetApp fakes", () => {
    const effect = createDeletionEffect(
      "effect-delete-1",
      "order-1",
      { id: "order-1", status: "paid" },
      "sync-anchor:order-1",
    );
    const operation = createApplyEffectsOperation({
      physicalSheetId: "orders-state",
      sheetName: "Orders",
      registeredRange: "A:B",
      projection: "user_input",
      schemaVersion: 1,
      effects: [effect],
    });
    const sandbox = createEffectApplySandbox(
      operation,
      [["id", "status"], ["order-1", "paid"]],
      { 2: ["sync-anchor:order-1"] },
      [RECEIPT_HEADERS],
    );

    const result = sandbox.run() as {
      results: Array<{
        effectId: string;
        status: string;
        visibleRevision: number | null;
        visibleHash: string | null;
        postcondition: string;
      }>;
      hasMore: boolean;
      timing: { phases: Array<{ phase: string; durationMs: number }> };
    };

    expect(result.hasMore).toBe(false);
    expect(result.results).toEqual([{
      effectId: "effect-delete-1",
      payloadHash: "payload-effect-delete-1",
      status: "applied",
      visibleRevision: 1,
      visibleHash: effect.payload.targetVisibleHash,
      snapshotHash: null,
      reason: null,
      postcondition: "verified",
    }]);
    // The target row was removed with the built-in row mutation API and the
    // receipt row landed through insertRowsAfter + setValues on the hidden
    // receipt sheet, with an explicit flush separating the two phases.
    expect(sandbox.dataSheet.writes).toEqual([{ kind: "deleteRows", row: 2, count: 1 }]);
    expect(sandbox.receiptSheet.writes).toEqual([
      { kind: "insertRowsAfter", row: 1, count: 1 },
      { kind: "setValues", row: 2, column: 1 },
    ]);
    expect(sandbox.flushCount()).toBe(2);
    expect(sandbox.dataSheet.snapshot()).toEqual([[ "id", "status"]]);
    expect(sandbox.receiptSheet.snapshot()[1]).toEqual([
      "effect-delete-1",
      "payload-effect-delete-1",
      "applied",
      effect.payload.targetVisibleHash,
      1,
      expect.any(String) as unknown as string,
    ]);
    const phaseNames = result.timing.phases.map((phase) => phase.phase);
    expect(phaseNames).toContain("delete_and_receipt_batch");
    expect(phaseNames).toContain("receipt_write");
    expect(phaseNames[phaseNames.length - 1]).toBe("script_lock");
  });

  it("deletes multiple target rows in descending physical row order", () => {
    const first = createDeletionEffect(
      "effect-delete-1",
      "order-1",
      { id: "order-1", status: "paid" },
      "sync-anchor:order-1",
    );
    const second = createDeletionEffect(
      "effect-delete-2",
      "order-2",
      { id: "order-2", status: "pending" },
      "sync-anchor:order-2",
    );
    const operation = createApplyEffectsOperation({
      physicalSheetId: "orders-state",
      sheetName: "Orders",
      registeredRange: "A:B",
      projection: "user_input",
      schemaVersion: 1,
      effects: [first, second],
    });
    const sandbox = createEffectApplySandbox(
      operation,
      [["id", "status"], ["order-1", "paid"], ["order-2", "pending"]],
      { 2: ["sync-anchor:order-1"], 3: ["sync-anchor:order-2"] },
      [RECEIPT_HEADERS],
    );

    const result = sandbox.run() as { results: Array<{ status: string }> };

    expect(result.results.map((entry) => entry.status)).toEqual(["applied", "applied"]);
    // Descending physical order: deleting row 3 first means deleting row 2
    // afterwards still addresses its original target, never a shifted row.
    expect(sandbox.dataSheet.writes).toEqual([
      { kind: "deleteRows", row: 3, count: 1 },
      { kind: "deleteRows", row: 2, count: 1 },
    ]);
    expect(sandbox.dataSheet.snapshot()).toEqual([["id", "status"]]);
    expect(sandbox.receiptSheet.snapshot()).toHaveLength(3);
  });

  it("fails closed when two rows share one physical anchor", () => {
    const effect = createEffect();
    const operation = createApplyEffectsOperation({
      physicalSheetId: "orders-state",
      sheetName: "Orders",
      registeredRange: "A:B",
      projection: "system_state",
      schemaVersion: 1,
      effects: [effect],
    });
    // Both physical rows claim the same Developer Metadata anchor, so the
    // gateway cannot tell which row the effect targets and must refuse the
    // whole operation instead of silently picking one.
    const sandbox = createEffectApplySandbox(
      operation,
      [["id", "status"], ["order-1", "paid"], ["order-2", "pending"]],
      { 2: ["sync-anchor:order-1"], 3: ["sync-anchor:order-1"] },
      [RECEIPT_HEADERS],
    );

    expect(() => sandbox.run(operation.args)).toThrow(
      "sync anchor is duplicated: sync-anchor:order-1 at rows 2 and 3",
    );
    expect(sandbox.dataSheet.writes).toHaveLength(0);
  });

  it("fails closed when two unanchored rows share one identity", () => {
    const operation = createApplyEffectsOperation({
      physicalSheetId: "orders-state",
      sheetName: "Orders",
      registeredRange: "A:B",
      projection: "system_state",
      schemaVersion: 1,
      identityField: "id",
      effects: [createAppendEffect()],
    });
    // No Developer Metadata anchors exist at all: the effect would locate its
    // target through the registered identity field, and a duplicated identity
    // must fail closed before any row is created or updated.
    const sandbox = createEffectApplySandbox(
      operation,
      [["id", "status"], ["order-1", "paid"], ["order-1", "pending"]],
      {},
      [RECEIPT_HEADERS],
    );

    expect(() => sandbox.run(operation.args)).toThrow(
      "sync identity is duplicated: order-1 at rows 2 and 3",
    );
    expect(sandbox.dataSheet.writes).toHaveLength(0);
    expect(sandbox.receiptSheet.writes).toHaveLength(0);
  });

  it("flushes ordinary receipt writes before releasing the effect lock so a later operation observes them", () => {
    const effect = createEffect();
    const operation = createApplyEffectsOperation({
      physicalSheetId: "orders-state",
      sheetName: "Orders",
      registeredRange: "A:B",
      projection: "system_state",
      schemaVersion: 1,
      effects: [effect],
    });
    // Mutations stay buffered until SpreadsheetApp.flush(), modeling real
    // Sheets: a second script execution that acquires the effect lock after
    // this one releases it can only see the receipt if it was flushed while
    // the lock was still held.
    const sandbox = createEffectApplySandbox(
      operation,
      [["id", "status"], ["order-1", "pending"]],
      { 2: ["sync-anchor:order-1"] },
      [RECEIPT_HEADERS],
      { bufferMutationsUntilFlush: true },
    );

    const result = sandbox.run() as {
      results: Array<{
        effectId: string;
        payloadHash: string;
        status: string;
        visibleRevision: number | null;
        visibleHash: string | null;
        postcondition: string;
      }>;
    };
    expect(result.results).toEqual([{
      effectId: "effect-1",
      payloadHash: "payload-hash-1",
      status: "applied",
      visibleRevision: 2,
      visibleHash: effect.payload.targetVisibleHash,
      snapshotHash: null,
      reason: null,
      postcondition: "verified",
    }]);
    // The ordinary writeReceipts_ path commits the receipt with a flush while
    // the effect lock is still held: the flush event precedes the lock
    // release, and the buffered receipt row is already visible afterwards.
    expect(sandbox.receiptSheet.snapshot()[1]).toEqual([
      "effect-1",
      "payload-hash-1",
      "applied",
      effect.payload.targetVisibleHash,
      2,
      expect.any(String) as unknown as string,
    ]);
    expect(sandbox.events.lastIndexOf("flush")).toBeGreaterThanOrEqual(0);
    expect(sandbox.events.lastIndexOf("flush")).toBeLessThan(
      sandbox.events.indexOf("releaseLock"),
    );

    // The next operation acquires the lock after this one released it and
    // observes the committed receipt; without the flush-before-release it
    // would read the target row without the receipt and stay fail-closed.
    const probe = createReadEffectPostconditionsOperation({
      physicalSheetId: "orders-state",
      sheetName: "Orders",
      registeredRange: "A:B",
      projection: "system_state",
      schemaVersion: 1,
      effects: [effect],
    });
    const probeResult = sandbox.run(probe.args) as {
      results: Array<{
        effectId: string;
        payloadHash: string;
        postcondition: {
          disposition: string;
          visibleRevision: number | null;
          visibleHash: string | null;
        };
      }>;
    };
    expect(probeResult.results).toEqual([{
      effectId: "effect-1",
      payloadHash: "payload-hash-1",
      postcondition: {
        disposition: "applied",
        visibleRevision: 2,
        visibleHash: effect.payload.targetVisibleHash,
        snapshotHash: null,
      },
    }]);
  });

  it("keeps the script-lock phase diagnostic out of the total timing", () => {
    const effect = createDeletionEffect(
      "effect-delete-1",
      "order-1",
      { id: "order-1", status: "paid" },
      "sync-anchor:order-1",
    );
    const operation = createApplyEffectsOperation({
      physicalSheetId: "orders-state",
      sheetName: "Orders",
      registeredRange: "A:B",
      projection: "user_input",
      schemaVersion: 1,
      effects: [effect],
    });
    // A slow lock acquisition makes the double-count observable: durationMs
    // already covers the lock wait, so the diagnostic script_lock phase must
    // never be added to the total a second time.
    const sandbox = createEffectApplySandbox(
      operation,
      [["id", "status"], ["order-1", "paid"]],
      { 2: ["sync-anchor:order-1"] },
      [RECEIPT_HEADERS],
      { lockDelayMs: 8 },
    );

    const result = sandbox.run() as {
      timing: { durationMs: number; phases: Array<{ phase: string; durationMs: number }> };
    };
    const scriptLock = result.timing.phases[result.timing.phases.length - 1];
    expect(scriptLock?.phase).toBe("script_lock");
    expect(scriptLock?.durationMs ?? 0).toBeGreaterThanOrEqual(8);
    // script_lock measures the lock wait plus the whole locked run, so the
    // run-only durationMs must stay strictly below it; adding the phase back
    // would inflate the total by the lock interval.
    expect(result.timing.durationMs).toBeLessThan(scriptLock?.durationMs ?? 0);
  });

  it("holds the Apps Script lock for a postcondition probe", async () => {
    const effect = createEffect();
    const operation = createReadEffectPostconditionOperation({
      physicalSheetId: "orders-state",
      sheetName: "Orders",
      registeredRange: "A:B",
      projection: "system_state",
      schemaVersion: 1,
      effect,
    });

    // Empty registered sheet: the probe classifies the missing target without
    // touching the receipt sheet.
    const sheet = {
      getLastRow: () => 1,
      getRange: (row: number) => ({
        getValues: () => (row === 1 ? [["id", "status"]] : [[]]),
      }),
    };
    const spreadsheet = {
      getId: () => "spreadsheet-1",
      getSheetByName: (name: string) => (name === "Orders" ? sheet : null),
    };
    const lockEvents: string[] = [];
    const LockService = {
      getScriptLock: () => ({
        tryLock: () => {
          lockEvents.push("tryLock");
          return true;
        },
        releaseLock: () => {
          lockEvents.push("releaseLock");
        },
      }),
    };
    const Utilities = {
      DigestAlgorithm: { SHA_256: "SHA_256" },
      Charset: { UTF_8: "UTF_8" },
      computeDigest: (_algorithm: string, value: unknown, _charset: string) => Array.from(
        createHash("sha256").update(String(value)).digest(),
      ),
      newBlob: (value: unknown) => ({
        getBytes: () => Array.from(new TextEncoder().encode(String(value))),
      }),
    };
    const evaluateSource = new Function(
      "LockService",
      "Utilities",
      "PropertiesService",
      `return (${operation.fn});`,
    );
    const source = evaluateSource(
      LockService,
      Utilities,
      { getScriptProperties: () => undefined },
    ) as (spreadsheet: unknown, args: unknown) => unknown;

    const result = source(spreadsheet, operation.args) as { readonly disposition: string };
    expect(result.disposition).toBe("changed");
    // A probe must hold the same script lock an apply holds for its whole
    // read-back, so a delayed or timed-out apply cannot overlap the probe.
    expect(lockEvents).toEqual(["tryLock", "releaseLock"]);
  });

  it("refuses a postcondition probe while a delayed apply still holds the script lock", async () => {
    const effect = createEffect();
    const operation = createReadEffectPostconditionOperation({
      physicalSheetId: "orders-state",
      sheetName: "Orders",
      registeredRange: "A:B",
      projection: "system_state",
      schemaVersion: 1,
      effect,
    });
    const sheet = {
      getLastRow: () => 1,
      getRange: (row: number) => ({
        getValues: () => (row === 1 ? [["id", "status"]] : [[]]),
      }),
    };
    const spreadsheet = {
      getId: () => "spreadsheet-1",
      getSheetByName: (name: string) => (name === "Orders" ? sheet : null),
    };
    // A timed-out apply still owns the remote script lock; the probe must not
    // read the Sheet while that write may still be mutating it.
    const LockService = {
      getScriptLock: () => ({
        tryLock: () => false,
        releaseLock: () => undefined,
      }),
    };
    const evaluateSource = new Function(
      "LockService",
      "Utilities",
      "PropertiesService",
      `return (${operation.fn});`,
    );
    const source = evaluateSource(
      LockService,
      {},
      { getScriptProperties: () => undefined },
    ) as (spreadsheet: unknown, args: unknown) => unknown;

    expect(() => source(spreadsheet, operation.args)).toThrow(
      "Could not acquire the sync effect gateway lock",
    );
  });

  it("never closes a receipt-less orphan row from row-hash evidence alone", () => {
    const effect = createEffect();
    const operation = createReadEffectPostconditionOperation({
      physicalSheetId: "orders-state",
      sheetName: "Orders",
      registeredRange: "A:B",
      projection: "system_state",
      schemaVersion: 1,
      effect,
    });
    // The two-flush append crashed between the target-row write and the
    // receipt write: the row already carries the target content, but the
    // receipt sheet holds no receipt for this effect. The locked probe must
    // not turn that orphan into an applied closure.
    const sheet = {
      getLastRow: () => 2,
      getRange: (row: number | string) => {
        if (typeof row === "string") {
          return {
            getDeveloperMetadata: () => [
              { getKey: () => "typed_sheets_sync_anchor", getValue: () => "sync-anchor:order-1" },
            ],
          };
        }
        if (row === 1) return { getValues: () => [["id", "status"]] };
        return { getValues: () => [["order-1", "paid"]] };
      },
    };
    const spreadsheet = {
      getId: () => "spreadsheet-1",
      getSheetByName: (name: string) => (name === "Orders" ? sheet : null),
    };
    const source = evaluatePostconditionProbeSource(operation);

    const result = source(spreadsheet, operation.args) as {
      readonly disposition: string;
      readonly reason?: string;
    };
    // The worker maps unavailable to deferred delivery-uncertain probing, so
    // the outbox effect is neither closed (completeApplied) nor blindly
    // redriven; only a receipt-backed probe may classify as applied.
    expect(result.disposition).toBe("unavailable");
    expect(result.reason).toBe("receipt_missing");
  });

  it("keeps classifying receipt-backed matching rows as applied", () => {
    const effect = createEffect();
    const operation = createReadEffectPostconditionOperation({
      physicalSheetId: "orders-state",
      sheetName: "Orders",
      registeredRange: "A:B",
      projection: "system_state",
      schemaVersion: 1,
      effect,
    });
    const sheet = {
      getLastRow: () => 2,
      getRange: (row: number | string) => {
        if (typeof row === "string") {
          return {
            getDeveloperMetadata: () => [
              { getKey: () => "typed_sheets_sync_anchor", getValue: () => "sync-anchor:order-1" },
            ],
          };
        }
        if (row === 1) return { getValues: () => [["id", "status"]] };
        return { getValues: () => [["order-1", "paid"]] };
      },
    };
    const receiptSheet = {
      getLastRow: () => 2,
      getRange: (row: number) => ({
        getValues: () => (row === 1
          ? [["effectId", "payloadHash", "status", "visibleHash", "visibleRevision", "updatedAt"]]
          : [[effect.effectId, effect.payloadHash, "applied", effect.payload.targetVisibleHash, 1, "2024-01-01T00:00:00.000Z"]]),
      }),
    };
    const spreadsheet = {
      getId: () => "spreadsheet-1",
      getSheetByName: (name: string) =>
        name === "Orders" ? sheet : name === "__typed_sheets_internal_effect_receipts" ? receiptSheet : null,
    };
    const source = evaluatePostconditionProbeSource(operation);

    const result = source(spreadsheet, operation.args) as {
      readonly disposition: string;
      readonly visibleRevision: number | null;
      readonly visibleHash: string | null;
    };
    expect(result.disposition).toBe("applied");
    expect(result.visibleRevision).toBe(1);
    expect(result.visibleHash).toBe(effect.payload.targetVisibleHash);
  });

  it("keeps receipt-backed missing non-delete rows in terminal changed recovery", () => {
    const effect = createEffect();
    const operation = createReadEffectPostconditionOperation({
      physicalSheetId: "orders-state",
      sheetName: "Orders",
      registeredRange: "A:B",
      projection: "system_state",
      schemaVersion: 1,
      effect,
    });

    expect(operation.fn).toContain("receipt !== null || !checked.payload.createIfMissing");
    expect(operation.fn).toContain("receipt_target_missing");
    expect(operation.fn).toContain("postcondition_");
  });

  it("rejects swapped effect result evidence at the operation boundary", () => {
    const first = createEffect();
    const second = { ...first, effectId: "effect-2", payloadHash: "payload-hash-2" };
    const operation = createApplyEffectsOperation({
      physicalSheetId: "orders-state",
      sheetName: "Orders",
      registeredRange: "A:B",
      projection: "system_state",
      schemaVersion: 1,
      effects: [first, second],
      postconditionMode: "inline",
    });
    const result = (effect: SyncGatewayEffect) => ({
      effectId: effect.effectId,
      payloadHash: effect.payloadHash,
      status: "applied",
      visibleRevision: null,
      visibleHash: null,
      snapshotHash: null,
      reason: null,
      postcondition: "acknowledged",
    });

    expect(() => operation.decode?.({
      results: [result(second), result(first)],
      snapshotHash: null,
      hasMore: false,
    })).toThrow("does not match the submitted effect order or evidence");
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
    expect(snapshot.rows[0]?.cells.id?.normalizedCell).toEqual({
      kind: "string",
      value: "order-1",
    });
    expect(snapshot.rows[0]?.physicalAnchor.kind).toBe("present");
    expect(operationGateway.calls).toHaveLength(2);
    expect(operationGateway.calls[0]?.fn).toContain("addDeveloperMetadata");
    expect(operationGateway.calls[0]?.fn).toContain("createDeveloperMetadataFinder");
    expect(operationGateway.calls[0]?.fn).toContain("getLocation().getRow");
    expect(operationGateway.calls[0]?.fn).toContain("LockService");
    expect(operationGateway.calls[1]?.fn).toContain("getMergedRanges");
    expect(operationGateway.calls[1]?.fn).toContain("getFormulas");
    expect(operationGateway.calls[1]?.fn).toContain("createDeveloperMetadataFinder");
    expect(operationGateway.calls[1]?.fn).not.toContain("getDeveloperMetadata");
    expect(operationGateway.calls[1]?.fn).not.toContain("LockService");
  });

  it("rejects full snapshot schema drift before polling consumes the rows", async () => {
    const operationGateway = new StubOperationGateway([{
      protocolVersion: "typed-sheets-sync-v1",
      sheetName: "Orders",
      registeredRange: "A:B",
      projection: "system_state",
      schemaVersion: 1,
      headers: ["wrong", "status"],
      rows: [],
      snapshotHash: "snapshot-hash",
      unanchoredRows: [],
      duplicateAnchors: [],
    }]);
    const adapter = new AppsScriptOperationSyncGateway({
      operationGateway,
      definitions: [createDefinition()],
    });

    await expect(adapter.readSnapshot({
      physicalSheetId: "orders-state",
      sheetName: "Orders",
      registeredRange: "A:B",
      projection: "system_state",
      schemaVersion: 1,
    })).rejects.toMatchObject({ code: "invalid_sync_gateway_response" });
  });

  it("rejects snapshot rows with incomplete registered cells", async () => {
    const operationGateway = new StubOperationGateway([{
      protocolVersion: "typed-sheets-sync-v1",
      sheetName: "Orders",
      registeredRange: "A:B",
      projection: "system_state",
      schemaVersion: 1,
      headers: ["id", "status"],
      rows: [{
        rowNumber: 2,
        physicalAnchor: null,
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
        },
      }],
      snapshotHash: "snapshot-hash",
      unanchoredRows: [2],
      duplicateAnchors: [],
    }]);
    const adapter = new AppsScriptOperationSyncGateway({
      operationGateway,
      definitions: [createDefinition()],
    });

    await expect(adapter.readSnapshot({
      physicalSheetId: "orders-state",
      sheetName: "Orders",
      registeredRange: "A:B",
      projection: "system_state",
      schemaVersion: 1,
    })).rejects.toMatchObject({ code: "invalid_sync_gateway_response" });
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
    expect(operationGateway.batches[0]?.[0]?.fn).toContain("LockService");
    expect(operationGateway.batches[0]?.[1]?.fn).toContain("LockService");
    expect(operationGateway.batches[0]?.[1]?.args).toMatchObject({
      mode: "observeSnapshot",
      readMode: "user_input",
    });
  });

  it("reads unanchored rows through the lock-free snapshot path", () => {
    const operation = createReadSnapshotOperation({
      physicalSheetId: "orders-state",
      sheetName: "Orders",
      registeredRange: "A:B",
      projection: "system_state",
      schemaVersion: 1,
      expectedHeaders: ["id", "status"],
    });
    // The sheet has no Developer Metadata anchors at all; the snapshot must
    // still read every row and report them as unanchored instead of failing.
    const sandbox = createObservationSandbox(operation.fn, [
      ["id", "status"],
      ["order-1", "paid"],
    ]);

    const result = sandbox.run(operation.args) as unknown as SyncGatewaySnapshot;

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.rowNumber).toBe(2);
    expect(result.rows[0]?.physicalAnchor).toBeNull();
    expect(result.unanchoredRows).toEqual([2]);
    expect(result.rows[0]?.cells.id?.normalizedCell).toEqual({ kind: "string", value: "order-1" });
    // The read-only snapshot source is generated without the platform lock.
    expect(operation.fn).not.toContain("LockService");
  });

  it("retains formula, merged, and error fidelity through the combined safety observation", () => {
    const operation = createObserveSnapshotOperation({
      physicalSheetId: "orders-state",
      sheetName: "Orders",
      registeredRange: "A:B",
      projection: "system_state",
      schemaVersion: 1,
      expectedHeaders: ["id", "status"],
    });
    const sandbox = createObservationSandbox(operation.fn, [
      ["id", "status"],
      ["order-1", 4],
      ["order-2", "x"],
      ["order-3", "#REF!"],
    ], {
      formulas: [
        ["", ""],
        ["", "=B2*2"],
        ["", ""],
        ["", ""],
      ],
      displayValues: [
        ["id", "status"],
        ["order-1", "4"],
        ["order-2", "x"],
        ["order-3", "#REF!"],
      ],
      mergedRanges: [{ a1: "A3:B3", row: 3, column: 1, numRows: 1, numColumns: 2 }],
    });

    const result = sandbox.run(operation.args) as unknown as {
      anchors: { assigned: number; existing: number };
      snapshot: SyncGatewaySnapshot;
    };

    // The safety scan assigns the anchors itself: no prior ensureRowAnchors
    // pass is required for the repair lane to run.
    expect(result.anchors).toMatchObject({ assigned: 3, existing: 0 });
    const rows = result.snapshot.rows;
    expect(rows).toHaveLength(3);
    expect(rows[0]?.cells.status?.cellKind).toBe("formula");
    expect(rows[0]?.cells.status?.formulaHash).toEqual(expect.any(String));
    expect(rows[1]?.cells.status?.cellKind).toBe("merged");
    expect(rows[1]?.cells.status?.mergeRange).toBe("A3:B3");
    expect(rows[2]?.cells.status?.cellKind).toBe("error");
    expect(rows[2]?.cells.status?.errorCode).toBe("#REF!");
    expect(rows[0]?.physicalAnchor).toEqual(expect.any(String));
  });

  it("reports duplicated physical anchors without assigning new ones", () => {
    const operation = createReadSnapshotOperation({
      physicalSheetId: "orders-state",
      sheetName: "Orders",
      registeredRange: "A:B",
      projection: "system_state",
      schemaVersion: 1,
      expectedHeaders: ["id", "status"],
    });
    const sandbox = createObservationSandbox(operation.fn, [
      ["id", "status"],
      ["order-1", "paid"],
      ["order-2", "pending"],
    ], { anchorsByRow: { 2: ["anchor-dup"], 3: ["anchor-dup"] } });

    const result = sandbox.run(operation.args) as unknown as SyncGatewaySnapshot;

    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]?.physicalAnchor).toBe("anchor-dup");
    expect(result.rows[1]?.physicalAnchor).toBe("anchor-dup");
    expect(result.duplicateAnchors).toEqual([{ anchor: "anchor-dup", rowNumbers: [2, 3] }]);
    expect(result.unanchoredRows).toEqual([]);
  });

  it("fails closed when one row carries multiple physical anchors", () => {
    const operation = createReadSnapshotOperation({
      physicalSheetId: "orders-state",
      sheetName: "Orders",
      registeredRange: "A:B",
      projection: "system_state",
      schemaVersion: 1,
      expectedHeaders: ["id", "status"],
    });
    const sandbox = createObservationSandbox(operation.fn, [
      ["id", "status"],
      ["order-1", "paid"],
    ], { anchorsByRow: { 2: ["anchor-a", "anchor-b"] } });

    expect(() => sandbox.run(operation.args)).toThrow("row has multiple sync anchors: 2");
  });

  it("flushes assigned anchors before releasing the observation lock so a later observation cannot assign another anchor", () => {
    const operation = createObserveSnapshotOperation({
      physicalSheetId: "orders-state",
      sheetName: "Orders",
      registeredRange: "A:B",
      projection: "system_state",
      schemaVersion: 1,
      expectedHeaders: ["id", "status"],
    });
    // Metadata mutations stay buffered until SpreadsheetApp.flush(), modeling
    // real Sheets: a second observation that acquires the lock after this one
    // releases it can only see the assigned anchors if they were flushed
    // while the lock was still held.
    const sandbox = createObservationSandbox(operation.fn, [
      ["id", "status"],
      ["order-1", "paid"],
    ], { bufferMutationsUntilFlush: true });

    const first = sandbox.run(operation.args) as unknown as {
      anchors: { assigned: number; existing: number };
      snapshot: SyncGatewaySnapshot;
    };
    expect(first.anchors).toMatchObject({ assigned: 1, existing: 0 });
    // The metadata flush precedes the anchor-lock release, so the next
    // lock-sequential observation observes the committed anchor.
    expect(sandbox.events.indexOf("flush")).toBeGreaterThanOrEqual(0);
    expect(sandbox.events.indexOf("flush")).toBeLessThan(
      sandbox.events.indexOf("releaseLock"),
    );

    const second = sandbox.run(operation.args) as unknown as {
      anchors: { assigned: number; existing: number };
      snapshot: SyncGatewaySnapshot;
    };
    // Without the flush-before-release the second observation would read
    // stale metadata and assign a second anchor to the same row.
    expect(second.anchors).toMatchObject({ assigned: 0, existing: 1 });
    expect(sandbox.assignedAnchors).toHaveLength(1);
    expect(second.snapshot.rows[0]?.physicalAnchor).toEqual(
      first.snapshot.rows[0]?.physicalAnchor,
    );
  });

  it("holds the observation script lock through the snapshot read so anchors and reads cannot interleave", () => {
    const operation = createObserveSnapshotOperation({
      physicalSheetId: "orders-state",
      sheetName: "Orders",
      registeredRange: "A:B",
      projection: "system_state",
      schemaVersion: 1,
      expectedHeaders: ["id", "status"],
    });
    // Buffered metadata models real Sheets: the anchor mutation is only
    // visible to a later lock-sequential execution after the flush inside
    // the lock, so the snapshot must be read under the same lock acquisition.
    const sandbox = createObservationSandbox(operation.fn, [
      ["id", "status"],
      ["order-1", "paid"],
    ], { bufferMutationsUntilFlush: true });

    const result = sandbox.run(operation.args) as unknown as {
      anchors: { assigned: number; existing: number };
      snapshot: SyncGatewaySnapshot;
      timing: { phases: ReadonlyArray<{ phase: string; durationMs: number }> };
    };

    expect(result.anchors).toMatchObject({ assigned: 1, existing: 0 });
    expect(result.snapshot.rows).toHaveLength(1);
    expect(result.snapshot.rows[0]?.physicalAnchor).toEqual(expect.any(String));

    // One lock acquisition covers the anchor mutation and every snapshot
    // read: releasing between them would let a concurrent effect mutate the
    // sheet and produce a mixed snapshot.
    const events = sandbox.events;
    expect(events.indexOf("tryLock")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("flush")).toBeGreaterThan(events.indexOf("tryLock"));
    for (const read of ["readValues", "readFormulas", "readDisplayValues", "readMergedRanges"]) {
      expect(events.lastIndexOf(read)).toBeGreaterThan(events.indexOf("tryLock"));
      expect(events.lastIndexOf(read)).toBeLessThan(events.indexOf("releaseLock"));
    }
    expect(events.indexOf("releaseLock")).toBe(events.length - 1);

    // phase_ records elapsed durations from start timestamps: the anchor
    // mutation barrier must be a small elapsed value, not epoch-sized.
    const barrier = result.timing.phases.find((phase) => phase.phase === "anchor_mutation_barrier");
    expect(barrier?.durationMs ?? Number.POSITIVE_INFINITY).toBeLessThan(60_000);
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

function evaluatePostconditionProbeSource(
  operation: ReturnType<typeof createReadEffectPostconditionOperation>,
): (spreadsheet: unknown, args: unknown) => unknown {
  const evaluateSource = new Function(
    "LockService",
    "Utilities",
    "PropertiesService",
    `return (${operation.fn});`,
  );
  return evaluateSource(
    { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => undefined }) },
    {
      DigestAlgorithm: { SHA_256: "SHA_256" },
      Charset: { UTF_8: "UTF_8" },
      // A content-dependent digest so postcondition hash comparisons are real.
      computeDigest: (_algorithm: string, value: unknown, _charset: string) => Array.from(
        createHash("sha256").update(String(value)).digest(),
      ),
      newBlob: (value: unknown) => ({
        getBytes: () => Array.from(new TextEncoder().encode(String(value))),
      }),
    },
    { getScriptProperties: () => undefined },
  ) as (spreadsheet: unknown, args: unknown) => unknown;
}

const RECEIPT_HEADERS = ["effectId", "payloadHash", "status", "visibleHash", "visibleRevision", "updatedAt"];

interface FakeEffectRange {
  getValues: () => unknown[][];
  setValues: (values: unknown[][]) => void;
  getDeveloperMetadata: () => Array<{ getKey: () => string; getValue: () => string }>;
}

interface FakeEffectSheetWrite {
  kind: "deleteRows" | "insertRowsAfter" | "setValues";
  row: number;
  count?: number;
  column?: number;
}

interface FakeEffectSheet {
  readonly name: string;
  getLastRow: () => number;
  getLastColumn: () => number;
  getRange: (
    row: number | string,
    column?: number,
    numRows?: number,
    numColumns?: number,
  ) => FakeEffectRange;
  insertRowsAfter: (afterRow: number, count: number) => void;
  deleteRows: (rowPosition: number, howMany: number) => void;
  isSheetHidden: () => boolean;
  hideSheet: () => void;
  snapshot: () => unknown[][];
  writes: FakeEffectSheetWrite[];
  /** Applies mutations that are still buffered until SpreadsheetApp.flush(). */
  commitPending: () => void;
}

function createEffectFakeSheet(
  name: string,
  initialRows: unknown[][],
  anchorsByRow: Record<number, string[]>,
  options: { readonly bufferMutationsUntilFlush?: boolean } = {},
): FakeEffectSheet {
  const rows: unknown[][] = initialRows.map((row) => [...row]);
  const writes: FakeEffectSheetWrite[] = [];
  // With buffering enabled, insertRowsAfter/setValues/deleteRows stay pending
  // until commitPending() runs, modeling real Sheets behavior where another
  // script execution only observes mutations after SpreadsheetApp.flush().
  const pendingMutations: Array<() => void> = [];
  const bufferMutations = options.bufferMutationsUntilFlush === true;
  const commitPending = () => {
    while (pendingMutations.length > 0) pendingMutations.shift()!();
  };
  const applyMutation = (mutation: () => void) => {
    if (bufferMutations) pendingMutations.push(mutation);
    else mutation();
  };
  return {
    name,
    getLastRow: () => rows.length,
    getLastColumn: () => Math.max(0, ...rows.map((row) => row.length)),
    getRange(row, column = 1, numRows = 1, numColumns = 1) {
      if (typeof row === "string") {
        // "N:N" row-range reads used for anchor metadata lookups.
        const rowNumber = Number(row.split(":")[0]);
        return {
          getValues: () => [],
          setValues: () => undefined,
          getDeveloperMetadata: () => (anchorsByRow[rowNumber] ?? []).map((value) => ({
            getKey: () => "typed_sheets_sync_anchor",
            getValue: () => value,
          })),
        };
      }
      const startRowIndex = row - 1;
      const startColumnIndex = column - 1;
      return {
        getValues: () => Array.from({ length: numRows }, (_, rowOffset) =>
          Array.from({ length: numColumns }, (_, columnOffset) =>
            rows[startRowIndex + rowOffset]?.[startColumnIndex + columnOffset] ?? "")),
        setValues: (values) => {
          writes.push({ kind: "setValues", row, column });
          applyMutation(() => {
            values.forEach((valueRow, rowOffset) => {
              const targetRow = rows[startRowIndex + rowOffset] ?? (rows[startRowIndex + rowOffset] = []);
              valueRow.forEach((value, columnOffset) => {
                targetRow[startColumnIndex + columnOffset] = value;
              });
            });
          });
        },
        getDeveloperMetadata: () => [],
      };
    },
    insertRowsAfter(afterRow, count) {
      writes.push({ kind: "insertRowsAfter", row: afterRow, count });
      applyMutation(() => {
        for (let index = 0; index < count; index += 1) rows.splice(afterRow, 0, []);
      });
    },
    deleteRows(rowPosition, howMany) {
      writes.push({ kind: "deleteRows", row: rowPosition, count: howMany });
      applyMutation(() => {
        rows.splice(rowPosition - 1, howMany);
      });
    },
    isSheetHidden: () => true,
    hideSheet: () => undefined,
    snapshot: () => rows.map((row) => [...row]),
    writes,
    commitPending,
  };
}

function createEffectApplySandbox(
  operation: ReturnType<typeof createApplyEffectsOperation>,
  dataRows: unknown[][],
  anchorsByRow: Record<number, string[]>,
  receiptRows: unknown[][],
  options: {
    readonly lockDelayMs?: number;
    readonly bufferMutationsUntilFlush?: boolean;
  } = {},
): {
  readonly dataSheet: FakeEffectSheet;
  readonly receiptSheet: FakeEffectSheet;
  run: (args?: unknown) => unknown;
  flushCount: () => number;
  /** tryLock/flush/releaseLock in execution order across all runs. */
  readonly events: string[];
} {
  const dataSheet = createEffectFakeSheet("Orders", dataRows, anchorsByRow, options);
  const receiptSheet = createEffectFakeSheet(
    "__typed_sheets_internal_effect_receipts",
    receiptRows,
    {},
    options,
  );
  const spreadsheet = {
    getId: () => "spreadsheet-1",
    getSheetByName: (name: string) =>
      name === "Orders" ? dataSheet : name === "__typed_sheets_internal_effect_receipts" ? receiptSheet : null,
    insertSheet: () => receiptSheet,
  };
  let flushCount = 0;
  const events: string[] = [];
  const SpreadsheetApp = {
    flush: () => {
      events.push("flush");
      // A flush is the only moment buffered mutations become visible to a
      // subsequent (lock-sequential) operation, like real Sheets.
      dataSheet.commitPending();
      receiptSheet.commitPending();
      flushCount += 1;
    },
  };
  const LockService = {
    getScriptLock: () => ({
      tryLock: () => {
        events.push("tryLock");
        // A delayed acquisition makes lock-wait timing observable so tests
        // can prove the script_lock phase stays out of the total duration.
        const lockWaitDeadline = Date.now() + (options.lockDelayMs ?? 0);
        while (Date.now() < lockWaitDeadline) { /* busy-wait for the fake lock */ }
        return true;
      },
      releaseLock: () => {
        events.push("releaseLock");
      },
    }),
  };
  const Utilities = {
    DigestAlgorithm: { SHA_256: "SHA_256" },
    Charset: { UTF_8: "UTF_8" },
    // A content-dependent digest so postcondition hash comparisons are real.
    computeDigest: (_algorithm: string, value: unknown, _charset: string) => Array.from(
      createHash("sha256").update(String(value)).digest(),
    ),
    newBlob: (value: unknown) => ({
      getBytes: () => Array.from(new TextEncoder().encode(String(value))),
    }),
  };
  const evaluateSource = new Function(
    "LockService",
    "SpreadsheetApp",
    "Utilities",
    "PropertiesService",
    `return (${operation.fn});`,
  );
  const source = evaluateSource(
    LockService,
    SpreadsheetApp,
    Utilities,
    { getScriptProperties: () => undefined },
  ) as (spreadsheet: unknown, args: unknown) => unknown;
  return {
    dataSheet,
    receiptSheet,
    run: (args = operation.args) => source(spreadsheet, args),
    flushCount: () => flushCount,
    events,
  };
}

interface FakeObservationMergedRange {
  readonly a1: string;
  readonly row: number;
  readonly column: number;
  readonly numRows: number;
  readonly numColumns: number;
}

/**
 * Executes a real observation operation source against a fake spreadsheet.
 *
 * The fake can model sheets with no Developer Metadata anchors at all, rows
 * with duplicated anchors, formulas, merged ranges, and displayed errors, so
 * tests prove the unanchored default path and the full safety-scan fidelity
 * against the actual V8 source rather than a stub response.
 */
function createObservationSandbox(
  fn: string,
  values: readonly (readonly unknown[])[],
  options: {
    readonly anchorsByRow?: Readonly<Record<number, readonly string[]>>;
    readonly formulas?: readonly (readonly unknown[])[];
    readonly displayValues?: readonly (readonly unknown[])[];
    readonly mergedRanges?: readonly FakeObservationMergedRange[];
    readonly bufferMutationsUntilFlush?: boolean;
  } = {},
): {
  run: (args?: unknown) => unknown;
  readonly assignedAnchors: ReadonlyArray<{ readonly rowNumber: number; readonly value: string }>;
  /** tryLock/flush/releaseLock in execution order across all runs. */
  readonly events: readonly string[];
} {
  const rows: unknown[][] = values.map((row) => [...row]);
  const anchorsByRow: Record<number, string[]> = {};
  for (const [rowNumber, anchors] of Object.entries(options.anchorsByRow ?? {})) {
    anchorsByRow[Number(rowNumber)] = [...anchors];
  }
  const assignedAnchors: Array<{ rowNumber: number; value: string }> = [];
  // With buffering enabled, addDeveloperMetadata stays pending until
  // SpreadsheetApp.flush(), modeling real Sheets where another script
  // execution only observes metadata after a flush.
  const pendingMetadata: Array<() => void> = [];
  const bufferMutations = options.bufferMutationsUntilFlush === true;
  const commitPending = () => {
    while (pendingMetadata.length > 0) pendingMetadata.shift()!();
  };
  const events: string[] = [];
  const sheet = {
    getLastRow: () => rows.length,
    getRange(row: number | string, column = 1, numRows = 1, numColumns = 1) {
      if (typeof row === "string") {
        // "N:N" row-range used by the anchor repair lane.
        const rowNumber = Number(row.split(":")[0]);
        return {
          getValues: () => [],
          getFormulas: () => [],
          getDisplayValues: () => [],
          getMergedRanges: () => [],
          addDeveloperMetadata: (key: string, value: string) => {
            const apply = () => {
              const bucket = anchorsByRow[rowNumber] ?? (anchorsByRow[rowNumber] = []);
              bucket.push(value);
              assignedAnchors.push({ rowNumber, value });
            };
            if (bufferMutations) pendingMetadata.push(apply);
            else apply();
          },
        };
      }
      const startRowIndex = row - 1;
      const startColumnIndex = column - 1;
      return {
        getValues: () => {
          events.push("readValues");
          return Array.from({ length: numRows }, (_, rowOffset) =>
            Array.from({ length: numColumns }, (_, columnOffset) =>
              rows[startRowIndex + rowOffset]?.[startColumnIndex + columnOffset] ?? ""));
        },
        getFormulas: () => {
          events.push("readFormulas");
          return Array.from({ length: numRows }, (_, rowOffset) =>
            Array.from({ length: numColumns }, (_, columnOffset) =>
              options.formulas?.[startRowIndex + rowOffset]?.[startColumnIndex + columnOffset] ?? ""));
        },
        getDisplayValues: () => {
          events.push("readDisplayValues");
          return Array.from({ length: numRows }, (_, rowOffset) =>
            Array.from({ length: numColumns }, (_, columnOffset) =>
              options.displayValues?.[startRowIndex + rowOffset]?.[startColumnIndex + columnOffset]
                ?? rows[startRowIndex + rowOffset]?.[startColumnIndex + columnOffset] ?? ""));
        },
        getMergedRanges: () => {
          events.push("readMergedRanges");
          return (options.mergedRanges ?? []).map((merged) => ({
            getA1Notation: () => merged.a1,
            getRow: () => merged.row,
            getColumn: () => merged.column,
            getNumRows: () => merged.numRows,
            getNumColumns: () => merged.numColumns,
          }));
        },
      };
    },
    createDeveloperMetadataFinder: () => ({
      withKey: () => ({
        withLocationType: () => ({
          find: () => Object.entries(anchorsByRow).flatMap(([rowNumber, anchors]) =>
            anchors.map((value) => ({
              getLocation: () => ({ getRow: () => ({ getRow: () => Number(rowNumber) }) }),
              getValue: () => value,
            }))),
        }),
      }),
    }),
  };
  const spreadsheet = {
    getId: () => "spreadsheet-1",
    getSheetByName: (name: string) => (name === "Orders" ? sheet : null),
  };
  let uuidSequence = 0;
  const Utilities = {
    DigestAlgorithm: { SHA_256: "SHA_256" },
    Charset: { UTF_8: "UTF_8" },
    computeDigest: (_algorithm: string, value: unknown, _charset: string) => Array.from(
      createHash("sha256").update(String(value)).digest(),
    ),
    newBlob: (value: unknown) => ({
      getBytes: () => Array.from(new TextEncoder().encode(String(value))),
    }),
    getUuid: () => "uuid-" + ++uuidSequence,
  };
  const LockService = {
    getScriptLock: () => ({
      tryLock: () => {
        events.push("tryLock");
        return true;
      },
      releaseLock: () => {
        events.push("releaseLock");
      },
    }),
  };
  const SpreadsheetApp = {
    DeveloperMetadataVisibility: { PROJECT: "PROJECT" },
    DeveloperMetadataLocationType: { ROW: "ROW" },
    flush: () => {
      events.push("flush");
      // A flush is the only moment buffered metadata becomes visible to a
      // subsequent (lock-sequential) operation, like real Sheets.
      commitPending();
    },
  };
  const evaluateSource = new Function(
    "LockService",
    "SpreadsheetApp",
    "Utilities",
    "PropertiesService",
    `return (${fn});`,
  );
  const source = evaluateSource(
    LockService,
    SpreadsheetApp,
    Utilities,
    { getScriptProperties: () => undefined },
  ) as (spreadsheet: unknown, args: unknown) => unknown;
  return {
    run: (args?: unknown) => source(spreadsheet, args),
    assignedAnchors,
    events,
  };
}

function createDeletionEffect(
  effectId: string,
  targetId: string,
  fieldValues: Record<string, string>,
  anchor: string,
): SyncGatewayEffect {
  const fields: Record<string, { kind: "string"; value: string }> = {};
  Object.keys(fieldValues).forEach((name) => {
    fields[name] = { kind: "string", value: fieldValues[name]! };
  });
  const targetVisibleHash = computeSyncVisibleHash(fields);
  return {
    effectId,
    payloadHash: `payload-${effectId}`,
    effectKind: "user_input_delete",
    physicalSheetId: "orders-state",
    projection: "user_input",
    targetKind: "entity",
    targetId,
    rowBindingId: { kind: "present", value: `row-${targetId}` },
    conflictId: { kind: "absent" },
    expectedVisibleRevision: 1,
    expectedVisibleHash: targetVisibleHash,
    repairGuardHash: { kind: "absent" },
    payload: {
      sheetName: "Orders",
      registeredRange: "A:B",
      schemaVersion: 1,
      targetAnchor: anchor,
      fields,
      targetVisibleHash,
      createIfMissing: false,
      expectedCandidateHash: { kind: "not_applicable" },
    },
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

function createAppendEffect(): SyncGatewayEffect {
  const fields = {
    id: { kind: "string" as const, value: "order-1" },
    status: { kind: "string" as const, value: "paid" },
  };
  return {
    effectId: "effect-append-1",
    payloadHash: "payload-append-1",
    effectKind: "system_projection",
    physicalSheetId: "orders-state",
    projection: "system_state",
    targetKind: "entity",
    targetId: "order-1",
    rowBindingId: { kind: "present", value: "row-1" },
    conflictId: { kind: "absent" },
    expectedVisibleRevision: 0,
    expectedVisibleHash: "",
    repairGuardHash: { kind: "absent" },
    payload: {
      sheetName: "Orders",
      registeredRange: "A:B",
      schemaVersion: 1,
      targetAnchor: "sync-anchor:order-1",
      fields,
      targetVisibleHash: computeSyncVisibleHash(fields),
      createIfMissing: true,
      expectedCandidateHash: { kind: "not_applicable" },
    },
  };
}
