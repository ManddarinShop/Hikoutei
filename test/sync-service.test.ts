import { afterEach, describe, expect, it } from "vitest";

import { defineTypedSheetsEntity } from "../src/index.js";
import {
  createInternalSyncService,
  type InternalSyncService,
} from "../src/application/sync/service/SyncServiceBootstrap.js";
import { SYNC_SERVICE_ERROR_CODES } from "../src/application/sync/service/errors.js";
import type {
  SyncGatewayProvisioner,
  SyncGatewayProvisionRoute,
} from "../src/application/sync/gateway/SyncGatewayBootstrap.js";
import {
  applyEffectResultWithAdapter,
  claimEffectWithAdapter,
  claimWriterLeaseWithAdapter,
  WRITER_LEASE_CLAIM_RESULT_KINDS,
} from "../src/infrastructure/storage/index.js";
import { presentValue } from "../src/shared/state/index.js";
import {
  SYNC_GATEWAY_PROJECTIONS,
} from "../src/application/sync/gateway/constants.js";
import type { MappedUserInputPollingReport } from "../src/adapter/persistence/providers/mikro-orm/observation/MikroOrmUserInputPolling.js";
import type { SyncTimingEvent } from "../src/application/sync/telemetry/syncTiming.js";
import { FakeSyncSheetGateway } from "./support/FakeSyncSheetGateway.js";

const User = defineTypedSheetsEntity({
  name: "SyncServiceUser",
  tableName: "sync_service_users",
  properties: {
    id: { type: "string", primary: true },
    status: { type: "string" },
  },
});

const SYSTEM_SHEET_ID = "entity:sync_service_users:system_state";
const USER_INPUT_SHEET_ID = "entity:sync_service_users:user_input";
const CONFLICT_SHEET_ID = "entity:sync_service_users:sync_conflicts";

class RecordingProvisioner implements SyncGatewayProvisioner {
  readonly calls: Array<readonly string[]> = [];
  readonly registrations: SyncGatewayProvisionRoute[][] = [];

  async provisionRegistry(registrations: readonly SyncGatewayProvisionRoute[]) {
    this.calls.push(registrations.map((registration) => registration.sheetName));
    this.registrations.push([...registrations]);
    return {
      registrations: registrations.map(({ headers: _headers, ...registration }) => registration),
      createdSheets: registrations.map((registration) => registration.sheetName),
      initializedHeaders: registrations.map((registration) => registration.sheetName),
    };
  }
}

describe("internal sync service bootstrap", () => {
  const services: InternalSyncService[] = [];

  afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.close()));
  });

  // Shared projection/gateway fixtures for the safety-scan lag telemetry tests.
  // Each test builds its own gateway because the fake carries mutable state.
  const buildPollingGateway = () =>
    new FakeSyncSheetGateway([
      {
        physicalSheetId: SYSTEM_SHEET_ID,
        sheetName: "SyncServiceUsers_System",
        registeredRange: "A:C",
        projection: SYNC_GATEWAY_PROJECTIONS.SYSTEM_STATE,
        schemaVersion: 1,
        headers: ["id", "status", "__typed_sheets_deleted"],
      },
      {
        physicalSheetId: USER_INPUT_SHEET_ID,
        sheetName: "SyncServiceUsers_Input",
        registeredRange: "A:B",
        projection: SYNC_GATEWAY_PROJECTIONS.USER_INPUT,
        schemaVersion: 1,
        headers: ["id", "status"],
      },
    ]);
  const pollingProjections = {
    spreadsheetId: "sync-service-spreadsheet",
    entities: {
      SyncServiceUser: {
        systemState: { tabName: "SyncServiceUsers_System", registeredRange: "A:C" },
        syncConflicts: { tabName: "SyncServiceUsers_Conflicts", registeredRange: "A:O" },
        userInput: { tabName: "SyncServiceUsers_Input", registeredRange: "A:B" },
        userOwnedFields: ["id", "status"],
      },
    },
  };

  it("provisions projections and delivers ORM outbox effects without root Sheet APIs", async () => {
    const gateway = new FakeSyncSheetGateway([
      {
        physicalSheetId: SYSTEM_SHEET_ID,
        sheetName: "SyncServiceUsers_System",
        registeredRange: "A:C",
        projection: SYNC_GATEWAY_PROJECTIONS.SYSTEM_STATE,
        schemaVersion: 1,
        headers: ["id", "status", "__typed_sheets_deleted"],
      },
      {
        physicalSheetId: USER_INPUT_SHEET_ID,
        sheetName: "SyncServiceUsers_Input",
        registeredRange: "A:B",
        projection: SYNC_GATEWAY_PROJECTIONS.USER_INPUT,
        schemaVersion: 1,
        headers: ["id", "status"],
      },
    ]);
    const provisioner = new RecordingProvisioner();
    const service = await createInternalSyncService({
      dbName: ":memory:",
      entities: [User],
      projections: {
        spreadsheetId: "sync-service-spreadsheet",
        entities: {
          SyncServiceUser: {
            systemState: { tabName: "SyncServiceUsers_System", registeredRange: "A:C" },
            syncConflicts: { tabName: "SyncServiceUsers_Conflicts", registeredRange: "A:O" },
            userInput: { tabName: "SyncServiceUsers_Input", registeredRange: "A:B" },
            userOwnedFields: ["id", "status"],
          },
        },
      },
      gateway,
      provisioner,
      pollingIntervalMs: 60_000,
      effectIdleIntervalMs: 60_000,
    });
    services.push(service);

    expect(provisioner.calls).toEqual([["SyncServiceUsers_System", "SyncServiceUsers_Input", "SyncServiceUsers_Conflicts"]]);
    expect(provisioner.registrations[0]?.find((registration) => registration.projection === SYNC_GATEWAY_PROJECTIONS.SYNC_CONFLICTS)).toMatchObject({
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

    const snapshot = await gateway.readSnapshot({
      physicalSheetId: SYSTEM_SHEET_ID,
      sheetName: "SyncServiceUsers_System",
      registeredRange: "A:C",
      projection: SYNC_GATEWAY_PROJECTIONS.SYSTEM_STATE,
      schemaVersion: 1,
    });
    expect(snapshot.rows[0]?.cells).toMatchObject({
      id: { normalizedCell: { kind: "string", value: "u1" } },
      status: { normalizedCell: { kind: "string", value: "pending" } },
    });
  });

  it("persists invalid User_Input rows as durable quarantine evidence", async () => {
    const gateway = new FakeSyncSheetGateway([
      {
        physicalSheetId: SYSTEM_SHEET_ID,
        sheetName: "SyncServiceUsers_System",
        registeredRange: "A:C",
        projection: SYNC_GATEWAY_PROJECTIONS.SYSTEM_STATE,
        schemaVersion: 1,
        headers: ["id", "status", "__typed_sheets_deleted"],
      },
      {
        physicalSheetId: USER_INPUT_SHEET_ID,
        sheetName: "SyncServiceUsers_Input",
        registeredRange: "A:B",
        projection: SYNC_GATEWAY_PROJECTIONS.USER_INPUT,
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
      projections: {
        spreadsheetId: "sync-service-spreadsheet",
        entities: {
          SyncServiceUser: {
            systemState: { tabName: "SyncServiceUsers_System", registeredRange: "A:C" },
            syncConflicts: { tabName: "SyncServiceUsers_Conflicts", registeredRange: "A:O" },
            userInput: { tabName: "SyncServiceUsers_Input", registeredRange: "A:B" },
            userOwnedFields: ["id", "status"],
          },
        },
      },
      gateway,
      provisioner: new RecordingProvisioner(),
      pollingIntervalMs: 60_000,
    });
    services.push(service);

    await service.pollingSupervisor.runOnce();
    gateway.mutateRow(USER_INPUT_SHEET_ID, "unknown-anchor-1", {
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

  it("rejects insufficient Gateway timeout and effect-lease headroom before startup", async () => {
    const provisioner = new RecordingProvisioner();

    await expect(createInternalSyncService({
      dbName: ":memory:",
      entities: [User],
      projections: {
        spreadsheetId: "sync-service-spreadsheet",
        entities: {
          SyncServiceUser: {
            systemState: { tabName: "SyncServiceUsers_System", registeredRange: "A:C" },
            syncConflicts: { tabName: "SyncServiceUsers_Conflicts", registeredRange: "A:O" },
          },
        },
      },
      appsScript: {
        url: "https://example.test/exec",
        secret: "test-secret",
        sheetId: "spreadsheet",
        requestTimeoutMs: 100_000,
      },
      effectLeaseDurationMs: 120_000,
      provisioner,
    })).rejects.toMatchObject({
      code: SYNC_SERVICE_ERROR_CODES.INVALID_OPTIONS,
      message: "sync service effectLeaseDurationMs must exceed Apps Script requestTimeoutMs by 30 seconds before supervisors start.",
    });
    expect(provisioner.calls).toHaveLength(0);
  });

  it("fails startup when provisioning fails", async () => {
    const gateway = new FakeSyncSheetGateway([
      {
        physicalSheetId: SYSTEM_SHEET_ID,
        sheetName: "SyncServiceUsers_System",
        registeredRange: "A:C",
        projection: SYNC_GATEWAY_PROJECTIONS.SYSTEM_STATE,
        schemaVersion: 1,
        headers: ["id", "status", "__typed_sheets_deleted"],
      },
    ]);
    const failingProvisioner: SyncGatewayProvisioner = {
      async provisionRegistry() {
        throw new Error("provisioning failed");
      },
    };

    await expect(createInternalSyncService({
      dbName: ":memory:",
      entities: [User],
      projections: {
        spreadsheetId: "sync-service-spreadsheet",
        entities: {
          SyncServiceUser: {
            systemState: { tabName: "SyncServiceUsers_System", registeredRange: "A:C" },
            syncConflicts: { tabName: "SyncServiceUsers_Conflicts", registeredRange: "A:O" },
            userOwnedFields: ["id"],
          },
        },
      },
      gateway,
      provisioner: failingProvisioner,
      pollingIntervalMs: 60_000,
    })).rejects.toThrow("provisioning failed");
  });

  it("polls a User_Input edit into SQLite without creating a user-projection echo", async () => {
    const gateway = new FakeSyncSheetGateway([
      {
        physicalSheetId: SYSTEM_SHEET_ID,
        sheetName: "SyncServiceUsers_System",
        registeredRange: "A:C",
        projection: SYNC_GATEWAY_PROJECTIONS.SYSTEM_STATE,
        schemaVersion: 1,
        headers: ["id", "status", "__typed_sheets_deleted"],
      },
      {
        physicalSheetId: USER_INPUT_SHEET_ID,
        sheetName: "SyncServiceUsers_Input",
        registeredRange: "A:B",
        projection: SYNC_GATEWAY_PROJECTIONS.USER_INPUT,
        schemaVersion: 1,
        headers: ["id", "status"],
      },
    ]);
    const service = await createInternalSyncService({
      dbName: ":memory:",
      entities: [User],
      projections: {
        spreadsheetId: "sync-service-spreadsheet",
        entities: {
          SyncServiceUser: {
            systemState: { tabName: "SyncServiceUsers_System", registeredRange: "A:C" },
            syncConflicts: { tabName: "SyncServiceUsers_Conflicts", registeredRange: "A:O" },
            userInput: { tabName: "SyncServiceUsers_Input", registeredRange: "A:B" },
            userOwnedFields: ["id", "status"],
          },
        },
      },
      gateway,
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
    const snapshotReadsBeforeSteadyPass = gateway.snapshotReadCount;
    const tableReadsBeforeSteadyPass = gateway.tableReadBatchCount;
    const steadyReport = await service.pollingSupervisor.runOnce();
    expect(steadyReport.mode).toBe("adaptive");
    expect(steadyReport.fullMetadataTables).toBe(0);
    expect(steadyReport.fastPathRowsScanned).toBe(1);
    expect(gateway.tableReadBatchCount).toBe(tableReadsBeforeSteadyPass + 1);
    expect(gateway.snapshotReadCount).toBe(snapshotReadsBeforeSteadyPass);

    const inputSnapshot = await gateway.readSnapshot({
      physicalSheetId: USER_INPUT_SHEET_ID,
      sheetName: "SyncServiceUsers_Input",
      registeredRange: "A:B",
      projection: SYNC_GATEWAY_PROJECTIONS.USER_INPUT,
      schemaVersion: 1,
    });
    const anchor = inputSnapshot.rows[0]?.physicalAnchor;
    if (anchor?.kind !== "present") throw new Error("expected a User_Input row anchor");
    gateway.mutateRow(USER_INPUT_SHEET_ID, anchor.value, {
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

    gateway.mutateRow(USER_INPUT_SHEET_ID, anchor.value, {
      id: { kind: "string", value: "u2" },
      status: { kind: "string", value: "completed" },
    });
    await service.pollingSupervisor.runOnce();
    await expect(service.hikoutei.em.fork().findOne(User, { id: "u2" })).resolves.toMatchObject({
      status: "completed",
    });
  });

  it("schedules a safety full scan first, coalesces adaptive passes, then re-scans after the interval", async () => {
    const gateway = new FakeSyncSheetGateway([
      {
        physicalSheetId: SYSTEM_SHEET_ID,
        sheetName: "SyncServiceUsers_System",
        registeredRange: "A:C",
        projection: SYNC_GATEWAY_PROJECTIONS.SYSTEM_STATE,
        schemaVersion: 1,
        headers: ["id", "status", "__typed_sheets_deleted"],
      },
      {
        physicalSheetId: USER_INPUT_SHEET_ID,
        sheetName: "SyncServiceUsers_Input",
        registeredRange: "A:B",
        projection: SYNC_GATEWAY_PROJECTIONS.USER_INPUT,
        schemaVersion: 1,
        headers: ["id", "status"],
      },
    ]);
    let captureFirstReport: ((report: MappedUserInputPollingReport) => void) | undefined;
    const firstSafetyScan = new Promise<MappedUserInputPollingReport>((resolve) => {
      captureFirstReport = resolve;
    });
    const service = await createInternalSyncService({
      dbName: ":memory:",
      entities: [User],
      projections: {
        spreadsheetId: "sync-service-spreadsheet",
        entities: {
          SyncServiceUser: {
            systemState: { tabName: "SyncServiceUsers_System", registeredRange: "A:C" },
            syncConflicts: { tabName: "SyncServiceUsers_Conflicts", registeredRange: "A:O" },
            userInput: { tabName: "SyncServiceUsers_Input", registeredRange: "A:B" },
            userOwnedFields: ["id", "status"],
          },
        },
      },
      gateway,
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

    // The auto-started loop's first pass is always a safety full scan.
    const firstReport = await firstSafetyScan;
    expect(firstReport.mode).toBe("full");
    expect(firstReport.safetyFullScan).toBe(true);

    // Subsequent passes inside the interval coalesce onto the adaptive fast path
    // and never invoke full metadata observation.
    const beforeAdaptiveSnapshots = gateway.snapshotReadCount;
    const beforeAdaptiveTables = gateway.tableReadBatchCount;
    const adaptiveReport = await service.pollingSupervisor.runOnce();
    expect(adaptiveReport.mode).toBe("adaptive");
    expect(adaptiveReport.safetyFullScan).toBe(false);
    expect(adaptiveReport.fullMetadataTables).toBe(0);
    expect(adaptiveReport.fastPathRowsScanned).toBe(1);
    expect(gateway.tableReadBatchCount).toBe(beforeAdaptiveTables + 1);
    expect(gateway.snapshotReadCount).toBe(beforeAdaptiveSnapshots);

    const coalescedReport = await service.pollingSupervisor.runOnce();
    expect(coalescedReport.mode).toBe("adaptive");
    expect(coalescedReport.safetyFullScan).toBe(false);
    expect(gateway.snapshotReadCount).toBe(beforeAdaptiveSnapshots);

    // After the full-scan interval elapses, the next pass is a safety full scan.
    await new Promise<void>((resolve) => setTimeout(resolve, 600));
    const beforeReScanSnapshots = gateway.snapshotReadCount;
    const reScanReport = await service.pollingSupervisor.runOnce();
    expect(reScanReport.mode).toBe("full");
    expect(reScanReport.safetyFullScan).toBe(true);
    expect(gateway.snapshotReadCount).toBe(beforeReScanSnapshots + 1);
  });

  it("automatically resolves a User_Input conflict to canonical state and audits it", async () => {
    const gateway = new FakeSyncSheetGateway([
      {
        physicalSheetId: SYSTEM_SHEET_ID,
        sheetName: "SyncServiceUsers_System",
        registeredRange: "A:C",
        projection: SYNC_GATEWAY_PROJECTIONS.SYSTEM_STATE,
        schemaVersion: 1,
        headers: ["id", "status", "__typed_sheets_deleted"],
      },
      {
        physicalSheetId: USER_INPUT_SHEET_ID,
        sheetName: "SyncServiceUsers_Input",
        registeredRange: "A:B",
        projection: SYNC_GATEWAY_PROJECTIONS.USER_INPUT,
        schemaVersion: 1,
        headers: ["id", "status"],
      },
      {
        physicalSheetId: CONFLICT_SHEET_ID,
        sheetName: "SyncServiceUsers_Conflicts",
        registeredRange: "A:O",
        projection: SYNC_GATEWAY_PROJECTIONS.SYNC_CONFLICTS,
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
      projections: {
        spreadsheetId: "sync-service-spreadsheet",
        entities: {
          SyncServiceUser: {
            systemState: { tabName: "SyncServiceUsers_System", registeredRange: "A:C" },
            syncConflicts: { tabName: "SyncServiceUsers_Conflicts", registeredRange: "A:O" },
            userInput: { tabName: "SyncServiceUsers_Input", registeredRange: "A:B" },
            userOwnedFields: ["id", "status"],
          },
        },
      },
      gateway,
      provisioner: new RecordingProvisioner(),
      pollingIntervalMs: 3_600_000,
      effectIdleIntervalMs: 3_600_000,
    });
    services.push(service);

    const em = service.hikoutei.em.fork();
    em.persist(em.create(User, { id: "conflict-user", status: "canonical" }));
    await em.flush();
    await service.effectSupervisor.runOnce();
    await service.pollingSupervisor.runOnce();

    const inputSnapshot = await gateway.readSnapshot({
      physicalSheetId: USER_INPUT_SHEET_ID,
      sheetName: "SyncServiceUsers_Input",
      registeredRange: "A:B",
      projection: SYNC_GATEWAY_PROJECTIONS.USER_INPUT,
      schemaVersion: 1,
    });
    const anchor = inputSnapshot.rows[0]?.physicalAnchor;
    if (anchor?.kind !== "present") throw new Error("expected a User_Input row anchor");
    gateway.mutateRow(USER_INPUT_SHEET_ID, anchor.value, {
      id: { kind: "string", value: "conflict-user" },
      status: { kind: "string", value: "human-edit" },
    });
    const updateManager = service.hikoutei.em.fork();
    const updateUser = await updateManager.findOne(User, { id: "conflict-user" });
    if (updateUser === null) throw new Error("expected conflict test entity");
    updateUser.status = "server-update";
    await updateManager.flush();

    // Simulate a remote predecessor that is still in flight when the conflict
    // is observed. Automatic system-wins must leave a durable pending command,
    // not rely on the caller remembering to invoke the resolver again.
    const predecessor = await service.storage.read(({ sql }) => sql.get<{ readonly effect_id: string }>(
      "SELECT effect_id FROM sheet_effect_outbox WHERE projection = ? ORDER BY stream_sequence DESC LIMIT 1",
      [SYNC_GATEWAY_PROJECTIONS.USER_INPUT],
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

    const report = await service.pollingSupervisor.runOnce();
    expect(report.conflictRows).toBe(1);
    await expect(service.storage.read(({ sql }) => sql.get<{ readonly status: string }>(
      "SELECT status FROM resolution_command WHERE target_conflict_id = (SELECT conflict_id FROM sync_conflict LIMIT 1)",
    ))).resolves.toEqual({ status: "pending" });

    // Once the predecessor is settled, the next polling pass must consume the
    // durable OPEN conflict and apply the same system-wins CAS command.
    // The predecessor has now recovered with a verified candidate guard
    // mismatch. It is settled, but it must not be marked applied because the
    // fake remote row still contains the human edit. This mirrors the real
    // worker transition and lets the resolver supersede the stale predecessor
    // with a fresh baseline from the observed Sheet value.
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
    expect(gateway.readRow(USER_INPUT_SHEET_ID, anchor.value).fields.status).toEqual({
      kind: "string",
      value: "server-update",
    });
    const conflictRows = gateway.readSnapshot({
      physicalSheetId: CONFLICT_SHEET_ID,
      sheetName: "SyncServiceUsers_Conflicts",
      registeredRange: "A:O",
      projection: SYNC_GATEWAY_PROJECTIONS.SYNC_CONFLICTS,
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
        }),
      })],
    });
  });

  it("reports inbound polling phases through the timing sink with empty operation counts", async () => {
    const gateway = new FakeSyncSheetGateway([
      {
        physicalSheetId: SYSTEM_SHEET_ID,
        sheetName: "SyncServiceUsers_System",
        registeredRange: "A:C",
        projection: SYNC_GATEWAY_PROJECTIONS.SYSTEM_STATE,
        schemaVersion: 1,
        headers: ["id", "status", "__typed_sheets_deleted"],
      },
      {
        physicalSheetId: USER_INPUT_SHEET_ID,
        sheetName: "SyncServiceUsers_Input",
        registeredRange: "A:B",
        projection: SYNC_GATEWAY_PROJECTIONS.USER_INPUT,
        schemaVersion: 1,
        headers: ["id", "status"],
      },
    ]);
    const pollingEvents: SyncTimingEvent[] = [];
    let resolveFirstTotal: (() => void) | undefined;
    const firstPollingTotal = new Promise<void>((resolve) => {
      resolveFirstTotal = resolve;
    });
    const service = await createInternalSyncService({
      dbName: ":memory:",
      entities: [User],
      projections: {
        spreadsheetId: "sync-service-spreadsheet",
        entities: {
          SyncServiceUser: {
            systemState: { tabName: "SyncServiceUsers_System", registeredRange: "A:C" },
            syncConflicts: { tabName: "SyncServiceUsers_Conflicts", registeredRange: "A:O" },
            userInput: { tabName: "SyncServiceUsers_Input", registeredRange: "A:B" },
            userOwnedFields: ["id", "status"],
          },
        },
      },
      gateway,
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
    const gateway = new FakeSyncSheetGateway([
      {
        physicalSheetId: SYSTEM_SHEET_ID,
        sheetName: "SyncServiceUsers_System",
        registeredRange: "A:C",
        projection: SYNC_GATEWAY_PROJECTIONS.SYSTEM_STATE,
        schemaVersion: 1,
        headers: ["id", "status", "__typed_sheets_deleted"],
      },
      {
        physicalSheetId: USER_INPUT_SHEET_ID,
        sheetName: "SyncServiceUsers_Input",
        registeredRange: "A:B",
        projection: SYNC_GATEWAY_PROJECTIONS.USER_INPUT,
        schemaVersion: 1,
        headers: ["id", "status"],
      },
    ]);
    const service = await createInternalSyncService({
      dbName: ":memory:",
      entities: [User],
      projections: {
        spreadsheetId: "sync-service-spreadsheet",
        entities: {
          SyncServiceUser: {
            systemState: { tabName: "SyncServiceUsers_System", registeredRange: "A:C" },
            syncConflicts: { tabName: "SyncServiceUsers_Conflicts", registeredRange: "A:O" },
            userInput: { tabName: "SyncServiceUsers_Input", registeredRange: "A:B" },
            userOwnedFields: ["id", "status"],
          },
        },
      },
      gateway,
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
    // Polling still reached the gateway, proving the throwing sink did not
    // short-circuit the canonical read or the values-only observation.
    expect(gateway.tableReadBatchCount + gateway.snapshotReadCount).toBeGreaterThan(0);
  });

  it("reports zero safety-scan lag on adaptive passes inside the full-scan interval", async () => {
    const gateway = buildPollingGateway();
    let nowMs = 1_000_000;
    const pollingEvents: SyncTimingEvent[] = [];
    let resolveFirstReport: ((report: MappedUserInputPollingReport) => void) | undefined;
    const firstReport = new Promise<MappedUserInputPollingReport>((resolve) => {
      resolveFirstReport = resolve;
    });
    const service = await createInternalSyncService({
      dbName: ":memory:",
      entities: [User],
      projections: pollingProjections,
      gateway,
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
    const gateway = buildPollingGateway();
    let nowMs = 1_000_000;
    const pollingEvents: SyncTimingEvent[] = [];
    let resolveFirstReport: ((report: MappedUserInputPollingReport) => void) | undefined;
    const firstReport = new Promise<MappedUserInputPollingReport>((resolve) => {
      resolveFirstReport = resolve;
    });
    const service = await createInternalSyncService({
      dbName: ":memory:",
      entities: [User],
      projections: pollingProjections,
      gateway,
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
    const gateway = buildPollingGateway();
    let nowMs = 1_000_000;
    const pollingEvents: SyncTimingEvent[] = [];
    let resolveFirstReport: ((report: MappedUserInputPollingReport) => void) | undefined;
    const firstReport = new Promise<MappedUserInputPollingReport>((resolve) => {
      resolveFirstReport = resolve;
    });
    const service = await createInternalSyncService({
      dbName: ":memory:",
      entities: [User],
      projections: pollingProjections,
      gateway,
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
    gateway.failSnapshotReads(new Error("safety scan snapshot read failed"));
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
    gateway.clearSnapshotReadFailure();
    const recoveryReport = await service.pollingSupervisor.runOnce();
    expect(recoveryReport.mode).toBe("full");
    expect(recoveryReport.safetyFullScan).toBe(true);
  });
});
