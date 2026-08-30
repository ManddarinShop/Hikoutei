/**
 * Lookup registry for validated entity mappings.
 *
 * Registry construction is kept separate from mapping validation so route
 * uniqueness and runtime lookup behavior can be read and tested independently.
 */

import {
  TYPED_SHEETS_ORM_ERROR_CODES,
  TypedSheetsOrmError,
} from "../errors.js";
import type {
  TypedSheetsEntityMapping,
  TypedSheetsEntityMappingRegistry,
} from "./contracts.js";

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
