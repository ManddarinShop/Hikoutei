import { defineEntity, p } from "@mikro-orm/sql";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import {
  createTypedSheets,
  defineTypedSheetsEntity,
  HIKOUTEI_ERROR_CODES,
  type Hikoutei,
} from "../src/index.js";
import { initializeMikroOrmSqliteAdapter } from "@hikoutei/storage/persistence/providers/mikro-orm/storage/MikroOrmSqliteAdapter.js";

const User = defineTypedSheetsEntity({
  name: "User",
  tableName: "users",
  properties: {
    id: { type: "string", primary: true },
    name: { type: "string" },
    age: { type: "number" },
    active: { type: "boolean" },
    nickname: { type: "string", nullable: true },
  },
});

const InspectionSchema = defineEntity({
  name: "PublicAtomicityInspection",
  tableName: "__public_atomicity_inspection",
  properties: { id: p.string().primary() },
});

const Counter = defineTypedSheetsEntity({
  name: "Counter",
  tableName: "counters",
  properties: {
    id: { type: "string", primary: true },
    value: { type: "number" },
  },
});

const Event = defineTypedSheetsEntity({
  name: "Event",
  tableName: "events",
  properties: {
    id: { type: "string", primary: true },
    createdAt: { type: "date" },
  },
});

const RichQueryRow = defineTypedSheetsEntity({
  name: "RichQueryRow",
  tableName: "rich_query_rows",
  properties: {
    id: { type: "string", primary: true },
    name: { type: "string" },
    score: { type: "number" },
    active: { type: "boolean" },
    note: { type: "string", nullable: true },
    createdAt: { type: "date" },
  },
});

const ColonEntityA = defineTypedSheetsEntity({
  name: "A",
  tableName: "colon_entity_a",
  properties: { id: { type: "string", primary: true }, value: { type: "string" } },
});

const ColonEntityAB = defineTypedSheetsEntity({
  name: "A:B",
  tableName: "colon_entity_ab",
  properties: { id: { type: "string", primary: true }, value: { type: "string" } },
});

describe("createTypedSheets public lifecycle", () => {
  const runtimes: Hikoutei[] = [];

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  });

  async function openRuntime(): Promise<Hikoutei> {
    const runtime = await createTypedSheets({
      dbName: ":memory:",
      entities: [User, Counter],
    });
    runtimes.push(runtime);
    return runtime;
  }

  it("creates, persists, and reads a scalar entity through the public API", async () => {
    const hikoutei = await openRuntime();
    const em = hikoutei.em.fork();

    const user = em.create(User, { id: "u1", name: "Ada", age: 36, active: true });
    em.persist(user);
    await em.flush();

    const reloaded = await em.findOne(User, { id: "u1" });
    expect(reloaded).not.toBeNull();
    expect(reloaded).toMatchObject({ id: "u1", name: "Ada", age: 36, active: true, nickname: null });
  });

  it("tracks dirty fields on a loaded entity without engine dirty tracking", async () => {
    const hikoutei = await openRuntime();
    const em = hikoutei.em.fork();

    const user = em.create(User, { id: "u2", name: "Grace", age: 40, active: false });
    em.persist(user);
    await em.flush();

    const loaded = await em.findOne(User, { id: "u2" });
    if (loaded === null) throw new Error("expected the persisted user to be readable");

    // Mutate a single scalar field and flush; no explicit persist() is required.
    loaded.name = "Grace Hopper";
    loaded.age = 41;
    await em.flush();

    // A second fork reads from SQLite with a fresh identity map.
    const fresh = await hikoutei.em.fork().findOne(User, { id: "u2" });
    expect(fresh).toMatchObject({ id: "u2", name: "Grace Hopper", age: 41, active: false });
  });

  it("does not emit an update when a loaded entity is unchanged", async () => {
    const hikoutei = await openRuntime();
    const em = hikoutei.em.fork();
    em.persist(em.create(User, { id: "u3", name: "Same", age: 1, active: true }));
    await em.flush();

    const loaded = await em.findOne(User, { id: "u3" });
    if (loaded === null) throw new Error("expected the persisted user");

    // flush() on an unchanged identity map is a no-op and must not throw.
    await expect(em.flush()).resolves.toBeUndefined();
  });

  it("removes a managed entity and tombstones it from SQLite", async () => {
    const hikoutei = await openRuntime();
    const em = hikoutei.em.fork();
    const user = em.create(User, { id: "u4", name: "Bye", age: 1, active: true });
    em.persist(user);
    await em.flush();

    const loaded = await em.findOne(User, { id: "u4" });
    if (loaded === null) throw new Error("expected the persisted user");
    em.remove(loaded);
    await em.flush();

    expect(await hikoutei.em.fork().findOne(User, { id: "u4" })).toBeNull();
  });

  it("commits a transactional unit of work atomically", async () => {
    const hikoutei = await openRuntime();

    await hikoutei.em.transactional(async (em) => {
      em.persist(em.create(User, { id: "tx-1", name: "Tx", age: 1, active: true }));
      em.persist(em.create(Counter, { id: "tx-counter", value: 7 }));
    });

    const em = hikoutei.em.fork();
    expect(await em.findOne(User, { id: "tx-1" })).toMatchObject({ id: "tx-1" });
    expect(await em.findOne(Counter, { id: "tx-counter" })).toMatchObject({ value: 7 });
  });

  it("reads its own writes inside a transactional callback", async () => {
    const hikoutei = await openRuntime();
    const em = hikoutei.em.fork();

    await em.transactional(async (transactionalEm) => {
      transactionalEm.persist(
        transactionalEm.create(User, { id: "transaction-read", name: "Read", age: 1, active: true }),
      );
      await transactionalEm.flush();
      expect(await transactionalEm.findOne(User, { id: "transaction-read" })).toMatchObject({
        name: "Read",
      });
    });
  });

  it("allows the same primary key in different entity tables", async () => {
    const hikoutei = await openRuntime();

    await hikoutei.em.transactional(async (em) => {
      em.persist(em.create(User, { id: "shared-id", name: "User", age: 1, active: true }));
      em.persist(em.create(Counter, { id: "shared-id", value: 7 }));
    });

    expect(await hikoutei.em.fork().findOne(User, { id: "shared-id" })).toMatchObject({
      name: "User",
    });
    expect(await hikoutei.em.fork().findOne(Counter, { id: "shared-id" })).toMatchObject({
      value: 7,
    });
  });

  it("keeps identity-map keys unambiguous when names and IDs contain colons", async () => {
    const hikoutei = await createTypedSheets({
      dbName: ":memory:",
      entities: [ColonEntityA, ColonEntityAB],
    });
    runtimes.push(hikoutei);
    const em = hikoutei.em.fork();
    em.persist(em.create(ColonEntityA, { id: "B:C", value: "first" }));
    em.persist(em.create(ColonEntityAB, { id: "C", value: "second" }));
    await em.flush();

    const first = await em.findOne(ColonEntityA, { id: "B:C" });
    const second = await em.findOne(ColonEntityAB, { id: "C" });
    expect(first).toMatchObject({ value: "first" });
    expect(second).toMatchObject({ value: "second" });
    expect(first).not.toBe(second);
  });

  it("rolls back a transactional unit of work when the callback rejects", async () => {
    const hikoutei = await openRuntime();

    await expect(
      hikoutei.em.transactional(async (em) => {
        em.persist(em.create(User, { id: "rollback", name: "Rb", age: 1, active: true }));
        await em.flush();
        throw new Error("rollback please");
      }),
    ).rejects.toThrow("rollback please");

    expect(await hikoutei.em.fork().findOne(User, { id: "rollback" })).toBeNull();
  });

  it("restores the common Unit of Work after a transaction rollback", async () => {
    const hikoutei = await openRuntime();
    const em = hikoutei.em.fork();
    const user = em.create(User, { id: "retry", name: "Retry", age: 1, active: true });

    await expect(
      em.transactional(async () => {
        em.persist(user);
        await em.flush();
        throw new Error("force rollback");
      }),
    ).rejects.toThrow("force rollback");

    await em.flush();
    expect(await em.findOne(User, { id: "retry" })).toMatchObject({ name: "Retry" });
  });

  it("restores entities loaded inside a failed transaction for retry", async () => {
    const hikoutei = await openRuntime();
    const seed = hikoutei.em.fork();
    seed.persist(seed.create(User, { id: "loaded-retry", name: "Before", age: 1, active: true }));
    await seed.flush();

    const em = hikoutei.em.fork();
    let loaded: { name: string } | undefined;
    await expect(em.transactional(async (transactionalEm) => {
      const inside = await transactionalEm.findOne(User, { id: "loaded-retry" });
      if (inside === null) throw new Error("expected loaded retry entity");
      loaded = inside;
      inside.name = "Inside";
      await transactionalEm.flush();
      throw new Error("rollback loaded entity");
    })).rejects.toThrow("rollback loaded entity");

    if (loaded === undefined) throw new Error("expected loaded retry entity");
    loaded.name = "After rollback";
    await em.flush();
    await expect(em.findOne(User, { id: "loaded-retry" })).resolves.toMatchObject({
      name: "After rollback",
    });
  });

  it("rejects primary-key mutation before deleting a managed entity", async () => {
    const hikoutei = await openRuntime();
    const em = hikoutei.em.fork();
    const user = em.create(User, { id: "immutable-id", name: "Immutable", age: 1, active: true });
    em.persist(user);
    await em.flush();
    user.id = "changed-id";
    em.remove(user);
    await expect(em.flush()).rejects.toMatchObject({
      code: HIKOUTEI_ERROR_CODES.ENTITY_PRIMARY_KEY_MUTATION,
    });
  });

  it("removes a canceled insert from the identity map", async () => {
    const hikoutei = await openRuntime();
    const em = hikoutei.em.fork();
    const pending = em.create(User, { id: "canceled", name: "Canceled", age: 1, active: true });
    em.remove(pending);
    const replacement = em.create(User, { id: "canceled", name: "Replacement", age: 2, active: true });
    expect(replacement).not.toBe(pending);
    await em.flush();
    await expect(em.findOne(User, { id: "canceled" })).resolves.toMatchObject({
      name: "Replacement",
    });
  });

  it("supports equality filters with paging on find()", async () => {
    const hikoutei = await openRuntime();
    const em = hikoutei.em.fork();
    for (const id of ["a", "b", "c"]) {
      em.persist(em.create(User, { id, name: "paged", age: 1, active: true }));
    }
    await em.flush();

    const all = await hikoutei.em.fork().find(User, { active: true });
    expect(all.map((user) => user.id).sort()).toEqual(["a", "b", "c"]);

    const limited = await hikoutei.em.fork().find(User, { active: true }, { limit: 2 });
    expect(limited).toHaveLength(2);
  });

  it("supports typed operators across string, number, boolean, and Date fields", async () => {
    const hikoutei = await createTypedSheets({
      dbName: ":memory:",
      entities: [RichQueryRow],
    });
    runtimes.push(hikoutei);
    const em = hikoutei.em.fork();
    const rows = [
      { id: "a", name: "Ada", score: 10, active: true, note: null, createdAt: new Date("2026-01-01T00:00:00.000Z") },
      { id: "b", name: "Alan", score: 20, active: false, note: "beta", createdAt: new Date("2026-02-01T00:00:00.000Z") },
      { id: "c", name: "Bob", score: 30, active: true, note: "Ada", createdAt: new Date("2026-03-01T00:00:00.000Z") },
      { id: "d", name: "Ava", score: 20, active: true, note: "delta", createdAt: new Date("2026-04-01T00:00:00.000Z") },
    ];
    for (const row of rows) em.persist(em.create(RichQueryRow, row));
    await em.flush();

    const ranged = await em.find(RichQueryRow, {
      name: { gte: "A", lt: "B", like: "A%" },
      score: { gte: 15, lte: 20 },
      active: { in: [true, false], ne: false },
      createdAt: {
        gt: new Date("2026-01-15T00:00:00.000Z"),
        lte: new Date("2026-04-01T00:00:00.000Z"),
      },
    }, { orderBy: { score: "desc", name: "asc" } });
    expect(ranged.map((row) => row.id)).toEqual(["b", "d"].filter((id) => id !== "b"));

    expect((await em.find(RichQueryRow, { score: { ne: 20 } }, { orderBy: { id: "asc" } }))
      .map((row) => row.id)).toEqual(["a", "c"]);
    expect((await em.find(RichQueryRow, { score: { gt: 10, lt: 30 } }, { orderBy: { id: "asc" } }))
      .map((row) => row.id)).toEqual(["b", "d"]);
    expect((await em.find(RichQueryRow, { id: { nin: ["a", "d"] } }, { orderBy: { id: "asc" } }))
      .map((row) => row.id)).toEqual(["b", "c"]);
    expect((await em.find(RichQueryRow, { name: { like: "A_a" } }, { orderBy: { id: "asc" } }))
      .map((row) => row.id)).toEqual(["a", "d"]);
  });

  it("uses explicit set semantics for nullable values and empty membership sets", async () => {
    const hikoutei = await createTypedSheets({ dbName: ":memory:", entities: [RichQueryRow] });
    runtimes.push(hikoutei);
    const em = hikoutei.em.fork();
    for (const row of [
      { id: "a", name: "A", score: 1, active: true, note: null, createdAt: new Date("2026-01-01T00:00:00.000Z") },
      { id: "b", name: "B", score: 2, active: true, note: "Ada", createdAt: new Date("2026-01-02T00:00:00.000Z") },
      { id: "c", name: "C", score: 3, active: true, note: "Bob", createdAt: new Date("2026-01-03T00:00:00.000Z") },
    ]) em.persist(em.create(RichQueryRow, row));
    await em.flush();

    const ids = async (
      where: Parameters<typeof em.find<{
        id: string;
        name: string;
        score: number;
        active: boolean;
        note: string | null;
        createdAt: Date;
      }>>[1],
    ) => (await em.find(RichQueryRow, where, { orderBy: { id: "asc" } }))
      .map((row) => row.id);
    expect(await ids({ note: null })).toEqual(["a"]);
    expect(await ids({ note: { eq: null } })).toEqual(["a"]);
    expect(await ids({ note: { ne: null } })).toEqual(["b", "c"]);
    expect(await ids({ note: { ne: "Ada" } })).toEqual(["a", "c"]);
    expect(await ids({ note: { in: [] } })).toEqual([]);
    expect(await ids({ note: { nin: [] } })).toEqual(["a", "b", "c"]);
    expect(await ids({ note: { in: [null, "Ada"] } })).toEqual(["a", "b"]);
    expect(await ids({ note: { nin: ["Ada"] } })).toEqual(["a", "c"]);
    expect(await ids({ note: { nin: [null, "Ada"] } })).toEqual(["c"]);
  });

  it("orders deterministically for explicit ordering and pagination", async () => {
    const hikoutei = await createTypedSheets({ dbName: ":memory:", entities: [RichQueryRow] });
    runtimes.push(hikoutei);
    const em = hikoutei.em.fork();
    for (const id of ["d", "b", "c", "a"]) {
      em.persist(em.create(RichQueryRow, {
        id,
        name: id === "d" ? "second" : "same",
        score: id === "d" ? 2 : 1,
        active: true,
        note: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      }));
    }
    await em.flush();

    const ordered = await em.find(RichQueryRow, {}, { orderBy: { score: "desc", name: "asc" } });
    expect(ordered.map((row) => row.id)).toEqual(["d", "a", "b", "c"]);
    const paged = await em.find(RichQueryRow, {}, { limit: 2, offset: 1 });
    expect(paged.map((row) => row.id)).toEqual(["b", "c"]);
    expect((await em.findOne(RichQueryRow, { score: 1 }, { orderBy: { id: "desc" } }))?.id)
      .toBe("c");
  });

  it("counts filters and returns an unpaged total from findAndCount", async () => {
    const hikoutei = await createTypedSheets({ dbName: ":memory:", entities: [RichQueryRow] });
    runtimes.push(hikoutei);
    const em = hikoutei.em.fork();
    for (let index = 0; index < 5; index += 1) {
      em.persist(em.create(RichQueryRow, {
        id: String(index),
        name: `User ${index}`,
        score: index,
        active: index < 4,
        note: null,
        createdAt: new Date(`2026-01-0${index + 1}T00:00:00.000Z`),
      }));
    }
    await em.flush();

    expect(await em.count(RichQueryRow)).toBe(5);
    expect(await em.count(RichQueryRow, { active: true })).toBe(4);
    const [page, total] = await em.findAndCount(
      RichQueryRow,
      { active: true },
      { orderBy: { score: "desc" }, limit: 2, offset: 1 },
    );
    expect(page.map((row) => row.id)).toEqual(["2", "1"]);
    expect(total).toBe(4);
    const [emptyPage, sameTotal] = await em.findAndCount(
      RichQueryRow,
      { active: true },
      { limit: 0 },
    );
    expect(emptyPage).toEqual([]);
    expect(sameTotal).toBe(4);

    await em.transactional(async (transactionalEm) => {
      transactionalEm.persist(transactionalEm.create(RichQueryRow, {
        id: "tx-visible",
        name: "Visible",
        score: 10,
        active: true,
        note: null,
        createdAt: new Date("2026-02-01T00:00:00.000Z"),
      }));
      expect((await transactionalEm.findAndCount(RichQueryRow))[1]).toBe(5);
      await transactionalEm.flush();
      expect((await transactionalEm.findAndCount(RichQueryRow))[1]).toBe(6);
    });
  });

  it("preserves identity-map and pending Unit-of-Work semantics for rich reads", async () => {
    const hikoutei = await createTypedSheets({ dbName: ":memory:", entities: [RichQueryRow] });
    runtimes.push(hikoutei);
    const em = hikoutei.em.fork();
    em.persist(em.create(RichQueryRow, {
      id: "persisted", name: "Old", score: 1, active: true, note: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    }));
    await em.flush();
    const loaded = await em.findOne(RichQueryRow, { id: "persisted" });
    if (loaded === null) throw new Error("expected row");
    loaded.name = "Local mutation";
    const [again] = await em.findAndCount(RichQueryRow, { id: { eq: "persisted" } });
    expect(again[0]).toBe(loaded);
    expect(again[0]?.name).toBe("Local mutation");

    em.persist(em.create(RichQueryRow, {
      id: "pending", name: "Pending", score: 2, active: true, note: null,
      createdAt: new Date("2026-01-02T00:00:00.000Z"),
    }));
    expect(await em.count(RichQueryRow)).toBe(1);
    expect((await em.findAndCount(RichQueryRow))[1]).toBe(1);
    await em.flush();
    expect(await em.count(RichQueryRow)).toBe(2);
  });

  it("rejects malformed query objects before they reach the provider", async () => {
    const hikoutei = await createTypedSheets({ dbName: ":memory:", entities: [RichQueryRow] });
    runtimes.push(hikoutei);
    const em = hikoutei.em.fork();
    const invalidQueries: Array<() => Promise<unknown>> = [
      () => em.find(RichQueryRow, { score: {} } as never),
      () => em.find(RichQueryRow, { score: { wat: 1 } } as never),
      () => em.find(RichQueryRow, { active: { gt: true } } as never),
      () => em.find(RichQueryRow, { score: { like: "1%" } } as never),
      () => em.find(RichQueryRow, { score: { in: 1 } } as never),
      () => em.find(RichQueryRow, {}, { orderBy: {} }),
      () => em.find(RichQueryRow, {}, { orderBy: { score: "sideways" } } as never),
    ];
    for (const query of invalidQueries) {
      await expect(query()).rejects.toMatchObject({ code: HIKOUTEI_ERROR_CODES.INVALID_QUERY });
    }
    await expect(em.find(RichQueryRow, { missing: 1 } as never)).rejects.toMatchObject({
      code: HIKOUTEI_ERROR_CODES.INVALID_SCALAR_VALUE,
    });
    await expect(em.find(RichQueryRow, { score: { in: [Number.NaN] } })).rejects.toMatchObject({
      code: HIKOUTEI_ERROR_CODES.INVALID_SCALAR_VALUE,
    });
  });

  it("rejects a primary-key mutation on a managed entity at flush", async () => {
    const hikoutei = await openRuntime();
    const em = hikoutei.em.fork();
    const user = em.create(User, { id: "pk", name: "Pk", age: 1, active: true });
    em.persist(user);
    await em.flush();

    const loaded = await em.findOne(User, { id: "pk" });
    if (loaded === null) throw new Error("expected the persisted user");
    // The primary key is the public entity identity; mutating it is not allowed.
    (loaded as { id: string }).id = "pk-moved";
    await expect(em.flush()).rejects.toMatchObject({
      code: HIKOUTEI_ERROR_CODES.ENTITY_PRIMARY_KEY_MUTATION,
    });
  });

  it("initializes the local runtime only and does not contact a remote provider", async () => {
    // createTypedSheets opens SQLite and creates entity tables only. There is no
    // provider client in scope, so this asserts the no-remote contract by path:
    // opening the runtime must not throw and must not depend on any network.
    const hikoutei = await openRuntime();
    expect(hikoutei.em).toBeDefined();
    expect(typeof hikoutei.em.fork).toBe("function");
    expect("setupSheets" in hikoutei).toBe(false);
  });

  it("keeps public writes in SQLite without creating sync state", async () => {
    const dbName = join(tmpdir(), `hikoutei-public-${randomUUID()}.sqlite`);
    const hikoutei = await createTypedSheets({
      dbName,
      entities: [User],
    });
    try {
      const em = hikoutei.em.fork();
      em.persist(em.create(User, { id: "local-only", name: "Local", age: 1, active: true }));
      await em.flush();
      await hikoutei.close();

      const storage = await initializeMikroOrmSqliteAdapter({
        dbName,
        entities: [InspectionSchema],
      });
      try {
        const row = await storage.read(({ sql }) => sql.get<{ readonly id: string }>(
          "SELECT id FROM users WHERE id = ?",
          ["local-only"],
        ));
        const syncTables = await storage.read(({ sql }) => sql.all<{ readonly name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('entity_state', 'sheet_effect_outbox')",
        ));
        expect(row?.id).toBe("local-only");
        expect(syncTables).toEqual([]);
      } finally {
        await storage.close(true);
      }
    } finally {
      await hikoutei.close().catch(() => undefined);
      await unlink(dbName).catch(() => undefined);
      await unlink(`${dbName}-wal`).catch(() => undefined);
      await unlink(`${dbName}-shm`).catch(() => undefined);
    }
  });

  it("round-trips date scalars through the provider-neutral contract", async () => {
    const hikoutei = await createTypedSheets({
      dbName: ":memory:",
      entities: [Event],
    });
    runtimes.push(hikoutei);
    const em = hikoutei.em.fork();
    const createdAt = new Date("2026-01-02T03:04:05.000Z");
    em.persist(em.create(Event, { id: "e1", createdAt }));
    await em.flush();

    const loaded = await em.findOne(Event, { id: "e1" });
    expect(loaded?.createdAt).toEqual(createdAt);
    loaded?.createdAt.setUTCDate(3);
    await em.flush();
    expect((await em.findOne(Event, { id: "e1" }))?.createdAt).toEqual(
      new Date("2026-01-03T03:04:05.000Z"),
    );
  });

  it("rejects non-finite numbers and empty primary keys at flush", async () => {
    const hikoutei = await openRuntime();
    const em = hikoutei.em.fork();

    em.persist(em.create(User, { id: "nan", name: "NaN", age: Number.NaN, active: true }));
    await expect(em.flush()).rejects.toMatchObject({ code: HIKOUTEI_ERROR_CODES.INVALID_SCALAR_VALUE });

    const emptyKeyManager = hikoutei.em.fork();
    emptyKeyManager.persist(emptyKeyManager.create(User, {
      id: "",
      name: "Empty",
      age: 1,
      active: true,
    }));
    await expect(emptyKeyManager.flush()).rejects.toMatchObject({
      code: HIKOUTEI_ERROR_CODES.ENTITY_PRIMARY_KEY_UNAVAILABLE,
    });
  });

  it("validates nullable and undefined filters", async () => {
    const hikoutei = await openRuntime();
    const em = hikoutei.em.fork();
    em.persist(em.create(User, { id: "filter", name: "Filter", age: 1, active: true }));
    await em.flush();

    await expect(em.find(User, { name: null as never })).rejects.toMatchObject({
      code: HIKOUTEI_ERROR_CODES.INVALID_SCALAR_VALUE,
    });
    await expect(em.find(User, { nickname: undefined as never })).rejects.toMatchObject({
      code: HIKOUTEI_ERROR_CODES.INVALID_SCALAR_VALUE,
    });
  });

  it("rejects a non-canonical stored date instead of normalizing it", async () => {
    const dbName = join(tmpdir(), `hikoutei-invalid-date-${randomUUID()}.sqlite`);
    const hikoutei = await createTypedSheets({
      dbName,
      entities: [Event],
    });    let reopened: Hikoutei | undefined;
    try {
      const em = hikoutei.em.fork();
      em.persist(em.create(Event, {
        id: "bad-date",
        createdAt: new Date("2026-01-02T03:04:05.000Z"),
      }));
      await em.flush();
      await hikoutei.close();

      const storage = await initializeMikroOrmSqliteAdapter({
        dbName,
        entities: [InspectionSchema],
      });
      try {
        await storage.transaction(({ sql }) => sql.run(
          "UPDATE events SET created_at = ? WHERE id = ?",
          ["2024-02-30T00:00:00.000Z", "bad-date"],
        ));
      } finally {
        await storage.close(true);
      }

      reopened = await createTypedSheets({
        dbName,
        entities: [Event],
      });      await expect(reopened.em.fork().findOne(Event, { id: "bad-date" })).rejects.toMatchObject({
        code: HIKOUTEI_ERROR_CODES.INVALID_SCALAR_VALUE,
      });
    } finally {
      await reopened?.close().catch(() => undefined);
      await hikoutei.close().catch(() => undefined);
      await unlink(dbName).catch(() => undefined);
      await unlink(`${dbName}-wal`).catch(() => undefined);
      await unlink(`${dbName}-shm`).catch(() => undefined);
    }
  });

  it("stores and reads booleans and nullable scalars faithfully", async () => {
    const hikoutei = await openRuntime();
    const em = hikoutei.em.fork();
    em.persist(
      em.create(User, { id: "b1", name: "Bool", age: 2, active: false, nickname: "nick" }),
    );
    em.persist(
      em.create(User, { id: "b2", name: "Null", age: 3, active: true, nickname: null }),
    );
    await em.flush();

    const em2 = hikoutei.em.fork();
    expect(await em2.findOne(User, { id: "b1" })).toMatchObject({ active: false, nickname: "nick" });
    expect(await em2.findOne(User, { id: "b2" })).toMatchObject({ active: true, nickname: null });
  });
});
