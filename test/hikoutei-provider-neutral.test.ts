import { describe, expect, it } from "vitest";

import { defineTypedSheetsEntity, HIKOUTEI_ERROR_CODES } from "../src/index.js";
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
} from "@hikoutei/contracts/storage/scalar.js";

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

describe("EntityManager offset-only paging contract", () => {
  // These are provider-neutral guarantees that hold for every engine behind
  // the public EntityManager: the query carries an offset through without a
  // limit, the result slices the same way the SQLite idiom would, and the
  // validation/paging restrictions are enforced before any provider is reached.
  it("find() with offset and no limit returns all rows after the offset", async () => {
    const { em } = buildManager();
    // Seeded in reverse so each slicing assertion can only pass when the
    // provider-neutral paged query applies its default primary-key ascending
    // order; without that normalization fallback the fake provider would
    // return rows in insertion order.
    for (const id of ["e", "d", "c", "b", "a"]) {
      em.persist(em.create(Product, { id, label: id, price: id.length }));
    }
    await em.flush();

    expect((await em.find(Product, {}, { offset: 2 })).map((row) => row.id))
      .toEqual(["c", "d", "e"]);
    // An offset of 0 with no limit is equivalent to the unpaged read.
    expect((await em.find(Product, {}, { offset: 0 })).map((row) => row.id))
      .toEqual(["a", "b", "c", "d", "e"]);
    // An offset beyond the row count returns an empty readonly array.
    expect(await em.find(Product, {}, { offset: 100 })).toEqual([]);
    // An explicit `limit: 0` must yield an empty page, not be mistaken for an
    // offset-only read that would return the tail. This guards the provider
    // against truthiness-based slicing (`if (limit)` instead of nullish
    // coalescing), which would incorrectly treat zero as "no limit".
    expect(await em.find(Product, {}, { limit: 0, offset: 2 })).toEqual([]);
  });

  it("rejects a negative or non-integer offset before reaching the provider", async () => {
    const { em } = buildManager();
    await expect(em.find(Product, {}, { offset: -1 })).rejects.toMatchObject({
      code: HIKOUTEI_ERROR_CODES.INVALID_SCALAR_VALUE,
    });
    await expect(em.find(Product, {}, { offset: 1.5 })).rejects.toMatchObject({
      code: HIKOUTEI_ERROR_CODES.INVALID_SCALAR_VALUE,
    });
  });

  it("rejects paging options on findOne", async () => {
    const { em } = buildManager();
    // findOne intentionally has no paging surface; the option is rejected at the
    // query-normalization boundary with a stable INVALID_QUERY code before the
    // provider is consulted.
    await expect(em.findOne(Product, {}, { offset: 1 } as never)).rejects.toMatchObject({
      code: HIKOUTEI_ERROR_CODES.INVALID_QUERY,
    });
    await expect(em.findOne(Product, {}, { limit: 1 } as never)).rejects.toMatchObject({
      code: HIKOUTEI_ERROR_CODES.INVALID_QUERY,
    });
  });
});

describe("EntityManager limit paging contract", () => {
  // The default primary-key ascending order is a provider-neutral guarantee
  // that must hold for every paging trigger, not only `offset`. A bare
  // `{ limit }` (no offset, no orderBy) is still paged, so the normalized query
  // must carry a primary-key ascending ORDER BY; without it, a regression that
  // computed "paged" from `offset` alone would leave rows in insertion order.
  // This complements the committed offset-only regression, which proves the
  // same normalization only for the offset trigger.
  it("find() with limit and no orderBy applies the default primary-key ascending order", async () => {
    const { em } = buildManager();
    // Seeded in reverse so the assertion can only pass when the paged query
    // applies its default primary-key ascending order; insertion order would
    // otherwise surface as ["e", "d"].
    for (const id of ["e", "d", "c", "b", "a"]) {
      em.persist(em.create(Product, { id, label: id, price: id.length }));
    }
    await em.flush();

    expect((await em.find(Product, {}, { limit: 2 })).map((row) => row.id))
      .toEqual(["a", "b"]);
    // A limit larger than the row count returns every row, still ordered by the
    // primary key ascending despite the reverse seed.
    expect((await em.find(Product, {}, { limit: 10 })).map((row) => row.id))
      .toEqual(["a", "b", "c", "d", "e"]);
  });

  // `limit` is validated by the same helper as `offset`, but its rejection is a
  // distinct stable-code guarantee: a regression that validated only `offset`
  // would let an invalid `limit` reach the provider. Mirrors the committed
  // offset validation test for the limit option.
  it("rejects a negative or non-integer limit before reaching the provider", async () => {
    const { em } = buildManager();
    await expect(em.find(Product, {}, { limit: -1 })).rejects.toMatchObject({
      code: HIKOUTEI_ERROR_CODES.INVALID_SCALAR_VALUE,
    });
    await expect(em.find(Product, {}, { limit: 1.5 })).rejects.toMatchObject({
      code: HIKOUTEI_ERROR_CODES.INVALID_SCALAR_VALUE,
    });
  });
});

describe("EntityManager query shape validation", () => {
  // The top-level filter and options must be plain objects. These runtime
  // boundaries are reached when an application builds a query dynamically and
  // hands in the wrong shape (for example a bare value instead of
  // `{ field: value }`); they must fail with the stable INVALID_QUERY code
  // before any provider is consulted.
  it("rejects a non-object filter and non-object options with INVALID_QUERY", async () => {
    const { em } = buildManager();
    await expect(em.find(Product, "not-a-filter" as never)).rejects.toMatchObject({
      code: HIKOUTEI_ERROR_CODES.INVALID_QUERY,
    });
    await expect(em.find(Product, {}, 42 as never)).rejects.toMatchObject({
      code: HIKOUTEI_ERROR_CODES.INVALID_QUERY,
    });
  });
});

describe("EntityManager explicit null filter contract", () => {
  // An omitted `where` (undefined) is the empty, match-all filter, but an
  // explicit `null` is a malformed query that must fail with the stable
  // INVALID_QUERY code before any provider is consulted. The earlier
  // `where ?? {}` coercion silently broadened reads/counts by turning an
  // explicit `null` into the match-all filter; these regression assertions pin
  // the distinction for all three collection APIs without altering `findOne`.
  it("rejects an explicit null filter on find, count, and findAndCount", async () => {
    const { em } = buildManager();
    em.persist(em.create(Product, { id: "a", label: "a", price: 1 }));
    await em.flush();

    await expect(em.find(Product, null as never)).rejects.toMatchObject({
      code: HIKOUTEI_ERROR_CODES.INVALID_QUERY,
    });
    await expect(em.count(Product, null as never)).rejects.toMatchObject({
      code: HIKOUTEI_ERROR_CODES.INVALID_QUERY,
    });
    await expect(em.findAndCount(Product, null as never)).rejects.toMatchObject({
      code: HIKOUTEI_ERROR_CODES.INVALID_QUERY,
    });
  });

  it("treats an omitted where as the empty match-all filter", async () => {
    const { em } = buildManager();
    em.persist(em.create(Product, { id: "a", label: "a", price: 1 }));
    em.persist(em.create(Product, { id: "b", label: "b", price: 2 }));
    await em.flush();

    // Omitting `where` (undefined) must keep the match-all behavior across all
    // three collection APIs; a regression that rejected undefined here would
    // break find/count/findAndCount with no arguments.
    // Unpaged find/findAndCount have no ordering contract, so compare the
    // returned IDs order-independently while still asserting both rows match.
    expect((await em.find(Product)).map((row) => row.id).sort()).toEqual(["a", "b"]);
    expect(await em.count(Product)).toBe(2);
    const [rows, total] = await em.findAndCount(Product);
    expect(rows.map((row) => row.id).sort()).toEqual(["a", "b"]);
    expect(total).toBe(2);
  });
});
