/**
 * Bulk preflight: a sheet enumeration call plus one bounded data read of the
 * target tab and receipt tab.
 *
 * The provider first enumerates every tab (no ranges, so hidden sheets are
 * returned), then reads the target grid (values, date formats, row-level
 * developer-metadata anchors) and the hidden receipt tab through the narrow
 * transport. Every untrusted SDK payload is validated with runtime guards
 * and promoted into a typed context the planner can mutate. Any drift —
 * header changes, duplicate anchors or identities, malformed receipts,
 * invalid cells — fails closed before a single mutation request is built.
 *
 * The enumeration and the data read are separate functions so the provider
 * can pace and report each transport request individually; the composite
 * `readPreflightContext` keeps the two-call sequence for non-pacing callers.
 */

import type { NormalizedCell } from "../../../../../domain/index.js";
import type { Presence } from "../../../../../shared/state/index.js";
import { presentValue, absentValue } from "../../../../../shared/state/index.js";
import {
  GOOGLE_SHEETS_API_ANCHOR_KEY,
  GOOGLE_SHEETS_API_RECEIPT_HEADERS,
  GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME,
} from "../constants.js";
import { invalidProviderState } from "../errors.js";
import type {
  GoogleSheetsApiTransport,
  GoogleSheetsApiGetSpreadsheetRequest,
} from "../transport/googleSheetsApiTransport.js";
import {
  columnLetters,
  identityFromNormalizedCell,
  isBlankApiCell,
  normalizedCellFromApiValue,
  parseRegisteredRange,
  quoteA1SheetName,
} from "./valueNormalization.js";

/**
 * Preflight field mask: sheet identity plus grid values, formats, anchors.
 *
 * GridData has no `sheetId` of its own; the parent sheet's
 * `sheets.properties.sheetId` identifies the grid, and developer metadata
 * uses the REST `metadataKey`/`metadataValue` field names.
 */
export const GOOGLE_SHEETS_API_PREFLIGHT_FIELDS = [
  "sheets.properties(sheetId,title,hidden),",
  "sheets.data(startRow,startColumn,",
  "rowMetadata.developerMetadata(metadataId,metadataKey,metadataValue),",
  "rowData.values(userEnteredValue,userEnteredFormat.numberFormat,effectiveFormat.numberFormat))",
].join("");

/**
 * Enumeration field mask: sheet identity only.
 *
 * The enumeration call requests no ranges because a ranged
 * `spreadsheets.get` response only carries sheets intersecting the requested
 * ranges (hidden tabs included only when no ranges are given); the receipt
 * tab can therefore never be discovered from the ranged data call alone.
 */
export const GOOGLE_SHEETS_API_ENUMERATION_FIELDS =
  "sheets.properties(sheetId,title,hidden)";

/**
 * Provisioning enumeration mask: sheet identity plus grid dimensions.
 *
 * The grid dimensions let provisioning request the full used grid of an
 * existing tab (up to the sheet's actual last column) so "truly empty" is
 * judged against the whole tab, not just the registered range.
 */
export const GOOGLE_SHEETS_API_PROVISION_ENUMERATION_FIELDS =
  "sheets.properties(sheetId,title,hidden,gridProperties(rowCount,columnCount))";

/**
 * Provisioning data mask: values plus number formats for header checks.
 *
 * Anchors, merged ranges, and computed values are not needed to decide
 * whether an existing tab is empty or whether its header row matches.
 */
export const GOOGLE_SHEETS_API_PROVISION_FIELDS = [
  "sheets.properties(sheetId,title,hidden),",
  "sheets.data(startRow,startColumn,",
  "rowData.values(userEnteredValue,userEnteredFormat.numberFormat,effectiveFormat.numberFormat))",
].join("");

/**
 * Values-only table-read mask (getValues semantics).
 *
 * Includes computed values, formatted error strings, number formats, and
 * data-validation rules so formula cells resolve to their computed value,
 * error cells to their display string, and checkbox columns to their
 * blank/false rule.
 */
export const GOOGLE_SHEETS_API_VALUES_FIELDS = [
  "sheets.properties(sheetId,title,hidden),",
  "sheets.data(startRow,startColumn,",
  "rowData.values(userEnteredValue,effectiveValue,formattedValue,",
  "userEnteredFormat.numberFormat,effectiveFormat.numberFormat,dataValidation))",
].join("");

/**
 * Full observation mask: values, computed values, merged ranges, anchors.
 *
 * This is the metadata-preserving read used by snapshots and anchor
 * assignment. Merged regions live on the SHEET object as `sheets.merges`
 * (GridRange entries), NOT on GridData, and `rowMetadata.developerMetadata`
 * returns the row anchor evidence under the REST `metadataKey`/
 * `metadataValue` names.
 */
export const GOOGLE_SHEETS_API_OBSERVATION_FIELDS = [
  "sheets.properties(sheetId,title,hidden),",
  "sheets.merges,",
  "sheets.data(startRow,startColumn,",
  "rowMetadata.developerMetadata(metadataId,metadataKey,metadataValue),",
  "rowData.values(userEnteredValue,effectiveValue,formattedValue,",
  "userEnteredFormat.numberFormat,effectiveFormat.numberFormat,dataValidation))",
].join("");

/**
 * Lightweight observation mask: values and computed values only.
 *
 * Used by user_input polling reads, which never consult merged regions (the
 * lightweight branch has no merged map) or data-validation rules (the
 * checkbox-false blank rule comes from the checkboxHeaders config, not from
 * dataValidation). Keeping `sheets.merges` and `dataValidation` out of the
 * request makes the polling read cheaper.
 */
export const GOOGLE_SHEETS_API_LIGHTWEIGHT_OBSERVATION_FIELDS = [
  "sheets.properties(sheetId,title,hidden),",
  "sheets.data(startRow,startColumn,",
  "rowMetadata.developerMetadata(metadataId,metadataKey,metadataValue),",
  "rowData.values(userEnteredValue,effectiveValue,formattedValue,",
  "userEnteredFormat.numberFormat,effectiveFormat.numberFormat))",
].join("");

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
// Untrusted SDK response guards
// ---------------------------------------------------------------------------

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

interface ParsedSpreadsheetDocument {
  readonly sheets: readonly ParsedSheet[];
  readonly grids: ReadonlyMap<number, ParsedGridData>;
}

/** Promotes an untrusted `spreadsheets.get` body with runtime guards. */
export function parseSpreadsheetDocument(
  value: unknown,
  label: string,
): ParsedSpreadsheetDocument {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalidProviderState(`${label} response must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.sheets)) {
    invalidProviderState(`${label} response must contain a sheets array`);
  }
  const grids = new Map<number, ParsedGridData>();
  const sheets = record.sheets.map((entry, index) => {
    const sheet = parseSheetEntry(entry, `${label} sheets[${index}]`);
    // Grid data is nested under each sheet entry in the API response and is
    // identified by the parent sheet's properties.sheetId (GridData itself
    // carries no sheetId).
    if (entry !== null && typeof entry === "object" && !Array.isArray(entry) &&
        (entry as Record<string, unknown>).data !== undefined) {
      parseGridDataArray(
        (entry as Record<string, unknown>).data,
        sheet.sheetId,
        `${label} sheets[${index}].data`,
        grids,
      );
    }
    return sheet;
  });
  return { sheets, grids };
}

/**
 * Promotes an enumeration-only `spreadsheets.get` body (sheet properties,
 * no grid data) with runtime guards.
 */
export function parseSheetPropertiesDocument(
  value: unknown,
  label: string,
): readonly ParsedSheet[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalidProviderState(`${label} response must be an object`);
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.sheets)) {
    invalidProviderState(`${label} response must contain a sheets array`);
  }
  return record.sheets.map((entry, index) =>
    parseSheetEntry(entry, `${label} sheets[${index}]`),
  );
}

/** Validates one REST sheet entry's properties (sheetId, title, hidden). */
function parseSheetEntry(value: unknown, label: string): ParsedSheet {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalidProviderState(`${label} must be an object`);
  }
  const sheet = value as Record<string, unknown>;
  const properties = sheet.properties;
  if (properties === null || typeof properties !== "object" || Array.isArray(properties)) {
    invalidProviderState(`${label}.properties must be an object`);
  }
  const propertyRecord = properties as Record<string, unknown>;
  const sheetId = propertyRecord.sheetId;
  const title = propertyRecord.title;
  if (typeof sheetId !== "number" || !Number.isSafeInteger(sheetId)) {
    invalidProviderState(`${label}.properties.sheetId is invalid`);
  }
  if (typeof title !== "string" || title.length === 0) {
    invalidProviderState(`${label}.properties.title is invalid`);
  }
  const hidden = propertyRecord.hidden;
  if (hidden !== undefined && typeof hidden !== "boolean") {
    invalidProviderState(`${label}.properties.hidden is invalid`);
  }
  const gridProperties = propertyRecord.gridProperties;
  const grid = gridProperties === undefined
    ? undefined
    : (() => {
      if (gridProperties === null || typeof gridProperties !== "object" || Array.isArray(gridProperties)) {
        invalidProviderState(`${label}.properties.gridProperties is invalid`);
      }
      const gridRecord = gridProperties as Record<string, unknown>;
      return {
        rowCount: optionalPositiveInteger(gridRecord.rowCount, `${label}.properties.gridProperties.rowCount`),
        columnCount: optionalPositiveInteger(gridRecord.columnCount, `${label}.properties.gridProperties.columnCount`),
      };
    })();
  // Merged regions are a sheet-level `merges` GridRange array in the API
  // response (GridData carries no mergedCells field), requested only by the
  // observation mask; other masks omit the field entirely.
  const merges = parseMergedCells(sheet.merges, `${label}.merges`);
  return {
    sheetId,
    title,
    hidden: hidden === true,
    ...(grid === undefined ? {} : { gridProperties: grid }),
    ...(merges === undefined ? {} : { merges }),
  };
}

function optionalPositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    invalidProviderState(`${label} is invalid`);
  }
  return value;
}

function parseGridDataArray(
  value: unknown,
  sheetId: number,
  label: string,
  grids: Map<number, ParsedGridData>,
): void {
  if (!Array.isArray(value)) {
    invalidProviderState(`${label} must be an array`);
  }
  if (grids.has(sheetId)) {
    invalidProviderState(`${label} contains a duplicate grid for one sheet`);
  }
  value.forEach((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      invalidProviderState(`${label}[${index}] must be an object`);
    }
    const data = entry as Record<string, unknown>;
    const startRow = optionalNonNegativeInteger(data.startRow, `${label}[${index}].startRow`);
    const startColumn = optionalNonNegativeInteger(
      data.startColumn,
      `${label}[${index}].startColumn`,
    );
    const rowData = parseRowData(data.rowData, `${label}[${index}].rowData`);
    const rowMetadata = parseRowMetadata(data.rowMetadata, `${label}[${index}].rowMetadata`);
    grids.set(sheetId, { startRow, startColumn, rowData, rowMetadata });
  });
}

/** Parses one sheet-level `merges` GridRange array with runtime guards. */
function parseMergedCells(
  value: unknown,
  label: string,
): readonly ParsedMergedCell[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) invalidProviderState(`${label} must be an array`);
  return value.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      invalidProviderState(`${label}[${index}] must be an object`);
    }
    const range = entry as Record<string, unknown>;
    const startRowIndex = optionalNonNegativeInteger(
      range.startRowIndex,
      `${label}[${index}].startRowIndex`,
    );
    const endRowIndex = optionalNonNegativeInteger(
      range.endRowIndex,
      `${label}[${index}].endRowIndex`,
    );
    const startColumnIndex = optionalNonNegativeInteger(
      range.startColumnIndex,
      `${label}[${index}].startColumnIndex`,
    );
    const endColumnIndex = optionalNonNegativeInteger(
      range.endColumnIndex,
      `${label}[${index}].endColumnIndex`,
    );
    if (endRowIndex <= startRowIndex || endColumnIndex <= startColumnIndex) {
      invalidProviderState(`${label}[${index}] is not a valid cell range`);
    }
    const sheetIdValue = range.sheetId;
    if (sheetIdValue !== undefined &&
        (typeof sheetIdValue !== "number" || !Number.isSafeInteger(sheetIdValue))) {
      invalidProviderState(`${label}[${index}].sheetId is invalid`);
    }
    return {
      ...(sheetIdValue === undefined ? {} : { sheetId: sheetIdValue }),
      startRowIndex,
      endRowIndex,
      startColumnIndex,
      endColumnIndex,
    };
  });
}

function parseRowData(value: unknown, label: string): readonly ParsedRowData[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalidProviderState(`${label} must be an array`);
  return value.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      invalidProviderState(`${label}[${index}] must be an object`);
    }
    const row = entry as Record<string, unknown>;
    if (row.values === undefined) return { values: [] };
    if (!Array.isArray(row.values)) {
      invalidProviderState(`${label}[${index}].values must be an array`);
    }
    return { values: row.values };
  });
}

function parseRowMetadata(value: unknown, label: string): readonly ParsedRowMetadata[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalidProviderState(`${label} must be an array`);
  return value.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      invalidProviderState(`${label}[${index}] must be an object`);
    }
    const metadata = entry as Record<string, unknown>;
    if (metadata.developerMetadata === undefined) return { developerMetadata: [] };
    if (!Array.isArray(metadata.developerMetadata)) {
      invalidProviderState(`${label}[${index}].developerMetadata must be an array`);
    }
    return {
      developerMetadata: metadata.developerMetadata.map((item, itemIndex) => {
        if (item === null || typeof item !== "object" || Array.isArray(item)) {
          invalidProviderState(
            `${label}[${index}].developerMetadata[${itemIndex}] must be an object`,
          );
        }
        const itemRecord = item as Record<string, unknown>;
        if (
          typeof itemRecord.metadataKey !== "string" ||
          itemRecord.metadataKey.length === 0
        ) {
          invalidProviderState(
            `${label}[${index}].developerMetadata[${itemIndex}].metadataKey is invalid`,
          );
        }
        if (
          itemRecord.metadataValue !== undefined &&
          typeof itemRecord.metadataValue !== "string"
        ) {
          invalidProviderState(
            `${label}[${index}].developerMetadata[${itemIndex}].metadataValue is invalid`,
          );
        }
        return {
          metadataKey: itemRecord.metadataKey,
          metadataValue: itemRecord.metadataValue === undefined ? "" : itemRecord.metadataValue,
        };
      }),
    };
  });
}

function optionalNonNegativeInteger(value: unknown, label: string): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    invalidProviderState(`${label} is invalid`);
  }
  return value;
}

function requireSheetByTitle(sheets: readonly ParsedSheet[], title: string): ParsedSheet {
  const sheet = findSheetByTitle(sheets, title);
  if (sheet === undefined) {
    invalidProviderState(`Registered sync sheet does not exist: ${title}`);
  }
  return sheet;
}

function findSheetByTitle(
  sheets: readonly ParsedSheet[],
  title: string,
): ParsedSheet | undefined {
  return sheets.find((sheet) => sheet.title === title);
}

function requireGridDataForSheet(
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

// ---------------------------------------------------------------------------
// Context construction
// ---------------------------------------------------------------------------

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

function validateCheckboxHeaders(
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

/** Normalizes nonblank grid rows into typed preflight rows. */
function readRows(
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

function indexRows(
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

/** Reads the userEnteredValue.stringValue of one API cell with guards. */
function apiStringValue(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const entered = record.userEnteredValue;
  if (entered === null || typeof entered !== "object") return undefined;
  const raw = (entered as Record<string, unknown>).stringValue;
  return typeof raw === "string" ? raw : undefined;
}

/** Reads the userEnteredValue.numberValue of one API cell with guards. */
function apiNumberValue(value: unknown): number | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const entered = record.userEnteredValue;
  if (entered === null || typeof entered !== "object") return undefined;
  const raw = (entered as Record<string, unknown>).numberValue;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}
