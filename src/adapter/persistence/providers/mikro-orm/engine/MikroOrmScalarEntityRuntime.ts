/**
 * Materializes scalar entity schemas and provider bindings without sync code.
 *
 * The root ORM factory imports this module only. Projection mapping, canonical
 * state, and provider code remain behind the internal sync-service path.
 */

import { defineEntity, p } from "@mikro-orm/sql";

import { getEntityDescriptor } from "../../../../../api/entity.js";
import type {
  HikouteiEntity,
  ResolvedHikouteiProperty,
} from "../../../../../api/entity.js";
import type { MappedEntityReference } from "../../../../../application/orm/mapping/contracts.js";
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
    });
    const GeneratedEntity = class extends schema.class {};
    schema.setClass(GeneratedEntity);
    const reference: MappedEntityReference<Record<string, unknown>> = GeneratedEntity;
    generatedEntities.push(schema);
    bindings.push({ descriptor, entity: reference });
  }

  return { entities: generatedEntities, bindings };
}

interface ScalarPropertyBuilder {
  primary(): ScalarPropertyBuilder;
  nullable(): ScalarPropertyBuilder;
}

function createMikroProperties(
  properties: readonly ResolvedHikouteiProperty[],
): Record<string, ScalarPropertyBuilder> {
  return Object.fromEntries(properties.map((property) => [
    property.name,
    createMikroProperty(property),
  ]));
}

function createMikroProperty(property: ResolvedHikouteiProperty): ScalarPropertyBuilder {
  switch (property.type) {
    case "number":
      return applyMikroPropertyFlags(p.float(), property);
    case "boolean":
      return applyMikroPropertyFlags(p.boolean(), property);
    case "string":
    case "date":
      // Dates use canonical ISO text in the provider bridge. This avoids
      // provider-specific Date conversion while the public value remains Date.
      return applyMikroPropertyFlags(p.string(), property);
  }
}

function applyMikroPropertyFlags(
  builder: ScalarPropertyBuilder,
  property: ResolvedHikouteiProperty,
): ScalarPropertyBuilder {
  if (property.primary) return builder.primary();
  if (property.nullable) return builder.nullable();
  return builder;
}
