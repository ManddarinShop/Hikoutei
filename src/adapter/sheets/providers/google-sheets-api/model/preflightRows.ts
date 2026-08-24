/**
 * Preflight row normalization, indexes, and sheet/grid lookup.
 *
 * Nonblank target rows are normalized into typed `PreflightRow` values with
 * their anchor evidence and visible identity; the identity index fails closed
 * on duplicates while the anchor index keeps only the FIRST row per anchor
 * value (duplicated anchors are evidence, never rewritten), and both derive
 * the next append row. Sheet and grid lookup helpers resolve titles to
 * validated grids for the preflight data read and the observation/
 * provisioning readers.
 */

import type { NormalizedCell } from "../../../../../shared/encoding/types.js";
import type { Presence } from "../../../../../shared/state/index.js";
import { presentValue, absentValue } from "../../../../../shared/state/index.js";
import { SYNC_PROJECTIONS } from "../../../../../application/sync/sheetsContract/constants.js";
import {
  SYNC_INVALID_PROVIDER_OPERATIONS,
  missingTabClassification,
  type SyncMissingTabOperation,
} from "../../../../../application/sync/sheetsContract/errors.js";
import {
  GOOGLE_SHEETS_API_ROW_ID_HEADER,
} from "../constants.js";
import {
  invalidProviderState,
  GET_REPLY_MALFORMED,
} from "../errors.js";
import { apiStringValue, requireApiContainer } from "./preflightParsing.js";
import {
  identityFromNormalizedCell,
  isBlankApiCell,
  normalizedCellFromApiValue,
  parseRegisteredRange,
} from "./valueNormalization.js";
import type {
  ParsedCellNumberFormat,
  ParsedGridData,
  ParsedSheet,
  ParsedSpreadsheetDocument,
  PreflightRow,
} from "./preflightContext.js";

/**
 * Resolves a tab by title or fails closed when it is absent from an
 * enumeration. `operation` classifies the missing-tab invalid state so the
 * caller's step (preflight vs postcondition recovery) is reported; it
 * defaults to the preflight step.
 */
export function requireSheetByTitle(
  sheets: readonly ParsedSheet[],
  title: string,
  operation?: SyncMissingTabOperation,
): ParsedSheet {
  const sheet = findSheetByTitle(sheets, title);
  if (sheet === undefined) {
    invalidProviderState(
      `Registered sync sheet does not exist: ${title}`,
      missingTabClassification(operation ?? SYNC_INVALID_PROVIDER_OPERATIONS.PREFLIGHT),
    );
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
    invalidProviderState(`grid data is missing for sheet ${sheetId}`, GET_REPLY_MALFORMED);
  }
  return grid;
}

/** Normalizes nonblank grid rows into typed preflight rows. */
export function readRows(
  data: ParsedGridData,
  range: { readonly startColumn: number; readonly columnCount: number },
  headers: readonly string[],
  identityField: Presence<string>,
  anchorColumn: number | undefined,
): readonly PreflightRow[] {
  const anchorsByRow = readAnchorIndex(data, anchorColumn);
  const userFieldCount = anchorColumn === undefined
    ? range.columnCount
    : range.columnCount - 1;
  const rows: PreflightRow[] = [];
  for (let rowIndex = 0; rowIndex < data.rowData.length; rowIndex += 1) {
    const rowNumber = data.startRow + 1 + rowIndex;
    if (rowNumber < 2) continue;
    const rawRow = data.rowData[rowIndex];
    if (rawRow === undefined) continue;
    const values = gridRowCells(data, rowNumber, range.startColumn, range.columnCount);
    // The system row-id column is invisible to the blank-row rule: a row
    // whose user fields are all blank stays blank even when the anchor cell
    // still holds its UUID (same semantics as metadata anchors).
    if (values.slice(0, userFieldCount).every((value) => isBlankApiCell(value))) continue;

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
 * Builds the row -> anchor-list index from the system row-id column.
 *
 * The anchor is the LAST column cell value of the user_input registered
 * range: any non-empty string value counts as the row's anchor (the column
 * position is the identity proof; the `sync-anchor:` prefix is the format of
 * observation- and append-assigned anchors, but flush-derived anchors keep
 * the mapping's deterministic format such as `entity:<id>`). The header row
 * is skipped so the `__hikoutei_row_id` header cell never becomes a
 * pseudo-anchor. Blank cells, whitespace-only cells, empty strings, and
 * non-string values are not anchors and are treated as missing by the
 * caller. `anchorColumn` is 1-based; projections without a system column
 * pass `undefined` and yield no anchors.
 */
export function readAnchorIndex(
  data: ParsedGridData,
  anchorColumn: number | undefined,
): ReadonlyMap<number, readonly string[]> {
  const byRow = new Map<number, string[]>();
  if (anchorColumn === undefined) return byRow;
  for (let rowIndex = 0; rowIndex < data.rowData.length; rowIndex += 1) {
    const rowNumber = data.startRow + 1 + rowIndex;
    if (rowNumber < 2) continue;
    const [value] = gridRowCells(data, rowNumber, anchorColumn, 1);
    const anchor = anchorFromColumnValue(value);
    if (anchor !== undefined) byRow.set(rowNumber, [anchor]);
  }
  return byRow;
}

/** Extracts one anchor value from a system-column cell, if any. */
function anchorFromColumnValue(value: unknown): string | undefined {
  const raw = apiStringValue(value);
  // Whitespace-only cells count as missing (re-anchored), mirroring the
  // header validation's trim rule for the system column.
  if (raw === undefined || raw.trim().length === 0) return undefined;
  return raw;
}

/**
 * Returns the 1-based system row-id column of one registered range, or
 * `undefined` for projections without a system column (only user_input tabs
 * carry one, always as the LAST column of the registered range).
 */
export function anchorColumnFor(
  registeredRange: string,
  projection: string,
): number | undefined {
  if (projection !== SYNC_PROJECTIONS.USER_INPUT) return undefined;
  const range = parseRegisteredRange(registeredRange);
  return range.startColumn + range.columnCount - 1;
}

export function indexRows(
  rows: readonly PreflightRow[],
): {
  readonly byAnchor: ReadonlyMap<string, PreflightRow>;
  readonly byIdentity: ReadonlyMap<string, PreflightRow>;
  readonly nextAppendRow: number;
} {
  const byAnchor = new Map<string, PreflightRow>();
  const byIdentity = new Map<string, PreflightRow>();
  for (const row of rows) {
    if (row.physicalAnchor.kind === "present") {
      // Duplicated anchors are evidence, never rewritten: a human copy-paste
      // copies the UUID cell, so only the FIRST row carrying each anchor
      // value enters the index and later rows fall back to identity/targetId
      // lookup in findWorkingRow. The duplicate itself is still reported by
      // the observation/anchor-ensure evidence path.
      if (!byAnchor.has(row.physicalAnchor.value)) {
        byAnchor.set(row.physicalAnchor.value, row);
      }
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
  // The API omits trailing empty rows from grid data, so the last nonblank
  // row is the sheet's last content row; appends start one row below it
  // (min row 2, matching the Apps Script nextAppendRow = max(lastRow + 1, 2)).
  // Computed from the normalized rows (not grid rowData) so a row whose only
  // remaining content is the system anchor cell does not extend the append
  // position, exactly like the metadata-anchor era.
  const lastRow = rows.length === 0 ? undefined : rows[rows.length - 1]?.rowNumber;
  const lastContentRow = lastRow === undefined ? 0 : lastRow;
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
  // Validate BOTH present format containers and BOTH present nested
  // numberFormat containers up front so a malformed lower-priority effective
  // format/numberFormat can never be hidden by a valid entered format.
  const entered = requireApiContainer(cell.userEnteredFormat, "cell userEnteredFormat must be an object");
  const effective = requireApiContainer(cell.effectiveFormat, "cell effectiveFormat must be an object");
  const enteredFormat = entered === undefined
    ? undefined
    : parseCellNumberFormat(entered.numberFormat);
  const effectiveFormat = effective === undefined
    ? undefined
    : parseCellNumberFormat(effective.numberFormat);
  if (enteredFormat !== undefined) return enteredFormat;
  return effectiveFormat;
}

/** Validates one SDK `numberFormat` object (type plus optional pattern). */
function parseCellNumberFormat(value: unknown): ParsedCellNumberFormat | undefined {
  // An omitted numberFormat is legitimate; a present null/primitive wrapper is
  // malformed and must fail closed instead of silently becoming absent.
  if (value === undefined) return undefined;
  const record = requireApiContainer(value, "cell numberFormat must be an object")!;
  const type = record.type;
  if (typeof type !== "string" || type.length === 0) {
    invalidProviderState("cell numberFormat.type is invalid", GET_REPLY_MALFORMED);
  }
  const pattern = record.pattern;
  if (pattern !== undefined && typeof pattern !== "string") {
    invalidProviderState("cell numberFormat.pattern is invalid", GET_REPLY_MALFORMED);
  }
  return { type, pattern };
}
