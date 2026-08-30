/**
 * Canonical SQLite helpers used by mapped entity lifecycle writes.
 *
 * These functions validate row bindings and revision contracts before the
 * storage commit helper mutates canonical state and appends projection effects.
 */

import { ROW_BINDING_STATES } from "@hikoutei/contracts/domain/model/constants.js";
import { isPositiveSafeInteger } from "@hikoutei/contracts/validation.js";

import {
  CANONICAL_COMMIT_RESULT_KINDS,
  commitCanonicalChangesWithSql,
  type CanonicalCommitInput,
} from "../../../../infrastructure/storage/state/canonical/canonicalCommit.js";
import {
  insertMappedActiveRowBindingWithSql,
  readMappedActiveCanonicalEntityWithSql,
  readMappedCanonicalEntityStateWithSql,
  readMappedCanonicalFieldRevisionsWithSql,
  readMappedRowBindingWithSql,
  reactivateMappedTombstonedRowBindingWithSql,
  tombstoneMappedActiveRowBindingWithSql,
} from "../../../../infrastructure/storage/state/mapped/mappedPersistenceSql.js";
import type { FencingContext } from "@hikoutei/ikisaki";
import type { SqlExecutor } from "@hikoutei/contracts/storage/sql.js";
import type { TypedSheetsEntityMapping } from "../../mapping/entityMapping.js";
import {
  TYPED_SHEETS_ORM_ERROR_CODES,
  TypedSheetsOrmError,
} from "../../errors.js";

/** Canonical entity lifecycle values used by mapped reactivation. */
const CANONICAL_ENTITY_STATUSES = {
  ACTIVE: "active",
  TOMBSTONED: "tombstoned",
} as const;

/** Result of preparing a mapped create's row binding. */
export type CreateRowBindingResult =
  | { readonly kind: "created" }
  | { readonly kind: "reactivated" };

/**
 * Prepares the active row binding used by both physical projections for a
 * mapped create.
 *
 * A fresh ID gets an ordinary active binding. A recreate reusing the exact
 * tombstoned identity (same logical sheet, deterministic anchor, binding, and
 * canonical entity ID) CAS-reactivates only the state, preserving the row's
 * candidate epoch and physical identity. Any other existing binding, or an
 * identity mismatch, stays a structured row-binding conflict.
 */
export async function createRowBinding(
  sql: SqlExecutor,
  mapping: TypedSheetsEntityMapping,
  rowBindingId: string,
  entityId: string,
  anchor: string,
): Promise<CreateRowBindingResult> {
  const existing = await readMappedRowBindingWithSql(sql, rowBindingId);
  if (existing === undefined) {
    const inserted = await insertMappedActiveRowBindingWithSql(
      sql,
      rowBindingId,
      mapping.logicalSheetId,
      anchor,
      entityId,
    );
    if (inserted.changes !== 1) {
      throw new TypedSheetsOrmError(
        TYPED_SHEETS_ORM_ERROR_CODES.ROW_BINDING_CONFLICT,
        `could not create the row binding for ${mapping.entityName}:${entityId}.`,
      );
    }
    return { kind: "created" };
  }
  if (
    existing.state === ROW_BINDING_STATES.TOMBSTONED &&
    existing.logical_sheet_id === mapping.logicalSheetId &&
    existing.anchor_reference === anchor &&
    existing.entity_id === entityId
  ) {
    const reactivated = await reactivateMappedTombstonedRowBindingWithSql(
      sql,
      rowBindingId,
      mapping.logicalSheetId,
      anchor,
      entityId,
    );
    if (reactivated.changes !== 1) {
      throw new TypedSheetsOrmError(
        TYPED_SHEETS_ORM_ERROR_CODES.ROW_BINDING_CONFLICT,
        `row binding ${rowBindingId} cannot be reactivated for ${mapping.entityName}:${entityId}.`,
      );
    }
    return { kind: "reactivated" };
  }
  throw new TypedSheetsOrmError(
    TYPED_SHEETS_ORM_ERROR_CODES.ROW_BINDING_CONFLICT,
    `row binding ${rowBindingId} already exists for ${mapping.entityName}:${entityId}.`,
  );
}

/** Reads an existing binding's canonical identity for legacy-compatible updates. */
export async function existingCanonicalEntityId(
  sql: SqlExecutor,
  mapping: TypedSheetsEntityMapping,
  rowBindingId: string,
  anchor: string,
): Promise<string | undefined> {
  const row = await readMappedRowBindingWithSql(sql, rowBindingId);
  if (row === undefined) return undefined;
  if (
    row.logical_sheet_id !== mapping.logicalSheetId ||
    row.anchor_reference !== anchor ||
    row.entity_id === null
  ) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.ROW_BINDING_CONFLICT,
      `row binding ${rowBindingId} does not match ${mapping.entityName}.`,
    );
  }
  return row.entity_id;
}

/** Requires the active binding to still match the mapped entity identity. */
export async function requireActiveRowBinding(
  sql: SqlExecutor,
  mapping: TypedSheetsEntityMapping,
  rowBindingId: string,
  entityId: string,
  anchor: string,
): Promise<void> {
  const row = await readMappedRowBindingWithSql(sql, rowBindingId);
  if (
    row === undefined ||
    row.logical_sheet_id !== mapping.logicalSheetId ||
    row.anchor_reference !== anchor ||
    row.entity_id !== entityId ||
    row.state !== ROW_BINDING_STATES.ACTIVE
  ) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.ROW_BINDING_CONFLICT,
      `active row binding is unavailable for ${mapping.entityName}:${entityId}.`,
    );
  }
}

/** Reads the current active canonical entity revision for an update or delete. */
export async function requireActiveCanonicalEntityRevision(
  sql: SqlExecutor,
  mapping: TypedSheetsEntityMapping,
  entityId: string,
): Promise<number> {
  const entity = await readMappedActiveCanonicalEntityWithSql(sql, entityId);
  if (entity === undefined || !isPositiveSafeInteger(entity.entity_revision)) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.CANONICAL_COMMIT_REJECTED,
      `active canonical state is unavailable for ${mapping.entityName}:${entityId}.`,
    );
  }
  return entity.entity_revision;
}

/** Reads the tombstoned canonical entity revision that a reactivation must advance. */
export async function requireTombstonedCanonicalEntityRevision(
  sql: SqlExecutor,
  mapping: TypedSheetsEntityMapping,
  entityId: string,
): Promise<number> {
  const entity = await readMappedCanonicalEntityStateWithSql(sql, entityId);
  if (
    entity === undefined ||
    entity.status !== CANONICAL_ENTITY_STATUSES.TOMBSTONED ||
    !isPositiveSafeInteger(entity.entity_revision)
  ) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.CANONICAL_COMMIT_REJECTED,
      `tombstoned canonical state is unavailable for ${mapping.entityName}:${entityId}.`,
    );
  }
  return entity.entity_revision;
}

/** Returns canonical field revisions indexed by field name for update CAS. */
export async function canonicalFieldRevisions(
  sql: SqlExecutor,
  entityId: string,
): Promise<ReadonlyMap<string, number>> {
  const rows = await readMappedCanonicalFieldRevisionsWithSql(sql, entityId);
  const revisions = new Map<string, number>();
  for (const row of rows) {
    if (isPositiveSafeInteger(row.field_revision)) {
      revisions.set(row.field_name, row.field_revision);
    }
  }
  return revisions;
}

/** Applies a canonical commit or translates its stable result into an ORM error. */
export async function requireAppliedCanonicalCommit(
  sql: SqlExecutor,
  fence: FencingContext,
  commit: CanonicalCommitInput,
): Promise<void> {
  const result = await commitCanonicalChangesWithSql(sql, fence, commit);
  if (result.kind === CANONICAL_COMMIT_RESULT_KINDS.APPLIED) return;
  if (result.kind === CANONICAL_COMMIT_RESULT_KINDS.FENCED_OUT) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.WRITER_LEASE_UNAVAILABLE,
      "the mapped entity writer lease was lost before canonical state could commit.",
    );
  }
  if (result.kind === CANONICAL_COMMIT_RESULT_KINDS.STALE) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.CANONICAL_COMMIT_REJECTED,
      `canonical ${result.target} state became stale while planning an entity flush.`,
    );
  }
  throw new TypedSheetsOrmError(
    TYPED_SHEETS_ORM_ERROR_CODES.CANONICAL_COMMIT_REJECTED,
    `mapped canonical commit is invalid: ${result.reason}.`,
  );
}

/** Tombstones a mapped row binding after the canonical delete has committed. */
export async function tombstoneActiveRowBinding(
  sql: SqlExecutor,
  mapping: TypedSheetsEntityMapping,
  rowBindingId: string,
  entityId: string,
): Promise<void> {
  const tombstoned = await tombstoneMappedActiveRowBindingWithSql(
    sql,
    rowBindingId,
    mapping.logicalSheetId,
    entityId,
  );
  if (tombstoned.changes !== 1) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.ROW_BINDING_CONFLICT,
      `could not tombstone the row binding for ${mapping.entityName}:${entityId}.`,
    );
  }
}
