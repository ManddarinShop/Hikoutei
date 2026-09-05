/**
 * Worker concurrent-dispatch tests: the `maxConcurrentUnits` wave scheduler.
 *
 * The scheduler must (a) never overlap two units that share a route key,
 * (b) overlap route-disjoint units up to the cap, (c) preserve per-route
 * FIFO order, and (d) settle siblings even when one unit fails. All gates
 * are test-controlled deferreds, so no wall-clock timing is asserted.
 */

import { describe, expect, it } from "vitest";

import {
  appendPendingEffectsWithAdapter,
  runEffectWorkerWithAdapter,
  DispatchTransportError,
  WORKER_OPTIONS_ERROR_CODES,
  WorkerOptionsError,
  absentValue,
  type AdaptiveEffectBatchControllerLike,
  type ApplyOutcome,
  type Dispatcher,
  type DispatchRequest,
  type FastAppendOutcome,
  type NewEffect,
  type PendingEffect,
  type PostconditionOutcome,
  type Presence,
} from "../src/index.js";
import {
  claimTestFence,
  createKernelStore,
  newEffect,
} from "./support/kernelFixtures.js";
import type { NodeSqliteTestAdapter } from "./support/nodeSqliteAdapter.js";

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Deferred the test resolves by hand to release a gated remote call. */
function deferred(): { readonly promise: Promise<void>; readonly release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

type RemoteHandler = (request: DispatchRequest) => Promise<ApplyOutcome | FastAppendOutcome>;

interface ControllableOptions {
  readonly onApply?: RemoteHandler;
  readonly onFastAppend?: RemoteHandler;
  readonly routeKeyFor?: (effect: PendingEffect) => string;
  readonly fastAppendRouteKeyFor?: (effect: PendingEffect) => string;
  readonly dispatchPriorityFor?: (effect: PendingEffect) => number;
}

/**
 * Dispatcher double that records the interleaved start/end of every remote
 * call and lets the test hold each call open with a test-owned deferred.
 */
class ControllableDispatcher implements Dispatcher {
  /** Interleaved log: "start:<routeKey>" / "end:<routeKey>" in call order. */
  public readonly events: string[] = [];
  /** Effect IDs delivered to a remote call, in call order. */
  public readonly dispatchedEffectIds: string[] = [];
  public activeCalls = 0;
  public peakActiveCalls = 0;

  private readonly options: ControllableOptions;
  private startWaiters: Array<{ readonly count: number; readonly resolve: () => void }> = [];

  public constructor(options: ControllableOptions = {}) {
    this.options = options;
  }

  /** Resolves once at least `count` remote calls have STARTED. */
  public waitUntilStarted(count: number): Promise<void> {
    if (this.startedCount >= count) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.startWaiters.push({ count, resolve });
    });
  }

  private get startedCount(): number {
    return this.events.filter((event) => event.startsWith("start:")).length;
  }

  public routeKeyFor(effect: PendingEffect): string {
    return this.options.routeKeyFor?.(effect)
      ?? [effect.physical_sheet_id, effect.projection].join("\u0000");
  }

  public fastAppendRouteKeyFor(effect: PendingEffect): string {
    return this.options.fastAppendRouteKeyFor?.(effect) ?? this.routeKeyFor(effect);
  }

  public isFastAppendCandidate(effect: PendingEffect): boolean {
    return effect.expected_visible_revision === 0 &&
      effect.expected_visible_hash === "" &&
      effect.effect_kind === "system_projection" &&
      effect.projection === "system_state" &&
      effect.target_kind === "entity";
  }

  public dispatchPriorityFor(effect: PendingEffect): number {
    return this.options.dispatchPriorityFor?.(effect) ?? 0;
  }

  public payloadValidationError(_effect: PendingEffect): Presence<string> {
    return absentValue<string>();
  }

  public async apply(request: DispatchRequest): Promise<ApplyOutcome> {
    const outcome = await this.runRemote("apply", request);
    return outcome as ApplyOutcome;
  }

  public async fastAppend(request: DispatchRequest): Promise<FastAppendOutcome> {
    const outcome = await this.runRemote("fastAppend", request);
    return outcome as FastAppendOutcome;
  }

  public async readPostconditions(request: DispatchRequest): Promise<PostconditionOutcome> {
    return {
      results: request.effects.map((effect) => ({
        effectId: effect.effect_id,
        payloadHash: effect.payload_hash,
        postcondition: {
          disposition: "applied" as const,
          visibleRevision: 1,
          visibleHash: "visible-1",
          fieldHashes: {},
        },
      })),
    };
  }

  private async runRemote(kind: "apply" | "fastAppend", request: DispatchRequest): Promise<ApplyOutcome | FastAppendOutcome> {
    this.activeCalls += 1;
    this.peakActiveCalls = Math.max(this.peakActiveCalls, this.activeCalls);
    this.events.push(`start:${kind}:${request.routeKey}`);
    for (const effect of request.effects) this.dispatchedEffectIds.push(effect.effect_id);
    const ready = this.startWaiters.filter((waiter) => waiter.count <= this.startedCount);
    this.startWaiters = this.startWaiters.filter((waiter) => !ready.includes(waiter));
    for (const waiter of ready) waiter.resolve();
    try {
      const handler = kind === "apply" ? this.options.onApply : this.options.onFastAppend;
      if (handler !== undefined) return await handler(request);
      return {
        hasMore: false,
        results: request.effects.map((effect) => ({
          effectId: effect.effect_id,
          payloadHash: effect.payload_hash,
          status: "applied" as const,
          visibleRevision: 1,
          visibleHash: "visible-1",
          fieldHashes: {},
        })),
      };
    } finally {
      this.activeCalls -= 1;
      this.events.push(`end:${kind}:${request.routeKey}`);
    }
  }
}

/** Batch controller slice that forces a fixed per-route chunk limit. */
function chunkLimitController(limit: number): AdaptiveEffectBatchControllerLike {
  return {
    limitFor: () => limit,
    beginDispatch: () => limit,
    observe: () => undefined,
    waitForCoalescing: async () => 0,
    beginAppendDispatch: () => undefined,
    waitForAppendThrottle: async () => 0,
  };
}

function systemStateEffect(effectId: string, physicalSheetId: string): NewEffect {
  return newEffect({
    effectId,
    targetId: `entity-${effectId}`,
    physicalSheetId,
    expectedVisibleRevision: 1,
    expectedVisibleHash: "baseline-1",
  });
}

function appendEffect(effectId: string, physicalSheetId: string): NewEffect {
  return newEffect({
    effectId,
    targetId: `entity-${effectId}`,
    physicalSheetId,
  });
}

async function outboxStatus(adapter: NodeSqliteTestAdapter, effectId: string): Promise<string | undefined> {
  return adapter.read(async ({ sql }) => {
    const row = await sql.get<{ readonly status: string }>(
      "SELECT status FROM sheet_effect_outbox WHERE effect_id = ?",
      [effectId],
    );
    return row?.status;
  });
}

describe("effect worker concurrent dispatch", () => {
  it("runs units strictly sequentially by default (maxConcurrentUnits omitted)", async () => {
    const adapter = createKernelStore();
    const fence = await claimTestFence(adapter);
    await appendPendingEffectsWithAdapter(adapter, fence, [
      systemStateEffect("seq-a", "sheet-a"),
      systemStateEffect("seq-b", "sheet-b"),
    ]);
    const dispatcher = new ControllableDispatcher();
    const report = await runEffectWorkerWithAdapter({
      storage: adapter,
      dispatcher,
      workerId: "worker-1",
      now: 1_000,
      maxEffects: 5,
    });
    // No overlap is even observable: each unit's start/end pair fully
    // precedes the next unit's start.
    expect(dispatcher.events).toEqual([
      "start:apply:sheet-a\u0000system_state",
      "end:apply:sheet-a\u0000system_state",
      "start:apply:sheet-b\u0000system_state",
      "end:apply:sheet-b\u0000system_state",
    ]);
    expect(dispatcher.peakActiveCalls).toBe(1);
    expect(report.applied).toBe(2);
  });

  it("never overlaps two units on the SAME route (route-busy gate)", async () => {
    const adapter = createKernelStore();
    const fence = await claimTestFence(adapter);
    await appendPendingEffectsWithAdapter(adapter, fence, [
      systemStateEffect("same-1", "sheet-a"),
      systemStateEffect("same-2", "sheet-a"),
    ]);
    const first = deferred();
    const second = deferred();
    const gates = [first, second];
    let call = 0;
    const dispatcher = new ControllableDispatcher({
      // Chunk limit 1 splits the single route group into two units.
      onApply: async (request) => {
        const gate = gates[call++]!;
        await gate.promise;
        return {
          hasMore: false,
          results: request.effects.map((effect) => ({
            effectId: effect.effect_id,
            payloadHash: effect.payload_hash,
            status: "applied" as const,
            visibleRevision: 1,
            visibleHash: "visible-1",
            fieldHashes: {},
          })),
        };
      },
    });
    const pass = runEffectWorkerWithAdapter({
      storage: adapter,
      dispatcher,
      workerId: "worker-1",
      now: 1_000,
      maxEffects: 5,
      // Even with a generous cap, both units share the sheet-a route: the
      // second must wait for the first to release it.
      maxConcurrentUnits: 3,
      batchController: chunkLimitController(1),
    });
    await dispatcher.waitUntilStarted(1);
    await tick();
    await tick();
    // The second same-route unit has NOT started while the first is open.
    expect(dispatcher.events.filter((e) => e.startsWith("start:"))).toHaveLength(1);
    first.release();
    await dispatcher.waitUntilStarted(2);
    second.release();
    const report = await pass;
    expect(dispatcher.peakActiveCalls).toBe(1);
    expect(dispatcher.events).toEqual([
      "start:apply:sheet-a\u0000system_state",
      "end:apply:sheet-a\u0000system_state",
      "start:apply:sheet-a\u0000system_state",
      "end:apply:sheet-a\u0000system_state",
    ]);
    expect(report.applied).toBe(2);
    await expect(outboxStatus(adapter, "same-1")).resolves.toBe("applied");
    await expect(outboxStatus(adapter, "same-2")).resolves.toBe("applied");
  });

  it("holds a fast-append unit's PHYSICAL routes busy (provider-scoped group key union)", async () => {
    const adapter = createKernelStore();
    const fence = await claimTestFence(adapter);
    await appendPendingEffectsWithAdapter(adapter, fence, [
      appendEffect("fa-append", "sheet-a"),
      systemStateEffect("fa-regular", "sheet-a"),
    ]);
    const appendGate = deferred();
    const regularGate = deferred();
    let calls = 0;
    const dispatcher = new ControllableDispatcher({
      // Spreadsheet-wide provider batch key, distinct from the physical route.
      fastAppendRouteKeyFor: () => "provider-batch",
      onFastAppend: async (request) => {
        calls += 1;
        await appendGate.promise;
        return {
          hasMore: false,
          results: request.effects.map((effect) => ({
            effectId: effect.effect_id,
            status: "applied" as const,
            visibleRevision: 1,
            visibleHash: "visible-1",
            fieldHashes: {},
          })),
        };
      },
      onApply: async (request) => {
        calls += 1;
        await regularGate.promise;
        return {
          hasMore: false,
          results: request.effects.map((effect) => ({
            effectId: effect.effect_id,
            payloadHash: effect.payload_hash,
            status: "applied" as const,
            visibleRevision: 1,
            visibleHash: "visible-1",
            fieldHashes: {},
          })),
        };
      },
    });
    const pass = runEffectWorkerWithAdapter({
      storage: adapter,
      dispatcher,
      workerId: "worker-1",
      now: 1_000,
      maxEffects: 5,
      maxConcurrentUnits: 2,
    });
    await dispatcher.waitUntilStarted(1);
    await tick();
    await tick();
    // The regular unit targets the SAME physical tab the append writes: the
    // union key set keeps it locked out until the append settles.
    expect(calls).toBe(1);
    appendGate.release();
    await dispatcher.waitUntilStarted(2);
    regularGate.release();
    const report = await pass;
    expect(report.applied).toBe(2);
    expect(dispatcher.peakActiveCalls).toBe(1);
  });

  it("overlaps two route-disjoint units when the cap allows", async () => {
    const adapter = createKernelStore();
    const fence = await claimTestFence(adapter);
    await appendPendingEffectsWithAdapter(adapter, fence, [
      systemStateEffect("x-a", "sheet-a"),
      systemStateEffect("x-b", "sheet-b"),
    ]);
    // Barrier: each call completes only once BOTH remote calls have started.
    // A serialized scheduler can never satisfy it (the test would time out).
    let started = 0;
    let unblock!: () => void;
    const bothStarted = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const dispatcher = new ControllableDispatcher({
      onApply: async (request) => {
        started += 1;
        if (started === 2) unblock();
        await bothStarted;
        return {
          hasMore: false,
          results: request.effects.map((effect) => ({
            effectId: effect.effect_id,
            payloadHash: effect.payload_hash,
            status: "applied" as const,
            visibleRevision: 1,
            visibleHash: "visible-1",
            fieldHashes: {},
          })),
        };
      },
    });
    const report = await runEffectWorkerWithAdapter({
      storage: adapter,
      dispatcher,
      workerId: "worker-1",
      now: 1_000,
      maxEffects: 5,
      maxConcurrentUnits: 2,
    });
    expect(dispatcher.peakActiveCalls).toBe(2);
    // The two starts interleave before either end.
    expect(dispatcher.events.slice(0, 3)).toEqual([
      "start:apply:sheet-a\u0000system_state",
      "start:apply:sheet-b\u0000system_state",
      expect.stringMatching(/^end:apply:/),
    ]);
    expect(report.applied).toBe(2);
  });

  it("never exceeds maxConcurrentUnits active units", async () => {
    const adapter = createKernelStore();
    const fence = await claimTestFence(adapter);
    await appendPendingEffectsWithAdapter(adapter, fence, [
      systemStateEffect("cap-a", "sheet-a"),
      systemStateEffect("cap-b", "sheet-b"),
      systemStateEffect("cap-c", "sheet-c"),
    ]);
    const gates = [deferred(), deferred(), deferred()];
    let call = 0;
    const dispatcher = new ControllableDispatcher({
      onApply: async (request) => {
        await gates[call++]!.promise;
        return {
          hasMore: false,
          results: request.effects.map((effect) => ({
            effectId: effect.effect_id,
            payloadHash: effect.payload_hash,
            status: "applied" as const,
            visibleRevision: 1,
            visibleHash: "visible-1",
            fieldHashes: {},
          })),
        };
      },
    });
    const pass = runEffectWorkerWithAdapter({
      storage: adapter,
      dispatcher,
      workerId: "worker-1",
      now: 1_000,
      maxEffects: 5,
      maxConcurrentUnits: 2,
    });
    await dispatcher.waitUntilStarted(2);
    await tick();
    await tick();
    // The third route stays unlaunched while both slots are held.
    expect(dispatcher.events.filter((e) => e.startsWith("start:"))).toHaveLength(2);
    gates[0]!.release();
    await dispatcher.waitUntilStarted(3);
    gates[1]!.release();
    gates[2]!.release();
    const report = await pass;
    expect(dispatcher.peakActiveCalls).toBe(2);
    expect(report.applied).toBe(3);
  });

  it("settles a healthy sibling when another unit's dispatch fails", async () => {
    const adapter = createKernelStore();
    const fence = await claimTestFence(adapter);
    await appendPendingEffectsWithAdapter(adapter, fence, [
      systemStateEffect("iso-bad", "sheet-a"),
      systemStateEffect("iso-good", "sheet-b"),
    ]);
    const dispatcher = new ControllableDispatcher({
      onApply: async (request) => {
        if (request.routeKey.includes("sheet-a")) {
          // A verified provider refusal: closes this unit's effects through
          // the terminal failure path WITHOUT throwing out of the pass.
          throw new DispatchTransportError("explicit_remote_failure", "provider refused");
        }
        return {
          hasMore: false,
          results: request.effects.map((effect) => ({
            effectId: effect.effect_id,
            payloadHash: effect.payload_hash,
            status: "applied" as const,
            visibleRevision: 1,
            visibleHash: "visible-1",
            fieldHashes: {},
          })),
        };
      },
    });
    const report = await runEffectWorkerWithAdapter({
      storage: adapter,
      dispatcher,
      workerId: "worker-1",
      now: 1_000,
      maxEffects: 5,
      maxConcurrentUnits: 2,
    });
    // The failing unit settled internally; the pass completed and the report
    // aggregates BOTH units' outcomes.
    expect(report.failed).toBe(1);
    expect(report.applied).toBe(1);
    await expect(outboxStatus(adapter, "iso-bad")).resolves.toBe("failed");
    await expect(outboxStatus(adapter, "iso-good")).resolves.toBe("applied");
  });

  it("rethrows the first unit error only after siblings settle fully", async () => {
    const adapter = createKernelStore();
    const fence = await claimTestFence(adapter);
    await appendPendingEffectsWithAdapter(adapter, fence, [
      systemStateEffect("thr-bad", "sheet-a"),
      systemStateEffect("thr-good", "sheet-b"),
    ]);
    const siblingGate = deferred();
    const dispatcher = new ControllableDispatcher({
      onApply: async (request) => {
        // Only the sheet-b sibling reaches a remote call: it holds open
        // until the test releases it.
        await siblingGate.promise;
        return {
          hasMore: false,
          results: request.effects.map((effect) => ({
            effectId: effect.effect_id,
            payloadHash: effect.payload_hash,
            status: "applied" as const,
            visibleRevision: 1,
            visibleHash: "visible-1",
            fieldHashes: {},
          })),
        };
      },
    });
    // A storage/programming-level failure raised OUTSIDE the classified
    // remote boundary (`beginDispatch` runs before the dispatch try block):
    // this is the only kind of unit failure that throws out of the unit.
    const controller = chunkLimitController(300);
    controller.beginDispatch = (routeKey: string): number => {
      if (routeKey.includes("sheet-a")) throw new Error("injected unit-level failure");
      return 300;
    };
    const pass = runEffectWorkerWithAdapter({
      storage: adapter,
      dispatcher,
      workerId: "worker-1",
      now: 1_000,
      maxEffects: 5,
      maxConcurrentUnits: 2,
      batchController: controller,
    });
    await dispatcher.waitUntilStarted(1);
    siblingGate.release();
    await expect(pass).rejects.toThrow("injected unit-level failure");
    // The sibling's settlement was persisted even though the pass threw.
    await expect(outboxStatus(adapter, "thr-good")).resolves.toBe("applied");
    // The throwing unit's effect keeps its claim for the next pass's lease
    // sweep (fail-closed, like a mid-pass sequential throw).
    await expect(outboxStatus(adapter, "thr-bad")).resolves.toBe("processing");
  });

  it("launches by priority and preserves per-route FIFO order", async () => {
    const adapter = createKernelStore();
    const fence = await claimTestFence(adapter);
    await appendPendingEffectsWithAdapter(adapter, fence, [
      systemStateEffect("pri-low", "sheet-a"),
      systemStateEffect("pri-mid", "sheet-b"),
      systemStateEffect("pri-high", "sheet-c"),
    ]);
    const gates = [deferred(), deferred(), deferred()];
    let call = 0;
    const dispatcher = new ControllableDispatcher({
      dispatchPriorityFor: (effect) =>
        effect.effect_id === "pri-high" ? 0 : effect.effect_id === "pri-mid" ? 1 : 2,
      onApply: async (request) => {
        await gates[call++]!.promise;
        return {
          hasMore: false,
          results: request.effects.map((effect) => ({
            effectId: effect.effect_id,
            payloadHash: effect.payload_hash,
            status: "applied" as const,
            visibleRevision: 1,
            visibleHash: "visible-1",
            fieldHashes: {},
          })),
        };
      },
    });
    const pass = runEffectWorkerWithAdapter({
      storage: adapter,
      dispatcher,
      workerId: "worker-1",
      now: 1_000,
      maxEffects: 5,
      maxConcurrentUnits: 2,
    });
    await dispatcher.waitUntilStarted(2);
    // The two launched units are the two HIGHEST-priority routes; the
    // lowest-priority sheet-a unit waits for a freed slot.
    expect(dispatcher.events.slice(0, 2)).toEqual([
      "start:apply:sheet-c\u0000system_state",
      "start:apply:sheet-b\u0000system_state",
    ]);
    gates[0]!.release();
    await dispatcher.waitUntilStarted(3);
    gates[1]!.release();
    gates[2]!.release();
    await pass;

    // Per-route FIFO: with chunk limit 1 the route's units launch strictly
    // in queue order, predecessor fully settled before successor starts.
    const fifoAdapter = createKernelStore();
    const fifoFence = await claimTestFence(fifoAdapter, 1_000, "writer-fifo");
    await appendPendingEffectsWithAdapter(fifoAdapter, fifoFence, [
      systemStateEffect("fifo-1", "sheet-f"),
      systemStateEffect("fifo-2", "sheet-f"),
    ]);
    const fifoDispatcher = new ControllableDispatcher();
    const fifoReport = await runEffectWorkerWithAdapter({
      storage: fifoAdapter,
      dispatcher: fifoDispatcher,
      workerId: "worker-1",
      now: 1_000,
      maxEffects: 5,
      maxConcurrentUnits: 4,
      batchController: chunkLimitController(1),
    });
    expect(fifoDispatcher.events).toEqual([
      "start:apply:sheet-f\u0000system_state",
      "end:apply:sheet-f\u0000system_state",
      "start:apply:sheet-f\u0000system_state",
      "end:apply:sheet-f\u0000system_state",
    ]);
    expect(fifoReport.applied).toBe(2);
    await expect(outboxStatus(fifoAdapter, "fifo-1")).resolves.toBe("applied");
    await expect(outboxStatus(fifoAdapter, "fifo-2")).resolves.toBe("applied");
  });

  it("never dispatches one effect through two concurrent units", async () => {
    const adapter = createKernelStore();
    const fence = await claimTestFence(adapter);
    await appendPendingEffectsWithAdapter(adapter, fence, [
      appendEffect("dup-append-1", "sheet-a"),
      appendEffect("dup-append-2", "sheet-b"),
      systemStateEffect("dup-regular-1", "sheet-c"),
      systemStateEffect("dup-regular-2", "sheet-d"),
      systemStateEffect("dup-regular-3", "sheet-c"),
    ]);
    const dispatcher = new ControllableDispatcher({
      fastAppendRouteKeyFor: () => "provider-batch",
    });
    const report = await runEffectWorkerWithAdapter({
      storage: adapter,
      dispatcher,
      workerId: "worker-1",
      now: 1_000,
      maxEffects: 10,
      maxConcurrentUnits: 3,
      batchController: chunkLimitController(1),
    });
    // Claims happen strictly before the dispatch loop, so every claimed
    // effect appears in exactly one remote request even under concurrency.
    expect(dispatcher.dispatchedEffectIds).toHaveLength(report.claimed);
    expect(new Set(dispatcher.dispatchedEffectIds).size).toBe(report.claimed);
    expect(report.claimed).toBe(5);
    expect(report.applied).toBe(5);
  });

  it("rejects non-positive maxConcurrentUnits with a stable options error", async () => {
    const adapter = createKernelStore();
    const fence = await claimTestFence(adapter);
    await appendPendingEffectsWithAdapter(adapter, fence, [
      systemStateEffect("opt-a", "sheet-a"),
    ]);
    const dispatcher = new ControllableDispatcher();
    for (const value of [0, -1, 1.5, Number.NaN]) {
      const error = await runEffectWorkerWithAdapter({
        storage: adapter,
        dispatcher,
        workerId: "worker-1",
        now: 1_000,
        maxEffects: 5,
        maxConcurrentUnits: value,
      }).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(WorkerOptionsError);
      expect((error as WorkerOptionsError).code).toBe(
        WORKER_OPTIONS_ERROR_CODES.MAX_CONCURRENT_UNITS_POSITIVE_REQUIRED,
      );
    }
    expect(dispatcher.events).toEqual([]);
  });
});
