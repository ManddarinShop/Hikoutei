/**
 * Phase 4 tests: the internal System_State readiness controller.
 *
 * The controller is keyed to the internal/public runtime object through a
 * WeakMap, is registered by the sync bootstrap and unregistered on close,
 * reports only the CURRENT System_State drain readiness (never the
 * whole-outbox idle state), and returns ready immediately for runtimes
 * without a registered sync service (local-only mode or after close). It
 * is deliberately not exported from `src/index.ts`; these tests import it
 * from its internal module, exactly like the sync bootstrap does.
 */

import { afterEach, describe, expect, it } from "vitest";
import { defineEntity, p } from "@mikro-orm/sql";

import { createTypedSheets, defineTypedSheetsEntity } from "../src/index.js";
import {
  createInternalSyncService,
  type InternalSyncService,
} from "@hikoutei/sync-engine/sync/service/SyncServiceBootstrap.js";
import {
  readRuntimeSystemStateReadiness,
  registerSystemStateReadiness,
  unregisterSystemStateReadiness,
} from "@hikoutei/sync-engine/sync/service/systemStateReadiness.js";
import { readSystemStateDrainReadinessWithAdapter } from "@hikoutei/ikisaki";
import {
  StubSpreadsheet,
  StubSheetsTransport,
} from "./support/StubSheetsTransport.js";

const User = defineTypedSheetsEntity({
  name: "ReadinessUser",
  tableName: "readiness_users",
  properties: {
    id: { type: "string", primary: true },
    status: { type: "string" },
  },
});

/** MikroORM inspection entity for the raw-storage register/unregister test. */
const InspectionSchema = defineEntity({
  name: "ReadinessInspection",
  tableName: "__readiness_inspection",
  properties: { id: p.string().primary() },
});

const fullProjections = {
  spreadsheetId: "readiness-spreadsheet",
  entities: {
    ReadinessUser: {
      systemState: { tabName: "ReadinessUsers_System", registeredRange: "A:C" },
      syncConflicts: { tabName: "ReadinessUsers_Conflicts", registeredRange: "A:O" },
      userInput: { tabName: "ReadinessUsers_Input", registeredRange: "A:C" },
      userOwnedFields: ["id", "status"],
    },
  },
};

describe("System_State readiness controller", () => {
  const services: InternalSyncService[] = [];

  afterEach(async () => {
    await Promise.all(
      services.splice(0).map((service) => service.close().catch(() => undefined)),
    );
  });

  async function openService(): Promise<InternalSyncService> {
    const spreadsheet = new StubSpreadsheet();
    const transport = new StubSheetsTransport(spreadsheet);
    const service = await createInternalSyncService({
      dbName: ":memory:",
      entities: [User],
      projections: fullProjections,
      googleSheetsApi: { transport, rateLimitIntervalMs: 0 },
      pollingIntervalMs: 3_600_000,
      effectIdleIntervalMs: 3_600_000,
      reconciliationIntervalMs: 3_600_000,
    });
    services.push(service);
    return service;
  }

  /** Stops the supervisors and queues a create + update (pending effects). */
  async function queuePendingSystemStateEffects(
    service: InternalSyncService,
  ): Promise<void> {
    await service.stop();
    const em = service.hikoutei.em.fork();
    em.persist(em.create(User, { id: "u1", status: "pending" }));
    await em.flush();
    const user = await em.findOne(User, { id: "u1" });
    if (user === null) throw new Error("expected the seeded entity");
    user.status = "updated";
    await em.flush();
  }

  it("reports ready immediately for an unregistered local-only runtime", async () => {
    const hikoutei = await createTypedSheets({ dbName: ":memory:", entities: [User] });
    try {
      // Local-only runtimes never register a sync service: the controller
      // must report ready without touching any storage.
      await expect(readRuntimeSystemStateReadiness(hikoutei)).resolves.toEqual({
        status: "ready",
      });
    } finally {
      await hikoutei.close();
    }
    // After close the same runtime still reports ready (unregistered).
    await expect(readRuntimeSystemStateReadiness(hikoutei)).resolves.toEqual({
      status: "ready",
    });
  });

  it("reports draining while System_State effects are nonterminal and ready once terminal", async () => {
    const service = await openService();
    // The bootstrap registered the runtime; a clean outbox is ready.
    await expect(readRuntimeSystemStateReadiness(service.hikoutei)).resolves.toEqual({
      status: "ready",
    });

    // Queued System_State work makes the controller report draining, even
    // though the whole outbox also carries User_Input work.
    await queuePendingSystemStateEffects(service);
    await expect(readRuntimeSystemStateReadiness(service.hikoutei)).resolves.toEqual({
      status: "draining",
    });
    await expect(readSystemStateDrainReadinessWithAdapter(service.storage)).resolves.toEqual({
      status: "draining",
    });

    // Terminal lifecycle states never defer: failed/conflict rows must not
    // keep the barrier waiting (a stuck stream cannot stall convergence).
    await service.storage.transaction(({ sql }) =>
      sql.run(
        "UPDATE sheet_effect_outbox SET status = 'superseded' WHERE status = 'pending'",
        [],
      ),
    );
    await expect(readRuntimeSystemStateReadiness(service.hikoutei)).resolves.toEqual({
      status: "ready",
    });

    // Close unregisters the runtime: the same object reports ready again
    // without touching the closed storage.
    await service.hikoutei.close();
    await expect(readRuntimeSystemStateReadiness(service.hikoutei)).resolves.toEqual({
      status: "ready",
    });
  });

  it("reports ready (not draining) when a pending follower sits behind a conflict predecessor", async () => {
    const service = await openService();
    await queuePendingSystemStateEffects(service);
    // Wedge the stream: the two lowest rows become terminal conflict heads,
    // leaving a pending System_State follower behind them that no worker can
    // ever claim (the durable predecessor guard blocks it).
    await service.storage.transaction(({ sql }) =>
      sql.run(
        `UPDATE sheet_effect_outbox SET status = 'conflict' WHERE effect_id IN (
          SELECT effect_id FROM sheet_effect_outbox WHERE status = 'pending'
          ORDER BY stream_sequence LIMIT 2
        )`,
        [],
      ),
    );
    // The blocked follower is NOT claimable drain work: under claimable-head
    // readiness the controller must report ready, so the first polling pass
    // (and external convergence barriers) are never stuck behind the
    // conflict without a manual release.
    await expect(readRuntimeSystemStateReadiness(service.hikoutei)).resolves.toEqual({
      status: "ready",
    });
    await expect(readSystemStateDrainReadinessWithAdapter(service.storage)).resolves.toEqual({
      status: "ready",
    });
    // Releasing the heads makes the follower claimable again: readiness
    // flips back to draining, proving the query still tracks real drain work
    // and only the conflict-blocked follower stopped deferring it.
    await service.storage.transaction(({ sql }) =>
      sql.run(
        "UPDATE sheet_effect_outbox SET status = 'superseded' WHERE status = 'conflict'",
        [],
      ),
    );
    await expect(readRuntimeSystemStateReadiness(service.hikoutei)).resolves.toEqual({
      status: "draining",
    });
    await expect(readSystemStateDrainReadinessWithAdapter(service.storage)).resolves.toEqual({
      status: "draining",
    });
  });

  it("tracks runtimes independently through the WeakMap registry", async () => {
    const draining = await openService();
    const clean = await openService();
    await queuePendingSystemStateEffects(draining);

    await expect(readRuntimeSystemStateReadiness(draining.hikoutei)).resolves.toEqual({
      status: "draining",
    });
    await expect(readRuntimeSystemStateReadiness(clean.hikoutei)).resolves.toEqual({
      status: "ready",
    });

    // Closing one runtime never affects the other's registration.
    await draining.hikoutei.close();
    await expect(readRuntimeSystemStateReadiness(draining.hikoutei)).resolves.toEqual({
      status: "ready",
    });
    await expect(readRuntimeSystemStateReadiness(clean.hikoutei)).resolves.toEqual({
      status: "ready",
    });
  });

  it("exposes idempotent register/unregister for internal callers", async () => {
    const hikoutei = await createTypedSheets({ dbName: ":memory:", entities: [User] });
    try {
      const storage = await import(
        "@hikoutei/storage/persistence/providers/mikro-orm/storage/MikroOrmSqliteAdapter.js"
      );
      const opened = await storage.initializeMikroOrmSqliteAdapter({
        dbName: ":memory:",
        entities: [InspectionSchema],
      });
      // The sync bootstrap runs the full sync schema migration before
      // registering; mirror it so the outbox table exists for the read.
      const { migrateMikroOrmSqliteStorageSchema } = await import(
        "@hikoutei/storage/persistence/providers/mikro-orm/storage/MikroOrmSqliteSchema.js",
      );
      await migrateMikroOrmSqliteStorageSchema(opened);
      try {
        registerSystemStateReadiness(hikoutei, opened);
        registerSystemStateReadiness(hikoutei, opened);
        await expect(readRuntimeSystemStateReadiness(hikoutei)).resolves.toEqual({
          status: "ready",
        });
        unregisterSystemStateReadiness(hikoutei);
        unregisterSystemStateReadiness(hikoutei);
        await expect(readRuntimeSystemStateReadiness(hikoutei)).resolves.toEqual({
          status: "ready",
        });
      } finally {
        await opened.close(true);
      }
    } finally {
      await hikoutei.close();
    }
  });
});
