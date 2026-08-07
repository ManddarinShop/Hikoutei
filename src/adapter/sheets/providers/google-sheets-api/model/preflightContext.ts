/**
 * Preflight context types and context assembly for the bulk preflight.
 *
 * A preflight is a sheet enumeration call plus one bounded data read of the
 * target tab and receipt tab; the composite functions here keep that
 * two-call sequence for non-pacing callers. Every untrusted SDK payload is
 * validated with runtime guards (in `preflightParsing`) and promoted into
 * the typed context the planner can mutate.
 */

import type { NormalizedCell } from "../../../../../domain/index.js";
import type { Presence } from "../../../../../shared/state/index.js";
import { presentValue, absentValue } from "../../../../../shared/state/index.js";
import {
  GOOGLE_SHEETS_API_RECEIPT_HEADERS,
  GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME,
} from "../constants.js";
import {
  GOOGLE_SHEETS_API_ENUMERATION_FIELDS,
  GOOGLE_SHEETS_API_PREFLIGHT_FIELDS,
} from "./preflightFields.js";
import { invalidProviderState } from "../errors.js";
import type {
  GoogleSheetsApiTransport,
  GoogleSheetsApiGetSpreadsheetRequest,
} from "../transport/googleSheetsApiTransport.js";
import {
  columnLetters,
  parseRegisteredRange,
  quoteA1SheetName,
} from "./valueNormalization.js";
import {
  apiNumberValue,
  apiStringValue,
  parseSheetPropertiesDocument,
  parseSpreadsheetDocument,
} from "./preflightParsing.js";
import {
  findSheetByTitle,
  gridRowCells,
  indexRows,
  readRows,
  requireGridDataForSheet,
  requireSheetByTitle,
} from "./preflightRows.js";
import {
  readRegisteredHeaders,
  validateCheckboxHeaders,
} from "./preflightHeaders.js";

/** One validated merged-cell region (a GridRange) from a sheet payload. */
export interface ParsedMergedCell {
  readonly sheetId?: number;
  readonly startRowIndex: number;
  readonly endRowIndex: number;
  readonly startColumnIndex: number;
  readonly endColumnIndex: number;
}

/** One validated receipt row read from the hidden receipt tab. */
export interface PreflightReceipt {
  readonly effectId: string;
  readonly payloadHash: string;
  readonly status: "applied";
  readonly visibleHash: string;
  readonly visibleRevision: number;
}

/** One nonblank target row normalized from the grid read. */
export interface PreflightRow {
  readonly rowNumber: number;
  readonly physicalAnchor: Presence<string>;
  readonly cells: Readonly<Record<string, NormalizedCell>>;
  readonly identity: Presence<string>;
}

/** Typed preflight context consumed by the planner and batch builder. */
export interface PreflightContext {
  readonly sheetId: number;
  readonly title: string;
  /** 1-based absolute start column of the registered range in the grid. */
  readonly startColumn: number;
  readonly headers: readonly string[];
  /** header -> 0-based column offset inside the registered range. */
  readonly positions: ReadonlyMap<string, number>;
  readonly rows: readonly PreflightRow[];
  readonly byAnchor: ReadonlyMap<string, PreflightRow>;
  readonly byIdentity: ReadonlyMap<string, PreflightRow>;
  /** First free row (1-based) for appends: max(lastContentRow + 1, 2). */
  readonly nextAppendRow: number;
  readonly identityField: Presence<string>;
  readonly checkboxHeaders: readonly string[];
  readonly receiptSheetId: Presence<number>;
  /** Receipt tab last content row; 0 when the tab is absent. */
  readonly receiptLastRow: number;
  readonly receipts: ReadonlyMap<string, PreflightReceipt>;
  /** Sheet ids of every tab seen by the enumeration (id allocator input). */
  readonly existingSheetIds: readonly number[];
}

/** Route-level inputs every preflight needs from the registered definition. */
export interface PreflightRouteOptions {
  readonly spreadsheetId: string;
  readonly sheetName: string;
  readonly registeredRange: string;
  readonly headers: readonly string[];
  readonly identityField: Presence<string>;
  readonly checkboxHeaders: readonly string[];
}

export interface ParsedSheet {
  readonly sheetId: number;
  readonly title: string;
  readonly hidden: boolean;
  /** Grid dimensions when the requesting mask included gridProperties. */
  readonly gridProperties?: {
    readonly rowCount: number;
    readonly columnCount: number;
  };
  /** Merged ranges when the requesting mask included sheets.merges. */
  readonly merges?: readonly ParsedMergedCell[];
}

export interface ParsedGridData {
  readonly startRow: number;
  readonly startColumn: number;
  readonly rowData: readonly ParsedRowData[];
  readonly rowMetadata: readonly ParsedRowMetadata[];
}

export interface ParsedRowData {
  readonly values: readonly unknown[];
}

export interface ParsedRowMetadata {
  readonly developerMetadata: readonly {
    readonly metadataKey: string;
    readonly metadataValue: string;
  }[];
}

/** One validated REST `CellFormat.numberFormat` object from an SDK cell. */
export interface ParsedCellNumberFormat {
  readonly type: string;
  readonly pattern: string | undefined;
}

/** One validated `spreadsheets.get` body: sheet entries plus grid data. */
export interface ParsedSpreadsheetDocument {
  readonly sheets: readonly ParsedSheet[];
  readonly grids: ReadonlyMap<number, ParsedGridData>;
}

/**
 * Enumerates every tab of the spreadsheet (no ranges, so hidden tabs are
 * returned). The enumeration supplies the sheetIds the data call's grid
 * data is keyed by and the receipt tab's presence.
 */
export async function enumerateSheetProperties(
  transport: GoogleSheetsApiTransport,
  spreadsheetId: string,
  timeoutMs?: number,
): Promise<readonly ParsedSheet[]> {
  const enumerationRequest: GoogleSheetsApiGetSpreadsheetRequest = {
    spreadsheetId,
    ranges: [],
    fields: GOOGLE_SHEETS_API_ENUMERATION_FIELDS,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
  const enumerationRaw = await transport.getSpreadsheet(enumerationRequest);
  return parseSheetPropertiesDocument(enumerationRaw, "sheet enumeration");
}

/** Reads and validates the target and receipt tabs for one route. */
export async function readPreflightContext(
  transport: GoogleSheetsApiTransport,
  route: PreflightRouteOptions,
  timeoutMs?: number,
): Promise<PreflightContext> {
  const sheets = await enumerateSheetProperties(transport, route.spreadsheetId, timeoutMs);
  return readPreflightData(transport, route, sheets, timeoutMs);
}

/**
 * Reads the bounded target/receipt grid data for one route, given the sheet
 * enumeration. The target range starts at A1 and extends to the registered
 * range's end column (whole-column ranges can legitimately exceed ZZ),
 * keeping the 1,048,576-row limit of the grid.
 */
export async function readPreflightData(
  transport: GoogleSheetsApiTransport,
  route: PreflightRouteOptions,
  sheets: readonly ParsedSheet[],
  timeoutMs?: number,
): Promise<PreflightContext> {
  const targetSheet = requireSheetByTitle(sheets, route.sheetName);
  const receiptSheet = findSheetByTitle(sheets, GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME);
  // Call 2: the bounded data read, covering exactly the tabs that exist.
  // The target range starts at A1 and extends to the registered range's end
  // column (whole-column ranges can legitimately exceed ZZ), keeping the
  // 1,048,576-row limit of the grid. The receipt range is requested only
  // when the enumeration found the receipt tab.
  const parsedRange = parseRegisteredRange(route.registeredRange);
  const endColumnLetters = columnLetters(
    parsedRange.startColumn + parsedRange.columnCount - 1,
  );
  const ranges = [
    `${quoteA1SheetName(route.sheetName)}!A1:${endColumnLetters}1048576`,
  ];
  if (receiptSheet !== undefined) {
    ranges.push(
      `${quoteA1SheetName(GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME)}!A1:F1048576`,
    );
  }
  const dataRequest: GoogleSheetsApiGetSpreadsheetRequest = {
    spreadsheetId: route.spreadsheetId,
    ranges,
    fields: GOOGLE_SHEETS_API_PREFLIGHT_FIELDS,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
  const dataRaw = await transport.getSpreadsheet(dataRequest);
  const dataDocument = parseSpreadsheetDocument(dataRaw, "grid data");
  const targetData = requireGridDataForSheet(dataDocument, targetSheet.sheetId);

  const headers = readRegisteredHeaders(targetData, parsedRange, route.headers);
  const positions = new Map<string, number>();
  headers.forEach((header, index) => positions.set(header, index));

  const identityField = route.identityField;
  const rows = readRows(targetData, parsedRange, headers, identityField);
  const { byAnchor, byIdentity, nextAppendRow } = indexRows(rows, targetData);

  const checkboxHeaders = validateCheckboxHeaders(route.checkboxHeaders, headers);

  let receipts: ReadonlyMap<string, PreflightReceipt> = new Map<string, PreflightReceipt>();
  let receiptLastRow = 0;
  let receiptSheetId: Presence<number> = absentValue();
  if (receiptSheet !== undefined) {
    receiptSheetId = presentValue(receiptSheet.sheetId);
    const receiptData = requireGridDataForSheet(dataDocument, receiptSheet.sheetId);
    const parsedReceipts = readReceipts(receiptData);
    receipts = parsedReceipts.receipts;
    receiptLastRow = parsedReceipts.lastRow;
  }

  return {
    sheetId: targetSheet.sheetId,
    title: targetSheet.title,
    startColumn: parsedRange.startColumn,
    headers,
    positions,
    rows,
    byAnchor,
    byIdentity,
    nextAppendRow,
    identityField,
    checkboxHeaders,
    receiptSheetId,
    receiptLastRow,
    receipts,
    existingSheetIds: sheets.map((sheet) => sheet.sheetId),
  };
}

// ---------------------------------------------------------------------------
// Receipt parsing
// ---------------------------------------------------------------------------

/** Parses and validates the hidden receipt tab grid. */
export function readReceipts(data: ParsedGridData): {
  readonly receipts: ReadonlyMap<string, PreflightReceipt>;
  readonly lastRow: number;
} {
  const headerValues = gridRowCells(data, 1, 1, GOOGLE_SHEETS_API_RECEIPT_HEADERS.length);
  const actualHeaders = headerValues.map((value) => {
    if (value === null) return "";
    const raw = apiStringValue(value);
    return typeof raw === "string" ? raw : "";
  });
  if (
    actualHeaders.length !== GOOGLE_SHEETS_API_RECEIPT_HEADERS.length ||
    actualHeaders.some(
      (header, index) => header !== GOOGLE_SHEETS_API_RECEIPT_HEADERS[index],
    )
  ) {
    invalidProviderState("receipt sheet headers do not match");
  }

  const receipts = new Map<string, PreflightReceipt>();
  let lastRow = Math.max(1, data.startRow + data.rowData.length);
  for (let rowIndex = 1; rowIndex < data.rowData.length; rowIndex += 1) {
    const rawRow = data.rowData[rowIndex];
    if (rawRow === undefined) continue;
    const values = gridRowCells(data, data.startRow + 1 + rowIndex, 1, GOOGLE_SHEETS_API_RECEIPT_HEADERS.length);
    const first = stringCellValue(values[0]);
    if (first === null) continue;
    const effectId = first;
    const payloadHash = stringCellValue(values[1]);
    const status = stringCellValue(values[2]);
    const visibleHash = stringCellValue(values[3]);
    const visibleRevision = numberCellValue(values[4]);
    if (payloadHash === null || visibleHash === null || status !== "applied" ||
        visibleRevision === null || !Number.isSafeInteger(visibleRevision) ||
        visibleRevision < 0) {
      invalidProviderState(`receipt sheet contains an invalid receipt for effectId: ${effectId}`);
    }
    if (receipts.has(effectId)) {
      invalidProviderState(`receipt sheet contains duplicate effectId: ${effectId}`);
    }
    receipts.set(effectId, {
      effectId,
      payloadHash,
      status,
      visibleHash,
      visibleRevision,
    });
  }
  return { receipts, lastRow };
}

function stringCellValue(value: unknown): string | null {
  const raw = apiStringValue(value);
  return raw === undefined ? null : raw;
}

function numberCellValue(value: unknown): number | null {
  const raw = apiNumberValue(value);
  return raw === undefined ? null : raw;
}
