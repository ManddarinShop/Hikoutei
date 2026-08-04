import { performance } from "node:perf_hooks";
import { defineTypedSheetsEntity } from "../src/index.ts";
import {
  createInternalSyncService,
  type InternalSyncService,
} from "../src/application/sync/service/SyncServiceBootstrap.ts";
import type {
  SyncGatewayProvisioner,
  SyncGatewayProvisionRoute,
} from "../src/application/sync/gateway/SyncGatewayBootstrap.ts";
import { SYNC_GATEWAY_PROJECTIONS } from "../src/application/sync/gateway/constants.ts";
import { FakeSyncSheetGateway } from "../test/support/FakeSyncSheetGateway.ts";

const User = defineTypedSheetsEntity({
  name: "PerfUser",
  tableName: "perf_users",
  properties: {
    id: { type: "string", primary: true },
    status: { type: "string" },
  },
});

const SYSTEM_SHEET_ID = "entity:perf_users:system_state";
const USER_INPUT_SHEET_ID = "entity:perf_users:user_input";
const ROWS = 66;
const POLL_SAMPLES = 7;

class Provisioner implements SyncGatewayProvisioner {
  async provisionRegistry(registrations: readonly SyncGatewayProvisionRoute[]) {
    return {
      registrations: registrations.map(({ headers: _headers, ...registration }) => registration),
      createdSheets: registrations.map((registration) => registration.sheetName),
      initializedHeaders: registrations.map((registration) => registration.sheetName),
    };
  }
}

function gateway(): FakeSyncSheetGateway {
  return new FakeSyncSheetGateway([
    {
      physicalSheetId: SYSTEM_SHEET_ID,
      sheetName: "PerfUsers_System",
      registeredRange: "A:C",
      projection: SYNC_GATEWAY_PROJECTIONS.SYSTEM_STATE,
      schemaVersion: 1,
      headers: ["id", "status", "__typed_sheets_deleted"],
    },
    {
      physicalSheetId: USER_INPUT_SHEET_ID,
      sheetName: "PerfUsers_Input",
      registeredRange: "A:B",
      projection: SYNC_GATEWAY_PROJECTIONS.USER_INPUT,
      schemaVersion: 1,
      headers: ["id", "status"],
    },
  ]);
}

function projections() {
  return {
    spreadsheetId: "perf-spreadsheet",
    entities: {
      PerfUser: {
        systemState: { tabName: "PerfUsers_System", registeredRange: "A:C" },
        userInput: { tabName: "PerfUsers_Input", registeredRange: "A:B" },
        syncConflicts: { tabName: "PerfUsers_Conflicts", registeredRange: "A:O" },
        userOwnedFields: ["id", "status"],
      },
    },
  } as const;
}

async function seed(service: InternalSyncService) {
  const em = service.hikoutei.em.fork();
  const users = [];
  for (let index = 0; index < ROWS; index += 1) {
    const user = em.create(User, { id: `u-${index}`, status: "pending" });
    users.push(user);
    em.persist(user);
  }
  await em.flush();
  for (let pass = 0; pass < 10; pass += 1) {
    const report = await service.effectSupervisor.runOnce();
    if (report.selected === 0 && report.claimed === 0) break;
  }
  return { em, users };
}

function stats(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: values.length,
    minMs: Number(sorted[0]!.toFixed(3)),
    meanMs: Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3)),
    maxMs: Number(sorted.at(-1)!.toFixed(3)),
  };
}

async function run(): Promise<void> {
  const adaptiveGateway = gateway();
  let adaptiveClock = 0;
  const adaptiveService = await createInternalSyncService({
    dbName: ":memory:",
    entities: [User],
    projections: projections(),
    gateway: adaptiveGateway,
    provisioner: new Provisioner(),
    maxEffects: 200,
    pollingIntervalMs: 3_600_000,
    pollingFullScanIntervalMs: 3_600_000,
    effectIdleIntervalMs: 3_600_000,
    now: () => adaptiveClock,
  });

  const fullGateway = gateway();
  let fullClock = 0;
  const fullService = await createInternalSyncService({
    dbName: ":memory:",
    entities: [User],
    projections: projections(),
    gateway: fullGateway,
    provisioner: new Provisioner(),
    maxEffects: 200,
    pollingIntervalMs: 3_600_000,
    pollingFullScanIntervalMs: 1,
    effectIdleIntervalMs: 3_600_000,
    now: () => fullClock,
  });

  try {
    const adaptiveSeed = await seed(adaptiveService);
    await adaptiveService.pollingSupervisor.runOnce();
    const adaptiveSamples: number[] = [];
    for (let index = 0; index < POLL_SAMPLES; index += 1) {
      const startedAt = performance.now();
      const report = await adaptiveService.pollingSupervisor.runOnce();
      adaptiveSamples.push(performance.now() - startedAt);
      if (report.mode !== "adaptive" || report.fullMetadataTables !== 0) {
        throw new Error(`adaptive sample escalated unexpectedly: ${report.mode}/${report.fullMetadataTables}`);
      }
    }

    const callsBeforeUpdate = adaptiveGateway.applyEffectsCalls;
    const flushStartedAt = performance.now();
    for (const user of adaptiveSeed.users) user.status = "approved";
    await adaptiveSeed.em.flush();
    const flushMs = performance.now() - flushStartedAt;
    const deliveryStartedAt = performance.now();
    const deliveryReport = await adaptiveService.effectSupervisor.runOnce();
    const deliveryMs = performance.now() - deliveryStartedAt;

    const fullSeed = await seed(fullService);
    fullClock = 1_000;
    await fullService.pollingSupervisor.runOnce();
    const fullSamples: number[] = [];
    for (let index = 0; index < POLL_SAMPLES; index += 1) {
      fullClock += 1_000;
      const startedAt = performance.now();
      const report = await fullService.pollingSupervisor.runOnce();
      fullSamples.push(performance.now() - startedAt);
      if (report.mode !== "full") throw new Error(`full sample was ${report.mode}`);
    }

    console.log(JSON.stringify({
      kind: "local_synthetic_performance",
      date: new Date().toISOString(),
      branch: "perf/adaptive-sync-performance",
      environment: { node: process.version, platform: process.platform, arch: process.arch },
      dataset: { unchangedRows: ROWS, pollingSamples: POLL_SAMPLES, setupExcluded: true },
      polling: {
        adaptiveValuesOnly: stats(adaptiveSamples),
        fullMetadata: stats(fullSamples),
        adaptiveGatewayCalls: {
          valuesOnlyBatches: adaptiveGateway.tableReadBatchCount,
          fullSnapshots: adaptiveGateway.snapshotReadCount,
        },
        fullGatewayCalls: {
          valuesOnlyBatches: fullGateway.tableReadBatchCount,
          fullSnapshots: fullGateway.snapshotReadCount,
        },
      },
      outboundUpdate: {
        rows: ROWS,
        sqliteFlushMs: Number(flushMs.toFixed(3)),
        deliveryMs: Number(deliveryMs.toFixed(3)),
        applied: deliveryReport.applied,
        applyEffectsCalls: adaptiveGateway.applyEffectsCalls - callsBeforeUpdate,
      },
    }, null, 2));
  } finally {
    await Promise.all([adaptiveService.close(), fullService.close()]);
  }
}

await run();
