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
  FIELD_OWNERSHIPS,
  PRESENCE_KINDS,
  ROW_OPERATIONS,
  claimWriterLeaseWithAdapter,
} from "../src/index.js";
import {
  NORMALIZED_CELL_KINDS,
} from "../src/core/encoding/constants.js";
import { ROW_OUTCOMES } from "../src/core/evaluate/constants.js";
import { SYNC_GATEWAY_PROJECTIONS } from "../src/runtime/gateway/constants.js";
import { runSyncEffectWorkerWithAdapter } from "../src/runtime/effects/SyncEffectWorker.js";
import { FakeSyncSheetGateway } from "./support/FakeSyncSheetGateway.js";
import {
  defineTypedSheetsEntityMapping,
  planMappedObservationEntityMutation,
  registerTypedSheetsEntityMappings,
} from "../src/orm/index.js";
import {
  createMappedTypedSheetsOrm,
  createMikroOrmSqliteAdapter,
  migrateMikroOrmSqliteSchema,
  persistMappedObservedRowWithMikroOrm,
  type MikroOrmSqliteAdapter,
} from "../src/adapter/mikro-orm/index.js";
import { parseSyncProjectionEffectPayload } from "../src/runtime/gateway/syncGateway.js";
import type { PersistObservedRowInput } from "../src/storage/index.js";

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
      registeredRange: "A:B",
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
          registeredRange: "A:B",
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
    const typedSheetsOrm = createMappedTypedSheetsOrm(storage, {
      mappings: [orderMapping],
      writer,
    });
    const em = typedSheetsOrm.em.fork();

    const order = em.create(Order, { id: "order-1", status: "pending" });
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

    expect(await orm.em.fork().find(Order, {})).toEqual([]);
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

  it("physically removes the User_Input row after a guarded mapped delete and response loss", async () => {
    const orm = await createOrm();
    openOrms.push(orm);
    const storage = createMikroOrmSqliteAdapter(orm);
    await migrateMikroOrmSqliteSchema(storage);
    const writer = deterministicWriter("mapped-delete-writer");
    await registerTypedSheetsEntityMappings(storage, [orderMapping], writer);
    const typedSheetsOrm = createMappedTypedSheetsOrm(storage, {
      mappings: [orderMapping],
      writer,
    });
    const gateway = new FakeSyncSheetGateway([
      {
        physicalSheetId: "orders-system",
        sheetName: "Orders_System",
        registeredRange: "A:C",
        projection: SYNC_GATEWAY_PROJECTIONS.SYSTEM_STATE,
        schemaVersion: 1,
        headers: ["id", "status", "__typed_sheets_deleted"],
      },
      {
        physicalSheetId: "orders-input",
        sheetName: "Orders_Input",
        registeredRange: "A:B",
        projection: SYNC_GATEWAY_PROJECTIONS.USER_INPUT,
        schemaVersion: 1,
        headers: ["id", "status"],
      },
    ]);
    const em = typedSheetsOrm.em.fork();
    const order = em.create(Order, { id: "order-delete", status: "pending" });
    em.persist(order);
    await em.flush();

    await expect(runSyncEffectWorkerWithAdapter({
      storage,
      gateway,
      workerId: "mapped-delete-worker",
      now: 1_000,
      maxEffects: 8,
    })).resolves.toMatchObject({ applied: 2, failed: 0 });

    em.remove(order);
    await em.flush();
    gateway.dropNextResponseAfterApply();

    await expect(runSyncEffectWorkerWithAdapter({
      storage,
      gateway,
      workerId: "mapped-delete-worker",
      now: 1_001,
      maxEffects: 8,
    })).resolves.toMatchObject({
      applied: 2,
      failed: 0,
      blockedCandidate: 0,
      responseLossRecovered: 1,
    });

    const userSnapshot = await gateway.readSnapshot({
      physicalSheetId: "orders-input",
      sheetName: "Orders_Input",
      registeredRange: "A:B",
      projection: SYNC_GATEWAY_PROJECTIONS.USER_INPUT,
      schemaVersion: 1,
    });
    expect(userSnapshot.rows).toEqual([]);

    const systemSnapshot = await gateway.readSnapshot({
      physicalSheetId: "orders-system",
      sheetName: "Orders_System",
      registeredRange: "A:C",
      projection: SYNC_GATEWAY_PROJECTIONS.SYSTEM_STATE,
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
    const typedSheetsOrm = createMappedTypedSheetsOrm(storage, {
      mappings: [orderMapping],
      writer,
    });
    const gateway = new FakeSyncSheetGateway([
      {
        physicalSheetId: "orders-system",
        sheetName: "Orders_System",
        registeredRange: "A:C",
        projection: SYNC_GATEWAY_PROJECTIONS.SYSTEM_STATE,
        schemaVersion: 1,
        headers: ["id", "status", "__typed_sheets_deleted"],
      },
      {
        physicalSheetId: "orders-input",
        sheetName: "Orders_Input",
        registeredRange: "A:B",
        projection: SYNC_GATEWAY_PROJECTIONS.USER_INPUT,
        schemaVersion: 1,
        headers: ["id", "status"],
      },
    ]);
    const em = typedSheetsOrm.em.fork();
    const order = em.create(Order, { id: "order-candidate-delete", status: "pending" });
    em.persist(order);
    await em.flush();
    await runSyncEffectWorkerWithAdapter({
      storage,
      gateway,
      workerId: "mapped-candidate-delete-worker",
      now: 1_000,
      maxEffects: 8,
    });

    gateway.mutateRow(
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

    await expect(runSyncEffectWorkerWithAdapter({
      storage,
      gateway,
      workerId: "mapped-candidate-delete-worker",
      now: 1_001,
      maxEffects: 8,
    })).resolves.toMatchObject({ applied: 1, blockedCandidate: 1, failed: 0 });
    expect(gateway.readRow("orders-input", "entity:order-candidate-delete").fields.status).toEqual({
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

    const result = await persistMappedObservedRowWithMikroOrm(storage, {
      mappings: [orderMapping],
      fence: {
        role: claim.lease.role,
        writerEpoch: claim.lease.writerEpoch,
        fencingToken: claim.lease.fencingToken,
        now: 1_000,
      },
      input: acceptedObservationInput(),
    });

    expect(result).toMatchObject({ kind: "persisted", outcome: ROW_OUTCOMES.ACCEPTED });
    await expect(orm.em.fork().findOne(Order, { id: "order-observed" })).resolves.toMatchObject({
      id: "order-observed",
      status: "pending",
    });
    await expect(storage.read(({ sql }) => {
      return sql.all<OutboxRow>("SELECT physical_sheet_id, target_kind, target_id, expected_visible_revision, expected_visible_hash, stream_sequence, payload_json FROM sheet_effect_outbox");
    })).resolves.toEqual([]);
  });
});

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
      ingressActorId: "gateway",
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
      ingressActorId: "gateway",
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
