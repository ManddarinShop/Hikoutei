import {
  defineEntity,
  MikroORM,
  NodeSqliteDialect,
  p,
  SqliteDriver,
} from "@mikro-orm/sql";
import { afterEach, describe, expect, it } from "vitest";

import { APPLICABILITY_KINDS, PRESENCE_KINDS } from "../src/shared/state/constants.js";
import {
  appendPendingEffectsWithAdapter,
  claimWriterLeaseWithAdapter,
  type NewEffect,
  type PendingEffect,
} from "../src/infrastructure/storage/index.js";
import {
  computeSyncVisibleHash,
  serializeSyncProjectionEffectPayload,
  type SyncGatewayEffect,
} from "../src/application/sync/gateway/syncGateway.js";
import {
  chunkGatewayEffectGroups,
  groupByGatewayRequest,
} from "../src/application/sync/outbound/effects/SyncEffectWorkerRouting.js";
import { GATEWAY_EFFECT_BATCH_LIMIT } from "../src/application/sync/outbound/effects/SyncEffectWorkerConstants.js";
import type { ClaimedEffect } from "../src/application/sync/outbound/effects/SyncEffectWorker.js";
import { runSyncEffectWorkerWithAdapter } from "../src/application/sync/outbound/effects/SyncEffectWorker.js";
import { FakeSyncSheetGateway } from "./support/FakeSyncSheetGateway.js";
import { MikroOrmSqliteAdapter } from "../src/adapter/persistence/providers/mikro-orm/storage/MikroOrmSqliteAdapter.js";
import { migrateMikroOrmSqliteSchema } from "../src/adapter/persistence/providers/mikro-orm/storage/MikroOrmSqliteSchema.js";

const PerfOrderSchema = defineEntity({
  name: "OutboundPerfOrder",
  tableName: "outbound_perf_order",
  properties: {
    id: p.string().primary(),
    status: p.string(),
  },
});

class PerfOrder extends PerfOrderSchema.class {
  declare id: string;
  declare status: string;
}

PerfOrderSchema.setClass(PerfOrder);

interface RouteSpec {
  readonly physicalSheetId: string;
  readonly sheetName: string;
  readonly registeredRange: string;
  readonly projection: "system_state";
  readonly schemaVersion: number;
}

const ROUTE_ALPHA: RouteSpec = {
  physicalSheetId: "physical-alpha",
  sheetName: "Orders",
  registeredRange: "A:B",
  projection: "system_state",
  schemaVersion: 1,
};

const ROUTE_BETA: RouteSpec = {
  physicalSheetId: "physical-beta",
  sheetName: "ConflictLog",
  registeredRange: "A:B",
  projection: "system_state",
  schemaVersion: 1,
};

describe("outbound effect dispatch batching", () => {
  describe("route grouping and predecessor order", () => {
    it("groups effects by physical route and preserves selection order", () => {
      // Input order intentionally interleaves two routes; grouping must keep
      // each route together and preserve the per-route predecessor order.
      const items = [
        makeItem(ROUTE_ALPHA, "a-1"),
        makeItem(ROUTE_BETA, "b-1"),
        makeItem(ROUTE_ALPHA, "a-2"),
        makeItem(ROUTE_BETA, "b-2"),
        makeItem(ROUTE_ALPHA, "a-3"),
      ];

      const groups = groupByGatewayRequest(items);

      expect(groups).toHaveLength(2);
      const alpha = groups.find((group) => group.items[0]!.pending.effect_id === "a-1")!;
      const beta = groups.find((group) => group.items[0]!.pending.effect_id === "b-1")!;
      expect(ids(alpha)).toEqual(["a-1", "a-2", "a-3"]);
      expect(ids(beta)).toEqual(["b-1", "b-2"]);
      // Each route keeps a single gateway request carrying all of its effects.
      expect(alpha.request.effects.map((effect) => effect.effectId)).toEqual(["a-1", "a-2", "a-3"]);
      expect(beta.request.effects.map((effect) => effect.effectId)).toEqual(["b-1", "b-2"]);
    });

    it("chunks an oversized route at the Apps Script bounded effect batch", () => {
      const oversized = Array.from({ length: GATEWAY_EFFECT_BATCH_LIMIT * 2 + 5 }, (_, index) =>
        makeItem(ROUTE_ALPHA, `a-${index}`),
      );

      const chunked = chunkGatewayEffectGroups(groupByGatewayRequest(oversized));

      // Every chunk fits inside the gateway batch so applyEffects returns a
      // complete result set (hasMore=false) instead of a partial prefix.
      expect(chunked).toHaveLength(3);
      expect(chunked.map((group) => group.items.length)).toEqual([
        GATEWAY_EFFECT_BATCH_LIMIT,
        GATEWAY_EFFECT_BATCH_LIMIT,
        5,
      ]);
      // Selection order is preserved across chunks; no effect is dropped.
      expect(chunked.flatMap(ids)).toEqual(oversized.map((item) => item.pending.effect_id));
      for (const group of chunked) {
        expect(group.request.effects).toHaveLength(group.items.length);
        expect(group.request.physicalSheetId).toBe(ROUTE_ALPHA.physicalSheetId);
      }
    });

    it("leaves a route that already fits the batch as a single group", () => {
      const items = Array.from({ length: GATEWAY_EFFECT_BATCH_LIMIT }, (_, index) =>
        makeItem(ROUTE_ALPHA, `a-${index}`),
      );

      const chunked = chunkGatewayEffectGroups(groupByGatewayRequest(items));

      expect(chunked).toHaveLength(1);
      expect(chunked[0]!.items).toHaveLength(GATEWAY_EFFECT_BATCH_LIMIT);
    });

    it("preserves physical-route grouping across distinct routes when chunking", () => {
      const items = [
        ...Array.from({ length: GATEWAY_EFFECT_BATCH_LIMIT + 3 }, (_, index) =>
          makeItem(ROUTE_ALPHA, `a-${index}`),
        ),
        ...Array.from({ length: 2 }, (_, index) => makeItem(ROUTE_BETA, `b-${index}`)),
      ];

      const chunked = chunkGatewayEffectGroups(groupByGatewayRequest(items));

      expect(chunked).toHaveLength(3);
      expect(chunked[0]!.request.physicalSheetId).toBe(ROUTE_ALPHA.physicalSheetId);
      expect(chunked[0]!.items).toHaveLength(GATEWAY_EFFECT_BATCH_LIMIT);
      expect(chunked[1]!.request.physicalSheetId).toBe(ROUTE_ALPHA.physicalSheetId);
      expect(chunked[1]!.items).toHaveLength(3);
      expect(chunked[2]!.request.physicalSheetId).toBe(ROUTE_BETA.physicalSheetId);
      expect(chunked[2]!.items).toHaveLength(2);
    });
  });

  describe("batch-cap draining through the worker", () => {
    const openOrms: Array<Awaited<ReturnType<typeof createOrm>>> = [];

    afterEach(async () => {
      await Promise.all(openOrms.splice(0).map((orm) => orm.close(true)));
    });

    it("drains an oversized route in bounded passes without partial-response churn", async () => {
      const count = GATEWAY_EFFECT_BATCH_LIMIT * 2 + 5; // 45 effects on one route
      const orm = await createOrm();
      openOrms.push(orm);
      const adapter = new MikroOrmSqliteAdapter(orm);
      await migrateMikroOrmSqliteSchema(adapter);
      await registerProjection(adapter);

      await seedEffects(adapter, count);

      // The fake gateway caps each applyEffects call at the Apps Script batch
      // limit, exactly like the deployed Code.gs MAX_EFFECTS guard.
      const gateway = new FakeSyncSheetGateway(
        [
          {
            physicalSheetId: "physical-perf",
            sheetName: "Orders",
            registeredRange: "A:B",
            projection: "system_state",
            schemaVersion: 1,
            headers: ["status"],
            rows: perfRows(count),
          },
        ],
        { maxEffectsPerApply: GATEWAY_EFFECT_BATCH_LIMIT },
      );

      // An oversized configured worker limit (50) remains a SQLite selection
      // upper bound; only the bounded in-flight window is leased per pass.
      const reports = [];
      for (let pass = 0; pass < 3; pass += 1) {
        reports.push(await runSyncEffectWorkerWithAdapter({
          storage: adapter,
          gateway,
          workerId: "perf-worker",
          now: 1_000 + pass,
          maxEffects: count + 5,
        }));
      }

      expect(reports[0]).toMatchObject({
        selected: GATEWAY_EFFECT_BATCH_LIMIT,
        claimed: GATEWAY_EFFECT_BATCH_LIMIT,
        applied: GATEWAY_EFFECT_BATCH_LIMIT,
        deferred: 0,
        requeued: 0,
        failed: 0,
      });
      expect(reports.reduce((sum, report) => sum + report.applied, 0)).toBe(count);
      // One bounded applyEffects call per leased window.
      expect(gateway.applyEffectsCalls).toBe(3);
      expect(gateway.fastAppendCalls).toBe(0);
      await expect(allApplied(adapter, count)).resolves.toBe(true);
    });

    it("recovers a regular-path response loss through batched postcondition read-back", async () => {
      const orm = await createOrm();
      openOrms.push(orm);
      const adapter = new MikroOrmSqliteAdapter(orm);
      await migrateMikroOrmSqliteSchema(adapter);
      await registerProjection(adapter);

      await seedEffects(adapter, 1);

      const gateway = new FakeSyncSheetGateway([
        {
          physicalSheetId: "physical-perf",
          sheetName: "Orders",
          registeredRange: "A:B",
          projection: "system_state",
          schemaVersion: 1,
          headers: ["status"],
          rows: perfRows(1),
        },
      ]);
      // The remote write completes before the response is dropped; the worker
      // must still close the effect by reading the postcondition back.
      gateway.dropNextResponseAfterApply();

      const report = await runSyncEffectWorkerWithAdapter({
        storage: adapter,
        gateway,
        workerId: "perf-worker",
        now: 1_000,
        maxEffects: 1,
      });

      expect(report).toMatchObject({
        claimed: 1,
        applied: 1,
        responseLossRecovered: 1,
        requeued: 0,
        failed: 0,
      });
      expect(gateway.applyEffectsCalls).toBe(1);
      expect(gateway.postconditionBatchReads).toBe(1);
      await expect(allApplied(adapter, 1)).resolves.toBe(true);
    });

    it("converges a backlog across passes while preserving route order", async () => {
      const count = GATEWAY_EFFECT_BATCH_LIMIT + 7; // 27 effects, two chunks + remainder
      const orm = await createOrm();
      openOrms.push(orm);
      const adapter = new MikroOrmSqliteAdapter(orm);
      await migrateMikroOrmSqliteSchema(adapter);
      await registerProjection(adapter);

      await seedEffects(adapter, count);

      const gateway = new FakeSyncSheetGateway(
        [
          {
            physicalSheetId: "physical-perf",
            sheetName: "Orders",
            registeredRange: "A:B",
            projection: "system_state",
            schemaVersion: 1,
            headers: ["status"],
            rows: perfRows(count),
          },
        ],
        { maxEffectsPerApply: GATEWAY_EFFECT_BATCH_LIMIT },
      );

      // A worker limit smaller than the backlog must still converge: chunked
      // dispatch within each pass keeps every request inside the gateway batch.
      const first = await runSyncEffectWorkerWithAdapter({
        storage: adapter,
        gateway,
        workerId: "perf-worker",
        now: 1_000,
        maxEffects: 10,
      });
      expect(first.applied).toBe(10);
      expect(first.deferred).toBe(0);

      const second = await runSyncEffectWorkerWithAdapter({
        storage: adapter,
        gateway,
        workerId: "perf-worker",
        now: 1_001,
        maxEffects: 10,
      });
      expect(second.applied).toBe(10);
      expect(second.deferred).toBe(0);

      const third = await runSyncEffectWorkerWithAdapter({
        storage: adapter,
        gateway,
        workerId: "perf-worker",
        now: 1_002,
        maxEffects: 10,
      });
      expect(third.applied).toBe(7);
      expect(third.deferred).toBe(0);
      expect(third.failed).toBe(0);

      await expect(allApplied(adapter, count)).resolves.toBe(true);
    });
  });
});

function makeItem(route: RouteSpec, effectId: string): ClaimedEffect {
  const fields = { status: { kind: "string" as const, value: "paid" } };
  const gatewayEffect: SyncGatewayEffect = {
    effectId,
    payloadHash: `payload-${effectId}`,
    effectKind: "system_projection",
    physicalSheetId: route.physicalSheetId,
    projection: route.projection,
    targetKind: "entity",
    targetId: effectId,
    rowBindingId: { kind: PRESENCE_KINDS.ABSENT },
    conflictId: { kind: PRESENCE_KINDS.ABSENT },
    expectedVisibleRevision: 1,
    expectedVisibleHash: "",
    repairGuardHash: { kind: PRESENCE_KINDS.ABSENT },
    payload: {
      sheetName: route.sheetName,
      registeredRange: route.registeredRange,
      schemaVersion: route.schemaVersion,
      targetAnchor: `${effectId}-anchor`,
      fields,
      targetVisibleHash: computeSyncVisibleHash(fields),
      createIfMissing: false,
      expectedCandidateHash: { kind: APPLICABILITY_KINDS.NOT_APPLICABLE },
    },
  };
  return {
    pending: { effect_id: effectId, payload_hash: `payload-${effectId}` } as PendingEffect,
    claimToken: `claim-${effectId}`,
    gatewayEffect: { kind: PRESENCE_KINDS.PRESENT, value: gatewayEffect },
    invalidPayloadError: { kind: PRESENCE_KINDS.ABSENT },
  };
}

function ids(group: { items: readonly ClaimedEffect[] }): string[] {
  return group.items.map((item) => item.pending.effect_id);
}

async function createOrm() {
  const orm = await MikroORM.init({
    driver: SqliteDriver,
    dbName: ":memory:",
    driverOptions: new NodeSqliteDialect(":memory:"),
    entities: [PerfOrder],
  });
  await orm.schema.create();
  return orm;
}

async function registerProjection(adapter: MikroOrmSqliteAdapter): Promise<void> {
  await adapter.transaction(async ({ sql }) => {
    await sql.run(
      "INSERT INTO sheet_registry (sheet_id, schema_version, ownership_manifest_json, business_key_field) VALUES (?, ?, ?, ?)",
      ["logical-perf", 1, "{}", "id"],
    );
    await sql.run(
      "INSERT INTO physical_sheet_registry (physical_sheet_id, logical_sheet_id, spreadsheet_id, tab_name, registered_range, projection, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["physical-perf", "logical-perf", "spreadsheet", "Orders", "A:B", "system_state", 1],
    );
  });
}

async function seedEffects(adapter: MikroOrmSqliteAdapter, count: number): Promise<void> {
  const claim = await claimWriterLeaseWithAdapter(adapter, {
    role: "sync-effect-worker",
    writerId: "perf-worker",
    leaseDurationMs: 10_000,
    now: 500,
  });
  if (claim.kind !== "claimed") throw new Error("Expected a writer lease");
  const fence = {
    role: claim.lease.role,
    writerEpoch: claim.lease.writerEpoch,
    fencingToken: claim.lease.fencingToken,
    now: 500,
  };
  const effects = Array.from({ length: count }, (_, index) => createUpdateEffect(index, index + 1));
  await expect(appendPendingEffectsWithAdapter(adapter, fence, effects)).resolves.toBe(true);
}

function createUpdateEffect(index: number, streamSequence: number): NewEffect {
  const currentFields = { status: { kind: "string" as const, value: "pending" } };
  const nextFields = { status: { kind: "string" as const, value: "paid" } };
  return {
    effectId: `effect-${index}`,
    effectKind: "system_projection",
    commitId: `commit-${index}`,
    logicalSheetId: "logical-perf",
    physicalSheetId: "physical-perf",
    projection: "system_state",
    rowBindingId: { kind: PRESENCE_KINDS.ABSENT },
    conflictId: { kind: PRESENCE_KINDS.ABSENT },
    targetKind: "entity",
    targetId: `order-${index}`,
    targetEntityRevision: { kind: APPLICABILITY_KINDS.APPLICABLE, value: 1 },
    targetFieldRevisionHash: { kind: APPLICABILITY_KINDS.NOT_APPLICABLE },
    targetCanonicalCommitId: { kind: APPLICABILITY_KINDS.NOT_APPLICABLE },
    expectedVisibleRevision: 0,
    expectedVisibleHash: computeSyncVisibleHash(currentFields),
    repairGuardHash: { kind: PRESENCE_KINDS.ABSENT },
    sourceQuarantineId: { kind: PRESENCE_KINDS.ABSENT },
    payloadJson: serializeSyncProjectionEffectPayload({
      sheetName: "Orders",
      registeredRange: "A:B",
      schemaVersion: 1,
      targetAnchor: `row-${index}-anchor`,
      fields: nextFields,
      targetVisibleHash: computeSyncVisibleHash(nextFields),
      createIfMissing: false,
      expectedCandidateHash: { kind: APPLICABILITY_KINDS.NOT_APPLICABLE },
    }),
    payloadHash: `payload-${index}`,
    effectDedupeKey: `dedupe-${index}`,
    streamSequence,
  };
}

function perfRows(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    targetId: `order-${index}`,
    physicalAnchor: `row-${index}-anchor`,
    fields: { status: { kind: "string" as const, value: "pending" } },
    visibleRevision: 0,
  }));
}

async function allApplied(adapter: MikroOrmSqliteAdapter, count: number): Promise<boolean> {
  const rows = await adapter.read(({ sql }) => sql.all<{ status: string }>(
    "SELECT status FROM sheet_effect_outbox ORDER BY effect_id",
  ));
  return rows.length === count && rows.every((row) => row.status === "applied");
}
