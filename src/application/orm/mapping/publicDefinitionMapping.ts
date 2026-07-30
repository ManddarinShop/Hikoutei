/** Builds internal Sheet mappings from the public entity and route contracts. */

import {
  FIELD_OWNERSHIPS,
} from "../../../domain/index.js";
import {
  NORMALIZED_CELL_KINDS,
  type NormalizedCellKind,
} from "../../../shared/encoding/constants.js";
import {
  requireTypedSheetsEntityDefinition,
  isTypedSheetsScalarProperty,
} from "../api/entityDefinition.js";
import type {
  TypedSheetsEntityClass,
} from "../api/contracts.js";
import type {
  TypedSheetsEntitySyncOptions,
  TypedSheetsSyncOptions,
} from "../api/factoryContracts.js";
import {
  defineTypedSheetsEntityMapping,
} from "./definition.js";
import type { TypedSheetsEntityMapping } from "./contracts.js";
import {
  TYPED_SHEETS_ORM_ERROR_CODES,
  TypedSheetsOrmError,
} from "../errors.js";
import type { TypedSheetsEntityMappingInput } from "./contracts.js";

/**
 * Converts public entity definitions plus separate route configuration into
 * the validated internal mapping used by the current sync planner.
 */
export function createTypedSheetsEntityMappings(
  entities: readonly TypedSheetsEntityClass<object>[],
  sync: TypedSheetsSyncOptions,
): readonly TypedSheetsEntityMapping[] {
  return entities.map((entity) => {
    const definition = requireTypedSheetsEntityDefinition(entity);
    const route = sync.entities[definition.name];
    if (route === undefined) {
      throw new TypedSheetsOrmError(
        TYPED_SHEETS_ORM_ERROR_CODES.INVALID_ENTITY_MAPPING,
        `sync configuration is missing an entity route for ${definition.name}`,
      );
    }
    return createEntityMapping(entity, definition, route);
  });
}

function createEntityMapping(
  entity: TypedSheetsEntityClass<object>,
  definition: ReturnType<typeof requireTypedSheetsEntityDefinition>,
  route: TypedSheetsEntitySyncOptions,
): TypedSheetsEntityMapping {
  const scalarEntries = Object.entries(definition.properties)
    .filter(([, property]) => isTypedSheetsScalarProperty(property));
  const scalarNames = scalarEntries.map(([propertyName]) => propertyName);
  const editableFields = new Set(route.editableFields ?? scalarNames);
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
    fields: scalarEntries.map(([propertyName, property]) => {
      if (!isTypedSheetsScalarProperty(property)) {
        throw new TypedSheetsOrmError(
          TYPED_SHEETS_ORM_ERROR_CODES.INVALID_ENTITY_MAPPING,
          "relation properties cannot be projected as scalar Sheet fields",
        );
      }
      return {
        property: propertyName,
        fieldName: property.fieldName ?? propertyName,
        cellKind: normalizedCellKind(property.type),
        ownership: editableFields.has(propertyName)
          ? FIELD_OWNERSHIPS.USER
          : FIELD_OWNERSHIPS.SYSTEM,
        required: property.nullable !== true,
        unique: propertyName === businessKey,
      };
    }),
    projections: [
      createProjection(logicalSheetId, "system_state", route.systemState),
      ...(route.userInput === undefined
        ? []
        : [createProjection(logicalSheetId, "user_input", route.userInput)]),
    ],
  };
  return defineTypedSheetsEntityMapping(mappingInput);
}

function createProjection(
  logicalSheetId: string,
  projection: "system_state" | "user_input",
  route: {
    readonly spreadsheetId: string;
    readonly tabName: string;
    readonly registeredRange: string;
    readonly physicalSheetId?: string;
  },
) {
  return {
    physicalSheetId: route.physicalSheetId ?? `${logicalSheetId}:${projection}`,
    spreadsheetId: route.spreadsheetId,
    tabName: route.tabName,
    registeredRange: route.registeredRange,
    projection,
  } as const;
}

function normalizedCellKind(type: "string" | "number" | "boolean" | "date"): NormalizedCellKind {
  return type === "string"
    ? NORMALIZED_CELL_KINDS.STRING
    : type === "number"
      ? NORMALIZED_CELL_KINDS.NUMBER
      : type === "boolean"
        ? NORMALIZED_CELL_KINDS.BOOLEAN
        : NORMALIZED_CELL_KINDS.DATE;
}
