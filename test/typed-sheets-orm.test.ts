import {
  defineEntity,
  MikroORM,
  NodeSqliteDialect,
  p,
  SqliteDriver,
} from "@mikro-orm/sql";
import { afterEach, describe, expect, it } from "vitest";

import { PRESENCE_KINDS } from "../src/shared/state/index.js";
import {
  TYPED_SHEETS_ENTITY_CHANGE_KINDS,
  type TypedSheetsEntityChange,
  type TypedSheetsFlushCoordinator,
} from "../src/application/orm/index.js";
import {
  createMikroOrmSqliteAdapter,
  createTypedSheetsOrm,
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

describe("TypedSheetsOrm", () => {
  const openOrms: Array<Awaited<ReturnType<typeof createOrm>>> = [];

  afterEach(async () => {
    await Promise.all(openOrms.splice(0).map((orm) => orm.close(true)));
  });

  it("uses our MikroORM-shaped entity lifecycle and writes its plan atomically", async () => {
    const orm = await createOrm();
    openOrms.push(orm);
    const adapter = createMikroOrmSqliteAdapter(orm);

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

  });

  it("uses the same lifecycle coordinator for transactional work", async () => {
    const orm = await createOrm();
    openOrms.push(orm);
    const adapter = createMikroOrmSqliteAdapter(orm);

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

    const typedSheetsOrm = createTypedSheetsOrm(adapter, {
      flushCoordinator: {
        async onFlush({ changes }) {
          const change = changes[0];
          if (change === undefined) return;
          throw new Error("flush plan rejected");
        },
      },
    });
    const em = typedSheetsOrm.em.fork();

    em.persist(em.create(Order, { id: "order-rolled-back", status: "pending" }));

    await expect(em.flush()).rejects.toThrow("flush plan rejected");
    expect(await orm.em.fork().find(Order, {})).toEqual([]);
  });
});

function createAuditFlushCoordinator(
  observedChanges: TypedSheetsEntityChange[],
): TypedSheetsFlushCoordinator {
  return {
    async onFlush({ changes }) {
      observedChanges.push(...changes);
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
