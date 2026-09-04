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
  EffectWorkerSupervisor,
  AdaptiveBatchOptionsError,
  DispatchTransportError,
  KernelInputError,
  SUPERVISOR_OPTIONS_ERROR_CODES,
  SupervisionOptionsError,
  WORKER_OPTIONS_ERROR_CODES,
  WorkerOptionsError,
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
  type PreparedDispatch,
  presentValue,
  absentValue,
  WORKER_ERROR_CODES,
  SYNC_EFFECT_RECOVERY_ERROR_CODES,
  type WorkerReport,
} from "../src/index.js";
import {
  claimTestFence,
  createKernelStore,
  newEffect,
  TEST_NOW,
  TEST_ROLE,
} from "./support/kernelFixtures.js";
import type { NodeSqliteTestAdapter } from "./support/nodeSqliteAdapter.js";
import type {
  SqlStorageAdapter,
  SqlStorageContext,
} from "../src/sql/sql.js";
import { chunkEffectGroups } from "../src/worker/dispatch/routing.js";
import { ProviderBatchLimitError } from "../src/worker/optionContracts.js";
import { requireSemanticString } from "../src/contract/identity.js";

/**
 * Wraps a kernel store so the FIRST result-persistence transaction after the
 * write succeeds throws, simulating a storage failure while persisting an
 * applied result. The write itself is a remote dispatcher call, so arming the
 * flag inside `applyPrepared` makes the next `transaction` (result
 * persistence) throw.
 */
class ThrowingResultPersistenceAdapter implements SqlStorageAdapter {
  public throwOnResultPersistence = false;
  constructor(private readonly inner: NodeSqliteTestAdapter) {}
  read<T>(operation: (context: SqlStorageContext) => Promise<T>): Promise<T> {
    return this.inner.read(operation);
  }
  async transaction<T>(operation: (context: SqlStorageContext) => Promise<T>): Promise<T> {
    if (this.throwOnResultPersistence) {
      throw new Error("injected result persistence failure");
    }
    return this.inner.transaction(operation);
  }
  close(): void {
    this.inner.close();
  }
}

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
  /** Spreadsheet-scoped fast-append grouping key; defaults to `routeKeyFor`. */
  readonly fastAppendRouteKeyFor?: (effect: PendingEffect) => string;
  /**
   * Optional split-dispatch stages. When both are supplied the worker routes
   * regular units through preflight + applyPrepared; when neither is supplied
   * it keeps the single legacy `apply` path. Supplying only one is invalid.
   */
  readonly preflight?: (request: DispatchRequest) => Promise<PreparedDispatch>;
  readonly applyPrepared?: (request: DispatchRequest, prepared: PreparedDispatch) => Promise<ApplyOutcome>;
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
  public preflightCalls = 0;
  public applyPreparedCalls = 0;
  public readonly lastApplyRequests: DispatchRequest[] = [];
  public readonly lastFastAppendRequests: DispatchRequest[] = [];
  /** Interleaved remote-call log in dispatch order: bucket + request. */
  public readonly callLog: Array<{ readonly bucket: "apply" | "fastAppend"; readonly request: DispatchRequest }> = [];
  /** Split-stage call log in dispatch order (only when split is enabled). */
  public readonly splitCallLog: Array<{ readonly phase: "preflight" | "applyPrepared"; readonly request: DispatchRequest }> = [];

  private readonly options: FakeDispatcherOptions;

  /**
   * Split-dispatch stages. Only defined when BOTH options are supplied; the
   * worker feature-detects the pair so an option-less fake keeps the legacy
   * single `apply` path (matching a host dispatcher that omits the methods).
   */
  public readonly preflight?: (request: DispatchRequest) => Promise<PreparedDispatch>;
  public readonly applyPrepared?: (request: DispatchRequest, prepared: PreparedDispatch) => Promise<ApplyOutcome>;

  public constructor(options: FakeDispatcherOptions = {}) {
    this.options = options;
    const split = options.preflight !== undefined && options.applyPrepared !== undefined;
    if (split) {
      this.preflight = this.preflightImpl;
      this.applyPrepared = this.applyPreparedImpl;
    }
  }

  private readonly preflightImpl = async (request: DispatchRequest): Promise<PreparedDispatch> => {
    this.preflightCalls += 1;
    this.splitCallLog.push({ phase: "preflight", request });
    return this.options.preflight!(request);
  };

  private readonly applyPreparedImpl = async (
    request: DispatchRequest,
    prepared: PreparedDispatch,
  ): Promise<ApplyOutcome> => {
    this.applyPreparedCalls += 1;
    this.splitCallLog.push({ phase: "applyPrepared", request });
    await this.invokeBeforeRemoteOrThrow(request);
    return this.options.applyPrepared!(request, prepared);
  };

  public routeKeyFor(effect: PendingEffect): string {
    return this.options.routeKeyFor?.(effect) ?? [effect.physical_sheet_id, effect.projection].join("\u0000");
  }

  public fastAppendRouteKeyFor(effect: PendingEffect): string {
    return this.options.fastAppendRouteKeyFor?.(effect) ?? this.routeKeyFor(effect);
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

  it("takes over a dead writer's stale-heartbeat lease within one pass (restart-stall fix)", async () => {
    const adapter = createKernelStore();
    // "Dead" writer: lease still nominally alive, heartbeat frozen in the past.
    const deadFence = await claimTestFence(adapter, 1_000, "dead-writer");
    await appendPendingEffectsWithAdapter(adapter, deadFence, [regularEffect("takeover-x")]);
    await adapter.read(({ sql }) =>
      sql.run("UPDATE writer_lease SET heartbeat_at = 0", []));

    const dispatcher = new FakeDispatcher();
    // now = 30_000: lease_until (61_000) is still in the FUTURE, but the
    // heartbeat (0) is far older than the 15_000 stale bound → takeable.
    const report = await runEffectWorkerWithAdapter({
      storage: adapter,
      dispatcher,
      writerRole: TEST_ROLE,
      workerId: "worker-2",
      now: 30_000,
      maxEffects: 5,
    });

    expect(report.leaseClaimFailureReason).toBeUndefined();
    expect(report.lease.kind).toBe("present");
    if (report.lease.kind !== "present") throw new Error("expected claim");
    expect(report.lease.value.writerEpoch).toBe(2);
    expect(report.claimed).toBe(1);
    expect(report.applied).toBe(1);
    await expect(outboxStatus(adapter, "takeover-x")).resolves.toBe("applied");
  });

  it("reports active_writer and claims nothing while a LIVE writer's lease and heartbeat are fresh", async () => {
    const adapter = createKernelStore();
    const liveFence = await claimTestFence(adapter, 1_000, "live-writer");
    await appendPendingEffectsWithAdapter(adapter, liveFence, [regularEffect("blocked-x")]);
    // Heartbeat fresh relative to the pass clock (now = 30_000, stale bound 15_000).
    await adapter.read(({ sql }) =>
      sql.run("UPDATE writer_lease SET heartbeat_at = ?", [29_000]));

    const dispatcher = new FakeDispatcher();
    const report = await runEffectWorkerWithAdapter({
      storage: adapter,
      dispatcher,
      writerRole: TEST_ROLE,
      workerId: "worker-2",
      now: 30_000,
      maxEffects: 5,
    });

    expect(report.lease.kind).toBe("absent");
    expect(report.leaseClaimFailureReason).toBe("active_writer");
    expect(report.claimed).toBe(0);
    expect(dispatcher.applyCalls).toBe(0);
    await expect(outboxStatus(adapter, "blocked-x")).resolves.toBe("pending");
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

  it("renews the writer lease inside the before-remote hook so a long queue cannot expire it", async () => {
    // The writer/authority renewal happens BEFORE the mutation lane is
    // acquired; the in-lane hook must ALSO renew the WRITER lease so a long
    // lane queue or limiter wait cannot expire it during remote work and
    // permit a stale mutation after a takeover.
    const adapter = createKernelStore();
    const fence = await claimTestFence(adapter);
    const effect = regularEffect("before-remote-writer-renewal");
    await appendPendingEffectsWithAdapter(adapter, fence, [effect]);

    let writerLeaseUntilAtHook: number | undefined;
    const dispatcher = new FakeDispatcher({
      apply: async (request) => {
        // Model a long mutation-lane queue: time passes after the claim and
        // before the host's before-remote hook. The hook must renew the
        // WRITER lease from THIS instant so a long queue cannot expire it
        // during remote work.
        await delay(200);
        const renewed = await request.beforeRemoteDispatch?.() ?? true;
        writerLeaseUntilAtHook = await readWriterLeaseUntil(adapter);
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
    // The in-lane hook renewed the writer lease from the hook instant
    // (~200ms past the claim), so the lease extends ~180s past the 1_000+200
    // worker clock. A renewal that happened only at claim time would leave it
    // near 181_000 and fail this bound.
    expect(writerLeaseUntilAtHook).toBeGreaterThan(181_100);
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
    await expect(outboxLastError(adapter, suffix.effectId)).resolves.toBe(
      WORKER_ERROR_CODES.PROVIDER_BATCH_DEFERRED,
    );
  });

  it("emits hasMore, requested, and acknowledged counts on fast-append timing", async () => {
    const adapter = createKernelStore();
    const fence = await claimTestFence(adapter);
    const first = newEffect({ effectId: "append-timing-first", targetId: "entity-first" });
    const suffix = newEffect({ effectId: "append-timing-suffix", targetId: "entity-suffix" });
    await appendPendingEffectsWithAdapter(adapter, fence, [first, suffix]);

    const dispatcher = new FakeDispatcher({
      fastAppend: async (request) => ({
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
    const timingEvents: Array<Record<string, unknown>> = [];
    await runEffectWorkerWithAdapter({
      storage: adapter,
      dispatcher,
      workerId: "worker-1",
      now: 1_000,
      maxEffects: 5,
      maxFastAppendCandidates: 2,
      onTiming: (event) => timingEvents.push(event as unknown as Record<string, unknown>),
    });

    const dispatchEvent = timingEvents.find((event) =>
      event.phase === "append_provider_dispatch" && event.scope === "worker");
    expect(dispatchEvent).toBeDefined();
    // Fast-append timing carries the same envelope fields as regular dispatch:
    // the provider's hasMore flag, the requested effect count, and the
    // acknowledged/result count.
    expect(dispatchEvent?.hasMore).toBe(true);
    expect(dispatchEvent?.responseSucceeded).toBe(true);
    expect(dispatchEvent?.requestedEffects).toBe(2);
    expect(dispatchEvent?.acknowledgedEffects).toBe(1);
    // Regression: the suffix released by the hasMore path must carry
    // the provider_batch_deferred error code in the persisted row.
    await expect(outboxLastError(adapter, suffix.effectId)).resolves.toBe(
      WORKER_ERROR_CODES.PROVIDER_BATCH_DEFERRED,
    );
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

  it("rejects invalid lease duration with the original message and error code", async () => {
    const adapter = createKernelStore();
    const dispatcher = new FakeDispatcher();
    try {
      await runEffectWorkerWithAdapter({
        storage: adapter,
        dispatcher,
        workerId: "worker-1",
        now: 1_000,
        maxEffects: 1,
        writerLeaseDurationMs: 0,
      });
      expect.fail("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkerOptionsError);
      expect((error as WorkerOptionsError).code).toBe(WORKER_OPTIONS_ERROR_CODES.LEASE_DURATION_POSITIVE_REQUIRED);
      expect((error as WorkerOptionsError).message).toBe("writerLeaseDurationMs must be a positive safe integer");
    }
  });

  it("throws WorkerOptionsError with code for invalid worker options", async () => {
    const adapter = createKernelStore();
    const dispatcher = new FakeDispatcher();
    try {
      await runEffectWorkerWithAdapter({
        storage: adapter,
        dispatcher,
        workerId: "",
        now: 1_000,
        maxEffects: 5,
      });
      expect.fail("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkerOptionsError);
      expect((error as WorkerOptionsError).code).toBe(WORKER_OPTIONS_ERROR_CODES.WORKER_ID_REQUIRED);
    }
  });

  it("throws KernelInputError with code for invalid semantic string", () => {
    try {
      requireSemanticString(123, "test field");
      expect.fail("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(KernelInputError);
      expect((error as KernelInputError).code).toBe("kernel_non_empty_string_required");
      expect((error as KernelInputError).message).toBe("test field must be a non-empty string");
    }
  });

  it("throws ProviderBatchLimitError with code when chunkEffectGroups receives a non-positive limit", () => {
    try {
      chunkEffectGroups(
        [{ routeKey: "r", items: [{ pending: {} as any, claimToken: "c", invalidPayloadError: { kind: "absent" } } as any] }],
        0,
      );
      expect.fail("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderBatchLimitError);
      expect((error as ProviderBatchLimitError).code).toBe("provider_batch_limit_positive_integer_required");
    }
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

  it("keeps mixed physical routes in ONE atomic fast-append call when the dispatcher declares spreadsheet-scoped append grouping", async () => {
    const adapter = createKernelStore();
    const fence = await claimTestFence(adapter);
    // Two fast-append effects on DIFFERENT physical routes of one spreadsheet
    // (system_state and sync_conflicts projections). The dispatcher declares a
    // spreadsheet-scoped fast-append grouping key, so the worker must send them
    // as ONE fast-append call (the provider commits the whole multi-route batch
    // atomically) instead of splitting per route.
    const sysAppend = newEffect({ effectId: "sys-append-atomic", targetId: "entity-atomic-a" });
    const conflictAppend = newEffect({
      effectId: "conflict-append-atomic",
      effectKind: "resolution_projection",
      projection: "sync_conflicts",
      targetKind: "conflict",
      targetId: "conflict-atomic",
      expectedVisibleRevision: 0,
      expectedVisibleHash: "",
    });
    await appendPendingEffectsWithAdapter(adapter, fence, [sysAppend, conflictAppend]);

    const dispatcher = new FakeDispatcher({
      isFastAppendCandidate: (effect) =>
        isAppendShaped(effect) ||
        (effect.projection === "sync_conflicts" &&
          effect.expected_visible_revision === 0 &&
          effect.expected_visible_hash === ""),
      // Spreadsheet-scoped append grouping: every append on this dispatcher's
      // single spreadsheet shares one grouping key.
      fastAppendRouteKeyFor: () => "spreadsheet-scope",
    });

    const report = await runEffectWorkerWithAdapter({
      storage: adapter,
      dispatcher,
      workerId: "worker-1",
      now: 1_000,
      maxEffects: 10,
    });

    expect(report).toMatchObject({ selected: 2, claimed: 2, applied: 2 });
    // ONE fast-append call carries BOTH mixed-route effects (atomic multi-route
    // batch), never a per-route split.
    expect(dispatcher.fastAppendCalls).toBe(1);
    expect(dispatcher.callLog.filter((entry) => entry.bucket === "fastAppend")).toHaveLength(1);
    const fastRequest = dispatcher.lastFastAppendRequests[0];
    expect(fastRequest).toBeDefined();
    expect(fastRequest?.effects.map((effect) => effect.effect_id).sort()).toEqual(
      [sysAppend.effectId, conflictAppend.effectId].sort(),
    );
  });

  it("does not partially commit when the single multi-route fast-append fails", async () => {
    const adapter = createKernelStore();
    const fence = await claimTestFence(adapter);
    const appA = newEffect({ effectId: "atomic-fail-a", targetId: "entity-atomic-fail-a" });
    const appB = newEffect({
      effectId: "atomic-fail-b",
      effectKind: "resolution_projection",
      projection: "sync_conflicts",
      targetKind: "conflict",
      targetId: "conflict-fail",
      expectedVisibleRevision: 0,
      expectedVisibleHash: "",
    });
    await appendPendingEffectsWithAdapter(adapter, fence, [appA, appB]);

    const dispatcher = new FakeDispatcher({
      isFastAppendCandidate: (effect) =>
        isAppendShaped(effect) ||
        (effect.projection === "sync_conflicts" &&
          effect.expected_visible_revision === 0 &&
          effect.expected_visible_hash === ""),
      fastAppendRouteKeyFor: () => "spreadsheet-scope",
      fastAppend: async () => {
        // The ONE atomic multi-route call is rejected as an explicit remote
        // failure, so the provider proved the whole batch was refused. The
        // worker must close EVERY mixed-route row identically (all failed)
        // and never mark one row applied while another is still unsettled.
        throw new DispatchTransportError("explicit_remote_failure", "remote fast append rejected");
      },
    });

    const report = await runEffectWorkerWithAdapter({
      storage: adapter,
      dispatcher,
      workerId: "worker-1",
      now: 1_000,
      maxEffects: 10,
    });

    // One call, and NO effect is applied: the whole atomic multi-route batch
    // was refused, so every mixed-route row closes together (no partial commit).
    expect(dispatcher.fastAppendCalls).toBe(1);
    expect(report).toMatchObject({ selected: 2, claimed: 2, applied: 0, failed: 2 });
    await expect(outboxStatus(adapter, appA.effectId)).resolves.toBe("failed");
    await expect(outboxStatus(adapter, appB.effectId)).resolves.toBe("failed");
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

  it("persists lease_recovered_requeue when a renewed item is released after mixed lease-renewal recovery", async () => {
    // Regression: worker.ts:280 mixed lease-renewal path must persist
    // LEASE_RECOVERED_REQUEUE, not PROVIDER_BATCH_DEFERRED.
    // The worker's beforeRemoteDispatch hook calls renewDispatchEffectLeases:
    // when some renewals fail and others succeed, the renewed items are
    // released with reason "lease_recovered" and the not-renewed items are
    // recovered through recoverExpiredLeases.  This test exercises that
    // actual worker path instead of calling releaseUnprocessedEffect directly.
    //
    // To trigger the mixed renewal path, we intercept the adapter's
    // transaction to expire effect-1's lease immediately after the worker
    // claims it (via claimEffect SQL), so that renewEffectLease fails for
    // effect-1 during beforeRemoteDispatch while effect-2's renewal succeeds.
    const adapter = createKernelStore();
    const fence = await claimTestFence(adapter);
    const effect1 = newEffect({ effectId: "lease-rr-1", targetId: "entity-lease-rr-1" });
    const effect2 = newEffect({ effectId: "lease-rr-2", targetId: "entity-lease-rr-2" });
    await appendPendingEffectsWithAdapter(adapter, fence, [effect1, effect2]);

    // Adapter wrapper: after every transaction completes, if effect-1 has been
    // claimed (status = 'processing') but its lease_until is still in the
    // future, expire it in a follow-up write.  This ensures the worker's
    // beforeRemoteDispatch hook sees an expired lease for effect-1 when it
    // tries to renew.  The expiry runs AFTER the committing transaction so it
    // is not overwritten by the in-transaction renewal.
    let effect1Expired = false;
    const wrappedAdapter: SqlStorageAdapter = {
      read: adapter.read.bind(adapter),
      async transaction<T>(op: (context: SqlStorageContext) => Promise<T>) {
        const result = await adapter.transaction(op);
        if (!effect1Expired) {
          await adapter.transaction(async ({ sql }) => {
            await sql.run(
              `UPDATE sheet_effect_outbox
               SET lease_until = ?
               WHERE effect_id = ? AND status = 'processing'
                 AND lease_until IS NOT NULL AND lease_until > ?`,
              [TEST_NOW + 5_000, effect1.effectId, TEST_NOW + 5_000],
            );
          });
          // Check if the expiry actually took effect (effect-1 was claimed)
          const row = await adapter.read(async ({ sql }) => {
            return sql.get<{ readonly lease_until: number | null }>(
              "SELECT lease_until FROM sheet_effect_outbox WHERE effect_id = ?",
              [effect1.effectId],
            );
          });
          if (row !== undefined && row.lease_until !== null && row.lease_until <= TEST_NOW + 5_000) {
            effect1Expired = true;
          }
        }
        return result;
      },
    };

    // FakeDispatcher with a custom apply that manually invokes the
    // beforeRemoteDispatch hook.  When the hook returns false (mixed
    // renewal), return empty results so the worker proceeds to recovery
    // without a remote write.
    const dispatcher = new FakeDispatcher({
      invokeBeforeRemote: false,
      isFastAppendCandidate: () => false,
      apply: async (request) => {
        const renewed = await request.beforeRemoteDispatch?.() ?? true;
        if (!renewed) {
          return { hasMore: false, results: [] };
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
      storage: wrappedAdapter,
      dispatcher,
      workerId: "worker-rr",
      now: TEST_NOW + 40_000,
      maxEffects: 10,
    });

    // The worker selected and claimed both effects, then the mixed renewal
    // hook released effect-2 and recovered effect-1.
    expect(report.selected).toBe(2);
    expect(report.claimed).toBe(2);

    // effect-2: released back to pending with LEASE_RECOVERED_REQUEUE.
    await expect(outboxLastError(adapter, effect2.effectId)).resolves.toBe(
      WORKER_ERROR_CODES.LEASE_RECOVERED_REQUEUE,
    );
    const row2 = await outboxError(adapter, effect2.effectId);
    expect(row2?.last_error_message).toBe(
      "Requeued after writer-lease recovery; no provider acknowledgement.",
    );
    expect(row2?.status).toBe("pending");

    // effect-1: lease expired, recovered to delivery_uncertain.
    await expect(outboxLastError(adapter, effect1.effectId)).resolves.toBe(
      SYNC_EFFECT_RECOVERY_ERROR_CODES.LEASE_EXPIRED_REQUIRES_POSTCONDITION,
    );
    const row1 = await outboxError(adapter, effect1.effectId);
    expect(row1?.status).toBe("delivery_uncertain");

    // No remote apply was executed — the hook aborted before dispatch.
    expect(dispatcher.applyCalls).toBe(1);
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

  it("throws SupervisionOptionsError with code for invalid reconciliation delay", () => {
    const adapter = createKernelStore();
    try {
      createEffectWorkerSupervisor({
        storage: adapter,
        dispatcher: new FakeDispatcher(),
        workerId: "recon-worker",
        reconciliation: {
          initialReconciliationDelayMs: -1,
          run: async () => ({ effectsEnqueued: 0 }),
        },
      });
      expect.fail("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SupervisionOptionsError);
      expect((error as SupervisionOptionsError).code).toBe("sync_effect_supervisor_non_negative_integer_required");
    }
  });

  it("rejects non-positive reconciliation interval with the typed error code", () => {
    expect.assertions(3);
    try {
      new EffectWorkerSupervisor({
        runPass: () => Promise.resolve() as never,
        reconciliation: { intervalMs: 0, run: () => Promise.resolve() as never },
      });
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(SupervisionOptionsError);
      expect((error as SupervisionOptionsError).code).toBe(
        SUPERVISOR_OPTIONS_ERROR_CODES.POSITIVE_INTEGER_REQUIRED,
      );
      expect((error as Error).message).toBe("sync effect supervisor reconciliation interval must be a positive safe integer");
    }
  });

  describe("split read-ahead pipeline (preflight + applyPrepared)", () => {
    /** Regular effect on a chosen route (never fast-append shaped). */
    const routeRegular = (effectId: string, physicalSheetId: string): NewEffect =>
      newEffect({
        effectId,
        physicalSheetId,
        targetId: "entity-" + effectId,
        expectedVisibleRevision: 1,
        expectedVisibleHash: "baseline-" + effectId,
      });

    /** Split-capable dispatcher whose stages record concurrency and order. */
    const createTracker = (stepMs = 5): {
      readonly dispatcher: FakeDispatcher;
      readonly probe: { readonly maxActive: number; readonly events: string[] };
    } => {
      const probe = { maxActive: 0, events: [] as string[] };
      let active = 0;
      const enter = async (label: string): Promise<void> => {
        active += 1;
        probe.maxActive = Math.max(probe.maxActive, active);
        probe.events.push(`${label}:enter`);
        await delay(stepMs);
        probe.events.push(`${label}:exit`);
        active -= 1;
      };
      const dispatcher = new FakeDispatcher({
        routeKeyFor: (effect) => effect.physical_sheet_id,
        preflight: async (request) => {
          await enter(`preflight:${request.routeKey}`);
          return { __preparedDispatch: "hikoutei/dispatcher/prepared" };
        },
        applyPrepared: async (request) => {
          await enter(`write:${request.routeKey}`);
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
      return { dispatcher, probe };
    };

    it("overlaps a next-route preflight with the current route's write", async () => {
      const adapter = createKernelStore();
      const fence = await claimTestFence(adapter);
      await appendPendingEffectsWithAdapter(adapter, fence, [
        routeRegular("read-ahead-a", "sheet-a"),
        routeRegular("read-ahead-b", "sheet-b"),
      ]);
      const { dispatcher, probe } = createTracker();
      const report = await runEffectWorkerWithAdapter({
        storage: adapter,
        dispatcher,
        workerId: "read-ahead-worker",
        now: 1_000,
        maxEffects: 5,
      });
      expect(report).toMatchObject({ claimed: 2, applied: 2, failed: 0 });
      expect(dispatcher.applyCalls).toBe(0);
      expect(dispatcher.preflightCalls).toBe(2);
      expect(dispatcher.applyPreparedCalls).toBe(2);
      // A next-route preflight ran while the current route's write was in
      // flight (the read-ahead benefit), not strictly serialized.
      expect(probe.maxActive).toBeGreaterThanOrEqual(2);
      // The read-ahead preflight for sheet-b fired before sheet-a's write.
      const phases = dispatcher.splitCallLog.map((c) => `${c.phase}:${c.request.routeKey}`);
      expect(phases.indexOf("preflight:sheet-b")).toBeLessThan(
        phases.indexOf("applyPrepared:sheet-a"),
      );
    });

    it("keeps preflight and write strictly serial within one route", async () => {
      const adapter = createKernelStore();
      const fence = await claimTestFence(adapter);
      await appendPendingEffectsWithAdapter(adapter, fence, [
        routeRegular("serial-1", "sheet-a"),
        routeRegular("serial-2", "sheet-a"),
      ]);
      const { dispatcher, probe } = createTracker();
      const report = await runEffectWorkerWithAdapter({
        storage: adapter,
        dispatcher,
        workerId: "serial-worker",
        now: 1_000,
        maxEffects: 5,
      });
      expect(report).toMatchObject({ claimed: 2, applied: 2, failed: 0 });
      // Both effects share one route, so one preflight then one serial write.
      expect(dispatcher.preflightCalls).toBe(1);
      expect(dispatcher.applyPreparedCalls).toBe(1);
      expect(probe.maxActive).toBe(1);
      const events = probe.events;
      expect(events.indexOf("preflight:sheet-a:exit")).toBeLessThan(
        events.indexOf("write:sheet-a:enter"),
      );
    });

    it("requeues a route whose preflight fails before any write", async () => {
      const adapter = createKernelStore();
      const fence = await claimTestFence(adapter);
      await appendPendingEffectsWithAdapter(adapter, fence, [regularEffect("preflight-fail")]);
      const dispatcher = new FakeDispatcher({
        preflight: async () => {
          throw new Error("preflight read failed");
        },
        applyPrepared: async (request) => ({
          hasMore: false,
          results: request.effects.map((effect) => ({
            effectId: effect.effect_id,
            payloadHash: effect.payload_hash,
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
        workerId: "preflight-fail-worker",
        now: 1_000,
        maxEffects: 1,
      });
      expect(report).toMatchObject({ claimed: 1, applied: 0, failed: 0, requeued: 1 });
      expect(dispatcher.applyPreparedCalls).toBe(0);
      await expect(outboxStatus(adapter, "preflight-fail")).resolves.toBe("pending");
    });

    it("terminally fails a route whose applyPrepared reports an explicit rejection", async () => {
      const adapter = createKernelStore();
      const fence = await claimTestFence(adapter);
      await appendPendingEffectsWithAdapter(adapter, fence, [regularEffect("applyprepared-fail")]);
      const dispatcher = new FakeDispatcher({
        preflight: async () => ({ __preparedDispatch: "hikoutei/dispatcher/prepared" }),
        applyPrepared: async () => {
          throw new DispatchTransportError("explicit_remote_failure", "the remote rejected before any write");
        },
      });
      const report = await runEffectWorkerWithAdapter({
        storage: adapter,
        dispatcher,
        workerId: "applyprepared-fail-worker",
        now: 1_000,
        maxEffects: 1,
      });
      expect(report).toMatchObject({ claimed: 1, applied: 0, failed: 1 });
      expect(dispatcher.probeCalls).toBe(0);
      await expect(outboxStatus(adapter, "applyprepared-fail")).resolves.toBe("failed");
    });

    it("chains three routes so the third preflights while the second writes", async () => {
      // A→B→C: C's preflight must fire once B's prepared state is consumed and
      // B's write is running (one route of read-ahead ahead of the writes).
      const adapter = createKernelStore();
      const fence = await claimTestFence(adapter);
      await appendPendingEffectsWithAdapter(adapter, fence, [
        routeRegular("chain-a", "sheet-a"),
        routeRegular("chain-b", "sheet-b"),
        routeRegular("chain-c", "sheet-c"),
      ]);
      const { dispatcher, probe } = createTracker();
      const report = await runEffectWorkerWithAdapter({
        storage: adapter,
        dispatcher,
        workerId: "chain-worker",
        now: 1_000,
        maxEffects: 5,
      });
      expect(report).toMatchObject({ claimed: 3, applied: 3, failed: 0 });
      expect(dispatcher.preflightCalls).toBe(3);
      expect(dispatcher.applyPreparedCalls).toBe(3);
      const phases = dispatcher.splitCallLog.map((c) => `${c.phase}:${c.request.routeKey}`);
      // C's preflight overlaps B's write (read-ahead one route past the
      // previously consumed prepared state), not strictly after B's write.
      expect(phases.indexOf("preflight:sheet-c")).toBeLessThan(
        phases.indexOf("applyPrepared:sheet-b"),
      );
      // C's write still strictly follows B's write (writes never reorder).
      expect(phases.indexOf("applyPrepared:sheet-b")).toBeLessThan(
        phases.indexOf("applyPrepared:sheet-c"),
      );
      expect(probe.maxActive).toBeGreaterThanOrEqual(2);
    });

    it("requeues a read-ahead route whose preflight fails before its write", async () => {
      const adapter = createKernelStore();
      const fence = await claimTestFence(adapter);
      await appendPendingEffectsWithAdapter(adapter, fence, [
        routeRegular("read-ahead-fail-a", "sheet-a"),
        routeRegular("read-ahead-fail-b", "sheet-b"),
      ]);
      const dispatcher = new FakeDispatcher({
        routeKeyFor: (effect) => effect.physical_sheet_id,
        preflight: async (request) => {
          if (request.routeKey === "sheet-b") throw new Error("read-ahead preflight failed");
          return { __preparedDispatch: "hikoutei/dispatcher/prepared" };
        },
        applyPrepared: async (request) => ({
          hasMore: false,
          results: request.effects.map((effect) => ({
            effectId: effect.effect_id,
            payloadHash: effect.payload_hash,
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
        workerId: "read-ahead-fail-worker",
        now: 1_000,
        maxEffects: 5,
      });
      // The read-ahead preflight for sheet-b fired during sheet-a's write and
      // rejected; the worker must requeue sheet-b (never an unhandled
      // rejection, never a write) while sheet-a still applies.
      expect(report).toMatchObject({ claimed: 2, applied: 1, requeued: 1 });
      await expect(outboxStatus(adapter, "read-ahead-fail-a")).resolves.toBe("applied");
      await expect(outboxStatus(adapter, "read-ahead-fail-b")).resolves.toBe("pending");
    });

    it("does not overlap a regular read-ahead preflight with a fast-append unit", async () => {
      const adapter = createKernelStore();
      const fence = await claimTestFence(adapter);
      await appendPendingEffectsWithAdapter(adapter, fence, [
        newEffect({ effectId: "fast-append-1", physicalSheetId: "sheet-fast" }),
        routeRegular("regular-1", "sheet-regular"),
      ]);
      const probe = { maxActive: 0, events: [] as string[] };
      let active = 0;
      const enter = async (label: string): Promise<void> => {
        active += 1;
        probe.maxActive = Math.max(probe.maxActive, active);
        probe.events.push(`${label}:enter`);
        await delay(5);
        probe.events.push(`${label}:exit`);
        active -= 1;
      };
      const dispatcher = new FakeDispatcher({
        routeKeyFor: (effect) => effect.physical_sheet_id,
        fastAppendRouteKeyFor: () => "spreadsheet-scope",
        fastAppend: async (request) => {
          await enter("fastAppend");
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
        preflight: async (request) => {
          await enter(`preflight:${request.routeKey}`);
          return { __preparedDispatch: "hikoutei/dispatcher/prepared" };
        },
        applyPrepared: async (request) => {
          await enter(`write:${request.routeKey}`);
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
        workerId: "fast-overlap-worker",
        now: 1_000,
        maxEffects: 5,
      });
      expect(report).toMatchObject({ claimed: 2, applied: 2, failed: 0 });
      // The regular route's read-ahead preflight must NOT overlap the
      // fast-append's atomic multi-route write (no concurrent preflight), so
      // the fast-append's prepared state cannot be made stale by a read.
      expect(probe.maxActive).toBe(1);
    });

    it("never overlaps two preflights while the next preflight overlaps the current write", async () => {
      const adapter = createKernelStore();
      const fence = await claimTestFence(adapter);
      await appendPendingEffectsWithAdapter(adapter, fence, [
        routeRegular("serial-a", "sheet-a"),
        routeRegular("serial-b", "sheet-b"),
      ]);
      const { dispatcher, probe } = createTracker();
      const report = await runEffectWorkerWithAdapter({
        storage: adapter,
        dispatcher,
        workerId: "no-overlap-worker",
        now: 1_000,
        maxEffects: 5,
      });
      expect(report).toMatchObject({ claimed: 2, applied: 2, failed: 0 });
      const events = probe.events;
      // B's preflight starts only AFTER A's preflight completes (A/B
      // preflights never overlap) and BEFORE A's write so B overlaps A's
      // write — the read-ahead benefit without two concurrent preflights.
      expect(events.indexOf("preflight:sheet-b:enter")).toBeGreaterThan(
        events.indexOf("preflight:sheet-a:exit"),
      );
      expect(events.indexOf("preflight:sheet-b:enter")).toBeLessThan(
        events.indexOf("write:sheet-a:enter"),
      );
      expect(maxConcurrentPreflights(events)).toBe(1);
      // A write still overlaps the next preflight.
      expect(probe.maxActive).toBeGreaterThanOrEqual(2);
    });

    it("chains three routes without ever overlapping two preflights", async () => {
      const adapter = createKernelStore();
      const fence = await claimTestFence(adapter);
      await appendPendingEffectsWithAdapter(adapter, fence, [
        routeRegular("chain-a", "sheet-a"),
        routeRegular("chain-b", "sheet-b"),
        routeRegular("chain-c", "sheet-c"),
      ]);
      const { dispatcher, probe } = createTracker();
      const report = await runEffectWorkerWithAdapter({
        storage: adapter,
        dispatcher,
        workerId: "chain-noverlap-worker",
        now: 1_000,
        maxEffects: 5,
      });
      expect(report).toMatchObject({ claimed: 3, applied: 3, failed: 0 });
      const events = probe.events;
      // Each preflight begins only after the previous preflight ends (one
      // route of read-ahead, but preflights stay strictly sequential).
      expect(events.indexOf("preflight:sheet-b:enter")).toBeGreaterThan(
        events.indexOf("preflight:sheet-a:exit"),
      );
      expect(events.indexOf("preflight:sheet-c:enter")).toBeGreaterThan(
        events.indexOf("preflight:sheet-b:exit"),
      );
      expect(maxConcurrentPreflights(events)).toBe(1);
      // Yet each write overlaps the next preflight (read-ahead one route ahead).
      expect(probe.maxActive).toBeGreaterThanOrEqual(2);
    });

    it("suppresses read-ahead after a preflight refusal and requeues safely", async () => {
      const adapter = createKernelStore();
      const fence = await claimTestFence(adapter);
      await appendPendingEffectsWithAdapter(adapter, fence, [
        routeRegular("refused-a", "sheet-a"),
        routeRegular("refused-b", "sheet-b"),
        routeRegular("refused-c", "sheet-c"),
      ]);
      const probe = { maxActive: 0, events: [] as string[] };
      let active = 0;
      const enter = async (label: string): Promise<void> => {
        active += 1;
        probe.maxActive = Math.max(probe.maxActive, active);
        probe.events.push(`${label}:enter`);
        await delay(5);
        probe.events.push(`${label}:exit`);
        active -= 1;
      };
      const dispatcher = new FakeDispatcher({
        routeKeyFor: (effect) => effect.physical_sheet_id,
        preflight: async (request) => {
          if (request.routeKey === "sheet-a") throw new Error("refused read-ahead preflight");
          await enter(`preflight:${request.routeKey}`);
          return { __preparedDispatch: "hikoutei/dispatcher/prepared" };
        },
        applyPrepared: async (request) => {
          await enter(`write:${request.routeKey}`);
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
        workerId: "suppress-worker",
        now: 1_000,
        maxEffects: 5,
      });
      expect(report).toMatchObject({ claimed: 3, applied: 2, failed: 0, requeued: 1 });
      await expect(outboxStatus(adapter, "refused-a")).resolves.toBe("pending");
      await expect(outboxStatus(adapter, "refused-b")).resolves.toBe("applied");
      await expect(outboxStatus(adapter, "refused-c")).resolves.toBe("applied");
      // After A's preflight refusal, read-ahead is suppressed for the rest of
      // the pass: C's preflight does NOT overlap B's write, and no two
      // preflights overlap anywhere.
      const events = probe.events;
      expect(events.indexOf("preflight:sheet-c:enter")).toBeGreaterThan(
        events.indexOf("write:sheet-b:exit"),
      );
      expect(maxConcurrentPreflights(events)).toBe(1);
    });

    it("suppresses read-ahead after a write failure so no C preflight overlaps B", async () => {
      const adapter = createKernelStore();
      const fence = await claimTestFence(adapter);
      await appendPendingEffectsWithAdapter(adapter, fence, [
        routeRegular("fail-a", "sheet-a"),
        routeRegular("fail-b", "sheet-b"),
        routeRegular("fail-c", "sheet-c"),
      ]);
      const probe = { maxActive: 0, events: [] as string[] };
      let active = 0;
      const enter = async (label: string): Promise<void> => {
        active += 1;
        probe.maxActive = Math.max(probe.maxActive, active);
        probe.events.push(`${label}:enter`);
        await delay(5);
        probe.events.push(`${label}:exit`);
        active -= 1;
      };
      const dispatcher = new FakeDispatcher({
        routeKeyFor: (effect) => effect.physical_sheet_id,
        preflight: async (request) => {
          await enter(`preflight:${request.routeKey}`);
          return { __preparedDispatch: "hikoutei/dispatcher/prepared" };
        },
        applyPrepared: async (request) => {
          if (request.routeKey === "sheet-a") {
            throw new DispatchTransportError("delivery_uncertain", "A write failed");
          }
          await enter(`write:${request.routeKey}`);
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
        readPostconditions: async (request) => ({
          results: request.effects.map((effect) => ({
            effectId: effect.effect_id,
            payloadHash: effect.payload_hash,
            postcondition: {
              disposition: "unapplied" as const,
              visibleRevision: 1,
              visibleHash: "visible-1",
              fieldHashes: {},
            },
          })),
        }),
      });
      const controller = new AdaptiveEffectBatchController({ coalesceWindowMs: 0 });
      const abandoned: string[] = [];
      const abandonPreflight = controller.abandonPreflight.bind(controller);
      controller.abandonPreflight = (routeKey: string): void => {
        abandoned.push(routeKey);
        abandonPreflight(routeKey);
      };
      const report = await runEffectWorkerWithAdapter({
        storage: adapter,
        dispatcher,
        workerId: "write-fail-suppress-worker",
        now: 1_000,
        maxEffects: 5,
        batchController: controller,
      });
      // A's write failed (delivery-uncertain) and was requeued; B and C applied.
      expect(report).toMatchObject({ claimed: 3, applied: 2, failed: 0, requeued: 1 });
      // B was read-ahead preflighted during A's write; when A's write failed
      // that pending preflight was discarded, so its buffered latency must be
      // abandoned (not double-charged to a later sheet-b write).
      expect(abandoned).toContain("sheet-b");
      await expect(outboxStatus(adapter, "fail-a")).resolves.toBe("pending");
      await expect(outboxStatus(adapter, "fail-b")).resolves.toBe("applied");
      await expect(outboxStatus(adapter, "fail-c")).resolves.toBe("applied");
      // After A's write failure, read-ahead is suppressed for the rest of the
      // pass: C's preflight does NOT overlap B's write.
      const events = probe.events;
      expect(events.indexOf("preflight:sheet-c:enter")).toBeGreaterThan(
        events.indexOf("write:sheet-b:exit"),
      );
      expect(maxConcurrentPreflights(events)).toBe(1);
    });

    it("settles the pending read-ahead preflight when result persistence throws", async () => {
      const inner = createKernelStore();
      const fence = await claimTestFence(inner);
      await appendPendingEffectsWithAdapter(inner, fence, [
        routeRegular("persist-a", "sheet-a"),
        routeRegular("persist-b", "sheet-b"),
        routeRegular("persist-c", "sheet-c"),
      ]);
      const adapter = new ThrowingResultPersistenceAdapter(inner);
      const dispatcher = new FakeDispatcher({
        routeKeyFor: (effect) => effect.physical_sheet_id,
        preflight: async () => ({ __preparedDispatch: "hikoutei/dispatcher/prepared" }),
        applyPrepared: async (request) => {
          if (request.routeKey === "sheet-a") {
            // A's write succeeds; arm the adapter so the NEXT transaction
            // (A's result persistence) throws.
            adapter.throwOnResultPersistence = true;
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
        readPostconditions: async (request) => ({
          results: request.effects.map((effect) => ({
            effectId: effect.effect_id,
            payloadHash: effect.payload_hash,
            postcondition: {
              disposition: "unapplied" as const,
              visibleRevision: 1,
              visibleHash: "visible-1",
              fieldHashes: {},
            },
          })),
        }),
      });
      const controller = new AdaptiveEffectBatchController({ coalesceWindowMs: 0 });
      const abandoned: string[] = [];
      const abandonPreflight = controller.abandonPreflight.bind(controller);
      controller.abandonPreflight = (routeKey: string): void => {
        abandoned.push(routeKey);
        abandonPreflight(routeKey);
      };
      // A's write succeeds but its result persistence throws; the pass aborts
      // and the pending read-ahead preflight for sheet-b must be settled and
      // its buffered latency abandoned so no remote read is left unhandled and
      // no controller state is retained.
      await expect(runEffectWorkerWithAdapter({
        storage: adapter,
        dispatcher,
        workerId: "persist-throw-worker",
        now: 1_000,
        maxEffects: 5,
        batchController: controller,
      })).rejects.toThrow("injected result persistence failure");
      expect(abandoned).toContain("sheet-b");
    });

    it("terminally fails a route whose preflight reports an explicit remote failure", async () => {
      const adapter = createKernelStore();
      const fence = await claimTestFence(adapter);
      await appendPendingEffectsWithAdapter(adapter, fence, [regularEffect("preflight-permanent")]);
      const dispatcher = new FakeDispatcher({
        preflight: async () => {
          throw new DispatchTransportError("explicit_remote_failure", "provider state/schema/route error");
        },
        applyPrepared: async (request) => ({
          hasMore: false,
          results: request.effects.map((effect) => ({
            effectId: effect.effect_id,
            payloadHash: effect.payload_hash,
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
        workerId: "preflight-permanent-worker",
        now: 1_000,
        maxEffects: 1,
      });
      expect(report).toMatchObject({ claimed: 1, applied: 0, failed: 1, requeued: 0 });
      await expect(outboxStatus(adapter, "preflight-permanent")).resolves.toBe("failed");
    });

    it("requeues a route whose preflight reports a delivery-uncertain transport failure", async () => {
      const adapter = createKernelStore();
      const fence = await claimTestFence(adapter);
      await appendPendingEffectsWithAdapter(adapter, fence, [regularEffect("preflight-transient")]);
      const dispatcher = new FakeDispatcher({
        preflight: async () => {
          throw new DispatchTransportError("delivery_uncertain", "bounded transport refusal/timeout");
        },
        applyPrepared: async (request) => ({
          hasMore: false,
          results: request.effects.map((effect) => ({
            effectId: effect.effect_id,
            payloadHash: effect.payload_hash,
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
        workerId: "preflight-transient-worker",
        now: 1_000,
        maxEffects: 1,
      });
      expect(report).toMatchObject({ claimed: 1, applied: 0, failed: 0, requeued: 1 });
      await expect(outboxStatus(adapter, "preflight-transient")).resolves.toBe("pending");
    });

    it("falls back to the legacy single apply when the dispatcher lacks split stages", async () => {
      const adapter = createKernelStore();
      const fence = await claimTestFence(adapter);
      await appendPendingEffectsWithAdapter(adapter, fence, [
        routeRegular("legacy-a", "sheet-a"),
        routeRegular("legacy-b", "sheet-b"),
      ]);
      const dispatcher = new FakeDispatcher({
        routeKeyFor: (effect) => effect.physical_sheet_id,
      });
      const report = await runEffectWorkerWithAdapter({
        storage: adapter,
        dispatcher,
        workerId: "legacy-split-worker",
        now: 1_000,
        maxEffects: 5,
      });
      expect(report).toMatchObject({ claimed: 2, applied: 2, failed: 0 });
      expect(dispatcher.applyCalls).toBe(2);
      expect(dispatcher.preflightCalls).toBe(0);
      expect(dispatcher.applyPreparedCalls).toBe(0);
    });
  });
});

describe("adaptive batch controller", () => {
  it("throttles fast-append request starts and adapts route limits", async () => {
    const controller = new AdaptiveEffectBatchController({
      appendDispatchIntervalMs: 50,
      coalesceWindowMs: 0,
    });

    expect(controller.limitFor("route-a")).toBe(100);
    controller.beginAppendDispatch(1_000);
    const waited = await controller.waitForAppendThrottle(1_020);
    expect(waited).toBeGreaterThanOrEqual(30);

    controller.observe("route-a", {
      durationMs: 100,
      responseSucceeded: false,
      responseLoss: true,
    });
    expect(controller.limitFor("route-a")).toBe(50);
    for (let index = 0; index < 2; index += 1) {
      controller.observe("route-a", { durationMs: 10, responseSucceeded: true, responseLoss: false });
    }
    expect(controller.limitFor("route-a")).toBe(75);
  });

  it("exposes a read-only limits snapshot without creating or mutating route state", () => {
    const controller = new AdaptiveEffectBatchController({ coalesceWindowMs: 0 });
    // Untouched controller: empty snapshot (the accessor creates no routes).
    expect(controller.limitsSnapshot()).toEqual({});
    controller.observe("route-b", { durationMs: 10, responseSucceeded: true, responseLoss: false });
    controller.observePreflight("route-a", { durationMs: 5, succeeded: false });
    expect(controller.limitsSnapshot()).toEqual({ "route-a": 50, "route-b": 100 });
    // Mutating the copy cannot reach the controller's policy state.
    const snapshot = controller.limitsSnapshot();
    snapshot["route-b"] = 999;
    expect(controller.limitFor("route-b")).toBe(100);
  });

  it("rejects invalid adaptive batch limit configurations", () => {
    expect(() => new AdaptiveEffectBatchController({ minimum: 20, maximum: 5 }))
      .toThrow("adaptive effect batch limits must satisfy minimum <= initial <= maximum");
    expect(() => new AdaptiveEffectBatchController({ initial: 0 }))
      .toThrow("adaptive initial must be a positive safe integer");
  });

  it("throws AdaptiveBatchOptionsError with code for invalid batch limits", () => {
    try {
      new AdaptiveEffectBatchController({ minimum: 20, maximum: 5 });
      expect.fail("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AdaptiveBatchOptionsError);
      expect((error as AdaptiveBatchOptionsError).code).toBe("adaptive_limit_order_invalid");
    }
    try {
      new AdaptiveEffectBatchController({ initial: 0 });
      expect.fail("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AdaptiveBatchOptionsError);
      expect((error as AdaptiveBatchOptionsError).code).toBe("adaptive_positive_integer_required");
    }
  });

  it("backs a route off when its preflight read fails", () => {
    const controller = new AdaptiveEffectBatchController({
      coalesceWindowMs: 0,
    });
    expect(controller.limitFor("route-read")).toBe(100);
    controller.observePreflight("route-read", { durationMs: 12, succeeded: false });
    // A failed preflight halves the limit so later write successes cannot
    // falsely regrow it.
    expect(controller.limitFor("route-read")).toBe(50);
  });

  it("includes preflight read latency in the write observation so slow reads back off", () => {
    const controller = new AdaptiveEffectBatchController({
      coalesceWindowMs: 0,
      highLatencyThresholdMs: 100,
    });
    // A fast write that would otherwise count as healthy is pushed over the
    // latency threshold by a slow read-ahead preflight.
    controller.observePreflight("route-latency", { durationMs: 90, succeeded: true });
    controller.observe("route-latency", { durationMs: 20, responseSucceeded: true, responseLoss: false });
    expect(controller.limitFor("route-latency")).toBe(50);
  });

  it("grows a route only when the read+write total stays healthy", () => {
    const controller = new AdaptiveEffectBatchController({
      coalesceWindowMs: 0,
      highLatencyThresholdMs: 1_000,
    });
    for (let index = 0; index < 2; index += 1) {
      controller.observePreflight("route-fast", { durationMs: 5, succeeded: true });
      controller.observe("route-fast", { durationMs: 5, responseSucceeded: true, responseLoss: false });
    }
    expect(controller.limitFor("route-fast")).toBe(125);
  });

  it("clears buffered preflight latency when a prepared unit is abandoned (fence loss)", () => {
    const controller = new AdaptiveEffectBatchController({
      coalesceWindowMs: 0,
      highLatencyThresholdMs: 100,
    });
    // A successful read-ahead preflight folds its latency into the next write
    // observation. If that write is then dropped (fence/authority loss before
    // the write), the buffered latency must be settled so it is NOT double
    // charged to a future genuine write of the same route.
    controller.observePreflight("route-abandoned", { durationMs: 90, succeeded: true });
    controller.abandonPreflight("route-abandoned");
    // The next genuine write is fast and healthy, so it must grow the route
    // instead of being pushed over the latency threshold by a stale read whose
    // write never ran.
    controller.observe("route-abandoned", { durationMs: 20, responseSucceeded: true, responseLoss: false });
    expect(controller.limitFor("route-abandoned")).toBe(100);
    // Without the clear, the 90ms read would have pushed 20+90=110 over the
    // 100ms threshold and halved the limit instead.
  });

  it("treats a hasMore=true partial prefix as healthy and only backs off a hasMore=false missing result", async () => {
    const routeKey = "physical-1\u0000system_state";
    // hasMore=true with a valid returned prefix: the provider stopped at its
    // body budget and the suffix is deferred, so the route must NOT back off.
    const partialAdapter = createKernelStore();
    const partialFence = await claimTestFence(partialAdapter);
    await appendPendingEffectsWithAdapter(partialAdapter, partialFence, [
      regularEffect("partial-a"),
      regularEffect("partial-b"),
    ]);
    const partialDispatcher = new FakeDispatcher({
      apply: async (request) => ({
        hasMore: true,
        results: request.effects.slice(0, 1).map((effect) => ({
          effectId: effect.effect_id,
          payloadHash: effect.payload_hash,
          status: "applied" as const,
          visibleRevision: 1,
          visibleHash: "visible-1",
          fieldHashes: {},
        })),
      }),
    });
    const partialController = new AdaptiveEffectBatchController({ coalesceWindowMs: 0 });
    await runEffectWorkerWithAdapter({
      storage: partialAdapter,
      dispatcher: partialDispatcher,
      workerId: "partial-worker",
      now: 1_000,
      maxEffects: 5,
      batchController: partialController,
    });
    expect(partialController.limitFor(routeKey)).toBe(100);

    // hasMore=false with a missing result: the provider claims completion but
    // did not acknowledge every effect, so delivery-uncertain recovery backs
    // the route off.
    const missingAdapter = createKernelStore();
    const missingFence = await claimTestFence(missingAdapter);
    await appendPendingEffectsWithAdapter(missingAdapter, missingFence, [
      regularEffect("missing-a"),
      regularEffect("missing-b"),
    ]);
    const missingDispatcher = new FakeDispatcher({
      apply: async (request) => ({
        hasMore: false,
        results: request.effects.slice(0, 1).map((effect) => ({
          effectId: effect.effect_id,
          payloadHash: effect.payload_hash,
          status: "applied" as const,
          visibleRevision: 1,
          visibleHash: "visible-1",
          fieldHashes: {},
        })),
      }),
    });
    const missingController = new AdaptiveEffectBatchController({ coalesceWindowMs: 0 });
    await runEffectWorkerWithAdapter({
      storage: missingAdapter,
      dispatcher: missingDispatcher,
      workerId: "missing-worker",
      now: 1_000,
      maxEffects: 5,
      batchController: missingController,
    });
    expect(missingController.limitFor(routeKey)).toBe(50);
  });

  it("keeps a hasMore=true fast-append prefix healthy without backing off the route", async () => {
    const routeKey = "physical-1\u0000system_state";
    const adapter = createKernelStore();
    const fence = await claimTestFence(adapter);
    const first = newEffect({ effectId: "append-adaptive-first", targetId: "entity-first" });
    const suffix = newEffect({ effectId: "append-adaptive-suffix", targetId: "entity-suffix" });
    await appendPendingEffectsWithAdapter(adapter, fence, [first, suffix]);

    const dispatcher = new FakeDispatcher({
      fastAppend: async (request) => ({
        // The provider stopped at its body budget after the first effect:
        // hasMore proves the deferral, so the suffix is released for the next
        // pass and the route must NOT back off.
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
    const controller = new AdaptiveEffectBatchController({ coalesceWindowMs: 0 });

    const report = await runEffectWorkerWithAdapter({
      storage: adapter,
      dispatcher,
      workerId: "adaptive-append-worker",
      now: 1_000,
      maxEffects: 5,
      maxFastAppendCandidates: 2,
      batchController: controller,
    });

    expect(controller.limitFor(routeKey)).toBe(100);
    expect(report).toMatchObject({ applied: 1, deferred: 1, requeued: 0, failed: 0 });
    await expect(outboxStatus(adapter, first.effectId)).resolves.toBe("applied");
    await expect(outboxStatus(adapter, suffix.effectId)).resolves.toBe("pending");
    await expect(outboxLastError(adapter, suffix.effectId)).resolves.toBe(
      WORKER_ERROR_CODES.PROVIDER_BATCH_DEFERRED,
    );
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

function outboxLastError(adapter: NodeSqliteTestAdapter, effectId: string): Promise<string | undefined> {
  return adapter.read(async ({ sql }) => {
    const row = await sql.get<{ readonly last_error_code: string | null }>(
      "SELECT last_error_code FROM sheet_effect_outbox WHERE effect_id = ?",
      [effectId],
    );
    return row?.last_error_code ?? undefined;
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

function readWriterLeaseUntil(adapter: NodeSqliteTestAdapter): Promise<number | undefined> {
  return adapter.read(async ({ sql }) => {
    const row = await sql.get<{ readonly lease_until: number | null }>(
      "SELECT lease_until FROM writer_lease WHERE role = ?",
      ["sync-effect-worker"],
    );
    return row?.lease_until ?? undefined;
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Counts the maximum number of concurrently active preflight stages in a log. */
function maxConcurrentPreflights(events: readonly string[]): number {
  let active = 0;
  let max = 0;
  for (const event of events) {
    if (event.startsWith("preflight:") && event.endsWith(":enter")) {
      active += 1;
      max = Math.max(max, active);
    } else if (event.startsWith("preflight:") && event.endsWith(":exit")) {
      active -= 1;
    }
  }
  return max;
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
