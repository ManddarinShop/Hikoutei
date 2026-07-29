/**
 * Canonical SQLite helpers used by mapped entity lifecycle writes.
 *
 * These functions validate row bindings and revision contracts before the
 * storage commit helper mutates canonical state and appends projection effects.
 */

import { POSITIVE_SAFE_INTEGER_MINIMUM } from "../../../../domain/index.js";
import { ROW_BINDING_STATES } from "../../../../domain/model/constants.js";
import {
  CANONICAL_COMMIT_RESULT_KINDS,
  type CanonicalCommitInput,
  type FencingContext,
} from "../../../../infrastructure/storage/index.js";
import type { TypedSheetsPersistenceContext } from "../../api/contracts.js";
import type { TypedSheetsEntityMapping } from "../../mapping/entityMapping.js";
import {
  TYPED_SHEETS_ORM_ERROR_CODES,
  TypedSheetsOrmError,
} from "../../errors.js";

/** Creates the active row binding used by both physical projections. */
export async function insertActiveRowBinding(
  persistence: TypedSheetsPersistenceContext,
  mapping: TypedSheetsEntityMapping,
  rowBindingId: string,
  entityId: string,
  anchor: string,
): Promise<void> {
  const existing = await persistence.readRowBinding(rowBindingId);
  if (existing !== undefined) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.ROW_BINDING_CONFLICT,
      `row binding ${rowBindingId} already exists for ${mapping.entityName}:${entityId}.`,
    );
  }
  const inserted = await persistence.insertActiveRowBinding(
    rowBindingId,
    mapping.logicalSheetId,
    anchor,
    entityId,
  );
  if (!inserted) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.ROW_BINDING_CONFLICT,
      `could not create the row binding for ${mapping.entityName}:${entityId}.`,
    );
  }
}

/** Requires the active binding to still match the mapped entity identity. */
export async function requireActiveRowBinding(
  persistence: TypedSheetsPersistenceContext,
  mapping: TypedSheetsEntityMapping,
  rowBindingId: string,
  entityId: string,
  anchor: string,
): Promise<void> {
  const row = await persistence.readRowBinding(rowBindingId);
  if (
    row === undefined ||
    row.logicalSheetId !== mapping.logicalSheetId ||
    row.anchorReference !== anchor ||
    row.entityId !== entityId ||
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
  persistence: TypedSheetsPersistenceContext,
  mapping: TypedSheetsEntityMapping,
  entityId: string,
): Promise<number> {
  const entityRevision = await persistence.readCanonicalEntityRevision(entityId);
  if (entityRevision === undefined || !isPositiveSafeInteger(entityRevision)) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.CANONICAL_COMMIT_REJECTED,
      `active canonical state is unavailable for ${mapping.entityName}:${entityId}.`,
    );
  }
  return entityRevision;
}

/** Returns canonical field revisions indexed by field name for update CAS. */
export async function canonicalFieldRevisions(
  persistence: TypedSheetsPersistenceContext,
  entityId: string,
): Promise<ReadonlyMap<string, number>> {
  const rows = await persistence.readCanonicalFieldRevisions(entityId);
  const revisions = new Map<string, number>();
  for (const row of rows) {
    if (isPositiveSafeInteger(row.fieldRevision)) {
      revisions.set(row.fieldName, row.fieldRevision);
    }
  }
  return revisions;
}

/** Applies a canonical commit or translates its stable result into an ORM error. */
export async function requireAppliedCanonicalCommit(
  persistence: TypedSheetsPersistenceContext,
  fence: FencingContext,
  commit: CanonicalCommitInput,
): Promise<void> {
  const result = await persistence.commitCanonicalChanges(fence, commit);
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
  persistence: TypedSheetsPersistenceContext,
  mapping: TypedSheetsEntityMapping,
  rowBindingId: string,
  entityId: string,
): Promise<void> {
  const tombstoned = await persistence.tombstoneActiveRowBinding(
    rowBindingId,
    mapping.logicalSheetId,
    entityId,
  );
  if (!tombstoned) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.ROW_BINDING_CONFLICT,
      `could not tombstone the row binding for ${mapping.entityName}:${entityId}.`,
    );
  }
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= POSITIVE_SAFE_INTEGER_MINIMUM;
}
