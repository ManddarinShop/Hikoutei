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

  const target = property.target();
  if (!entitySet.has(target)) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.INVALID_ENTITY_MAPPING,
      "a relation target must be included in createTypedSheets({ entities })",
    );
  }

  if (property.relation === TYPED_SHEETS_RELATION_KINDS.MANY_TO_ONE) {
    return () => {
      let builder = p.manyToOne(target);
      if (property.inversedBy !== undefined) builder = builder.inversedBy(property.inversedBy);
      if (property.joinColumn !== undefined) builder = builder.joinColumn(property.joinColumn);
      if (property.nullable === true) builder = builder.nullable();
      return builder;
    };
  }

  return () => p.oneToMany(target).mappedBy(property.mappedBy);
}

function materializeScalarProperty(property: TypedSheetsScalarPropertyDefinition): unknown {
  // MikroORM's fluent builder narrows its generic after every modifier. The
  // public definition has already validated the scalar union, so this small
  // provider-local widening keeps the conversion table readable.
  let builder: {
    primary: () => unknown;
    nullable: () => unknown;
    fieldName: (name: string) => unknown;
  } = property.type === TYPED_SHEETS_SCALAR_TYPES.STRING
    ? p.string()
    : property.type === TYPED_SHEETS_SCALAR_TYPES.NUMBER
      ? p.float()
      : property.type === TYPED_SHEETS_SCALAR_TYPES.BOOLEAN
        ? p.boolean()
        : p.datetime();
  if (property.primary === true) builder = builder.primary() as typeof builder;
  if (property.nullable === true) builder = builder.nullable() as typeof builder;
  if (property.fieldName !== undefined) {
    builder = builder.fieldName(property.fieldName) as typeof builder;
  }
  return builder;
}
