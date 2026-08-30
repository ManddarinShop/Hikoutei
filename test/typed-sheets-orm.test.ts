import {
  defineEntity,
  MikroORM,
  NodeSqliteDialect,
  p,
  SqliteDriver,
} from "@mikro-orm/sql";
import { afterEach, describe, expect, it } from "vitest";

import { defineTypedSheetsEntity } from "../src/index.js";
import { getEntityDescriptor } from "@hikoutei/sync-engine/api/entity.js";
import { createEntityManager } from "@hikoutei/sync-engine/api/internalEntityManager.js";
import {
  SCALAR_ENTITY_CHANGE_KINDS,
  type ScalarEntityFlushCoordinator,
} from "@hikoutei/contracts/storage/scalar.js";
import { MikroOrmScalarPersistenceProvider } from "@hikoutei/storage/persistence/providers/mikro-orm/api/MikroOrmScalarPersistenceProvider.js";
import {
  createMikroOrmSqliteAdapter,
  type MikroOrmSqliteAdapter,
} from "@hikoutei/storage/persistence/providers/mikro-orm/storage/MikroOrmSqliteAdapter.js";

const OrderSchema = defineEntity({
  name: "TypedSheetsFacadeOrder",
  tableName: "typed_sheets_facade_order",
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
  name: "TypedSheetsFacadeOrder",
  tableName: "typed_sheets_facade_order",
  properties: {
    id: { type: "string", primary: true },
    status: { type: "string" },
  },
});
const orderDescriptor = getEntityDescriptor(OrderToken);

interface FlushAuditRow {
  readonly change_kind: string;
  readonly entity_name: string;
  readonly primary_key: string;
}

describe("scalar provider persistence boundary", () => {
  const openOrms: Array<Awaited<ReturnType<typeof createOrm>>> = [];

  afterEach(async () => {
    await Promise.all(openOrms.splice(0).map((orm) => orm.close(true)));
  });

  it("executes Hikoutei's insert/update/delete plan atomically", async () => {
    const orm = await createOrm();
    openOrms.push(orm);
    const adapter = createMikroOrmSqliteAdapter(orm);
    await createFlushAudit(adapter);
    const observedKinds: string[] = [];
    const manager = createManager(adapter, createAuditCoordinator(observedKinds));

    const order = manager.create(OrderToken, { id: "order-1", status: "pending" });
    manager.persist(order);
    await manager.flush();

    const loaded = await manager.findOne(OrderToken, { id: "order-1" });
    expect(loaded).not.toBeNull();
    if (loaded === null) throw new Error("expected persisted order");
    loaded.status = "paid";
    await manager.flush();

    manager.remove(loaded);
    await manager.flush();

    expect(await manager.find(OrderToken, {})).toEqual([]);
    expect(observedKinds).toEqual([
      SCALAR_ENTITY_CHANGE_KINDS.INSERT,
      SCALAR_ENTITY_CHANGE_KINDS.UPDATE,
      SCALAR_ENTITY_CHANGE_KINDS.DELETE,
    ]);
    await expect(adapter.read(({ sql }) => sql.all<FlushAuditRow>(
      "SELECT change_kind, entity_name, primary_key FROM typed_sheets_flush_audit ORDER BY sequence",
    ))).resolves.toEqual([
      { change_kind: "insert", entity_name: orderDescriptor.name, primary_key: "order-1" },
      { change_kind: "update", entity_name: orderDescriptor.name, primary_key: "order-1" },
      { change_kind: "delete", entity_name: orderDescriptor.name, primary_key: "order-1" },
    ]);
  });

  it("flushes pending work at the end of transactional()", async () => {
    const orm = await createOrm();
    openOrms.push(orm);
    const adapter = createMikroOrmSqliteAdapter(orm);
    const manager = createManager(adapter);

    await manager.transactional(async (transactionalManager) => {
      transactionalManager.persist(
        transactionalManager.create(OrderToken, {
          id: "order-transactional",
          status: "pending",
        }),
      );
    });

    await expect(manager.findOne(OrderToken, { id: "order-transactional" }))
      .resolves.toMatchObject({ id: "order-transactional" });
  });

  it("rolls entity and planner SQL back when the planner rejects", async () => {
    const orm = await createOrm();
    openOrms.push(orm);
    const adapter = createMikroOrmSqliteAdapter(orm);
    await createFlushAudit(adapter);
    const manager = createManager(adapter, {
      async onFlush({ changes, sql }) {
        const change = changes[0];
        if (change === undefined) return;
        await sql.run(
          "INSERT INTO typed_sheets_flush_audit (change_kind, entity_name, primary_key) VALUES (?, ?, ?)",
          [change.kind, change.row.entityName, String(change.row.values.id)],
        );
        throw new Error("flush plan rejected");
      },
    });

    manager.persist(manager.create(OrderToken, { id: "order-rolled-back", status: "pending" }));
    await expect(manager.flush()).rejects.toThrow("flush plan rejected");
    expect(await manager.find(OrderToken, {})).toEqual([]);
    await expect(adapter.read(({ sql }) => sql.all<FlushAuditRow>(
      "SELECT change_kind, entity_name, primary_key FROM typed_sheets_flush_audit",
    ))).resolves.toEqual([]);
  });
});

function createManager(
  adapter: MikroOrmSqliteAdapter,
  flushCoordinator?: ScalarEntityFlushCoordinator,
) {
  const provider = new MikroOrmScalarPersistenceProvider(
    adapter,
    [{ descriptor: orderDescriptor, entity: Order as unknown as new (...arguments_: never[]) => Record<string, unknown> }],
    flushCoordinator,
  );
  return createEntityManager(provider, new Map([[orderDescriptor.name, orderDescriptor]]));
}

function createAuditCoordinator(observedKinds: string[]): ScalarEntityFlushCoordinator {
  return {
    async onFlush({ changes, sql }) {
      for (const change of changes) {
        observedKinds.push(change.kind);
        await sql.run(
          "INSERT INTO typed_sheets_flush_audit (change_kind, entity_name, primary_key) VALUES (?, ?, ?)",
          [change.kind, change.row.entityName, String(change.row.values.id)],
        );
      }
    },
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

async function createFlushAudit(adapter: MikroOrmSqliteAdapter): Promise<void> {
  await adapter.transaction(async ({ sql }) => {
    await sql.run(`
      CREATE TABLE typed_sheets_flush_audit (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        change_kind TEXT NOT NULL,
        entity_name TEXT NOT NULL,
        primary_key TEXT NOT NULL
      )
    `);
  });
}
