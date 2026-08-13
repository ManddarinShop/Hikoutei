import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineTypedSheetsEntity } from "../src/index.js";
import {
  createInternalSyncService,
  type InternalSyncService,
} from "../src/application/sync/service/SyncServiceBootstrap.js";
import { SYNC_SERVICE_ERROR_CODES } from "../src/application/sync/service/errors.js";
import {
  applyEffectResultWithAdapter,
  claimEffectWithAdapter,
  claimWriterLeaseWithAdapter,
  WRITER_LEASE_CLAIM_RESULT_KINDS,
} from "@hikoutei/ikisaki";
import { presentValue } from "../src/shared/state/index.js";
import { SYNC_PROJECTIONS } from "../src/application/sync/sheetsContract/constants.js";
import { runReconciliationScan } from "../src/application/sync/outbound/reconciliation/ReconciliationScanner.js";
import type {
  SyncSheetsProvisioner,
  SyncSheetsProvisionRoute,
} from "../src/application/sync/sheetsContract/sheetsProvisioning.js";
import type { MappedUserInputPollingReport } from "../src/adapter/persistence/providers/mikro-orm/observation/MikroOrmUserInputPolling.js";
import type { SyncTimingEvent } from "../src/application/sync/telemetry/syncTiming.js";
import { FakeSyncSheetsProvider } from "./support/FakeSyncSheetsProvider.js";
import {
  StubSpreadsheet,
  StubSheetsTransport,
  stubRowFields,
} from "./support/StubSheetsTransport.js";

const User = defineTypedSheetsEntity({
  name: "SyncServiceUser",
  tableName: "sync_service_users",
  properties: {
    id: { type: "string", primary: true },
    status: { type: "string" },
  },
});

describe("internal sync service googleSheetsApi full-provider mode", () => {
  const services: InternalSyncService[] = [];

  afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.close()));
  });

  const fullProjections = {
    spreadsheetId: "sync-service-spreadsheet",
    entities: {
      SyncServiceUser: {
        systemState: { tabName: "SyncServiceUsers_System", registeredRange: "A:C" },
        syncConflicts: { tabName: "SyncServiceUsers_Conflicts", registeredRange: "A:O" },
        userInput: { tabName: "SyncServiceUsers_Input", registeredRange: "A:C" },
        userOwnedFields: ["id", "status"],
      },
    },
  };

  it("provisions an EMPTY spreadsheet, delivers effects, and polls without any Apps Script object", async () => {
    // A brand-new spreadsheet with no tabs at all: the full provider must
    // create every projection tab and header row through the stub transport.
    const spreadsheet = new StubSpreadsheet();
    const transport = new StubSheetsTransport(spreadsheet);
    const service = await createInternalSyncService({
      dbName: ":memory:",
      entities: [User],
      projections: fullProjections,
      googleSheetsApi: {
        transport,
        // Per-request pacing paces every getSpreadsheet; fast pacing keeps
        // this wall-clock test quick.
        rateLimitIntervalMs: 1,
      },
      pollingIntervalMs: 3_600_000,
      effectIdleIntervalMs: 3_600_000,
    });
    services.push(service);

    // Provisioning created all three tabs in one atomic batch (addSheet +
    // header updateCells pairs); the conflicts tab carries its checkbox
    // header row too.
    const provisionBatch = transport.appliedBatchUpdates[0];
    const addSheets = provisionBatch?.filter((request) => request.kind === "addSheet");
    expect(addSheets?.map((request) => request.kind === "addSheet" ? request.title : "")).toEqual([
      "SyncServiceUsers_System",
      "SyncServiceUsers_Input",
      "SyncServiceUsers_Conflicts",
    ]);
    const systemTab = spreadsheet.findTab("SyncServiceUsers_System");
    const inputTab = spreadsheet.findTab("SyncServiceUsers_Input");
    const conflictsTab = spreadsheet.findTab("SyncServiceUsers_Conflicts");
    expect(systemTab).toBeDefined();
    expect(inputTab).toBeDefined();
    expect(conflictsTab).toBeDefined();
    expect(systemTab?.cell(0, 0)?.userEnteredValue?.stringValue).toBe("id");
    expect(systemTab?.cell(0, 2)?.userEnteredValue?.stringValue).toBe("__typed_sheets_deleted");
    expect(conflictsTab?.cell(0, 12)?.userEnteredValue?.stringValue).toBe("Status");

    // ORM create travels through the worker to the stub tabs (system fast
    // append plus user_input create), each atomic with its receipts.
    const em = service.hikoutei.em.fork();
    em.persist(em.create(User, { id: "full-1", status: "pending" }));
    await em.flush();
    await service.effectSupervisor.runOnce();
    expect(stubRowFields(systemTab as never, 2, ["id", "status", "__typed_sheets_deleted"]).id).toEqual({
      kind: "string",
      value: "full-1",
    });
    expect(stubRowFields(inputTab as never, 2, ["id", "status"]).id).toEqual({
      kind: "string",
      value: "full-1",
    });
    const receiptTab = spreadsheet.findTab("__typed_sheets_internal_effect_receipts");
    expect(receiptTab?.hidden).toBe(true);
    expect(receiptTab?.cell(1, 0)?.userEnteredValue?.stringValue).toBeTypeOf("string");

    // A polling pass observes the created rows through the provider's own
    // snapshots/table reads (no Apps Script anywhere in this mode).
    const report = await service.pollingSupervisor.runOnce();
    expect(report.rowsScanned).toBeGreaterThanOrEqual(1);

    // ORM update and delete drain through the provider as well.
    const loaded = await em.findOne(User, { id: "full-1" });
    expect(loaded).not.toBeNull();
    if (loaded !== null) {
      loaded.status = "paid";
      await em.flush();
    }
    await service.effectSupervisor.runOnce();
    expect(stubRowFields(inputTab as never, 2, ["id", "status"]).status).toEqual({
      kind: "string",
      value: "paid",
    });

    if (loaded !== null) em.remove(loaded);
    await em.flush();
    await service.effectSupervisor.runOnce();
    expect(stubRowFields(inputTab as never, 2, ["id", "status"]).id).toBeNull();
    const systemRow = stubRowFields(systemTab as never, 2, ["id", "status", "__typed_sheets_deleted"]);
    expect(systemRow.__typed_sheets_deleted).toEqual({ kind: "boolean", value: true });
  });

  it("uses the googleSheetsApi timeout for lease-headroom validation", async () => {
    const spreadsheet = new StubSpreadsheet();
    await expect(createInternalSyncService({
      dbName: ":memory:",
      entities: [User],
      projections: fullProjections,
      googleSheetsApi: {
        transport: new StubSheetsTransport(spreadsheet),
        requestTimeoutMs: 100_000,
      },
      effectLeaseDurationMs: 120_000,
    })).rejects.toMatchObject({
      code: SYNC_SERVICE_ERROR_CODES.INVALID_OPTIONS,
      message: "sync service effectLeaseDurationMs must exceed Google Sheets API requestTimeoutMs plus two read timeouts by 30 seconds before supervisors start.",
    });
  });

  it("uses the googleSheetsApi default timeout when the option omits requestTimeoutMs", async () => {
    const spreadsheet = new StubSpreadsheet();
    await expect(createInternalSyncService({
      dbName: ":memory:",
      entities: [User],
      projections: fullProjections,
      googleSheetsApi: {
        transport: new StubSheetsTransport(spreadsheet),
      },
      effectLeaseDurationMs: 85_000,
    })).rejects.toMatchObject({
      code: SYNC_SERVICE_ERROR_CODES.INVALID_OPTIONS,
      message: "sync service effectLeaseDurationMs must exceed Google Sheets API requestTimeoutMs plus two read timeouts by 30 seconds before supervisors start.",
    });
  });

  it("passes lease-headroom validation with default timeouts and the default 120-second lease", async () => {
    // The default worst-case dispatch is 60 s write + 2 x 10 s reads + 30 s
    // headroom = 110 s, which fits inside the 120 s default effect lease, so
    // startup must succeed without any lease override.
    const spreadsheet = new StubSpreadsheet();
    const service = await createInternalSyncService({
      dbName: ":memory:",
      entities: [User],
      projections: fullProjections,
      googleSheetsApi: {
        transport: new StubSheetsTransport(spreadsheet),
        rateLimitIntervalMs: 1,
      },
      effectLeaseDurationMs: 120_000,
      pollingIntervalMs: 3_600_000,
      effectIdleIntervalMs: 3_600_000,
    });
    services.push(service);
    expect(service.effectSupervisor).toBeDefined();
  });

  it("rejects a lease that only covers the write timeout, not the two preflight reads", async () => {
    // 120 s covers 60 s write + 30 s headroom but not 2 x 10 s of preflight
    // reads; a too-large read timeout must fail the headroom validation.
    const spreadsheet = new StubSpreadsheet();
    await expect(createInternalSyncService({
      dbName: ":memory:",
      entities: [User],
      projections: fullProjections,
      googleSheetsApi: {
        transport: new StubSheetsTransport(spreadsheet),
        readTimeoutMs: 60_000,
      },
      effectLeaseDurationMs: 120_000,
    })).rejects.toMatchObject({
      code: SYNC_SERVICE_ERROR_CODES.INVALID_OPTIONS,
      message: "sync service effectLeaseDurationMs must exceed Google Sheets API requestTimeoutMs plus two read timeouts by 30 seconds before supervisors start.",
    });
  });

  it("rejects a readTimeoutMs outside the 1..60 second bounds before any transport call", async () => {
    const spreadsheet = new StubSpreadsheet();
    const transport = new StubSheetsTransport(spreadsheet);
    await expect(createInternalSyncService({
      dbName: ":memory:",
      entities: [User],
      projections: fullProjections,
      googleSheetsApi: {
        transport,
        readTimeoutMs: 500,
      },
    })).rejects.toMatchObject({
      code: SYNC_SERVICE_ERROR_CODES.INVALID_OPTIONS,
      message: "sync service googleSheetsApi readTimeoutMs must be between 1 second and 60 seconds.",
    });
    expect(transport.getSpreadsheetCalls).toBe(0);
    expect(transport.batchUpdateCalls).toBe(0);
  });
});

class RecordingProvisioner implements SyncSheetsProvisioner {
  readonly calls: Array<readonly string[]> = [];
  readonly registrations: SyncSheetsProvisionRoute[][] = [];

  async provisionRegistry(registrations: readonly SyncSheetsProvisionRoute[]) {
    this.calls.push(registrations.map((registration) => registration.sheetName));
    this.registrations.push([...registrations]);
    return {
      registrations: registrations.map(({ headers: _headers, ...registration }) => registration),
      createdSheets: registrations.map((registration) => registration.sheetName),
      initializedHeaders: registrations.map((registration) => registration.sheetName),
    };
  }
}

describe("internal sync service descriptor registry validation", () => {
  it("rejects a non-token entity value with INVALID_OPTIONS before any provider work", async () => {
    await expect(createInternalSyncService({
      dbName: ":memory:",
      entities: [{} as never],
      projections: { spreadsheetId: "sync-service-spreadsheet", entities: {} },
      provider: new FakeSyncSheetsProvider([]),
    })).rejects.toMatchObject({
      code: SYNC_SERVICE_ERROR_CODES.INVALID_OPTIONS,
      message: "sync service entities must be tokens produced by defineTypedSheetsEntity().",
    });
  });

  it("rejects duplicate entity names with INVALID_OPTIONS and the sync message", async () => {
    const Dup = defineTypedSheetsEntity({
      name: "SyncRegistryDup",
      tableName: "sync_registry_dup_a",
      properties: { id: { type: "string", primary: true } },
    });
    const DupAgain = defineTypedSheetsEntity({
      name: "SyncRegistryDup",
      tableName: "sync_registry_dup_b",
      properties: { id: { type: "string", primary: true } },
    });
    await expect(createInternalSyncService({
      dbName: ":memory:",
      entities: [Dup, DupAgain],
      projections: { spreadsheetId: "sync-service-spreadsheet", entities: {} },
      provider: new FakeSyncSheetsProvider([]),
    })).rejects.toMatchObject({
      code: SYNC_SERVICE_ERROR_CODES.INVALID_OPTIONS,
      message: 'sync service entity "SyncRegistryDup" is registered more than once.',
    });
  });

  it("rejects a shared table name with INVALID_OPTIONS and the sync message", async () => {
    const SharedOne = defineTypedSheetsEntity({
      name: "SyncRegistrySharedOne",
      tableName: "sync_registry_shared_table",
      properties: { id: { type: "string", primary: true } },
    });
    const SharedTwo = defineTypedSheetsEntity({
      name: "SyncRegistrySharedTwo",
      tableName: "sync_registry_shared_table",
      properties: { id: { type: "string", primary: true } },
    });
    await expect(createInternalSyncService({
      dbName: ":memory:",
      entities: [SharedOne, SharedTwo],
      projections: { spreadsheetId: "sync-service-spreadsheet", entities: {} },
      provider: new FakeSyncSheetsProvider([]),
    })).rejects.toMatchObject({
      code: SYNC_SERVICE_ERROR_CODES.INVALID_OPTIONS,
      message: 'sync service table "sync_registry_shared_table" is shared by "SyncRegistrySharedOne" and "SyncRegistrySharedTwo".',
    });
  });
});

describe("internal sync service injected-provider mode", () => {
  const services: InternalSyncService[] = [];

  afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.close()));
  });

  const SYSTEM_SHEET_ID = "entity:sync_service_users:system_state";
  const USER_INPUT_SHEET_ID = "entity:sync_service_users:user_input";
  const CONFLICT_SHEET_ID = "entity:sync_service_users:sync_conflicts";

  const projections = {
    spreadsheetId: "sync-service-spreadsheet",
    entities: {
      SyncServiceUser: {
        systemState: { tabName: "SyncServiceUsers_System", registeredRange: "A:C" },
        syncConflicts: { tabName: "SyncServiceUsers_Conflicts", registeredRange: "A:O" },
        userInput: { tabName: "SyncServiceUsers_Input", registeredRange: "A:C" },
        userOwnedFields: ["id", "status"],
      },
    },
  };

  class RecordingProvisioner implements SyncSheetsProvisioner {
    readonly calls: Array<readonly string[]> = [];
    readonly registrations: SyncSheetsProvisionRoute[][] = [];

    async provisionRegistry(registrations: readonly SyncSheetsProvisionRoute[]) {
      this.calls.push(registrations.map((registration) => registration.sheetName));
      this.registrations.push([...registrations]);
      return {
        registrations: registrations.map(({ headers: _headers, ...registration }) => registration),
        createdSheets: registrations.map((registration) => registration.sheetName),
        initializedHeaders: registrations.map((registration) => registration.sheetName),
      };
    }
  }

  // Shared provider fixtures for the polling/safety-scan tests. Each test
  // builds its own provider because the fake carries mutable state.
  const buildPollingProvider = () =>
    new FakeSyncSheetsProvider([
      {
        physicalSheetId: SYSTEM_SHEET_ID,
        sheetName: "SyncServiceUsers_System",
        registeredRange: "A:C",
        projection: SYNC_PROJECTIONS.SYSTEM_STATE,
        schemaVersion: 1,
        headers: ["id", "status", "__typed_sheets_deleted"],
      },
      {
        physicalSheetId: USER_INPUT_SHEET_ID,
        sheetName: "SyncServiceUsers_Input",
        registeredRange: "A:C",
        projection: SYNC_PROJECTIONS.USER_INPUT,
        schemaVersion: 1,
        headers: ["id", "status"],
      },
    ]);

  // Shared provider fixture for the human-resolution-flow tests: the
  // Sync_Conflicts tab starts with one OPEN row that has no corresponding
  // pending resolution command, mirroring a conflict the automatic resolver
  // must leave alone.
  const buildPollingProviderWithOpenConflictRow = () =>
    new FakeSyncSheetsProvider([
      {
        physicalSheetId: SYSTEM_SHEET_ID,
        sheetName: "SyncServiceUsers_System",
        registeredRange: "A:C",
        projection: SYNC_PROJECTIONS.SYSTEM_STATE,
        schemaVersion: 1,
        headers: ["id", "status", "__typed_sheets_deleted"],
      },
      {
        physicalSheetId: USER_INPUT_SHEET_ID,
        sheetName: "SyncServiceUsers_Input",
        registeredRange: "A:C",
        projection: SYNC_PROJECTIONS.USER_INPUT,
        schemaVersion: 1,
        headers: ["id", "status"],
      },
      {
        physicalSheetId: CONFLICT_SHEET_ID,
        sheetName: "SyncServiceUsers_Conflicts",
        registeredRange: "A:O",
        projection: SYNC_PROJECTIONS.SYNC_CONFLICTS,
        schemaVersion: 1,
        headers: [
          "Conflict_ID",
          "Conflict_Group_ID",
          "Event_ID",
          "Entity_ID",
          "Field_Name",
          "User_Value",
          "User_Base_Revision",
          "Canonical_Value_At_Detection",
          "Canonical_Revision_At_Detection",
          "Current_Canonical_Value",
          "Current_Canonical_Revision",
          "Candidate_Epoch",
          "Status",
          "Resolution",
          "Resolution_Command_ID",
        ],
        rows: [{
          targetId: "conflict-open-1",
          physicalAnchor: "conflict-open-anchor",
          fields: {
            Conflict_ID: { kind: "string", value: "conflict-open-1" },
            Entity_ID: { kind: "string", value: "open-user" },
            Field_Name: { kind: "string", value: "status" },
            User_Value: { kind: "string", value: "human-edit" },
            Status: { kind: "string", value: "OPEN" },
            Resolution: { kind: "string", value: "" },
          },
        }],
      },
    ]);

  // Seeds one OPEN conflict row (with its event ledger) through direct SQL so
  // a test can model a conflict that has no durable pending resolution
  // command, exactly the state a human resolver must handle on the
  // Sync_Conflicts tab.
  const insertOpenConflictWithSql = async (
    service: InternalSyncService,
    conflictId: string,
  ): Promise<void> => {
    const binding = await service.storage.read(({ sql }) => sql.get<{
      readonly row_binding_id: string;
      readonly entity_id: string | null;
    }>(
      "SELECT row_binding_id, entity_id FROM row_binding WHERE logical_sheet_id = ? LIMIT 1",
      ["entity:sync_service_users"],
    ));
    if (binding === undefined || binding.entity_id === null) {
      throw new Error("expected a mapped row binding with an entity id");
    }
    const now = Date.now();
    const batchId = `batch-${conflictId}`;
    const eventId = `event-${conflictId}`;
    await service.storage.transaction(async ({ sql }) => {
      await sql.run(
        "INSERT INTO event_batch (batch_id, logical_sheet_id, physical_sheet_id, source, projection, atomicity, base_snapshot_hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [batchId, "entity:sync_service_users", USER_INPUT_SHEET_ID, "polling", "user_input", "row_independent", "snapshot"],
      );
      await sql.run(
        "INSERT INTO event_log (event_id, logical_sheet_id, physical_sheet_id, event_key, payload_hash, event_sequence, batch_id, row_binding_id, operation, status, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [eventId, "entity:sync_service_users", USER_INPUT_SHEET_ID, `event-key-${conflictId}`, "payload", 1, batchId, binding.row_binding_id, "update", "conflict", now],
      );
      await sql.run(
        "INSERT INTO sync_conflict (conflict_id, event_id, logical_sheet_id, entity_id, row_binding_id, field_name, user_value, user_base_revision, canonical_value_at_detection, canonical_revision_at_detection, current_canonical_value, current_canonical_revision, candidate_epoch, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          conflictId,
          eventId,
          "entity:sync_service_users",
          binding.entity_id,
          binding.row_binding_id,
          "status",
          JSON.stringify({ kind: "string", value: "human-edit" }),
          1,
          JSON.stringify({ kind: "string", value: "canonical" }),
          2,
          JSON.stringify({ kind: "string", value: "canonical" }),
          2,
          3,
          "OPEN",
          now,
          now,
        ],
      );
    });
  };

  it("provisions projections and delivers ORM outbox effects through the injected provider", async () => {
    const provider = new FakeSyncSheetsProvider([
      {
        physicalSheetId: SYSTEM_SHEET_ID,
        sheetName: "SyncServiceUsers_System",
        registeredRange: "A:C",
        projection: SYNC_PROJECTIONS.SYSTEM_STATE,
        schemaVersion: 1,
        headers: ["id", "status", "__typed_sheets_deleted"],
      },
      {
        physicalSheetId: USER_INPUT_SHEET_ID,
        sheetName: "SyncServiceUsers_Input",
        registeredRange: "A:C",
        projection: SYNC_PROJECTIONS.USER_INPUT,
        schemaVersion: 1,
        headers: ["id", "status"],
      },
    ]);
    const provisioner = new RecordingProvisioner();
    const service = await createInternalSyncService({
      dbName: ":memory:",
      entities: [User],
      projections,
      provider,
      provisioner,
      pollingIntervalMs: 60_000,
      effectIdleIntervalMs: 60_000,
    });
    services.push(service);

    expect(provisioner.calls).toEqual([["SyncServiceUsers_System", "SyncServiceUsers_Input", "SyncServiceUsers_Conflicts"]]);
    expect(provisioner.registrations[0]?.find((registration) => registration.projection === SYNC_PROJECTIONS.SYNC_CONFLICTS)).toMatchObject({
      headers: [
        "Conflict_ID",
        "Conflict_Group_ID",
        "Event_ID",
        "Entity_ID",
        "Field_Name",
        "User_Value",
        "User_Base_Revision",
        "Canonical_Value_At_Detection",
        "Canonical_Revision_At_Detection",
        "Current_Canonical_Value",
        "Current_Canonical_Revision",
        "Candidate_Epoch",
        "Status",
        "Resolution",
        "Resolution_Command_ID",
      ],
    });

    const em = service.hikoutei.em.fork();
    em.persist(em.create(User, { id: "u1", status: "pending" }));
    await em.flush();
    await service.effectSupervisor.runOnce();

    const snapshot = await provider.readSnapshot({
      physicalSheetId: SYSTEM_SHEET_ID,
      sheetName: "SyncServiceUsers_System",
      registeredRange: "A:C",
      projection: SYNC_PROJECTIONS.SYSTEM_STATE,
      schemaVersion: 1,
    });
    expect(snapshot.rows[0]?.cells).toMatchObject({
      id: { normalizedCell: { kind: "string", value: "u1" } },
      status: { normalizedCell: { kind: "string", value: "pending" } },
    });
  });

  it("persists invalid User_Input rows as durable quarantine evidence", async () => {
    const provider = new FakeSyncSheetsProvider([
      {
        physicalSheetId: SYSTEM_SHEET_ID,
        sheetName: "SyncServiceUsers_System",
        registeredRange: "A:C",
        projection: SYNC_PROJECTIONS.SYSTEM_STATE,
        schemaVersion: 1,
        headers: ["id", "status", "__typed_sheets_deleted"],
      },
      {
        physicalSheetId: USER_INPUT_SHEET_ID,
        sheetName: "SyncServiceUsers_Input",
        registeredRange: "A:C",
        projection: SYNC_PROJECTIONS.USER_INPUT,
        schemaVersion: 1,
        headers: ["id", "status"],
        rows: [
          {
            targetId: "unknown-1",
            physicalAnchor: "unknown-anchor-1",
            fields: {
              id: { kind: "string", value: "unknown-1" },
              status: { kind: "string", value: "invalid" },
            },
          },
          {
            targetId: "unknown-2",
            physicalAnchor: "unknown-anchor-2",
            fields: {
              id: { kind: "string", value: "unknown-2" },
              status: { kind: "string", value: "invalid" },
            },
          },
        ],
      },
    ]);
    const service = await createInternalSyncService({
      dbName: ":memory:",
      entities: [User],
      projections,
      provider,
      provisioner: new RecordingProvisioner(),
      pollingIntervalMs: 60_000,
    });
    services.push(service);

    await service.pollingSupervisor.runOnce();
    provider.mutateRow(USER_INPUT_SHEET_ID, "unknown-anchor-1", {
      id: { kind: "string", value: "unknown-3" },
      status: { kind: "string", value: "invalid-again" },
    });
    await service.pollingSupervisor.runOnce();
    const quarantines = await service.storage.read(({ sql }) => sql.all<{ readonly reason: string }>(
      "SELECT reason FROM quarantine_record WHERE logical_sheet_id = ?",
      ["entity:sync_service_users"],
    ));
    expect(quarantines).toEqual([
      { reason: "ambiguous_identity" },
      { reason: "ambiguous_identity" },
      { reason: "ambiguous_identity" },
    ]);
  });

  it("wires periodic System_State reconciliation that re-detects a removed system_state row", async () => {
    const provider = buildPollingProvider();
    const reports: Array<{ readonly effectsEnqueued: number }> = [];
    const service = await createInternalSyncService({
      dbName: ":memory:",
      entities: [User],
      projections,
      provider,
      provisioner: new RecordingProvisioner(),
      pollingIntervalMs: 60_000,
      effectIdleIntervalMs: 5,
      reconciliationIntervalMs: 5,
      onReconciliationReport: (report) => reports.push({ effectsEnqueued: report.effectsEnqueued }),
    });
    services.push(service);

    const em = service.hikoutei.em.fork();
    em.persist(em.create(User, { id: "u1", status: "pending" }));
    await em.flush();
    // Fast-append the System_State projection so the canonical row exists.
    await service.effectSupervisor.runOnce();

    // The supervisor loop (started by the bootstrap) runs the reconciliation
    // task in its first idle iteration; wait for at least one report so the
    // wiring is proven to execute against the real runtime.
    await waitForCondition(() => reports.length > 0, 5_000);
    expect(reports.length).toBeGreaterThan(0);

    // Remove the projected row so the next scan observes it as missing and
    // enqueues a system_projection correction through the durable outbox.
    provider.removeRowByIdentity(SYSTEM_SHEET_ID, "u1");
    await waitForCondition(
      () => reports.some((report) => report.effectsEnqueued > 0),
      5_000,
    );
    expect(reports.some((report) => report.effectsEnqueued > 0)).toBe(true);
  });

  it("recovers a terminal failed System_State head so later em.flush() writes converge", async () => {
    const provider = buildPollingProvider();
    const service = await createInternalSyncService({
      dbName: ":memory:",
      entities: [User],
      projections,
      provider,
      provisioner: new RecordingProvisioner(),
      pollingIntervalMs: 60_000,
      pollingFullScanIntervalMs: 3_600_000,
      effectIdleIntervalMs: 3_600_000,
      reconciliationIntervalMs: 3_600_000,
    });
    services.push(service);

    const em = service.hikoutei.em.fork();
    em.persist(em.create(User, { id: "u1", status: "pending" }));
    await em.flush();
    await service.effectSupervisor.runOnce();
    // The auto-started effect loop runs its first reconciliation right after
    // its first pass (one snapshot read per projection); settle it before
    // staging the corruption so the manual scans below stay deterministic.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    const logicalSheetId = await service.storage.read(async ({ sql }) => {
      const row = await sql.get<{ readonly sheet_id: string }>(
        "SELECT sheet_id FROM sheet_registry LIMIT 1",
      );
      if (row === undefined) throw new Error("expected a registered logical sheet");
      return row.sheet_id;
    });
    // The auto reconciliation never claims the reconciler lease while the
    // sheet is clean; the manual scans below own that lease under a fixed
    // test writer id (the first scan creates it, later scans renew it).

    // A human edit removes the System_State row; the scanner enqueues a
    // createIfMissing correction whose delivery is lost past the durable
    // probe bound, so the effect force-settles as a terminal failed head and
    // wedges the stream.
    provider.removeRowByIdentity(SYSTEM_SHEET_ID, "u1");

    const scan = (): Promise<{ readonly effectsEnqueued: number }> => runReconciliationScan({
      storage: service.storage,
      provider,
      physicalSheetId: SYSTEM_SHEET_ID,
      logicalSheetId,
      systemFields: ["id", "status", "__typed_sheets_deleted"],
      tombstoneField: "__typed_sheets_deleted",
      schemaVersion: 1,
      writerId: "manual-reconciler",
    });
    const firstScan = await scan();
    expect(firstScan.effectsEnqueued).toBe(1);

    await service.storage.transaction(({ sql }) => sql.run(
      "UPDATE sheet_effect_outbox SET status = 'failed', claim_token = NULL, lease_until = NULL, next_attempt_at = NULL, last_error_code = 'delivery_uncertain_timeout', last_error_message = 'seeded terminal failure' WHERE target_kind = 'entity' AND projection = 'system_state' AND status = 'pending'",
    ));

    // The next scan supersedes the terminal failed head and appends a fresh
    // repair; the worker applies it and the Sheet converges again.
    const recoveryScan = await scan();
    expect(recoveryScan.effectsEnqueued).toBe(1);
    await service.effectSupervisor.runOnce();
    const converged = await provider.readSnapshot({
      physicalSheetId: SYSTEM_SHEET_ID,
      sheetName: "SyncServiceUsers_System",
      registeredRange: "A:C",
      projection: SYNC_PROJECTIONS.SYSTEM_STATE,
      schemaVersion: 1,
    });
    const convergedRow = converged.rows[0];
    if (convergedRow === undefined) throw new Error("expected the repaired System_State row");
    expect(convergedRow.cells.status?.normalizedCell)
      .toEqual({ kind: "string", value: "pending" });

    // A subsequent canonical write flushes normally and the projection keeps
    // converging past the recovered stream.
    const user = await em.findOne(User, { id: "u1" });
    if (user === null) throw new Error("expected the flushed user");
    user.status = "completed";
    await em.flush();
    await service.effectSupervisor.runOnce();
    const completed = await provider.readSnapshot({
      physicalSheetId: SYSTEM_SHEET_ID,
      sheetName: "SyncServiceUsers_System",
      registeredRange: "A:C",
      projection: SYNC_PROJECTIONS.SYSTEM_STATE,
      schemaVersion: 1,
    });
    expect(completed.rows[0]?.cells.status?.normalizedCell)
      .toEqual({ kind: "string", value: "completed" });
    await expect(service.hikoutei.em.fork().findOne(User, { id: "u1" }))
      .resolves.toMatchObject({ status: "completed" });
  });

  it("fails startup when provisioning fails", async () => {
    const provider = new FakeSyncSheetsProvider([
      {
        physicalSheetId: SYSTEM_SHEET_ID,
        sheetName: "SyncServiceUsers_System",
        registeredRange: "A:C",
        projection: SYNC_PROJECTIONS.SYSTEM_STATE,
        schemaVersion: 1,
        headers: ["id", "status", "__typed_sheets_deleted"],
      },
    ]);
    const failingProvisioner: SyncSheetsProvisioner = {
      async provisionRegistry() {
        throw new Error("provisioning failed");
      },
    };

    await expect(createInternalSyncService({
      dbName: ":memory:",
      entities: [User],
      projections,
      provider,
      provisioner: failingProvisioner,
      pollingIntervalMs: 60_000,
    })).rejects.toThrow("provisioning failed");
  });

  it("rejects an injected provider combined with googleSheetsApi settings before any transport call", async () => {
    const spreadsheet = new StubSpreadsheet();
    const transport = new StubSheetsTransport(spreadsheet);
    const provider = new FakeSyncSheetsProvider([]);

    await expect(createInternalSyncService({
      dbName: ":memory:",
      entities: [User],
      projections,
      provider,
      googleSheetsApi: { transport },
    })).rejects.toMatchObject({
      code: SYNC_SERVICE_ERROR_CODES.INVALID_OPTIONS,
      message: "sync service cannot supply both an injected provider and googleSheetsApi client settings.",
    });
    expect(transport.getSpreadsheetCalls).toBe(0);
    expect(transport.batchUpdateCalls).toBe(0);
  });

  it("polls a User_Input edit into SQLite without creating a user-projection echo", async () => {
    const provider = new FakeSyncSheetsProvider([
      {
        physicalSheetId: SYSTEM_SHEET_ID,
        sheetName: "SyncServiceUsers_System",
        registeredRange: "A:C",
        projection: SYNC_PROJECTIONS.SYSTEM_STATE,
        schemaVersion: 1,
        headers: ["id", "status", "__typed_sheets_deleted"],
      },
      {
        physicalSheetId: USER_INPUT_SHEET_ID,
        sheetName: "SyncServiceUsers_Input",
        registeredRange: "A:C",
        projection: SYNC_PROJECTIONS.USER_INPUT,
        schemaVersion: 1,
        headers: ["id", "status"],
      },
    ]);
    const service = await createInternalSyncService({
      dbName: ":memory:",
      entities: [User],
      projections,
      provider,
      provisioner: new RecordingProvisioner(),
      pollingIntervalMs: 60_000,
      effectIdleIntervalMs: 60_000,
    });
    services.push(service);

    const em = service.hikoutei.em.fork();
    em.persist(em.create(User, { id: "u2", status: "pending" }));
    await em.flush();
    await service.effectSupervisor.runOnce();

    await service.pollingSupervisor.runOnce();
    const snapshotReadsBeforeSteadyPass = provider.snapshotReadCount;
    const tableReadsBeforeSteadyPass = provider.tableReadBatchCount;
    const steadyReport = await service.pollingSupervisor.runOnce();
    expect(steadyReport.mode).toBe("adaptive");
    expect(steadyReport.fullMetadataTables).toBe(0);
    expect(steadyReport.fastPathRowsScanned).toBe(1);
    expect(provider.tableReadBatchCount).toBe(tableReadsBeforeSteadyPass + 1);
    expect(provider.snapshotReadCount).toBe(snapshotReadsBeforeSteadyPass);

    const inputSnapshot = await provider.readSnapshot({
      physicalSheetId: USER_INPUT_SHEET_ID,
      sheetName: "SyncServiceUsers_Input",
      registeredRange: "A:C",
      projection: SYNC_PROJECTIONS.USER_INPUT,
      schemaVersion: 1,
    });
    const anchor = inputSnapshot.rows[0]?.physicalAnchor;
    if (anchor?.kind !== "present") throw new Error("expected a User_Input row anchor");
    provider.mutateRow(USER_INPUT_SHEET_ID, anchor.value, {
      id: { kind: "string", value: "u2" },
      status: { kind: "string", value: "approved" },
    });

    const changedReport = await service.pollingSupervisor.runOnce();
    expect(changedReport.mode).toBe("adaptive");
    expect(changedReport.fullMetadataTables).toBe(1);
    expect(changedReport.fastPathChangedRows).toBe(1);

    await expect(service.hikoutei.em.fork().findOne(User, { id: "u2" })).resolves.toMatchObject({
      status: "approved",
    });

    provider.mutateRow(USER_INPUT_SHEET_ID, anchor.value, {
      id: { kind: "string", value: "u2" },
      status: { kind: "string", value: "completed" },
    });
    await service.pollingSupervisor.runOnce();
    await expect(service.hikoutei.em.fork().findOne(User, { id: "u2" })).resolves.toMatchObject({
      status: "completed",
    });
  });

  it("schedules a safety full scan first, coalesces adaptive passes, then re-scans after the interval", async () => {
    const provider = buildPollingProvider();
    let captureFirstReport: ((report: MappedUserInputPollingReport) => void) | undefined;
    const firstSafetyScan = new Promise<MappedUserInputPollingReport>((resolve) => {
      captureFirstReport = resolve;
    });
    const service = await createInternalSyncService({
      dbName: ":memory:",
      entities: [User],
      projections,
      provider,
      provisioner: new RecordingProvisioner(),
      // Keep the auto-started loop asleep so explicit passes stay deterministic.
      pollingIntervalMs: 3_600_000,
      pollingFullScanIntervalMs: 500,
      effectIdleIntervalMs: 3_600_000,
      onPollingReport: (report) => captureFirstReport?.(report),
    });
    services.push(service);

    const em = service.hikoutei.em.fork();
    em.persist(em.create(User, { id: "safe-1", status: "pending" }));
    await em.flush();
    await service.effectSupervisor.runOnce();
    // The auto-started effect loop runs the scheduled reconciliation right
    // after its first pass; that task reads one snapshot per projection
    // (System_State repair scan plus User_Input cleanup scan). Settle it
    // before capturing the polling read counters so the adaptive-pass
    // assertions below measure polling behavior only.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    // The auto-started loop's first pass is always a safety full scan.
    const firstReport = await firstSafetyScan;
    expect(firstReport.mode).toBe("full");
    expect(firstReport.safetyFullScan).toBe(true);

    // Subsequent passes inside the interval coalesce onto the adaptive fast path
    // and never invoke full metadata observation.
    const beforeAdaptiveSnapshots = provider.snapshotReadCount;
    const beforeAdaptiveTables = provider.tableReadBatchCount;
    const adaptiveReport = await service.pollingSupervisor.runOnce();
    expect(adaptiveReport.mode).toBe("adaptive");
    expect(adaptiveReport.safetyFullScan).toBe(false);
    expect(adaptiveReport.fullMetadataTables).toBe(0);
    expect(adaptiveReport.fastPathRowsScanned).toBe(1);
    expect(provider.tableReadBatchCount).toBe(beforeAdaptiveTables + 1);
    expect(provider.snapshotReadCount).toBe(beforeAdaptiveSnapshots);

    const coalescedReport = await service.pollingSupervisor.runOnce();
    expect(coalescedReport.mode).toBe("adaptive");
    expect(coalescedReport.safetyFullScan).toBe(false);
    expect(provider.snapshotReadCount).toBe(beforeAdaptiveSnapshots);

    // After the full-scan interval elapses, the next pass is a safety full scan.
    await new Promise<void>((resolve) => setTimeout(resolve, 600));
    const beforeReScanSnapshots = provider.snapshotReadCount;
    const reScanReport = await service.pollingSupervisor.runOnce();
    expect(reScanReport.mode).toBe("full");
    expect(reScanReport.safetyFullScan).toBe(true);
    expect(provider.snapshotReadCount).toBe(beforeReScanSnapshots + 1);
  });

  it("defers implicit system-wins while a processing User_Input predecessor is in flight, then applies the exact pending command (issue #196)", async () => {
    const provider = new FakeSyncSheetsProvider([
      {
        physicalSheetId: SYSTEM_SHEET_ID,
        sheetName: "SyncServiceUsers_System",
        registeredRange: "A:C",
        projection: SYNC_PROJECTIONS.SYSTEM_STATE,
        schemaVersion: 1,
        headers: ["id", "status", "__typed_sheets_deleted"],
      },
      {
        physicalSheetId: USER_INPUT_SHEET_ID,
        sheetName: "SyncServiceUsers_Input",
        registeredRange: "A:C",
        projection: SYNC_PROJECTIONS.USER_INPUT,
        schemaVersion: 1,
        headers: ["id", "status"],
      },
      {
        physicalSheetId: CONFLICT_SHEET_ID,
        sheetName: "SyncServiceUsers_Conflicts",
        registeredRange: "A:O",
        projection: SYNC_PROJECTIONS.SYNC_CONFLICTS,
        schemaVersion: 1,
        headers: [
          "Conflict_ID",
          "Conflict_Group_ID",
          "Event_ID",
          "Entity_ID",
          "Field_Name",
          "User_Value",
          "User_Base_Revision",
          "Canonical_Value_At_Detection",
          "Canonical_Revision_At_Detection",
          "Current_Canonical_Value",
          "Current_Canonical_Revision",
          "Candidate_Epoch",
          "Status",
          "Resolution",
          "Resolution_Command_ID",
        ],
      },
    ]);
    const service = await createInternalSyncService({
      dbName: ":memory:",
      entities: [User],
      projections,
      provider,
      provisioner: new RecordingProvisioner(),
      pollingIntervalMs: 3_600_000,
      effectIdleIntervalMs: 3_600_000,
    });
    services.push(service);

    const em = service.hikoutei.em.fork();
    em.persist(em.create(User, { id: "conflict-user", status: "canonical" }));
    await em.flush();
    await service.effectSupervisor.runOnce();

    const inputSnapshot = await provider.readSnapshot({
      physicalSheetId: USER_INPUT_SHEET_ID,
      sheetName: "SyncServiceUsers_Input",
      registeredRange: "A:C",
      projection: SYNC_PROJECTIONS.USER_INPUT,
      schemaVersion: 1,
    });
    const anchor = inputSnapshot.rows[0]?.physicalAnchor;
    if (anchor?.kind !== "present") throw new Error("expected a User_Input row anchor");
    provider.mutateRow(USER_INPUT_SHEET_ID, anchor.value, {
      id: { kind: "string", value: "conflict-user" },
      status: { kind: "string", value: "human-edit" },
    });

    // A pre-detection app flush enqueues the normal full-row User_Input
    // projection; it is still in flight when polling later detects the human
    // edit, so the implicit system-wins command must wait for it.
    const firstManager = service.hikoutei.em.fork();
    const firstUser = await firstManager.findOne(User, { id: "conflict-user" });
    if (firstUser === null) throw new Error("expected conflict test entity");
    firstUser.status = "server-update";
    await firstManager.flush();

    const predecessor = await service.storage.read(({ sql }) => sql.get<{ readonly effect_id: string }>(
      "SELECT effect_id FROM sheet_effect_outbox WHERE projection = ? ORDER BY stream_sequence DESC LIMIT 1",
      [SYNC_PROJECTIONS.USER_INPUT],
    ));
    if (predecessor === undefined) throw new Error("expected a User_Input predecessor effect");
    const recoveryNow = Date.now();
    const recoveryLease = await claimWriterLeaseWithAdapter(service.storage, {
      role: "test-deferred-effect-worker",
      writerId: "test-deferred-effect-worker",
      leaseDurationMs: 60_000,
      now: recoveryNow,
    });
    if (recoveryLease.kind !== WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED) {
      throw new Error("expected a recovery writer lease");
    }
    const recoveryFence = {
      role: recoveryLease.lease.role,
      writerEpoch: recoveryLease.lease.writerEpoch,
      fencingToken: recoveryLease.lease.fencingToken,
      now: recoveryNow,
    };
    const predecessorClaim = await claimEffectWithAdapter(service.storage, {
      ...recoveryFence,
      effectId: predecessor.effect_id,
      claimToken: "deferred-test-claim",
      leaseDurationMs: 60_000,
    });
    expect(predecessorClaim.status).toBe("claimed");

    // Polling detects the conflict: OPEN + active candidate + zero commands.
    const report = await service.pollingSupervisor.runOnce();
    expect(report.conflictRows).toBe(1);
    await expect(service.storage.read(({ sql }) => sql.all<{ readonly command_id: string }>(
      "SELECT command_id FROM resolution_command",
    ))).resolves.toEqual([]);

    // A later real revision increase on the SAME conflicted field is the
    // implicit system-wins trigger; the in-flight predecessor defers the
    // exact revision-identified command as durable pending work.
    const secondManager = service.hikoutei.em.fork();
    const secondUser = await secondManager.findOne(User, { id: "conflict-user" });
    if (secondUser === null) throw new Error("expected conflict test entity");
    secondUser.status = "completed";
    await secondManager.flush();

    const pending = await service.storage.read(({ sql }) => sql.get<{
      readonly status: string;
      readonly command_id: string;
    }>(
      "SELECT status, command_id FROM resolution_command",
    ));
    expect(pending?.status).toBe("pending");
    expect(pending?.command_id).toMatch(/^sync:system-wins:conflict:/);
    const deferredCommandId = pending?.command_id;
    if (deferredCommandId === undefined) throw new Error("expected a deferred command id");
    await expect(service.storage.read(({ sql }) => sql.get<{
      readonly status: string;
      readonly current_canonical_revision: number;
      readonly last_rebased_commit_id: string | null;
    }>(
      "SELECT status, current_canonical_revision, last_rebased_commit_id FROM sync_conflict",
    ))).resolves.toMatchObject({ status: "NEEDS_REBASE" });

    // Once the predecessor settles, the next polling pass must reconstruct
    // the exact command from stored candidate evidence and apply it. The
    // predecessor settles as blocked_candidate (its baseline predates the
    // human edit), exactly like the real worker transition.
    await expect(applyEffectResultWithAdapter(service.storage, {
      ...recoveryFence,
      effectId: predecessor.effect_id,
      claimToken: "deferred-test-claim",
      status: "blocked_candidate",
      lastErrorCode: presentValue("candidate_guard_mismatch"),
      lastErrorMessage: presentValue("predecessor recovered with a candidate guard mismatch"),
    })).resolves.toBe(true);
    await service.pollingSupervisor.runOnce();
    await service.effectSupervisor.runOnce();
    await service.effectSupervisor.runOnce();
    await service.effectSupervisor.runOnce();

    await expect(service.storage.read(({ sql }) => sql.get<{ readonly status: string }>(
      "SELECT status FROM sync_conflict WHERE logical_sheet_id = ? LIMIT 1",
      ["entity:sync_service_users"],
    ))).resolves.toEqual({ status: "RESOLVED" });
    await expect(service.storage.read(({ sql }) => sql.get<{ readonly status: string; readonly command_id: string }>(
      "SELECT status, command_id FROM resolution_command WHERE target_conflict_id = (SELECT conflict_id FROM sync_conflict LIMIT 1)",
    ))).resolves.toEqual({
      status: "applied",
      // The retry reconstructed the exact same durable command identity, not
      // a new generation.
      command_id: deferredCommandId,
    });
    expect(provider.readRow(USER_INPUT_SHEET_ID, anchor.value).fields.status).toEqual({
      kind: "string",
      value: "completed",
    });
    const conflictRows = provider.readSnapshot({
      physicalSheetId: CONFLICT_SHEET_ID,
      sheetName: "SyncServiceUsers_Conflicts",
      registeredRange: "A:O",
      projection: SYNC_PROJECTIONS.SYNC_CONFLICTS,
      schemaVersion: 1,
    });
    await expect(conflictRows).resolves.toMatchObject({
      rows: [expect.objectContaining({
        cells: expect.objectContaining({
          Resolution: expect.objectContaining({
            normalizedCell: { kind: "string", value: "system_wins" },
          }),
          Status: expect.objectContaining({
            normalizedCell: { kind: "string", value: "RESOLVED" },
          }),
          Resolution_Command_ID: expect.objectContaining({
            normalizedCell: { kind: "string", value: expect.stringMatching(/^sync:system-wins:conflict:/) },
          }),
        }),
      })],
    });
  });

  it("defers implicit system-wins while a delivery-uncertain predecessor awaits its probe, then applies the exact pending command (issue #196)", async () => {
    const provider = new FakeSyncSheetsProvider([
      {
        physicalSheetId: SYSTEM_SHEET_ID,
        sheetName: "SyncServiceUsers_System",
        registeredRange: "A:C",
        projection: SYNC_PROJECTIONS.SYSTEM_STATE,
        schemaVersion: 1,
        headers: ["id", "status", "__typed_sheets_deleted"],
      },
      {
        physicalSheetId: USER_INPUT_SHEET_ID,
        sheetName: "SyncServiceUsers_Input",
        registeredRange: "A:C",
        projection: SYNC_PROJECTIONS.USER_INPUT,
        schemaVersion: 1,
        headers: ["id", "status"],
      },
      {
        physicalSheetId: CONFLICT_SHEET_ID,
        sheetName: "SyncServiceUsers_Conflicts",
        registeredRange: "A:O",
        projection: SYNC_PROJECTIONS.SYNC_CONFLICTS,
        schemaVersion: 1,
        headers: [
          "Conflict_ID",
          "Conflict_Group_ID",
          "Event_ID",
          "Entity_ID",
          "Field_Name",
          "User_Value",
          "User_Base_Revision",
          "Canonical_Value_At_Detection",
          "Canonical_Revision_At_Detection",
          "Current_Canonical_Value",
          "Current_Canonical_Revision",
          "Candidate_Epoch",
          "Status",
          "Resolution",
          "Resolution_Command_ID",
        ],
      },
    ]);
    const service = await createInternalSyncService({
      dbName: ":memory:",
      entities: [User],
      projections,
      provider,
      provisioner: new RecordingProvisioner(),
      pollingIntervalMs: 3_600_000,
      effectIdleIntervalMs: 3_600_000,
    });
    services.push(service);

    const em = service.hikoutei.em.fork();
    em.persist(em.create(User, { id: "uncertain-user", status: "canonical" }));
    await em.flush();
    await service.effectSupervisor.runOnce();

    const inputSnapshot = await provider.readSnapshot({
      physicalSheetId: USER_INPUT_SHEET_ID,
      sheetName: "SyncServiceUsers_Input",
      registeredRange: "A:C",
      projection: SYNC_PROJECTIONS.USER_INPUT,
      schemaVersion: 1,
    });
    const anchor = inputSnapshot.rows[0]?.physicalAnchor;
    if (anchor?.kind !== "present") throw new Error("expected a User_Input row anchor");
    provider.mutateRow(USER_INPUT_SHEET_ID, anchor.value, {
      id: { kind: "string", value: "uncertain-user" },
      status: { kind: "string", value: "human-edit" },
    });

    const firstManager = service.hikoutei.em.fork();
    const firstUser = await firstManager.findOne(User, { id: "uncertain-user" });
    if (firstUser === null) throw new Error("expected conflict test entity");
    firstUser.status = "server-update";
    await firstManager.flush();

    // The pre-detection User_Input effect lost its response and is waiting
    // for a postcondition probe; its remote write may still commit, so the
    // implicit system-wins command must wait for the probe to settle it.
    const predecessor = await service.storage.read(({ sql }) => sql.get<{ readonly effect_id: string }>(
      "SELECT effect_id FROM sheet_effect_outbox WHERE projection = ? ORDER BY stream_sequence DESC LIMIT 1",
      [SYNC_PROJECTIONS.USER_INPUT],
    ));
    if (predecessor === undefined) throw new Error("expected a User_Input predecessor effect");
    await service.storage.transaction(({ sql }) => sql.run(
      "UPDATE sheet_effect_outbox SET status = 'delivery_uncertain', claim_token = NULL, lease_until = NULL, uncertain_since = ?, next_probe_at = ? WHERE effect_id = ?",
      [Date.now(), Date.now() + 60_000, predecessor.effect_id],
    ));

    await service.pollingSupervisor.runOnce();
    const secondManager = service.hikoutei.em.fork();
    const secondUser = await secondManager.findOne(User, { id: "uncertain-user" });
    if (secondUser === null) throw new Error("expected conflict test entity");
    secondUser.status = "completed";
    await secondManager.flush();

    await expect(service.storage.read(({ sql }) => sql.get<{ readonly status: string }>(
      "SELECT status FROM resolution_command",
    ))).resolves.toEqual({ status: "pending" });
    const deferredCommandId = await service.storage.read(({ sql }) => sql.get<{ readonly command_id: string }>(
      "SELECT command_id FROM resolution_command",
    ));
    if (deferredCommandId === undefined) {
      throw new Error("expected a deferred command id");
    }
    await expect(service.storage.read(({ sql }) => sql.get<{ readonly status: string }>(
      "SELECT status FROM sync_conflict",
    ))).resolves.toEqual({ status: "NEEDS_REBASE" });

    // The probe settles the predecessor as applied; the same exact CAS
    // request then proceeds from stored candidate evidence.
    await service.storage.transaction(({ sql }) => sql.run(
      "UPDATE sheet_effect_outbox SET status = 'applied' WHERE effect_id = ?",
      [predecessor.effect_id],
    ));
    await service.pollingSupervisor.runOnce();
    await service.effectSupervisor.runOnce();
    await service.effectSupervisor.runOnce();
    await service.effectSupervisor.runOnce();

    await expect(service.storage.read(({ sql }) => sql.get<{ readonly status: string }>(
      "SELECT status FROM sync_conflict",
    ))).resolves.toEqual({ status: "RESOLVED" });
    // The applied command is the exact deferred identity, never a new one.
    await expect(service.storage.read(({ sql }) => sql.get<{ readonly status: string; readonly command_id: string }>(
      "SELECT status, command_id FROM resolution_command",
    ))).resolves.toEqual({ status: "applied", command_id: deferredCommandId.command_id });
    expect(provider.readRow(USER_INPUT_SHEET_ID, anchor.value).fields.status).toEqual({
      kind: "string",
      value: "completed",
    });
  });

  it("leaves a new OPEN conflict without a pending command untouched by a polling pass", async () => {
    const provider = buildPollingProviderWithOpenConflictRow();
    const service = await createInternalSyncService({
      dbName: ":memory:",
      entities: [User],
      projections,
      provider,
      provisioner: new RecordingProvisioner(),
      // Keep the auto-started loop asleep after its first pass so explicit
      // passes stay deterministic.
      pollingIntervalMs: 3_600_000,
      effectIdleIntervalMs: 3_600_000,
    });
    services.push(service);

    const em = service.hikoutei.em.fork();
    em.persist(em.create(User, { id: "open-user", status: "canonical" }));
    await em.flush();
    await service.effectSupervisor.runOnce();
    await insertOpenConflictWithSql(service, "conflict-open-1");

    await service.pollingSupervisor.runOnce();

    // The polling pass must not resolve, audit, or even claim the conflict:
    // without a durable pending resolution command the row is a human
    // resolution target, not an automatic system-wins retry.
    await expect(service.storage.read(({ sql }) => sql.get<{ readonly status: string }>(
      "SELECT status FROM sync_conflict WHERE conflict_id = ?",
      ["conflict-open-1"],
    ))).resolves.toEqual({ status: "OPEN" });
    await expect(service.storage.read(({ sql }) => sql.all<{ readonly command_id: string }>(
      "SELECT command_id FROM resolution_command",
    ))).resolves.toEqual([]);
    expect(provider.readRow(CONFLICT_SHEET_ID, "conflict-open-anchor").fields.Status).toEqual({
      kind: "string",
      value: "OPEN",
    });
  });

  it("does not auto-resolve an existing OPEN conflict at service boot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hikoutei-boot-open-conflict-"));
    try {
      const dbName = join(dir, "boot-open-conflict.sqlite");
      const provider = buildPollingProviderWithOpenConflictRow();
      const first = await createInternalSyncService({
        dbName,
        entities: [User],
        projections,
        provider,
        provisioner: new RecordingProvisioner(),
        pollingIntervalMs: 3_600_000,
        effectIdleIntervalMs: 3_600_000,
      });
      services.push(first);
      const em = first.hikoutei.em.fork();
      em.persist(em.create(User, { id: "boot-user", status: "canonical" }));
      await em.flush();
      await first.effectSupervisor.runOnce();
      await insertOpenConflictWithSql(first, "conflict-boot-1");
      // Release the leases so the restarted runtime claims immediately; the
      // OPEN conflict row survives in SQLite and must stay OPEN across boot.
      await first.close();

      const second = await createInternalSyncService({
        dbName,
        entities: [User],
        projections,
        provider,
        provisioner: new RecordingProvisioner(),
        pollingIntervalMs: 3_600_000,
        effectIdleIntervalMs: 3_600_000,
      });
      services.push(second);
      await second.pollingSupervisor.runOnce();

      // Boot used to auto-resolve every OPEN conflict before the supervisors
      // started; it must now leave the human resolution target untouched.
      await expect(second.storage.read(({ sql }) => sql.get<{ readonly status: string }>(
        "SELECT status FROM sync_conflict WHERE conflict_id = ?",
        ["conflict-boot-1"],
      ))).resolves.toEqual({ status: "OPEN" });
      await expect(second.storage.read(({ sql }) => sql.all<{ readonly command_id: string }>(
        "SELECT command_id FROM resolution_command",
      ))).resolves.toEqual([]);
      expect(provider.readRow(CONFLICT_SHEET_ID, "conflict-open-anchor").fields.Status).toEqual({
        kind: "string",
        value: "OPEN",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports inbound polling phases through the timing sink with empty operation counts", async () => {
    const provider = buildPollingProvider();
    const pollingEvents: SyncTimingEvent[] = [];
    let resolveFirstTotal: (() => void) | undefined;
    const firstPollingTotal = new Promise<void>((resolve) => {
      resolveFirstTotal = resolve;
    });
    const service = await createInternalSyncService({
      dbName: ":memory:",
      entities: [User],
      projections,
      provider,
      provisioner: new RecordingProvisioner(),
      // Keep the auto-started loop asleep after its first pass so explicit
      // passes stay deterministic.
      pollingIntervalMs: 3_600_000,
      effectIdleIntervalMs: 3_600_000,
      onTiming: (event) => {
        if (event.scope !== "polling") return;
        pollingEvents.push(event);
        if (event.phase === "polling_total") resolveFirstTotal?.();
      },
    });
    services.push(service);

    const em = service.hikoutei.em.fork();
    em.persist(em.create(User, { id: "t1", status: "pending" }));
    await em.flush();
    await service.effectSupervisor.runOnce();

    // Wait for the auto-started safety full scan to finish so the next explicit
    // pass coalesces onto the adaptive fast path deterministically.
    await firstPollingTotal;

    const beforeAdaptive = pollingEvents.length;
    const adaptiveReport = await service.pollingSupervisor.runOnce();
    const adaptivePhases = new Set(
      pollingEvents.slice(beforeAdaptive).map((event) => event.phase),
    );

    // An unchanged adaptive pass reads values only and compares them; it must
    // not escalate to full metadata observation or persistence.
    expect(adaptiveReport.mode).toBe("adaptive");
    expect(adaptiveReport.fullMetadataTables).toBe(0);
    for (const phase of [
      "canonical_state_read",
      "values_only_read",
      "fast_comparison",
      "polling_total",
    ]) {
      expect(adaptivePhases.has(phase)).toBe(true);
    }
    expect(adaptivePhases.has("full_metadata_observation")).toBe(false);
    expect(adaptivePhases.has("persistence")).toBe(false);

    // Across the safety full scan plus the adaptive pass, every implemented
    // phase is observed at least once.
    const allPhases = new Set(pollingEvents.map((event) => event.phase));
    for (const phase of [
      "canonical_state_read",
      "values_only_read",
      "fast_comparison",
      "full_metadata_observation",
      "persistence",
      "polling_total",
    ]) {
      expect(allPhases.has(phase)).toBe(true);
    }

    // Polling observes Sheets without append/update/delete work, so every event
    // reports the polling scope with empty operation kinds and zeroed counts.
    for (const event of pollingEvents) {
      expect(event.scope).toBe("polling");
      expect(event.operationKinds).toEqual([]);
      expect(event.operationCounts).toEqual({ append: 0, update: 0, delete: 0 });
      expect(event.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("keeps polling alive when the timing sink throws", async () => {
    const provider = buildPollingProvider();
    const service = await createInternalSyncService({
      dbName: ":memory:",
      entities: [User],
      projections,
      provider,
      provisioner: new RecordingProvisioner(),
      pollingIntervalMs: 3_600_000,
      effectIdleIntervalMs: 3_600_000,
      onTiming: () => {
        throw new Error("timing sink failure");
      },
    });
    services.push(service);

    const em = service.hikoutei.em.fork();
    em.persist(em.create(User, { id: "t2", status: "pending" }));
    await em.flush();
    await service.effectSupervisor.runOnce();

    // A faulty diagnostics sink must never abort inbound polling.
    const report = await service.pollingSupervisor.runOnce();
    expect(["full", "adaptive"]).toContain(report.mode);
    // Polling still reached the provider, proving the throwing sink did not
    // short-circuit the canonical read or the values-only observation.
    expect(provider.tableReadBatchCount + provider.snapshotReadCount).toBeGreaterThan(0);
  });

  it("reports zero safety-scan lag on adaptive passes inside the full-scan interval", async () => {
    const provider = buildPollingProvider();
    let nowMs = 1_000_000;
    const pollingEvents: SyncTimingEvent[] = [];
    let resolveFirstReport: ((report: MappedUserInputPollingReport) => void) | undefined;
    const firstReport = new Promise<MappedUserInputPollingReport>((resolve) => {
      resolveFirstReport = resolve;
    });
    const service = await createInternalSyncService({
      dbName: ":memory:",
      entities: [User],
      projections,
      provider,
      provisioner: new RecordingProvisioner(),
      // Keep the auto-started loop asleep after its first pass so explicit
      // passes stay deterministic, and freeze the cadence clock for assertions.
      pollingIntervalMs: 3_600_000,
      pollingFullScanIntervalMs: 500,
      now: () => nowMs,
      onTiming: (event) => {
        if (event.scope === "polling") pollingEvents.push(event);
      },
      onPollingReport: (report) => resolveFirstReport?.(report),
    });
    services.push(service);

    // The auto-started loop's first pass is always a safety full scan; its lag is
    // zero because there is no prior completed scan to be overdue against.
    const firstScan = await firstReport;
    expect(firstScan.safetyFullScan).toBe(true);
    expect(firstScan.safetyScanLagMs).toBe(0);

    // A pass that starts before the deadline coalesces onto the adaptive fast
    // path and reports a stable zero lag with no safety-scan timing phase.
    const beforeAdaptive = pollingEvents.length;
    const adaptiveReport = await service.pollingSupervisor.runOnce();
    expect(adaptiveReport.mode).toBe("adaptive");
    expect(adaptiveReport.safetyFullScan).toBe(false);
    expect(adaptiveReport.safetyScanLagMs).toBe(0);
    expect(
      pollingEvents.slice(beforeAdaptive).some((event) => event.phase === "safety_scan_lag"),
    ).toBe(false);
  });

  it("reports overdue safety-scan lag when a safety full scan completes past the deadline", async () => {
    const provider = buildPollingProvider();
    let nowMs = 1_000_000;
    const pollingEvents: SyncTimingEvent[] = [];
    let resolveFirstReport: ((report: MappedUserInputPollingReport) => void) | undefined;
    const firstReport = new Promise<MappedUserInputPollingReport>((resolve) => {
      resolveFirstReport = resolve;
    });
    const service = await createInternalSyncService({
      dbName: ":memory:",
      entities: [User],
      projections,
      provider,
      provisioner: new RecordingProvisioner(),
      pollingIntervalMs: 3_600_000,
      pollingFullScanIntervalMs: 500,
      now: () => nowMs,
      onTiming: (event) => {
        if (event.scope === "polling") pollingEvents.push(event);
      },
      onPollingReport: (report) => resolveFirstReport?.(report),
    });
    services.push(service);

    // First safety scan completes at the frozen start time (lag 0).
    await firstReport;

    // Advance exactly 100 ms past the one-minute-style deadline so the lag is
    // deterministic rather than wall-clock dependent.
    nowMs = 1_000_600;
    const beforeReScan = pollingEvents.length;
    const reScanReport = await service.pollingSupervisor.runOnce();
    expect(reScanReport.mode).toBe("full");
    expect(reScanReport.safetyFullScan).toBe(true);
    expect(reScanReport.safetyScanLagMs).toBe(100);

    const reScanLag = pollingEvents
      .slice(beforeReScan)
      .find((event) => event.phase === "safety_scan_lag");
    expect(reScanLag).toBeDefined();
    expect(reScanLag?.durationMs).toBe(100);
  });

  it("emits the safety-scan lag timing phase and keeps the deadline when a safety scan fails", async () => {
    const provider = buildPollingProvider();
    let nowMs = 1_000_000;
    const pollingEvents: SyncTimingEvent[] = [];
    let resolveFirstReport: ((report: MappedUserInputPollingReport) => void) | undefined;
    const firstReport = new Promise<MappedUserInputPollingReport>((resolve) => {
      resolveFirstReport = resolve;
    });
    const service = await createInternalSyncService({
      dbName: ":memory:",
      entities: [User],
      projections,
      provider,
      provisioner: new RecordingProvisioner(),
      pollingIntervalMs: 3_600_000,
      pollingFullScanIntervalMs: 500,
      now: () => nowMs,
      onTiming: (event) => {
        if (event.scope === "polling") pollingEvents.push(event);
      },
      onPollingReport: (report) => resolveFirstReport?.(report),
    });
    services.push(service);

    // First safety scan completes; the deadline is now the frozen start time.
    await firstReport;

    // Move past the deadline and make the next safety scan fail during the
    // metadata snapshot read, i.e. before a polling report can be produced.
    nowMs = 1_000_600;
    provider.failSnapshotReads(new Error("safety scan snapshot read failed"));
    const beforeFailingScan = pollingEvents.length;
    await expect(service.pollingSupervisor.runOnce()).rejects.toThrow(
      "safety scan snapshot read failed",
    );

    // The lag timing phase is emitted even though the scan never produced a
    // report; the original failure still propagates to the caller.
    const failingLag = pollingEvents
      .slice(beforeFailingScan)
      .find((event) => event.phase === "safety_scan_lag");
    expect(failingLag).toBeDefined();
    expect(failingLag?.durationMs).toBe(100);

    // The failed scan must not advance the deadline: with the clock unchanged,
    // the next pass is still overdue and therefore a safety full scan rather
    // than an adaptive pass.
    provider.clearSnapshotReadFailure();
    const recoveryReport = await service.pollingSupervisor.runOnce();
    expect(recoveryReport.mode).toBe("full");
    expect(recoveryReport.safetyFullScan).toBe(true);
  });
});

describe("internal sync service writer lease handoff across close/reopen", () => {
  const tempDirs: string[] = [];
  const openedServices: InternalSyncService[] = [];

  afterEach(async () => {
    await Promise.all(openedServices.splice(0).map((service) => service.close().catch(() => undefined)));
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const SYSTEM_SHEET_ID = "entity:sync_service_users:system_state";
  const USER_INPUT_SHEET_ID = "entity:sync_service_users:user_input";

  const projections = {
    spreadsheetId: "sync-service-spreadsheet",
    entities: {
      SyncServiceUser: {
        systemState: { tabName: "SyncServiceUsers_System", registeredRange: "A:C" },
        syncConflicts: { tabName: "SyncServiceUsers_Conflicts", registeredRange: "A:O" },
        userInput: { tabName: "SyncServiceUsers_Input", registeredRange: "A:C" },
        userOwnedFields: ["id", "status"],
      },
    },
  };

  const buildProvider = () =>
    new FakeSyncSheetsProvider([
      {
        physicalSheetId: SYSTEM_SHEET_ID,
        sheetName: "SyncServiceUsers_System",
        registeredRange: "A:C",
        projection: SYNC_PROJECTIONS.SYSTEM_STATE,
        schemaVersion: 1,
        headers: ["id", "status", "__typed_sheets_deleted"],
      },
      {
        physicalSheetId: USER_INPUT_SHEET_ID,
        sheetName: "SyncServiceUsers_Input",
        registeredRange: "A:C",
        projection: SYNC_PROJECTIONS.USER_INPUT,
        schemaVersion: 1,
        headers: ["id", "status"],
      },
    ]);

  const openService = async (dbName: string, provider: FakeSyncSheetsProvider): Promise<InternalSyncService> => {
    const service = await createInternalSyncService({
      dbName,
      entities: [User],
      projections,
      provider,
      provisioner: new RecordingProvisioner(),
      // Keep both auto-started loops asleep between explicit passes so the
      // lease handoff assertions stay deterministic.
      pollingIntervalMs: 3_600_000,
      effectIdleIntervalMs: 3_600_000,
    });
    openedServices.push(service);
    return service;
  };

  const newDbFile = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "hikoutei-lease-handoff-"));
    tempDirs.push(dir);
    return join(dir, "lease-handoff.sqlite");
  };

  it("releases the writer lease on close so a restarted runtime flushes immediately (issue #170)", async () => {
    const dbName = newDbFile();
    const first = await openService(dbName, buildProvider());
    const em = first.hikoutei.em.fork();
    em.persist(em.create(User, { id: "lease-1", status: "pending" }));
    await em.flush();
    await first.close();

    // Before the fix the first runtime's lease row stayed valid for 180 s, so
    // the second runtime's flush failed with WRITER_LEASE_UNAVAILABLE. After
    // graceful close the row is expired, and the new claim funnels into the
    // TAKEOVER path with a strictly higher epoch.
    const second = await openService(dbName, buildProvider());
    const restartedEm = second.hikoutei.em.fork();
    restartedEm.persist(restartedEm.create(User, { id: "lease-2", status: "pending" }));
    await expect(restartedEm.flush()).resolves.toBeUndefined();
    await expect(restartedEm.findOne(User, { id: "lease-2" })).resolves.toMatchObject({
      status: "pending",
    });

    // The mapped writer role was taken over with epoch + 1, never deleted: a
    // row DELETE would reset the epoch to 1 and fence the spreadsheet
    // authority out forever.
    const lease = await second.storage.read(({ sql }) => sql.get<{ readonly writer_epoch: number }>(
      "SELECT writer_epoch FROM writer_lease WHERE role = ?",
      ["typed-sheets-entity-writer"],
    ));
    expect(lease?.writer_epoch).toBe(2);
    await second.close();
  });

  it("expires both leases even when a supervisor stop() rejects, so close() retry and restart claim immediately (issue #170)", async () => {
    const dbName = newDbFile();
    const first = await openService(dbName, buildProvider());
    // The bootstrap owns the supervisor instances, so simulate a transport
    // teardown failure by replacing the effect supervisor's stop() for the
    // first call only; the real stop() runs on the close() retry below.
    const realEffectStop = first.effectSupervisor.stop.bind(first.effectSupervisor);
    let effectStopCalls = 0;
    first.effectSupervisor.stop = () => {
      effectStopCalls += 1;
      if (effectStopCalls === 1) {
        return Promise.reject(new Error("simulated effect supervisor stop failure"));
      }
      return realEffectStop();
    };

    // Before the fix the supervisor error skipped the lease expiry entirely:
    // stopped stayed false AND both leases stayed valid for the full window,
    // so the immediate restart failed with WRITER_LEASE_UNAVAILABLE.
    await expect(first.stop()).rejects.toThrow("simulated effect supervisor stop failure");

    // The finally block must still have expired this runtime's own leases even
    // though the supervisor error escaped: both rows survive (never deleted)
    // with lease_until pushed into the past instead of the full claim window.
    const releasedAt = Date.now();
    for (const role of ["typed-sheets-entity-writer", "sync-effect-worker"]) {
      const lease = await first.storage.read(({ sql }) => sql.get<{ readonly lease_until: number }>(
        "SELECT lease_until FROM writer_lease WHERE role = ?",
        [role],
      ));
      expect(lease?.lease_until).toBeDefined();
      expect(lease!.lease_until).toBeLessThanOrEqual(releasedAt);
    }

    // stopped stayed false after the failed attempt, so a second close()
    // re-runs the stop path (real supervisor stop now) and completes cleanly.
    await expect(first.close()).resolves.toBeUndefined();
    expect(effectStopCalls).toBe(2);

    // The release ran before the error escaped, so a restart inside the lease
    // window takes over both roles immediately (epoch + 1, never deleted).
    const second = await openService(dbName, buildProvider());
    const restartedEm = second.hikoutei.em.fork();
    restartedEm.persist(restartedEm.create(User, { id: "lease-stop-fail-1", status: "pending" }));
    await expect(restartedEm.flush()).resolves.toBeUndefined();
    for (const role of ["typed-sheets-entity-writer", "sync-effect-worker"]) {
      const lease = await second.storage.read(({ sql }) => sql.get<{ readonly writer_epoch: number }>(
        "SELECT writer_epoch FROM writer_lease WHERE role = ?",
        [role],
      ));
      expect(lease?.writer_epoch).toBe(2);
    }
    await second.close();
  });

  it("expires the claimed writer lease when startup fails, so a retry inside the lease window claims immediately (issue #170)", async () => {
    const dbName = newDbFile();
    // Fail only the first provisioning pass: conflict route registration has
    // already claimed the mapped-role writer lease before provisioning runs.
    let provisioningCalls = 0;
    const failFirstProvisioner: SyncSheetsProvisioner = {
      async provisionRegistry(registrations) {
        provisioningCalls += 1;
        if (provisioningCalls === 1) throw new Error("provisioning failed");
        return {
          registrations: registrations.map(({ headers: _headers, ...registration }) => registration),
          createdSheets: registrations.map((registration) => registration.sheetName),
          initializedHeaders: registrations.map((registration) => registration.sheetName),
        };
      },
    };
    const provider = buildProvider();
    await expect(createInternalSyncService({
      dbName,
      entities: [User],
      projections,
      provider,
      provisioner: failFirstProvisioner,
      pollingIntervalMs: 3_600_000,
      effectIdleIntervalMs: 3_600_000,
    })).rejects.toThrow("provisioning failed");

    // Before the fix the failed startup left its mapped-role claim valid for
    // the full 180-second window, so this retry failed at the same claim with
    // WRITER_LEASE_UNAVAILABLE. The startup catch now expires the claimed
    // leases, and the retry funnels into the TAKEOVER path immediately.
    const service = await createInternalSyncService({
      dbName,
      entities: [User],
      projections,
      provider,
      provisioner: failFirstProvisioner,
      pollingIntervalMs: 3_600_000,
      effectIdleIntervalMs: 3_600_000,
    });
    openedServices.push(service);

    // The mapped writer role was taken over with epoch + 1, never deleted.
    const lease = await service.storage.read(({ sql }) => sql.get<{ readonly writer_epoch: number }>(
      "SELECT writer_epoch FROM writer_lease WHERE role = ?",
      ["typed-sheets-entity-writer"],
    ));
    expect(lease?.writer_epoch).toBe(2);
  });

  it("drains a pending outbox effect after close and reopen on the same SQLite file", async () => {
    const dbName = newDbFile();
    const first = await openService(dbName, buildProvider());
    // Settle the startup worker pass first: with no effects it is idle, and
    // the loop then sleeps for the idle interval, so the effect enqueued below
    // stays pending across close() instead of being dispatched pre-close.
    await first.effectSupervisor.runOnce();
    const em = first.hikoutei.em.fork();
    em.persist(em.create(User, { id: "drain-1", status: "pending" }));
    await em.flush();
    await first.close();

    const secondProvider = buildProvider();
    const second = await openService(dbName, secondProvider);
    // The restarted worker takes over the sync-effect-worker lease and drains
    // the surviving effect. Joining the auto-started pass keeps the assertion
    // race-free: the pass cannot sleep until the ready effect is dispatched.
    await second.effectSupervisor.runOnce();
    await second.close();

    expect(secondProvider.applyEffectsCalls).toBeGreaterThanOrEqual(1);
    const snapshot = await secondProvider.readSnapshot({
      physicalSheetId: SYSTEM_SHEET_ID,
      sheetName: "SyncServiceUsers_System",
      registeredRange: "A:C",
      projection: SYNC_PROJECTIONS.SYSTEM_STATE,
      schemaVersion: 1,
    });
    expect(snapshot.rows[0]?.cells).toMatchObject({
      id: { normalizedCell: { kind: "string", value: "drain-1" } },
      status: { normalizedCell: { kind: "string", value: "pending" } },
    });
  });

  it("keeps close() idempotent after the lease release", async () => {
    const dbName = newDbFile();
    const service = await openService(dbName, buildProvider());
    await expect(service.close()).resolves.toBeUndefined();
    await expect(service.close()).resolves.toBeUndefined();
  });
});

/** Polls `predicate` until it returns true or `timeoutMs` elapses. */
async function waitForCondition(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!predicate()) {
    throw new Error(`waitForCondition timed out after ${timeoutMs}ms`);
  }
}
