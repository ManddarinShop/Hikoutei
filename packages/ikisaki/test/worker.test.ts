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
  readonly dispatchPriorityFor?: (effect: PendingEffect) => number;
  readonly payloadValidationError?: (effect: PendingEffect) => Presence<string>;
  readonly routeKeyFor?: (effect: PendingEffect) => string;
  /**
   * Models the host-dispatcher contract: invoke the request's
   * `beforeRemoteDispatch` hook immediately before the canned remote result
   * and abort with a classified delivery-uncertain error when it fails.
   * Fakes that omit this option must keep working untouched.
   */
  readonly invokeBeforeRemote?: boolean;
}

class FakeDispatcher implements Dispatcher {
  public applyCalls = 0;
  public fastAppendCalls = 0;
  public probeCalls = 0;
  public readonly lastApplyRequests: DispatchRequest[] = [];
  public readonly lastFastAppendRequests: DispatchRequest[] = [];
  /** Interleaved remote-call log in dispatch order: bucket + request. */
  public readonly callLog: Array<{ readonly bucket: "apply" | "fastAppend"; readonly request: DispatchRequest }> = [];

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

  public dispatchPriorityFor(effect: PendingEffect): number {
    return this.options.dispatchPriorityFor?.(effect) ?? 0;
  }

  public payloadValidationError(effect: PendingEffect): Presence<string> {
    return this.options.payloadValidationError?.(effect) ?? absentValue();
  }

  public async apply(request: DispatchRequest): Promise<ApplyOutcome> {
    this.applyCalls += 1;
    this.lastApplyRequests.push(request);
    this.callLog.push({ bucket: "apply", request });
    await this.invokeBeforeRemoteOrThrow(request);
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
    this.callLog.push({ bucket: "fastAppend", request });
    await this.invokeBeforeRemoteOrThrow(request);
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
    await this.invokeBeforeRemoteOrThrow(request);
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

  private async invokeBeforeRemoteOrThrow(request: DispatchRequest): Promise<void> {
    if (this.options.invokeBeforeRemote !== true) return;
    const renewed = await request.beforeRemoteDispatch?.() ?? true;
    if (!renewed) {
      throw new DispatchTransportError(
        "delivery_uncertain",
        "effect lease could not be renewed before remote dispatch",
      );
    }
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

  it("renews the effect lease inside the before-remote hook before the provider result", async () => {
    const adapter = createKernelStore();
    const fence = await claimTestFence(adapter);
    const effect = regularEffect("before-remote-renewal");
    await appendPendingEffectsWithAdapter(adapter, fence, [effect]);

    let hookRenewed: boolean | undefined;
    let leaseUntilAtProviderCall: number | undefined;
    const dispatcher = new FakeDispatcher({
      apply: async (request) => {
        // Model the lane queue + limiter wait: time passes after the claim
        // and before the host's before-remote hook. The hook must renew the
        // lease from THIS instant (now = 1_000 + elapsed), so the lease
        // extends ~120s past a now well beyond the 1_000 claim baseline.
        await delay(200);
        hookRenewed = await request.beforeRemoteDispatch?.() ?? true;
        leaseUntilAtProviderCall = await readLeaseUntil(adapter, effect.effectId);
        return {
          hasMore: false,
          results: request.effects.map((pending) => ({
            effectId: pending.effect_id,
            payloadHash: pending.payload_hash,
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
    });

    expect(report).toMatchObject({ applied: 1, failed: 0 });
    expect(dispatcher.lastApplyRequests[0]!.beforeRemoteDispatch).toBeTypeOf("function");
    // The hook renewed the lease from the hook instant (~200ms past the
    // claim), not from the claim baseline: the lease must extend at least
    // 120s past the 1_000+200 worker clock. A renewal that happened only at
    // claim time would leave it near 121_000 and fail this bound.
    expect(hookRenewed).toBe(true);
    expect(leaseUntilAtProviderCall).toBeGreaterThan(121_100);
    await expect(outboxStatus(adapter, effect.effectId)).resolves.toBe("applied");
  });

  it("attaches the before-remote renewal to fast append and postcondition probe requests", async () => {
    const adapter = createKernelStore();
    const fence = await claimTestFence(adapter);
    const appendEffect = newEffect({ effectId: "append-hook", targetId: "entity-append-hook" });
    const regular = regularEffect("probe-hook");
    await appendPendingEffectsWithAdapter(adapter, fence, [appendEffect, regular]);

    let fastAppendHook: (() => Promise<boolean>) | undefined;
    let probeHook: (() => Promise<boolean>) | undefined;
    const dispatcher = new FakeDispatcher({
      invokeBeforeRemote: true,
      apply: async () => {
        throw new DispatchTransportError("delivery_uncertain", "response was lost");
      },
      fastAppend: async (request) => {
        fastAppendHook = request.beforeRemoteDispatch;
        return {
          hasMore: false,
          results: request.effects.map((pending) => ({
            effectId: pending.effect_id,
            status: "applied" as const,
            visibleRevision: 1,
            visibleHash: "visible-1",
            fieldHashes: {},
          })),
        };
      },
      readPostconditions: async (request) => {
        probeHook = request.beforeRemoteDispatch;
        return {
          results: request.effects.map((pending) => ({
            effectId: pending.effect_id,
            payloadHash: pending.payload_hash,
            postcondition: { disposition: "unapplied" as const },
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
      maxFastAppendCandidates: 1,
    });

    expect(report).toMatchObject({ applied: 1, failed: 0, requeued: 1, deferred: 1 });
    expect(dispatcher.fastAppendCalls).toBe(1);
    expect(dispatcher.probeCalls).toBe(1);
    expect(fastAppendHook).toBeTypeOf("function");
    expect(probeHook).toBeTypeOf("function");
  });

  it("recovers durably when the effect lease expires before the before-remote renewal", async () => {
    const adapter = createKernelStore();
    const fence = await claimTestFence(adapter);
    const effect = regularEffect("before-remote-expired");
    await appendPendingEffectsWithAdapter(adapter, fence, [effect]);

    let hookResult: boolean | undefined;
    let probeRequest: DispatchRequest | undefined;
    const dispatcher = new FakeDispatcher({
      apply: async (request) => {
        // The mutation lane can hold dispatch past the effect lease: wait past
        // the short lease, then run the host's before-remote hook. Renewal
        // must fail and the host must abort with a classified
        // delivery-uncertain error instead of sending a write.
        await delay(400);
        hookResult = await request.beforeRemoteDispatch?.() ?? true;
        expect(hookResult).toBe(false);
        throw new DispatchTransportError(
          "delivery_uncertain",
          "effect lease could not be renewed before remote dispatch",
        );
      },
      readPostconditions: async (request) => {
        probeRequest = request;
        return {
          results: request.effects.map((pending) => ({
            effectId: pending.effect_id,
            payloadHash: pending.payload_hash,
            postcondition: { disposition: "unapplied" as const },
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
      effectLeaseDurationMs: 100,
    });

    // No remote write happened: the expired lease was recovered to a due
    // delivery-uncertain probe instead of being applied or failed, and the
    // recovery probe request carries the same renewal protection.
    expect(hookResult).toBe(false);
    expect(report).toMatchObject({
      selected: 1,
      claimed: 1,
      applied: 0,
      failed: 0,
    });
    expect(probeRequest?.beforeRemoteDispatch).toBeTypeOf("function");
    await expect(outboxStatus(adapter, effect.effectId)).resolves.toBe("delivery_uncertain");
    await expect(outboxError(adapter, effect.effectId)).resolves.toMatchObject({
      status: "delivery_uncertain",
      last_error_code: "lease_expired_requires_postcondition",
    });
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

  it("probes receipts when a hasMore:false fast-append envelope misses an expected result", async () => {
    const adapter = createKernelStore();
    const fence = await claimTestFence(adapter);
    const reported = newEffect({ effectId: "append-reported", targetId: "entity-reported" });
    const missing = newEffect({ effectId: "append-missing", targetId: "entity-missing" });
    await appendPendingEffectsWithAdapter(adapter, fence, [reported, missing]);

    const dispatcher = new FakeDispatcher({
      fastAppend: async (request) => ({
        // Malformed/partial envelope: hasMore is false (the provider claims
        // the response is complete) but only one of the two expected result
        // ids is present. The worker must not redrive the missing row
        // without receipt/postcondition evidence.
        hasMore: false,
        results: request.effects
          .filter((pending) => pending.effect_id === reported.effectId)
          .map((pending) => ({
            effectId: pending.effect_id,
            status: "applied" as const,
            visibleRevision: 1,
            visibleHash: "visible-1",
            fieldHashes: {},
          })),
      }),
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
      maxFastAppendCandidates: 2,
    });

    // The missing result was settled from probed postcondition evidence, not
    // a blind requeue: no effect was redriven without a receipt.
    expect(report).toMatchObject({
      applied: 2,
      responseLossRecovered: 1,
      failed: 0,
      requeued: 0,
      deferred: 0,
    });
    expect(dispatcher.fastAppendCalls).toBe(1);
    expect(dispatcher.probeCalls).toBe(1);
    await expect(outboxStatus(adapter, reported.effectId)).resolves.toBe("applied");
    await expect(outboxStatus(adapter, missing.effectId)).resolves.toBe("applied");
  });

  it("releases an intentional hasMore fast-append suffix without probing or requeueing it", async () => {
    const adapter = createKernelStore();
    const fence = await claimTestFence(adapter);
    const first = newEffect({ effectId: "append-first", targetId: "entity-first" });
    const suffix = newEffect({ effectId: "append-suffix", targetId: "entity-suffix" });
    await appendPendingEffectsWithAdapter(adapter, fence, [first, suffix]);

    const dispatcher = new FakeDispatcher({
      fastAppend: async (request) => ({
        // The provider intentionally stopped before the supplied suffix:
        // hasMore proves the deferral, so the suffix is released for the
        // next pass, never probed and never requeued.
        hasMore: true,
        results: request.effects
          .filter((pending) => pending.effect_id === first.effectId)
          .map((pending) => ({
            effectId: pending.effect_id,
            status: "applied" as const,
            visibleRevision: 1,
            visibleHash: "visible-1",
            fieldHashes: {},
          })),
      }),
    });

    const report = await runEffectWorkerWithAdapter({
      storage: adapter,
      dispatcher,
      workerId: "worker-1",
      now: 1_000,
      maxEffects: 5,
      maxFastAppendCandidates: 2,
    });

    expect(report).toMatchObject({
      applied: 1,
      deferred: 1,
      requeued: 0,
      failed: 0,
    });
    expect(dispatcher.probeCalls).toBe(0);
    await expect(outboxStatus(adapter, first.effectId)).resolves.toBe("applied");
    await expect(outboxStatus(adapter, suffix.effectId)).resolves.toBe("pending");
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

  it("dispatches ready effects in ascending declared priority across both buckets", async () => {
    const adapter = createKernelStore();
    const fence = await claimTestFence(adapter);
    const sysAppend = newEffect({ effectId: "sys-append", targetId: "entity-sys-append" });
    const sysRegular = regularEffect("sys-regular");
    const conflictAppend = newEffect({
      effectId: "conflict-append",
      effectKind: "resolution_projection",
      projection: "sync_conflicts",
      targetKind: "conflict",
      targetId: "conflict-1",
      expectedVisibleRevision: 0,
      expectedVisibleHash: "",
    });
    const other = newEffect({
      effectId: "other-regular",
      effectKind: "user_input_delete",
      projection: "user_input",
      targetKind: "row_binding",
      targetId: "row-binding-1",
      expectedVisibleRevision: 1,
      expectedVisibleHash: "baseline-1",
    });
    await appendPendingEffectsWithAdapter(adapter, fence, [
      sysAppend,
      sysRegular,
      conflictAppend,
      other,
    ]);

    const dispatcher = new FakeDispatcher({
      isFastAppendCandidate: (effect) =>
        isAppendShaped(effect) ||
        (effect.projection === "sync_conflicts" &&
          effect.expected_visible_revision === 0 &&
          effect.expected_visible_hash === ""),
      dispatchPriorityFor: (effect) => {
        if (effect.projection === "system_state") {
          return isAppendShaped(effect) ? 0 : 1;
        }
        if (effect.projection === "sync_conflicts") return 2;
        return 3;
      },
    });

    const report = await runEffectWorkerWithAdapter({
      storage: adapter,
      dispatcher,
      workerId: "worker-1",
      now: 1_000,
      maxEffects: 10,
    });

    expect(report).toMatchObject({ selected: 4, claimed: 4, applied: 4 });
    // Expected interleaved order: System_State fast append, System_State
    // regular follower, Sync_Conflicts fast append, then the rest.
    expect(dispatcher.callLog.map((entry) => [entry.bucket, entry.request.routeKey])).toEqual([
      ["fastAppend", "physical-1\u0000system_state"],
      ["apply", "physical-1\u0000system_state"],
      ["fastAppend", "physical-1\u0000sync_conflicts"],
      ["apply", "physical-1\u0000user_input"],
    ]);
  });

  it("keeps the legacy fast-append-before-regular order when no priority is declared", async () => {
    const adapter = createKernelStore();
    const fence = await claimTestFence(adapter);
    const sysAppend = newEffect({ effectId: "sys-append-legacy", targetId: "entity-sys-append-legacy" });
    const sysRegular = regularEffect("sys-regular-legacy");
    const other = regularEffect("other-legacy");
    await appendPendingEffectsWithAdapter(adapter, fence, [
      sysAppend,
      sysRegular,
      other,
    ]);

    const dispatcher = new FakeDispatcher();
    const report = await runEffectWorkerWithAdapter({
      storage: adapter,
      dispatcher,
      workerId: "worker-1",
      now: 1_000,
      maxEffects: 10,
    });

    expect(report).toMatchObject({ selected: 3, claimed: 3, applied: 3 });
    // Without a declared priority every group is 0, so the legacy order is
    // preserved exactly: all fast appends before all regular effects (the
    // two regular effects share one route and arrive in one apply call).
    expect(dispatcher.callLog.map((entry) => entry.bucket)).toEqual([
      "fastAppend",
      "apply",
    ]);
    expect(dispatcher.callLog[1]!.request.effects.map((effect) => effect.effect_id).sort()).toEqual([
      "other-legacy",
      "sys-regular-legacy",
    ]);
  });

  it("never forces an unready predecessor ahead of priority work", async () => {
    const adapter = createKernelStore();
    const fence = await claimTestFence(adapter);
    // The System_State append is blocked by an UNCLAIMABLE predecessor on the
    // same target stream (an active conflict row). Priority work must not
    // bypass the durable predecessor guard: the append is never claimed, and
    // a ready unrelated effect still dispatches in the same pass.
    const blockedHead = newEffect({ effectId: "head-conflict", targetId: "entity-blocked" });
    const blockedAppend = newEffect({
      effectId: "blocked-append",
      targetId: "entity-blocked",
    });
    const readyOther = regularEffect("ready-other");
    await appendPendingEffectsWithAdapter(adapter, fence, [
      blockedHead,
      blockedAppend,
      readyOther,
    ]);
    await adapter.transaction(async ({ sql }) => {
      await sql.run(
        "UPDATE sheet_effect_outbox SET status = 'conflict' WHERE effect_id = ?",
        [blockedHead.effectId],
      );
    });

    const dispatcher = new FakeDispatcher({
      dispatchPriorityFor: () => 0,
    });
    const report = await runEffectWorkerWithAdapter({
      storage: adapter,
      dispatcher,
      workerId: "worker-1",
      now: 1_000,
      maxEffects: 10,
    });

    expect(report).toMatchObject({ selected: 1, claimed: 1, applied: 1 });
    expect(dispatcher.callLog).toHaveLength(1);
    expect(dispatcher.callLog[0]!.request.effects.map((effect) => effect.effect_id)).toEqual([
      "ready-other",
    ]);
    await expect(outboxStatus(adapter, "blocked-append")).resolves.toBe("pending");
  });
});

describe("reconciliation first-scan scheduling", () => {
  /**
   * Builds a fake clock + wait pair that advance together through waits.
   *
   * The fake wait advances the virtual clock AND yields through a macrotask
   * (`setImmediate`) so the supervisor loop and the test loop interleave
   * fairly. A microtask-only wait would let the supervisor loop (whose own
   * injected waits resolve in microtasks too) spin forever inside one
   * microtask drain without ever yielding to the test loop — the exact
   * starvation that made the first-scan scheduling tests hang.
   */
  function fakeClockAndWait(): {
    readonly clock: { value: number };
    readonly now: () => number;
    readonly wait: (durationMs: number) => Promise<void>;
    readonly waits: number[];
  } {
    const clock = { value: 0 };
    const waits: number[] = [];
    return {
      clock,
      now: () => clock.value,
      wait: async (durationMs: number) => {
        waits.push(durationMs);
        clock.value += durationMs;
        // Yield to the macrotask queue: the supervisor loop must be able to
        // run its own iterations (each ending in another fake wait) without
        // starving the test loop's `await wait(0)` continuations.
        await new Promise<void>((resolve) => setImmediate(resolve));
      },
      waits,
    };
  }

  interface SupervisorHarness {
    readonly scanCalls: number[];
    readonly gateCalls: number;
    readonly errors: unknown[];
    stop(): Promise<void>;
  }

  function startScanningSupervisor(options: {
    readonly clock: { value: number };
    readonly now: () => number;
    readonly wait: (durationMs: number) => Promise<void>;
    readonly initialReconciliationDelayMs?: number;
    readonly intervalMs?: number;
    readonly idleIntervalMs?: number;
    readonly gate?: () => Promise<boolean>;
  }): SupervisorHarness {
    const adapter = createKernelStore();
    const scanCalls: number[] = [];
    const errors: unknown[] = [];
    const gate = options.gate;
    let gateCalls = 0;
    const supervisor = createEffectWorkerSupervisor({
      storage: adapter,
      dispatcher: new FakeDispatcher(),
      workerId: "recon-worker",
      now: options.now,
      wait: options.wait,
      idleIntervalMs: options.idleIntervalMs ?? 1_000,
      reconciliation: {
        ...(options.initialReconciliationDelayMs === undefined
          ? {}
          : { initialReconciliationDelayMs: options.initialReconciliationDelayMs }),
        ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs }),
        ...(gate === undefined ? {} : {
          isFirstScanReady: async () => {
            gateCalls += 1;
            return gate();
          },
        }),
        run: async () => {
          scanCalls.push(options.now());
          return { effectsEnqueued: 0 };
        },
        onError: (error: unknown) => errors.push(error),
      },
    });
    supervisor.start();
    return {
      scanCalls,
      get gateCalls() {
        return gateCalls;
      },
      errors,
      stop: () => supervisor.stop(),
    };
  }

  it("delays the first scan by initialReconciliationDelayMs without changing the interval", async () => {
    const { clock, now, wait, waits } = fakeClockAndWait();
    const harness = startScanningSupervisor({
      clock,
      now,
      wait,
      initialReconciliationDelayMs: 10_000,
      intervalMs: 60_000,
    });
    // With an empty outbox each loop pass is idle and waits 1 s; the first
    // scan must NOT run before the 10 s initial delay elapses.
    while (clock.value < 9_000) await wait(0);
    expect(harness.scanCalls).toEqual([]);
    while (clock.value < 11_000) await wait(0);
    expect(harness.scanCalls).toEqual([10_000]);
    // The interval clock starts at the first scan, so the next scan is due
    // one full interval later, not immediately after the initial delay.
    // The scan runs at the START of the loop pass that crosses 70_000, so
    // the test waits for the scan itself: the virtual clock reaches 70_000
    // at the END of the previous pass's idle wait, one interleaving before
    // the scan executes.
    while (harness.scanCalls.length < 2) await wait(0);
    expect(harness.scanCalls).toEqual([10_000, 70_000]);
    expect(waits.length).toBeGreaterThan(0);
    await harness.stop();
  });

  it("defers the first scan while the gate is not ready without consuming the interval", async () => {
    const { clock, now, wait } = fakeClockAndWait();
    let ready = false;
    const harness = startScanningSupervisor({
      clock,
      now,
      wait,
      intervalMs: 60_000,
      gate: async () => ready,
    });
    // The gate is re-checked every idle pass (about 1 s each), and the scan
    // stays deferred while it returns false.
    while (clock.value < 5_000) await wait(0);
    expect(harness.scanCalls).toEqual([]);
    expect(harness.gateCalls).toBeGreaterThan(1);
    ready = true;
    // The deferred scan runs on the NEXT pass once the gate allows it.
    while (harness.scanCalls.length === 0) await wait(0);
    expect(harness.scanCalls).toHaveLength(1);
    await harness.stop();
  });

  it("consults the first-scan gate only for the FIRST scan, then keeps the interval schedule", async () => {
    const { clock, now, wait } = fakeClockAndWait();
    let gateValue = true;
    const harness = startScanningSupervisor({
      clock,
      now,
      wait,
      intervalMs: 5_000,
      gate: async () => gateValue,
    });
    // First scan runs immediately because the gate allows it.
    while (harness.scanCalls.length < 1) await wait(0);
    expect(harness.scanCalls).toEqual([0]);
    const gateCallsAfterFirstScan = harness.gateCalls;
    // The gate now refuses forever, but the interval schedule must keep
    // running busy-outbox scans exactly like the legacy supervisor: the
    // next scan is due one interval later and runs WITHOUT the gate.
    gateValue = false;
    while (clock.value <= 10_000) await wait(0);
    expect(harness.scanCalls).toEqual([0, 5_000, 10_000]);
    expect(harness.gateCalls).toBe(gateCallsAfterFirstScan);
    await harness.stop();
  });

  it("routes a throwing first-scan gate to the reconciliation error path and retries later", async () => {
    const { clock, now, wait } = fakeClockAndWait();
    let gateCalls = 0;
    const harness = startScanningSupervisor({
      clock,
      now,
      wait,
      intervalMs: 60_000,
      gate: async () => {
        gateCalls += 1;
        if (gateCalls === 1) throw new Error("gate exploded");
        return true;
      },
    });
    while (harness.errors.length === 0) await wait(0);
    expect(harness.errors.map((error) => (error as Error).message)).toEqual(["gate exploded"]);
    // The first scan stays pending after the gate error and runs once the
    // gate recovers.
    while (harness.scanCalls.length === 0) await wait(0);
    expect(harness.scanCalls).toHaveLength(1);
    await harness.stop();
  });

  it("rejects a negative initial reconciliation delay", () => {
    const adapter = createKernelStore();
    expect(() => createEffectWorkerSupervisor({
      storage: adapter,
      dispatcher: new FakeDispatcher(),
      workerId: "recon-worker",
      reconciliation: {
        initialReconciliationDelayMs: -1,
        run: async () => ({ effectsEnqueued: 0 }),
      },
    })).toThrow("initial reconciliation delay must be a non-negative safe integer");
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

function readLeaseUntil(adapter: NodeSqliteTestAdapter, effectId: string): Promise<number | undefined> {
  return adapter.read(async ({ sql }) => {
    const row = await sql.get<{ readonly lease_until: number | null }>(
      "SELECT lease_until FROM sheet_effect_outbox WHERE effect_id = ?",
      [effectId],
    );
    return row?.lease_until ?? undefined;
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
