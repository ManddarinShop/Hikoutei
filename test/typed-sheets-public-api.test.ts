import { afterEach, describe, expect, it } from "vitest";

import {
  createTypedSheets,
  defineTypedSheetsEntity,
  type TypedSheetsEntityClass,
} from "../src/index.js";

describe("typed-sheets public entity API", () => {
  const runtimes: Array<Awaited<ReturnType<typeof createTypedSheets>>> = [];

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.close(true)));
  });

  it("keeps entity definition and lifecycle code independent from MikroORM", async () => {
    const User = defineTypedSheetsEntity({
      name: "PublicApiUser",
      tableName: "public_api_users",
      properties: {
        id: { type: "string", primary: true },
        name: { type: "string" },
      },
    });
    const runtime = await createTypedSheets({
      dbName: ":memory:",
      entities: [User],
    });
    runtimes.push(runtime);

    const em = runtime.em.fork();
    const user = em.create(User, { id: "u1", name: "Ada" });
    em.persist(user);
    await em.flush();

    const loaded = await em.findOne(User, { id: "u1" });
    expect(loaded).not.toBeNull();
    expect(loaded?.name).toBe("Ada");
  });

  it("accepts and materializes only the initial manyToOne and oneToMany relation pair", async () => {
    let Order!: TypedSheetsEntityClass<object>;
    const User = defineTypedSheetsEntity({
      name: "PublicApiRelationUser",
      tableName: "public_api_relation_users",
      properties: {
        id: { type: "string", primary: true },
        orders: {
          relation: "oneToMany",
          target: () => Order,
          mappedBy: "user",
        },
      },
    });
    Order = defineTypedSheetsEntity({
      name: "PublicApiRelationOrder",
      tableName: "public_api_relation_orders",
      properties: {
        id: { type: "string", primary: true },
        user: {
          relation: "manyToOne",
          target: () => User,
          inversedBy: "orders",
        },
      },
    });

    const runtime = await createTypedSheets({
      dbName: ":memory:",
      entities: [User, Order],
    });
    runtimes.push(runtime);
    const em = runtime.em.fork();
    const user = em.create(User, { id: "u1" });
    const order = em.create(Order, { id: "o1", user });
    em.persist([user, order]);
    await expect(em.flush()).resolves.toBeUndefined();
  });

  it("keeps Sheet route configuration separate from the entity definition", async () => {
    const User = defineTypedSheetsEntity({
      name: "PublicApiSyncUser",
      tableName: "public_api_sync_users",
      properties: {
        id: { type: "string", primary: true },
        name: { type: "string" },
      },
    });
    const runtime = await createTypedSheets({
      dbName: ":memory:",
      entities: [User],
      sync: {
        writerId: "public-api-test",
        entities: {
          PublicApiSyncUser: {
            systemState: {
              spreadsheetId: "spreadsheet-1",
              tabName: "Users_System",
              registeredRange: "A:C",
            },
            userInput: {
              spreadsheetId: "spreadsheet-1",
              tabName: "Users_Input",
              registeredRange: "A:B",
            },
          },
        },
      },
    });
    runtimes.push(runtime);

    const em = runtime.em.fork();
    const user = em.create(User, { id: "u1", name: "Ada" });
    em.persist(user);
    await expect(em.flush()).resolves.toBeUndefined();
  });

  it("rejects a generated or non-string primary key at definition time", () => {
    expect(() => defineTypedSheetsEntity({
      name: "InvalidPublicApiEntity",
      tableName: "invalid_public_api_entities",
      properties: {
        id: { type: "number", primary: true },
      },
    })).toThrow("primary property must have type string");
  });
});
