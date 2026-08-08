/**
 * Worker tests: the generic effect worker against the in-memory kernel store
 * and fake dispatchers.
 *
 * The worker is payload-opaque, so these tests drive it with dispatcher
 * doubles that classify effects from kernel fields only (expected revision /
 * effect kind) and return canned outcomes. Credential-free and fast.
 */

import { describe, expect, it } from "vitest";

import {
  AdaptiveEffectBatchController,
  appendPendingEffectsWithAdapter,
  claimEffectWithAdapter,
  createEffectWorkerSupervisor,
  DispatchTransportError,
  EFFECT_BATCH_LIMIT,
  markDeliveryUncertainWithAdapter,
  runEffectWorkerWithAdapter,
  type ApplyOutcome,
  type Dispatcher,
  type DispatchRequest,
  type FastAppendOutcome,
  type NewEffect,
  type PendingEffect,
  type PostconditionOutcome,
  type Presence,
  presentValue,
  absentValue,
  WORKER_ERROR_CODES,
  type WorkerReport,
} from "../src/index.js";
import {
  claimTestFence,
  createKernelStore,
  newEffect,
} from "./support/kernelFixtures.js";
import type { NodeSqliteTestAdapter } from "./support/nodeSqliteAdapter.js";

/** Fast-append classification that mirrors the kernel's SQL-visible shape. */
function isAppendShaped(effect: PendingEffect): boolean {
  return effect.expected_visible_revision === 0 &&
    effect.expected_visible_hash === "" &&
    effect.effect_kind === "system_projection" &&
    effect.projection === "system_state" &&
    effect.target_kind === "entity";
}

interface FakeDispatcherOptions {
  readonly apply?: (request: DispatchRequest) => Promise<ApplyOutcome>;
  readonly fastAppend?: (request: DispatchRequest) => Promise<FastAppendOutcome>;
  readonly readPostconditions?: (request: DispatchRequest) => Promise<PostconditionOutcome>;
  readonly isFastAppendCandidate?: (effect: PendingEffect) => boolean;
  readonly payloadValidationError?: (effect: PendingEffect) => Presence<string>;
  readonly routeKeyFor?: (effect: PendingEffect) => string;
}

class FakeDispatcher implements Dispatcher {
  public applyCalls = 0;
  public fastAppendCalls = 0;
  public probeCalls = 0;
  public readonly lastApplyRequests: DispatchRequest[] = [];
  public readonly lastFastAppendRequests: DispatchRequest[] = [];

  private readonly options: FakeDispatcherOptions;

  public constructor(options: FakeDispatcherOptions = {}) {
    this.options = options;
  }

  public routeKeyFor(effect: PendingEffect): string {
    return this.options.routeKeyFor?.(effect) ?? [effect.physical_sheet_id, effect.projection].join("\u0000");
  }

  public isFastAppendCandidate(effect: PendingEffect): boolean {
    return this.options.isFastAppendCandidate?.(effect) ?? isAppendShaped(effect);
  }

  public payloadValidationError(effect: PendingEffect): Presence<string> {
    return this.options.payloadValidationError?.(effect) ?? absentValue();
  }

  public async apply(request: DispatchRequest): Promise<ApplyOutcome> {
    this.applyCalls += 1;
    this.lastApplyRequests.push(request);
    if (this.options.apply !== undefined) return this.options.apply(request);
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
  }

  public async fastAppend(request: DispatchRequest): Promise<FastAppendOutcome> {
    this.fastAppendCalls += 1;
    this.lastFastAppendRequests.push(request);
    if (this.options.fastAppend !== undefined) return this.options.fastAppend(request);
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
  }

  public async readPostconditions(request: DispatchRequest): Promise<PostconditionOutcome> {
    this.probeCalls += 1;
    if (this.options.readPostconditions !== undefined) {
      return this.options.readPostconditions(request);
    }
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
}

describe("effect worker", () => {
  it("applies dispatcher-backed effects through one pass", async () => {
    const adapter = createKernelStore();
    const fence = await claimTestFence(adapter);
    const effects = [regularEffect("worker-a"), regularEffect("worker-b")];
    await appendPendingEffectsWithAdapter(adapter, fence, effects);

    const dispatcher = new FakeDispatcher();
    const report = await runEffectWorkerWithAdapter({
      storage: adapter,
      dispatcher,
      workerId: "worker-1",
      now: 1_000,
      maxEffects: 5,
    });

    expect(report).toMatchObject({
      selected: 2,
      claimed: 2,
      applied: 2,
      failed: 0,
      deferred: 0,
      requeued: 0,
      responseLossRecovered: 0,
    });
    expect(dispatcher.applyCalls).toBe(1);
    expect(dispatcher.fastAppendCalls).toBe(0);
    await expect(outboxStatus(adapter, "worker-a")).resolves.toBe("applied");
    await expect(outboxStatus(adapter, "worker-b")).resolves.toBe("applied");
  });

  it("probes a delivery-uncertain dispatch and requeues an unapplied read-back", async () => {
    const adapter = createKernelStore();
    const fence = await claimTestFence(adapter);
    const effect = regularEffect("uncertain-requeue");
    await appendPendingEffectsWithAdapter(adapter, fence, [effect]);

    const dispatcher = new FakeDispatcher({
      apply: async () => {
        throw new DispatchTransportError("delivery_uncertain", "response was lost");
      },
      readPostconditions: async (request) => ({
        results: request.effects.map((pending) => ({
          effectId: pending.effect_id,
          payloadHash: pending.payload_hash,
          postcondition: { disposition: "unapplied" as const },
        })),
      }),
    });

    const report = await runEffectWorkerWithAdapter({
      storage: adapter,
      dispatcher,
      workerId: "worker-1",
      now: 1_000,
      maxEffects: 5,
    });

    expect(report).toMatchObject({
      selected: 1,
      claimed: 1,
      applied: 0,
      failed: 0,
      deferred: 1,
      requeued: 1,
      responseLossRecovered: 0,
    });
    expect(dispatcher.probeCalls).toBe(1);
    await expect(outboxStatus(adapter, effect.effectId)).resolves.toBe("pending");
    await expect(outboxError(adapter, effect.effectId)).resolves.toMatchObject({
      last_error_code: WORKER_ERROR_CODES.POSTCONDITION_UNAPPLIED_REQUIRES_REDRIVE,
    });
  });

  it("recovers a lost response as applied after a postcondition probe", async () => {
    const adapter = createKernelStore();
    const fence = await claimTestFence(adapter);
    const effect = regularEffect("uncertain-applied");
    await appendPendingEffectsWithAdapter(adapter, fence, [effect]);

    const dispatcher = new FakeDispatcher({
      apply: async () => {
        throw new DispatchTransportError("delivery_uncertain", "response was lost");
      },
      readPostconditions: async (request) => ({
        results: request.effects.map((pending) => ({
          effectId: pending.effect_id,
          payloadHash: pending.payload_hash,
          postcondition: {
            disposition: "applied" as const,
            visibleRevision: 3,
            visibleHash: "visible-3",
            fieldHashes: {},
          },
        })),
      }),
    });

    const report = await runEffectWorkerWithAdapter({
      storage: adapter,
      dispatcher,
      workerId: "worker-1",
      now: 1_000,
      maxEffects: 5,
    });

    expect(report).toMatchObject({
      applied: 1,
      responseLossRecovered: 1,
      failed: 0,
      requeued: 0,
    });
    await expect(outboxStatus(adapter, effect.effectId)).resolves.toBe("applied");
  });

  it("marks delivery uncertain when the probe itself fails", async () => {
    const adapter = createKernelStore();
    const fence = await claimTestFence(adapter);
    const effect = regularEffect("uncertain-probe-failed");
    await appendPendingEffectsWithAdapter(adapter, fence, [effect]);

    const dispatcher = new FakeDispatcher({
      apply: async () => {
        throw new DispatchTransportError("delivery_uncertain", "response was lost");
      },
      readPostconditions: async () => {
        throw new Error("probe transport failed");
      },
    });

    const report = await runEffectWorkerWithAdapter({
      storage: adapter,
      dispatcher,
      workerId: "worker-1",
      now: 1_000,
      maxEffects: 5,
    });

    expect(report).toMatchObject({
      selected: 1,
      claimed: 1,
      applied: 0,
      deferred: 1,
      failed: 0,
    });
    await expect(outboxStatus(adapter, effect.effectId)).resolves.toBe("delivery_uncertain");
    await expect(outboxError(adapter, effect.effectId)).resolves.toMatchObject({
      last_error_code: WORKER_ERROR_CODES.POSTCONDITION_READ_FAILED,
      last_error_message: "probe transport failed",
    });
  });

  it("force-settles delivery_uncertain effects past the probe bound as failed", async () => {
    const adapter = createKernelStore();
    const fence = await claimTestFence(adapter);
    const effect = regularEffect("uncertain-timeout");
    await appendPendingEffectsWithAdapter(adapter, fence, [effect]);
    await claimEffectWithAdapter(adapter, {
      ...fence,
      effectId: effect.effectId,
      claimToken: "claim-1",
      leaseDurationMs: 30_000,
    });

    // Stage the effect as delivery_uncertain with an uncertainty window older
    // than the durable probe bound and a probe already due.
    const uncertainSince = 1_000;
    await markDeliveryUncertainWithAdapter(adapter, {
      ...fence,
      effectId: effect.effectId,
      claimToken: "claim-1",
      uncertainSince,
      nextProbeAt: uncertainSince + 1_000,
      lastErrorCode: WORKER_ERROR_CODES.POSTCONDITION_UNAVAILABLE,
      lastErrorMessage: "response lost",
    });

    const dispatcher = new FakeDispatcher({
      readPostconditions: async (request) => ({
        results: request.effects.map((pending) => ({
          effectId: pending.effect_id,
          payloadHash: pending.payload_hash,
          postcondition: { disposition: "unavailable" as const },
        })),
      }),
    });

    // now is 31s past uncertainty start: beyond the 30s durable probe bound.
    const report = await runEffectWorkerWithAdapter({
      storage: adapter,
      dispatcher,
      workerId: "worker-1",
      now: uncertainSince + 31_000,
      maxEffects: 5,
    });

    expect(report).toMatchObject({
      selected: 1,
      claimed: 1,
      applied: 0,
      failed: 1,
      deferred: 0,
      requeued: 0,
    });
    expect(dispatcher.probeCalls).toBe(1);
    await expect(outboxStatus(adapter, effect.effectId)).resolves.toBe("failed");
    await expect(outboxError(adapter, effect.effectId)).resolves.toMatchObject({
      status: "failed",
      last_error_code: WORKER_ERROR_CODES.DELIVERY_UNCERTAIN_TIMEOUT,
    });

    // A failed effect is terminal and no longer an in-flight predecessor, so
    // a later write on the same target stream is unblocked. This mirrors the
    // READ_PROCESSING_PREDECESSOR guard that #193 reported as stuck forever.
    const inFlight = await adapter.read(async ({ sql }) => {
      const rows = await sql.all<{ readonly effect_id: string }>(
        `SELECT effect_id FROM sheet_effect_outbox
         WHERE logical_sheet_id = ? AND target_kind = ? AND target_id = ?
           AND stream_sequence < ? AND status IN ('processing', 'delivery_uncertain')`,
        [effect.logicalSheetId, effect.targetKind, effect.targetId, effect.streamSequence + 1],
      );
      return rows.map((row) => row.effect_id);
    });
    expect(inFlight).toEqual([]);
  });

  it("keeps deferring delivery_uncertain effects within the probe bound", async () => {
    const adapter = createKernelStore();
    const fence = await claimTestFence(adapter);
    const effect = regularEffect("uncertain-defer");
    await appendPendingEffectsWithAdapter(adapter, fence, [effect]);
    await claimEffectWithAdapter(adapter, {
      ...fence,
      effectId: effect.effectId,
      claimToken: "claim-1",
      leaseDurationMs: 30_000,
    });

    const uncertainSince = 1_000;
    await markDeliveryUncertainWithAdapter(adapter, {
      ...fence,
      effectId: effect.effectId,
      claimToken: "claim-1",
      uncertainSince,
      nextProbeAt: uncertainSince + 1_000,
      lastErrorCode: WORKER_ERROR_CODES.POSTCONDITION_UNAVAILABLE,
      lastErrorMessage: "response lost",
    });

    const dispatcher = new FakeDispatcher({
      readPostconditions: async (request) => ({
        results: request.effects.map((pending) => ({
          effectId: pending.effect_id,
          payloadHash: pending.payload_hash,
          postcondition: { disposition: "unavailable" as const },
        })),
      }),
    });

    // now is 5s past uncertainty start: well within the 30s bound, so the
    // existing defer behavior is preserved.
    const report = await runEffectWorkerWithAdapter({
      storage: adapter,
      dispatcher,
      workerId: "worker-1",
      now: uncertainSince + 5_000,
      maxEffects: 5,
    });

    expect(report).toMatchObject({
      selected: 1,
      claimed: 1,
      applied: 0,
      failed: 0,
      deferred: 1,
      requeued: 0,
    });
    expect(dispatcher.probeCalls).toBe(1);
    await expect(outboxStatus(adapter, effect.effectId)).resolves.toBe("delivery_uncertain");
    await expect(outboxError(adapter, effect.effectId)).resolves.toMatchObject({
      status: "delivery_uncertain",
      last_error_code: WORKER_ERROR_CODES.POSTCONDITION_UNAVAILABLE,
    });
  });

  it("maps guard_mismatch to conflict or blocked_candidate by effect kind", async () => {
    const adapter = createKernelStore();
    const fence = await claimTestFence(adapter);
    const conflictEffect = regularEffect("guard-conflict");
    const blockedEffect = newEffect({
      effectId: "guard-blocked",
      targetId: "entity-guard-blocked",
      effectKind: "candidate_reconcile",
      expectedVisibleRevision: 1,
      expectedVisibleHash: "baseline-1",
    });
    await appendPendingEffectsWithAdapter(adapter, fence, [conflictEffect, blockedEffect]);

    const dispatcher = new FakeDispatcher({
      apply: async (request) => ({
        hasMore: false,
        results: request.effects.map((pending) => ({
          effectId: pending.effect_id,
          payloadHash: pending.payload_hash,
          status: "guard_mismatch" as const,
          reason: presentValue("remote state changed"),
        })),
      }),
    });

    const report = await runEffectWorkerWithAdapter({
      storage: adapter,
      dispatcher,
      workerId: "worker-1",
      now: 1_000,
      maxEffects: 5,
    });

    expect(report).toMatchObject({ conflicted: 1, blockedCandidate: 1, applied: 0, failed: 0 });
    await expect(outboxError(adapter, "guard-conflict")).resolves.toMatchObject({
      status: "conflict",
      last_error_code: WORKER_ERROR_CODES.VISIBLE_GUARD_MISMATCH,
    });
    await expect(outboxError(adapter, "guard-blocked")).resolves.toMatchObject({
      status: "blocked_candidate",
      last_error_code: WORKER_ERROR_CODES.CANDIDATE_GUARD_MISMATCH,
    });
  });

  it("selects fast-append candidates through the dedicated bulk window", async () => {
    const adapter = createKernelStore();
    const fence = await claimTestFence(adapter);
    const effects: NewEffect[] = [
      newEffect({ effectId: "append-1", targetId: "entity-append-1" }),
      newEffect({ effectId: "append-2", targetId: "entity-append-2" }),
      regularEffect("regular-1"),
      regularEffect("regular-2"),
      regularEffect("regular-3"),
    ];
    await appendPendingEffectsWithAdapter(adapter, fence, effects);

    const dispatcher = new FakeDispatcher();
    const report = await runEffectWorkerWithAdapter({
      storage: adapter,
      dispatcher,
      workerId: "worker-1",
      now: 1_000,
      maxEffects: 3,
      maxFastAppendCandidates: 2,
    });

    expect(report).toMatchObject({ selected: 5, claimed: 5, applied: 5, failed: 0 });
    expect(dispatcher.fastAppendCalls).toBe(1);
    expect(dispatcher.lastFastAppendRequests[0]!.effects.map((effect) => effect.effect_id))
      .toEqual(["append-1", "append-2"]);
    expect(dispatcher.applyCalls).toBe(1);
    expect(dispatcher.lastApplyRequests[0]!.effects.map((effect) => effect.effect_id))
      .toEqual(["regular-1", "regular-2", "regular-3"]);
  });

  it("fails an effect per-effect when the dispatcher candidate predicate throws", async () => {
    const adapter = createKernelStore();
    const fence = await claimTestFence(adapter);
    const effect = regularEffect("throwing-candidate");
    await appendPendingEffectsWithAdapter(adapter, fence, [effect]);

    const dispatcher = new FakeDispatcher({
      isFastAppendCandidate: () => {
        throw new Error("candidate classification failed");
      },
    });

    const report = await runEffectWorkerWithAdapter({
      storage: adapter,
      dispatcher,
      workerId: "worker-1",
      now: 1_000,
      maxEffects: 5,
    });

    // A throwing predicate must not abort the pass into supervisor backoff:
    // the effect is closed per-effect through the invalid-payload failure
    // path and is never left processing.
    expect(report).toMatchObject({
      selected: 1,
      claimed: 1,
      applied: 0,
      failed: 1,
      deferred: 0,
      requeued: 0,
    });
    expect(dispatcher.applyCalls).toBe(0);
    expect(dispatcher.fastAppendCalls).toBe(0);
    await expect(outboxError(adapter, effect.effectId)).resolves.toMatchObject({
      status: "failed",
      last_error_code: WORKER_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
    });
  });

  it("fails an effect per-effect when the dispatcher payload validation throws", async () => {
    const adapter = createKernelStore();
    const fence = await claimTestFence(adapter);
    const effect = regularEffect("throwing-validation");
    await appendPendingEffectsWithAdapter(adapter, fence, [effect]);

    const dispatcher = new FakeDispatcher({
      payloadValidationError: () => {
        throw new Error("payload validation failed");
      },
    });

    const report = await runEffectWorkerWithAdapter({
      storage: adapter,
      dispatcher,
      workerId: "worker-1",
      now: 1_000,
      maxEffects: 5,
    });

    // A throwing validation predicate must not abort the pass into supervisor
    // backoff: the claimed effect is closed per-effect through the
    // invalid-payload failure path and is never left processing.
    expect(report).toMatchObject({
      selected: 1,
      claimed: 1,
      applied: 0,
      failed: 1,
      deferred: 0,
      requeued: 0,
    });
    expect(dispatcher.applyCalls).toBe(0);
    expect(dispatcher.fastAppendCalls).toBe(0);
    await expect(outboxError(adapter, effect.effectId)).resolves.toMatchObject({
      status: "failed",
      last_error_code: WORKER_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
    });
  });

  it("fails the affected route bucket when the dispatcher route predicate throws", async () => {
    const adapter = createKernelStore();
    const fence = await claimTestFence(adapter);
    const effects = [
      regularEffect("route-throw-a"),
      regularEffect("route-throw-b"),
      regularEffect("route-throw-c"),
    ];
    await appendPendingEffectsWithAdapter(adapter, fence, effects);

    const dispatcher = new FakeDispatcher({
      routeKeyFor: () => {
        throw new Error("route classification failed");
      },
    });

    const report = await runEffectWorkerWithAdapter({
      storage: adapter,
      dispatcher,
      workerId: "worker-1",
      now: 1_000,
      maxEffects: 5,
    });

    // The route predicate degrades at bucket level: every item in the affected
    // bucket is closed per-effect through the invalid-payload failure path and
    // the whole bucket is skipped, so the pass completes without dispatch and
    // without aborting into supervisor backoff.
    expect(report).toMatchObject({
      selected: 3,
      claimed: 3,
      applied: 0,
      failed: 3,
      deferred: 0,
      requeued: 0,
    });
    expect(dispatcher.applyCalls).toBe(0);
    expect(dispatcher.fastAppendCalls).toBe(0);
    for (const effect of effects) {
      await expect(outboxError(adapter, effect.effectId)).resolves.toMatchObject({
        status: "failed",
        last_error_code: WORKER_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
      });
    }
  });

  it("rejects lease configurations without the request-timeout headroom", async () => {
    const adapter = createKernelStore();
    const dispatcher = new FakeDispatcher();
    await expect(runEffectWorkerWithAdapter({
      storage: adapter,
      dispatcher,
      workerId: "worker-1",
      now: 1_000,
      maxEffects: 1,
      effectLeaseDurationMs: 120_000,
      requestTimeoutMs: 120_000,
    })).rejects.toThrow("effectLeaseDurationMs must exceed requestTimeoutMs by 30 seconds");
  });

  it("supervisor runs one pass and stops", async () => {
    const adapter = createKernelStore();
    const fence = await claimTestFence(adapter);
    await appendPendingEffectsWithAdapter(adapter, fence, [regularEffect("supervised-1")]);

    const dispatcher = new FakeDispatcher();
    const supervisor = createEffectWorkerSupervisor({
      storage: adapter,
      dispatcher,
      workerId: "worker-1",
      now: () => 1_000,
    });

    const report: WorkerReport = await supervisor.runOnce();
    expect(report).toMatchObject({ selected: 1, claimed: 1, applied: 1 });
    expect(supervisor.isRunning()).toBe(false);
    await supervisor.stop();
    await expect(outboxStatus(adapter, "supervised-1")).resolves.toBe("applied");
  });
});

describe("adaptive batch controller", () => {
  it("throttles fast-append request starts and adapts route limits", async () => {
    const controller = new AdaptiveEffectBatchController({
      appendDispatchIntervalMs: 50,
      coalesceWindowMs: 0,
    });

    expect(controller.limitFor("route-a")).toBe(10);
    controller.beginAppendDispatch(1_000);
    const waited = await controller.waitForAppendThrottle(1_020);
    expect(waited).toBeGreaterThanOrEqual(30);

    controller.observe("route-a", {
      durationMs: 100,
      responseSucceeded: false,
      responseLoss: true,
    });
    expect(controller.limitFor("route-a")).toBe(5);
    for (let index = 0; index < 3; index += 1) {
      controller.observe("route-a", { durationMs: 10, responseSucceeded: true, responseLoss: false });
    }
    expect(controller.limitFor("route-a")).toBe(10);
  });

  it("rejects invalid adaptive batch limit configurations", () => {
    expect(() => new AdaptiveEffectBatchController({ minimum: 20, maximum: 5 }))
      .toThrow("adaptive effect batch limits must satisfy minimum <= initial <= maximum");
    expect(() => new AdaptiveEffectBatchController({ initial: 0 }))
      .toThrow("adaptive initial must be a positive safe integer");
  });
});

function regularEffect(effectId: string): NewEffect {
  return newEffect({
    effectId,
    targetId: "entity-" + effectId,
    expectedVisibleRevision: 1,
    expectedVisibleHash: "baseline-1",
  });
}

function outboxStatus(adapter: NodeSqliteTestAdapter, effectId: string): Promise<string | undefined> {
  return adapter.read(async ({ sql }) => {
    const row = await sql.get<{ readonly status: string }>(
      "SELECT status FROM sheet_effect_outbox WHERE effect_id = ?",
      [effectId],
    );
    return row?.status;
  });
}

function outboxError(
  adapter: NodeSqliteTestAdapter,
  effectId: string,
): Promise<{ readonly status: string; readonly last_error_code: string | null; readonly last_error_message: string | null } | undefined> {
  return adapter.read(async ({ sql }) => {
    const row = await sql.get<{
      readonly status: string;
      readonly last_error_code: string | null;
      readonly last_error_message: string | null;
    }>(
      "SELECT status, last_error_code, last_error_message FROM sheet_effect_outbox WHERE effect_id = ?",
      [effectId],
    );
    return row ?? undefined;
  });
}
