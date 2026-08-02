import { afterEach, describe, expect, it } from "vitest";

import { defineTypedSheetsEntity } from "../src/index.js";
import {
  createInternalSyncService,
  type InternalSyncService,
} from "../src/application/sync/service/SyncServiceBootstrap.js";
import type {
  SyncGatewayProvisioner,
  SyncGatewayProvisionRoute,
} from "../src/application/sync/gateway/SyncGatewayBootstrap.js";
import {
  SYNC_GATEWAY_PROJECTIONS,
} from "../src/application/sync/gateway/constants.js";
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

class RecordingProvisioner implements SyncGatewayProvisioner {
  readonly calls: Array<readonly string[]> = [];

  async provisionRegistry(registrations: readonly SyncGatewayProvisionRoute[]) {
    this.calls.push(registrations.map((registration) => registration.sheetName));
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

    expect(provisioner.calls).toEqual([["SyncServiceUsers_System", "SyncServiceUsers_Input"]]);

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

    await service.pollingSupervisor.runOnce();

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
});
