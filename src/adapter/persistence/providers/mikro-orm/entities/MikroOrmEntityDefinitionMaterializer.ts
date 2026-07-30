/**
 * Materializes typed-sheets entity tokens into MikroORM schemas.
 *
 * This is the only place where the public entity definition is translated to
 * `defineEntity`/`p`. Keeping the conversion here lets another persistence
 * provider consume the same public metadata without importing MikroORM.
 */

import {
  defineEntity,
  p,
  type EntitySchema,
} from "@mikro-orm/sql";
import type { AnyEntity } from "@mikro-orm/core";
import {
  isTypedSheetsScalarProperty,
  requireTypedSheetsEntityDefinition,
  TYPED_SHEETS_RELATION_KINDS,
  TYPED_SHEETS_SCALAR_TYPES,
} from "../../../../../application/orm/api/entityDefinition.js";
import type {
  TypedSheetsEntityClass,
  TypedSheetsManyToOnePropertyDefinition,
  TypedSheetsOneToManyPropertyDefinition,
  TypedSheetsPropertyDefinition,
  TypedSheetsScalarPropertyDefinition,
} from "../../../../../application/orm/index.js";
import {
  TYPED_SHEETS_ORM_ERROR_CODES,
  TypedSheetsOrmError,
} from "../../../../../application/orm/errors.js";
import type { MikroOrmSqliteEntity } from "../storage/MikroOrmSqliteAdapter.js";

/**
 * Converts all public entity definitions into schemas accepted by the current
 * MikroORM SQLite provider.
 */
export function materializeTypedSheetsEntityDefinitions(
  entities: readonly TypedSheetsEntityClass<object>[],
): readonly MikroOrmSqliteEntity[] {
  const entitySet = new Set(entities);
  const schemas = entities.map((entity) => materializeEntity(entity, entitySet));
  return schemas;
}

function materializeEntity(
  entity: TypedSheetsEntityClass<object>,
  entitySet: ReadonlySet<TypedSheetsEntityClass<object>>,
): EntitySchema<AnyEntity>[][number] {
  const definition = requireTypedSheetsEntityDefinition(entity);
  const properties: Record<string, unknown> = {};

  for (const [propertyName, property] of Object.entries(definition.properties)) {
    properties[propertyName] = materializeProperty(property, entitySet);
  }

  const schema = defineEntity({
    name: definition.name,
    tableName: definition.tableName,
    properties,
  } as never);
  schema.setClass(entity as never);
  return schema;
}

function materializeProperty(
  property: TypedSheetsPropertyDefinition,
  entitySet: ReadonlySet<TypedSheetsEntityClass<object>>,
): unknown {
  if (isTypedSheetsScalarProperty(property)) {
    return materializeScalarProperty(property);
  }

  const target = requireRelationTarget(property, entitySet);

  if (property.relation === TYPED_SHEETS_RELATION_KINDS.MANY_TO_ONE) {
    return materializeManyToOneProperty(property, target);
  }

  return materializeOneToManyProperty(property, target);
}

function requireRelationTarget(
  property: TypedSheetsManyToOnePropertyDefinition | TypedSheetsOneToManyPropertyDefinition,
  entitySet: ReadonlySet<TypedSheetsEntityClass<object>>,
): TypedSheetsEntityClass<object> {
  const target = property.target();
  if (entitySet.has(target)) return target;
  throw new TypedSheetsOrmError(
    TYPED_SHEETS_ORM_ERROR_CODES.INVALID_ENTITY_MAPPING,
    "a relation target must be included in createTypedSheets({ entities })",
  );
}

function materializeManyToOneProperty(
  property: TypedSheetsManyToOnePropertyDefinition,
  target: TypedSheetsEntityClass<object>,
): unknown {
  return () => {
    let builder = p.manyToOne(target);
    if (property.inversedBy !== undefined) builder = builder.inversedBy(property.inversedBy);
    if (property.joinColumn !== undefined) builder = builder.joinColumn(property.joinColumn);
    if (property.nullable === true) builder = builder.nullable();
    return builder;
  };
}

function materializeOneToManyProperty(
  property: TypedSheetsOneToManyPropertyDefinition,
  target: TypedSheetsEntityClass<object>,
): unknown {
  return () => p.oneToMany(target).mappedBy(property.mappedBy);
}

function materializeScalarProperty(property: TypedSheetsScalarPropertyDefinition): unknown {
  // MikroORM's fluent builder narrows its generic after every modifier. The
  // public definition has already validated the scalar union, so this small
  // provider-local widening keeps the conversion table readable.
  const builder = createScalarBuilder(property.type);
  let configuredBuilder: {
    primary: () => unknown;
    nullable: () => unknown;
    fieldName: (name: string) => unknown;
  } = builder;
  if (property.primary === true) configuredBuilder = configuredBuilder.primary() as typeof configuredBuilder;
  if (property.nullable === true) configuredBuilder = configuredBuilder.nullable() as typeof configuredBuilder;
  if (property.fieldName !== undefined) {
    configuredBuilder = configuredBuilder.fieldName(property.fieldName) as typeof configuredBuilder;
  }
  return configuredBuilder;
}

function createScalarBuilder(type: TypedSheetsScalarPropertyDefinition["type"]): {
  primary: () => unknown;
  nullable: () => unknown;
  fieldName: (name: string) => unknown;
} {
  switch (type) {
    case TYPED_SHEETS_SCALAR_TYPES.STRING:
      return p.string();
    case TYPED_SHEETS_SCALAR_TYPES.NUMBER:
      return p.float();
    case TYPED_SHEETS_SCALAR_TYPES.BOOLEAN:
      return p.boolean();
    case TYPED_SHEETS_SCALAR_TYPES.DATE:
      return p.datetime();
  }
}
