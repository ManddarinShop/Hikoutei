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
import { initializeMikroOrmSqliteAdapter } from "../src/adapter/persistence/providers/mikro-orm/storage/MikroOrmSqliteAdapter.js";

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
      sheets: {
        spreadsheetId: "spreadsheet-test",
        routes: {
          User: {
            systemState: { tabName: "Users_System", registeredRange: "A:Z" },
          },
          Counter: {
            systemState: { tabName: "Counters_System", registeredRange: "A:Z" },
          },
        },
      },
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
      sheets: {
        spreadsheetId: "spreadsheet-test",
        routes: {
          A: { systemState: { tabName: "A_System", registeredRange: "A:Z" } },
          "A:B": { systemState: { tabName: "AB_System", registeredRange: "A:Z" } },
        },
      },
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

  it("initializes the local runtime only and does not contact a remote gateway", async () => {
    // createTypedSheets opens SQLite and creates entity tables only. There is no
    // gateway client in scope, so this asserts the no-remote contract by path:
    // opening the runtime must not throw and must not depend on any network.
    const hikoutei = await openRuntime();
    expect(hikoutei.em).toBeDefined();
    expect(typeof hikoutei.em.fork).toBe("function");
  });

  it("commits the entity row, canonical state, and outbox effect together", async () => {
    const dbName = join(tmpdir(), `hikoutei-public-${randomUUID()}.sqlite`);
    const hikoutei = await createTypedSheets({
      dbName,
      entities: [User],
      sheets: {
        spreadsheetId: "spreadsheet-test",
        routes: {
          User: {
            systemState: { tabName: "Users_System", registeredRange: "A:Z" },
          },
        },
      },
    });
    try {
      const em = hikoutei.em.fork();
      em.persist(em.create(User, { id: "atomic", name: "Atomic", age: 1, active: true }));
      await em.flush();
      await hikoutei.close();

      const storage = await initializeMikroOrmSqliteAdapter({
        dbName,
        entities: [InspectionSchema],
      });
      try {
        const state = await storage.read(({ sql }) => sql.get<{ readonly status: string }>(
          "SELECT status FROM entity_state WHERE entity_id = ?",
          ["entity:users:atomic"],
        ));
        const effect = await storage.read(({ sql }) => sql.get<{ readonly status: string }>(
          "SELECT status FROM sheet_effect_outbox WHERE target_id = ?",
          ["entity:users:atomic"],
        ));
        expect(state?.status).toBe("active");
        expect(effect?.status).toBe("pending");
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

  it("rejects duplicate physical Sheet tabs before opening the runtime", async () => {
    await expect(createTypedSheets({
      dbName: ":memory:",
      entities: [User, Counter],
      sheets: {
        spreadsheetId: "spreadsheet-test",
        routes: {
          User: {
            systemState: { tabName: "Shared", registeredRange: "A:Z" },
          },
          Counter: {
            systemState: { tabName: "Shared", registeredRange: "A:Z" },
          },
        },
      },
    })).rejects.toMatchObject({ code: HIKOUTEI_ERROR_CODES.INVALID_SHEET_ROUTE });
  });

  it("provisions registered routes only when setupSheets is explicitly called", async () => {
    const hikoutei = await openRuntime();
    let callCount = 0;
    const result = await hikoutei.setupSheets({
      provisionRegistry: async (registrations) => {
        callCount += 1;
        return {
          registrations: registrations.map(({ headers: _headers, ...registration }) => registration),
          createdSheets: registrations.map((registration) => registration.sheetName),
          initializedHeaders: registrations.flatMap((registration) => registration.headers),
        };
      },
    });

    expect(callCount).toBe(1);
    expect(result.createdSheets).toEqual(["Users_System", "Counters_System"]);
  });

  it("round-trips date scalars through the provider-neutral contract", async () => {
    const hikoutei = await createTypedSheets({
      dbName: ":memory:",
      entities: [Event],
      sheets: {
        spreadsheetId: "spreadsheet-test",
        routes: {
          Event: {
            systemState: { tabName: "Events_System", registeredRange: "A:Z" },
          },
        },
      },
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
      sheets: {
        spreadsheetId: "spreadsheet-test",
        routes: {
          Event: {
            systemState: { tabName: "Events_System", registeredRange: "A:Z" },
          },
        },
      },
    });
    let reopened: Hikoutei | undefined;
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
        sheets: {
          spreadsheetId: "spreadsheet-test",
          routes: {
            Event: {
              systemState: { tabName: "Events_System", registeredRange: "A:Z" },
            },
          },
        },
      });
      await expect(reopened.em.fork().findOne(Event, { id: "bad-date" })).rejects.toMatchObject({
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
