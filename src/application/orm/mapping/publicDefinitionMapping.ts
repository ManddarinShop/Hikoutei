/** Builds internal Sheet mappings from the public entity and route contracts. */

import { FIELD_OWNERSHIPS } from "../../../domain/index.js";
import {
  NORMALIZED_CELL_KINDS,
  type NormalizedCellKind,
} from "../../../shared/encoding/constants.js";
import {
  isTypedSheetsScalarProperty,
  requireTypedSheetsEntityDefinition,
  type TypedSheetsPropertyDefinition,
  type TypedSheetsScalarPropertyDefinition,
  type TypedSheetsScalarType,
} from "../api/entityDefinition.js";
import type { TypedSheetsEntityClass } from "../api/contracts.js";
import type {
  TypedSheetsEntitySyncOptions,
  TypedSheetsSheetRouteOptions,
  TypedSheetsSyncOptions,
} from "../api/factoryContracts.js";
import { TYPED_SHEETS_ORM_ERROR_CODES, TypedSheetsOrmError } from "../errors.js";
import { defineTypedSheetsEntityMapping } from "./definition.js";
import type {
  TypedSheetsEntityFieldMappingInput,
  TypedSheetsEntityMapping,
  TypedSheetsEntityMappingInput,
  TypedSheetsEntityProjection,
  TypedSheetsEntityProjectionMappingInput,
} from "./contracts.js";

const NORMALIZED_CELL_KIND_BY_TYPE = {
  string: NORMALIZED_CELL_KINDS.STRING,
  number: NORMALIZED_CELL_KINDS.NUMBER,
  boolean: NORMALIZED_CELL_KINDS.BOOLEAN,
  date: NORMALIZED_CELL_KINDS.DATE,
} as const satisfies Record<TypedSheetsScalarType, NormalizedCellKind>;

/**
 * Converts public entity definitions plus separate route configuration into
 * the validated internal mapping used by the current sync planner.
 */
export function createTypedSheetsEntityMappings(
  entities: readonly TypedSheetsEntityClass<object>[],
  sync: TypedSheetsSyncOptions,
): readonly TypedSheetsEntityMapping[] {
  return entities.map((entity) => createEntityMappingForEntity(entity, sync));
}

function createEntityMappingForEntity(
  entity: TypedSheetsEntityClass<object>,
  sync: TypedSheetsSyncOptions,
): TypedSheetsEntityMapping {
  const definition = requireTypedSheetsEntityDefinition(entity);
  const route = sync.entities[definition.name];
  if (route === undefined) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.INVALID_ENTITY_MAPPING,
      `sync configuration is missing an entity route for ${definition.name}`,
    );
  }
  return createEntityMapping(entity, definition, route);
}

function createEntityMapping(
  entity: TypedSheetsEntityClass<object>,
  definition: ReturnType<typeof requireTypedSheetsEntityDefinition>,
  route: TypedSheetsEntitySyncOptions,
): TypedSheetsEntityMapping {
  const scalarEntries = scalarPropertyEntries(definition.properties);
  const editableFields = new Set(
    route.editableFields ?? scalarEntries.map(([propertyName]) => propertyName),
  );
  const businessKey = route.businessKey ?? definition.primaryKey;
  const logicalSheetId = route.logicalSheetId ?? definition.name;
  const schemaVersion = route.schemaVersion ?? 1;

  const mappingInput: TypedSheetsEntityMappingInput<Record<string, unknown>> = {
    entity: entity as unknown as TypedSheetsEntityClass<Record<string, unknown>>,
    entityName: definition.name,
    logicalSheetId,
    primaryKey: definition.primaryKey,
    businessKey,
    schemaVersion,
    fields: scalarEntries.map(([propertyName, property]) =>
      createFieldMapping(propertyName, property, editableFields, businessKey),
    ),
    projections: createProjections(logicalSheetId, route),
  };
  return defineTypedSheetsEntityMapping(mappingInput);
}

function scalarPropertyEntries(
  properties: Readonly<Record<string, TypedSheetsPropertyDefinition>>,
): readonly [string, TypedSheetsScalarPropertyDefinition][] {
  return Object.entries(properties).filter(
    (entry): entry is [string, TypedSheetsScalarPropertyDefinition] =>
      isTypedSheetsScalarProperty(entry[1]),
  );
}

function createFieldMapping(
  propertyName: string,
  property: TypedSheetsScalarPropertyDefinition,
  editableFields: ReadonlySet<string>,
  businessKey: string,
): TypedSheetsEntityFieldMappingInput<Record<string, unknown>> {
  return {
    property: propertyName,
    fieldName: property.fieldName ?? propertyName,
    cellKind: NORMALIZED_CELL_KIND_BY_TYPE[property.type],
    ownership: editableFields.has(propertyName)
      ? FIELD_OWNERSHIPS.USER
      : FIELD_OWNERSHIPS.SYSTEM,
    required: property.nullable !== true,
    unique: propertyName === businessKey,
  };
}

function createProjections(
  logicalSheetId: string,
  route: TypedSheetsEntitySyncOptions,
): readonly TypedSheetsEntityProjectionMappingInput[] {
  const projections = [
    createProjection(logicalSheetId, "system_state", route.systemState),
  ];

  if (route.userInput !== undefined) {
    projections.push(
      createProjection(logicalSheetId, "user_input", route.userInput),
    );
  }

  return projections;
}

function createProjection(
  logicalSheetId: string,
  projection: TypedSheetsEntityProjection,
  route: TypedSheetsSheetRouteOptions,
): TypedSheetsEntityProjectionMappingInput {
  return {
    physicalSheetId: route.physicalSheetId ?? `${logicalSheetId}:${projection}`,
    spreadsheetId: route.spreadsheetId,
    tabName: route.tabName,
    registeredRange: route.registeredRange,
    projection,
  } as const;
}
