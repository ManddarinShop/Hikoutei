/**
 * Guards the root entrypoint (`src/index.ts`) public surface contract.
 * Asserts the stable entity-lifecycle API is exported, internal engine symbols
 * stay hidden, and removed sync options are rejected at compile time.
 */
import { describe, expect, it } from "vitest";

// Root entrypoint: only the stable public surface should be reachable here.
import * as hikouteiRoot from "../src/index.js";
import {
  createTypedSheets,
  defineTypedSheetsEntity,
  HikouteiError,
  HIKOUTEI_ERROR_CODES,
  HIKOUTEI_SCALAR_TYPES,
} from "../src/index.js";

// Verifies the root entrypoint only exposes the stable public surface.
describe("root public surface", () => {
  // Verifies the entity-lifecycle API is exported from the root entrypoint.
  it("exposes the stable entity-lifecycle API from the root entrypoint", () => {
    expect(typeof defineTypedSheetsEntity).toBe("function");
    expect(typeof createTypedSheets).toBe("function");
    expect(typeof HikouteiError).toBe("function");
    expect(HIKOUTEI_ERROR_CODES.INVALID_ENTITY_DESCRIPTOR).toBe("invalid_entity_descriptor");
    expect(HIKOUTEI_SCALAR_TYPES.STRING).toBe("string");
  });

  // Verifies internal provider, ORM, and SQL types stay out of the root.
  it("does not re-export internal provider, ORM, or SQL types from the root", () => {
    const namespace = hikouteiRoot as Record<string, unknown>;
    // Internal engine symbols that must never be part of the public contract.
    expect(namespace.createMikroOrmSqliteAdapter).toBeUndefined();
    expect(namespace.createMappedTypedSheetsFlushCoordinator).toBeUndefined();
    expect(namespace.SqlExecutor).toBeUndefined();
    expect(namespace.AppsScriptOperationClient).toBeUndefined();
    expect(namespace.resolveEntityDescriptor).toBeUndefined();
    expect(namespace.HikouteiEntity).toBeUndefined();
  });
});

const publicOptions: import("../src/index.js").CreateTypedSheetsOptions = {
  dbName: ":memory:",
  entities: [],
};
void publicOptions;

// Sheet routes and provisioning are deliberately not part of the root contract.
const removedSheetOptions: import("../src/index.js").CreateTypedSheetsOptions = {
  dbName: ":memory:",
  entities: [],
  // @ts-expect-error `sheets` belongs to the internal sync service.
  sheets: {},
};
void removedSheetOptions;

// User_Input ownership is internal sync configuration.
const removedOwnershipOption: import("../src/index.js").HikouteiPropertyOptions = {
  type: "string",
  // @ts-expect-error `editable` belongs to the internal sync service.
  editable: true,
};
void removedOwnershipOption;
