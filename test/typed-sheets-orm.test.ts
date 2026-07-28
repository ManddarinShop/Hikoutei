import {
  defineEntity,
  MikroORM,
  NodeSqliteDialect,
  p,
  SqliteDriver,
} from "@mikro-orm/sql";
import { afterEach, describe, expect, it } from "vitest";

import { PRESENCE_KINDS } from "../src/core/state/index.js";
import {
  TYPED_SHEETS_ENTITY_CHANGE_KINDS,
  type TypedSheetsEntityChange,
  type TypedSheetsFlushCoordinator,
} from "../src/orm/index.js";
import {
  createMikroOrmSqliteAdapter,
  createTypedSheetsOrm,
  type MikroOrmSqliteAdapter,
} from "../src/adapter/persistence/providers/mikro-orm/index.js";

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

interface FlushAuditRow {
  readonly change_kind: string;
  readonly entity_name: string;
  readonly primary_key: string | null;
}

describe("TypedSheetsOrm", () => {
  const openOrms: Array<Awaited<ReturnType<typeof createOrm>>> = [];

  afterEach(async () => {
    await Promise.all(openOrms.splice(0).map((orm) => orm.close(true)));
  });

  it("uses our MikroORM-shaped entity lifecycle and writes its plan atomically", async () => {
    const orm = await createOrm();
    openOrms.push(orm);
    const adapter = createMikroOrmSqliteAdapter(orm);
    await createFlushAudit(adapter);

    const observedChanges: TypedSheetsEntityChange[] = [];
    const typedSheetsOrm = createTypedSheetsOrm(adapter, {
      flushCoordinator: createAuditFlushCoordinator(observedChanges),
    });
    const em = typedSheetsOrm.em.fork();

    const order = em.create(Order, { id: "order-1", status: "pending" });
    em.persist(order);
    await em.flush();

    const loadedOrder = await em.findOne(Order, { id: order.id });
    if (loadedOrder === null) {
      throw new Error("Expected the persisted order to be readable from SQLite.");
    }
    loadedOrder.status = "paid";
    await em.flush();

    em.remove(loadedOrder);
    await em.flush();

    expect((await orm.em.fork().find(Order, {})).map((candidate) => candidate.id)).toEqual([]);
    expect(observedChanges.map((change) => change.kind)).toEqual([
      TYPED_SHEETS_ENTITY_CHANGE_KINDS.CREATE,
      TYPED_SHEETS_ENTITY_CHANGE_KINDS.UPDATE,
      TYPED_SHEETS_ENTITY_CHANGE_KINDS.DELETE,
    ]);
    expect(observedChanges.map((change) => change.primaryKey)).toEqual([
      { kind: PRESENCE_KINDS.PRESENT, value: "order-1" },
      { kind: PRESENCE_KINDS.PRESENT, value: "order-1" },
      { kind: PRESENCE_KINDS.PRESENT, value: "order-1" },
    ]);

    const auditRows = await adapter.read(({ sql }) => {
      return sql.all<FlushAuditRow>(
        "SELECT change_kind, entity_name, primary_key FROM typed_sheets_flush_audit ORDER BY sequence",
      );
    });
    expect(auditRows).toEqual([
      {
        change_kind: TYPED_SHEETS_ENTITY_CHANGE_KINDS.CREATE,
        entity_name: "TypedSheetsFacadeOrder",
        primary_key: "order-1",
      },
      {
        change_kind: TYPED_SHEETS_ENTITY_CHANGE_KINDS.UPDATE,
        entity_name: "TypedSheetsFacadeOrder",
        primary_key: "order-1",
      },
      {
        change_kind: TYPED_SHEETS_ENTITY_CHANGE_KINDS.DELETE,
        entity_name: "TypedSheetsFacadeOrder",
        primary_key: "order-1",
      },
    ]);
  });

  it("uses the same lifecycle coordinator for transactional work", async () => {
    const orm = await createOrm();
    openOrms.push(orm);
    const adapter = createMikroOrmSqliteAdapter(orm);
    await createFlushAudit(adapter);

    const observedChanges: TypedSheetsEntityChange[] = [];
    const typedSheetsOrm = createTypedSheetsOrm(adapter, {
      flushCoordinator: createAuditFlushCoordinator(observedChanges),
    });

    await typedSheetsOrm.em.transactional(async (em) => {
      const order = em.create(Order, { id: "order-transactional", status: "pending" });
      em.persist(order);
    });

    expect((await orm.em.fork().find(Order, {})).map((order) => order.id)).toEqual([
      "order-transactional",
    ]);
    expect(observedChanges.map((change) => change.kind)).toEqual([
      TYPED_SHEETS_ENTITY_CHANGE_KINDS.CREATE,
    ]);
  });

  it("rolls entity writes and planned Sheets work back when the coordinator rejects a flush", async () => {
    const orm = await createOrm();
    openOrms.push(orm);
    const adapter = createMikroOrmSqliteAdapter(orm);
    await createFlushAudit(adapter);

    const typedSheetsOrm = createTypedSheetsOrm(adapter, {
      flushCoordinator: {
        async onFlush({ changes, sql }) {
          const change = changes[0];
          if (change === undefined) return;
          await sql.run(
            "INSERT INTO typed_sheets_flush_audit (change_kind, entity_name, primary_key, payload_json) VALUES (?, ?, ?, ?)",
            [
              change.kind,
              change.entityName,
              primaryKeyValue(change),
              JSON.stringify(change.payload),
            ],
          );
          throw new Error("flush plan rejected");
        },
      },
    });
    const em = typedSheetsOrm.em.fork();

    em.persist(em.create(Order, { id: "order-rolled-back", status: "pending" }));

    await expect(em.flush()).rejects.toThrow("flush plan rejected");
    expect(await orm.em.fork().find(Order, {})).toEqual([]);
    expect(await adapter.read(({ sql }) => {
      return sql.all<FlushAuditRow>(
        "SELECT change_kind, entity_name, primary_key FROM typed_sheets_flush_audit",
      );
    })).toEqual([]);
  });
});

function createAuditFlushCoordinator(
  observedChanges: TypedSheetsEntityChange[],
): TypedSheetsFlushCoordinator {
  return {
    async onFlush({ changes, sql }) {
      observedChanges.push(...changes);
      for (const change of changes) {
        await sql.run(
          "INSERT INTO typed_sheets_flush_audit (change_kind, entity_name, primary_key, payload_json) VALUES (?, ?, ?, ?)",
          [
            change.kind,
            change.entityName,
            primaryKeyValue(change),
            JSON.stringify(change.payload),
          ],
        );
      }
    },
  };
}

function primaryKeyValue(change: TypedSheetsEntityChange): string | null {
  return change.primaryKey.kind === PRESENCE_KINDS.PRESENT
    ? change.primaryKey.value
    : null;
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
        primary_key TEXT,
        payload_json TEXT NOT NULL
      )
    `);
  });
}
