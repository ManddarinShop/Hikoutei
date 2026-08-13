import {
  defineEntity,
  MikroORM,
  NodeSqliteDialect,
  p,
  SqliteDriver,
} from "@mikro-orm/sql";
import { afterEach, describe, expect, it } from "vitest";

import { APPLICABILITY_KINDS, PRESENCE_KINDS } from "../src/shared/state/constants.js";
import { FIELD_OWNERSHIPS, ROW_OPERATIONS } from "../src/domain/model/constants.js";
import { claimWriterLeaseWithAdapter } from "../src/infrastructure/storage/index.js";
import {
  NORMALIZED_CELL_KINDS,
} from "../src/shared/encoding/constants.js";
import { ROW_OUTCOMES } from "../src/domain/evaluate/constants.js";
import { SYNC_PROJECTIONS } from "../src/application/sync/sheetsContract/constants.js";
import { runEffectWorkerWithAdapter } from "../src/infrastructure/storage/index.js";
import { defineTypedSheetsEntity } from "../src/index.js";
import { getEntityDescriptor } from "../src/api/entity.js";
import { createEntityManager } from "../src/api/internalEntityManager.js";
import { SheetsEffectDispatcher } from "../src/application/sync/outbound/SheetsEffectDispatcher.js";
import { FakeSyncSheetsProvider } from "./support/FakeSyncSheetsProvider.js";
import { defineTypedSheetsEntityMapping } from "../src/application/orm/mapping/entityMapping.js";
import { typedSheetsEntityRowBindingId } from "../src/application/orm/mapping/identity.js";
import { planMappedObservationEntityMutation } from "../src/application/orm/mapping/observationMapping.js";
import {
  createMappedTypedSheetsFlushCoordinator,
  registerTypedSheetsEntityMappings,
} from "../src/application/orm/persistence/flush/flushCoordinator.js";
import {
  createMikroOrmSqliteAdapter,
  type MikroOrmSqliteAdapter,
} from "../src/adapter/persistence/providers/mikro-orm/storage/MikroOrmSqliteAdapter.js";
import { MikroOrmScalarPersistenceProvider } from "../src/adapter/persistence/providers/mikro-orm/api/MikroOrmScalarPersistenceProvider.js";
import { migrateMikroOrmSqliteSchema } from "../src/adapter/persistence/providers/mikro-orm/storage/MikroOrmSqliteSchema.js";
import { persistMappedObservedRowWithMikroOrm } from "../src/adapter/persistence/providers/mikro-orm/observation/MikroOrmMappedObservation.js";
import { parseSyncProjectionEffectPayload } from "../src/application/sync/sheetsContract/syncSheets.js";
import type { PersistObservedRowInput } from "../src/infrastructure/storage/index.js";

const OrderSchema = defineEntity({
  name: "MappedTypedSheetsOrder",
  tableName: "mapped_typed_sheets_order",
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

const OrderToken = defineTypedSheetsEntity({
  name: "MappedTypedSheetsOrder",
  tableName: "mapped_typed_sheets_order",
  properties: {
    id: { type: "string", primary: true },
    status: { type: "string" },
  },
});
const orderDescriptor = getEntityDescriptor(OrderToken);

const orderMapping = defineTypedSheetsEntityMapping({
  entity: Order,
  entityName: "MappedTypedSheetsOrder",
  logicalSheetId: "orders",
  primaryKey: "id",
  businessKey: "id",
  schemaVersion: 1,
  fields: [
    {
      property: "id",
      cellKind: NORMALIZED_CELL_KINDS.STRING,
      ownership: FIELD_OWNERSHIPS.USER,
      required: true,
      unique: true,
    },
    {
      property: "status",
      cellKind: NORMALIZED_CELL_KINDS.STRING,
      ownership: FIELD_OWNERSHIPS.USER,
      required: true,
    },
  ],
  projections: [
    {
      physicalSheetId: "orders-system",
      spreadsheetId: "spreadsheet-orders",
      tabName: "Orders_System",
      registeredRange: "A:C",
      projection: "system_state",
    },
    {
      physicalSheetId: "orders-input",
      spreadsheetId: "spreadsheet-orders",
      tabName: "Orders_Input",
      registeredRange: "A:C",
      projection: "user_input",
    },
  ],
});

interface CanonicalEntityRow {
  readonly entity_revision: number;
  readonly status: string;
}

interface CanonicalFieldRow {
  readonly field_name: string;
  readonly field_revision: number;
}

interface RowBindingRow {
  readonly entity_id: string | null;
  readonly state: string;
}

interface BusinessKeyRow {
  readonly state: string;
}

interface OutboxRow {
  readonly physical_sheet_id: string;
  readonly effect_kind: string;
  readonly target_kind: string;
  readonly target_id: string;
  readonly expected_visible_revision: number;
  readonly expected_visible_hash: string;
  readonly stream_sequence: number;
  readonly payload_json: string;
}

interface DeletionEffectRow {
  readonly effect_kind: string;
  readonly status: string;
}

describe("mapped typed-sheets ORM", () => {
  const openOrms: Array<Awaited<ReturnType<typeof createOrm>>> = [];

  afterEach(async () => {
    await Promise.all(openOrms.splice(0).map((orm) => orm.close(true)));
  });

  it("retains shared identity metadata and promotes property codecs", () => {
    const mapping = defineTypedSheetsEntityMapping({
      entity: Order,
      entityName: "TypedCodecOrder",
      logicalSheetId: "typed-codec-orders",
      primaryKey: "id",
      businessKey: "id",
      schemaVersion: 1,
      fields: [
        {
          property: "id",
          cellKind: NORMALIZED_CELL_KINDS.STRING,
          ownership: FIELD_OWNERSHIPS.USER,
          required: true,
          unique: true,
        },
        {
          property: "status",
          cellKind: NORMALIZED_CELL_KINDS.STRING,
          ownership: FIELD_OWNERSHIPS.USER,
          required: true,
          encode: (value) => ({ kind: NORMALIZED_CELL_KINDS.STRING, value: value.toUpperCase() }),
          decode: (value) => value?.kind === NORMALIZED_CELL_KINDS.STRING ? value.value : "",
        },
      ],
      projections: [{
        physicalSheetId: "typed-codec-orders-system",
        spreadsheetId: "spreadsheet-orders",
        tabName: "Orders_System",
        registeredRange: "A:C",
        projection: "system_state",
      }],
    });

    expect(mapping.identity.primaryProperty).toBe("id");
    expect(mapping.identity.businessKey).toBe(mapping.businessKey);
    expect(mapping.fields.find((field) => field.property === "status")?.encode?.("pending"))
      .toEqual({ kind: NORMALIZED_CELL_KINDS.STRING, value: "PENDING" });
  });

  it("rejects malformed mapping input before reading its fields", () => {
    expect(() => defineTypedSheetsEntityMapping(null as never)).toThrow(
      "entity mapping must be an object",
    );
    expect(() => defineTypedSheetsEntityMapping({ fields: null, projections: [] } as never)).toThrow(
      "entity mapping fields and projections must be arrays",
    );
    expect(() => defineTypedSheetsEntityMapping({
      ...orderMapping,
      entity: Order,
      primaryKey: "id",
      businessKey: "id",
      fields: orderMapping.fields.map((field, index) => index === 0
        ? { ...field, encode: "not-a-function" }
        : field),
    } as never)).toThrow("encode must be a function");
  });

  it("rejects a User_Input mapping whose business key is system-owned", () => {
    expect(() => defineTypedSheetsEntityMapping({
      entity: Order,
      entityName: "InvalidMappedTypedSheetsOrder",
      logicalSheetId: "invalid-orders",
      primaryKey: "id",
      businessKey: "id",
      schemaVersion: 1,
      fields: [
        {
          property: "id",
          cellKind: NORMALIZED_CELL_KINDS.STRING,
          ownership: FIELD_OWNERSHIPS.SYSTEM,
          required: true,
          unique: true,
        },
        {
          property: "status",
          cellKind: NORMALIZED_CELL_KINDS.STRING,
          ownership: FIELD_OWNERSHIPS.USER,
          required: true,
        },
      ],
      projections: [
        {
          physicalSheetId: "invalid-orders-system",
          spreadsheetId: "spreadsheet-orders",
          tabName: "Orders_System",
          registeredRange: "A:C",
          projection: "system_state",
        },
        {
          physicalSheetId: "invalid-orders-input",
          spreadsheetId: "spreadsheet-orders",
          tabName: "Orders_Input",
          registeredRange: "A:C",
          projection: "user_input",
        },
      ],
    })).toThrow("a user_input projection requires a user-owned business-key field");
  });

  it("maps accepted canonical insert, update, and delete operations to entity mutations", () => {
    const idCell = { kind: NORMALIZED_CELL_KINDS.STRING, value: "order-observed" } as const;
    const pendingCell = { kind: NORMALIZED_CELL_KINDS.STRING, value: "pending" } as const;
    const paidCell = { kind: NORMALIZED_CELL_KINDS.STRING, value: "paid" } as const;

    expect(planMappedObservationEntityMutation(orderMapping, {
      kind: ROW_OPERATIONS.INSERT,
      entityId: "order-observed",
      acceptedSnapshotHash: { kind: PRESENCE_KINDS.PRESENT, value: "snapshot-insert" },
      fields: [
        {
          fieldName: "id",
          value: idCell,
          expectedFieldRevision: { kind: APPLICABILITY_KINDS.NOT_APPLICABLE },
          ownership: FIELD_OWNERSHIPS.USER,
        },
        {
          fieldName: "status",
          value: pendingCell,
          expectedFieldRevision: { kind: APPLICABILITY_KINDS.NOT_APPLICABLE },
          ownership: FIELD_OWNERSHIPS.USER,
        },
      ],
      effects: [],
    })).toEqual({
      kind: "insert",
      entityId: "order-observed",
      data: { id: "order-observed", status: "pending" },
    });

    expect(planMappedObservationEntityMutation(orderMapping, {
      kind: ROW_OPERATIONS.UPDATE,
      entityId: "order-observed",
      acceptedSnapshotHash: { kind: PRESENCE_KINDS.PRESENT, value: "snapshot-update" },
      fields: [
        {
          fieldName: "status",
          value: paidCell,
          expectedFieldRevision: { kind: APPLICABILITY_KINDS.APPLICABLE, value: 1 },
          ownership: FIELD_OWNERSHIPS.USER,
        },
      ],
      effects: [],
    })).toEqual({
      kind: "update",
      entityId: "order-observed",
      data: { status: "paid" },
    });

    expect(planMappedObservationEntityMutation(orderMapping, {
      kind: ROW_OPERATIONS.DELETE,
      entityId: "order-observed",
      acceptedSnapshotHash: { kind: PRESENCE_KINDS.PRESENT, value: "snapshot-delete" },
      expectedEntityRevision: 2,
      effects: [],
    })).toEqual({ kind: "delete", entityId: "order-observed" });
  });

  it("plans entity lifecycle writes into canonical state and ordered projection effects", async () => {
    const orm = await createOrm();
    openOrms.push(orm);
    const storage = createMikroOrmSqliteAdapter(orm);
    await migrateMikroOrmSqliteSchema(storage);
    const timingEvents: Array<{ readonly phase: string; readonly operationKinds: readonly string[] }> = [];
    const writer = {
      ...deterministicWriter("mapped-order-writer"),
      onTiming: (event: { readonly phase: string; readonly operationKinds: readonly string[] }) => {
        timingEvents.push(event);
      },
    };
    await registerTypedSheetsEntityMappings(storage, [orderMapping], writer);
    const em = createMappedManager(storage, writer);

    const order = em.create(OrderToken, { id: "order-1", status: "pending" });
    em.persist(order);
    await em.flush();

    order.status = "paid";
    await em.flush();

    em.remove(order);
    await em.flush();

    expect(timingEvents.filter((event) => event.phase === "entity_change_total")
      .map((event) => event.operationKinds)).toEqual([
      ["append"],
      ["update"],
      ["delete"],
    ]);
    expect(timingEvents.some((event) => event.phase === "flush_total")).toBe(true);

    await expect(em.find(OrderToken, {})).resolves.toEqual([]);
    await expect(storage.read(({ sql }) => {
      return sql.get<CanonicalEntityRow>(
        "SELECT entity_revision, status FROM entity_state WHERE entity_id = ?",
        ["order-1"],
      );
    })).resolves.toEqual({ entity_revision: 3, status: "tombstoned" });
    await expect(storage.read(({ sql }) => {
      return sql.all<CanonicalFieldRow>(
        "SELECT field_name, field_revision FROM entity_field_state WHERE entity_id = ? ORDER BY field_name",
        ["order-1"],
      );
    })).resolves.toEqual([
      { field_name: "id", field_revision: 1 },
      { field_name: "status", field_revision: 2 },
    ]);
    await expect(storage.read(({ sql }) => {
      return sql.get<RowBindingRow>(
        "SELECT entity_id, state FROM row_binding WHERE logical_sheet_id = ?",
        ["orders"],
      );
    })).resolves.toEqual({ entity_id: "order-1", state: "tombstoned" });
    await expect(storage.read(({ sql }) => {
      return sql.get<BusinessKeyRow>(
        "SELECT state FROM business_key_index WHERE logical_sheet_id = ? AND entity_id = ?",
        ["orders", "order-1"],
      );
    })).resolves.toEqual({ state: "inactive" });

    const effects = await readOutbox(storage);
    const systemEffects = effects.filter((effect) => effect.physical_sheet_id === "orders-system");
    const userEffects = effects.filter((effect) => effect.physical_sheet_id === "orders-input");

    expect(systemEffects.map((effect) => effect.stream_sequence)).toEqual([1, 2, 3]);
    expect(systemEffects.every((effect) => effect.target_kind === "entity")).toBe(true);
    expect(userEffects.map((effect) => effect.stream_sequence)).toEqual([1, 2, 3]);
    expect(userEffects.every((effect) => effect.target_kind === "projection_row")).toBe(true);

    const firstSystem = requireEffect(systemEffects, 0);
    const secondSystem = requireEffect(systemEffects, 1);
    const thirdSystem = requireEffect(systemEffects, 2);
    const firstSystemPayload = parseSyncProjectionEffectPayload(firstSystem.payload_json);
    const secondSystemPayload = parseSyncProjectionEffectPayload(secondSystem.payload_json);
    const thirdSystemPayload = parseSyncProjectionEffectPayload(thirdSystem.payload_json);
    expect(firstSystemPayload.fields).toEqual({
      id: { kind: NORMALIZED_CELL_KINDS.STRING, value: "order-1" },
      status: { kind: NORMALIZED_CELL_KINDS.STRING, value: "pending" },
      __typed_sheets_deleted: { kind: NORMALIZED_CELL_KINDS.BOOLEAN, value: false },
    });
    expect(secondSystem.expected_visible_revision).toBe(1);
    expect(secondSystem.expected_visible_hash).toBe(firstSystemPayload.targetVisibleHash);
    expect(thirdSystem.expected_visible_revision).toBe(2);
    expect(thirdSystem.expected_visible_hash).toBe(secondSystemPayload.targetVisibleHash);
    expect(thirdSystemPayload.fields.__typed_sheets_deleted).toEqual({
      kind: NORMALIZED_CELL_KINDS.BOOLEAN,
      value: true,
    });

    const firstUser = requireEffect(userEffects, 0);
    const secondUser = requireEffect(userEffects, 1);
    const thirdUser = requireEffect(userEffects, 2);
    const firstUserPayload = parseSyncProjectionEffectPayload(firstUser.payload_json);
    const secondUserPayload = parseSyncProjectionEffectPayload(secondUser.payload_json);
    const thirdUserPayload = parseSyncProjectionEffectPayload(thirdUser.payload_json);
    expect(firstUserPayload.fields).toEqual({
      id: { kind: NORMALIZED_CELL_KINDS.STRING, value: "order-1" },
      status: { kind: NORMALIZED_CELL_KINDS.STRING, value: "pending" },
    });
    expect(secondUser.expected_visible_revision).toBe(1);
    expect(secondUser.expected_visible_hash).toBe(firstUserPayload.targetVisibleHash);
    expect(secondUserPayload.fields).toEqual({
      id: { kind: NORMALIZED_CELL_KINDS.STRING, value: "order-1" },
      status: { kind: NORMALIZED_CELL_KINDS.STRING, value: "paid" },
    });
    expect(thirdUser.effect_kind).toBe("user_input_delete");
    expect(thirdUser.expected_visible_revision).toBe(2);
    expect(thirdUser.expected_visible_hash).toBe(secondUserPayload.targetVisibleHash);
    expect(thirdUserPayload.targetVisibleHash).toBe(thirdUser.expected_visible_hash);
    expect(thirdUserPayload.fields).toEqual(secondUserPayload.fields);
  });

  it("floors the follower system effect revision at the confirmed state while a create-baseline effect is in flight", async () => {
    const orm = await createOrm();
    openOrms.push(orm);
    const storage = createMikroOrmSqliteAdapter(orm);
    await migrateMikroOrmSqliteSchema(storage);
    const writer = deterministicWriter("mapped-chain-writer");
    await registerTypedSheetsEntityMappings(storage, [orderMapping], writer);
    const em = createMappedManager(storage, writer);
    const provider = new FakeSyncSheetsProvider([
      {
        physicalSheetId: "orders-system",
        sheetName: "Orders_System",
        registeredRange: "A:C",
        projection: SYNC_PROJECTIONS.SYSTEM_STATE,
        schemaVersion: 1,
        headers: ["id", "status", "__typed_sheets_deleted"],
      },
      {
        physicalSheetId: "orders-input",
        sheetName: "Orders_Input",
        registeredRange: "A:C",
        projection: SYNC_PROJECTIONS.USER_INPUT,
        schemaVersion: 1,
        headers: ["id", "status"],
      },
    ]);
    const order = em.create(OrderToken, { id: "order-1", status: "pending" });
    em.persist(order);
    await em.flush();

    // The binding already has a higher confirmed revision (3) from an
    // earlier lifecycle: the row was deleted from the Sheet, and the create
    // effect above is the create-baseline repair (expected revision 0)
    // still in flight.
    const rowBindingId = typedSheetsEntityRowBindingId(orderMapping, "order-1");
    const createSystem = requireEffect(
      (await readOutbox(storage)).filter((effect) => effect.physical_sheet_id === "orders-system"),
      0,
    );
    const createSystemPayload = parseSyncProjectionEffectPayload(createSystem.payload_json);
    await storage.transaction(({ sql }) => sql.run(
      "INSERT INTO sheet_visible_state (physical_sheet_id, projection, row_binding_id, confirmed_snapshot_hash, confirmed_visible_revision, confirmed_entity_revision, last_observed_hash) VALUES (?, 'system_state', ?, ?, 3, 1, ?)",
      ["orders-system", rowBindingId, createSystemPayload.targetVisibleHash, createSystemPayload.targetVisibleHash],
    ));

    // Canonical content changes while the create-baseline effect is still in
    // flight. The follower system effect must be floored at the confirmed
    // revision (3), not the create effect's expected + 1 (1): after the
    // create-baseline effect confirms, the durable revision clamps to
    // confirmed + 1, and a follower whose receipt echoes 1 + 1 = 2 would be
    // rejected by the confirmation upsert guard as a regression.
    order.status = "shipped";
    await em.flush();

    const effects = await readOutbox(storage);
    const systemEffects = effects.filter((effect) => effect.physical_sheet_id === "orders-system");
    expect(systemEffects.map((effect) => effect.stream_sequence)).toEqual([1, 2]);
    const follower = requireEffect(systemEffects, 1);
    const followerPayload = parseSyncProjectionEffectPayload(follower.payload_json);
    expect(follower.expected_visible_revision).toBe(3);
    // The follower still carries the create-baseline effect's target hash:
    // that is the hash the sheet will show once the repair applies.
    expect(follower.expected_visible_hash).toBe(createSystemPayload.targetVisibleHash);
    expect(followerPayload.fields.status).toEqual({
      kind: NORMALIZED_CELL_KINDS.STRING,
      value: "shipped",
    });

    // The worker applies the create-baseline effects first (the system
    // repair clamps the durable revision to 4); the follower effects become
    // claimable only after their predecessors settle. The system follower's
    // receipt revision 4 then clears the confirmation guard instead of
    // regressing it. The user-input stream confirms normally at 1 then 2.
    const workerOptions = {
      storage,
      dispatcher: new SheetsEffectDispatcher({ provider, storage }),
      workerId: "mapped-chain-worker",
      now: 1_000,
      maxEffects: 8,
    };
    await expect(runEffectWorkerWithAdapter(workerOptions)).resolves.toMatchObject({ applied: 2, failed: 0 });
    await expect(runEffectWorkerWithAdapter(workerOptions)).resolves.toMatchObject({ applied: 2, failed: 0 });

    await expect(storage.read(({ sql }) => sql.all<{ readonly status: string }>(
      "SELECT status FROM sheet_effect_outbox WHERE physical_sheet_id = ? AND target_kind = 'entity' ORDER BY stream_sequence",
      ["orders-system"],
    ))).resolves.toEqual([{ status: "applied" }, { status: "applied" }]);
    await expect(storage.read(({ sql }) => sql.get<{ readonly confirmed_visible_revision: number }>(
      "SELECT confirmed_visible_revision FROM sheet_visible_state WHERE physical_sheet_id = ? AND projection = 'system_state' AND row_binding_id = ?",
      ["orders-system", rowBindingId],
    ))).resolves.toEqual({ confirmed_visible_revision: 4 });

    const systemSnapshot = await provider.readSnapshot({
      physicalSheetId: "orders-system",
      sheetName: "Orders_System",
      registeredRange: "A:C",
      projection: SYNC_PROJECTIONS.SYSTEM_STATE,
      schemaVersion: 1,
    });
    expect(systemSnapshot.rows[0]?.cells.status?.normalizedCell).toEqual({
      kind: NORMALIZED_CELL_KINDS.STRING,
      value: "shipped",
    });
  });

  it("physically removes the User_Input row after a guarded mapped delete and response loss", async () => {
    const orm = await createOrm();
    openOrms.push(orm);
    const storage = createMikroOrmSqliteAdapter(orm);
    await migrateMikroOrmSqliteSchema(storage);
    const writer = deterministicWriter("mapped-delete-writer");
    await registerTypedSheetsEntityMappings(storage, [orderMapping], writer);
    const em = createMappedManager(storage, writer);
    const provider = new FakeSyncSheetsProvider([
      {
        physicalSheetId: "orders-system",
        sheetName: "Orders_System",
        registeredRange: "A:C",
        projection: SYNC_PROJECTIONS.SYSTEM_STATE,
        schemaVersion: 1,
        headers: ["id", "status", "__typed_sheets_deleted"],
      },
      {
        physicalSheetId: "orders-input",
        sheetName: "Orders_Input",
        registeredRange: "A:C",
        projection: SYNC_PROJECTIONS.USER_INPUT,
        schemaVersion: 1,
        headers: ["id", "status"],
      },
    ]);
    const order = em.create(OrderToken, { id: "order-delete", status: "pending" });
    em.persist(order);
    await em.flush();

    await expect(runEffectWorkerWithAdapter({
      storage,
      dispatcher: new SheetsEffectDispatcher({ provider, storage }),
      workerId: "mapped-delete-worker",
      now: 1_000,
      maxEffects: 8,
    })).resolves.toMatchObject({ applied: 2, failed: 0 });

    em.remove(order);
    await em.flush();
    provider.dropNextResponseAfterApply();

    await expect(runEffectWorkerWithAdapter({
      storage,
      dispatcher: new SheetsEffectDispatcher({ provider, storage }),
      workerId: "mapped-delete-worker",
      now: 1_001,
      maxEffects: 8,
    })).resolves.toMatchObject({
      applied: 2,
      failed: 0,
      blockedCandidate: 0,
      responseLossRecovered: 1,
    });

    const userSnapshot = await provider.readSnapshot({
      physicalSheetId: "orders-input",
      sheetName: "Orders_Input",
      registeredRange: "A:C",
      projection: SYNC_PROJECTIONS.USER_INPUT,
      schemaVersion: 1,
    });
    expect(userSnapshot.rows).toEqual([]);

    const systemSnapshot = await provider.readSnapshot({
      physicalSheetId: "orders-system",
      sheetName: "Orders_System",
      registeredRange: "A:C",
      projection: SYNC_PROJECTIONS.SYSTEM_STATE,
      schemaVersion: 1,
    });
    expect(systemSnapshot.rows[0]?.cells.__typed_sheets_deleted?.normalizedCell).toEqual({
      kind: NORMALIZED_CELL_KINDS.BOOLEAN,
      value: true,
    });
  });

  it("preserves a remote User_Input candidate instead of physically deleting its row", async () => {
    const orm = await createOrm();
    openOrms.push(orm);
    const storage = createMikroOrmSqliteAdapter(orm);
    await migrateMikroOrmSqliteSchema(storage);
    const writer = deterministicWriter("mapped-candidate-delete-writer");
    await registerTypedSheetsEntityMappings(storage, [orderMapping], writer);
    const em = createMappedManager(storage, writer);
    const provider = new FakeSyncSheetsProvider([
      {
        physicalSheetId: "orders-system",
        sheetName: "Orders_System",
        registeredRange: "A:C",
        projection: SYNC_PROJECTIONS.SYSTEM_STATE,
        schemaVersion: 1,
        headers: ["id", "status", "__typed_sheets_deleted"],
      },
      {
        physicalSheetId: "orders-input",
        sheetName: "Orders_Input",
        registeredRange: "A:C",
        projection: SYNC_PROJECTIONS.USER_INPUT,
        schemaVersion: 1,
        headers: ["id", "status"],
      },
    ]);
    const order = em.create(OrderToken, { id: "order-candidate-delete", status: "pending" });
    em.persist(order);
    await em.flush();
    await runEffectWorkerWithAdapter({
      storage,
      dispatcher: new SheetsEffectDispatcher({ provider, storage }),
      workerId: "mapped-candidate-delete-worker",
      now: 1_000,
      maxEffects: 8,
    });

    provider.mutateRow(
      "orders-input",
      "entity:order-candidate-delete",
      {
        id: { kind: NORMALIZED_CELL_KINDS.STRING, value: "order-candidate-delete" },
        status: { kind: NORMALIZED_CELL_KINDS.STRING, value: "edited-by-user" },
      },
      { kind: APPLICABILITY_KINDS.APPLICABLE, value: "candidate:remote-edit" },
    );
    em.remove(order);
    await em.flush();

    await expect(runEffectWorkerWithAdapter({
      storage,
      dispatcher: new SheetsEffectDispatcher({ provider, storage }),
      workerId: "mapped-candidate-delete-worker",
      now: 1_001,
      maxEffects: 8,
    })).resolves.toMatchObject({ applied: 1, blockedCandidate: 1, failed: 0 });
    expect(provider.readRow("orders-input", "entity:order-candidate-delete").fields.status).toEqual({
      kind: NORMALIZED_CELL_KINDS.STRING,
      value: "edited-by-user",
    });
    await expect(storage.read(({ sql }) => sql.get<DeletionEffectRow>(`
      SELECT effect_kind, status
      FROM sheet_effect_outbox
      WHERE effect_kind = 'user_input_delete'
    `))).resolves.toEqual({
      effect_kind: "user_input_delete",
      status: "blocked_candidate",
    });
  });

  it("applies an accepted canonical observation to the MikroORM entity table without an outbound loop", async () => {
    const orm = await createOrm();
    openOrms.push(orm);
    const storage = createMikroOrmSqliteAdapter(orm);
    await migrateMikroOrmSqliteSchema(storage);
    await registerTypedSheetsEntityMappings(storage, [orderMapping], deterministicWriter("mapping-setup"));
    await storage.transaction(({ sql }) => sql.run(
      "INSERT INTO row_binding (row_binding_id, logical_sheet_id, anchor_reference, state) VALUES (?, ?, ?, ?)",
      ["row-binding-observed", "orders", "observed-anchor", "candidate"],
    ));

    const claim = await claimWriterLeaseWithAdapter(storage, {
      role: "observation-writer",
      writerId: "observation-writer-a",
      leaseDurationMs: 1_000,
      now: 1_000,
    });
    if (claim.kind !== "claimed") throw new Error("Expected the observation writer lease.");

    const observationWriter = {
      ...deterministicWriter("observation-writer"),
      onTiming: undefined,
    };
    const result = await persistMappedObservedRowWithMikroOrm(storage, {
      mappings: [orderMapping],
      writer: observationWriter,
      fence: {
        role: claim.lease.role,
        writerEpoch: claim.lease.writerEpoch,
        fencingToken: claim.lease.fencingToken,
        now: 1_000,
      },
      input: acceptedObservationInput(),
    });

    expect(result).toMatchObject({ kind: "persisted", outcome: ROW_OUTCOMES.ACCEPTED });
    const observedManager = createMappedManager(storage, deterministicWriter("observed-read"));
    await expect(observedManager.findOne(OrderToken, { id: "order-observed" })).resolves.toMatchObject({
      id: "order-observed",
      status: "pending",
    });
    await expect(storage.read(({ sql }) => {
      return sql.all<OutboxRow>("SELECT physical_sheet_id, target_kind, target_id, expected_visible_revision, expected_visible_hash, stream_sequence, payload_json FROM sheet_effect_outbox");
    })).resolves.toEqual([]);
  });
});

function createMappedManager(
  storage: MikroOrmSqliteAdapter,
  writer: ReturnType<typeof deterministicWriter>,
) {
  const provider = new MikroOrmScalarPersistenceProvider(
    storage,
    [{ descriptor: orderDescriptor, entity: Order as unknown as new (...arguments_: never[]) => Record<string, unknown> }],
    createMappedTypedSheetsFlushCoordinator({ mappings: [orderMapping], writer }),
  );
  return createEntityManager(provider, new Map([[orderDescriptor.name, orderDescriptor]]));
}

function deterministicWriter(role: string) {
  let nextId = 0;
  return {
    writerId: "mapped-writer-a",
    role,
    leaseDurationMs: 1_000,
    now: () => 1_000,
    createId: () => `generated-${++nextId}`,
  };
}

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

async function readOutbox(storage: MikroOrmSqliteAdapter): Promise<readonly OutboxRow[]> {
  return storage.read(({ sql }) => sql.all<OutboxRow>(`
    SELECT physical_sheet_id, effect_kind, target_kind, target_id,
           expected_visible_revision, expected_visible_hash, stream_sequence, payload_json
    FROM sheet_effect_outbox
    ORDER BY physical_sheet_id, stream_sequence
  `));
}

function requireEffect(
  effects: readonly OutboxRow[],
  index: number,
): OutboxRow {
  const effect = effects[index];
  if (effect === undefined) throw new Error(`Expected outbox effect ${index}.`);
  return effect;
}

function acceptedObservationInput(): PersistObservedRowInput {
  const rowBindingId = "row-binding-observed";
  const statusCell = { kind: NORMALIZED_CELL_KINDS.STRING, value: "pending" } as const;
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
    physicalSheetId: "orders-system",
    batch: {
      batchId: "batch-observed",
      source: "onEdit",
      sheetId: "orders",
      projection: "system_state",
      schemaVersion: 1,
      atomicity: "row_independent",
      baseSnapshotHash: "snapshot-observed",
      ingressActorId: "provider",
      editorActorId: { kind: PRESENCE_KINDS.ABSENT },
      editorActorSource: "unavailable",
      rows: [row],
    },
    rowIndex: 0,
    observation: {
      observationId: "observation-observed",
      observationKey: "observation-key-observed",
      payloadJson: "{\"kind\":\"accepted\"}",
      payloadHash: "payload-observed",
      detectedAt: 1_000,
      receivedAt: 1_000,
      ingressActorId: "provider",
      editorActorId: { kind: PRESENCE_KINDS.ABSENT },
      editorActorSource: "unavailable",
    },
    event: {
      kind: PRESENCE_KINDS.PRESENT,
      value: {
        eventKey: "event-key-observed",
        payloadHash: "event-payload-observed",
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
        commitId: "commit-observed",
        commit: {
          kind: ROW_OPERATIONS.INSERT,
          entityId: "order-observed",
          acceptedSnapshotHash: { kind: PRESENCE_KINDS.PRESENT, value: "snapshot-observed" },
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
