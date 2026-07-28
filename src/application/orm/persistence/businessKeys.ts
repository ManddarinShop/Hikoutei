/**
 * Business-key index maintenance for mapped entity persistence.
 *
 * The index is kept in the same SQLite transaction as the canonical entity
 * write, so duplicate and rotated keys cannot become visible independently of
 * the entity lifecycle change.
 */

import { stableHash, type NormalizedCell } from "../../../domain/index.js";
import type { SqlExecutor } from "../../../adapter/persistence/contracts/sql.js";
import type { TypedSheetsEntityMapping } from "../mapping/entityMapping.js";
import {
  TYPED_SHEETS_ORM_ERROR_CODES,
  TypedSheetsOrmError,
} from "../errors.js";
import {
  INSERT_ACTIVE_BUSINESS_KEY_SQL,
  READ_ACTIVE_BUSINESS_KEY_SQL,
  READ_BUSINESS_KEY_OWNER_SQL,
  RETIRE_ACTIVE_BUSINESS_KEY_SQL,
  RETIRE_ENTITY_BUSINESS_KEYS_SQL,
  type ActiveBusinessKeySqlRow,
  type BusinessKeyOwnerSqlRow,
} from "./contracts.js";
import { requireEncodedField } from "./helpers.js";

/** Claims the mapped entity's normalized business key during creation. */
export async function claimBusinessKey(
  sql: SqlExecutor,
  mapping: TypedSheetsEntityMapping,
  entityId: string,
  encodedEntity: Readonly<Record<string, NormalizedCell>>,
): Promise<void> {
  const normalizedKey = businessKeyHash(mapping, encodedEntity);
  await ensureBusinessKeyOwner(sql, mapping, entityId, normalizedKey);
}

/** Rotates the indexed business key after an accepted entity update. */
export async function rotateBusinessKey(
  sql: SqlExecutor,
  mapping: TypedSheetsEntityMapping,
  entityId: string,
  encodedEntity: Readonly<Record<string, NormalizedCell>>,
): Promise<void> {
  const current = await sql.get<ActiveBusinessKeySqlRow>(READ_ACTIVE_BUSINESS_KEY_SQL, [
    mapping.logicalSheetId,
    mapping.businessKey.fieldName,
    entityId,
  ]);
  if (current === undefined) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.CANONICAL_COMMIT_REJECTED,
      `business-key index is unavailable for ${mapping.entityName}:${entityId}.`,
    );
  }
  const nextNormalizedKey = businessKeyHash(mapping, encodedEntity);
  if (current.normalized_key === nextNormalizedKey) return;
  const retired = await sql.run(RETIRE_ACTIVE_BUSINESS_KEY_SQL, [
    mapping.logicalSheetId,
    mapping.businessKey.fieldName,
    current.normalized_key,
    entityId,
  ]);
  if (retired.changes !== 1) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.CANONICAL_COMMIT_REJECTED,
      `could not retire the previous business key for ${mapping.entityName}:${entityId}.`,
    );
  }
  await ensureBusinessKeyOwner(sql, mapping, entityId, nextNormalizedKey);
}

/** Retires all business keys owned by a deleted mapped entity. */
export async function retireEntityBusinessKeys(
  sql: SqlExecutor,
  mapping: TypedSheetsEntityMapping,
  entityId: string,
): Promise<void> {
  const retired = await sql.run(RETIRE_ENTITY_BUSINESS_KEYS_SQL, [mapping.logicalSheetId, entityId]);
  if (retired.changes !== 1) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.CANONICAL_COMMIT_REJECTED,
      `could not retire the business key for ${mapping.entityName}:${entityId}.`,
    );
  }
}

async function ensureBusinessKeyOwner(
  sql: SqlExecutor,
  mapping: TypedSheetsEntityMapping,
  entityId: string,
  normalizedKey: string,
): Promise<void> {
  const owner = await sql.get<BusinessKeyOwnerSqlRow>(READ_BUSINESS_KEY_OWNER_SQL, [
    mapping.logicalSheetId,
    mapping.businessKey.fieldName,
    normalizedKey,
  ]);
  if (owner !== undefined) {
    if (owner.entity_id === entityId) return;
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.CANONICAL_COMMIT_REJECTED,
      `business key for ${mapping.entityName} is already owned by ${owner.entity_id}.`,
    );
  }
  const inserted = await sql.run(INSERT_ACTIVE_BUSINESS_KEY_SQL, [
    mapping.logicalSheetId,
    mapping.businessKey.fieldName,
    normalizedKey,
    entityId,
  ]);
  if (inserted.changes !== 1) {
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
