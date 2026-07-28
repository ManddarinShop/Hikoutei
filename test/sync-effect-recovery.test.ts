import {
  defineEntity,
  MikroORM,
  NodeSqliteDialect,
  p,
  SqliteDriver,
} from "@mikro-orm/sql";
import { afterEach, describe, expect, it } from "vitest";

import {
  APPLICABILITY_KINDS,
  appendPendingEffectsWithAdapter,
  claimWriterLeaseWithAdapter,
  PRESENCE_KINDS,
} from "../src/index.js";
import {
  computeSyncVisibleHash,
  serializeSyncProjectionEffectPayload,
} from "../src/application/sync/gateway/syncGateway.js";
import { runSyncEffectWorkerWithAdapter } from "../src/application/sync/outbound/effects/SyncEffectWorker.js";
import { FakeSyncSheetGateway } from "./support/FakeSyncSheetGateway.js";
import {
  migrateMikroOrmSqliteSchema,
  MikroOrmSqliteAdapter,
} from "../src/adapter/persistence/providers/mikro-orm/index.js";
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
    const effect = createEffect();
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
        headers: ["status"],
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
      now: 1_002,
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

  it("retries a lost fast-append response through the stable anchor", async () => {
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
    const effect = createEffect("fast-loss");
    await expect(appendPendingEffectsWithAdapter(adapter, fence, [effect])).resolves.toBe(true);

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
    gateway.dropNextResponseAfterApply();

    await expect(runSyncEffectWorkerWithAdapter({
      storage: adapter,
      gateway,
      workerId: "fast-loss-worker",
      now: 3_001,
      maxEffects: 1,
    })).resolves.toMatchObject({ applied: 0, failed: 0, requeued: 1 });
    await expect(readStatus(adapter, effect.effectId)).resolves.toBe("pending");

    await expect(runSyncEffectWorkerWithAdapter({
      storage: adapter,
      gateway,
      workerId: "fast-loss-worker",
      now: 3_002,
      maxEffects: 1,
    })).resolves.toMatchObject({ applied: 1, failed: 0 });
    expect(gateway.fastAppendCalls).toBe(2);
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

function createEffect(suffix = "recovery", streamSequence = 1): NewEffect {
  const nextFields = { status: { kind: "string" as const, value: "paid" } };
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
    targetId: `order-${suffix}`,
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
