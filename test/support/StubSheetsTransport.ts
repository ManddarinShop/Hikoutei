/**
 * Credential-free in-memory Google Sheets model + stub transport.
 *
 * The stub implements the provider's narrow transport contract
 * (`getSpreadsheet` / `batchUpdate`) over a tiny spreadsheet model so the
 * planner, batch builder, postcondition classifier, rate limiters, and
 * telemetry can be exercised without a network call. It mirrors the real
 * API's observable behaviors the provider relies on, using the REAL wire
 * shapes so the stub can never mask a contract bug:
 *
 * - grid data omits trailing empty rows and returns each row's values only
 *   up to its last populated column (empty cells are `{}`); GridData itself
 *   carries NO sheetId (the parent sheet properties identify the grid) and
 *   NO mergedCells field — merged regions are sheet-level `merges` entries
 * - a `spreadsheets.get` with ranges returns ONLY the sheets intersecting
 *   those ranges; with no ranges every sheet is returned, hidden ones
 *   included (the real API's behavior the preflight's enumeration relies on)
 * - rowMetadata is index-aligned with rowData and carries the anchor key
 *   under the REST developerMetadata names (metadataKey/metadataValue)
 * - number formats are `{ type, pattern }` objects, never bare strings
 * - batchUpdate applies requests sequentially and returns one reply each
 * - a range that names a missing tab is rejected (400 INVALID_ARGUMENT)
 */

import type {
  GoogleSheetsApiBatchUpdateRequest,
  GoogleSheetsApiCell,
  GoogleSheetsApiGetSpreadsheetRequest,
  GoogleSheetsApiTransport,
  GoogleSheetsApiWriteRequest,
} from "../../src/adapter/sheets/providers/google-sheets-api/index.js";
import {
  GOOGLE_SHEETS_API_ANCHOR_KEY,
  GOOGLE_SHEETS_API_DATE_NUMBER_FORMAT_OBJECT,
} from "../../src/adapter/sheets/providers/google-sheets-api/constants.js";
import {
  GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES,
  GoogleSheetsApiTransportError,
} from "../../src/adapter/sheets/providers/google-sheets-api/errors.js";
import { presentValue, absentValue } from "../../src/shared/state/index.js";
import { computeSyncVisibleHash } from "../../src/application/sync/sheetsContract/syncSheets.js";
import type { NormalizedCell } from "../../src/domain/index.js";
import { dateSerialFromIso, isCanonicalDateNumberFormat } from "../../src/adapter/sheets/providers/google-sheets-api/model/valueNormalization.js";

/** One stored cell in the in-memory grid (real REST wire shapes). */
export interface StubCell {
  userEnteredValue?: {
    readonly stringValue?: string;
    readonly numberValue?: number;
    readonly boolValue?: boolean;
    readonly formulaValue?: string;
    readonly errorValue?: {
      readonly type?: string;
      readonly message?: string;
    };
  };
  userEnteredFormat?: {
    readonly numberFormat?: {
      readonly type: "DATE_TIME";
      readonly pattern: string;
    };
  };
  effectiveValue?: {
    readonly stringValue?: string;
    readonly numberValue?: number;
    readonly boolValue?: boolean;
    readonly errorValue?: {
      readonly type?: string;
      readonly message?: string;
    };
  };
  formattedValue?: string;
  dataValidation?: {
    readonly rule?: {
      readonly condition?: {
        readonly type?: string;
      };
    };
    readonly strict?: boolean;
  };
}

/** Fault injection for transport failure classification tests. */
export type StubTransportFault =
  | { readonly kind: "http"; readonly status: number; readonly apiErrorStatus: string }
  | { readonly kind: "timeout" }
  | { readonly kind: "network" }
  | { readonly kind: "malformedBatchUpdateReply" }
  | { readonly kind: "malformedGetResponse" };

/** One tab of the in-memory spreadsheet. */
export class StubSheet {
  public constructor(
    public readonly sheetId: number,
    public readonly title: string,
    public hidden: boolean,
  ) {}

  /** Cells keyed by `${row},${col}` with 0-based coordinates. */
  public readonly cells = new Map<string, StubCell>();
  /**
   * Developer-metadata anchors keyed by 0-based row index. A row may carry
   * several anchors (a single string value is treated as one anchor).
   */
  public readonly anchors = new Map<number, string | readonly string[]>();
  /** Checkbox data-validation ranges recorded for assertions. */
  public readonly dataValidationRanges: {
    readonly startRowIndex: number;
    readonly endRowIndex: number;
    readonly startColumnIndex: number;
    readonly endColumnIndex: number;
  }[] = [];
  /** Merged-cell regions (0-based, end-exclusive), real GridRange shapes. */
  public readonly mergedRanges: {
    readonly startRowIndex: number;
    readonly endRowIndex: number;
    readonly startColumnIndex: number;
    readonly endColumnIndex: number;
  }[] = [];

  public cell(row: number, col: number): StubCell | undefined {
    return this.cells.get(`${row},${col}`);
  }

  /** Returns the anchors of one row as an array (empty when absent). */
  public anchorsFor(row: number): readonly string[] {
    const anchors = this.anchors.get(row);
    if (anchors === undefined) return [];
    return typeof anchors === "string" ? [anchors] : anchors;
  }

  /** Returns the data-validation rule covering one cell, if any. */
  public dataValidationFor(row: number, col: number): StubCell["dataValidation"] {
    const range = this.dataValidationRanges.find((candidate) =>
      row >= candidate.startRowIndex && row < candidate.endRowIndex &&
      col >= candidate.startColumnIndex && col < candidate.endColumnIndex);
    if (range === undefined) return undefined;
    return {
      rule: { condition: { type: "BOOLEAN" } },
      strict: true,
    };
  }

  /** Returns the last row (0-based) that has any cell content. */
  public lastContentRow(): number {
    let last = -1;
    for (const key of this.cells.keys()) {
      const row = Number(key.split(",")[0]);
      if (row > last) last = row;
    }
    for (const row of this.anchors.keys()) {
      if (row > last) last = row;
    }
    return last;
  }

  public lastContentColumn(): number {
    let last = -1;
    for (const key of this.cells.keys()) {
      const col = Number(key.split(",")[1]);
      if (col > last) last = col;
    }
    return last;
  }
}

/** In-memory spreadsheet shared by one test. */
export class StubSpreadsheet {
  public readonly sheets: StubSheet[] = [];
  private nextSheetId = 1000;
  public spreadsheetId = "stub-spreadsheet";

  /** Adds a tab; `headers` and `rows` seed cells at 1-based row/col positions. */
  public addTab(
    title: string,
    options: {
      readonly headers?: readonly string[];
      readonly rows?: readonly (readonly (NormalizedCell | string | number | boolean | null)[])[];
      readonly hidden?: boolean;
      readonly anchors?: ReadonlyMap<number, string>;
    } = {},
  ): StubSheet {
    const sheet = new StubSheet(this.nextSheetId, title, options.hidden === true);
    this.nextSheetId += 1;
    this.sheets.push(sheet);
    if (options.headers !== undefined) {
      options.headers.forEach((header, index) => {
        sheet.cells.set(`0,${index}`, { userEnteredValue: { stringValue: header } });
      });
    }
    (options.rows ?? []).forEach((row, rowIndex) => {
      row.forEach((value, columnIndex) => {
        sheet.cells.set(`${rowIndex + 1},${columnIndex}`, toStubCell(value));
      });
    });
    if (options.anchors !== undefined) {
      for (const [row, anchor] of options.anchors) sheet.anchors.set(row, anchor);
    }
    return sheet;
  }

  public findTab(title: string): StubSheet | undefined {
    return this.sheets.find((sheet) => sheet.title === title);
  }
}

/** Converts a fixture value to a stored stub cell. */
export function toStubCell(value: NormalizedCell | string | number | boolean | null): StubCell {
  if (value === null || value === undefined) return {};
  if (typeof value === "string") return { userEnteredValue: { stringValue: value } };
  if (typeof value === "boolean") return { userEnteredValue: { boolValue: value } };
  if (typeof value === "number") return { userEnteredValue: { numberValue: value } };
  switch (value.kind) {
    case "string":
      return { userEnteredValue: { stringValue: value.value } };
    case "boolean":
      return { userEnteredValue: { boolValue: value.value } };
    case "number":
      return { userEnteredValue: { numberValue: value.value } };
    case "date":
      return {
        userEnteredValue: { numberValue: dateSerialFromIso(value.value) },
        userEnteredFormat: { numberFormat: GOOGLE_SHEETS_API_DATE_NUMBER_FORMAT_OBJECT },
      };
  }
}

/** Reads a stub cell back as a normalized cell (with date format awareness). */
export function stubCellToNormalized(cell: StubCell | undefined): NormalizedCell {
  const value = cell?.userEnteredValue;
  if (value === undefined || Object.keys(value).length === 0) return null;
  if (value.stringValue !== undefined) {
    return { kind: "string", value: value.stringValue.normalize("NFC") };
  }
  if (value.boolValue !== undefined) return { kind: "boolean", value: value.boolValue };
  if (value.numberValue !== undefined) {
    const format = cell?.userEnteredFormat?.numberFormat;
    if (format !== undefined && isCanonicalDateNumberFormat(format)) {
      return {
        kind: "date",
        value: new Date(Date.UTC(1899, 11, 30) + value.numberValue * 86_400_000).toISOString(),
      };
    }
    return { kind: "number", value: value.numberValue };
  }
  return null;
}

/** Reads one row of a stub sheet as normalized cells keyed by header. */
export function stubRowFields(
  sheet: StubSheet,
  rowNumber: number,
  headers: readonly string[],
): Record<string, NormalizedCell> {
  const fields: Record<string, NormalizedCell> = {};
  headers.forEach((header, index) => {
    // rowNumber is 1-based; the stub grid is keyed 0-based.
    fields[header] = stubCellToNormalized(sheet.cell(rowNumber - 1, index));
  });
  return fields;
}

/**
 * Stub transport implementing the narrow provider contract over the model.
 *
 * `fault` applies to the NEXT request of its class and clears afterwards
 * (one-shot), so a test can prove recovery behavior after a failed call.
 */
export class StubSheetsTransport implements GoogleSheetsApiTransport {
  public readonly spreadsheet: StubSpreadsheet;
  public readonly appliedBatchUpdates: GoogleSheetsApiWriteRequest[][] = [];
  public getSpreadsheetCalls = 0;
  /** Every `getSpreadsheet` request, in order, for preflight shape asserts. */
  public readonly getSpreadsheetRequests: GoogleSheetsApiGetSpreadsheetRequest[] = [];
  public batchUpdateCalls = 0;
  /** Injectable clock so limiter tests can observe request starts in fake time. */
  public now: () => number = Date.now;
  public requestStarts: { readonly kind: "read" | "write"; readonly at: number }[] = [];
  public fault: StubTransportFault | undefined;

  public constructor(spreadsheet: StubSpreadsheet) {
    this.spreadsheet = spreadsheet;
  }

  public async getSpreadsheet(request: GoogleSheetsApiGetSpreadsheetRequest): Promise<unknown> {
    this.requestStarts.push({ kind: "read", at: this.now() });
    this.getSpreadsheetCalls += 1;
    this.getSpreadsheetRequests.push(request);
    if (this.fault !== undefined && this.fault.kind !== "malformedBatchUpdateReply") {
      const fault = this.fault;
      this.fault = undefined;
      if (fault.kind === "malformedGetResponse") {
        return { unexpected: true };
      }
      throw transportFaultError(fault);
    }
    // The real API returns only the sheets intersecting the requested ranges
    // when ranges are given (other sheets' properties are omitted); with no
    // ranges every sheet is returned, hidden ones included. The preflight
    // depends on this: the range-less enumeration finds the hidden receipt
    // tab, and the ranged data call returns grids for exactly the tabs whose
    // ranges were requested.
    const visible = request.ranges.length === 0
      ? this.spreadsheet.sheets
      : this.spreadsheet.sheets.filter((sheet) =>
          request.ranges.some((range) => rangeNamesSheet(range, sheet.title)));
    const sheets = visible.map((sheet) => {
      const data = request.ranges.some((range) => rangeNamesSheet(range, sheet.title))
        ? [gridDataFor(sheet)]
        : [];
      return {
        properties: {
          sheetId: sheet.sheetId,
          title: sheet.title,
          hidden: sheet.hidden,
          gridProperties: {
            rowCount: Math.max(sheet.lastContentRow() + 1, 1000),
            columnCount: Math.max(sheet.lastContentColumn() + 1, 26),
          },
        },
        // Merged regions live on the SHEET object as `merges` GridRange
        // entries (real wire shape); GridData has no mergedCells field.
        merges: sheet.mergedRanges.map((range) => ({
          startRowIndex: range.startRowIndex,
          endRowIndex: range.endRowIndex,
          startColumnIndex: range.startColumnIndex,
          endColumnIndex: range.endColumnIndex,
        })),
        data,
      };
    });
    return { spreadsheetId: this.spreadsheet.spreadsheetId, sheets };
  }

  public async batchUpdate(request: GoogleSheetsApiBatchUpdateRequest): Promise<unknown> {
    this.requestStarts.push({ kind: "write", at: this.now() });
    this.batchUpdateCalls += 1;
    if (this.fault !== undefined && this.fault.kind === "malformedBatchUpdateReply") {
      // A 2xx body whose shape cannot prove what was applied. The requests are
      // applied first, mirroring the real API: the batch commits remotely and
      // only the reply is lost, so a retry must be idempotent.
      this.fault = undefined;
      const replies: unknown[] = [];
      for (const item of request.requests) {
        replies.push(applyRequest(this.spreadsheet, item));
      }
      this.appliedBatchUpdates.push([...request.requests]);
      return { spreadsheetId: this.spreadsheet.spreadsheetId, replies: [] };
    }
    if (this.fault !== undefined) {
      const fault = this.fault;
      this.fault = undefined;
      if (fault.kind === "malformedGetResponse") {
        throw new Error("stub fault misuse: malformedGetResponse only applies to getSpreadsheet");
      }
      throw transportFaultError(fault);
    }
    const replies: unknown[] = [];
    for (const item of request.requests) {
      replies.push(applyRequest(this.spreadsheet, item));
    }
    this.appliedBatchUpdates.push([...request.requests]);
    return { spreadsheetId: this.spreadsheet.spreadsheetId, replies };
  }
}

/** Builds the transport error for one injected fault. */
function transportFaultError(fault: StubTransportFault): Error {
  switch (fault.kind) {
    case "http":
      return new GoogleSheetsApiTransportError(
        GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.HTTP_ERROR,
        "stub http failure",
        presentValue(fault.status),
        presentValue(fault.apiErrorStatus),
      );
    case "timeout":
      return new GoogleSheetsApiTransportError(
        GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.TIMEOUT,
        "stub timeout",
        absentValue(),
      );
    case "network":
      return new GoogleSheetsApiTransportError(
        GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.NETWORK_ERROR,
        "stub network failure",
        absentValue(),
        presentValue("ECONNRESET"),
      );
    default:
      throw new Error(`stub transport fault is unsupported: ${fault.kind}`);
  }
}

/** Builds the grid data response shape for one stub sheet. */
function gridDataFor(sheet: StubSheet): unknown {
  const lastRow = sheet.lastContentRow();
  const rowData: unknown[] = [];
  const rowMetadata: unknown[] = [];
  for (let row = 0; row <= lastRow; row += 1) {
    const lastColumn = sheet.lastContentColumn();
    const values: unknown[] = [];
    for (let col = 0; col <= lastColumn; col += 1) {
      const cell = sheet.cell(row, col);
      values.push(stubCellWire(cell, sheet.dataValidationFor(row, col)));
    }
    rowData.push({ values });
    const anchors = sheet.anchorsFor(row);
    rowMetadata.push({
      developerMetadata: anchors.map((anchor) => ({
        metadataKey: GOOGLE_SHEETS_API_ANCHOR_KEY,
        metadataValue: anchor,
      })),
    });
  }
  return {
    startRow: 0,
    startColumn: 0,
    rowData,
    rowMetadata,
  };
}

function stubCellWire(cell: StubCell | undefined, dataValidation: StubCell["dataValidation"]): unknown {
  if (cell === undefined) {
    return dataValidation === undefined ? {} : { dataValidation };
  }
  return dataValidation === undefined ? cell : { ...cell, dataValidation };
}

function rangeNamesSheet(range: string, title: string): boolean {
  const parsed = parseA1Range(range);
  return parsed !== undefined && parsed.sheetName === title;
}

interface ParsedA1Range {
  readonly sheetName: string;
}

function parseA1Range(range: string): ParsedA1Range | undefined {
  const match = /^'((?:[^']|'')*)'!/.exec(range);
  if (match === null || match[1] === undefined) return undefined;
  return { sheetName: match[1]?.replace(/''/g, "'") ?? "" };
}

/** Applies one provider write request to the model and returns its reply. */
function applyRequest(spreadsheet: StubSpreadsheet, request: GoogleSheetsApiWriteRequest): unknown {
  switch (request.kind) {
    case "addSheet": {
      const sheet = new StubSheet(request.sheetId, request.title, false);
      spreadsheet.sheets.push(sheet);
      return { addSheet: { properties: { sheetId: request.sheetId, title: request.title } } };
    }
    case "updateSheetProperties": {
      const sheet = requireSheet(spreadsheet, request.sheetId);
      sheet.hidden = request.hidden;
      return {};
    }
    case "updateCells": {
      const sheet = requireSheet(spreadsheet, request.sheetId);
      request.rows.forEach((row, rowOffset) => {
        row.forEach((cell, columnOffset) => {
          const rowIndex = request.startRowIndex + rowOffset;
          const columnIndex = request.startColumnIndex + columnOffset;
          const key = `${rowIndex},${columnIndex}`;
          if (cell === null) {
            sheet.cells.delete(key);
            return;
          }
          const existing = sheet.cells.get(key) ?? {};
          const next: StubCell = { ...existing };
          if (cell.userEnteredValue !== undefined) {
            next.userEnteredValue = cell.userEnteredValue;
          }
          if (cell.userEnteredFormat !== undefined) {
            next.userEnteredFormat = cell.userEnteredFormat;
          }
          sheet.cells.set(key, next);
        });
      });
      return {};
    }
    case "insertDimension": {
      const sheet = requireSheet(spreadsheet, request.sheetId);
      const count = request.endIndex - request.startIndex;
      shiftRows(sheet, request.startIndex, count);
      return {};
    }
    case "deleteDimension": {
      const sheet = requireSheet(spreadsheet, request.sheetId);
      const count = request.endIndex - request.startIndex;
      deleteRows(sheet, request.startIndex, count);
      return {};
    }
    case "setDataValidation": {
      const sheet = requireSheet(spreadsheet, request.sheetId);
      sheet.dataValidationRanges.push({
        startRowIndex: request.startRowIndex,
        endRowIndex: request.endRowIndex,
        startColumnIndex: request.startColumnIndex,
        endColumnIndex: request.endColumnIndex,
      });
      return {};
    }
    case "createDeveloperMetadata": {
      const sheet = requireSheet(spreadsheet, request.sheetId);
      const existing = sheet.anchorsFor(request.rowIndex);
      sheet.anchors.set(request.rowIndex, [...existing, request.value]);
      return {};
    }
    case "deleteSheet": {
      const index = spreadsheet.sheets.findIndex((sheet) => sheet.sheetId === request.sheetId);
      if (index < 0) {
        throw new GoogleSheetsApiTransportError(
          GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.HTTP_ERROR,
          "stub sheet is missing",
          presentValue(400),
          presentValue("INVALID_ARGUMENT"),
        );
      }
      spreadsheet.sheets.splice(index, 1);
      return {};
    }
  }
}

function requireSheet(spreadsheet: StubSpreadsheet, sheetId: number): StubSheet {
  const sheet = spreadsheet.sheets.find((candidate) => candidate.sheetId === sheetId);
  if (sheet === undefined) {
    throw new GoogleSheetsApiTransportError(
      GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.HTTP_ERROR,
      "stub sheet is missing",
      presentValue(400),
      presentValue("INVALID_ARGUMENT"),
    );
  }
  return sheet;
}

/** Shifts cells and anchors at/after `startRow` down by `count` rows. */
function shiftRows(sheet: StubSheet, startRow: number, count: number): void {
  const shiftedCells = new Map<string, StubCell>();
  for (const [key, cell] of sheet.cells) {
    const [row, col] = key.split(",").map(Number);
    if (row !== undefined && row >= startRow) {
      shiftedCells.set(`${row + count},${col}`, cell);
    } else {
      shiftedCells.set(key, cell);
    }
  }
  sheet.cells.clear();
  for (const [key, cell] of shiftedCells) sheet.cells.set(key, cell);

  const shiftedAnchors = new Map<number, string | readonly string[]>();
  for (const [row, anchor] of sheet.anchors) {
    shiftedAnchors.set(row >= startRow ? row + count : row, anchor);
  }
  sheet.anchors.clear();
  for (const [row, anchor] of shiftedAnchors) sheet.anchors.set(row, anchor);
}

/** Deletes `count` rows starting at `startRow` and shifts the rest up. */
function deleteRows(sheet: StubSheet, startRow: number, count: number): void {
  const keptCells = new Map<string, StubCell>();
  for (const [key, cell] of sheet.cells) {
    const [row, col] = key.split(",").map(Number);
    if (row === undefined || row < startRow) {
      keptCells.set(key, cell);
    } else if (row >= startRow + count) {
      keptCells.set(`${row - count},${col}`, cell);
    }
  }
  sheet.cells.clear();
  for (const [key, cell] of keptCells) sheet.cells.set(key, cell);

  const keptAnchors = new Map<number, string | readonly string[]>();
  for (const [row, anchor] of sheet.anchors) {
    if (row < startRow) {
      keptAnchors.set(row, anchor);
    } else if (row >= startRow + count) {
      keptAnchors.set(row - count, anchor);
    }
  }
  sheet.anchors.clear();
  for (const [row, anchor] of keptAnchors) sheet.anchors.set(row, anchor);
}

/** Computes the visible hash of a stub row over all headers (append rule). */
export function stubRowVisibleHash(
  sheet: StubSheet,
  rowNumber: number,
  headers: readonly string[],
): string {
  return computeSyncVisibleHash(stubRowFields(sheet, rowNumber, headers));
}
