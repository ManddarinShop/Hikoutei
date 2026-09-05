import { describe, expect, it } from "vitest";

import { defineTypedSheetsEntity } from "@hikoutei/sync-engine/api/entity.js";
import {
  resolveEntityDescriptors,
  type EntityDescriptorResolutionFailure,
} from "@hikoutei/sync-engine/api/internalEntityRegistry.js";

/** Captures structured failures instead of throwing, for direct assertions. */
function captureResolutionError(): {
  readonly factory: (failure: EntityDescriptorResolutionFailure) => never;
  readonly failures: EntityDescriptorResolutionFailure[];
} {
  const failures: EntityDescriptorResolutionFailure[] = [];
  const factory = (failure: EntityDescriptorResolutionFailure): never => {
    failures.push(failure);
    throw new Error("resolution failed");
  };
  return { factory, failures };
}

function defineUser(name: string, tableName: string) {
  return defineTypedSheetsEntity({
    name,
    tableName,
    properties: {
      id: { type: "string", primary: true },
      name: { type: "string" },
    },
  });
}

describe("resolveEntityDescriptors", () => {
  it("indexes resolved descriptors by entity name in encounter order", () => {
    const First = defineUser("FirstRegistry", "first_registry");
    const Second = defineUser("SecondRegistry", "second_registry");
    const { factory, failures } = captureResolutionError();

    const descriptors = resolveEntityDescriptors([First, Second], factory);

    expect(failures).toEqual([]);
    expect(descriptors).toBeInstanceOf(Map);
    expect([...descriptors.keys()]).toEqual(["FirstRegistry", "SecondRegistry"]);
    expect(descriptors.get("FirstRegistry")).toMatchObject({
      name: "FirstRegistry",
      tableName: "first_registry",
      primaryKey: "id",
    });
    expect(descriptors.get("SecondRegistry")).toMatchObject({
      name: "SecondRegistry",
      tableName: "second_registry",
    });
  });

  it("reports a non-token value as invalid-token", () => {
    const User = defineUser("TokenOwner", "token_owner");
    const { factory, failures } = captureResolutionError();

    expect(() => resolveEntityDescriptors([User, {} as never], factory)).toThrow(
      "resolution failed",
    );
    expect(failures).toEqual([{ kind: "invalid-token" }]);
  });

  it("reports a duplicate entity name with the colliding name", () => {
    const First = defineUser("RegistryDup", "registry_dup_a");
    const Second = defineUser("RegistryDup", "registry_dup_b");
    const { factory, failures } = captureResolutionError();

    expect(() => resolveEntityDescriptors([First, Second], factory)).toThrow(
      "resolution failed",
    );
    expect(failures).toEqual([{ kind: "duplicate-name", entityName: "RegistryDup" }]);
  });

  it("reports a shared table name with both entity names in encounter order", () => {
    const First = defineUser("RegistrySharedOne", "registry_shared_table");
    const Second = defineUser("RegistrySharedTwo", "registry_shared_table");
    const { factory, failures } = captureResolutionError();

    expect(() => resolveEntityDescriptors([First, Second], factory)).toThrow(
      "resolution failed",
    );
    expect(failures).toEqual([
      {
        kind: "duplicate-table",
        tableName: "registry_shared_table",
        firstEntityName: "RegistrySharedOne",
        secondEntityName: "RegistrySharedTwo",
      },
    ]);
  });

  it("reports at most one failure for a list with multiple problems", () => {
    const First = defineUser("RegistryMulti", "registry_multi_a");
    const Second = defineUser("RegistryMulti", "registry_multi_b");
    const { factory, failures } = captureResolutionError();

    expect(() => resolveEntityDescriptors([First, Second, {} as never], factory)).toThrow(
      "resolution failed",
    );
    // The duplicate name is found before the trailing non-token value.
    expect(failures).toEqual([{ kind: "duplicate-name", entityName: "RegistryMulti" }]);
  });
});
