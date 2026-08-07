/**
 * Values-only table reads (getValues semantics).
 *
 * These helpers port the Apps Script table-read operation to the REST wire
 * shapes: formula cells resolve to their computed effective value, error
 * cells to their formatted error string (the known fast-path limitation the
 * safety scan exists for), strings are NFC-normalized, dates are detected
 * through the canonical number format, and blank rows are skipped with the
 * checkbox rule. Unsupported cell shapes fail closed, exactly like the Apps
 * Script source throws.
 */

import type { NormalizedCell } from "../../../../../domain/index.js";
import type { SyncTableRow } from "../../../../../application/sync/sheetsContract/syncSheets.js";
import { invalidProviderState } from "../errors.js";
import {
  apiCellNumberFormat,
  gridRowCells,
  readRegisteredHeaders,
  type ParsedGridData,
} from "./preflight.js";
import {
  computedValueFromApiCell,
  isComputedBlankCell,
  parseRegisteredRange,
} from "./valueNormalization.js";

/** One values-only read target with its registered schema. */
export interface TableReadTarget {
  readonly registeredRange: string;
  readonly headers: readonly string[];
  readonly checkboxHeaders: readonly string[];
}

/**
 * Builds the nonblank rows of one validated grid as normalized table rows.
 * Header validation is strict (exact match, non-empty, no duplicates) and
 * blank rows are skipped with the checkbox-false rule.
 */
export function buildTableRowsFromGrid(
  grid: ParsedGridData,
  target: TableReadTarget,
): readonly SyncTableRow[] {
  const range = parseRegisteredRange(target.registeredRange);
  const headers = readRegisteredHeaders(grid, range, target.headers);
  const checkboxIndexes = checkboxColumnIndexes(headers, target.checkboxHeaders);
  const rows: SyncTableRow[] = [];
  for (let rowIndex = 0; rowIndex < grid.rowData.length; rowIndex += 1) {
    const rowNumber = grid.startRow + 1 + rowIndex;
    if (rowNumber < 2) continue;
    const values = gridRowCells(grid, rowNumber, range.startColumn, range.columnCount);
    if (values.every((value, index) =>
      isComputedBlankCell(value, checkboxIndexes.has(index)))) {
      continue;
    }
    const fields: Record<string, NormalizedCell> = {};
    headers.forEach((header, columnIndex) => {
      const value = values[columnIndex];
      fields[header] = computedValueFromApiCell(
        value,
        apiCellNumberFormat(value),
      );
    });
    rows.push({ rowNumber, fields });
  }
  return rows;
}

/** Returns the checkbox column offsets (0-based inside the range) by header. */
function checkboxColumnIndexes(
  headers: readonly string[],
  checkboxHeaders: readonly string[] | undefined,
): ReadonlySet<number> {
  if (checkboxHeaders === undefined || checkboxHeaders.length === 0) {
    return new Set<number>();
  }
  const indexes = new Set<number>();
  for (const header of checkboxHeaders) {
    const index = headers.indexOf(header);
    if (index < 0) {
      invalidProviderState(`checkbox header is not registered: ${header}`);
    }
    indexes.add(index);
  }
  return indexes;
}
