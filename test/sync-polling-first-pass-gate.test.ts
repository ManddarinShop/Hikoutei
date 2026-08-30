/**
 * Phase 3 tests: the first polling pass waits for the System_State drain.
 *
 * Covers the SyncPollingSupervisor first-pass gate mechanics (deferral,
 * exactly-once consultation, error retry, stop interruption, cadence after
 * the first pass) and the end-to-end service wiring: with in-flight
 * System_State work the auto-started polling loop performs NO remote reads
 * until the drain clears, the first pass after readiness is a safety full
 * scan, and stop() interrupts a pending gate promptly. A separate regression
 * proves the conflict-blocked follower no longer defers: after restart with
 * a conflict predecessor + pending follower, readiness is ready and the
 * first poll proceeds without manually releasing the wedge.
 *
 * Credential-free: the service runs over the in-memory StubSpreadsheet
 * transport with zero request pacing, and the seeded outbox is staged on a
 * temp SQLite file through the internal service itself.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { defineTypedSheetsEntity } from "../src/index.js";
import {
  createInternalSyncService,
  type InternalSyncService,
} from "@hikoutei/sync-engine/sync/service/SyncServiceBootstrap.js";
import { SyncPollingSupervisor } from "@hikoutei/sync-engine/sync/service/SyncPollingSupervisor.js";
import { readSystemStateDrainReadinessWithAdapter } from "@hikoutei/ikisaki";
import type { MappedUserInputPollingReport } from "@hikoutei/storage/persistence/providers/mikro-orm/observation/MikroOrmUserInputPolling.js";
import {
  StubSpreadsheet,
  StubSheetsTransport,
} from "./support/StubSheetsTransport.js";

const User = defineTypedSheetsEntity({
  name: "PollingGateUser",
  tableName: "polling_gate_users",
  properties: {
    id: { type: "string", primary: true },
    status: { type: "string" },
  },
});

const fullProjections = {
  spreadsheetId: "polling-gate-spreadsheet",
  entities: {
    PollingGateUser: {
      systemState: { tabName: "PollingGateUsers_System", registeredRange: "A:C" },
      syncConflicts: { tabName: "PollingGateUsers_Conflicts", registeredRange: "A:O" },
      userInput: { tabName: "PollingGateUsers_Input", registeredRange: "A:C" },
      userOwnedFields: ["id", "status"],
    },
  },
};

/** Yields through the macrotask queue so loop iterations can interleave. */
function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Fake clock + wait pair that advance together through waits and yield
 * through a macrotask, so a supervisor loop and the test loop interleave
 * fairly instead of starving each other in the microtask queue.
 */
function fakeClockAndWait(): {
  readonly clock: { value: number };
  readonly wait: (durationMs: number) => Promise<void>;
} {
  const clock = { value: 0 };
  return {
    clock,
    wait: async (durationMs: number) => {
      clock.value += durationMs;
      await tick();
    },
  };
}

describe("SyncPollingSupervisor first-pass gate", () => {
  it("defers the first pass until the gate resolves and never consults it again", async () => {
    const { clock, wait } = fakeClockAndWait();
    let gateCalls = 0;
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const passes: number[] = [];
    const supervisor = new SyncPollingSupervisor({
      runPass: async () => {
        passes.push(clock.value);
        return { pass: passes.length };
      },
      intervalMs: 1_000,
      wait,
      waitForFirstPass: async () => {
        gateCalls += 1;
        await gate;
      },
    });
    supervisor.start();

    // The loop reaches the gate and parks there: no pass runs while the
    // gate is pending, and the gate is consulted exactly once.
    await tick();
    expect(passes).toEqual([]);
    expect(gateCalls).toBe(1);
    expect(supervisor.isStopping()).toBe(false);

    // Releasing the gate lets the first pass run; subsequent passes follow
    // the interval cadence without ever consulting the gate again.
    releaseGate?.();
    while (passes.length < 3) await tick();
    expect(passes).toEqual([0, 1_000, 2_000]);
    expect(gateCalls).toBe(1);
    await supervisor.stop();
    expect(supervisor.isStopping()).toBe(true);
  });

  it("routes a throwing gate through the polling error path and retries without running a pass", async () => {
    const { clock, wait } = fakeClockAndWait();
    const errors: unknown[] = [];
    let gateOk = false;
    let gateAttempts = 0;
    const passes: number[] = [];
    const supervisor = new SyncPollingSupervisor({
      runPass: async () => {
        passes.push(clock.value);
        return { pass: passes.length };
      },
      intervalMs: 1_000,
      errorBackoffInitialMs: 1_000,
      wait,
      waitForFirstPass: async () => {
        gateAttempts += 1;
        if (!gateOk) throw new Error("gate exploded");
      },
      onError: (error: unknown) => errors.push(error),
    });
    supervisor.start();

    // The throwing gate keeps the first pass pending: the loop backs off
    // and retries the gate, never running the pass.
    while (gateAttempts < 2) await tick();
    expect(passes).toEqual([]);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.every((error) => (error as Error).message === "gate exploded")).toBe(true);

    gateOk = true;
    while (passes.length < 1) await tick();
    // The first pass runs only after the gate succeeds, at the clock
    // position reached by the two backoff waits (1 s + 2 s of virtual
    // time); it never ran while the gate was failing.
    expect(passes).toEqual([3_000]);
    expect(gateAttempts).toBeGreaterThanOrEqual(3);
    await supervisor.stop();
  });

  it("keeps manual runOnce() passes ungated", async () => {
    const { clock, wait } = fakeClockAndWait();
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const passes: number[] = [];
    const supervisor = new SyncPollingSupervisor({
      runPass: async () => {
        passes.push(clock.value);
        return { pass: passes.length };
      },
      intervalMs: 1_000,
      wait,
      waitForFirstPass: async () => {
        await gate;
      },
    });
    supervisor.start();
    await tick();
    expect(passes).toEqual([]);

    // Explicit caller-driven passes are not deferred by the loop gate.
    await supervisor.runOnce();
    expect(passes).toEqual([0]);
    releaseGate?.();
    while (passes.length < 2) await tick();
    await supervisor.stop();
  });

  it("stop() interrupts a pending first-pass gate", async () => {
    const { wait } = fakeClockAndWait();
    let supervisor: SyncPollingSupervisor<{ readonly pass: number }>;
    const passes: number[] = [];
    supervisor = new SyncPollingSupervisor({
      runPass: async () => {
        passes.push(1);
        return { pass: passes.length };
      },
      intervalMs: 1_000,
      wait,
      // A stop-aware gate: it parks until the supervisor stops.
      waitForFirstPass: async () => {
        while (!supervisor.isStopping()) await tick();
      },
    });
    supervisor.start();
    await tick();
    expect(passes).toEqual([]);

    // stop() must resolve promptly while the gate is pending (the gate
    // observes isStopping() and returns; the loop then exits).
    await supervisor.stop();
    expect(passes).toEqual([]);
  });
});

describe("internal sync service first polling pass readiness gate", () => {
  const services: InternalSyncService[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(
      services.splice(0).map((service) => service.close().catch(() => undefined)),
    );
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempDbName(label: string): string {
    const dir = mkdtempSync(join(tmpdir(), `hikoutei-poll-gate-${label}-`));
    tempDirs.push(dir);
    return join(dir, `${randomUUID()}.sqlite`);
  }

  /**
   * Opens a temp-file service, stops its supervisors, and queues a clean
   * System_State create + update stream for one entity. This is the shared
   * starting point of every seeded outbox; the caller then transforms the
   * queued rows and asserts the resulting readiness before a fresh session
   * reopens the same file.
   */
  async function seedQueuedEffects(options: {
    readonly dbName: string;
    readonly spreadsheet: StubSpreadsheet;
    readonly transport: StubSheetsTransport;
  }): Promise<InternalSyncService> {
    const service = await createInternalSyncService({
      dbName: options.dbName,
      entities: [User],
      projections: fullProjections,
      googleSheetsApi: { transport: options.transport, rateLimitIntervalMs: 0 },
      pollingIntervalMs: 3_600_000,
      effectIdleIntervalMs: 3_600_000,
      reconciliationIntervalMs: 3_600_000,
    });
    // Stop supervisors first so the flush's effects stay queued: the worker
    // must never drain the seeded outbox before it is shaped.
    await service.stop();
    const em = service.hikoutei.em.fork();
    em.persist(em.create(User, { id: "u1", status: "pending" }));
    await em.flush();
    const user = await em.findOne(User, { id: "u1" });
    if (user === null) throw new Error("expected the seeded entity");
    user.status = "updated";
    await em.flush();
    return service;
  }

  /**
   * Closes a seeded service, expiring writer leases so the next session on
   * the same file takes over immediately (the same deterministic restart
   * pattern as the sync auto-start restart tests).
   */
  async function finalizeSeed(service: InternalSyncService): Promise<void> {
    await service.storage.transaction(({ sql }) =>
      sql.run("UPDATE writer_lease SET lease_until = 0", []),
    );
    await service.hikoutei.close();
  }

  /**
   * Seeds a CONFLICT-BLOCKED System_State outbox (the restart regression
   * shape): the two lowest stream rows become terminal conflict heads and
   * a pending follower stays behind them. Under claimable-head readiness
   * the follower is NOT drain work (its predecessor is outside
   * applied/superseded), so the first polling pass must not defer: the
   * outbox reports READY immediately, even though no worker can ever claim
   * the stream until a later effect supersedes it.
   */
  async function seedConflictBlockedOutbox(options: {
    readonly dbName: string;
    readonly spreadsheet: StubSpreadsheet;
    readonly transport: StubSheetsTransport;
  }): Promise<void> {
    const service = await seedQueuedEffects(options);
    await service.storage.transaction(({ sql }) =>
      sql.run(
        `UPDATE sheet_effect_outbox SET status = 'conflict' WHERE effect_id IN (
          SELECT effect_id FROM sheet_effect_outbox WHERE status = 'pending'
          ORDER BY stream_sequence LIMIT 2
        )`,
        [],
      ),
    );
    const readiness = await readSystemStateDrainReadinessWithAdapter(service.storage);
    if (readiness.status !== "ready") {
      throw new Error("expected the conflict-blocked outbox to be ready, not draining");
    }
    await finalizeSeed(service);
  }

  /**
   * Seeds a GENUINELY draining System_State outbox for the gate-mechanics
   * tests: every queued System_State effect is left in flight
   * (delivery_uncertain with a far-future probe). In-flight work counts as
   * draining but is not claimable now, so the first polling pass defers
   * until the rows are released, deterministically and without any worker
   * traffic.
   */
  async function seedDrainingOutbox(options: {
    readonly dbName: string;
    readonly spreadsheet: StubSpreadsheet;
    readonly transport: StubSheetsTransport;
  }): Promise<void> {
    const service = await seedQueuedEffects(options);
    await service.storage.transaction(({ sql }) =>
      sql.run(
        `UPDATE sheet_effect_outbox
         SET status = 'delivery_uncertain', next_probe_at = ?, last_error_code = NULL
         WHERE status = 'pending'`,
        [Date.now() + 3_600_000],
      ),
    );
    const readiness = await readSystemStateDrainReadinessWithAdapter(service.storage);
    if (readiness.status !== "draining") {
      throw new Error("expected the in-flight outbox to be draining");
    }
    await finalizeSeed(service);
  }

  function openService(options: {
    readonly dbName: string;
    readonly spreadsheet: StubSpreadsheet;
    readonly transport: StubSheetsTransport;
    readonly onPollingReport?: (report: MappedUserInputPollingReport) => void;
  }): Promise<InternalSyncService> {
    return createInternalSyncService({
      dbName: options.dbName,
      entities: [User],
      projections: fullProjections,
      googleSheetsApi: { transport: options.transport, rateLimitIntervalMs: 0 },
      pollingIntervalMs: 3_600_000,
      effectIdleIntervalMs: 3_600_000,
      reconciliationIntervalMs: 3_600_000,
      ...(options.onPollingReport === undefined
        ? {}
        : { onPollingReport: options.onPollingReport }),
    });
  }

  it("performs no remote reads while the System_State drain is in flight, then starts with a full scan", async () => {
    const dbName = tempDbName("gate");
    const spreadsheet = new StubSpreadsheet();
    const transport = new StubSheetsTransport(spreadsheet);
    await seedDrainingOutbox({ dbName, spreadsheet, transport });

    let resolveFirstReport: ((report: MappedUserInputPollingReport) => void) | undefined;
    const firstReport = new Promise<MappedUserInputPollingReport>((resolve) => {
      resolveFirstReport = resolve;
    });
    const service = await openService({
      dbName,
      spreadsheet,
      transport,
      onPollingReport: (report) => {
        resolveFirstReport?.(report);
        resolveFirstReport = undefined;
      },
    });
    services.push(service);

    // The auto-started loop's FIRST pass is gated on the System_State drain
    // (SQLite-only polls): several gate ticks must produce zero remote reads.
    // The worker also cannot claim the in-flight rows (their probe is far in
    // the future), so the transport count is fully stable while the gate
    // waits.
    const readsAfterOpen = transport.getSpreadsheetCalls;
    await new Promise<void>((resolve) => setTimeout(resolve, 700));
    expect(transport.getSpreadsheetCalls).toBe(readsAfterOpen);

    // Release the in-flight rows: the next gate poll sees readiness and the
    // first polling pass runs as a safety full scan.
    await service.storage.transaction(({ sql }) =>
      sql.run(
        "UPDATE sheet_effect_outbox SET status = 'superseded' WHERE status IN ('pending', 'conflict', 'delivery_uncertain')",
        [],
      ),
    );
    const report = await firstReport;
    expect(report.safetyFullScan).toBe(true);
    expect(report.mode).toBe("full");
    expect(transport.getSpreadsheetCalls).toBeGreaterThan(readsAfterOpen);

    // After the first pass the gate is gone: a caller-driven pass inside
    // the full-scan interval is a normal adaptive pass.
    const adaptive = await service.pollingSupervisor.runOnce();
    expect(adaptive.mode).toBe("adaptive");
    expect(adaptive.safetyFullScan).toBe(false);
  });

  it("restart with a conflict predecessor and a pending follower is not stuck on the readiness gate", async () => {
    const dbName = tempDbName("restart");
    const spreadsheet = new StubSpreadsheet();
    const transport = new StubSheetsTransport(spreadsheet);
    await seedConflictBlockedOutbox({ dbName, spreadsheet, transport });

    let resolveFirstReport: ((report: MappedUserInputPollingReport) => void) | undefined;
    const firstReport = new Promise<MappedUserInputPollingReport>((resolve) => {
      resolveFirstReport = resolve;
    });
    const service = await openService({
      dbName,
      spreadsheet,
      transport,
      onPollingReport: (report) => {
        resolveFirstReport?.(report);
        resolveFirstReport = undefined;
      },
    });
    services.push(service);

    // The pending follower behind terminal conflict predecessors is NOT
    // claimable drain work: readiness must be ready immediately after the
    // restart, before any manual release of the wedge.
    await expect(readSystemStateDrainReadinessWithAdapter(service.storage)).resolves.toEqual({
      status: "ready",
    });

    // The first polling pass runs despite the wedge (which is never manually
    // released). Under the old "count every pending System_State effect"
    // query the conflict-blocked follower kept the gate draining forever;
    // claimable-head readiness lets the recovery-visible pass proceed.
    const report = await Promise.race([
      firstReport,
      new Promise<never>((_, reject) => {
        const handle = setTimeout(
          () => reject(new Error("first polling pass stayed stuck behind the conflict-blocked follower")),
          3_000,
        );
        handle.unref?.();
      }),
    ]);
    expect(report.safetyFullScan).toBe(true);
    expect(report.mode).toBe("full");

    // The wedge itself is untouched: the conflict heads and the pending
    // follower still occupy the stream (no worker claimed the follower).
    const statuses = await service.storage.read(({ sql }) =>
      sql.all<{ readonly status: string }>(
        "SELECT status FROM sheet_effect_outbox ORDER BY stream_sequence",
        [],
      ),
    );
    expect(statuses.map((row) => row.status)).toContain("conflict");
    expect(statuses.map((row) => row.status)).toContain("pending");
  });

  it("stop() interrupts the first-pass readiness wait promptly", async () => {
    const dbName = tempDbName("stop");
    const spreadsheet = new StubSpreadsheet();
    const transport = new StubSheetsTransport(spreadsheet);
    await seedDrainingOutbox({ dbName, spreadsheet, transport });

    const service = await openService({ dbName, spreadsheet, transport });
    services.push(service);

    // The gate polls SQLite every 250 ms and honors isStopping() between
    // polls, so a stop requested while the first pass is parked must
    // resolve within one poll tick — never waiting for the drain.
    const started = Date.now();
    await service.stop();
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});
