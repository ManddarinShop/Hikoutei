/**
 * Business-key index maintenance for mapped entity persistence.
 *
 * The index is kept in the same SQLite transaction as the canonical entity
 * write, so duplicate and rotated keys cannot become visible independently of
 * the entity lifecycle change.
 */

import { stableHash, type NormalizedCell } from "../../../../domain/index.js";
import type { TypedSheetsPersistenceContext } from "../../api/contracts.js";
import type { TypedSheetsEntityMapping } from "../../mapping/entityMapping.js";
import {
  TYPED_SHEETS_ORM_ERROR_CODES,
  TypedSheetsOrmError,
} from "../../errors.js";
import { requireEncodedField } from "./helpers.js";

/** Claims the mapped entity's normalized business key during creation. */
export async function claimBusinessKey(
  persistence: TypedSheetsPersistenceContext,
  mapping: TypedSheetsEntityMapping,
  entityId: string,
  encodedEntity: Readonly<Record<string, NormalizedCell>>,
): Promise<void> {
  const normalizedKey = businessKeyHash(mapping, encodedEntity);
  await ensureBusinessKeyOwner(persistence, mapping, entityId, normalizedKey);
}

/** Rotates the indexed business key after an accepted entity update. */
export async function rotateBusinessKey(
  persistence: TypedSheetsPersistenceContext,
  mapping: TypedSheetsEntityMapping,
  entityId: string,
  encodedEntity: Readonly<Record<string, NormalizedCell>>,
): Promise<void> {
  const current = await persistence.readActiveBusinessKey(
    mapping.logicalSheetId,
    mapping.businessKey.fieldName,
    entityId,
  );
  if (current === undefined) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.CANONICAL_COMMIT_REJECTED,
      `business-key index is unavailable for ${mapping.entityName}:${entityId}.`,
    );
  }
  const nextNormalizedKey = businessKeyHash(mapping, encodedEntity);
  if (current.normalizedKey === nextNormalizedKey) return;
  const retired = await persistence.retireActiveBusinessKey(
    mapping.logicalSheetId,
    mapping.businessKey.fieldName,
    current.normalizedKey,
    entityId,
  );
  if (!retired) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.CANONICAL_COMMIT_REJECTED,
      `could not retire the previous business key for ${mapping.entityName}:${entityId}.`,
    );
  }
  await ensureBusinessKeyOwner(persistence, mapping, entityId, nextNormalizedKey);
}

/** Retires all business keys owned by a deleted mapped entity. */
export async function retireEntityBusinessKeys(
  persistence: TypedSheetsPersistenceContext,
  mapping: TypedSheetsEntityMapping,
  entityId: string,
): Promise<void> {
  const retired = await persistence.retireEntityBusinessKeys(
    mapping.logicalSheetId,
    entityId,
  );
  if (!retired) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.CANONICAL_COMMIT_REJECTED,
      `could not retire the business key for ${mapping.entityName}:${entityId}.`,
    );
  }
}

async function ensureBusinessKeyOwner(
  persistence: TypedSheetsPersistenceContext,
  mapping: TypedSheetsEntityMapping,
  entityId: string,
  normalizedKey: string,
): Promise<void> {
  const owner = await persistence.readBusinessKeyOwner(
    mapping.logicalSheetId,
    mapping.businessKey.fieldName,
    normalizedKey,
  );
  if (owner !== undefined) {
    if (owner === entityId) return;
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.CANONICAL_COMMIT_REJECTED,
      `business key for ${mapping.entityName} is already owned by ${owner}.`,
    );
  }
  const inserted = await persistence.insertActiveBusinessKey(
    mapping.logicalSheetId,
    mapping.businessKey.fieldName,
    normalizedKey,
    entityId,
  );
  if (!inserted) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.CANONICAL_COMMIT_REJECTED,
      `could not claim the business key for ${mapping.entityName}:${entityId}.`,
    );
  }
}

function businessKeyHash(
  mapping: TypedSheetsEntityMapping,
  encodedEntity: Readonly<Record<string, NormalizedCell>>,
): string {
  return stableHash(requireEncodedField(encodedEntity, mapping.businessKey));
}
