/**
 * Entity-to-Sheets mapping metadata for the typed-sheets public lifecycle.
 *
 * The mapping belongs to typed-sheets, not to MikroORM. An execution adapter
 * may therefore change while the application's entity, field, and projection
 * declarations stay stable.
 */

import {
  EMPTY_STRING_LENGTH_ZERO,
  FIELD_OWNERSHIPS,
  stableHash,
  type FieldManifestEntry,
  type FieldOwnership,
  type NormalizedCell,
  type OwnershipManifest,
} from "../../core/index.js";
import {
  NORMALIZED_CELL_KINDS,
  type NormalizedCellKind,
} from "../../core/encoding/constants.js";
import { SYNC_GATEWAY_PROJECTIONS } from "../../runtime/gateway/constants.js";
import type { RegisterSyncSheetInput, RegisteredProjection } from "../../storage/index.js";
import type { TypedSheetsEntityReference } from "../api/contracts.js";
import {
  TYPED_SHEETS_ORM_ERROR_CODES,
  TypedSheetsOrmError,
} from "../errors.js";

/** Physical projections supported by a mapped business entity. */
export type TypedSheetsEntityProjection =
  | typeof SYNC_GATEWAY_PROJECTIONS.USER_INPUT
  | typeof SYNC_GATEWAY_PROJECTIONS.SYSTEM_STATE;

/** A string property name declared by one mapped entity. */
export type TypedSheetsEntityProperty<Entity extends object> = Extract<keyof Entity, string>;

/** Optional codec used when a TypeScript property needs custom cell conversion. */
export interface TypedSheetsEntityFieldCodec {
  /** Converts one entity property value into a normalized Sheet cell. */
  readonly encode?: (value: unknown) => NormalizedCell;
  /** Converts one accepted canonical cell into an entity property value. */
  readonly decode?: (value: NormalizedCell) => unknown;
}

/** Input declaration for one entity property stored as a canonical field. */
export interface TypedSheetsEntityFieldMappingInput<Entity extends object>
  extends TypedSheetsEntityFieldCodec {
  /** Property on the application entity. */
  readonly property: TypedSheetsEntityProperty<Entity>;
  /** Stable canonical/Sheet field name. Defaults to `property`. */
  readonly fieldName?: string;
  /** Runtime cell type stored in canonical state and projected to Sheets. */
  readonly cellKind: NormalizedCellKind;
  /** Whether a human Sheet edit may own this business field. */
  readonly ownership: FieldOwnership;
  /** Whether blank (`null`) or an empty string is invalid. */
  readonly required?: boolean;
  /** Whether this is the one v1 business-key field. */
  readonly unique?: boolean;
}

/** Immutable routing coordinates for one physical User_Input or System_State tab. */
export interface TypedSheetsEntityProjectionMappingInput {
  readonly physicalSheetId: string;
  readonly spreadsheetId: string;
  readonly tabName: string;
  readonly registeredRange: string;
  readonly projection: TypedSheetsEntityProjection;
}

/** User-facing declaration used to construct one validated entity mapping. */
export interface TypedSheetsEntityMappingInput<Entity extends object> {
  /** Entity class or stable entity name handled by the execution engine. */
  readonly entity: TypedSheetsEntityReference<Entity>;
  /** Overrides the execution engine's class name when a stable alias is needed. */
  readonly entityName?: string;
  /** Stable logical Sheets identifier shared by its physical projections. */
  readonly logicalSheetId: string;
  /** String primary-key property used as SQLite/canonical entity identity. */
  readonly primaryKey: TypedSheetsEntityProperty<Entity>;
  /** Required unique property used by the v1 business-key index. */
  readonly businessKey: TypedSheetsEntityProperty<Entity>;
  /** Schema version registered for every physical projection of this entity. */
  readonly schemaVersion: number;
  /** Canonical business fields exposed by this mapping. */
  readonly fields: readonly TypedSheetsEntityFieldMappingInput<Entity>[];
  /** One System_State projection and, optionally, one User_Input projection. */
  readonly projections: readonly TypedSheetsEntityProjectionMappingInput[];
  /** System-only marker projected when `em.remove()` tombstones an entity. */
  readonly tombstoneFieldName?: string;
  /** Builds a deterministic projection-local row anchor from canonical identity. */
  readonly anchorForEntity?: (entityId: string) => string;
}

/** Validated mapping metadata for one canonical entity. */
export interface TypedSheetsEntityFieldMapping extends TypedSheetsEntityFieldCodec {
  readonly property: string;
  readonly fieldName: string;
  readonly cellKind: NormalizedCellKind;
  readonly ownership: FieldOwnership;
  readonly required: boolean;
  readonly unique: boolean;
}

/** Validated physical projection route. */
export interface TypedSheetsEntityProjectionMapping {
  readonly physicalSheetId: string;
  readonly spreadsheetId: string;
  readonly tabName: string;
  readonly registeredRange: string;
  readonly projection: TypedSheetsEntityProjection;
}

/** Adapter-neutral mapping consumed by the flush and observation bridges. */
export interface TypedSheetsEntityMapping {
  readonly entity: TypedSheetsEntityReference<object>;
  readonly entityName: string;
  readonly logicalSheetId: string;
  readonly primaryKey: string;
  readonly businessKey: TypedSheetsEntityFieldMapping;
  readonly schemaVersion: number;
  readonly fields: readonly TypedSheetsEntityFieldMapping[];
  readonly projections: readonly TypedSheetsEntityProjectionMapping[];
  readonly tombstoneFieldName: string;
  readonly anchorForEntity: (entityId: string) => string;
}

/** An indexed collection of validated mappings used by one typed-sheets runtime. */
export interface TypedSheetsEntityMappingRegistry {
  readonly mappings: readonly TypedSheetsEntityMapping[];
  findByEntityName(entityName: string): TypedSheetsEntityMapping | undefined;
  findByLogicalSheetId(logicalSheetId: string): TypedSheetsEntityMapping | undefined;
  findByPhysicalSheetId(physicalSheetId: string): TypedSheetsEntityMapping | undefined;
}

/** A physical projection plus its computed registry input and header schema. */
export interface TypedSheetsMappedProjectionDefinition {
  readonly mapping: TypedSheetsEntityMapping;
  readonly projection: TypedSheetsEntityProjectionMapping;
  readonly registration: RegisterSyncSheetInput;
  readonly headers: readonly string[];
}

/**
 * Validates and normalizes a single entity-to-Sheets mapping declaration.
 *
 * It rejects ambiguous entity names, duplicated field names, missing business
 * key guarantees, and a projection layout that would violate the v1
 * User_Input/System_State ownership boundary.
 */
export function defineTypedSheetsEntityMapping<Entity extends object>(
  input: TypedSheetsEntityMappingInput<Entity>,
): TypedSheetsEntityMapping {
  const entityName = input.entityName ?? entityReferenceName(input.entity);
  requireText(entityName, "entity name");
  requireText(input.logicalSheetId, "logical sheet ID");
  requireText(input.primaryKey, "primary-key property");
  requireText(input.businessKey, "business-key property");
  if (!Number.isSafeInteger(input.schemaVersion) || input.schemaVersion < 1) {
    throwInvalidMapping("schema version must be a positive safe integer");
  }
  if (input.fields.length === 0) {
    throwInvalidMapping("an entity mapping must declare at least one field");
  }

  const fields = input.fields.map((field) => normalizeFieldMapping(field));
  assertDistinct(fields.map((field) => field.property), "entity property");
  assertDistinct(fields.map((field) => field.fieldName), "canonical field name");

  const businessKey = fields.find((field) => field.property === input.businessKey);
  if (businessKey === undefined) {
    throwInvalidMapping("the business-key property must be declared as a mapped field");
  }
  if (!businessKey.required || !businessKey.unique) {
    throwInvalidMapping("the business-key field must be required and unique");
  }
  if (fields.some((field) => field.unique && field.property !== input.businessKey)) {
    throwInvalidMapping("v1 supports exactly one unique business-key field");
  }

  const projections = input.projections.map(normalizeProjectionMapping);
  if (projections.length === 0) {
    throwInvalidMapping("an entity mapping must declare a system_state projection");
  }
  assertDistinct(projections.map((projection) => projection.physicalSheetId), "physical sheet ID");
  assertDistinct(projections.map((projection) => projection.projection), "projection kind");
  if (!projections.some((projection) => projection.projection === SYNC_GATEWAY_PROJECTIONS.SYSTEM_STATE)) {
    throwInvalidMapping("an entity mapping must declare exactly one system_state projection");
  }

  const tombstoneFieldName = input.tombstoneFieldName ?? "__typed_sheets_deleted";
  requireText(tombstoneFieldName, "tombstone field name");
  if (fields.some((field) => field.fieldName === tombstoneFieldName)) {
    throwInvalidMapping("the tombstone field name cannot duplicate a mapped field");
  }

  const userInput = projections.find(
    (projection) => projection.projection === SYNC_GATEWAY_PROJECTIONS.USER_INPUT,
  );
  if (userInput !== undefined && fields.every((field) => field.ownership !== FIELD_OWNERSHIPS.USER)) {
    throwInvalidMapping("a user_input projection requires at least one user-owned field");
  }
  if (userInput !== undefined && businessKey.ownership !== FIELD_OWNERSHIPS.USER) {
    throwInvalidMapping("a user_input projection requires a user-owned business-key field");
  }

  return {
    entity: input.entity as unknown as TypedSheetsEntityReference<object>,
    entityName,
    logicalSheetId: input.logicalSheetId,
    primaryKey: input.primaryKey,
    businessKey,
    schemaVersion: input.schemaVersion,
    fields,
    projections,
    tombstoneFieldName,
    anchorForEntity: input.anchorForEntity ?? defaultAnchorForEntity,
  };
}

/**
 * Creates lookup indexes for a group of entity mappings.
 *
 * Logical and physical routes are unique so one incoming Sheet observation can
 * never be applied to two different application entity types.
 */
export function createTypedSheetsEntityMappingRegistry(
  mappings: readonly TypedSheetsEntityMapping[],
): TypedSheetsEntityMappingRegistry {
  const byEntityName = new Map<string, TypedSheetsEntityMapping>();
  const byLogicalSheetId = new Map<string, TypedSheetsEntityMapping>();
  const byPhysicalSheetId = new Map<string, TypedSheetsEntityMapping>();

  for (const mapping of mappings) {
    insertUniqueMapping(byEntityName, mapping.entityName, mapping, "entity name");
    insertUniqueMapping(byLogicalSheetId, mapping.logicalSheetId, mapping, "logical sheet ID");
    for (const projection of mapping.projections) {
      insertUniqueMapping(
        byPhysicalSheetId,
        projection.physicalSheetId,
        mapping,
        "physical sheet ID",
      );
    }
  }

  return {
    mappings: [...mappings],
    findByEntityName: (entityName) => byEntityName.get(entityName),
    findByLogicalSheetId: (logicalSheetId) => byLogicalSheetId.get(logicalSheetId),
    findByPhysicalSheetId: (physicalSheetId) => byPhysicalSheetId.get(physicalSheetId),
  };
}

/** Returns the one physical route registered for the requested projection kind. */
export function requireTypedSheetsEntityProjection(
  mapping: TypedSheetsEntityMapping,
  projection: TypedSheetsEntityProjection,
): TypedSheetsEntityProjectionMapping {
  const result = mapping.projections.find((candidate) => candidate.projection === projection);
  if (result === undefined) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.INVALID_ENTITY_MAPPING,
      `${mapping.entityName} does not declare a ${projection} projection.`,
    );
  }
  return result;
}

/** Builds the core ownership manifest used by evaluation for this entity mapping. */
export function createTypedSheetsEntityOwnershipManifest(
  mapping: TypedSheetsEntityMapping,
): OwnershipManifest {
  return new Map<string, FieldManifestEntry>(
    mapping.fields.map((field) => [
      field.fieldName,
      {
        fieldName: field.fieldName,
        ownership: field.ownership,
        projection: field.ownership === FIELD_OWNERSHIPS.USER
          ? SYNC_GATEWAY_PROJECTIONS.USER_INPUT
          : SYNC_GATEWAY_PROJECTIONS.SYSTEM_STATE,
        type: field.cellKind,
        required: field.required,
        unique: field.unique,
      },
    ]),
  );
}

/** Serializes the logical ownership manifest in deterministic field-name order. */
export function serializeTypedSheetsEntityOwnershipManifest(
  mapping: TypedSheetsEntityMapping,
): string {
  const fields = [...createTypedSheetsEntityOwnershipManifest(mapping).values()]
    .sort((left, right) => left.fieldName.localeCompare(right.fieldName));
  return JSON.stringify({ fields });
}

/** Returns the headers that setup must materialize for one physical projection. */
export function typedSheetsEntityProjectionHeaders(
  mapping: TypedSheetsEntityMapping,
  projection: TypedSheetsEntityProjection,
): readonly string[] {
  const fieldNames = projection === SYNC_GATEWAY_PROJECTIONS.SYSTEM_STATE
    ? mapping.fields.map((field) => field.fieldName)
    : mapping.fields
      .filter((field) => field.ownership === FIELD_OWNERSHIPS.USER)
      .map((field) => field.fieldName);
  return projection === SYNC_GATEWAY_PROJECTIONS.SYSTEM_STATE
    ? [...fieldNames, mapping.tombstoneFieldName]
    : fieldNames;
}

/** Creates one registry declaration for a validated mapping projection. */
export function createTypedSheetsEntityProjectionRegistration(
  mapping: TypedSheetsEntityMapping,
  projection: TypedSheetsEntityProjectionMapping,
): RegisterSyncSheetInput {
  return {
    logicalSheetId: mapping.logicalSheetId,
    physicalSheetId: projection.physicalSheetId,
    spreadsheetId: projection.spreadsheetId,
    tabName: projection.tabName,
    registeredRange: projection.registeredRange,
    projection: projection.projection as RegisteredProjection,
    schemaVersion: mapping.schemaVersion,
    ownershipManifestJson: serializeTypedSheetsEntityOwnershipManifest(mapping),
    businessKeyField: mapping.businessKey.fieldName,
  };
}

/** Returns every setup definition necessary to register and provision a mapping collection. */
export function createTypedSheetsMappedProjectionDefinitions(
  mappings: readonly TypedSheetsEntityMapping[],
): readonly TypedSheetsMappedProjectionDefinition[] {
  return mappings.flatMap((mapping) => mapping.projections.map((projection) => ({
    mapping,
    projection,
    registration: createTypedSheetsEntityProjectionRegistration(mapping, projection),
    headers: typedSheetsEntityProjectionHeaders(mapping, projection.projection),
  })));
}

/** Derives the stable row-binding ID shared by an entity's physical projections. */
export function typedSheetsEntityRowBindingId(
  mapping: TypedSheetsEntityMapping,
  entityId: string,
): string {
  const anchor = typedSheetsEntityAnchor(mapping, entityId);
  return "binding:" + stableHash({
    logicalSheetId: mapping.logicalSheetId,
    physicalAnchor: anchor,
  });
}

/** Derives and validates the projection anchor for one canonical entity. */
export function typedSheetsEntityAnchor(
  mapping: TypedSheetsEntityMapping,
  entityId: string,
): string {
  requireText(entityId, "entity ID");
  const anchor = mapping.anchorForEntity(entityId);
  requireText(anchor, "row anchor");
  return anchor;
}

/** Reads the mapping's string primary key from a pending entity change. */
export function typedSheetsEntityId(
  mapping: TypedSheetsEntityMapping,
  entity: object,
): string {
  const value = readEntityProperty(entity, mapping.primaryKey);
  if (typeof value !== "string" || value.length === EMPTY_STRING_LENGTH_ZERO) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.ENTITY_PRIMARY_KEY_UNAVAILABLE,
      `${mapping.entityName}.${mapping.primaryKey} must be a non-empty string before flush.`,
    );
  }
  return value;
}

/** Encodes every mapped entity property into its canonical normalized-cell value. */
export function encodeTypedSheetsEntity(
  mapping: TypedSheetsEntityMapping,
  entity: object,
): Readonly<Record<string, NormalizedCell>> {
  const encoded: Record<string, NormalizedCell> = {};
  for (const field of mapping.fields) {
    encoded[field.fieldName] = encodeTypedSheetsEntityField(
      mapping,
      field,
      readEntityProperty(entity, field.property),
    );
  }
  return encoded;
}

/** Encodes one mapped property while enforcing its declared normalized-cell contract. */
export function encodeTypedSheetsEntityField(
  mapping: TypedSheetsEntityMapping,
  field: TypedSheetsEntityFieldMapping,
  value: unknown,
): NormalizedCell {
  const cell = field.encode === undefined
    ? defaultEncode(field, value)
    : field.encode(value);
  return requireValidMappedCell(mapping, field, cell);
}

/** Decodes one accepted canonical cell into the mapped application property value. */
export function decodeTypedSheetsEntityField(
  mapping: TypedSheetsEntityMapping,
  field: TypedSheetsEntityFieldMapping,
  value: NormalizedCell,
): unknown {
  const cell = requireValidMappedCell(mapping, field, value);
  if (field.decode !== undefined) return field.decode(cell);
  if (cell === null) return null;
  switch (cell.kind) {
    case NORMALIZED_CELL_KINDS.STRING:
    case NORMALIZED_CELL_KINDS.NUMBER:
    case NORMALIZED_CELL_KINDS.BOOLEAN:
      return cell.value;
    case NORMALIZED_CELL_KINDS.DATE:
      return new Date(cell.value);
  }
}

/** Finds the field declaration for one canonical field name or fails closed. */
export function requireTypedSheetsEntityField(
  mapping: TypedSheetsEntityMapping,
  fieldName: string,
): TypedSheetsEntityFieldMapping {
  const field = mapping.fields.find((candidate) => candidate.fieldName === fieldName);
  if (field === undefined) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.INVALID_ENTITY_MAPPING,
      `${mapping.entityName} does not map canonical field ${fieldName}.`,
    );
  }
  return field;
}

function normalizeFieldMapping<Entity extends object>(
  field: TypedSheetsEntityFieldMappingInput<Entity>,
): TypedSheetsEntityFieldMapping {
  const property = field.property;
  const fieldName = field.fieldName ?? property;
  requireText(property, "entity property");
  requireText(fieldName, "canonical field name");
  if (!isNormalizedCellKind(field.cellKind)) {
    throwInvalidMapping(`${fieldName} has an unsupported normalized cell kind`);
  }
  if (field.ownership !== FIELD_OWNERSHIPS.USER && field.ownership !== FIELD_OWNERSHIPS.SYSTEM) {
    throwInvalidMapping(`${fieldName} has an unsupported ownership`);
  }
  return {
    property,
    fieldName,
    cellKind: field.cellKind,
    ownership: field.ownership,
    required: field.required ?? false,
    unique: field.unique ?? false,
    ...(field.encode === undefined ? {} : { encode: field.encode }),
    ...(field.decode === undefined ? {} : { decode: field.decode }),
  };
}

function normalizeProjectionMapping(
  projection: TypedSheetsEntityProjectionMappingInput,
): TypedSheetsEntityProjectionMapping {
  requireText(projection.physicalSheetId, "physical sheet ID");
  requireText(projection.spreadsheetId, "spreadsheet ID");
  requireText(projection.tabName, "tab name");
  requireText(projection.registeredRange, "registered range");
  if (
    projection.projection !== SYNC_GATEWAY_PROJECTIONS.USER_INPUT &&
    projection.projection !== SYNC_GATEWAY_PROJECTIONS.SYSTEM_STATE
  ) {
    throwInvalidMapping("an entity mapping supports only user_input and system_state projections");
  }
  return { ...projection };
}

function entityReferenceName<Entity extends object>(
  entity: TypedSheetsEntityReference<Entity>,
): string {
  if (typeof entity === "string") return entity;
  const name = (entity as unknown as { readonly name?: unknown }).name;
  if (typeof name !== "string") {
    throwInvalidMapping("an entity class must expose a stable name or entityName must be provided");
  }
  return name;
}

function assertDistinct(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throwInvalidMapping(`a mapping cannot repeat ${label}: ${value}`);
    }
    seen.add(value);
  }
}

function insertUniqueMapping(
  index: Map<string, TypedSheetsEntityMapping>,
  key: string,
  mapping: TypedSheetsEntityMapping,
  label: string,
): void {
  if (index.has(key)) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.DUPLICATE_ENTITY_MAPPING,
      `typed-sheets mappings cannot repeat ${label}: ${key}.`,
    );
  }
  index.set(key, mapping);
}

function defaultAnchorForEntity(entityId: string): string {
  return `entity:${entityId}`;
}

function readEntityProperty(entity: object, property: string): unknown {
  return (entity as Readonly<Record<string, unknown>>)[property];
}

function defaultEncode(field: TypedSheetsEntityFieldMapping, value: unknown): NormalizedCell {
  if (value === null) return null;
  switch (field.cellKind) {
    case NORMALIZED_CELL_KINDS.STRING:
      return typeof value === "string"
        ? { kind: NORMALIZED_CELL_KINDS.STRING, value }
        : invalidMappedFieldValue(field, "must be a string or null");
    case NORMALIZED_CELL_KINDS.NUMBER:
      return typeof value === "number" && Number.isFinite(value)
        ? { kind: NORMALIZED_CELL_KINDS.NUMBER, value }
        : invalidMappedFieldValue(field, "must be a finite number or null");
    case NORMALIZED_CELL_KINDS.BOOLEAN:
      return typeof value === "boolean"
        ? { kind: NORMALIZED_CELL_KINDS.BOOLEAN, value }
        : invalidMappedFieldValue(field, "must be a boolean or null");
    case NORMALIZED_CELL_KINDS.DATE:
      return defaultDateCell(field, value);
  }
}

function defaultDateCell(field: TypedSheetsEntityFieldMapping, value: unknown): NormalizedCell {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) {
      return invalidMappedFieldValue(field, "must be a valid Date or canonical ISO date string");
    }
    return { kind: NORMALIZED_CELL_KINDS.DATE, value: value.toISOString() };
  }
  if (typeof value === "string" && isCanonicalIsoDate(value)) {
    return { kind: NORMALIZED_CELL_KINDS.DATE, value };
  }
  return invalidMappedFieldValue(field, "must be a valid Date or canonical ISO date string");
}

function requireValidMappedCell(
  mapping: TypedSheetsEntityMapping,
  field: TypedSheetsEntityFieldMapping,
  cell: unknown,
): NormalizedCell {
  if (cell === null) {
    if (field.required) {
      throwInvalidFieldValue(mapping, field, "cannot be blank");
    }
    return cell;
  }
  if (!isNonNullNormalizedCell(cell)) {
    throwInvalidFieldValue(mapping, field, "must encode as a normalized cell or null");
  }
  if (cell.kind !== field.cellKind) {
    throwInvalidFieldValue(mapping, field, `must encode as ${field.cellKind}`);
  }
  if (
    field.required &&
    cell.kind === NORMALIZED_CELL_KINDS.STRING &&
    cell.value.length === EMPTY_STRING_LENGTH_ZERO
  ) {
    throwInvalidFieldValue(mapping, field, "cannot be an empty string");
  }
  if (
    cell.kind === NORMALIZED_CELL_KINDS.NUMBER &&
    !Number.isFinite(cell.value)
  ) {
    throwInvalidFieldValue(mapping, field, "must be a finite number");
  }
  if (cell.kind === NORMALIZED_CELL_KINDS.DATE && !isCanonicalIsoDate(cell.value)) {
    throwInvalidFieldValue(mapping, field, "must be a canonical ISO date string");
  }
  return cell;
}

function isCanonicalIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isNormalizedCellKind(value: unknown): value is NormalizedCellKind {
  return value === NORMALIZED_CELL_KINDS.STRING ||
    value === NORMALIZED_CELL_KINDS.NUMBER ||
    value === NORMALIZED_CELL_KINDS.BOOLEAN ||
    value === NORMALIZED_CELL_KINDS.DATE;
}

function isNonNullNormalizedCell(value: unknown): value is Exclude<NormalizedCell, null> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as { readonly kind?: unknown; readonly value?: unknown };
  switch (candidate.kind) {
    case NORMALIZED_CELL_KINDS.STRING:
    case NORMALIZED_CELL_KINDS.DATE:
      return typeof candidate.value === "string";
    case NORMALIZED_CELL_KINDS.NUMBER:
      return typeof candidate.value === "number";
    case NORMALIZED_CELL_KINDS.BOOLEAN:
      return typeof candidate.value === "boolean";
    default:
      return false;
  }
}

function invalidMappedFieldValue(
  field: TypedSheetsEntityFieldMapping,
  message: string,
): never {
  throw new TypedSheetsOrmError(
    TYPED_SHEETS_ORM_ERROR_CODES.INVALID_MAPPED_FIELD_VALUE,
    `${field.property} ${message}.`,
  );
}

function throwInvalidFieldValue(
  mapping: TypedSheetsEntityMapping,
  field: TypedSheetsEntityFieldMapping,
  message: string,
): never {
  throw new TypedSheetsOrmError(
    TYPED_SHEETS_ORM_ERROR_CODES.INVALID_MAPPED_FIELD_VALUE,
    `${mapping.entityName}.${field.property} ${message}.`,
  );
}

function requireText(value: string, label: string): void {
  if (value.length === EMPTY_STRING_LENGTH_ZERO) {
    throwInvalidMapping(`${label} is required`);
  }
}

function throwInvalidMapping(message: string): never {
  throw new TypedSheetsOrmError(TYPED_SHEETS_ORM_ERROR_CODES.INVALID_ENTITY_MAPPING, message);
}
