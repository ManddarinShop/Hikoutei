/**
 * Preflight row normalization, indexes, and sheet/grid lookup.
 *
 * Nonblank target rows are normalized into typed `PreflightRow` values with
 * their anchor evidence and visible identity; the anchor/identity indexes
 * fail closed on duplicates and derive the next append row. Sheet and grid
 * lookup helpers resolve titles to validated grids for the preflight data
 * read and the observation/provisioning readers.
 */

import type { NormalizedCell } from "../../../../../domain/index.js";
import type { Presence } from "../../../../../shared/state/index.js";
import { presentValue, absentValue } from "../../../../../shared/state/index.js";
import { GOOGLE_SHEETS_API_ANCHOR_KEY } from "../constants.js";
import { invalidProviderState } from "../errors.js";
import {
  identityFromNormalizedCell,
  isBlankApiCell,
  normalizedCellFromApiValue,
} from "./valueNormalization.js";
import type {
  ParsedCellNumberFormat,
  ParsedGridData,
  ParsedSheet,
  ParsedSpreadsheetDocument,
  PreflightRow,
} from "./preflightContext.js";

export function requireSheetByTitle(sheets: readonly ParsedSheet[], title: string): ParsedSheet {
  const sheet = findSheetByTitle(sheets, title);
  if (sheet === undefined) {
    invalidProviderState(`Registered sync sheet does not exist: ${title}`);
  }
  return sheet;
}

export function findSheetByTitle(
  sheets: readonly ParsedSheet[],
  title: string,
): ParsedSheet | undefined {
  return sheets.find((sheet) => sheet.title === title);
}

export function requireGridDataForSheet(
  document: ParsedSpreadsheetDocument,
  sheetId: number,
): ParsedGridData {
  const grid = document.grids.get(sheetId);
  if (grid === undefined) {
    invalidProviderState(`grid data is missing for sheet ${sheetId}`);
  }
  return grid;
}

/** Returns the parsed grid for one sheet by title, failing closed when absent. */
export function requireGridDataByTitle(
  document: ParsedSpreadsheetDocument,
  sheets: readonly ParsedSheet[],
  title: string,
): { readonly sheet: ParsedSheet; readonly grid: ParsedGridData } {
  const sheet = findSheetByTitle(sheets, title);
  if (sheet === undefined) {
    invalidProviderState(`Registered sync sheet does not exist: ${title}`);
  }
  const grid = document.grids.get(sheet.sheetId);
  if (grid === undefined) {
    invalidProviderState(`grid data is missing for sheet ${sheet.sheetId}`);
  }
  return { sheet, grid };
}

/** Normalizes nonblank grid rows into typed preflight rows. */
export function readRows(
  data: ParsedGridData,
  range: { readonly startColumn: number; readonly columnCount: number },
  headers: readonly string[],
  identityField: Presence<string>,
): readonly PreflightRow[] {
  const anchorsByRow = readAnchorIndex(data);  const rows: PreflightRow[] = [];
  for (let rowIndex = 0; rowIndex < data.rowData.length; rowIndex += 1) {
    const rowNumber = data.startRow + 1 + rowIndex;
    if (rowNumber < 2) continue;
    const rawRow = data.rowData[rowIndex];
    if (rawRow === undefined) continue;
    const values = gridRowCells(data, rowNumber, range.startColumn, range.columnCount);
    if (values.every((value) => isBlankApiCell(value))) continue;

    const cells: Record<string, NormalizedCell> = {};
    headers.forEach((header, columnIndex) => {
      const value = values[columnIndex];
      const numberFormat = apiCellNumberFormat(value);
      cells[header] = normalizedCellFromApiValue(
        value === null || value === undefined
          ? undefined
          : (value as Record<string, unknown>).userEnteredValue,
        numberFormat,
      );
    });

    const anchors = anchorsByRow.get(rowNumber);
    if (anchors !== undefined && anchors.length > 1) {
      invalidProviderState(`row has multiple sync anchors: ${rowNumber}`);
    }
    const firstAnchor = anchors === undefined || anchors.length === 0
      ? undefined
      : (anchors[0] ?? undefined);
    const physicalAnchor: Presence<string> = firstAnchor === undefined
      ? absentValue()
      : presentValue(firstAnchor);

    let identity: Presence<string> = absentValue();
    if (identityField.kind === "present") {
      const identityCell = cells[identityField.value];
      const value = identityFromNormalizedCell(identityCell ?? null);
      if (value !== null) identity = presentValue(value);
    }

    rows.push({ rowNumber, physicalAnchor, cells, identity });
  }
  return rows;
}

/**
 * Builds the row -> anchor-list index from one grid's row metadata.
 *
 * Row metadata is index-aligned with rowData; only the shared anchor key
 * counts, and a row may legitimately carry several metadata entries (the
 * caller decides whether multiple anchors are an error).
 */
export function readAnchorIndex(data: ParsedGridData): ReadonlyMap<number, readonly string[]> {
  const byRow = new Map<number, string[]>();
  data.rowMetadata.forEach((metadata, index) => {
    const rowNumber = data.startRow + 1 + index;
    const anchors = metadata.developerMetadata
      .filter((item) => item.metadataKey === GOOGLE_SHEETS_API_ANCHOR_KEY)
      .map((item) => item.metadataValue);
    if (anchors.length > 0) byRow.set(rowNumber, anchors);
  });
  return byRow;
}

export function indexRows(
  rows: readonly PreflightRow[],
  data: ParsedGridData,
): {
  readonly byAnchor: ReadonlyMap<string, PreflightRow>;
  readonly byIdentity: ReadonlyMap<string, PreflightRow>;
  readonly nextAppendRow: number;
} {
  const byAnchor = new Map<string, PreflightRow>();
  const byIdentity = new Map<string, PreflightRow>();
  for (const row of rows) {
    if (row.physicalAnchor.kind === "present") {
      const existing = byAnchor.get(row.physicalAnchor.value);
      if (existing !== undefined) {
        invalidProviderState(
          `sync anchor is duplicated: ${row.physicalAnchor.value} at rows ${existing.rowNumber} and ${row.rowNumber}`,
        );
      }
      byAnchor.set(row.physicalAnchor.value, row);
    }
    if (row.identity.kind === "present") {
      const existing = byIdentity.get(row.identity.value);
      if (existing !== undefined) {
        invalidProviderState(
          `sync identity is duplicated: ${row.identity.value} at rows ${existing.rowNumber} and ${row.rowNumber}`,
        );
      }
      byIdentity.set(row.identity.value, row);
    }
  }
  // The API omits trailing empty rows from grid data, so the last data row is
  // the sheet's last content row; appends start one row below it (min row 2,
  // matching the Apps Script nextAppendRow = max(lastRow + 1, 2)).
  const lastContentRow = data.startRow + data.rowData.length;
  return {
    byAnchor,
    byIdentity,
    nextAppendRow: Math.max(lastContentRow + 1, 2),
  };
}

/**
 * Reads the visible cells of one 1-based row over the registered range.
 *
 * `null` entries mark blank cells, matching the sparse values arrays the API
 * returns (a row's values array may be narrower than the requested range).
 */
export function gridRowCells(
  data: ParsedGridData,
  rowNumber: number,
  startColumn: number,
  columnCount: number,
): readonly unknown[] {
  const rowIndex = rowNumber - data.startRow - 1;
  const rawRow = data.rowData[rowIndex];
  if (rawRow === undefined) {
    return Array.from({ length: columnCount }, () => null);
  }
  const values = rawRow.values;
  const cells: unknown[] = [];
  for (let offset = 0; offset < columnCount; offset += 1) {
    const column = startColumn - 1 + offset - data.startColumn;
    const value = values[column];
    cells.push(value === undefined ? null : value);
  }
  return cells;
}

/**
 * Extracts the number format of one API cell, if any.
 *
 * The REST API models `CellFormat.numberFormat` as a `{ type, pattern }`
 * object, never a bare string; the user-entered format wins over the
 * effective format when both are present.
 */
export function apiCellNumberFormat(value: unknown): ParsedCellNumberFormat | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const cell = value as Record<string, unknown>;
  const entered = cell.userEnteredFormat;
  if (entered !== null && typeof entered === "object") {
    const format = parseCellNumberFormat(
      (entered as Record<string, unknown>).numberFormat,
    );
    if (format !== undefined) return format;
  }
  const effective = cell.effectiveFormat;
  if (effective !== null && typeof effective === "object") {
    const format = parseCellNumberFormat(
      (effective as Record<string, unknown>).numberFormat,
    );
    if (format !== undefined) return format;
  }
  return undefined;
}

/** Validates one SDK `numberFormat` object (type plus optional pattern). */
function parseCellNumberFormat(value: unknown): ParsedCellNumberFormat | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    invalidProviderState("cell numberFormat must be an object");
  }
  const record = value as Record<string, unknown>;
  const type = record.type;
  if (typeof type !== "string" || type.length === 0) {
    invalidProviderState("cell numberFormat.type is invalid");
  }
  const pattern = record.pattern;
  if (pattern !== undefined && typeof pattern !== "string") {
    invalidProviderState("cell numberFormat.pattern is invalid");
  }
  return { type, pattern };
}
