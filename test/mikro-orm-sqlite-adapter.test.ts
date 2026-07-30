import {
  defineEntity,
  MikroORM,
  NodeSqliteDialect,
  p,
  SqliteDriver,
} from "@mikro-orm/sql";
import { afterEach, describe, expect, it } from "vitest";

import { APPLICABILITY_KINDS, LOOKUP_RESULT_KINDS, PRESENCE_KINDS } from "../src/shared/state/index.js";
import { stableHash } from "../src/shared/encoding/index.js";
import {
  FIELD_OWNERSHIPS,
  ROW_OPERATIONS,
  CONFLICT_STATUSES,
  QUARANTINE_REASONS,
} from "../src/domain/model/constants.js";
import {
  QUARANTINE_REPAIR_NOT_PLANNED_REASONS,
  QUARANTINE_REPAIR_STATUSES,
  ROW_OUTCOMES,
} from "../src/domain/evaluate/constants.js";
import {
  applyEffectResultWithAdapter,
  appendPendingEffectsWithSql,
  claimEffectWithAdapter,
  listReadyEffectsWithAdapter,
} from "../src/infrastructure/storage/sync/outbound/effectOutbox.js";
import { persistObservedRowWithAdapter } from "../src/infrastructure/storage/state/observation/observationWriter.js";
import {
  claimWriterLeaseWithAdapter,
  isFencingValidWithAdapter,
  readWriterLeaseWithAdapter,
  WRITER_LEASE_CLAIM_FAILURE_REASONS,
  WRITER_LEASE_CLAIM_RESULT_KINDS,
} from "../src/infrastructure/storage/sync/shared/writerLease.js";
import {
  CANONICAL_COMMIT_RESULT_KINDS,
  commitCanonicalChangesWithSql,
} from "../src/infrastructure/storage/state/canonical/canonicalCommit.js";
import {
  registerSyncSheetWithAdapter,
  requireRegisteredSyncSheetWithAdapter,
} from "../src/infrastructure/storage/sync/shared/syncRegistry.js";
import { persistResolutionCommandWithAdapter } from "../src/infrastructure/storage/state/resolution/resolutionWriter.js";
import type {
  NewEffect,
} from "../src/infrastructure/storage/sync/outbound/effectOutbox.js";
import type {
  PersistObservedRowInput,
} from "../src/infrastructure/storage/state/observation/observationWriter.js";
import type {
  PersistResolutionCommandInput,
} from "../src/infrastructure/storage/state/resolution/resolutionWriter.js";
import {
  initializeMikroOrmSqliteAdapter,
  migrateMikroOrmSqliteSchema,
  migrateMikroOrmSqliteStorageSchema,
  MikroOrmSqliteAdapter,
} from "../src/adapter/persistence/providers/mikro-orm/index.js";
import {
  computeSyncVisibleHash,
  serializeSyncProjectionEffectPayload,
} from "../src/application/sync/gateway/syncGateway.js";
import { runSyncEffectWorkerWithAdapter } from "../src/application/sync/outbound/effects/SyncEffectWorker.js";
import { FakeSyncSheetGateway } from "./support/FakeSyncSheetGateway.js";

const OrderSchema = defineEntity({
  name: "MikroOrmAdapterOrder",
  tableName: "mikro_orm_adapter_order",
  properties: {
    id: p.string().primary(),
    status: p.string(),
  },
});

class Order extends OrderSchema.class {
  declare id: string;
  declare status: string;
}

OrderSchema.setClass(Order);

interface OutboxRow {
  readonly id: string;
  readonly order_id: string;
  readonly effect_kind: string;
}

interface SyncOutboxRow {
  readonly effect_id: string;
  readonly target_id: string;
  readonly effect_kind: string;
}

interface AppliedEffectRow {
  readonly effect_id: string;
  readonly status: string;
}

interface VisibleFieldRow {
  readonly field_name: string;
  readonly confirmed_field_hash: string;
  readonly confirmed_visible_revision: number;
}

interface CanonicalEntityRow {
  readonly entity_id: string;
  readonly entity_revision: number;
  readonly status: string;
}

interface CanonicalFieldRow {
  readonly entity_id: string;
  readonly field_name: string;
  readonly normalized_value: string;
  readonly field_revision: number;
  readonly ownership: string;
}

interface ObservationReceiptRow {
  readonly observation_key: string;
  readonly event_id: string | null;
  readonly state: string;
}

interface QuarantineRow {
  readonly quarantine_id: string;
  readonly event_id: string | null;
  readonly observation_id: string | null;
  readonly reason: string;
}

interface ObservedEventRow {
  readonly event_id: string;
  readonly status: string;
  readonly event_sequence: number;
}

interface RowBindingStateRow {
  readonly entity_id: string | null;
  readonly state: string;
}

interface ResolutionCommandRow {
  readonly status: string;
  readonly applied_commit_id: string | null;
}

interface ConflictResolutionRow {
  readonly status: string;
  readonly resolution_command_id: string | null;
}

interface ActiveCandidateStateRow {
  readonly active_candidate_conflict_id: string | null;
  readonly active_candidate_hash: string | null;
  readonly candidate_epoch: number;
}

describe("MikroOrmSqliteAdapter", () => {
  const openOrms: Array<Awaited<ReturnType<typeof createOrm>>> = [];

  afterEach(async () => {
    await Promise.all(openOrms.splice(0).map((orm) => orm.close(true)));
  });

  it("commits an ORM entity and typed-sheets outbox SQL together", async () => {
    const orm = await createOrm();
    openOrms.push(orm);
    const adapter = new MikroOrmSqliteAdapter(orm);

    await createOutbox(adapter);

    await adapter.transactional(async ({ entityManager, sql }) => {
      const order = entityManager.create(Order, {
        id: "order-committed",
        status: "pending",
      });
      entityManager.persist(order);
      await entityManager.flush();

      const result = await sql.run(
        "INSERT INTO typed_sheets_effect_outbox (id, order_id, effect_kind) VALUES (?, ?, ?)",
        ["effect-committed", order.id, "order_upsert"],
      );

      expect(result.changes).toBe(1);
    });

    const orders = await orm.em.fork().find(Order, {});
    const effects = await adapter.read(({ sql }) => {
      return sql.all<OutboxRow>(
        "SELECT id, order_id, effect_kind FROM typed_sheets_effect_outbox ORDER BY id",
      );
    });

    expect(orders.map((order) => order.id)).toEqual(["order-committed"]);
    expect(effects).toEqual([
      {
        id: "effect-committed",
        order_id: "order-committed",
        effect_kind: "order_upsert",
      },
    ]);
  });

  it("opens a standalone MikroORM SQLite adapter without an application-owned ORM", async () => {
    const adapter = await initializeMikroOrmSqliteAdapter({
      dbName: ":memory:",
      entities: [Order],
    });

    try {
      await expect(migrateMikroOrmSqliteStorageSchema(adapter)).resolves.toEqual({
        fromVersion: 0,
        toVersion: 4,
        appliedVersions: [4],
      });
      await expect(migrateMikroOrmSqliteStorageSchema(adapter)).resolves.toEqual({
        fromVersion: 4,
        toVersion: 4,
        appliedVersions: [],
      });
      await expect(adapter.read(({ sql }) => {
        return sql.get<{ readonly name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
          ["mikro_orm_adapter_order"],
        );
      })).resolves.toEqual({ name: "mikro_orm_adapter_order" });
    } finally {
      await adapter.close(true);
    }
  });

  it("rolls the entity and raw outbox SQL back together when the transaction fails", async () => {
    const orm = await createOrm();
    openOrms.push(orm);
    const adapter = new MikroOrmSqliteAdapter(orm);

    await createOutbox(adapter);

    await expect(
      adapter.transactional(async ({ entityManager, sql }) => {
        const order = entityManager.create(Order, {
          id: "order-rolled-back",
          status: "pending",
        });
        entityManager.persist(order);
        await entityManager.flush();

        await sql.run(
          "INSERT INTO typed_sheets_effect_outbox (id, order_id, effect_kind) VALUES (?, ?, ?)",
          ["effect-rolled-back", order.id, "order_upsert"],
        );

        throw new Error("rollback requested");
      }),
    ).rejects.toThrow("rollback requested");

    expect(await orm.em.fork().find(Order, {})).toEqual([]);
    const effects = await adapter.read(({ sql }) => {
      return sql.all<OutboxRow>("SELECT id, order_id, effect_kind FROM typed_sheets_effect_outbox");
    });
    expect(effects).toEqual([]);
  });

  it("binds adapter-neutral SQL to the same transaction boundary", async () => {
    const orm = await createOrm();
    openOrms.push(orm);
    const adapter = new MikroOrmSqliteAdapter(orm);

    await createOutbox(adapter);

    await adapter.transaction(async ({ sql }) => {
      await sql.run(
        "INSERT INTO typed_sheets_effect_outbox (id, order_id, effect_kind) VALUES (?, ?, ?)",
        ["effect-neutral", "order-neutral", "order_upsert"],
      );
    });

    const effect = await adapter.read(({ sql }) => {
      return sql.get<OutboxRow>(
        "SELECT id, order_id, effect_kind FROM typed_sheets_effect_outbox WHERE id = ?",
        ["effect-neutral"],
      );
    });

    expect(effect).toEqual({
      id: "effect-neutral",
      order_id: "order-neutral",
      effect_kind: "order_upsert",
    });
  });

  it("migrates the typed-sheets schema through the MikroORM SQLite connection", async () => {
    const orm = await createOrm();
    openOrms.push(orm);
    const adapter = new MikroOrmSqliteAdapter(orm);

    const firstMigration = await migrateMikroOrmSqliteSchema(adapter);
    const secondMigration = await migrateMikroOrmSqliteSchema(adapter);

    const tables = await adapter.read(({ sql }) => {
      return sql.all<{ readonly name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      );
    });

    expect(firstMigration).toEqual({
      fromVersion: 0,
      toVersion: 4,
      appliedVersions: [4],
    });
    expect(secondMigration).toEqual({
      fromVersion: 4,
      toVersion: 4,
      appliedVersions: [],
    });

    await adapter.transaction(async ({ sql }) => {
      await sql.run("PRAGMA user_version = 3");
    });
    await expect(migrateMikroOrmSqliteSchema(adapter)).resolves.toEqual({
      fromVersion: 3,
      toVersion: 4,
      appliedVersions: [4],
    });
    await expect(adapter.read(({ sql }) => sql.get<{ readonly user_version: number }>("PRAGMA user_version")))
      .resolves.toEqual({ user_version: 4 });

    expect(tables.map((table) => table.name)).toContain("mikro_orm_adapter_order");
    expect(tables.map((table) => table.name)).toContain("sheet_effect_outbox");
  });

  it("uses the adapter transaction for writer lease fencing", async () => {
    const orm = await createOrm();
    openOrms.push(orm);
    const adapter = new MikroOrmSqliteAdapter(orm);
    await migrateMikroOrmSqliteSchema(adapter);

    const firstClaim = await claimWriterLeaseWithAdapter(adapter, {
      role: "sync_writer",
      writerId: "worker-a",
      leaseDurationMs: 100,
      now: 1000,
    });
    const activeOtherWriterClaim = await claimWriterLeaseWithAdapter(adapter, {
      role: "sync_writer",
      writerId: "worker-b",
      leaseDurationMs: 100,
      now: 1050,
    });
    const takeoverClaim = await claimWriterLeaseWithAdapter(adapter, {
      role: "sync_writer",
      writerId: "worker-b",
      leaseDurationMs: 100,
      now: 1100,
    });

    expect(firstClaim.kind).toBe(WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED);
    if (firstClaim.kind !== WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED) {
      throw new Error("Expected initial writer lease claim");
    }
    expect(activeOtherWriterClaim).toEqual({
      kind: WRITER_LEASE_CLAIM_RESULT_KINDS.NOT_CLAIMED,
      reason: WRITER_LEASE_CLAIM_FAILURE_REASONS.ACTIVE_WRITER,
    });
    expect(takeoverClaim.kind).toBe(WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED);
    if (takeoverClaim.kind !== WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED) {
      throw new Error("Expected expired writer lease takeover");
    }
    expect(takeoverClaim.lease.writerEpoch).toBe(2);

    expect(
      await isFencingValidWithAdapter(adapter, {
        role: "sync_writer",
        writerEpoch: firstClaim.lease.writerEpoch,
        fencingToken: firstClaim.lease.fencingToken,
        now: 1100,
      }),
    ).toBe(false);
    expect(
      await isFencingValidWithAdapter(adapter, {
        role: "sync_writer",
        writerEpoch: takeoverClaim.lease.writerEpoch,
        fencingToken: takeoverClaim.lease.fencingToken,
        now: 1100,
      }),
    ).toBe(true);
    await expect(readWriterLeaseWithAdapter(adapter, "sync_writer")).resolves.toEqual({
      kind: LOOKUP_RESULT_KINDS.FOUND,
      value: takeoverClaim.lease,
    });
  });

  it("registers and reads a Sheets projection through the MikroORM adapter", async () => {
    const orm = await createOrm();
    openOrms.push(orm);
    const adapter = new MikroOrmSqliteAdapter(orm);
    await migrateMikroOrmSqliteSchema(adapter);

    const leaseClaim = await claimWriterLeaseWithAdapter(adapter, {
      role: "sync_writer",
      writerId: "worker-a",
      leaseDurationMs: 100,
      now: 1000,
    });
    if (leaseClaim.kind !== WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED) {
      throw new Error("Expected writer lease claim");
    }
    const fence = {
      role: leaseClaim.lease.role,
      writerEpoch: leaseClaim.lease.writerEpoch,
      fencingToken: leaseClaim.lease.fencingToken,
      now: 1000,
    };

    await expect(registerSyncSheetWithAdapter(adapter, fence, {
      logicalSheetId: "orders",
      physicalSheetId: "orders-system-state",
      spreadsheetId: "spreadsheet-id",
      tabName: "Orders",
      registeredRange: "a:z",
      projection: "system_state",
      schemaVersion: 1,
      ownershipManifestJson: "{}",
      businessKeyField: "id",
    })).resolves.toEqual({
      kind: "registered",
      sheet: {
        logicalSheetId: "orders",
        physicalSheetId: "orders-system-state",
        spreadsheetId: "spreadsheet-id",
        tabName: "Orders",
        registeredRange: "A:Z",
        projection: "system_state",
        schemaVersion: 1,
        ownershipManifestJson: "{}",
        businessKeyField: "id",
        anchorMode: "business_key",
      },
    });
    await expect(
      requireRegisteredSyncSheetWithAdapter(adapter, "orders-system-state"),
    ).resolves.toMatchObject({
      logicalSheetId: "orders",
      registeredRange: "A:Z",
    });
  });

  it("claims and applies an outbox effect through the MikroORM adapter", async () => {
    const orm = await createOrm();
    openOrms.push(orm);
    const adapter = new MikroOrmSqliteAdapter(orm);
    await migrateMikroOrmSqliteSchema(adapter);
    await registerProjection(adapter);

    const leaseClaim = await claimWriterLeaseWithAdapter(adapter, {
      role: "sync_writer",
      writerId: "worker-a",
      leaseDurationMs: 100,
      now: 1000,
    });
    if (leaseClaim.kind !== WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED) {
      throw new Error("Expected writer lease claim");
    }
    const fence = {
      role: leaseClaim.lease.role,
      writerEpoch: leaseClaim.lease.writerEpoch,
      fencingToken: leaseClaim.lease.fencingToken,
      now: 1000,
    };
    const effect = {
      ...createPendingEffect(),
      rowBindingId: {
        kind: PRESENCE_KINDS.PRESENT,
        value: "row-binding-1",
      },
    };

    await expect(appendPendingEffectsWithSqlInAdapter(adapter, fence, [effect])).resolves.toBe(true);
    await expect(listReadyEffectsWithAdapter(adapter, 1)).resolves.toMatchObject([
      { effect_id: effect.effectId },
    ]);
    await expect(claimEffectWithAdapter(adapter, {
      ...fence,
      effectId: effect.effectId,
      claimToken: "claim-1",
      leaseDurationMs: 50,
    })).resolves.toMatchObject({
      effectId: effect.effectId,
      claimToken: "claim-1",
      success: true,
      reason: "claimed",
    });
    await expect(applyEffectResultWithAdapter(adapter, {
      ...fence,
      effectId: effect.effectId,
      claimToken: "claim-1",
      status: "applied",
      lastErrorCode: { kind: PRESENCE_KINDS.ABSENT },
      lastErrorMessage: { kind: PRESENCE_KINDS.ABSENT },
      projectionConfirmation: {
        physicalSheetId: effect.physicalSheetId,
        projection: effect.projection,
        rowBindingId: "row-binding-1",
        visibleRevision: 1,
        visibleHash: "visible-hash-1",
        entityRevision: { kind: APPLICABILITY_KINDS.APPLICABLE, value: 1 },
        fieldHashes: { status: "field-hash-1" },
      },
    })).resolves.toBe(true);

    const appliedEffect = await adapter.read(({ sql }) => {
      return sql.get<AppliedEffectRow>(
        "SELECT effect_id, status FROM sheet_effect_outbox WHERE effect_id = ?",
        [effect.effectId],
      );
    });
    const visibleField = await adapter.read(({ sql }) => {
      return sql.get<VisibleFieldRow>(
        "SELECT field_name, confirmed_field_hash, confirmed_visible_revision FROM sheet_visible_field_state WHERE physical_sheet_id = ? AND projection = ? AND row_binding_id = ? AND field_name = ?",
        [effect.physicalSheetId, effect.projection, "row-binding-1", "status"],
      );
    });
    expect(appliedEffect).toEqual({ effect_id: effect.effectId, status: "applied" });
    expect(visibleField).toEqual({
      field_name: "status",
      confirmed_field_hash: "field-hash-1",
      confirmed_visible_revision: 1,
    });
  });

  it("runs the Sheets effect worker through the MikroORM adapter", async () => {
    const orm = await createOrm();
    openOrms.push(orm);
    const adapter = new MikroOrmSqliteAdapter(orm);
    await migrateMikroOrmSqliteSchema(adapter);
    await registerProjection(adapter);

    const leaseClaim = await claimWriterLeaseWithAdapter(adapter, {
      role: "sync_worker",
      writerId: "worker-a",
      leaseDurationMs: 100,
      now: 1000,
    });
    if (leaseClaim.kind !== WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED) {
      throw new Error("Expected writer lease claim");
    }
    const fence = {
      role: leaseClaim.lease.role,
      writerEpoch: leaseClaim.lease.writerEpoch,
      fencingToken: leaseClaim.lease.fencingToken,
      now: 1000,
    };
    const oldFields = { status: { kind: "string" as const, value: "pending" } };
    const nextFields = { status: { kind: "string" as const, value: "paid" } };
    const effect = {
      ...createPendingEffect(),
      effectId: "effect-worker",
      logicalSheetId: "logical-sheet",
      physicalSheetId: "physical-sheet",
      projection: "system_state",
      rowBindingId: { kind: PRESENCE_KINDS.PRESENT, value: "row-binding-worker" },
      targetId: "order-worker",
      expectedVisibleRevision: 0,
      expectedVisibleHash: computeSyncVisibleHash(oldFields),
      payloadJson: serializeSyncProjectionEffectPayload({
        sheetName: "Orders",
        registeredRange: "A:Z",
        schemaVersion: 1,
        targetAnchor: "order-anchor",
        fields: nextFields,
        targetVisibleHash: computeSyncVisibleHash(nextFields),
        createIfMissing: false,
        expectedCandidateHash: { kind: APPLICABILITY_KINDS.NOT_APPLICABLE },
      }),
      payloadHash: "worker-payload-hash",
      effectDedupeKey: "worker-effect-dedupe-key",
    };
    await expect(appendPendingEffectsWithSqlInAdapter(adapter, fence, [effect])).resolves.toBe(true);

    const gateway = new FakeSyncSheetGateway([
      {
        physicalSheetId: "physical-sheet",
        sheetName: "Orders",
        registeredRange: "A:Z",
        projection: "system_state",
        schemaVersion: 1,
        headers: ["status"],
        rows: [
          {
            targetId: "order-worker",
            physicalAnchor: "order-anchor",
            fields: oldFields,
            visibleRevision: 0,
          },
        ],
      },
    ]);

    await expect(runSyncEffectWorkerWithAdapter({
      storage: adapter,
      gateway,
      workerId: "worker-a",
      writerRole: "sync_worker",
      now: 1000,
      maxEffects: 1,
    })).resolves.toMatchObject({
      selected: 1,
      claimed: 1,
      applied: 1,
      failed: 0,
    });
    expect(gateway.readRow("physical-sheet", "order-anchor")).toMatchObject({
      fields: nextFields,
      visibleRevision: 1,
    });
    await expect(adapter.read(({ sql }) => {
      return sql.get<AppliedEffectRow>(
        "SELECT effect_id, status FROM sheet_effect_outbox WHERE effect_id = ?",
        [effect.effectId],
      );
    })).resolves.toEqual({ effect_id: effect.effectId, status: "applied" });
  });

  it("persists a quarantined observation through the MikroORM transaction", async () => {
    const orm = await createOrm();
    openOrms.push(orm);
    const adapter = new MikroOrmSqliteAdapter(orm);
    await migrateMikroOrmSqliteSchema(adapter);
    await registerProjection(adapter);

    const leaseClaim = await claimWriterLeaseWithAdapter(adapter, {
      role: "observation_writer",
      writerId: "writer-a",
      leaseDurationMs: 100,
      now: 1000,
    });
    if (leaseClaim.kind !== WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED) {
      throw new Error("Expected writer lease claim");
    }

    const result = await persistObservedRowWithAdapter(
      adapter,
      {
        role: leaseClaim.lease.role,
        writerEpoch: leaseClaim.lease.writerEpoch,
        fencingToken: leaseClaim.lease.fencingToken,
        now: 1000,
      },
      createQuarantinedObservationInput(),
    );

    expect(result).toEqual({
      kind: "quarantined",
      observationId: "observation-quarantine",
      eventId: { kind: PRESENCE_KINDS.ABSENT },
      quarantineId: "quarantine-observation",
    });
    await expect(adapter.read(({ sql }) => {
      return sql.get<ObservationReceiptRow>(
        "SELECT observation_key, event_id, state FROM observation_receipt WHERE logical_sheet_id = ? AND observation_key = ?",
        ["logical-sheet", "observation-key-quarantine"],
      );
    })).resolves.toEqual({
      observation_key: "observation-key-quarantine",
      event_id: null,
      state: "quarantined",
    });
    await expect(adapter.read(({ sql }) => {
      return sql.get<QuarantineRow>(
        "SELECT quarantine_id, event_id, observation_id, reason FROM quarantine_record WHERE quarantine_id = ?",
        ["quarantine-observation"],
      );
    })).resolves.toEqual({
      quarantine_id: "quarantine-observation",
      event_id: null,
      observation_id: "observation-quarantine",
      reason: QUARANTINE_REASONS.INVALID_EVENT,
    });
  });

  it("persists an accepted observation and canonical insert through the MikroORM transaction", async () => {
    const orm = await createOrm();
    openOrms.push(orm);
    const adapter = new MikroOrmSqliteAdapter(orm);
    await migrateMikroOrmSqliteSchema(adapter);
    await registerProjection(adapter);
    await adapter.transaction(({ sql }) => {
      return sql.run(
        "INSERT INTO row_binding (row_binding_id, logical_sheet_id, anchor_reference, state) VALUES (?, ?, ?, ?)",
        ["row-binding-accepted", "logical-sheet", "order-anchor", "candidate"],
      );
    });

    const leaseClaim = await claimWriterLeaseWithAdapter(adapter, {
      role: "observation_writer",
      writerId: "writer-a",
      leaseDurationMs: 100,
      now: 1000,
    });
    if (leaseClaim.kind !== WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED) {
      throw new Error("Expected writer lease claim");
    }

    const result = await persistObservedRowWithAdapter(
      adapter,
      {
        role: leaseClaim.lease.role,
        writerEpoch: leaseClaim.lease.writerEpoch,
        fencingToken: leaseClaim.lease.fencingToken,
        now: 1000,
      },
      createAcceptedObservationInput(),
    );

    expect(result).toMatchObject({
      kind: "persisted",
      observationId: "observation-accepted",
      eventSequence: 1,
      outcome: ROW_OUTCOMES.ACCEPTED,
      entityRevision: { kind: APPLICABILITY_KINDS.APPLICABLE, value: 1 },
      conflictIds: [],
    });
    await expect(adapter.read(({ sql }) => {
      return sql.get<ObservedEventRow>(
        "SELECT event_id, status, event_sequence FROM event_log WHERE logical_sheet_id = ? AND event_key = ?",
        ["logical-sheet", "event-key-accepted"],
      );
    })).resolves.toMatchObject({ status: ROW_OUTCOMES.ACCEPTED, event_sequence: 1 });
    await expect(adapter.read(({ sql }) => {
      return sql.get<CanonicalEntityRow>(
        "SELECT entity_id, entity_revision, status FROM entity_state WHERE entity_id = ?",
        ["order-accepted"],
      );
    })).resolves.toEqual({
      entity_id: "order-accepted",
      entity_revision: 1,
      status: "active",
    });
    await expect(adapter.read(({ sql }) => {
      return sql.get<RowBindingStateRow>(
        "SELECT entity_id, state FROM row_binding WHERE row_binding_id = ?",
        ["row-binding-accepted"],
      );
    })).resolves.toEqual({ entity_id: "order-accepted", state: "active" });
  });

  it("persists a resolved conflict command through the MikroORM transaction", async () => {
    const orm = await createOrm();
    openOrms.push(orm);
    const adapter = new MikroOrmSqliteAdapter(orm);
    await migrateMikroOrmSqliteSchema(adapter);
    await registerProjection(adapter);
    await seedResolvableConflict(adapter);

    const leaseClaim = await claimWriterLeaseWithAdapter(adapter, {
      role: "resolution_writer",
      writerId: "writer-a",
      leaseDurationMs: 100,
      now: 1000,
    });
    if (leaseClaim.kind !== WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED) {
      throw new Error("Expected writer lease claim");
    }

    const result = await persistResolutionCommandWithAdapter(
      adapter,
      {
        role: leaseClaim.lease.role,
        writerEpoch: leaseClaim.lease.writerEpoch,
        fencingToken: leaseClaim.lease.fencingToken,
        now: 1000,
      },
      createResolvedCommandInput(),
    );

    expect(result).toEqual({
      kind: "applied",
      commandId: "command-resolved",
      conflictId: "conflict-resolved",
    });
    await expect(adapter.read(({ sql }) => {
      return sql.get<ResolutionCommandRow>(
        "SELECT status, applied_commit_id FROM resolution_command WHERE command_id = ?",
        ["command-resolved"],
      );
    })).resolves.toEqual({ status: "applied", applied_commit_id: "commit-resolved" });
    await expect(adapter.read(({ sql }) => {
      return sql.get<ConflictResolutionRow>(
        "SELECT status, resolution_command_id FROM sync_conflict WHERE conflict_id = ?",
        ["conflict-resolved"],
      );
    })).resolves.toEqual({
      status: CONFLICT_STATUSES.RESOLVED,
      resolution_command_id: "command-resolved",
    });
    await expect(adapter.read(({ sql }) => {
      return sql.get<ActiveCandidateStateRow>(
        "SELECT active_candidate_conflict_id, active_candidate_hash, candidate_epoch FROM sheet_visible_field_state WHERE physical_sheet_id = ? AND projection = ? AND row_binding_id = ? AND field_name = ?",
        ["physical-sheet", "system_state", "row-binding-resolution", "status"],
      );
    })).resolves.toEqual({
      active_candidate_conflict_id: null,
      active_candidate_hash: null,
      candidate_epoch: 4,
    });
  });

  it("rolls an ORM entity back with its pending Sheets effect when outbox insertion fails", async () => {
    const orm = await createOrm();
    openOrms.push(orm);
    const adapter = new MikroOrmSqliteAdapter(orm);
    await migrateMikroOrmSqliteSchema(adapter);
    await registerProjection(adapter);

    const leaseClaim = await claimWriterLeaseWithAdapter(adapter, {
      role: "sync_writer",
      writerId: "worker-a",
      leaseDurationMs: 100,
      now: 1000,
    });
    if (leaseClaim.kind !== WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED) {
      throw new Error("Expected writer lease claim");
    }
    const fence = {
      role: leaseClaim.lease.role,
      writerEpoch: leaseClaim.lease.writerEpoch,
      fencingToken: leaseClaim.lease.fencingToken,
      now: 1000,
    };
    const firstEffect = createPendingEffect();

    await adapter.transactional(async ({ entityManager, sql }) => {
      const order = entityManager.create(Order, {
        id: "order-with-effect",
        status: "pending",
      });
      entityManager.persist(order);
      await entityManager.flush();

      expect(await appendPendingEffectsWithSql(sql, fence, [firstEffect])).toBe(true);
    });

    await expect(
      adapter.transactional(async ({ entityManager, sql }) => {
        const order = entityManager.create(Order, {
          id: "order-rolled-back-with-effect",
          status: "pending",
        });
        entityManager.persist(order);
        await entityManager.flush();

        await appendPendingEffectsWithSql(sql, fence, [
          {
            ...firstEffect,
            effectId: "effect-duplicate-dedupe-key",
          },
        ]);
      }),
    ).rejects.toThrow();

    expect((await orm.em.fork().find(Order, {})).map((order) => order.id)).toEqual([
      "order-with-effect",
    ]);
    const effects = await adapter.read(({ sql }) => {
      return sql.all<SyncOutboxRow>(
        "SELECT effect_id, target_id, effect_kind FROM sheet_effect_outbox ORDER BY effect_id",
      );
    });
    expect(effects).toEqual([
      {
        effect_id: "effect-pending",
        target_id: "order-with-effect",
        effect_kind: "system_projection",
      },
    ]);
  });

  it("commits an ORM entity, canonical state, and pending Sheets effect together", async () => {
    const orm = await createOrm();
    openOrms.push(orm);
    const adapter = new MikroOrmSqliteAdapter(orm);
    await migrateMikroOrmSqliteSchema(adapter);
    await registerProjection(adapter);

    const leaseClaim = await claimWriterLeaseWithAdapter(adapter, {
      role: "sync_writer",
      writerId: "worker-a",
      leaseDurationMs: 100,
      now: 1000,
    });
    if (leaseClaim.kind !== WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED) {
      throw new Error("Expected writer lease claim");
    }
    const fence = {
      role: leaseClaim.lease.role,
      writerEpoch: leaseClaim.lease.writerEpoch,
      fencingToken: leaseClaim.lease.fencingToken,
      now: 1000,
    };

    const canonicalResult = await adapter.transactional(async ({ entityManager, sql }) => {
      const order = entityManager.create(Order, {
        id: "order-canonical",
        status: "pending",
      });
      entityManager.persist(order);
      await entityManager.flush();

      return commitCanonicalChangesWithSql(sql, fence, {
        kind: ROW_OPERATIONS.INSERT,
        entityId: order.id,
        acceptedSnapshotHash: { kind: PRESENCE_KINDS.ABSENT },
        fields: [
          {
            fieldName: "status",
            value: { kind: "string", value: order.status },
            expectedFieldRevision: { kind: APPLICABILITY_KINDS.NOT_APPLICABLE },
            ownership: FIELD_OWNERSHIPS.USER,
          },
        ],
        effects: [
          {
            ...createPendingEffect(),
            effectId: "effect-canonical",
            targetId: order.id,
            effectDedupeKey: "effect-canonical-dedupe-key",
          },
        ],
      });
    });

    expect(canonicalResult.kind).toBe(CANONICAL_COMMIT_RESULT_KINDS.APPLIED);
    if (canonicalResult.kind !== CANONICAL_COMMIT_RESULT_KINDS.APPLIED) {
      throw new Error("Expected canonical insert to be applied");
    }
    expect(canonicalResult.entityRevision).toBe(1);
    expect(canonicalResult.fieldRevisions.get("status")).toBe(1);
    expect((await orm.em.fork().find(Order, {})).map((order) => order.id)).toEqual([
      "order-canonical",
    ]);

    const canonicalEntities = await adapter.read(({ sql }) => {
      return sql.all<CanonicalEntityRow>(
        "SELECT entity_id, entity_revision, status FROM entity_state ORDER BY entity_id",
      );
    });
    const canonicalFields = await adapter.read(({ sql }) => {
      return sql.all<CanonicalFieldRow>(
        "SELECT entity_id, field_name, normalized_value, field_revision, ownership FROM entity_field_state ORDER BY entity_id, field_name",
      );
    });
    const effects = await adapter.read(({ sql }) => {
      return sql.all<SyncOutboxRow>(
        "SELECT effect_id, target_id, effect_kind FROM sheet_effect_outbox ORDER BY effect_id",
      );
    });

    expect(canonicalEntities).toEqual([
      {
        entity_id: "order-canonical",
        entity_revision: 1,
        status: "active",
      },
    ]);
    expect(canonicalFields).toEqual([
      {
        entity_id: "order-canonical",
        field_name: "status",
        normalized_value: '{"kind":"string","value":"pending"}',
        field_revision: 1,
        ownership: "user",
      },
    ]);
    expect(effects).toEqual([
      {
        effect_id: "effect-canonical",
        target_id: "order-canonical",
        effect_kind: "system_projection",
      },
    ]);
  });
});

async function createOrm() {
  const orm = await MikroORM.init({
    driver: SqliteDriver,
    dbName: ":memory:",
    driverOptions: new NodeSqliteDialect(":memory:"),
    entities: [Order],
  });
  await orm.schema.create();
  return orm;
}

async function createOutbox(adapter: MikroOrmSqliteAdapter): Promise<void> {
  await adapter.transaction(async ({ sql }) => {
    await sql.run(`
      CREATE TABLE typed_sheets_effect_outbox (
        id TEXT PRIMARY KEY NOT NULL,
        order_id TEXT NOT NULL,
        effect_kind TEXT NOT NULL
      )
    `);
  });
}

async function appendPendingEffectsWithSqlInAdapter(
  adapter: MikroOrmSqliteAdapter,
  fence: Parameters<typeof appendPendingEffectsWithSql>[1],
  effects: Parameters<typeof appendPendingEffectsWithSql>[2],
): Promise<boolean> {
  return adapter.transaction(({ sql }) => appendPendingEffectsWithSql(sql, fence, effects));
}

async function registerProjection(adapter: MikroOrmSqliteAdapter): Promise<void> {
  await adapter.transaction(async ({ sql }) => {
    await sql.run(
      "INSERT INTO sheet_registry (sheet_id, schema_version, ownership_manifest_json, business_key_field) VALUES (?, ?, ?, ?)",
      ["logical-sheet", 1, "{}", "id"],
    );
    await sql.run(
      "INSERT INTO physical_sheet_registry (physical_sheet_id, logical_sheet_id, spreadsheet_id, tab_name, registered_range, projection, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["physical-sheet", "logical-sheet", "spreadsheet", "Orders", "A1:Z", "system_state", 1],
    );
  });
}

function createPendingEffect(): NewEffect {
  return {
    effectId: "effect-pending",
    effectKind: "system_projection",
    commitId: "commit-1",
    logicalSheetId: "logical-sheet",
    physicalSheetId: "physical-sheet",
    projection: "system_state",
    rowBindingId: { kind: PRESENCE_KINDS.ABSENT },
    conflictId: { kind: PRESENCE_KINDS.ABSENT },
    targetKind: "entity",
    targetId: "order-with-effect",
    targetEntityRevision: {
      kind: APPLICABILITY_KINDS.APPLICABLE,
      value: 1,
    },
    targetFieldRevisionHash: { kind: APPLICABILITY_KINDS.NOT_APPLICABLE },
    targetCanonicalCommitId: { kind: APPLICABILITY_KINDS.NOT_APPLICABLE },
    expectedVisibleRevision: 1,
    expectedVisibleHash: "visible-hash",
    repairGuardHash: { kind: PRESENCE_KINDS.ABSENT },
    sourceQuarantineId: { kind: PRESENCE_KINDS.ABSENT },
    payloadJson: "{}",
    payloadHash: "payload-hash",
    effectDedupeKey: "effect-dedupe-key",
    streamSequence: 1,
  };
}

function createQuarantinedObservationInput(): PersistObservedRowInput {
  const rowBindingId = "row-binding-quarantine";
  const afterRow = {
    rowBindingId,
    fields: new Map([
      [
        "status",
        {
          fieldName: "status",
          cell: { kind: "string" as const, value: "pending" },
          baseFieldRevision: { kind: APPLICABILITY_KINDS.NOT_APPLICABLE },
        },
      ],
    ]),
  };
  const row = {
    rowBindingId,
    baseVisibleRevision: 0,
    operation: ROW_OPERATIONS.INSERT,
    afterRow,
    fields: [
      {
        fieldName: "status",
        previousValue: null,
        nextValue: { kind: "string" as const, value: "pending" },
      },
    ],
  };

  return {
    physicalSheetId: "physical-sheet",
    batch: {
      batchId: "batch-quarantine",
      source: "onEdit",
      sheetId: "logical-sheet",
      projection: "system_state",
      schemaVersion: 1,
      atomicity: "row_independent",
      baseSnapshotHash: "snapshot-quarantine",
      ingressActorId: "gateway",
      editorActorId: { kind: PRESENCE_KINDS.ABSENT },
      editorActorSource: "unavailable",
      rows: [row],
    },
    rowIndex: 0,
    observation: {
      observationId: "observation-quarantine",
      observationKey: "observation-key-quarantine",
      payloadJson: "{\"kind\":\"quarantine\"}",
      payloadHash: "payload-quarantine",
      detectedAt: 1000,
      receivedAt: 1000,
      ingressActorId: "gateway",
      editorActorId: { kind: PRESENCE_KINDS.ABSENT },
      editorActorSource: "unavailable",
    },
    event: { kind: PRESENCE_KINDS.ABSENT },
    evaluation: {
      rowBindingId,
      outcome: ROW_OUTCOMES.QUARANTINE,
      acceptedFields: [],
      conflicts: [],
      quarantine: {
        quarantineId: "quarantine-observation",
        reason: QUARANTINE_REASONS.INVALID_EVENT,
        rowBindingId,
        operation: ROW_OPERATIONS.INSERT,
        afterRow,
        fields: row.fields,
        repairFields: [],
      },
      repair: {
        status: QUARANTINE_REPAIR_STATUSES.NOT_PLANNED,
        reason: QUARANTINE_REPAIR_NOT_PLANNED_REASONS.QUARANTINE_ONLY,
      },
    },
    canonical: { kind: PRESENCE_KINDS.ABSENT },
    effects: [],
  };
}

function createAcceptedObservationInput(): PersistObservedRowInput {
  const rowBindingId = "row-binding-accepted";
  const statusCell = { kind: "string" as const, value: "pending" };
  const afterRow = {
    rowBindingId,
    fields: new Map([
      [
        "status",
        {
          fieldName: "status",
          cell: statusCell,
          baseFieldRevision: { kind: APPLICABILITY_KINDS.NOT_APPLICABLE },
        },
      ],
    ]),
  };
  const row = {
    rowBindingId,
    baseVisibleRevision: 0,
    operation: ROW_OPERATIONS.INSERT,
    afterRow,
    fields: [
      {
        fieldName: "status",
        previousValue: null,
        nextValue: statusCell,
      },
    ],
  };

  return {
    physicalSheetId: "physical-sheet",
    batch: {
      batchId: "batch-accepted",
      source: "onEdit",
      sheetId: "logical-sheet",
      projection: "system_state",
      schemaVersion: 1,
      atomicity: "row_independent",
      baseSnapshotHash: "snapshot-accepted",
      ingressActorId: "gateway",
      editorActorId: { kind: PRESENCE_KINDS.ABSENT },
      editorActorSource: "unavailable",
      rows: [row],
    },
    rowIndex: 0,
    observation: {
      observationId: "observation-accepted",
      observationKey: "observation-key-accepted",
      payloadJson: "{\"kind\":\"accepted\"}",
      payloadHash: "payload-accepted",
      detectedAt: 1000,
      receivedAt: 1000,
      ingressActorId: "gateway",
      editorActorId: { kind: PRESENCE_KINDS.ABSENT },
      editorActorSource: "unavailable",
    },
    event: {
      kind: PRESENCE_KINDS.PRESENT,
      value: {
        eventKey: "event-key-accepted",
        payloadHash: "event-payload-accepted",
      },
    },
    evaluation: {
      rowBindingId,
      outcome: ROW_OUTCOMES.ACCEPTED,
      acceptedFields: [
        {
          fieldName: "status",
          nextValue: statusCell,
          nextFieldRevision: 1,
        },
      ],
      conflicts: [],
      nextEntityRevision: 1,
    },
    canonical: {
      kind: PRESENCE_KINDS.PRESENT,
      value: {
        commitId: "commit-accepted",
        commit: {
          kind: ROW_OPERATIONS.INSERT,
          entityId: "order-accepted",
          acceptedSnapshotHash: { kind: PRESENCE_KINDS.PRESENT, value: "snapshot-accepted" },
          fields: [
            {
              fieldName: "status",
              value: statusCell,
              expectedFieldRevision: { kind: APPLICABILITY_KINDS.NOT_APPLICABLE },
              ownership: FIELD_OWNERSHIPS.USER,
            },
          ],
          effects: [],
        },
        businessKeyChanges: [],
      },
    },
    effects: [],
  };
}

function createResolvedCommandInput(): PersistResolutionCommandInput {
  const userValue = { kind: "string" as const, value: "edited-by-user" };
  return {
    logicalSheetId: "logical-sheet",
    commitId: "commit-resolved",
    command: {
      commandId: "command-resolved",
      requestKey: "request-key-resolved",
      action: "acknowledge_system",
      actorId: "sheet-editor",
      role: "sheet_editor",
      targetConflictId: "conflict-resolved",
      expectedRevision: 2,
      activeCandidateHash: stableHash({ value: userValue, revision: 1 }),
      expectedCandidateEpoch: 3,
      payloadHash: "resolution-payload-hash",
    },
    effects: [],
  };
}

async function seedResolvableConflict(adapter: MikroOrmSqliteAdapter): Promise<void> {
  const userValue = JSON.stringify({ kind: "string", value: "edited-by-user" });
  const canonicalValue = JSON.stringify({ kind: "string", value: "canonical" });
  const candidateHash = stableHash({
    value: { kind: "string" as const, value: "edited-by-user" },
    revision: 1,
  });
  await adapter.transaction(async ({ sql }) => {
    await sql.run(
      "INSERT INTO row_binding (row_binding_id, logical_sheet_id, anchor_reference, entity_id, state) VALUES (?, ?, ?, ?, ?)",
      ["row-binding-resolution", "logical-sheet", "resolution-anchor", "order-resolution", "active"],
    );
    await sql.run(
      "INSERT INTO event_batch (batch_id, logical_sheet_id, physical_sheet_id, source, projection, atomicity, base_snapshot_hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        "batch-resolution",
        "logical-sheet",
        "physical-sheet",
        "onEdit",
        "system_state",
        "row_independent",
        "snapshot-resolution",
      ],
    );
    await sql.run(
      "INSERT INTO event_log (event_id, logical_sheet_id, physical_sheet_id, event_key, payload_hash, event_sequence, batch_id, row_binding_id, operation, status, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "event-resolution",
        "logical-sheet",
        "physical-sheet",
        "event-key-resolution",
        "event-payload-resolution",
        1,
        "batch-resolution",
        "row-binding-resolution",
        ROW_OPERATIONS.UPDATE,
        ROW_OUTCOMES.CONFLICT,
        1000,
      ],
    );
    await sql.run(
      "INSERT INTO sync_conflict (conflict_id, event_id, logical_sheet_id, entity_id, row_binding_id, field_name, user_value, user_base_revision, canonical_value_at_detection, canonical_revision_at_detection, current_canonical_value, current_canonical_revision, candidate_epoch, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "conflict-resolved",
        "event-resolution",
        "logical-sheet",
        "order-resolution",
        "row-binding-resolution",
        "status",
        userValue,
        1,
        canonicalValue,
        2,
        canonicalValue,
        2,
        3,
        CONFLICT_STATUSES.OPEN,
        1000,
        1000,
      ],
    );
    await sql.run(
      "INSERT INTO sheet_visible_field_state (physical_sheet_id, projection, row_binding_id, field_name, confirmed_field_hash, confirmed_visible_revision, active_candidate_conflict_id, active_candidate_hash, candidate_epoch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "physical-sheet",
        "system_state",
        "row-binding-resolution",
        "status",
        "canonical-hash",
        2,
        "conflict-resolved",
        candidateHash,
        3,
      ],
    );
  });
}
