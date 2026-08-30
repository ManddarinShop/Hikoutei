/**
 * Preflight context types and context assembly for the bulk preflight.
 *
 * A preflight is a sheet enumeration call plus one bounded data read of the
 * target tab and receipt tab; `readPreflightData` keeps that two-call
 * sequence for callers that already enumerated the tabs (the pacing callers
 * dispatch each transport request individually). Every untrusted SDK payload
 * is validated with runtime guards (in `preflightParsing`) and promoted into
 * the typed context the planner can mutate.
 */

import type { NormalizedCell } from "@hikoutei/contracts/encoding/types.js";
import type { Presence } from "@hikoutei/contracts/state/index.js";
import { presentValue, absentValue } from "@hikoutei/contracts/state/index.js";
import {
  GOOGLE_SHEETS_API_RECEIPT_HEADERS,
  GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME,
  GOOGLE_SHEETS_API_ROW_ID_HEADER,
} from "../constants.js";
import {
  GOOGLE_SHEETS_API_ENUMERATION_FIELDS,
  GOOGLE_SHEETS_API_PREFLIGHT_FIELDS,
} from "./preflightFields.js";
import { invalidProviderState } from "../errors.js";
import type {
  SyncMissingTabOperation,
} from "@hikoutei/contracts/sheets/errors.js";
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
  anchorColumnFor,
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
  /**
   * 1-based absolute column of the User_Input system row-id column; undefined
   * for projections without one (system_state, sync_conflicts).
   */
  readonly anchorColumn: number | undefined;
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
  /** §12 columnMap: adopted-route physical headers (see the definition type). */
  readonly physicalHeaders?: readonly string[];
  readonly identityField: Presence<string>;
  readonly checkboxHeaders: readonly string[];
  /** Registered projection kind; user_input routes carry the system row-id column. */
  readonly projection: string;
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
}

export interface ParsedRowData {
  readonly values: readonly unknown[];
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

/**
 * Builds the preflight ranges for one or more routes, deduplicating target
 * tabs and adding the shared receipt tab once. The multi-route call reads
 * ALL needed tabs in a single ranged `getSpreadsheet`, so the enumerations
 * and ranged reads are shared across the routes of one spreadsheet.
 */
export function buildPreflightRanges(
  routes: readonly PreflightRouteOptions[],
  receiptSheet: ParsedSheet | undefined,
): readonly string[] {
  const seen = new Set<string>();
  const ranges: string[] = [];
  for (const route of routes) {
    const parsedRange = parseRegisteredRange(route.registeredRange);
    const endColumnLetters = columnLetters(
      parsedRange.startColumn + parsedRange.columnCount - 1,
    );
    const target = `${quoteA1SheetName(route.sheetName)}!A1:${endColumnLetters}1048576`;
    if (seen.has(target)) continue;
    seen.add(target);
    ranges.push(target);
  }
  if (receiptSheet !== undefined) {
    ranges.push(
      `${quoteA1SheetName(GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME)}!A1:F1048576`,
    );
  }
  return ranges;
}

/** Builds one preflight context for a single route from an enumerated doc. */
export async function readPreflightData(
  transport: GoogleSheetsApiTransport,
  route: PreflightRouteOptions,
  sheets: readonly ParsedSheet[],
  timeoutMs?: number,
): Promise<PreflightContext> {
  const targetSheet = requireSheetByTitle(sheets, route.sheetName);
  const receiptSheet = findSheetByTitle(sheets, GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME);
  const dataRequest: GoogleSheetsApiGetSpreadsheetRequest = {
    spreadsheetId: route.spreadsheetId,
    ranges: buildPreflightRanges([route], receiptSheet),
    fields: GOOGLE_SHEETS_API_PREFLIGHT_FIELDS,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
  const dataRaw = await transport.getSpreadsheet(dataRequest);
  const dataDocument = parseSpreadsheetDocument(dataRaw, "grid data");
  return buildRouteContext(dataDocument, sheets, route);
}

/**
 * Reads one ranged getSpreadsheet across ALL needed tabs and builds a
 * PreflightContext for each route (keyed by its sheetName), sharing the
 * read across the routes of one spreadsheet. `operation` classifies an
 * invalid provider state (e.g. a missing tab) detected while building a
 * route context.
 */
export async function readPreflightDataForRoutes(
  transport: GoogleSheetsApiTransport,
  routes: readonly PreflightRouteOptions[],
  sheets: readonly ParsedSheet[],
  timeoutMs?: number,
  operation?: SyncMissingTabOperation,
): Promise<ReadonlyMap<string, PreflightContext>> {
  const receiptSheet = findSheetByTitle(sheets, GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME);
  const dataRequest: GoogleSheetsApiGetSpreadsheetRequest = {
    spreadsheetId: routes[0]?.spreadsheetId ?? "",
    ranges: buildPreflightRanges(routes, receiptSheet),
    fields: GOOGLE_SHEETS_API_PREFLIGHT_FIELDS,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
  const dataRaw = await transport.getSpreadsheet(dataRequest);
  const dataDocument = parseSpreadsheetDocument(dataRaw, "grid data");
  const contexts = new Map<string, PreflightContext>();
  for (const route of routes) {
    contexts.set(route.sheetName, buildRouteContext(dataDocument, sheets, route, operation));
  }
  return contexts;
}

/** Builds one route's preflight context from an already-fetched document. */
export function buildRouteContext(
  dataDocument: ParsedSpreadsheetDocument,
  sheets: readonly ParsedSheet[],
  route: PreflightRouteOptions,
  operation?: SyncMissingTabOperation,
): PreflightContext {
  const targetSheet = requireSheetByTitle(sheets, route.sheetName, operation);
  const receiptSheet = findSheetByTitle(sheets, GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME);
  const parsedRange = parseRegisteredRange(route.registeredRange);
  const targetData = requireGridDataForSheet(dataDocument, targetSheet.sheetId);
  const anchorColumn = anchorColumnFor(route.registeredRange, route.projection);
  const headers = readRegisteredHeaders(
    targetData,
    parsedRange,
    route.headers,
    anchorColumn === undefined ? undefined : GOOGLE_SHEETS_API_ROW_ID_HEADER,
    route.physicalHeaders,
  );
  const positions = new Map<string, number>();
  headers.forEach((header, index) => positions.set(header, index));

  const identityField = route.identityField;
  const rows = readRows(targetData, parsedRange, headers, identityField, anchorColumn);
  const { byAnchor, byIdentity, nextAppendRow } = indexRows(rows);

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
    anchorColumn,
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
