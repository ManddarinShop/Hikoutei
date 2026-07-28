/**
 * Validates and normalizes user-facing entity mapping declarations.
 *
 * This module is the construction boundary: callers provide flexible input,
 * and every downstream mapping module receives a validated contract.
 */

import {
  EMPTY_STRING_LENGTH_ZERO,
  FIELD_OWNERSHIPS,
} from "../../../domain/index.js";
import {
  NORMALIZED_CELL_KINDS,
  type NormalizedCellKind,
} from "../../../shared/encoding/constants.js";
import { SYNC_GATEWAY_PROJECTIONS } from "../../../application/sync/gateway/constants.js";
import type {
  TypedSheetsEntityFieldMapping,
  TypedSheetsEntityFieldMappingInput,
  TypedSheetsEntityMapping,
  TypedSheetsEntityMappingInput,
  TypedSheetsEntityProjectionMapping,
  TypedSheetsEntityProjectionMappingInput,
} from "./contracts.js";
import {
  TYPED_SHEETS_ORM_ERROR_CODES,
  TypedSheetsOrmError,
} from "../errors.js";

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
    entity: input.entity as unknown as TypedSheetsEntityMapping["entity"],
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
  entity: TypedSheetsEntityMappingInput<Entity>["entity"],
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

function defaultAnchorForEntity(entityId: string): string {
  return `entity:${entityId}`;
}

function isNormalizedCellKind(value: unknown): value is NormalizedCellKind {
  return value === NORMALIZED_CELL_KINDS.STRING ||
    value === NORMALIZED_CELL_KINDS.NUMBER ||
    value === NORMALIZED_CELL_KINDS.BOOLEAN ||
    value === NORMALIZED_CELL_KINDS.DATE;
}

function requireText(value: string, label: string): void {
  if (value.length === EMPTY_STRING_LENGTH_ZERO) {
    throwInvalidMapping(`${label} is required`);
  }
}

function throwInvalidMapping(message: string): never {
  throw new TypedSheetsOrmError(TYPED_SHEETS_ORM_ERROR_CODES.INVALID_ENTITY_MAPPING, message);
}
