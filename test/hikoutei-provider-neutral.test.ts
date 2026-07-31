import { describe, expect, it } from "vitest";

import { defineTypedSheetsEntity } from "../src/index.js";
import { getEntityDescriptor } from "../src/api/entity.js";
import { createEntityManager } from "../src/api/internalEntityManager.js";
import type {
  ScalarEntityDelete,
  ScalarEntityInsert,
  ScalarEntityPersistenceProvider,
  ScalarEntityQuery,
  ScalarEntityRow,
  ScalarEntityTransaction,
  ScalarEntityUpdate,
  ScalarEntityValue,
} from "../src/adapter/persistence/contracts/scalar.js";

/**
 * A fully in-memory provider-neutral persistence provider.
 *
 * It implements the exact internal contract the public `EntityManager` depends
 * on, proving the lifecycle and dirty tracking are engine-neutral: no
 * node:sqlite, MikroORM, or raw-SQL type is referenced anywhere in the path.
 */
class FakeScalarPersistenceProvider implements ScalarEntityPersistenceProvider {
  readonly recordedChanges: Array<{ readonly kind: string; readonly table: string }> = [];
  private readonly rows = new Map<string, Map<string, Record<string, ScalarEntityValue>>>([
    ["products", new Map()],
  ]);


  async beginTransaction<Result>(
    work: (transaction: ScalarEntityTransaction) => Promise<Result>,
  ): Promise<Result> {
    const transaction: ScalarEntityTransaction = {
      insert: async (row: ScalarEntityInsert) => {
        this.recordedChanges.push({ kind: "insert", table: row.tableName });
        this.table(row.tableName).set(String(row.values[row.primaryKeyColumn]), { ...row.values });
      },
      update: async (row: ScalarEntityUpdate) => {
        this.recordedChanges.push({ kind: "update", table: row.tableName });
        const existing = this.table(row.tableName).get(String(row.primaryKeyValue));
        if (existing !== undefined) Object.assign(existing, row.changedValues);
      },
      delete: async (row: ScalarEntityDelete) => {
        this.recordedChanges.push({ kind: "delete", table: row.tableName });
        this.table(row.tableName).delete(String(row.primaryKeyValue));
      },
      read: async (query: ScalarEntityQuery) => this.readSync(query),
      flush: async () => undefined,
    };
    return work(transaction);
  }

  async read(query: ScalarEntityQuery): Promise<readonly ScalarEntityRow[]> {
    return this.readSync(query);
  }

  async close(): Promise<void> {
    /* no-op */
  }

  private readSync(query: ScalarEntityQuery): readonly ScalarEntityRow[] {
    const rows = [...this.table(query.tableName).values()];
    const filters = Object.entries(query.where);
    return rows
      .filter((row) => filters.every(([key, value]) => row[key] === value))
      .slice(query.offset ?? 0, query.limit === undefined ? undefined : (query.offset ?? 0) + query.limit);
  }

  private table(name: string): Map<string, Record<string, ScalarEntityValue>> {
    const table = this.rows.get(name);
    if (table === undefined) throw new Error(`unknown table ${name}`);
    return table;
  }
}

const Product = defineTypedSheetsEntity({
  name: "Product",
  tableName: "products",
  properties: {
    id: { type: "string", primary: true },
    label: { type: "string" },
    price: { type: "number" },
  },
});

function buildManager() {
  const provider = new FakeScalarPersistenceProvider();
  const descriptor = getEntityDescriptor(Product);
  const descriptors = new Map([[descriptor.name, descriptor]]);
  const em = createEntityManager(provider, descriptors);
  return { provider, em };
}

describe("EntityManager provider-neutral semantics", () => {
  it("emits one insert for a new entity and one update for a dirty field", async () => {
    const { provider, em } = buildManager();

    em.create(Product, { id: "p1", label: "first", price: 10 });
    await em.flush();
    expect(provider.recordedChanges).toEqual([{ kind: "insert", table: "products" }]);

    const loaded = await em.findOne(Product, { id: "p1" });
    if (loaded === null) throw new Error("expected the loaded product");
    loaded.price = 12;
    await em.flush();
    expect(provider.recordedChanges).toEqual([
      { kind: "insert", table: "products" },
      { kind: "update", table: "products" },
    ]);
  });

  it("emits a delete for a removed managed entity", async () => {
    const { provider, em } = buildManager();

    const product = em.create(Product, { id: "p2", label: "doomed", price: 1 });
    await em.flush();
    em.remove(product);
    await em.flush();

    expect(provider.recordedChanges).toEqual([
      { kind: "insert", table: "products" },
      { kind: "delete", table: "products" },
    ]);
    expect(await em.findOne(Product, { id: "p2" })).toBeNull();
  });

  it("does not depend on any SQL executor or ORM type", async () => {
    // The fake provider implements only ScalarEntityPersistenceProvider; if the
    // manager required SqlExecutor/MikroORM types this would not typecheck.
    const { em } = buildManager();
    em.persist(em.create(Product, { id: "x", label: "l", price: 1 }));
    await em.flush();
    expect(await em.findOne(Product, { id: "x" })).toMatchObject({ id: "x" });
  });
});
