/**
 * Stable identity derivation for mapped entities.
 *
 * These helpers keep entity IDs, row anchors, and shared row-binding IDs
 * deterministic across the system_state and user_input projections.
 */

import {
  EMPTY_STRING_LENGTH_ZERO,
  stableHash,
} from "../../../domain/index.js";
import {
  TYPED_SHEETS_ORM_ERROR_CODES,
  TypedSheetsOrmError,
} from "../errors.js";
import type { TypedSheetsEntityMapping } from "./contracts.js";

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
  const value = (entity as Readonly<Record<string, unknown>>)[mapping.primaryKey];
  if (typeof value !== "string" || value.length === EMPTY_STRING_LENGTH_ZERO) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.ENTITY_PRIMARY_KEY_UNAVAILABLE,
      `${mapping.entityName}.${mapping.primaryKey} must be a non-empty string before flush.`,
    );
  }
  return value;
}

function requireText(value: string, label: string): void {
  if (value.length === EMPTY_STRING_LENGTH_ZERO) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.INVALID_ENTITY_MAPPING,
      `${label} is required`,
    );
  }
}
