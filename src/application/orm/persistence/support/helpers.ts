/**
 * Small persistence helpers shared by the lifecycle and projection modules.
 *
 * Keeping these guards and presence constructors together makes the larger
 * persistence flows read in terms of their domain operation instead of their
 * repeated boundary checks.
 */

import {
  EMPTY_STRING_LENGTH_ZERO,
} from "../../../../shared/constants.js";
import {
  SCALAR_ENTITY_CHANGE_KINDS,
  type ScalarEntityFlushChange,
} from "../../../../adapter/persistence/contracts/scalar.js";
import type { NormalizedCell } from "../../../../shared/encoding/types.js";
import {
  isNonNegativeSafeInteger,
  isPositiveSafeInteger,
} from "../../../../shared/validation.js";
import {
  type TypedSheetsEntityFieldMapping,
  type TypedSheetsEntityMapping,
  requireTypedSheetsEntityProjection,
} from "../../mapping/entityMapping.js";
import {
  TYPED_SHEETS_ORM_ERROR_CODES,
  TypedSheetsOrmError,
} from "../../errors.js";
import type { ResolvedWriterOptions } from "./contracts.js";

/** Returns a namespaced ID and rejects an invalid injected ID source. */
export function identifiedValue(prefix: string, writer: ResolvedWriterOptions): string {
  const value = writer.createId();
  if (value.length === EMPTY_STRING_LENGTH_ZERO) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.INVALID_ENTITY_MAPPING,
      "mapped writer createId must return a non-empty value.",
    );
  }
  return `${prefix}:${value}`;
}

/** Reads one mapped field and fails before an incomplete canonical commit. */
export function requireEncodedField(
  encodedEntity: Readonly<Record<string, NormalizedCell>>,
  field: TypedSheetsEntityFieldMapping,
): NormalizedCell {
  const value = encodedEntity[field.fieldName];
  if (value === undefined) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.INVALID_MAPPED_FIELD_VALUE,
      `encoded value is unavailable for ${field.fieldName}.`,
    );
  }
  return value;
}

/** Validates the primary-key value promoted by Hikoutei's scalar flush plan. */
export function requireChangeEntityId(
  mapping: TypedSheetsEntityMapping,
  change: ScalarEntityFlushChange,
): string {
  const row = change.row;
  const value = change.kind === SCALAR_ENTITY_CHANGE_KINDS.INSERT
    ? row.values[mapping.primaryKey]
    : "primaryKeyValue" in row ? row.primaryKeyValue : undefined;
  if (typeof value !== "string" || value.length === EMPTY_STRING_LENGTH_ZERO) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.ENTITY_PRIMARY_KEY_UNAVAILABLE,
      `${mapping.entityName}.${mapping.primaryKey} must be a non-empty string before flush.`,
    );
  }
  const rowValue = row.values[mapping.primaryKey];
  if (rowValue !== value) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.ENTITY_PRIMARY_KEY_MISMATCH,
      `${mapping.entityName} primary-key value does not match its row snapshot.`,
    );
  }
  return value;
}

/** Builds the stable target ID used by a physical projection row effect. */
export function projectionRowTargetId(physicalSheetId: string, rowBindingId: string): string {
  return `projection-row:${physicalSheetId}:${rowBindingId}`;
}

/** Throws the common error used when a projection cannot safely be planned. */
export function throwProjectionBlocked(
  mapping: TypedSheetsEntityMapping,
  projection: ReturnType<typeof requireTypedSheetsEntityProjection>,
  reason: string,
): never {
  throw new TypedSheetsOrmError(
    TYPED_SHEETS_ORM_ERROR_CODES.PROJECTION_OUTBOX_BLOCKED,
    `${mapping.entityName} ${projection.projection} projection is blocked: ${reason}.`,
  );
}
