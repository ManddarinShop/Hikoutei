/**
 * Converts mapped entity values to and from normalized Sheet cells.
 *
 * Custom codecs are accepted at this boundary, but every result is still
 * checked against the declared normalized-cell contract before persistence.
 */

import {
  EMPTY_STRING_LENGTH_ZERO,
} from "../../../shared/constants.js";
import type { NormalizedCell } from "../../../shared/encoding/types.js";
import {
  isNormalizedCell,
  NORMALIZED_CELL_KINDS,
} from "../../../shared/encoding/index.js";
import { isCanonicalUtcIsoDate } from "../../../shared/validation.js";
import {
  TYPED_SHEETS_ORM_ERROR_CODES,
  TypedSheetsOrmError,
} from "../errors.js";
import type {
  TypedSheetsEntityFieldMapping,
  TypedSheetsEntityMapping,
} from "./contracts.js";

/** Encodes every mapped entity property into its canonical normalized-cell value. */
export function encodeTypedSheetsEntity(
  mapping: TypedSheetsEntityMapping,
  entity: object,
): Readonly<Record<string, NormalizedCell>> {
  return encodeTypedSheetsEntityValues(mapping, readEntityValues(entity, mapping.fields));
}

/** Encodes a complete provider-neutral entity row without requiring a managed object. */
export function encodeTypedSheetsEntityValues(
  mapping: TypedSheetsEntityMapping,
  values: Readonly<Record<string, unknown>>,
): Readonly<Record<string, NormalizedCell>> {
  const encoded: Record<string, NormalizedCell> = {};
  for (const field of mapping.fields) {
    encoded[field.fieldName] = encodeTypedSheetsEntityField(
      mapping,
      field,
      values[field.property],
    );
  }
  return encoded;
}

/** Encodes one mapped property while enforcing its declared normalized-cell contract. */
export function encodeTypedSheetsEntityField(
  mapping: TypedSheetsEntityMapping,
  field: TypedSheetsEntityFieldMapping,
  value: unknown,
): NormalizedCell {
  const cell = field.encode === undefined
    ? defaultEncode(field, value)
    : field.encode(value);
  return requireValidMappedCell(mapping, field, cell);
}

/** Decodes one accepted canonical cell into the mapped application property value. */
export function decodeTypedSheetsEntityField(
  mapping: TypedSheetsEntityMapping,
  field: TypedSheetsEntityFieldMapping,
  value: NormalizedCell,
): unknown {
  const cell = requireValidMappedCell(mapping, field, value);
  if (field.decode !== undefined) return field.decode(cell);
  if (cell === null) return null;
  switch (cell.kind) {
    case NORMALIZED_CELL_KINDS.STRING:
    case NORMALIZED_CELL_KINDS.NUMBER:
    case NORMALIZED_CELL_KINDS.BOOLEAN:
      return cell.value;
    case NORMALIZED_CELL_KINDS.DATE:
      return new Date(cell.value);
  }
}

/** Finds the field declaration for one canonical field name or fails closed. */
export function requireTypedSheetsEntityField(
  mapping: TypedSheetsEntityMapping,
  fieldName: string,
): TypedSheetsEntityFieldMapping {
  const field = mapping.fields.find((candidate) => candidate.fieldName === fieldName);
  if (field === undefined) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.INVALID_ENTITY_MAPPING,
      `${mapping.entityName} does not map canonical field ${fieldName}.`,
    );
  }
  return field;
}

function readEntityValues(
  entity: object,
  fields: readonly TypedSheetsEntityFieldMapping[],
): Readonly<Record<string, unknown>> {
  const values: Record<string, unknown> = {};
  for (const field of fields) values[field.property] = Reflect.get(entity, field.property);
  return values;
}

function defaultEncode(field: TypedSheetsEntityFieldMapping, value: unknown): NormalizedCell {
  if (value === null) return null;
  switch (field.cellKind) {
    case NORMALIZED_CELL_KINDS.STRING:
      return typeof value === "string"
        ? { kind: NORMALIZED_CELL_KINDS.STRING, value }
        : invalidMappedFieldValue(field, "must be a string or null");
    case NORMALIZED_CELL_KINDS.NUMBER:
      return typeof value === "number" && Number.isFinite(value)
        ? { kind: NORMALIZED_CELL_KINDS.NUMBER, value }
        : invalidMappedFieldValue(field, "must be a finite number or null");
    case NORMALIZED_CELL_KINDS.BOOLEAN:
      return typeof value === "boolean"
        ? { kind: NORMALIZED_CELL_KINDS.BOOLEAN, value }
        : invalidMappedFieldValue(field, "must be a boolean or null");
    case NORMALIZED_CELL_KINDS.DATE:
      return defaultDateCell(field, value);
  }
}

function defaultDateCell(field: TypedSheetsEntityFieldMapping, value: unknown): NormalizedCell {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) {
      return invalidMappedFieldValue(field, "must be a valid Date or canonical ISO date string");
    }
    return { kind: NORMALIZED_CELL_KINDS.DATE, value: value.toISOString() };
  }
  if (typeof value === "string" && isCanonicalUtcIsoDate(value)) {
    return { kind: NORMALIZED_CELL_KINDS.DATE, value };
  }
  return invalidMappedFieldValue(field, "must be a valid Date or canonical ISO date string");
}

function requireValidMappedCell(
  mapping: TypedSheetsEntityMapping,
  field: TypedSheetsEntityFieldMapping,
  cell: unknown,
): NormalizedCell {
  if (cell === null) {
    if (field.required) {
      throwInvalidFieldValue(mapping, field, "cannot be blank");
    }
    return cell;
  }
  if (!isNormalizedCell(cell)) {
    throwInvalidFieldValue(mapping, field, "must encode as a normalized cell or null");
  }
  if (cell.kind !== field.cellKind) {
    throwInvalidFieldValue(mapping, field, `must encode as ${field.cellKind}`);
  }
  if (
    field.required &&
    cell.kind === NORMALIZED_CELL_KINDS.STRING &&
    cell.value.length === EMPTY_STRING_LENGTH_ZERO
  ) {
    throwInvalidFieldValue(mapping, field, "cannot be an empty string");
  }
  return cell;
}

function invalidMappedFieldValue(
  field: TypedSheetsEntityFieldMapping,
  message: string,
): never {
  throw new TypedSheetsOrmError(
    TYPED_SHEETS_ORM_ERROR_CODES.INVALID_MAPPED_FIELD_VALUE,
    `${field.property} ${message}.`,
  );
}

function throwInvalidFieldValue(
  mapping: TypedSheetsEntityMapping,
  field: TypedSheetsEntityFieldMapping,
  message: string,
): never {
  throw new TypedSheetsOrmError(
    TYPED_SHEETS_ORM_ERROR_CODES.INVALID_MAPPED_FIELD_VALUE,
    `${mapping.entityName}.${field.property} ${message}.`,
  );
}
