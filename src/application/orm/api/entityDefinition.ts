/**
 * Public entity-definition contract owned by typed-sheets.
 *
 * The definition deliberately contains no MikroORM or SQLite types. The
 * current provider reads the private metadata accessor and materializes this
 * contract into its own schema representation.
 */

import {
  TYPED_SHEETS_ORM_ERROR_CODES,
  TypedSheetsOrmError,
} from "../errors.js";
import type { TypedSheetsEntityClass } from "./contracts.js";

/** Scalar property types supported by the first public entity definition. */
export const TYPED_SHEETS_SCALAR_TYPES = {
  STRING: "string",
  NUMBER: "number",
  BOOLEAN: "boolean",
  DATE: "date",
} as const;

/** Closed set of scalar property type tags. */
export type TypedSheetsScalarType =
  (typeof TYPED_SHEETS_SCALAR_TYPES)[keyof typeof TYPED_SHEETS_SCALAR_TYPES];

/** Relation kinds supported by the first public entity definition. */
export const TYPED_SHEETS_RELATION_KINDS = {
  MANY_TO_ONE: "manyToOne",
  ONE_TO_MANY: "oneToMany",
} as const;

/** Closed set of supported relation tags. */
export type TypedSheetsRelationKind =
  (typeof TYPED_SHEETS_RELATION_KINDS)[keyof typeof TYPED_SHEETS_RELATION_KINDS];

/** A scalar field stored as a column in the entity table. */
export interface TypedSheetsScalarPropertyDefinition {
  readonly type: TypedSheetsScalarType;
  /** The only supported primary-key strategy is an explicit string value. */
  readonly primary?: boolean;
  /** Allows a real SQL NULL value for this property. */
  readonly nullable?: boolean;
  /** Optional entity-column name; Sheet field names are configured separately. */
  readonly fieldName?: string;
}

/** The owning side of a relation, represented by a foreign key column. */
export interface TypedSheetsManyToOnePropertyDefinition<
  Target extends TypedSheetsEntityClass<object> = TypedSheetsEntityClass<object>,
> {
  readonly relation: typeof TYPED_SHEETS_RELATION_KINDS.MANY_TO_ONE;
  readonly target: () => Target;
  readonly nullable?: boolean;
  readonly joinColumn?: string;
  readonly inversedBy?: string;
}

/** The inverse collection side of a relation. */
export interface TypedSheetsOneToManyPropertyDefinition<
  Target extends TypedSheetsEntityClass<object> = TypedSheetsEntityClass<object>,
> {
  readonly relation: typeof TYPED_SHEETS_RELATION_KINDS.ONE_TO_MANY;
  readonly target: () => Target;
  /** Property on the target entity that owns the foreign key. */
  readonly mappedBy: string;
}

/** Any property declaration accepted by `defineTypedSheetsEntity()`. */
export type TypedSheetsPropertyDefinition =
  | TypedSheetsScalarPropertyDefinition
  | TypedSheetsManyToOnePropertyDefinition
  | TypedSheetsOneToManyPropertyDefinition;

/** Input accepted by `defineTypedSheetsEntity()`. */
export interface DefineTypedSheetsEntityInput<
  Properties extends Readonly<Record<string, TypedSheetsPropertyDefinition>>,
> {
  readonly name: string;
  readonly tableName: string;
  readonly properties: Properties;
}

/** Internal immutable metadata retained behind a public entity token. */
export interface TypedSheetsEntityDefinitionMetadata {
  readonly name: string;
  readonly tableName: string;
  readonly properties: Readonly<Record<string, TypedSheetsPropertyDefinition>>;
  readonly primaryKey: string;
}

/** Resolves the runtime value represented by one public property definition. */
export type TypedSheetsPropertyValue<
  Property extends TypedSheetsPropertyDefinition,
> = Property extends TypedSheetsScalarPropertyDefinition
  ? Property["type"] extends "string"
    ? string
    : Property["type"] extends "number"
      ? number
      : Property["type"] extends "boolean"
        ? boolean
        : Date
  : Property extends TypedSheetsManyToOnePropertyDefinition<infer Target>
    ? InstanceType<Target> | (Property["nullable"] extends true ? null : never)
    : Property extends TypedSheetsOneToManyPropertyDefinition<infer Target>
      ? ReadonlyArray<InstanceType<Target>>
      : never;

/** Infers the application entity shape from its property declarations. */
export type InferTypedSheetsEntity<
  Properties extends Readonly<Record<string, TypedSheetsPropertyDefinition>>,
> = {
  -readonly [Property in keyof Properties]: Properties[Property] extends TypedSheetsPropertyDefinition
    ? TypedSheetsPropertyValue<Properties[Property]>
    : never;
};

/** Public entity token returned by `defineTypedSheetsEntity()`. */
export type TypedSheetsEntityDefinition<
  Properties extends Readonly<Record<string, TypedSheetsPropertyDefinition>>,
> = TypedSheetsEntityClass<InferTypedSheetsEntity<Properties>>;

const entityMetadata = new WeakMap<Function, TypedSheetsEntityDefinitionMetadata>();

/**
 * Defines a typed-sheets entity without exposing the current persistence ORM.
 *
 * Entity identity is explicit: exactly one scalar property must be marked
 * `primary: true`, it must be a string, and generated identifiers are not
 * part of the initial contract.
 */
export function defineTypedSheetsEntity<
  const Properties extends Readonly<Record<string, TypedSheetsPropertyDefinition>>,
>(
  input: DefineTypedSheetsEntityInput<Properties>,
): TypedSheetsEntityDefinition<Properties> {
  validateEntityDefinition(input);

  class TypedSheetsEntity {}
  Object.defineProperty(TypedSheetsEntity, "name", {
    configurable: true,
    value: input.name,
  });

  const primaryKey = Object.entries(input.properties).find(([, property]) => {
    return isScalarProperty(property) && property.primary === true;
  })?.[0];
  if (primaryKey === undefined) {
    throwInvalidDefinition("an entity must declare one primary property");
  }

  entityMetadata.set(TypedSheetsEntity, {
    name: input.name,
    tableName: input.tableName,
    properties: { ...input.properties },
    primaryKey,
  });

  return TypedSheetsEntity as unknown as TypedSheetsEntityDefinition<Properties>;
}

/** Returns private definition metadata for the current persistence provider. */
export function requireTypedSheetsEntityDefinition(
  entity: TypedSheetsEntityClass<object>,
): TypedSheetsEntityDefinitionMetadata {
  const metadata = entityMetadata.get(entity);
  if (metadata === undefined) {
    throwInvalidDefinition(
      "the entity must be created by defineTypedSheetsEntity before it is initialized",
    );
  }
  return metadata;
}

/** Returns true when a property is a scalar field rather than a relation. */
export function isTypedSheetsScalarProperty(
  property: TypedSheetsPropertyDefinition,
): property is TypedSheetsScalarPropertyDefinition {
  return isScalarProperty(property);
}

function validateEntityDefinition<
  Properties extends Readonly<Record<string, TypedSheetsPropertyDefinition>>,
>(input: DefineTypedSheetsEntityInput<Properties>): void {
  if (!isRecord(input)) throwInvalidDefinition("entity definition must be an object");
  requireText(input.name, "entity name");
  requireText(input.tableName, "entity table name");
  if (!isRecord(input.properties)) {
    throwInvalidDefinition("entity properties must be an object");
  }
  const entries = Object.entries(input.properties);
  if (entries.length === 0) {
    throwInvalidDefinition("an entity must declare at least one property");
  }

  let primaryCount = 0;
  for (const [propertyName, property] of entries) {
    requireText(propertyName, "entity property name");
    if (!isRecord(property)) {
      throwInvalidDefinition(`${propertyName} must declare a property object`);
    }
    if (!isScalarProperty(property)) {
      validateRelationProperty(propertyName, property);
      continue;
    }
    if (!isScalarType(property.type)) {
      throwInvalidDefinition(`${propertyName} has an unsupported scalar type`);
    }
    if (property.fieldName !== undefined) requireText(property.fieldName, `${propertyName} field name`);
    if (property.primary === true) {
      primaryCount += 1;
      if (property.type !== TYPED_SHEETS_SCALAR_TYPES.STRING) {
        throwInvalidDefinition("the primary property must have type string");
      }
      if (property.nullable === true) {
        throwInvalidDefinition("the primary property cannot be nullable");
      }
    }
  }
  if (primaryCount !== 1) {
    throwInvalidDefinition("an entity must declare exactly one primary property");
  }
}

function validateRelationProperty(
  propertyName: string,
  property:
    | TypedSheetsManyToOnePropertyDefinition
    | TypedSheetsOneToManyPropertyDefinition,
): void {
  if (
    property.relation !== TYPED_SHEETS_RELATION_KINDS.MANY_TO_ONE &&
    property.relation !== TYPED_SHEETS_RELATION_KINDS.ONE_TO_MANY
  ) {
    throwInvalidDefinition(`${propertyName} has an unsupported relation`);
  }
  if (typeof property.target !== "function") {
    throwInvalidDefinition(`${propertyName} must declare a target callback`);
  }
  if (property.relation === TYPED_SHEETS_RELATION_KINDS.ONE_TO_MANY) {
    requireText(property.mappedBy, `${propertyName} mappedBy property`);
  } else if (property.joinColumn !== undefined) {
    requireText(property.joinColumn, `${propertyName} join column`);
  }
}

function isScalarProperty(
  property: TypedSheetsPropertyDefinition,
): property is TypedSheetsScalarPropertyDefinition {
  return !Object.prototype.hasOwnProperty.call(property, "relation");
}

function isScalarType(value: unknown): value is TypedSheetsScalarType {
  return value === TYPED_SHEETS_SCALAR_TYPES.STRING ||
    value === TYPED_SHEETS_SCALAR_TYPES.NUMBER ||
    value === TYPED_SHEETS_SCALAR_TYPES.BOOLEAN ||
    value === TYPED_SHEETS_SCALAR_TYPES.DATE;
}

function requireText(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throwInvalidDefinition(`${label} is required`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function throwInvalidDefinition(message: string): never {
  throw new TypedSheetsOrmError(
    TYPED_SHEETS_ORM_ERROR_CODES.INVALID_ENTITY_MAPPING,
    message,
  );
}
