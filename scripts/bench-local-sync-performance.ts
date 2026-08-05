import { performance } from "node:perf_hooks";
import { defineTypedSheetsEntity } from "../src/index.ts";
import {
  createInternalSyncService,
  type InternalSyncService,
} from "../src/application/sync/service/SyncServiceBootstrap.ts";
import {
  StubSpreadsheet,
  StubSheetsTransport,
} from "../test/support/StubSheetsTransport.ts";

const User = defineTypedSheetsEntity({
  name: "PerfUser",
  tableName: "perf_users",
  properties: {
    id: { type: "string", primary: true },
    status: { type: "string" },
  },
});

const ROWS = 66;
const POLL_SAMPLES = 7;

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

function transport(): StubSheetsTransport {
  // Each service provisions its own spreadsheet from the EMPTY state so the
  // adaptive and full-scan services measure identical data shapes.
  return new StubSheetsTransport(new StubSpreadsheet());
}

async function seed(service: InternalSyncService, transport: StubSheetsTransport) {
  const em = service.hikoutei.em.fork();
  const users = [];
  for (let index = 0; index < ROWS; index += 1) {
    const user = em.create(User, { id: `u-${index}`, status: "pending" });
    users.push(user);
    em.persist(user);
  }
  await em.flush();
  const writesBefore = transport.batchUpdateCalls;
  for (let pass = 0; pass < 10; pass += 1) {
    const report = await service.effectSupervisor.runOnce();
    if (report.selected === 0 && report.claimed === 0) break;
  }
  return { em, users, writesBefore, writesAfter: transport.batchUpdateCalls };
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
  let adaptiveClock = 0;
  const adaptiveTransport = transport();
  const adaptiveService = await createInternalSyncService({
    dbName: ":memory:",
    entities: [User],
    projections: projections(),
    googleSheetsApi: {
      transport: adaptiveTransport,
      rateLimitIntervalMs: 0,
    },
    maxEffects: 200,
    pollingIntervalMs: 3_600_000,
    pollingFullScanIntervalMs: 3_600_000,
    effectIdleIntervalMs: 3_600_000,
    now: () => adaptiveClock,
  });

  let fullClock = 0;
  const fullTransport = transport();
  const fullService = await createInternalSyncService({
    dbName: ":memory:",
    entities: [User],
    projections: projections(),
    googleSheetsApi: {
      transport: fullTransport,
      rateLimitIntervalMs: 0,
    },
    maxEffects: 200,
    pollingIntervalMs: 3_600_000,
    pollingFullScanIntervalMs: 1,
    effectIdleIntervalMs: 3_600_000,
    now: () => fullClock,
  });

  try {
    const adaptiveSeed = await seed(adaptiveService, adaptiveTransport);
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

    const readsBeforeUpdate = adaptiveTransport.getSpreadsheetCalls;
    const flushStartedAt = performance.now();
    for (const user of adaptiveSeed.users) user.status = "approved";
    await adaptiveSeed.em.flush();
    const flushMs = performance.now() - flushStartedAt;
    const deliveryStartedAt = performance.now();
    const deliveryReport = await adaptiveService.effectSupervisor.runOnce();
    const deliveryMs = performance.now() - deliveryStartedAt;
    const applyEffectsWrites = adaptiveTransport.batchUpdateCalls - adaptiveSeed.writesAfter;
    const deliveryReads = adaptiveTransport.getSpreadsheetCalls - readsBeforeUpdate;

    const fullSeed = await seed(fullService, fullTransport);
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
        adaptiveProviderCalls: {
          getSpreadsheet: adaptiveTransport.getSpreadsheetCalls,
          batchUpdate: adaptiveTransport.batchUpdateCalls,
        },
        fullProviderCalls: {
          getSpreadsheet: fullTransport.getSpreadsheetCalls,
          batchUpdate: fullTransport.batchUpdateCalls,
        },
      },
      outboundUpdate: {
        rows: ROWS,
        sqliteFlushMs: Number(flushMs.toFixed(3)),
        deliveryMs: Number(deliveryMs.toFixed(3)),
        applied: deliveryReport.applied,
        applyEffectsWrites,
        deliveryReads,
      },
    }, null, 2));
  } finally {
    await Promise.all([adaptiveService.close(), fullService.close()]);
  }
}

await run();
