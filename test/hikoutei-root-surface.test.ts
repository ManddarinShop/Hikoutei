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

describe("root public surface", () => {
  it("exposes the stable entity-lifecycle API from the root entrypoint", () => {
    expect(typeof defineTypedSheetsEntity).toBe("function");
    expect(typeof createTypedSheets).toBe("function");
    expect(typeof HikouteiError).toBe("function");
    expect(HIKOUTEI_ERROR_CODES.INVALID_ENTITY_DESCRIPTOR).toBe("invalid_entity_descriptor");
    expect(HIKOUTEI_SCALAR_TYPES.STRING).toBe("string");
  });

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
