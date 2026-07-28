import { describe, expect, it } from "vitest";

import { PRESENCE_KINDS } from "../src/core/index.js";
import {
  SyncEffectWorkerSupervisor,
} from "../src/runtime/effects/SyncEffectSupervisor.js";
import type { SyncEffectWorkerReport } from "../src/runtime/effects/SyncEffectWorker.js";
import type { ReconciliationScanReport } from "../src/runtime/operations/ReconciliationScanner.js";

describe("SyncEffectWorkerSupervisor", () => {
  it("coalesces concurrent manual and background passes", async () => {
    let calls = 0;
    let resolvePass!: (report: SyncEffectWorkerReport) => void;
    const pendingPass = new Promise<SyncEffectWorkerReport>((resolve) => {
      resolvePass = resolve;
    });
    const supervisor = new SyncEffectWorkerSupervisor({
      runPass: () => {
        calls += 1;
        return pendingPass;
      },
    });

    const first = supervisor.runOnce();
    const second = supervisor.runOnce();
    await Promise.resolve();

    expect(calls).toBe(1);
    resolvePass(createReport({ claimed: 1, applied: 1 }));
    await expect(Promise.all([first, second])).resolves.toEqual([
      createReport({ claimed: 1, applied: 1 }),
      createReport({ claimed: 1, applied: 1 }),
    ]);
  });

  it("continues bounded passes until the outbox reports idle", async () => {
    let calls = 0;
    let stopPromise: Promise<void> | undefined;
    let supervisor!: SyncEffectWorkerSupervisor;
    supervisor = new SyncEffectWorkerSupervisor({
      runPass: async () => {
        calls += 1;
        return calls === 1 ? createReport({ selected: 1, claimed: 1, applied: 1 }) : createReport();
      },
      wait: async () => {},
      onReport: (report) => {
        if (report.selected === 0) stopPromise = supervisor.stop();
      },
    });

    supervisor.start();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await stopPromise;

    expect(calls).toBe(2);
    expect(supervisor.isRunning()).toBe(false);
  });

  it("backs off after a pass error and retries the pass", async () => {
    let calls = 0;
    const waits: number[] = [];
    const errors: unknown[] = [];
    let stopPromise: Promise<void> | undefined;
    let supervisor!: SyncEffectWorkerSupervisor;
    supervisor = new SyncEffectWorkerSupervisor({
      runPass: async () => {
        calls += 1;
        if (calls === 1) throw new Error("gateway unavailable");
        return createReport();
      },
      wait: async (durationMs) => {
        waits.push(durationMs);
      },
      random: () => 0,
      onError: (error) => errors.push(error),
      onReport: () => {
        stopPromise = supervisor.stop();
      },
    });

    supervisor.start();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await stopPromise;

    expect(calls).toBe(2);
    expect(waits).toEqual([1_000]);
    expect(errors).toHaveLength(1);
  });

  it("runs reconciliation after the worker pass and drains discovered corrections", async () => {
    let workerCalls = 0;
    let reconciliationCalls = 0;
    let stopPromise: Promise<void> | undefined;
    let supervisor!: SyncEffectWorkerSupervisor;
    supervisor = new SyncEffectWorkerSupervisor({
      runPass: async () => {
        workerCalls += 1;
        return createReport({
          selected: workerCalls === 1 ? 0 : 1,
          claimed: workerCalls === 1 ? 0 : 1,
          applied: workerCalls === 1 ? 0 : 1,
        });
      },
      wait: async () => {},
      reconciliation: {
        intervalMs: 60_000,
        run: async () => {
          reconciliationCalls += 1;
          return createReconciliationReport({ effectsEnqueued: 1 });
        },
      },
      onReport: () => {
        if (workerCalls === 2) stopPromise = supervisor.stop();
      },
    });

    supervisor.start();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await stopPromise;

    expect(workerCalls).toBe(2);
    expect(reconciliationCalls).toBe(1);
    expect(supervisor.isRunning()).toBe(false);
  });

  it("isolates reconciliation errors and keeps the worker loop alive", async () => {
    let workerCalls = 0;
    let reconciliationCalls = 0;
    const reconciliationErrors: unknown[] = [];
    let stopPromise: Promise<void> | undefined;
    let supervisor!: SyncEffectWorkerSupervisor;
    supervisor = new SyncEffectWorkerSupervisor({
      runPass: async () => {
        workerCalls += 1;
        return createReport();
      },
      wait: async () => {},
      now: () => 10_000,
      reconciliation: {
        intervalMs: 60_000,
        run: async () => {
          reconciliationCalls += 1;
          throw new Error("reconciliation gateway unavailable");
        },
        onError: (error) => reconciliationErrors.push(error),
      },
      onReport: () => {
        if (workerCalls === 2) stopPromise = supervisor.stop();
      },
    });

    supervisor.start();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await stopPromise;

    expect(workerCalls).toBe(2);
    expect(reconciliationCalls).toBe(1);
    expect(reconciliationErrors).toHaveLength(1);
    expect(reconciliationErrors[0]).toBeInstanceOf(Error);
  });

  it("waits for the outbox to become idle before reconciliation", async () => {
    let workerCalls = 0;
    let reconciliationCalls = 0;
    let idleChecks = 0;
    let currentTime = 10_000;
    let stopPromise: Promise<void> | undefined;
    let supervisor!: SyncEffectWorkerSupervisor;
    supervisor = new SyncEffectWorkerSupervisor({
      runPass: async () => {
        workerCalls += 1;
        return createReport({
          selected: workerCalls === 1 ? 1 : 0,
          claimed: workerCalls === 1 ? 1 : 0,
        });
      },
      wait: async () => {
        currentTime += 1;
      },
      now: () => currentTime,
      reconciliation: {
        intervalMs: 1,
        isOutboxIdle: async () => {
          idleChecks += 1;
          return idleChecks > 1;
        },
        run: async () => {
          reconciliationCalls += 1;
          return createReconciliationReport();
        },
        onReport: () => {
          stopPromise = supervisor.stop();
        },
      },
    });

    supervisor.start();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await stopPromise;

    expect(workerCalls).toBe(3);
    expect(idleChecks).toBe(2);
    expect(reconciliationCalls).toBe(1);
  });
});

function createReport(overrides: Partial<SyncEffectWorkerReport> = {}): SyncEffectWorkerReport {
  return {
    lease: { kind: PRESENCE_KINDS.ABSENT },
    expiredLeasesRecovered: 0,
    selected: 0,
    claimed: 0,
    applied: 0,
    blockedCandidate: 0,
    superseded: 0,
    conflicted: 0,
    failed: 0,
    deferred: 0,
    requeued: 0,
    replanned: 0,
    responseLossRecovered: 0,
    ...overrides,
  };
}

function createReconciliationReport(
  overrides: Partial<ReconciliationScanReport> = {},
): ReconciliationScanReport {
  return {
    physicalSheetId: "physical-sheet",
    snapshotRowsScanned: 0,
    desiredRowsScanned: 0,
    matchedRows: 0,
    driftedRows: 0,
    missingRows: 0,
    extraRows: 0,
    effectsEnqueued: 0,
    fenceClaimed: false,
    ...overrides,
  };
}
