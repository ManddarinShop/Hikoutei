import { describe, expect, it } from "vitest";

import { defineTypedSheetsEntity } from "../src/index.js";
import { getEntityDescriptor } from "../src/api/entity.js";
import { createEntityManager } from "../src/api/internalEntityManager.js";
import type {
  ScalarEntityCountQuery,
  ScalarEntityDelete,
  ScalarEntityInsert,
  ScalarEntityPersistenceProvider,
  ScalarEntityPredicate,
  ScalarEntityQuery,
  ScalarEntityReader,
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
  snapshotReads = 0;
  mutateLiveRowsAfterSnapshotRead = false;
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
      count: async (query: ScalarEntityCountQuery) => this.countSync(query),
      flush: async () => undefined,
    };
    return work(transaction);
  }

  async read(query: ScalarEntityQuery): Promise<readonly ScalarEntityRow[]> {
    return this.readSync(query);
  }

  async count(query: ScalarEntityCountQuery): Promise<number> {
    return this.countSync(query);
  }

  async readSnapshot<Result>(
    work: (reader: ScalarEntityReader) => Promise<Result>,
  ): Promise<Result> {
    const snapshot = cloneRows(this.rows);
    const reader: ScalarEntityReader = {
      read: async (query) => {
        this.snapshotReads += 1;
        const result = readRows(snapshot, query);
        if (this.mutateLiveRowsAfterSnapshotRead) {
          this.table(query.tableName).set("concurrent", {
            id: "concurrent",
            label: "concurrent",
            price: 999,
          });
        }
        return result;
      },
      count: async (query) => countRows(snapshot, query),
    };
    return work(reader);
  }

  async close(): Promise<void> {
    /* no-op */
  }

  private readSync(query: ScalarEntityQuery): readonly ScalarEntityRow[] {
    return readRows(this.rows, query);
  }

  private countSync(query: ScalarEntityCountQuery): number {
    return countRows(this.rows, query);
  }

  private table(name: string): Map<string, Record<string, ScalarEntityValue>> {
    const table = this.rows.get(name);
    if (table === undefined) throw new Error(`unknown table ${name}`);
    return table;
  }
}

function cloneRows(
  rows: ReadonlyMap<string, Map<string, Record<string, ScalarEntityValue>>>,
): Map<string, Map<string, Record<string, ScalarEntityValue>>> {
  return new Map([...rows].map(([table, tableRows]) => [
    table,
    new Map([...tableRows].map(([key, row]) => [key, { ...row }])),
  ]));
}

function readRows(
  tables: ReadonlyMap<string, Map<string, Record<string, ScalarEntityValue>>>,
  query: ScalarEntityQuery,
): readonly ScalarEntityRow[] {
  const table = tables.get(query.tableName);
  if (table === undefined) throw new Error(`unknown table ${query.tableName}`);
  let rows = [...table.values()].filter((row) => matches(query.predicate, row));
  if (query.orderBy.length > 0) {
    rows = rows.sort((left, right) => compareRows(left, right, query.orderBy));
  }
  return rows.slice(
    query.offset ?? 0,
    query.limit === undefined ? undefined : (query.offset ?? 0) + query.limit,
  );
}

function countRows(
  tables: ReadonlyMap<string, Map<string, Record<string, ScalarEntityValue>>>,
  query: ScalarEntityCountQuery,
): number {
  const table = tables.get(query.tableName);
  if (table === undefined) throw new Error(`unknown table ${query.tableName}`);
  return [...table.values()].filter((row) => matches(query.predicate, row)).length;
}

function matches(
  predicate: ScalarEntityPredicate,
  row: Readonly<Record<string, ScalarEntityValue>>,
): boolean {
  switch (predicate.kind) {
    case "constant": return predicate.value;
    case "all": return predicate.predicates.every((child) => matches(child, row));
    case "any": return predicate.predicates.some((child) => matches(child, row));
    case "null": return predicate.operator === "is_null"
      ? row[predicate.field] === null
      : row[predicate.field] !== null && row[predicate.field] !== undefined;
    case "set": {
      const included = predicate.values.some((value) => same(value, row[predicate.field]));
      return predicate.operator === "in" ? included : !included;
    }
    case "like": {
      const value = row[predicate.field];
      if (typeof value !== "string") return false;
      const pattern = predicate.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(/%/g, ".*").replace(/_/g, ".");
      return new RegExp(`^${pattern}$`).test(value);
    }
    case "comparison": {
      const actual = row[predicate.field];
      if (actual === null || actual === undefined) return false;
      const comparison = compare(actual, predicate.value);
      switch (predicate.operator) {
        case "eq": return comparison === 0;
        case "ne": return comparison !== 0;
        case "gt": return comparison > 0;
        case "gte": return comparison >= 0;
        case "lt": return comparison < 0;
        case "lte": return comparison <= 0;
      }
    }
  }
}

function compareRows(
  left: Readonly<Record<string, ScalarEntityValue>>,
  right: Readonly<Record<string, ScalarEntityValue>>,
  orderBy: ScalarEntityQuery["orderBy"],
): number {
  for (const order of orderBy) {
    const result = compareNullable(left[order.field] ?? null, right[order.field] ?? null);
    if (result !== 0) return order.direction === "asc" ? result : -result;
  }
  return 0;
}

function compareNullable(left: ScalarEntityValue, right: ScalarEntityValue): number {
  if (left === null) return right === null ? 0 : -1;
  if (right === null) return 1;
  return compare(left, right);
}

function compare(
  left: Exclude<ScalarEntityValue, null>,
  right: Exclude<ScalarEntityValue, null>,
): number {
  const leftValue = left instanceof Date ? left.getTime() : left;
  const rightValue = right instanceof Date ? right.getTime() : right;
  if (leftValue === rightValue) return 0;
  return leftValue < rightValue ? -1 : 1;
}

function same(left: Exclude<ScalarEntityValue, null>, right: ScalarEntityValue | undefined): boolean {
  if (right === undefined || right === null) return false;
  return compare(left, right) === 0;
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

  it("combines rows and count against one provider snapshot", async () => {
    const { provider, em } = buildManager();
    for (const id of ["a", "b"]) {
      em.persist(em.create(Product, { id, label: id, price: 1 }));
    }
    await em.flush();
    provider.mutateLiveRowsAfterSnapshotRead = true;

    const [rows, total] = await em.findAndCount(Product, {}, { orderBy: { id: "asc" } });
    expect(rows.map((row) => row.id)).toEqual(["a", "b"]);
    expect(total).toBe(2);
    expect(provider.snapshotReads).toBe(1);
    expect(await em.count(Product)).toBe(3);
  });
});
