/**
 * Registered header validation for the bulk preflight.
 *
 * The header row of the target tab must match the registered definition and
 * layout exactly: every cell a non-empty string, no duplicates, exact order
 * and width. Checkbox headers must be registered headers.
 */

import { invalidProviderState } from "../errors.js";
import { apiStringValue } from "./preflightParsing.js";
import { gridRowCells } from "./preflightRows.js";
import type { ParsedGridData } from "./preflightContext.js";

/**
 * Validates the header row against the registered definition and layout:
 * every cell must be a non-empty string, duplicates fail closed, and the
 * row must match the expected headers exactly.
 */
export function readRegisteredHeaders(
  data: ParsedGridData,
  range: { readonly startColumn: number; readonly columnCount: number },
  expectedHeaders: readonly string[],
): readonly string[] {
  const headerValues = gridRowCells(data, 1, range.startColumn, range.columnCount);
  const actual = headerValues.map((value, index) => {
    if (value === null) {
      invalidProviderState(`registered header is missing at column ${index + 1}`);
    }
    const raw = apiStringValue(value);
    if (typeof raw !== "string" || raw.trim() === "") {
      invalidProviderState(`registered header is invalid at column ${index + 1}`);
    }
    return raw;
  });
  if (new Set(actual).size !== actual.length) {
    invalidProviderState("registered headers contain a duplicate");
  }
  if (
    actual.length !== expectedHeaders.length ||
    actual.some((header, index) => header !== expectedHeaders[index])
  ) {
    invalidProviderState("registered headers do not match the projected schema");
  }
  return actual;
}

/** Returns the header cells of one grid as raw API values (no validation). */
export function gridHeaderCells(
  data: ParsedGridData,
  range: { readonly startColumn: number; readonly columnCount: number },
): readonly unknown[] {
  return gridRowCells(data, 1, range.startColumn, range.columnCount);
}

export function validateCheckboxHeaders(
  checkboxHeaders: readonly string[] | undefined,
  headers: readonly string[],
): readonly string[] {
  if (checkboxHeaders === undefined || checkboxHeaders.length === 0) return [];
  const headerSet = new Set(headers);
  for (const header of checkboxHeaders) {
    if (!headerSet.has(header)) {
      invalidProviderState(`checkbox header is not registered: ${header}`);
    }
  }
  return [...checkboxHeaders];
}
