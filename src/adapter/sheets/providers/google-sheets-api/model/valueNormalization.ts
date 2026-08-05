/**
 * Value normalization between Sheets API cells and the canonical contracts.
 *
 * These helpers mirror the Apps Script operations' value semantics exactly:
 * whole-column registered ranges, the Excel 1900-system date serial
 * (days since 1899-12-30 UTC), the canonical UTC number format, NFC-normalized
 * strings, and the identity-from-cell rule used by the append/replay paths.
 */

import type { NormalizedCell } from "../../../../../domain/index.js";
import {
  GOOGLE_SHEETS_API_DATE_NUMBER_FORMAT,
} from "../constants.js";
import { invalidProviderState } from "../errors.js";

/** A validated whole-column registered range with 1-based column positions. */
export interface ParsedRegisteredRange {
  readonly startColumn: number;
  readonly columnCount: number;
}

const WHOLE_COLUMN_RANGE_PATTERN = /^[A-Z]+:[A-Z]+$/;

/** Parses `A:C`-style whole-column ranges like the Apps Script operations. */
export function parseRegisteredRange(value: string): ParsedRegisteredRange {
  if (!WHOLE_COLUMN_RANGE_PATTERN.test(value)) {
    invalidProviderState("registeredRange must be an uppercase whole-column range");
  }
  const separator = value.indexOf(":");
  const start = value.slice(0, separator);
  const end = value.slice(separator + 1);
  const startColumn = columnNumber(start);
  const endColumn = columnNumber(end);
  if (endColumn < startColumn) {
    invalidProviderState("registeredRange end precedes start");
  }
  return { startColumn, columnCount: endColumn - startColumn + 1 };
}

/** Converts A1 column letters to a 1-based column number. */
export function columnNumber(letters: string): number {
  let result = 0;
  for (const letter of letters) {
    result = result * 26 + letter.charCodeAt(0) - 64;
  }
  return result;
}

/** Converts a 1-based column number to A1 column letters (1 -> "A", 28 -> "AB"). */
export function columnLetters(column: number): string {
  let letters = "";
  let value = column;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    value = Math.floor((value - 1) / 26);
  }
  return letters;
}

/** Quotes a sheet tab name for A1 notation, doubling embedded single quotes. */
export function quoteA1SheetName(sheetName: string): string {
  return `'${sheetName.replace(/'/g, "''")}'`;
}

/**
 * Excel/Sheets 1900-system serial: whole days since 1899-12-30 UTC. Canonical
 * dates are always after the 1900-02-29 phantom day, so the serial is exactly
 * the UTC day offset (the same formula the Apps Script batch append uses).
 */
export function dateSerialFromIso(iso: string): number {
  return (Date.parse(iso) - Date.UTC(1899, 11, 30)) / 86_400_000;
}

/** Converts a date serial back to the canonical UTC ISO timestamp. */
export function isoFromDateSerial(serial: number): string {
  return new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000).toISOString();
}

/**
 * Returns whether a cell number format is the canonical date format.
 *
 * The REST API returns `CellFormat.numberFormat` as a `{ type, pattern }`
 * object, never a bare string. The canonical check requires the DATE_TIME
 * type and a pattern that matches after stripping embedded quotes and
 * whitespace, so both the quoted pattern the provider writes and any
 * unquoted equivalent are recognized. Null or absent formats are tolerated
 * and are not dates.
 */
export function isCanonicalDateNumberFormat(format: unknown): boolean {
  if (format === null || format === undefined) return false;
  if (typeof format !== "object" || Array.isArray(format)) return false;
  const record = format as Record<string, unknown>;
  if (record.type !== "DATE_TIME") return false;
  const pattern = record.pattern;
  if (typeof pattern !== "string") return false;
  return normalizeDateNumberFormatPattern(pattern) ===
    normalizeDateNumberFormatPattern(GOOGLE_SHEETS_API_DATE_NUMBER_FORMAT);
}

function normalizeDateNumberFormatPattern(pattern: string): string {
  return pattern.replace(/["\s]/g, "");
}

/**
 * Converts one API cell value to a canonical normalized cell.
 *
 * A number whose cell format is the canonical date format becomes a date;
 * everything else keeps its raw kind. Formula and error cells fail closed
 * (the outbound provider never writes them and must not hash them as
 * literals). Blank cells (missing or empty value objects) become `null`.
 */
export function normalizedCellFromApiValue(
  value: unknown,
  numberFormat: unknown,
): NormalizedCell {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") {
    invalidProviderState("Sheet cell value is not an object");
  }
  const record = value as Record<string, unknown>;
  if (record.formulaValue !== undefined || record.errorValue !== undefined) {
    invalidProviderState("Sheet cell contains a formula or error value");
  }
  if (record.stringValue !== undefined) {
    if (typeof record.stringValue !== "string") {
      invalidProviderState("Sheet cell stringValue is not a string");
    }
    return { kind: "string", value: record.stringValue.normalize("NFC") };
  }
  if (record.boolValue !== undefined) {
    if (typeof record.boolValue !== "boolean") {
      invalidProviderState("Sheet cell boolValue is not a boolean");
    }
    return { kind: "boolean", value: record.boolValue };
  }
  if (record.numberValue !== undefined) {
    if (typeof record.numberValue !== "number" || !Number.isFinite(record.numberValue)) {
      invalidProviderState("Sheet cell numberValue is not a finite number");
    }
    if (isCanonicalDateNumberFormat(numberFormat)) {
      return { kind: "date", value: isoFromDateSerial(record.numberValue) };
    }
    return { kind: "number", value: record.numberValue };
  }
  // An empty value object (or an unknown value shape) is treated as blank;
  // the API omits empty cells, so a missing value is the common blank form.
  if (Object.keys(record).length === 0) return null;
  invalidProviderState("Sheet cell cannot be normalized");
}

/**
 * Normalizes a literal API cell for observation reads.
 *
 * Matches the Apps Script observation literal branch: explicit empty strings
 * and empty value objects become `null` (blank). Returns `undefined` for
 * shapes that are not a valid literal (formula/error/unknown) so the caller
 * can emit an `unsupported_cell_value` error cell instead of failing the
 * whole snapshot; type-invalid fields still fail closed.
 */
export function observationLiteralFromApiValue(
  value: unknown,
  numberFormat: unknown,
): NormalizedCell | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.stringValue !== undefined) {
    if (typeof record.stringValue !== "string") {
      invalidProviderState("Sheet cell stringValue is not a string");
    }
    return record.stringValue.length === 0
      ? null
      : { kind: "string", value: record.stringValue.normalize("NFC") };
  }
  if (record.boolValue !== undefined) {
    if (typeof record.boolValue !== "boolean") {
      invalidProviderState("Sheet cell boolValue is not a boolean");
    }
    return { kind: "boolean", value: record.boolValue };
  }
  if (record.numberValue !== undefined) {
    if (typeof record.numberValue !== "number" || !Number.isFinite(record.numberValue)) {
      invalidProviderState("Sheet cell numberValue is not a finite number");
    }
    if (isCanonicalDateNumberFormat(numberFormat)) {
      return { kind: "date", value: isoFromDateSerial(record.numberValue) };
    }
    return { kind: "number", value: record.numberValue };
  }
  if (Object.keys(record).length === 0) return null;
  // Formula, error, and unknown value shapes are handled by the caller.
  return undefined;
}

/**
 * getValues-equivalent normalization for one REST cell.
 *
 * Formula cells resolve to their computed effective value, error cells to
 * their formatted error string (the Apps Script fast-path limitation: a
 * "#REF!" error cell becomes a literal string), and literal cells to their
 * user-entered value. Blank cells — including explicit empty strings —
 * become `null`; unsupported shapes fail closed exactly like the Apps
 * Script table read throws.
 */
export function computedValueFromApiCell(
  value: unknown,
  numberFormat: unknown,
): NormalizedCell {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") {
    invalidProviderState("Sheet cell value is not an object");
  }
  const record = value as Record<string, unknown>;
  const entered = record.userEnteredValue;
  const enteredRecord = recordLike(entered);
  if (enteredRecord !== undefined && enteredRecord.formulaValue !== undefined) {
    if (typeof enteredRecord.formulaValue !== "string") {
      invalidProviderState("Sheet cell formulaValue is not a string");
    }
    const effective = record.effectiveValue;
    const effectiveRecord = recordLike(effective);
    if (effectiveRecord === undefined) {
      invalidProviderState("Sheet formula cell has no effective value");
    }
    if (effectiveRecord.errorValue !== undefined) {
      return {
        kind: "string",
        value: errorDisplayString(record, effectiveRecord),
      };
    }
    if (effectiveRecord.stringValue !== undefined) {
      if (typeof effectiveRecord.stringValue !== "string") {
        invalidProviderState("Sheet cell effective stringValue is not a string");
      }
      return { kind: "string", value: effectiveRecord.stringValue.normalize("NFC") };
    }
    if (effectiveRecord.boolValue !== undefined) {
      if (typeof effectiveRecord.boolValue !== "boolean") {
        invalidProviderState("Sheet cell effective boolValue is not a boolean");
      }
      return { kind: "boolean", value: effectiveRecord.boolValue };
    }
    if (effectiveRecord.numberValue !== undefined) {
      if (typeof effectiveRecord.numberValue !== "number" ||
          !Number.isFinite(effectiveRecord.numberValue)) {
        invalidProviderState("Sheet cell effective numberValue is not a finite number");
      }
      if (isCanonicalDateNumberFormat(numberFormat)) {
        return { kind: "date", value: isoFromDateSerial(effectiveRecord.numberValue) };
      }
      return { kind: "number", value: effectiveRecord.numberValue };
    }
    invalidProviderState("Sheet formula cell effective value is unsupported");
  }
  if (enteredRecord !== undefined && enteredRecord.errorValue !== undefined) {
    return { kind: "string", value: errorDisplayString(record, enteredRecord) };
  }
  const literal = observationLiteralFromApiValue(entered, numberFormat);
  if (literal === undefined) {
    invalidProviderState("Sheet cell value is unsupported");
  }
  return literal;
}

/**
 * Blank-row rule shared by the values-only read and observation paths.
 *
 * A cell is blank when it has no value at all; checkbox columns additionally
 * treat an unchecked (boolValue false) cell as blank, mirroring the Apps
 * Script `isBlankRow_` rule. Formula cells are blank only when their computed
 * value is an empty string (getValues semantics).
 */
export function isComputedBlankCell(value: unknown, checkboxColumn: boolean): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length === 0) return true;
  const entered = record.userEnteredValue;
  const enteredRecord = recordLike(entered);
  if (enteredRecord === undefined) {
    // Formatting-only or effective-only cells carry no user value.
    return true;
  }
  if (enteredRecord.formulaValue !== undefined) {
    const effective = record.effectiveValue;
    const effectiveRecord = recordLike(effective);
    if (effectiveRecord === undefined) return false;
    if (effectiveRecord.stringValue !== undefined) {
      if (typeof effectiveRecord.stringValue !== "string") {
        invalidProviderState("Sheet cell effective stringValue is not a string");
      }
      return effectiveRecord.stringValue.length === 0;
    }
    if (effectiveRecord.boolValue !== undefined) {
      if (typeof effectiveRecord.boolValue !== "boolean") {
        invalidProviderState("Sheet cell effective boolValue is not a boolean");
      }
      return checkboxColumn && effectiveRecord.boolValue === false;
    }
    return false;
  }
  if (enteredRecord.errorValue !== undefined) return false;
  if (enteredRecord.stringValue !== undefined) {
    if (typeof enteredRecord.stringValue !== "string") {
      invalidProviderState("Sheet cell stringValue is not a string");
    }
    return enteredRecord.stringValue.length === 0;
  }
  if (enteredRecord.numberValue !== undefined) {
    if (typeof enteredRecord.numberValue !== "number" ||
        !Number.isFinite(enteredRecord.numberValue)) {
      invalidProviderState("Sheet cell numberValue is not a finite number");
    }
    return false;
  }
  if (enteredRecord.boolValue !== undefined) {
    if (typeof enteredRecord.boolValue !== "boolean") {
      invalidProviderState("Sheet cell boolValue is not a boolean");
    }
    return checkboxColumn && enteredRecord.boolValue === false;
  }
  return Object.keys(enteredRecord).length === 0;
}

/** Returns `value` as a record when it is a plain object. */
function recordLike(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

/**
 * Resolves the display string of an error cell: the formatted value when
 * present ("#DIV/0!"), the error message otherwise, failing closed when an
 * error cell carries no display evidence at all.
 */
function errorDisplayString(
  cell: Record<string, unknown>,
  errorOwner: Record<string, unknown>,
): string {
  const formatted = cell.formattedValue;
  if (typeof formatted === "string" && formatted.length > 0) return formatted;
  const error = errorOwner.errorValue;
  const errorRecord = recordLike(error);
  const message = errorRecord?.message;
  if (typeof message === "string" && message.length > 0) return message;
  invalidProviderState("Sheet error cell has no display string");
}

/**
 * Converts a canonical normalized cell to the API userEnteredValue shape.
 *
 * Dates become their Excel serial number; the canonical number format is
 * applied separately by the batch builder so it can keep the format field
 * mask isolated from the value write.
 */
export function toApiUserEnteredValue(cell: NormalizedCell): {
  readonly userEnteredValue: {
    readonly stringValue?: string;
    readonly numberValue?: number;
    readonly boolValue?: boolean;
  };
} {
  if (cell === null) return { userEnteredValue: {} };
  switch (cell.kind) {
    case "string":
      return { userEnteredValue: { stringValue: cell.value } };
    case "number":
      return { userEnteredValue: { numberValue: cell.value } };
    case "boolean":
      return { userEnteredValue: { boolValue: cell.value } };
    case "date":
      return { userEnteredValue: { numberValue: dateSerialFromIso(cell.value) } };
  }
}

/**
 * Derives the visible business identity from a normalized cell, exactly like
 * the Apps Script `identityFromCell_`: non-empty strings and finite numbers.
 */
export function identityFromNormalizedCell(cell: NormalizedCell | null): string | null {
  if (cell === null) return null;
  if (typeof cell.value === "string") return cell.value.length === 0 ? null : cell.value;
  if (typeof cell.value === "number" && Number.isFinite(cell.value)) {
    return String(cell.value);
  }
  return null;
}

/** Returns whether an API cell is blank (missing value or empty object). */
export function isBlankApiCell(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 0 || record.userEnteredValue === undefined;
}
