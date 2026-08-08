/**
 * Registered header validation for the bulk preflight.
 *
 * The header row of the target tab must match the registered definition and
 * layout exactly: every cell a non-empty string, no duplicates, exact order
 * and width. Checkbox headers must be registered headers. user_input tabs
 * additionally carry the reserved `__hikoutei_row_id` system column as the
 * LAST header: a user property with that name fails closed, and a tab
 * provisioned without the system column (legacy format) fails closed with a
 * re-provision message instead of being silently read or repaired.
 */

import { GOOGLE_SHEETS_API_ROW_ID_HEADER } from "../constants.js";
import { invalidProviderState } from "../errors.js";
import { apiStringValue } from "./preflightParsing.js";
import { gridRowCells } from "./preflightRows.js";
import type { ParsedGridData } from "./preflightContext.js";

/** Message used when a user_input tab lacks the system row-id column. */
export const SYSTEM_COLUMN_REPROVISION_MESSAGE =
  `user input tab is missing the ${GOOGLE_SHEETS_API_ROW_ID_HEADER} system column; re-provision the route`;

/**
 * Validates the header row against the registered definition and layout:
 * every cell must be a non-empty string, duplicates fail closed, and the
 * row must match the expected headers exactly. When `systemColumnHeader` is
 * provided the LAST column of the range must carry exactly that header
 * (fail-closed on legacy tabs and on a user property named like the system
 * column).
 */
export function readRegisteredHeaders(
  data: ParsedGridData,
  range: { readonly startColumn: number; readonly columnCount: number },
  expectedHeaders: readonly string[],
  systemColumnHeader?: string,
): readonly string[] {
  if (
    systemColumnHeader !== undefined &&
    expectedHeaders.includes(systemColumnHeader)
  ) {
    invalidProviderState(
      `registered header ${systemColumnHeader} collides with the system row-id column`,
    );
  }
  const headerValues = gridRowCells(data, 1, range.startColumn, range.columnCount);
  const userFieldCount = expectedHeaders.length;
  const actual: string[] = [];
  for (let index = 0; index < headerValues.length; index += 1) {
    const isSystemPosition = systemColumnHeader !== undefined &&
      index === userFieldCount;
    const value = headerValues[index];
    if (value === null) {
      if (isSystemPosition) invalidProviderState(SYSTEM_COLUMN_REPROVISION_MESSAGE);
      invalidProviderState(`registered header is missing at column ${index + 1}`);
    }
    const raw = apiStringValue(value);
    if (typeof raw !== "string" || raw.trim() === "") {
      if (isSystemPosition) invalidProviderState(SYSTEM_COLUMN_REPROVISION_MESSAGE);
      invalidProviderState(`registered header is invalid at column ${index + 1}`);
    }
    actual.push(raw);
  }
  const userHeaders = actual.slice(0, userFieldCount);
  if (new Set(userHeaders).size !== userHeaders.length) {
    invalidProviderState("registered headers contain a duplicate");
  }
  const expectedCount = userFieldCount + (systemColumnHeader === undefined ? 0 : 1);
  if (
    actual.length !== expectedCount ||
    userHeaders.some((header, index) => header !== expectedHeaders[index])
  ) {
    invalidProviderState("registered headers do not match the projected schema");
  }
  if (systemColumnHeader !== undefined) {
    const systemHeader = actual[userFieldCount];
    if (systemHeader !== systemColumnHeader) {
      invalidProviderState(SYSTEM_COLUMN_REPROVISION_MESSAGE);
    }
  }
  return userHeaders;
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
