/**
 * Stable identity derivation for mapped entities.
 *
 * These helpers keep entity IDs, row anchors, and shared row-binding IDs
 * deterministic across the system_state and user_input projections.
 */

import {
  EMPTY_STRING_LENGTH_ZERO,
} from "../../constants.js";
import { stableHash } from "../../encoding/stableEncode.js";
import {
  TYPED_SHEETS_ORM_ERROR_CODES,
  TypedSheetsOrmError,
} from "../errors.js";
import type { TypedSheetsEntityMapping } from "./contracts.js";

/** Derives the stable row-binding ID shared by an entity's physical projections. */
export function typedSheetsEntityRowBindingId(
  mapping: TypedSheetsEntityMapping,
  entityId: string | number,
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
  entityId: string | number,
): string {
  const normalized = normalizeSyncEntityId(entityId, "entity ID");
  const anchor = mapping.anchorForEntity(normalized);
  requireText(anchor, "row anchor");
  return anchor;
}

/** Reads the mapping's primary key from a pending entity change.
 *
 * Accepts a non-empty string or a safe-integer number and normalizes both to
 * the single canonical string form (`String(id)`) so Sheets, canonical
 * state, and observation agree on `42` vs `"42"`.
 */
export function typedSheetsEntityId(
  mapping: TypedSheetsEntityMapping,
  entity: object,
): string {
  const value: unknown = Reflect.get(entity, mapping.primaryKey);
  return normalizeSyncEntityId(value, `${mapping.entityName}.${mapping.primaryKey}`);
}

/** Converts a visible entity ID into the canonical ID used by sync state. */
export function typedSheetsCanonicalEntityId(
  mapping: TypedSheetsEntityMapping,
  entityId: string | number,
): string {
  const normalized = normalizeSyncEntityId(entityId, "entity ID");
  const canonical = mapping.canonicalEntityIdFor(normalized);
  requireText(canonical, "canonical entity ID");
  return canonical;
}

/** Converts a canonical sync identity back to the entity-table primary key. */
export function typedSheetsEntityIdFromCanonical(
  mapping: TypedSheetsEntityMapping,
  entityId: string | number,
): string {
  const normalized = normalizeSyncEntityId(entityId, "canonical entity ID");
  const visible = mapping.entityIdFromCanonical(normalized);
  requireText(visible, "entity ID");
  return visible;
}

/** Normalizes a visible/canonical entity ID to its canonical string form. */
function normalizeSyncEntityId(value: unknown, label: string): string {
  if (typeof value === "string") {
    if (value.length === EMPTY_STRING_LENGTH_ZERO) {
      throw new TypedSheetsOrmError(
        TYPED_SHEETS_ORM_ERROR_CODES.ENTITY_PRIMARY_KEY_UNAVAILABLE,
        `${label} must be a non-empty string or safe integer before flush.`,
      );
    }
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  throw new TypedSheetsOrmError(
    TYPED_SHEETS_ORM_ERROR_CODES.ENTITY_PRIMARY_KEY_UNAVAILABLE,
    `${label} must be a non-empty string or safe integer before flush.`,
  );
}

function requireText(value: string, label: string): void {
  if (value.length === EMPTY_STRING_LENGTH_ZERO) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.INVALID_ENTITY_MAPPING,
      `${label} is required`,
    );
  }
}
