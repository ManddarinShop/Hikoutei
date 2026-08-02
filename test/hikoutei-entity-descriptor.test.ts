import { describe, expect, it } from "vitest";

import {
  defineTypedSheetsEntity,
  HIKOUTEI_ERROR_CODES,
  HIKOUTEI_SCALAR_TYPES,
} from "../src/index.js";
import { getEntityDescriptor, resolveEntityDescriptor } from "../src/api/entity.js";

function expectDescriptorError(input: {
  name: string;
  tableName: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  properties: Record<string, any>;
}): Error {
  try {
    defineTypedSheetsEntity(input as never);
    throw new Error("expected descriptor validation to throw");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as { code?: string }).code).toBe(
      HIKOUTEI_ERROR_CODES.INVALID_ENTITY_DESCRIPTOR,
    );
    return error as Error;
  }
}

describe("defineTypedSheetsEntity descriptor validation", () => {
  it("resolves a scalar descriptor and infers its primary key", () => {
    const User = defineTypedSheetsEntity({
      name: "User",
      tableName: "users",
      properties: {
        id: { type: "string", primary: true },
        name: { type: "string" },
        age: { type: "number" },
        active: { type: "boolean" },
      },
    });

    const descriptor = getEntityDescriptor(User);
    expect(descriptor.name).toBe("User");
    expect(descriptor.tableName).toBe("users");
    expect(descriptor.primaryKey).toBe("id");
    expect(descriptor.properties).toEqual([
      { name: "id", type: HIKOUTEI_SCALAR_TYPES.STRING, storageType: "TEXT", primary: true, nullable: false, unique: true },
      { name: "name", type: HIKOUTEI_SCALAR_TYPES.STRING, storageType: "TEXT", primary: false, nullable: false, unique: false },
      { name: "age", type: HIKOUTEI_SCALAR_TYPES.NUMBER, storageType: "REAL", primary: false, nullable: false, unique: false },
      { name: "active", type: HIKOUTEI_SCALAR_TYPES.BOOLEAN, storageType: "INTEGER", primary: false, nullable: false, unique: false },
    ]);
  });

  it("maps a nullable property to a nullable storage column", () => {
    const descriptor = resolveEntityDescriptor({
      name: "Ticket",
      tableName: "tickets",
      properties: {
        id: { type: "string", primary: true },
        note: { type: "string", nullable: true },
      },
    });
    expect(descriptor.properties.find((property) => property.name === "note")).toEqual({
      name: "note",
      type: HIKOUTEI_SCALAR_TYPES.STRING,
      storageType: "TEXT",
      primary: false,
      nullable: true,
      unique: false,
    });
  });

  it("accepts date as a scalar stored in text form", () => {
    const descriptor = resolveEntityDescriptor({
      name: "Event",
      tableName: "events",
      properties: {
        id: { type: "string", primary: true },
        createdAt: { type: "date" },
      },
    });
    expect(descriptor.properties.find((property) => property.name === "createdAt")).toMatchObject({
      type: HIKOUTEI_SCALAR_TYPES.DATE,
      storageType: "TEXT",
    });
  });

  it("rejects an empty entity name", () => {
    const error = expectDescriptorError({
      name: "  ",
      tableName: "users",
      properties: { id: { type: "string", primary: true } },
    });
    expect(error.message).toContain("entity name must be a non-empty string");
  });

  it("rejects an invalid table name", () => {
    const error = expectDescriptorError({
      name: "User",
      tableName: "1-bad",
      properties: { id: { type: "string", primary: true } },
    });
    expect(error.message).toContain("table name must be a SQL identifier");
  });

  it("rejects a table name owned by the internal sync schema", () => {
    const error = expectDescriptorError({
      name: "State",
      tableName: "entity_state",
      properties: { id: { type: "string", primary: true } },
    });
    expect(error.message).toContain("reserved by Hikoutei");
  });

  it("rejects every SQLite-internal table-name prefix", () => {
    const error = expectDescriptorError({
      name: "SQLiteOwned",
      tableName: "sqlite_application_table",
      properties: { id: { type: "string", primary: true } },
    });
    expect(error.message).toContain("reserved by Hikoutei");
  });

  it("rejects a descriptor with no primary key", () => {
    const error = expectDescriptorError({
      name: "User",
      tableName: "users",
      properties: { id: { type: "string" } },
    });
    expect(error.message).toContain("must declare exactly one primary key");
  });

  it("rejects a descriptor with more than one primary key", () => {
    const error = expectDescriptorError({
      name: "User",
      tableName: "users",
      properties: {
        id: { type: "string", primary: true },
        email: { type: "string", primary: true },
      },
    });
    expect(error.message).toContain("more than one primary key");
  });

  it("rejects a non-string primary key", () => {
    const error = expectDescriptorError({
      name: "Counter",
      tableName: "counters",
      properties: { id: { type: "number", primary: true } },
    });
    expect(error.message).toContain("primary key");
    expect(error.message).toContain("must be a string scalar in v1");
  });

  it("rejects a non-scalar property type", () => {
    const error = expectDescriptorError({
      name: "User",
      tableName: "users",
      properties: {
        id: { type: "string", primary: true },
        createdAt: { type: "json" as unknown as "string" },
      },
    });
    expect(error.message).toContain("createdAt");
    expect(error.message).toContain("supports only");
  });

  it("rejects unsupported relation/provider and Sheet ownership options", () => {
    const relationError = expectDescriptorError({
      name: "User",
      tableName: "users",
      properties: {
        id: { type: "string", primary: true },
        profile: { type: "string", relation: "manyToOne" } as unknown as { type: "string" },
      },
    });
    expect(relationError.message).toContain("unsupported option");
    expect(relationError.message).toContain("relation");
    expect(relationError.message).toContain("v1 supports only scalar types");

    const ownershipError = expectDescriptorError({
      name: "User",
      tableName: "users",
      properties: {
        id: { type: "string", primary: true, editable: true } as unknown as { type: "string" },
      },
    });
    expect(ownershipError.message).toContain("unsupported option");
    expect(ownershipError.message).toContain("editable");
  });

  it("rejects a primary key that is also nullable", () => {
    const error = expectDescriptorError({
      name: "User",
      tableName: "users",
      properties: { id: { type: "string", primary: true, nullable: true } },
    });
    expect(error.message).toContain("cannot be both primary and nullable");
  });

  it("rejects a descriptor with no properties", () => {
    const error = expectDescriptorError({
      name: "Empty",
      tableName: "empty",
      properties: {},
    });
    expect(error.message).toContain("at least one scalar property");
  });
});
