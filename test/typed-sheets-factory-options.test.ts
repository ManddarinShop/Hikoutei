import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createTypedSheets,
  defineTypedSheetsEntity,
  HIKOUTEI_ERROR_CODES,
  type Hikoutei,
} from "../src/index.js";
import {
  clearRegisteredEntityTokens,
  getEntityDescriptor,
  getRegisteredEntityTokens,
} from "@hikoutei/sync-engine/api/entity.js";
import { resolveDefaultDbPath } from "../src/api/Hikoutei.js";

/**
 * Runs `run` with the given env overrides applied, then restores the previous
 * values (or removes the keys) even when `run` rejects.
 */
async function withEnv(
  overrides: Record<string, string | undefined>,
  run: () => Promise<void>,
): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** Fresh entity definition so each test controls exactly what is registered. */
function defineUser(name = "User", tableName = "users") {
  return defineTypedSheetsEntity({
    name,
    tableName,
    properties: {
      id: { type: "string", primary: true },
      name: { type: "string" },
    },
  });
}

describe("createTypedSheets optional arguments", () => {
  const runtimes: Hikoutei[] = [];

  // The registry is module-level; every test starts from an empty registry so
  // the registry-default tests are deterministic and order-independent.
  beforeEach(() => {
    clearRegisteredEntityTokens();
  });

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  });

  async function openRuntime(options: Parameters<typeof createTypedSheets>[0]): Promise<Hikoutei> {
    const runtime = await createTypedSheets(options);
    runtimes.push(runtime);
    return runtime;
  }

  async function tempDbPath(): Promise<string> {
    const path = join(tmpdir(), `hikoutei-factory-options-${randomUUID()}.sqlite`);
    return path;
  }

  async function removeDbFiles(path: string): Promise<void> {
    await Promise.all([
      unlink(path).catch(() => undefined),
      unlink(`${path}-wal`).catch(() => undefined),
      unlink(`${path}-shm`).catch(() => undefined),
    ]);
  }

  it("keeps explicit dbName + entities behavior identical (regression)", async () => {
    const User = defineUser();
    const hikoutei = await openRuntime({ dbName: ":memory:", entities: [User] });
    const em = hikoutei.em.fork();
    em.persist(em.create(User, { id: "explicit", name: "Explicit" }));
    await em.flush();

    expect(await em.findOne(User, { id: "explicit" })).toMatchObject({
      id: "explicit",
      name: "Explicit",
    });
  });

  it("uses the HIKOUTEI_DB_PATH env value when dbName is omitted", async () => {
    const User = defineUser();
    const dbPath = await tempDbPath();
    try {
      await withEnv({ HIKOUTEI_DB_PATH: dbPath }, async () => {
        const hikoutei = await openRuntime({ entities: [User] });
        const em = hikoutei.em.fork();
        em.persist(em.create(User, { id: "env-path", name: "Env" }));
        await em.flush();
      });

      // Reopening the same file explicitly proves the env path was used.
      const reopened = await openRuntime({ dbName: dbPath, entities: [User] });
      expect(await reopened.em.fork().findOne(User, { id: "env-path" })).toMatchObject({
        name: "Env",
      });
      // Close before cleanup so the reopened runtime cannot checkpoint WAL
      // files after removeDbFiles unlinks them (afterEach close is a no-op).
      await reopened.close();
    } finally {
      await removeDbFiles(dbPath);
    }
  });

  it("uses registered entities when entities is omitted", async () => {
    const User = defineUser();
    const Counter = defineTypedSheetsEntity({
      name: "Counter",
      tableName: "counters",
      properties: { id: { type: "string", primary: true }, value: { type: "number" } },
    });
    const hikoutei = await openRuntime({ dbName: ":memory:" });
    const em = hikoutei.em.fork();
    em.persist(em.create(User, { id: "reg-user", name: "Registered" }));
    em.persist(em.create(Counter, { id: "reg-counter", value: 3 }));
    await em.flush();

    expect(await em.findOne(User, { id: "reg-user" })).toMatchObject({ name: "Registered" });
    expect(await em.findOne(Counter, { id: "reg-counter" })).toMatchObject({ value: 3 });
  });

  it("supports a no-argument call with env db path and registered entities", async () => {
    const User = defineUser();
    const dbPath = await tempDbPath();
    try {
      await withEnv({ HIKOUTEI_DB_PATH: dbPath }, async () => {
        const hikoutei = await openRuntime({});
        const em = hikoutei.em.fork();
        em.persist(em.create(User, { id: "no-args", name: "NoArgs" }));
        await em.flush();
      });

      const reopened = await openRuntime({ dbName: dbPath, entities: [User] });
      expect(await reopened.em.fork().findOne(User, { id: "no-args" })).toMatchObject({
        name: "NoArgs",
      });
      // Close before cleanup so the reopened runtime cannot checkpoint WAL
      // files after removeDbFiles unlinks them (afterEach close is a no-op).
      await reopened.close();
    } finally {
      await removeDbFiles(dbPath);
    }
  });

  it("rejects a call without entities when the registry is empty", async () => {
    await expect(createTypedSheets({ dbName: ":memory:" })).rejects.toMatchObject({
      code: HIKOUTEI_ERROR_CODES.INVALID_ENTITY_DESCRIPTOR,
    });
    await expect(createTypedSheets({ dbName: ":memory:" })).rejects.toThrow(
      /requires at least one entity/,
    );

    // The same applies to a fully bare call; the env path is resolved but no
    // runtime is opened, so nothing touches the filesystem.
    await withEnv({ HIKOUTEI_DB_PATH: undefined }, async () => {
      await expect(createTypedSheets()).rejects.toMatchObject({
        code: HIKOUTEI_ERROR_CODES.INVALID_ENTITY_DESCRIPTOR,
      });
    });
  });

  it("preserves registry registration order", async () => {
    const first = defineUser("First", "first_entities");
    const second = defineTypedSheetsEntity({
      name: "Second",
      tableName: "second_entities",
      properties: { id: { type: "string", primary: true } },
    });
    const third = defineTypedSheetsEntity({
      name: "Third",
      tableName: "third_entities",
      properties: { id: { type: "string", primary: true } },
    });

    expect(getRegisteredEntityTokens().map((token) => getEntityDescriptor(token).name)).toEqual([
      "First",
      "Second",
      "Third",
    ]);

    const hikoutei = await openRuntime({ dbName: ":memory:" });
    const em = hikoutei.em.fork();
    em.persist(em.create(second, { id: "s2" }));
    em.persist(em.create(third, { id: "s3" }));
    await em.flush();
    expect(await em.findOne(second, { id: "s2" })).toMatchObject({ id: "s2" });
    expect(await em.findOne(third, { id: "s3" })).toMatchObject({ id: "s3" });
    void first;
  });

  it("lets explicit entities win over the registry", async () => {
    const RegistryUser = defineUser("RegistryUser", "registry_users");
    const ExplicitUser = defineUser("ExplicitUser", "explicit_users");

    const hikoutei = await openRuntime({ dbName: ":memory:", entities: [ExplicitUser] });
    const em = hikoutei.em.fork();
    em.persist(em.create(ExplicitUser, { id: "explicit-wins", name: "Wins" }));
    await em.flush();
    expect(await em.findOne(ExplicitUser, { id: "explicit-wins" })).toMatchObject({
      name: "Wins",
    });

    // The registry token was not passed, so the runtime must reject it.
    let caught: unknown;
    try {
      em.create(RegistryUser, { id: "nope", name: "Nope" });
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: HIKOUTEI_ERROR_CODES.UNREGISTERED_ENTITY,
    });
  });

  it("uses a per-call registry snapshot", async () => {
    const First = defineUser("FirstSnapshot", "first_snapshot");
    const firstRuntime = await openRuntime({ dbName: ":memory:" });

    // Register another entity after the first runtime was opened.
    const Second = defineUser("SecondSnapshot", "second_snapshot");
    const secondRuntime = await openRuntime({ dbName: ":memory:" });

    const firstEm = firstRuntime.em.fork();
    let caught: unknown;
    try {
      firstEm.create(Second, { id: "late", name: "Late" });
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: HIKOUTEI_ERROR_CODES.UNREGISTERED_ENTITY,
    });

    const secondEm = secondRuntime.em.fork();
    secondEm.persist(secondEm.create(Second, { id: "late", name: "Late" }));
    await secondEm.flush();
    expect(await secondEm.findOne(Second, { id: "late" })).toMatchObject({ name: "Late" });
    void First;
  });

  it("rejects duplicate registrations through the registry default", async () => {
    defineUser("Dup", "dup_a");
    defineUser("Dup", "dup_b");
    await expect(createTypedSheets({ dbName: ":memory:" })).rejects.toMatchObject({
      code: HIKOUTEI_ERROR_CODES.DUPLICATE_ENTITY,
      message: 'entity name "Dup" is registered more than once.',
    });
  });

  it("rejects a shared table name through the registry default", async () => {
    defineUser("SharedOne", "shared_table");
    defineUser("SharedTwo", "shared_table");
    await expect(createTypedSheets({ dbName: ":memory:" })).rejects.toMatchObject({
      code: HIKOUTEI_ERROR_CODES.DUPLICATE_ENTITY,
      message: 'table "shared_table" is shared by entities "SharedOne" and "SharedTwo".',
    });
  });

  it("keeps option validation identical when values are provided", async () => {
    const User = defineUser();
    await expect(createTypedSheets({ dbName: "   ", entities: [User] })).rejects.toMatchObject({
      code: HIKOUTEI_ERROR_CODES.INVALID_ENTITY_DESCRIPTOR,
    });
    await expect(
      createTypedSheets({ dbName: ":memory:", entities: "not-an-array" as never }),
    ).rejects.toMatchObject({
      code: HIKOUTEI_ERROR_CODES.INVALID_ENTITY_DESCRIPTOR,
    });
    await expect(createTypedSheets(null as never)).rejects.toMatchObject({
      code: HIKOUTEI_ERROR_CODES.INVALID_ENTITY_DESCRIPTOR,
    });
  });
});

describe("resolveDefaultDbPath", () => {
  it("falls back to ./hikoutei.sqlite when the env var is unset", () => {
    expect(resolveDefaultDbPath({})).toBe("./hikoutei.sqlite");
  });

  it("prefers a non-empty HIKOUTEI_DB_PATH value", () => {
    expect(resolveDefaultDbPath({ HIKOUTEI_DB_PATH: "/tmp/custom.sqlite" })).toBe(
      "/tmp/custom.sqlite",
    );
  });

  it("ignores an empty or whitespace-only HIKOUTEI_DB_PATH value", () => {
    expect(resolveDefaultDbPath({ HIKOUTEI_DB_PATH: "" })).toBe("./hikoutei.sqlite");
    expect(resolveDefaultDbPath({ HIKOUTEI_DB_PATH: "   " })).toBe("./hikoutei.sqlite");
  });

  it("trims a padded HIKOUTEI_DB_PATH value", () => {
    expect(resolveDefaultDbPath({ HIKOUTEI_DB_PATH: "  /tmp/padded.sqlite  " })).toBe(
      "/tmp/padded.sqlite",
    );
  });
});
