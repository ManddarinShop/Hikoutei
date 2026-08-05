import { describe, expect, it } from "vitest";

import { PRESENCE_KINDS } from "../src/shared/state/index.js";
import {
  SyncEffectWorkerSupervisor,
} from "../src/application/sync/outbound/effects/SyncEffectSupervisor.js";
import type { SyncEffectWorkerReport } from "../src/application/sync/outbound/effects/SyncEffectWorker.js";
import type { ReconciliationScanReport } from "../src/application/sync/outbound/reconciliation/ReconciliationScanner.js";

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

  it("drains an externally triggered pass before stop resolves", async () => {
    let resolvePass!: (report: SyncEffectWorkerReport) => void;
    const pendingPass = new Promise<SyncEffectWorkerReport>((resolve) => {
      resolvePass = resolve;
    });
    const supervisor = new SyncEffectWorkerSupervisor({ runPass: () => pendingPass });
    const pass = supervisor.runOnce();
    await Promise.resolve();

    let stopped = false;
    const stopping = supervisor.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    resolvePass(createReport());
    await expect(pass).resolves.toEqual(createReport());
    await stopping;
    expect(stopped).toBe(true);
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
        if (calls === 1) throw new Error("provider unavailable");
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
          throw new Error("reconciliation provider unavailable");
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

  it("backs off when a pass only requeues work without forward progress", async () => {
    // A response-loss / postcondition-unapplied loop: the pass claimed work
    // but only requeued it. The supervisor must back off so a struggling
    // remote is not retried in a tight immediate loop.
    let calls = 0;
    const waits: number[] = [];
    let stopPromise: Promise<void> | undefined;
    let supervisor!: SyncEffectWorkerSupervisor;
    supervisor = new SyncEffectWorkerSupervisor({
      runPass: async () => {
        calls += 1;
        return createReport({ selected: 1, claimed: 1, requeued: 1, deferred: 1 });
      },
      idleIntervalMs: 5_000,
      errorBackoffInitialMs: 1_000,
      errorBackoffMaxMs: 30_000,
      random: () => 0,
      wait: async (durationMs) => {
        waits.push(durationMs);
      },
      onReport: () => {
        if (calls >= 2) stopPromise = supervisor.stop();
      },
    });

    supervisor.start();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await stopPromise;

    expect(calls).toBe(2);
    // The first pass backed off using the error backoff (1s), not the idle
    // interval (5s), proving the loop did not continue immediately.
    expect(waits[0]).toBe(1_000);
    expect(waits.every((durationMs) => durationMs !== 5_000)).toBe(true);
  });

  it("keeps draining immediately when a requeuing pass also applies work", async () => {
    // Forward progress (an applied effect) must not be penalized even when the
    // same pass requeued another effect: the drain loop continues without a
    // backoff or idle wait between passes.
    let calls = 0;
    const waits: number[] = [];
    let stopPromise: Promise<void> | undefined;
    let supervisor!: SyncEffectWorkerSupervisor;
    supervisor = new SyncEffectWorkerSupervisor({
      runPass: async () => {
        calls += 1;
        return createReport({ selected: 2, claimed: 2, applied: 1, requeued: 1, deferred: 1 });
      },
      idleIntervalMs: 5_000,
      errorBackoffInitialMs: 1_000,
      errorBackoffMaxMs: 30_000,
      random: () => 0,
      wait: async (durationMs) => {
        waits.push(durationMs);
      },
      onReport: () => {
        if (calls >= 2) stopPromise = supervisor.stop();
      },
    });

    supervisor.start();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await stopPromise;

    expect(calls).toBe(2);
    expect(waits).toEqual([]);
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
