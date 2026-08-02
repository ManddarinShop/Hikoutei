/**
 * Materializes scalar entity schemas and provider bindings without sync code.
 *
 * The root ORM factory imports this module only. Projection mapping, canonical
 * state, and gateway code remain behind the internal sync-service path.
 */

import { defineEntity, p } from "@mikro-orm/sql";

import { getEntityDescriptor } from "../../../../../api/entity.js";
import type {
  HikouteiEntity,
  ResolvedHikouteiProperty,
} from "../../../../../api/entity.js";
import type { TypedSheetsEntityReference } from "../../../../../application/orm/api/contracts.js";
import type { MikroOrmSqliteEntity } from "../storage/MikroOrmSqliteAdapter.js";
import type { MikroOrmScalarEntityBinding } from "../api/MikroOrmScalarPersistenceProvider.js";

/** Generated provider inputs for scalar entity tables. */
export interface MikroOrmScalarEntityRuntimeDefinition {
  readonly entities: readonly MikroOrmSqliteEntity[];
  readonly bindings: readonly MikroOrmScalarEntityBinding[];
}

/**
 * Materializes entity tables and provider bindings without any Sheet concern.
 * The public root runtime uses this path so opening SQLite cannot contact or
 * configure a remote projection.
 */
export function createMikroOrmScalarEntityRuntime(
  entities: readonly HikouteiEntity[],
): MikroOrmScalarEntityRuntimeDefinition {
  const generatedEntities: MikroOrmSqliteEntity[] = [];
  const bindings: MikroOrmScalarEntityBinding[] = [];

  for (const token of entities) {
    const descriptor = getEntityDescriptor(token);
    const schema = defineEntity({
      name: descriptor.name,
      tableName: descriptor.tableName,
      properties: createMikroProperties(descriptor.properties),
    } as never);
    const GeneratedEntity = class extends schema.class {};
    schema.setClass(GeneratedEntity);
    const reference = GeneratedEntity as unknown as TypedSheetsEntityReference<object>;
    generatedEntities.push(schema);
    bindings.push({ descriptor, entity: reference });
  }

  return { entities: generatedEntities, bindings };
}

function createMikroProperties(
  properties: readonly ResolvedHikouteiProperty[],
): Record<string, unknown> {
  return Object.fromEntries(properties.map((property) => {
    let builder: unknown;
    switch (property.type) {
      case "number":
        builder = p.float();
        break;
      case "boolean":
        builder = p.boolean();
        break;
      case "string":
      case "date":
        // Dates use canonical ISO text in the provider bridge. This avoids
        // provider-specific Date conversion while the public value remains Date.
        builder = p.string();
        break;
    }
    if (property.primary) {
      builder = (builder as { primary(): unknown }).primary();
    }
    if (property.nullable) {
      builder = (builder as { nullable(): unknown }).nullable();
    }
    return [property.name, builder];
  }));
}
