/**
 * Public scalar entity descriptor and the `defineTypedSheetsEntity()` builder.
 *
 * The descriptor is intentionally scalar-only and provider-neutral: it describes
 * a local entity table without referencing any ORM, Sheet route, or storage-
 * execution type. Remote projection configuration is an internal service concern,
 * so descriptor validation never depends on it.
 *
 * The returned `HikouteiEntity` token carries the runtime descriptor and a
 * phantom entity type so `em.create(User, { ... })` infers the entity shape.
 */

import { EMPTY_STRING_LENGTH_ZERO } from "../shared/constants.js";
import { isRecord } from "../shared/encoding/typeGuards.js";
import { HIKOUTEI_ERROR_CODES, HikouteiError } from "./errors.js";

/** Runtime tags for the scalar property types supported in v1. */
export const HIKOUTEI_SCALAR_TYPES = {
  STRING: "string",
  NUMBER: "number",
  BOOLEAN: "boolean",
  DATE: "date",
} as const;

/** Closed set of scalar property types accepted by `defineTypedSheetsEntity`. */
export type HikouteiScalarType =
  (typeof HIKOUTEI_SCALAR_TYPES)[keyof typeof HIKOUTEI_SCALAR_TYPES];

/** SQLite storage affinity derived from one scalar property type. */
export type HikouteiScalarStorageType = "TEXT" | "REAL" | "INTEGER";

/** Property descriptor options accepted for one scalar entity field. */
export interface HikouteiPropertyOptions {
  /** Scalar value type stored in the entity table. */
  readonly type: HikouteiScalarType;
  /** Marks this field as the single immutable primary-key/business-key column. */
  readonly primary?: boolean;
  /** Allows `null` values and types the TypeScript property as `T | null`. */
  readonly nullable?: boolean;
  /** Equivalent positive spelling for callers that prefer required fields. */
  readonly required?: boolean;
  /** v1 permits uniqueness only on the primary/business key. */
  readonly unique?: boolean;
}

/** Map of property name to scalar options declared by one entity descriptor. */
export type HikouteiPropertyDescriptorMap = Readonly<Record<string, HikouteiPropertyOptions>>;

/** User-facing entity descriptor accepted by `defineTypedSheetsEntity`. */
export interface HikouteiEntityDescriptorInput<
  Name extends string = string,
  Properties extends HikouteiPropertyDescriptorMap = HikouteiPropertyDescriptorMap,
> {
  /** Stable entity name used by the manager and internal service mappings. */
  readonly name: Name;
  /** SQLite table name that stores this entity's rows. */
  readonly tableName: string;
  /** Scalar property declarations keyed by property name. */
  readonly properties: Properties;
}

/** Validated scalar property metadata consumed by the local runtime. */
export interface ResolvedHikouteiProperty {
  readonly name: string;
  readonly type: HikouteiScalarType;
  readonly storageType: HikouteiScalarStorageType;
  readonly primary: boolean;
  readonly nullable: boolean;
  readonly unique: boolean;
}

/** Validated entity descriptor consumed by the local runtime. */
export interface ResolvedHikouteiEntityDescriptor {
  readonly name: string;
  readonly tableName: string;
  /** Property name of the single primary-key/business-key column. */
  readonly primaryKey: string;
  readonly properties: readonly ResolvedHikouteiProperty[];
}

/** TypeScript value type stored for one declared scalar property type. */
export type HikouteiScalarValueType<Type extends HikouteiScalarType> =
  Type extends typeof HIKOUTEI_SCALAR_TYPES.STRING ? string
    : Type extends typeof HIKOUTEI_SCALAR_TYPES.NUMBER ? number
      : Type extends typeof HIKOUTEI_SCALAR_TYPES.BOOLEAN ? boolean
        : Type extends typeof HIKOUTEI_SCALAR_TYPES.DATE ? Date
          : never;

/** TypeScript property type for one property descriptor, honoring `nullable`. */
export type HikouteiPropertyValueType<Options extends HikouteiPropertyOptions> =
  Options extends { readonly nullable: true } | { readonly required: false }
    ? HikouteiScalarValueType<Options["type"]> | null
    : HikouteiScalarValueType<Options["type"]>;

/** Inferred mutable entity instance shape derived from a property map. */
export type HikouteiEntityInstance<
  Properties extends HikouteiPropertyDescriptorMap,
> = {
  -readonly [Property in keyof Properties]: HikouteiPropertyValueType<Properties[Property]>;
};

/**
 * Opaque entity token returned by `defineTypedSheetsEntity`.
 *
 * The phantom `Entity` generic preserves property-name and value inference for
 * `em.create()` / `em.find()` without exposing internal storage types. Only the
 * runtime `descriptor` is read by the manager; application code treats the token
 * as a stable entity reference.
 */
const ENTITY_DESCRIPTORS = new WeakMap<object, ResolvedHikouteiEntityDescriptor>();

export class HikouteiEntity<
  Entity extends object = object,
  Name extends string = string,
> {
  /** @internal phantom marker that carries the inferred entity type. */
  private declare readonly __entityType: Entity;
  /** @internal phantom marker that preserves the descriptor name. */
  private declare readonly __entityName: Name;

  constructor(descriptor: ResolvedHikouteiEntityDescriptor) {
    ENTITY_DESCRIPTORS.set(this, descriptor);
  }
}

/** Reads an opaque token's descriptor for internal runtime/provider wiring. */
export function getEntityDescriptor<
  Entity extends object,
  Name extends string,
>(
  entity: HikouteiEntity<Entity, Name>,
): ResolvedHikouteiEntityDescriptor {
  const descriptor = ENTITY_DESCRIPTORS.get(entity);
  if (descriptor === undefined) {
    throwInvalid("entity token is not registered with a valid descriptor.");
  }
  return descriptor;
}

/**
 * Tokens created by `defineTypedSheetsEntity()`, in registration order.
 *
 * The registry backs the `entities` default of `createTypedSheets()`: a factory
 * call that omits `entities` consumes a snapshot of this list at call time.
 * Registration is deliberately lenient — duplicate names or tables may be
 * stored and are rejected by the factory's resolved-list validation — so
 * standalone use of `defineTypedSheetsEntity()` keeps its existing behavior.
 */
const REGISTERED_ENTITY_TOKENS: HikouteiEntity[] = [];

/**
 * Returns the registered entity tokens in registration order.
 *
 * Internal factory support, not part of the application-facing contract. The
 * returned array is a snapshot so callers cannot mutate the registry.
 */
export function getRegisteredEntityTokens(): readonly HikouteiEntity[] {
  return [...REGISTERED_ENTITY_TOKENS];
}

/**
 * Empties the entity registry.
 *
 * Test-only helper for isolated factory tests; not exported from the root
 * entrypoint and never called by production code.
 */
export function clearRegisteredEntityTokens(): void {
  REGISTERED_ENTITY_TOKENS.length = 0;
}

/** Keys allowed on a scalar property descriptor; anything else is rejected. */
const ALLOWED_PROPERTY_OPTION_KEYS: ReadonlySet<string> = new Set([
  "type",
  "primary",
  "nullable",
  "required",
  "unique",
]);

/**
 * Validates a scalar entity descriptor and returns a stable entity token.
 *
 * Throws a typed `HikouteiError` for an empty name or table name, an invalid
 * table identifier, a missing or duplicate primary key, a non-string primary
 * key, a non-scalar property type, or any unsupported relation/provider option.
 * The returned token is safe to pass to `createTypedSheets({ entities })`, and
 * is also registered so a later `createTypedSheets()` call that omits
 * `entities` can use it as the default entity set.
 */
export function defineTypedSheetsEntity<
  Name extends string,
  Properties extends HikouteiPropertyDescriptorMap,
>(
  input: HikouteiEntityDescriptorInput<Name, Properties>,
): HikouteiEntity<HikouteiEntityInstance<Properties>, Name> {
  const entity = new HikouteiEntity<HikouteiEntityInstance<Properties>, Name>(
    resolveEntityDescriptor(input),
  );
  REGISTERED_ENTITY_TOKENS.push(entity);
  return entity;
}

/**
 * Validates and normalizes one entity descriptor input.
 *
 * Exported for focused contract tests; application code uses the typed
 * `defineTypedSheetsEntity` wrapper instead.
 */
export function resolveEntityDescriptor(
  input: HikouteiEntityDescriptorInput,
): ResolvedHikouteiEntityDescriptor {
  if (input === null || typeof input !== "object") {
    throwInvalid("entity descriptor must be an object.");
  }
  const name = requireNonEmptyString(input.name, "entity name");
  const tableName = requireTableName(input.tableName);
  const propertiesInput = input.properties;
  if (
    propertiesInput === null
    || typeof propertiesInput !== "object"
    || Array.isArray(propertiesInput)
  ) {
    throwInvalid("entity properties must be an object keyed by property name.");
  }

  const propertyNames = Object.keys(propertiesInput);
  if (propertyNames.length === EMPTY_STRING_LENGTH_ZERO) {
    throwInvalid("an entity must declare at least one scalar property.");
  }

  const properties: ResolvedHikouteiProperty[] = [];
  let primaryKey: string | undefined;
  for (const propertyName of propertyNames) {
    requireIdentifier(propertyName, "property name");
    const resolved = resolveProperty(propertyName, propertiesInput[propertyName]);
    properties.push(resolved);
    if (resolved.primary) {
      if (primaryKey !== undefined) {
        throwInvalid(
          `entity "${name}" declares more than one primary key (${primaryKey}, ${propertyName}).`,
        );
      }
      primaryKey = propertyName;
    }
  }

  if (primaryKey === undefined) {
    throwInvalid(`entity "${name}" must declare exactly one primary key.`);
  }
  const primaryProperty = findProperty(properties, primaryKey);
  if (primaryProperty.type !== HIKOUTEI_SCALAR_TYPES.STRING) {
    throwInvalid(
      `entity "${name}" primary key "${primaryKey}" must be a string scalar in v1.`,
    );
  }

  return { name, tableName, primaryKey, properties };
}

function resolveProperty(
  propertyName: string,
  options: unknown,
): ResolvedHikouteiProperty {
  if (!isRecord(options)) {
    throwInvalid(`property "${propertyName}" must declare a scalar descriptor object.`);
  }
  for (const optionKey of Object.keys(options)) {
    if (!ALLOWED_PROPERTY_OPTION_KEYS.has(optionKey)) {
      throwInvalid(
        `property "${propertyName}" has an unsupported option "${optionKey}"; v1 supports only scalar types (relations and provider options are not supported).`,
      );
    }
  }
  const type = options.type;
  if (!isHikouteiScalarType(type)) {
    throwInvalid(
      `property "${propertyName}" has an unsupported type; v1 supports only "string", "number", "boolean", and "date" scalars.`,
    );
  }
  const primary = options.primary === true;
  const nullable = options.nullable === true || options.required === false;
  const unique = options.unique === true || primary;
  if (primary && nullable) {
    throwInvalid(`property "${propertyName}" cannot be both primary and nullable.`);
  }
  if (options.required !== undefined && typeof options.required !== "boolean") {
    throwInvalid(`property "${propertyName}" required must be a boolean.`);
  }
  if (options.nullable !== undefined && typeof options.nullable !== "boolean") {
    throwInvalid(`property "${propertyName}" nullable must be a boolean.`);
  }
  if (options.primary !== undefined && typeof options.primary !== "boolean") {
    throwInvalid(`property "${propertyName}" primary must be a boolean.`);
  }
  if (options.unique !== undefined && typeof options.unique !== "boolean") {
    throwInvalid(`property "${propertyName}" unique must be a boolean.`);
  }
  if (options.required === true && options.nullable === true) {
    throwInvalid(`property "${propertyName}" cannot be both required and nullable.`);
  }
  if (unique && !primary) {
    throwInvalid(
      `property "${propertyName}" cannot be unique; v1 uses the required primary id as its business key.`,
    );
  }
  return {
    name: propertyName,
    type,
    storageType: toStorageType(type),
    primary,
    nullable,
    unique,
  };
}

function toStorageType(type: HikouteiScalarType): HikouteiScalarStorageType {
  switch (type) {
    case HIKOUTEI_SCALAR_TYPES.STRING:
      return "TEXT";
    case HIKOUTEI_SCALAR_TYPES.NUMBER:
      return "REAL";
    case HIKOUTEI_SCALAR_TYPES.BOOLEAN:
      return "INTEGER";
    case HIKOUTEI_SCALAR_TYPES.DATE:
      return "TEXT";
  }
}

function findProperty(
  properties: readonly ResolvedHikouteiProperty[],
  name: string,
): ResolvedHikouteiProperty {
  const found = properties.find((property) => property.name === name);
  if (found === undefined) {
    throwInvalid(`property "${name}" is declared as primary but missing from the descriptor.`);
  }
  return found;
}

function isHikouteiScalarType(value: unknown): value is HikouteiScalarType {
  return (
    value === HIKOUTEI_SCALAR_TYPES.STRING
    || value === HIKOUTEI_SCALAR_TYPES.NUMBER
    || value === HIKOUTEI_SCALAR_TYPES.BOOLEAN
    || value === HIKOUTEI_SCALAR_TYPES.DATE
  );
}

const SQL_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Names owned by Hikoutei's SQLite sync schema and SQLite itself. */
export const RESERVED_TABLE_NAMES = new Set([
  "sheet_registry",
  "physical_sheet_registry",
  "row_binding",
  // Retired by the v7 cleanup migration (the orphan table is dropped); kept
  // reserved so the dropped-table verification in migrateSchema.ts stays
  // meaningful forever — a user entity must never re-create this name.
  "projection_row_binding",
  "entity_state",
  "entity_field_state",
  "sheet_visible_state",
  "sheet_visible_field_state",
  "event_batch",
  "event_log",
  "event_observation",
  "observation_receipt",
  "event_row",
  "event_field",
  "sync_conflict",
  "quarantine_record",
  "resolution_command",
  "business_key_index",
  "sheet_effect_outbox",
  "writer_lease",
  "sqlite_master",
  "sqlite_schema",
  "sqlite_sequence",
  "sqlite_temp_master",
  "sqlite_temp_schema",
]);

function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !SQL_IDENTIFIER_PATTERN.test(value)) {
    throwInvalid(`${label} must be a SQL identifier matching ${SQL_IDENTIFIER_PATTERN}.`);
  }
  return value;
}

function requireTableName(value: unknown): string {
  const tableName = requireIdentifier(value, "table name");
  if (
    RESERVED_TABLE_NAMES.has(tableName.toLowerCase()) ||
    tableName.toLowerCase().startsWith("sqlite_")
  ) {
    throwInvalid(`table name "${tableName}" is reserved by Hikoutei or SQLite.`);
  }
  return tableName;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === EMPTY_STRING_LENGTH_ZERO) {
    throwInvalid(`${label} must be a non-empty string.`);
  }
  return value;
}

function throwInvalid(message: string): never {
  throw new HikouteiError(HIKOUTEI_ERROR_CODES.INVALID_ENTITY_DESCRIPTOR, message);
}
