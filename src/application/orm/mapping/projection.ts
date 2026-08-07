/**
 * Converts validated entity mappings into sync projection metadata.
 *
 * This module owns ownership manifests, projection headers, and registration
 * payloads; it does not validate entity declarations or encode field values.
 */

import {
  FIELD_OWNERSHIPS,
  REGISTERED_PROJECTION_KINDS,
  type FieldManifestEntry,
  type OwnershipManifest,
} from "../../../domain/index.js";
import { SYNC_PROJECTIONS } from "../../sync/sheetsContract/constants.js";
import type { RegisterSyncSheetInput, RegisteredProjection } from "../../../infrastructure/storage/index.js";
import {
  TYPED_SHEETS_ORM_ERROR_CODES,
  TypedSheetsOrmError,
} from "../errors.js";
import type {
  TypedSheetsEntityMapping,
  TypedSheetsEntityProjection,
  TypedSheetsEntityProjectionMapping,
  TypedSheetsMappedProjectionDefinition,
} from "./contracts.js";

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
          ? SYNC_PROJECTIONS.USER_INPUT
          : SYNC_PROJECTIONS.SYSTEM_STATE,
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
    .sort((left, right) => left.fieldName < right.fieldName ? -1 : left.fieldName > right.fieldName ? 1 : 0);
  return JSON.stringify({ fields });
}

/** Returns the headers that setup must materialize for one physical projection. */
export function typedSheetsEntityProjectionHeaders(
  mapping: TypedSheetsEntityMapping,
  projection: TypedSheetsEntityProjection,
): readonly string[] {
  const fieldNames = projection === SYNC_PROJECTIONS.SYSTEM_STATE
    ? mapping.fields.map((field) => field.fieldName)
    : mapping.fields
      .filter((field) => field.ownership === FIELD_OWNERSHIPS.USER)
      .map((field) => field.fieldName);
  return projection === SYNC_PROJECTIONS.SYSTEM_STATE
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
    projection: toRegisteredProjection(projection.projection),
    schemaVersion: mapping.schemaVersion,
    ownershipManifestJson: serializeTypedSheetsEntityOwnershipManifest(mapping),
    businessKeyField: mapping.businessKey.fieldName,
  };
}

function toRegisteredProjection(
  projection: TypedSheetsEntityProjection,
): RegisteredProjection {
  switch (projection) {
    case SYNC_PROJECTIONS.USER_INPUT:
      return REGISTERED_PROJECTION_KINDS.USER_INPUT;
    case SYNC_PROJECTIONS.SYSTEM_STATE:
      return REGISTERED_PROJECTION_KINDS.SYSTEM_STATE;
  }
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
