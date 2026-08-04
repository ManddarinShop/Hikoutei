import {
  defineEntity,
  MikroORM,
  NodeSqliteDialect,
  p,
  SqliteDriver,
} from "@mikro-orm/sql";
import { afterEach, describe, expect, it } from "vitest";

import { APPLICABILITY_KINDS, PRESENCE_KINDS } from "../src/shared/state/constants.js";
import { absentValue, presentValue } from "../src/shared/state/index.js";
import {
  AppsScriptSyncGatewayError,
  SYNC_GATEWAY_CLIENT_ERROR_CODES,
} from "../src/adapter/sheets/providers/apps-script-gateway/errors.js";
import {
  appendPendingEffectsWithAdapter,
  claimWriterLeaseWithAdapter,
} from "../src/infrastructure/storage/index.js";
import { WRITER_LEASE_CLAIM_RESULT_KINDS } from "../src/infrastructure/storage/sync/shared/writerLease.js";
import {
  computeSyncVisibleHash,
  serializeSyncProjectionEffectPayload,
} from "../src/application/sync/gateway/syncGateway.js";
import { SYNC_GATEWAY_POSTCONDITION_DISPOSITIONS } from "../src/application/sync/gateway/constants.js";
import { runSyncEffectWorkerWithAdapter } from "../src/application/sync/outbound/effects/SyncEffectWorker.js";
import { FakeSyncSheetGateway } from "./support/FakeSyncSheetGateway.js";
import { MikroOrmSqliteAdapter } from "../src/adapter/persistence/providers/mikro-orm/storage/MikroOrmSqliteAdapter.js";
import { migrateMikroOrmSqliteSchema } from "../src/adapter/persistence/providers/mikro-orm/storage/MikroOrmSqliteSchema.js";
import type { NewEffect } from "../src/infrastructure/storage/index.js";

const EntitySchema = defineEntity({
  name: "SyncEffectRecoveryEntity",
  tableName: "sync_effect_recovery_entity",
  properties: { id: p.string().primary() },
});

class Entity extends EntitySchema.class {}

EntitySchema.setClass(Entity);

describe("sync effect recovery", () => {
  const openOrms: Array<Awaited<ReturnType<typeof createOrm>>> = [];

  afterEach(async () => {
    await Promise.all(openOrms.splice(0).map((orm) => orm.close(true)));
  });

  it("reads an unapplied failed effect before returning it to pending", async () => {
    const orm = await createOrm();
    openOrms.push(orm);
    const adapter = new MikroOrmSqliteAdapter(orm);
    await migrateMikroOrmSqliteSchema(adapter);
    await registerProjection(adapter);

    const claim = await claimWriterLeaseWithAdapter(adapter, {
      role: "sync-effect-worker",
      writerId: "recovery-worker",
      leaseDurationMs: 10_000,
      now: 1_000,
    });
    if (claim.kind !== "claimed") throw new Error("Expected a writer lease");
    const fence = {
      role: claim.lease.role,
      writerEpoch: claim.lease.writerEpoch,
      fencingToken: claim.lease.fencingToken,
      now: 1_000,
    };
    const effect = createEffect("recovery", 1, { includeId: true });
    await expect(appendPendingEffectsWithAdapter(adapter, fence, [effect])).resolves.toBe(true);
    await adapter.transaction(({ sql }) => sql.run(
      "UPDATE sheet_effect_outbox SET status = 'processing', claim_token = ?, writer_epoch = ?, lease_until = ? WHERE effect_id = ?",
      ["expired-claim", claim.lease.writerEpoch, 900, effect.effectId],
    ));

    const gateway = new FakeSyncSheetGateway([
      {
        physicalSheetId: "physical-recovery",
        sheetName: "Orders",
        registeredRange: "A:B",
        projection: "system_state",
        schemaVersion: 1,
        headers: ["id", "status"],
      },
    ]);

    await expect(runSyncEffectWorkerWithAdapter({
      storage: adapter,
      gateway,
      workerId: "recovery-worker",
      now: 1_001,
      maxEffects: 1,
    })).resolves.toMatchObject({
      expiredLeasesRecovered: 1,
      selected: 1,
      claimed: 1,
      applied: 0,
      failed: 0,
      requeued: 1,
    });
    await expect(readStatus(adapter, effect.effectId)).resolves.toBe("pending");

    await expect(runSyncEffectWorkerWithAdapter({
      storage: adapter,
      gateway,
      workerId: "recovery-worker",
      now: 10_000,
      maxEffects: 1,
    })).resolves.toMatchObject({ applied: 1, failed: 0 });
    expect(gateway.applyPostconditionMode).toBeUndefined();
    expect(gateway.fastAppendCalls).toBe(1);
    await expect(readStatus(adapter, effect.effectId)).resolves.toBe("applied");
  });

  it("reads failed effects for one projection in a single postcondition batch", async () => {
    const orm = await createOrm();
    openOrms.push(orm);
    const adapter = new MikroOrmSqliteAdapter(orm);
    await migrateMikroOrmSqliteSchema(adapter);
    await registerProjection(adapter);

    const claim = await claimWriterLeaseWithAdapter(adapter, {
      role: "sync-effect-worker",
      writerId: "batch-recovery-worker",
      leaseDurationMs: 10_000,
      now: 2_000,
    });
    if (claim.kind !== "claimed") throw new Error("Expected a writer lease");
    const fence = {
      role: claim.lease.role,
      writerEpoch: claim.lease.writerEpoch,
      fencingToken: claim.lease.fencingToken,
      now: 2_000,
    };
    const effects = [createEffect("batch-a", 2), createEffect("batch-b", 3)];
    await expect(appendPendingEffectsWithAdapter(adapter, fence, effects)).resolves.toBe(true);
    await adapter.transaction(({ sql }) => sql.run(
      "UPDATE sheet_effect_outbox SET status = 'failed', last_error_code = ? WHERE effect_id IN (?, ?)",
      ["postcondition_unavailable", effects[0]!.effectId, effects[1]!.effectId],
    ));

    const gateway = new FakeSyncSheetGateway([
      {
        physicalSheetId: "physical-recovery",
        sheetName: "Orders",
        registeredRange: "A:B",
        projection: "system_state",
        schemaVersion: 1,
        headers: ["status"],
      },
    ]);

    await expect(runSyncEffectWorkerWithAdapter({
      storage: adapter,
      gateway,
      workerId: "batch-recovery-worker",
      now: 2_001,
      maxEffects: 2,
    })).resolves.toMatchObject({
      selected: 2,
      claimed: 2,
      failed: 0,
      requeued: 2,
    });
    expect(gateway.postconditionBatchReads).toBe(1);
    await expect(readStatus(adapter, effects[0]!.effectId)).resolves.toBe("pending");
    await expect(readStatus(adapter, effects[1]!.effectId)).resolves.toBe("pending");
  });

  it("keeps a receipt-less orphan row delivery-uncertain instead of closing or redriving", async () => {
    const orm = await createOrm();
    openOrms.push(orm);
    const adapter = new MikroOrmSqliteAdapter(orm);
    await migrateMikroOrmSqliteSchema(adapter);
    await registerProjection(adapter);

    const claim = await claimWriterLeaseWithAdapter(adapter, {
      role: "sync-effect-worker",
      writerId: "orphan-worker",
      leaseDurationMs: 10_000,
      now: 4_000,
    });
    if (claim.kind !== "claimed") throw new Error("Expected a writer lease");
    const fence = {
      role: claim.lease.role,
      writerEpoch: claim.lease.writerEpoch,
      fencingToken: claim.lease.fencingToken,
      now: 4_000,
    };
    const effect = createEffect("orphan");
    await expect(appendPendingEffectsWithAdapter(adapter, fence, [effect])).resolves.toBe(true);
    // Simulate the response-loss probe of a two-flush append orphan: the
    // target row exists at the target hash, but the receipt write never
    // landed, so the gateway classifies the probe as unavailable with a
    // stable reason instead of an applied closure.
    await adapter.transaction(({ sql }) => sql.run(
      "UPDATE sheet_effect_outbox SET status = 'failed', last_error_code = ? WHERE effect_id = ?",
      ["postcondition_unavailable", effect.effectId],
    ));

    const gateway = new ReceiptLessOrphanGateway();
    const first = await runSyncEffectWorkerWithAdapter({
      storage: adapter,
      gateway,
      workerId: "orphan-worker",
      now: 4_001,
      maxEffects: 1,
      // A controlled pass clock pins the live fence to 4_001 regardless of
      // wall time, so the deferral schedules next_probe_at deterministically
      // instead of drifting with how long the pass actually ran.
      clock: () => 4_001,
    });

    // The worker defers delivery for a later probe: no applied closure, no
    // blind redrive of the append, no permanent failure.
    expect(first).toMatchObject({
      claimed: 1,
      applied: 0,
      failed: 0,
      requeued: 0,
      deferred: 1,
      responseLossRecovered: 0,
    });
    expect(gateway.orphanProbeReads).toBe(1);
    expect(gateway.fastAppendCalls).toBe(0);
    await expect(readStatus(adapter, effect.effectId)).resolves.toBe("delivery_uncertain");
    const probeRow = await adapter.read(({ sql }) => sql.get<{ readonly next_probe_at: number | null }>(
      "SELECT next_probe_at FROM sheet_effect_outbox WHERE effect_id = ?",
      [effect.effectId],
    ));
    // The probe delay is exactly 1s from the controlled pass clock (4_001),
    // independent of wall time consumed by the pass.
    expect(probeRow?.next_probe_at).toBe(5_001);

    // A later pass re-probes the same orphan instead of blindly redriving:
    // the append is never re-dispatched and the outbox row stays open. 5_002
    // is deterministically past the recorded 5_001 probe time, so the effect
    // is always selected and re-probed.
    const second = await runSyncEffectWorkerWithAdapter({
      storage: adapter,
      gateway,
      workerId: "orphan-worker",
      now: 5_002,
      maxEffects: 1,
    });
    expect(second).toMatchObject({
      claimed: 1,
      applied: 0,
      failed: 0,
      requeued: 0,
      deferred: 1,
    });
    expect(gateway.orphanProbeReads).toBe(2);
    expect(gateway.fastAppendCalls).toBe(0);
    await expect(readStatus(adapter, effect.effectId)).resolves.toBe("delivery_uncertain");
  });

  it("terminally records an explicit structured remote failure", async () => {
    const result = await runWorkerWithThrownGateway(openOrms, new AppsScriptSyncGatewayError(
      SYNC_GATEWAY_CLIENT_ERROR_CODES.REMOTE_ERROR,
      "the gateway rejected the signed envelope before any operation ran",
      presentValue(409),
      presentValue("invalid_signature"),
    ));

    expect(result.report).toMatchObject({
      claimed: 1,
      applied: 0,
      failed: 1,
      responseLossRecovered: 0,
      requeued: 0,
    });
    expect(result.gateway.postconditionBatchReads).toBe(0);
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("gateway_remote_error");
  });

  it("recovers a partial remote write followed by an ambiguous batch failure", async () => {
    const orm = await createOrm();
    openOrms.push(orm);
    const adapter = new MikroOrmSqliteAdapter(orm);
    await migrateMikroOrmSqliteSchema(adapter);
    await registerProjection(adapter);
    const claim = await claimWriterLeaseWithAdapter(adapter, {
      role: "sync-effect-worker",
      writerId: "partial-batch-worker",
      leaseDurationMs: 10_000,
      now: 5_000,
    });
    if (claim.kind !== WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED) throw new Error("Expected a writer lease");
    const fence = {
      role: claim.lease.role,
      writerEpoch: claim.lease.writerEpoch,
      fencingToken: claim.lease.fencingToken,
      now: 5_000,
    };
    const first = createEffect("partial-first", undefined, { includeId: true });
    const second = createEffect("partial-second", undefined, { includeId: true });
    await expect(appendPendingEffectsWithAdapter(adapter, fence, [first, second])).resolves.toBe(true);

    const gateway = new PartialBatchFailureGateway();
    const report = await runSyncEffectWorkerWithAdapter({
      storage: adapter,
      gateway,
      workerId: "partial-batch-worker",
      now: 5_001,
      maxEffects: 2,
    });

    expect(report).toMatchObject({
      claimed: 2,
      applied: 1,
      failed: 0,
      requeued: 1,
      responseLossRecovered: 1,
    });
    await expect(readStatus(adapter, first.effectId)).resolves.toBe("applied");
    await expect(readStatus(adapter, second.effectId)).resolves.toBe("pending");
    expect(gateway.postconditionBatchReads).toBe(1);
  });

  it.each([
    [
      "timeout",
      new AppsScriptSyncGatewayError(
        SYNC_GATEWAY_CLIENT_ERROR_CODES.TIMEOUT,
        "request timed out",
        presentValue(504),
      ),
    ],
    [
      "non-json response",
      new AppsScriptSyncGatewayError(
        SYNC_GATEWAY_CLIENT_ERROR_CODES.INVALID_RESPONSE,
        "response was not JSON",
        presentValue(502),
      ),
    ],
    ["unknown error", new Error("connection dropped")],
    [
      "structured operation_failed at HTTP 200",
      new AppsScriptSyncGatewayError(
        SYNC_GATEWAY_CLIENT_ERROR_CODES.REMOTE_ERROR,
        "the batch aborted after a partial remote write",
        presentValue(200),
        presentValue("operation_failed"),
      ),
    ],
    [
      "structured internal_error at HTTP 200",
      new AppsScriptSyncGatewayError(
        SYNC_GATEWAY_CLIENT_ERROR_CODES.REMOTE_ERROR,
        "the gateway handler failed after the operation ran",
        presentValue(200),
        presentValue("internal_error"),
      ),
    ],
  ])("recovers %s through postcondition inspection", async (_label, error) => {
    const result = await runWorkerWithThrownGateway(openOrms, error);

    expect(result.report.failed).toBe(0);
    expect(result.report.requeued).toBe(1);
    expect(result.gateway.postconditionBatchReads).toBe(1);
    expect(result.status).toBe("pending");
  });

  it("recovers a fast append that reports applied without receipt evidence", async () => {
    const orm = await createOrm();
    openOrms.push(orm);
    const adapter = new MikroOrmSqliteAdapter(orm);
    await migrateMikroOrmSqliteSchema(adapter);
    await registerProjection(adapter);

    const claim = await claimWriterLeaseWithAdapter(adapter, {
      role: "sync-effect-worker",
      writerId: "fast-evidence-worker",
      leaseDurationMs: 10_000,
      now: 2_500,
    });
    if (claim.kind !== "claimed") throw new Error("Expected a writer lease");
    const fence = {
      role: claim.lease.role,
      writerEpoch: claim.lease.writerEpoch,
      fencingToken: claim.lease.fencingToken,
      now: 2_500,
    };
    const effect = createEffect("fast-evidence", 1, { includeId: true });
    await expect(appendPendingEffectsWithAdapter(adapter, fence, [effect])).resolves.toBe(true);

    const gateway = new EvidenceOmittingFastAppendGateway();
    const report = await runSyncEffectWorkerWithAdapter({
      storage: adapter,
      gateway,
      workerId: "fast-evidence-worker",
      now: 2_501,
      maxEffects: 1,
    });

    expect(report).toMatchObject({
      claimed: 1,
      applied: 1,
      responseLossRecovered: 1,
      failed: 0,
    });
    expect(gateway.fastAppendCalls).toBe(1);
    expect(gateway.postconditionBatchReads).toBe(1);
    await expect(readStatus(adapter, effect.effectId)).resolves.toBe("applied");
  });

  it("does not replay a receipt-only append when a non-delete row was manually removed", async () => {
    const orm = await createOrm();
    openOrms.push(orm);
    const adapter = new MikroOrmSqliteAdapter(orm);
    await migrateMikroOrmSqliteSchema(adapter);
    await registerProjection(adapter);

    const claim = await claimWriterLeaseWithAdapter(adapter, {
      role: "manual-repair-worker",
      writerId: "manual-repair-worker",
      leaseDurationMs: 10_000,
      now: 2_700,
    });
    if (claim.kind !== "claimed") throw new Error("Expected a writer lease");
    const fence = {
      role: claim.lease.role,
      writerEpoch: claim.lease.writerEpoch,
      fencingToken: claim.lease.fencingToken,
      now: 2_700,
    };
    const effect = createEffect("manual-repair", 1, { includeId: true });
    await expect(appendPendingEffectsWithAdapter(adapter, fence, [effect])).resolves.toBe(true);

    const gateway = new FakeSyncSheetGateway([
      {
        physicalSheetId: "physical-recovery",
        sheetName: "Orders",
        registeredRange: "A:B",
        projection: "system_state",
        schemaVersion: 1,
        headers: ["id", "status"],
      },
    ]);
    gateway.dropNextResponseAfterApply();
    await gateway.fastAppendRows({
      physicalSheetId: "physical-recovery",
      sheetName: "Orders",
      registeredRange: "A:B",
      projection: "system_state",
      schemaVersion: 1,
      rows: [{
        effectId: effect.effectId,
        payloadHash: effect.payloadHash,
        anchor: "manual-repair-anchor",
        fields: {
          id: { kind: "string", value: "order-manual-repair" },
          status: { kind: "string", value: "paid" },
        },
      }],
    }).catch(() => undefined);
    // The built-in append path never materialized the advisory anchor, so a
    // manual deletion of the appended row is located by registered identity.
    gateway.removeRowByIdentity("physical-recovery", "order-manual-repair");

    // Seed the durable effect as failed/recoverable after the simulated
    // response loss so the worker exercises the postcondition path directly.
    await adapter.transaction(({ sql }) => sql.run(
      "UPDATE sheet_effect_outbox SET status = 'failed', last_error_code = ? WHERE effect_id = ?",
      ["postcondition_unavailable", effect.effectId],
    ));
    const first = await runSyncEffectWorkerWithAdapter({
      storage: adapter,
      gateway,
      workerId: "manual-repair-worker",
      now: 2_701,
      maxEffects: 1,
    });
    const second = await runSyncEffectWorkerWithAdapter({
      storage: adapter,
      gateway,
      workerId: "manual-repair-worker",
      now: 2_702,
      maxEffects: 1,
    });

    expect(first.failed).toBe(1);
    expect(second.selected).toBe(0);
    expect(gateway.fastAppendCalls).toBe(1);
    await expect(readStatus(adapter, effect.effectId)).resolves.toBe("failed");
    await expect(adapter.read(({ sql }) => sql.get<{ readonly last_error_code: string }>(
      "SELECT last_error_code FROM sheet_effect_outbox WHERE effect_id = ?",
      [effect.effectId],
    ))).resolves.toEqual({ last_error_code: "postcondition_changed" });
  });

  it("retries a lost fast-append response through the registered identity", async () => {
    const orm = await createOrm();
    openOrms.push(orm);
    const adapter = new MikroOrmSqliteAdapter(orm);
    await migrateMikroOrmSqliteSchema(adapter);
    await registerProjection(adapter);

    const claim = await claimWriterLeaseWithAdapter(adapter, {
      role: "sync-effect-worker",
      writerId: "fast-loss-worker",
      leaseDurationMs: 10_000,
      now: 3_000,
    });
    if (claim.kind !== "claimed") throw new Error("Expected a writer lease");
    const fence = {
      role: claim.lease.role,
      writerEpoch: claim.lease.writerEpoch,
      fencingToken: claim.lease.fencingToken,
      now: 3_000,
    };
    const effect = createEffect("fast-loss", 1, { includeId: true });
    await expect(appendPendingEffectsWithAdapter(adapter, fence, [effect])).resolves.toBe(true);

    const gateway = new FakeSyncSheetGateway([
      {
        physicalSheetId: "physical-recovery",
        sheetName: "Orders",
        registeredRange: "A:B",
        projection: "system_state",
        schemaVersion: 1,
        headers: ["id", "status"],
      },
    ]);
    gateway.dropNextResponseAfterApply();

    await expect(runSyncEffectWorkerWithAdapter({
      storage: adapter,
      gateway,
      workerId: "fast-loss-worker",
      now: 3_001,
      maxEffects: 1,
    })).resolves.toMatchObject({ applied: 1, failed: 0, responseLossRecovered: 1 });
    await expect(readStatus(adapter, effect.effectId)).resolves.toBe("applied");

    await expect(runSyncEffectWorkerWithAdapter({
      storage: adapter,
      gateway,
      workerId: "fast-loss-worker",
      now: 3_002,
      maxEffects: 1,
    })).resolves.toMatchObject({ selected: 0, applied: 0, failed: 0 });
    expect(gateway.fastAppendCalls).toBe(1);
    await expect(readStatus(adapter, effect.effectId)).resolves.toBe("applied");
  });
});

async function createOrm() {
  const orm = await MikroORM.init({
    driver: SqliteDriver,
    dbName: ":memory:",
    driverOptions: new NodeSqliteDialect(":memory:"),
    entities: [Entity],
  });
  await orm.schema.create();
  return orm;
}

type RecoveryOrm = Awaited<ReturnType<typeof createOrm>>;

async function runWorkerWithThrownGateway(
  openOrms: RecoveryOrm[],
  error: Error,
): Promise<{
  readonly report: Awaited<ReturnType<typeof runSyncEffectWorkerWithAdapter>>;
  readonly gateway: ThrowingEffectGateway;
  readonly status: string | undefined;
  readonly errorCode: string | null | undefined;
}> {
  const orm = await createOrm();
  openOrms.push(orm);
  const adapter = new MikroOrmSqliteAdapter(orm);
  await migrateMikroOrmSqliteSchema(adapter);
  await registerProjection(adapter);
  const claim = await claimWriterLeaseWithAdapter(adapter, {
    role: "sync-effect-worker",
    writerId: "dispatch-classification-worker",
    leaseDurationMs: 10_000,
    now: 4_000,
  });
  if (claim.kind !== "claimed") throw new Error("Expected a writer lease");
  const fence = {
    role: claim.lease.role,
    writerEpoch: claim.lease.writerEpoch,
    fencingToken: claim.lease.fencingToken,
    now: 4_000,
  };
  const effect = createEffect("dispatch-classification");
  await expect(appendPendingEffectsWithAdapter(adapter, fence, [effect])).resolves.toBe(true);
  const gateway = new ThrowingEffectGateway(error);
  const report = await runSyncEffectWorkerWithAdapter({
    storage: adapter,
    gateway,
    workerId: "dispatch-classification-worker",
    now: 4_001,
    maxEffects: 1,
  });
  const row = await adapter.read(({ sql }) => sql.get<{
    readonly status: string;
    readonly last_error_code: string | null;
  }>(
    "SELECT status, last_error_code FROM sheet_effect_outbox WHERE effect_id = ?",
    [effect.effectId],
  ));
  return {
    report,
    gateway,
    status: row?.status,
    errorCode: row?.last_error_code,
  };
}

class EvidenceOmittingFastAppendGateway extends FakeSyncSheetGateway {
  public constructor() {
    super([{
      physicalSheetId: "physical-recovery",
      sheetName: "Orders",
      registeredRange: "A:B",
      projection: "system_state",
      schemaVersion: 1,
      headers: ["id", "status"],
    }]);
  }

  public override async fastAppendRows(
    request: Parameters<FakeSyncSheetGateway["fastAppendRows"]>[0],
  ): ReturnType<FakeSyncSheetGateway["fastAppendRows"]> {
    const response = await super.fastAppendRows(request);
    return {
      ...response,
      results: response.results.map(({ effectId, status }) => ({ effectId, status })),
    };
  }
}

/**
 * Models the two-flush append orphan: the target row exists at the target
 * hash, but the receipt write never landed, so the gateway probe stays
 * fail-closed instead of claiming an applied closure.
 */
class ReceiptLessOrphanGateway extends FakeSyncSheetGateway {
  public orphanProbeReads = 0;

  public constructor() {
    super([{
      physicalSheetId: "physical-recovery",
      sheetName: "Orders",
      registeredRange: "A:B",
      projection: "system_state",
      schemaVersion: 1,
      headers: ["status"],
    }]);
  }

  public override async readEffectPostcondition(
    effect: Parameters<FakeSyncSheetGateway["readEffectPostcondition"]>[0],
  ): ReturnType<FakeSyncSheetGateway["readEffectPostcondition"]> {
    return {
      disposition: SYNC_GATEWAY_POSTCONDITION_DISPOSITIONS.UNAVAILABLE,
      visibleRevision: absentValue(),
      visibleHash: absentValue(),
      snapshotHash: absentValue(),
      reason: "receipt_missing",
    };
  }

  public override async readEffectPostconditions(
    request: Parameters<FakeSyncSheetGateway["readEffectPostconditions"]>[0],
  ): ReturnType<FakeSyncSheetGateway["readEffectPostconditions"]> {
    this.orphanProbeReads += 1;
    return Promise.all(request.effects.map(async (effect) => ({
      effectId: effect.effectId,
      payloadHash: effect.payloadHash,
      postcondition: await this.readEffectPostcondition(effect),
    })));
  }
}

class ThrowingEffectGateway extends FakeSyncSheetGateway {
  public constructor(private readonly thrown: Error) {
    super([{
      physicalSheetId: "physical-recovery",
      sheetName: "Orders",
      registeredRange: "A:B",
      projection: "system_state",
      schemaVersion: 1,
      headers: ["status"],
    }]);
  }

  public override async applyEffects(
    _request: Parameters<FakeSyncSheetGateway["applyEffects"]>[0],
  ): Promise<Awaited<ReturnType<FakeSyncSheetGateway["applyEffects"]>>> {
    throw this.thrown;
  }

  public override async fastAppendRows(
    _request: Parameters<FakeSyncSheetGateway["fastAppendRows"]>[0],
  ): Promise<Awaited<ReturnType<FakeSyncSheetGateway["fastAppendRows"]>>> {
    throw this.thrown;
  }
}

/** Applies one append from a batch, then reports a structured batch failure. */
class PartialBatchFailureGateway extends FakeSyncSheetGateway {
  public constructor() {
    super([{
      physicalSheetId: "physical-recovery",
      sheetName: "Orders",
      registeredRange: "A:B",
      projection: "system_state",
      schemaVersion: 1,
      headers: ["id", "status"],
    }]);
  }

  public override async fastAppendRows(
    request: Parameters<FakeSyncSheetGateway["fastAppendRows"]>[0],
  ): ReturnType<FakeSyncSheetGateway["fastAppendRows"]> {
    await super.fastAppendRows({ ...request, rows: request.rows.slice(0, 1) });
    throw new AppsScriptSyncGatewayError(
      SYNC_GATEWAY_CLIENT_ERROR_CODES.REMOTE_ERROR,
      "batch operation failed after a partial remote write",
      presentValue(502),
      presentValue("operation_failed"),
    );
  }
}

async function registerProjection(adapter: MikroOrmSqliteAdapter): Promise<void> {
  await adapter.transaction(async ({ sql }) => {
    await sql.run(
      "INSERT INTO sheet_registry (sheet_id, schema_version, ownership_manifest_json, business_key_field) VALUES (?, ?, ?, ?)",
      ["logical-recovery", 1, "{}", "id"],
    );
    await sql.run(
      "INSERT INTO physical_sheet_registry (physical_sheet_id, logical_sheet_id, spreadsheet_id, tab_name, registered_range, projection, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["physical-recovery", "logical-recovery", "spreadsheet", "Orders", "A:B", "system_state", 1],
    );
  });
}

function createEffect(
  suffix = "recovery",
  streamSequence = 1,
  options: { readonly includeId?: boolean } = {},
): NewEffect {
  const targetId = `order-${suffix}`;
  // The fast append path locates rows through the registered identity, so
  // effects dispatched that way carry the business key matching targetId.
  const nextFields = options.includeId === true
    ? {
      id: { kind: "string" as const, value: targetId },
      status: { kind: "string" as const, value: "paid" },
    }
    : { status: { kind: "string" as const, value: "paid" } };
  return {
    effectId: `effect-${suffix}`,
    effectKind: "system_projection",
    commitId: `commit-${suffix}`,
    logicalSheetId: "logical-recovery",
    physicalSheetId: "physical-recovery",
    projection: "system_state",
    rowBindingId: { kind: PRESENCE_KINDS.ABSENT },
    conflictId: { kind: PRESENCE_KINDS.ABSENT },
    targetKind: "entity",
    targetId,
    targetEntityRevision: { kind: APPLICABILITY_KINDS.APPLICABLE, value: 1 },
    targetFieldRevisionHash: { kind: APPLICABILITY_KINDS.NOT_APPLICABLE },
    targetCanonicalCommitId: { kind: APPLICABILITY_KINDS.NOT_APPLICABLE },
    expectedVisibleRevision: 0,
    expectedVisibleHash: "",
    repairGuardHash: { kind: PRESENCE_KINDS.ABSENT },
    sourceQuarantineId: { kind: PRESENCE_KINDS.ABSENT },
    payloadJson: serializeSyncProjectionEffectPayload({
      sheetName: "Orders",
      registeredRange: "A:B",
      schemaVersion: 1,
      targetAnchor: `${suffix}-anchor`,
      fields: nextFields,
      targetVisibleHash: computeSyncVisibleHash(nextFields),
      createIfMissing: true,
      expectedCandidateHash: { kind: APPLICABILITY_KINDS.NOT_APPLICABLE },
    }),
    payloadHash: `payload-${suffix}`,
    effectDedupeKey: `dedupe-${suffix}`,
    streamSequence,
  };
}

async function readStatus(adapter: MikroOrmSqliteAdapter, effectId: string): Promise<string | undefined> {
  const row = await adapter.read(({ sql }) => sql.get<{ status: string }>(
    "SELECT status FROM sheet_effect_outbox WHERE effect_id = ?",
    [effectId],
  ));
  return row?.status;
}
