/**
 * Small persistence helpers shared by the lifecycle and projection modules.
 *
 * Keeping these guards and presence constructors together makes the larger
 * persistence flows read in terms of their domain operation instead of their
 * repeated boundary checks.
 */

import {
  APPLICABILITY_KINDS,
  EMPTY_STRING_LENGTH_ZERO,
  POSITIVE_SAFE_INTEGER_MINIMUM,
  PRESENCE_KINDS,
  type Applicability,
  type NormalizedCell,
  type Presence,
} from "../../../../domain/index.js";
import type {
  TypedSheetsEntityChange,
} from "../../api/contracts.js";
import {
  type TypedSheetsEntityFieldMapping,
  type TypedSheetsEntityMapping,
  requireTypedSheetsEntityProjection,
  typedSheetsEntityId,
} from "../../mapping/entityMapping.js";
import {
  TYPED_SHEETS_ORM_ERROR_CODES,
  TypedSheetsOrmError,
} from "../../errors.js";
import type { ResolvedWriterOptions } from "./contracts.js";

/** Wraps a value in the validated presence contract used by storage writes. */
export function presentValue<T>(value: T): Presence<T> {
  return { kind: PRESENCE_KINDS.PRESENT, value };
}

/** Represents a value that is intentionally not applicable to an operation. */
export function absentValue<T>(): Presence<T> {
  return { kind: PRESENCE_KINDS.ABSENT };
}

/** Wraps a value in the validated applicability contract used by storage writes. */
export function applicableValue<T>(value: T): Applicability<T> {
  return { kind: APPLICABILITY_KINDS.APPLICABLE, value };
}

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

/** Validates the entity identity collected by the underlying flush engine. */
export function requireChangeEntityId(
  mapping: TypedSheetsEntityMapping,
  change: TypedSheetsEntityChange,
): string {
  const entityId = typedSheetsEntityId(mapping, change.entity);
  if (change.primaryKey.kind !== PRESENCE_KINDS.PRESENT) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.ENTITY_PRIMARY_KEY_UNAVAILABLE,
      `${mapping.entityName} has no serialized primary key during flush.`,
    );
  }
  if (change.primaryKey.value !== entityId) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.ENTITY_PRIMARY_KEY_MISMATCH,
      `${mapping.entityName} primary-key metadata does not match its entity property.`,
    );
  }
  return entityId;
}

/** Builds the stable target ID used by a physical projection row effect. */
export function projectionRowTargetId(physicalSheetId: string, rowBindingId: string): string {
  return `projection-row:${physicalSheetId}:${rowBindingId}`;
}

/** Checks a positive SQLite revision or stream sequence. */
export function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= POSITIVE_SAFE_INTEGER_MINIMUM;
}

/** Checks a revision that may validly start at zero. */
export function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
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
