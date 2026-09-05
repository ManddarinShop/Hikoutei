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
 * - row anchors are ordinary cell values in the tab's last system column
 *   (no developer metadata anywhere in the model)
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
} from "@hikoutei/sheets/sheets/providers/google-sheets-api/index.js";
import type {
  GoogleSheetsApiValuesGetRequest,
  GoogleSheetsApiValuesGetResponse,
} from "@hikoutei/sheets/sheets/providers/google-sheets-api/transport/googleSheetsApiTransport.js";
import {
  GOOGLE_SHEETS_API_DATE_NUMBER_FORMAT_OBJECT,
  GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME,
} from "@hikoutei/sheets/sheets/providers/google-sheets-api/constants.js";
import {
  GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES,
  GoogleSheetsApiTransportError,
} from "@hikoutei/sheets/sheets/providers/google-sheets-api/errors.js";
import { presentValue, absentValue } from "@hikoutei/contracts/state/index.js";
import { computeSyncVisibleHash } from "@hikoutei/contracts/sheets/syncSheets.js";
import {
  renderRowCheckCell,
  SYNC_ROW_CHECK_DELIMITER,
} from "@hikoutei/contracts/sheets/rowCheck.js";
import { buildRowCheckFormula } from "@hikoutei/sheets/sheets/providers/google-sheets-api/model/rowCheckFormula.js";
import type { NormalizedCell } from "@hikoutei/contracts/encoding/types.js";
import { dateSerialFromIso, isCanonicalDateNumberFormat, isoFromDateSerial } from "@hikoutei/sheets/sheets/providers/google-sheets-api/model/valueNormalization.js";

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
  /**
   * The real API COMPUTES effectiveFormat; the stub only carries one on
   * malformed-shape fixtures that must reach the boundary guard verbatim.
   */
  effectiveFormat?: unknown;
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
  | { readonly kind: "malformedGetResponse" }
  | { readonly kind: "malformedGetField" }
  | { readonly kind: "duplicateGrids" }
  /**
   * The real API's proven pre-mutation rejection of a receipt-tail band whose
   * start row sits beyond the tab's rows (HTTP 400 INVALID_ARGUMENT). Applies
   * ONLY to a `spreadsheets.get` that requests a banded receipt range
   * (`'receipts'!A{n}:...` with n >= 2); enumerations and full receipt reads
   * pass through untouched, so a cursor-recovery fallback can be pinned.
   */
  | { readonly kind: "rejectBandedReceiptRange" };

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
   * Explicit grid column count for addDimension/grid-width tests. The stub
   * otherwise reports `max(lastContentColumn + 1, 26)` like a fresh real
   * sheet; setting it lets a test pin a NARROW grid so provisioning must
   * emit an addDimension for the row-check column before its header write.
   */
  public gridColumnCount: number | undefined;
  /** Grid width the stub reports (default 26 columns, like a real sheet). */
  public gridColumns(): number {
    return this.gridColumnCount ?? Math.max(this.lastContentColumn() + 1, 26);
  }

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
        // Delegate to the provider conversion so the stub read-back (and
        // the visible hashes derived from it) can never drift from the
        // production serial-to-ISO rounding.
        value: isoFromDateSerial(value.numberValue),
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

  /**
   * Raw `spreadsheets.values.get` over the in-memory grid (FORMATTED_VALUE
   * semantics). Only the existing-sheet adoption reader consumes this.
   */
  public async getValues(
    request: GoogleSheetsApiValuesGetRequest,
  ): Promise<GoogleSheetsApiValuesGetResponse> {
    const rangeText = request.range;
    const tabTitle = rangeText.includes("!") ? rangeText.split("!")[0]!.replace(/^'/, "").replace(/'$/, "").replace(/''/g, "'") : rangeText;
    const sheet = this.spreadsheet.findTab(tabTitle);
    if (sheet === undefined) {
      throw new GoogleSheetsApiTransportError(
        GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.HTTP_ERROR,
        `Unable to parse range: ${rangeText}`,
        presentValue(400),
        presentValue("INVALID_ARGUMENT"),
      );
    }
    const rows: (string | number | boolean | null)[][] = [];
    for (let row = 0; row < 1000; row++) {
      const rowValues: (string | number | boolean | null)[] = [];
      let populated = false;
      for (let col = 0; col < 50; col++) {
        const cell = sheet.cell(row, col);
        const raw = cell?.userEnteredValue;
        if (raw === undefined) { rowValues.push(null); continue; }
        populated = true;
        if (cell?.formattedValue !== undefined) { rowValues.push(cell.formattedValue); continue; }
        if (raw.stringValue !== undefined) rowValues.push(raw.stringValue);
        else if (raw.numberValue !== undefined) rowValues.push(raw.numberValue);
        else if (raw.boolValue !== undefined) rowValues.push(raw.boolValue);
        else rowValues.push(null);
      }
      if (!populated) break;
      // The real API omits trailing empty cells: trim the null padding so the
      // adoption reader's ignored-column report matches real wire behavior.
      while (rowValues.length > 0 && rowValues.at(-1) === null) rowValues.pop();
      rows.push(rowValues);
    }
    return { values: rows };
  }

  public async getSpreadsheet(request: GoogleSheetsApiGetSpreadsheetRequest): Promise<unknown> {
    this.requestStarts.push({ kind: "read", at: this.now() });
    this.getSpreadsheetCalls += 1;
    this.getSpreadsheetRequests.push(request);
    // The duplicateGrids fault targets ranged data calls only; a range-less
    // enumeration passes through untouched so the fault survives to the data
    // read that follows it in provisioning/snapshot flows.
    if (this.fault !== undefined && this.fault.kind !== "malformedBatchUpdateReply" &&
        !(this.fault.kind === "duplicateGrids" && request.ranges.length === 0) &&
        !(this.fault.kind === "rejectBandedReceiptRange" && !requestsBandedReceiptRange(request))) {
      const fault = this.fault;
      this.fault = undefined;
      if (fault.kind === "malformedGetResponse") {
        return { unexpected: true };
      }
      if (fault.kind === "malformedGetField") {
        // A structurally valid `spreadsheets.get` body whose field-level shape
        // is malformed: the top-level shape guard passes but a field-level
        // parser guard (here, a non-string tab title) must fail closed.
        return {
          spreadsheetId: this.spreadsheet.spreadsheetId,
          sheets: [{ properties: { sheetId: 1, title: 42 } }],
        };
      }
      if (fault.kind === "duplicateGrids") {
        // A structurally valid multi-grid reply to a single-range request:
        // the grids no longer match the request shape and single-range
        // readers must fail closed instead of silently taking grid [0].
        // Re-run the normal path (fault cleared) and duplicate each grid.
        const body = (await this.getSpreadsheet(request)) as {
          spreadsheetId: string;
          sheets: Array<{ data?: unknown[] }>;
        };
        return {
          ...body,
          sheets: body.sheets.map((entry) =>
            Array.isArray(entry.data) ? { ...entry, data: [...entry.data, ...entry.data] } : entry),
        };
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
    // The real API returns ONLY the response fields named by the request's
    // field mask. Enforcing the mask here (per top-level cell wrapper) is
    // what makes values-only base reads and format-evidenced verification
    // reads actually different in tests, exactly like on the wire.
    const includeNumberFormats = request.fields.includes("numberFormat");
    const includeEffectiveValue = request.fields.includes("effectiveValue");
    const includeFormattedValue = request.fields.includes("formattedValue");
    const includeDataValidation = request.fields.includes("dataValidation");
    // The real API returns ONLY the grid dimensions the field mask named
    // (proven live: a `gridProperties(rowCount)`-only mask carries no
    // columnCount). Mirror that per-dimension mask semantics so bound
    // planning is exercised against the REAL response shape.
    const gridMask = gridPropertiesMask(request.fields);
    const sheets = visible.map((sheet) => {
      // The real API returns ONE cropped GridData per requested range of the
      // sheet (in request order), each carrying its own startRow/startColumn
      // band. Emitting a single whole-sheet grid would let scoped-read tests
      // silently pass against data outside the requested band.
      const bands = request.ranges
        .map((range) => parseA1Range(range))
        .filter((band): band is ParsedA1Range => band !== undefined && band.sheetName === sheet.title);
      const data = bands.map((band) => gridDataFor(sheet, band, {
        includeNumberFormats,
        includeEffectiveValue,
        includeFormattedValue,
        includeDataValidation,
      }));
      // The REAL API returns exactly the sheet-properties dimensions the
      // field mask named (proven live: a `gridProperties(rowCount)`-only
      // mask carries NO columnCount). Mirror that per-field masking so
      // mask/parse drift cannot hide behind an over-generous stub.
      return {
        properties: {
          sheetId: sheet.sheetId,
          title: sheet.title,
          hidden: sheet.hidden,
          ...(gridMask === undefined ? {} : {
            gridProperties: {
              ...(gridMask.rowCount
                ? { rowCount: Math.max(sheet.lastContentRow() + 1, 1000) }
                : {}),
              ...(gridMask.columnCount
                ? { columnCount: sheet.gridColumns() }
                : {}),
            },
          }),
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
      if (fault.kind === "malformedGetResponse" || fault.kind === "malformedGetField" ||
          fault.kind === "duplicateGrids" || fault.kind === "rejectBandedReceiptRange") {
        throw new Error("stub fault misuse: malformed get faults only apply to getSpreadsheet");
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
    case "rejectBandedReceiptRange":
      // Same wire shape the real API uses to reject an out-of-bounds range:
      // HTTP 400 carrying the canonical INVALID_ARGUMENT remote status.
      return new GoogleSheetsApiTransportError(
        GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.HTTP_ERROR,
        "Range (receipt tail band) exceeds grid limits",
        presentValue(400),
        presentValue("INVALID_ARGUMENT"),
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

/** Cell wrappers kept per requested field mask (real API mask semantics). */
interface StubMaskOptions {
  readonly includeNumberFormats: boolean;
  readonly includeEffectiveValue: boolean;
  readonly includeFormattedValue: boolean;
  readonly includeDataValidation: boolean;
}

/** Builds the cropped grid data response for ONE requested A1 band. */
function gridDataFor(sheet: StubSheet, band: ParsedA1Range, mask: StubMaskOptions): unknown {
  // The real API omits trailing fully-empty rows inside the requested band.
  const lastRow = Math.min(band.endRow, sheet.lastContentRow());
  const rowData: unknown[] = [];
  for (let row = band.startRow; row <= lastRow; row += 1) {
    const values: unknown[] = [];
    for (let col = band.startColumn; col <= band.endColumn; col += 1) {
      values.push(stubCellWire(sheet, row, col, mask));
    }
    // ...and each row's values only up to its last populated column. The
    // real API omits trailing empty CellData entries, but a MERGE-COVERED
    // cell inside the row's span still comes back as a blank `{}` entry —
    // the provider's merged/blank contract depends on that distinction
    // (`null` position means blank; a present `{}` inside a merge means
    // merged), so the trim must stop at merge coverage.
    while (
      values.length > 0
      && isPlainEmptyCell(values[values.length - 1])
      && !mergeCovers(sheet, row, band.startColumn + values.length - 1)
    ) {
      values.pop();
    }
    rowData.push({ values });
  }
  return {
    startRow: band.startRow,
    startColumn: band.startColumn,
    rowData,
  };
}

/** True when one 0-based cell position falls inside a merged region. */
function mergeCovers(sheet: StubSheet, row: number, col: number): boolean {
  return sheet.mergedRanges.some((range) =>
    row >= range.startRowIndex && row < range.endRowIndex &&
    col >= range.startColumnIndex && col < range.endColumnIndex);
}

/**
 * Parses the gridProperties dimensions named by a `spreadsheets.get` field
 * mask (`gridProperties(rowCount)`, `gridProperties.rowCount`,
 * `gridProperties(rowCount,columnCount)`); returns `undefined` when the mask
 * names no grid dimension at all (the real API then omits `gridProperties`).
 */
function gridPropertiesMask(
  fields: string,
): { readonly rowCount: boolean; readonly columnCount: boolean } | undefined {
  const rowCount = /gridProperties\(.*\browCount\b|gridProperties\.rowCount\b/.test(fields);
  const columnCount = /gridProperties\(.*\bcolumnCount\b|gridProperties\.columnCount\b/.test(fields);
  if (!rowCount && !columnCount) return undefined;
  return { rowCount, columnCount };
}

/** True when a built wire cell carries no wrappers (a blank `{}` CellData). */
function isPlainEmptyCell(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value as Record<string, unknown>).length === 0;
}

/**
 * The provider-written per-row token formula in the check column (see
 * `model/rowCheckFormula.ts`): one `IF(ISNUMBER(<ref>),"n",...)&LEN(<ref>)
 * &":"&<ref>` term per
 * data column joined by `&"|"&`. The stub EVALUATES it lazily at read time
 * over the current row cells — mirroring the real API's PROVEN behavior
 * that a recalc is visible on the FIRST read after the batchUpdate that
 * changed a referenced cell, and that a cell-targeted `updateCells`
 * preserves the neighboring formula. Tokens are rendered by the SAME
 * contracts renderer the SQLite side uses, so the provider write/read pair
 * is exercised against the real encoding, not a stub re-implementation.
 */
const STUB_ROW_CHECK_TERM = /IF\(ISNUMBER\(([A-Z]+)(\d+)\),"n",/g;

/**
 * Computes one cell's wire representation (mask-filtered), evaluating
 * row-check token formulas into `effectiveValue`/`formattedValue` like
 * the real engine does.
 */
function stubCellWire(
  sheet: StubSheet,
  row: number,
  col: number,
  mask: StubMaskOptions,
): unknown {
  const cell = sheet.cell(row, col);
  const dataValidation = sheet.dataValidationFor(row, col);
  // Injected primitive/null CellData entries are malformed wire data and
  // must survive untouched so the provider's boundary guard fails closed on
  // them (the real API never emits one; injection fixtures do).
  if (cell === null || (cell !== undefined && typeof cell !== "object")) return cell;
  // Allowlisted rebuild: the response carries ONLY the CellData wrappers the
  // real API can emit, and only the ones the request's field mask names —
  // a stray wrapper in the stored model can never ride through unmasked.
  const wire: Record<string, unknown> = {};
  const formula = cell?.userEnteredValue?.formulaValue;
  if (cell !== undefined && cell.userEnteredValue !== undefined) {
    wire.userEnteredValue = cell.userEnteredValue;
  }
  // A supported row-check formula computes live; anything else keeps the
  // fixture-provided effectiveValue/formattedValue verbatim (the old
  // behavior hand-written fixtures rely on).
  const computed = typeof formula === "string"
    ? evaluateStubRowCheck(sheet, row, formula)
    : undefined;
  if (mask.includeEffectiveValue) {
    if (computed !== undefined) wire.effectiveValue = { stringValue: computed };
    else if (cell !== undefined && cell.effectiveValue !== undefined) {
      wire.effectiveValue = cell.effectiveValue;
    }
  }
  if (mask.includeFormattedValue) {
    if (computed !== undefined) wire.formattedValue = computed;
    else if (cell !== undefined && cell.formattedValue !== undefined) {
      wire.formattedValue = cell.formattedValue;
    }
  }
  if (mask.includeNumberFormats) {
    if (cell !== undefined && cell.userEnteredFormat !== undefined) {
      wire.userEnteredFormat = cell.userEnteredFormat;
    }
    // An injected effectiveFormat (malformed-shape fixture: the real API
    // COMPUTES effectiveFormat, so only fixtures carry one explicitly) rides
    // through under its real wrapper name for the boundary guard to catch.
    if (cell !== undefined && cell.effectiveFormat !== undefined) {
      wire.effectiveFormat = cell.effectiveFormat;
    } else if (wire.userEnteredValue !== undefined) {
      // The real API resolves a COMPUTED effectiveFormat for every populated
      // cell (that is what dominates preflight response bytes on the wire:
      // textFormat/alignment wrappers around the inherited number format),
      // and date-formatted cells carry the same canonical format in
      // effective. The stub mirrors that shape so byte guards measure the
      // real payload hierarchy instead of a toy minimum.
      wire.effectiveFormat = cell !== undefined && cell.userEnteredFormat !== undefined
        ? cell.userEnteredFormat
        : {
          numberFormat: { type: "TEXT", pattern: "@" },
          textFormat: {
            foregroundColorStyle: { rgbColor: {} },
            fontFamily: "Arial",
            fontSize: 10,
            bold: false,
            italic: false,
          },
          verticalAlignment: "BOTTOM",
        };
    }
  }
  if (dataValidation !== undefined && mask.includeDataValidation) {
    wire.dataValidation = dataValidation;
  }
  return wire;
}

/**
 * Evaluates one supported row-check token formula over the referenced
 * column span; returns undefined for any other formula text (fixtures keep
 * their stored shape). A referenced cell that is itself an unsupported
 * formula yields undefined too (passthrough, never a fake token).
 */
function evaluateStubRowCheck(
  sheet: StubSheet,
  row: number,
  formula: string,
): string | undefined {
  const refs = [...formula.matchAll(STUB_ROW_CHECK_TERM)];
  if (refs.length === 0) return undefined;
  const firstRef = refs[0];
  const lastRef = refs[refs.length - 1];
  if (firstRef === undefined || lastRef === undefined) return undefined;
  const writtenRow = firstRef[2];
  if (writtenRow === undefined || refs.some((ref) => ref[2] !== writtenRow)) {
    return undefined;
  }
  const firstCol = columnLettersToIndex(firstRef[1]!);
  const lastCol = columnLettersToIndex(lastRef[1]!);
  if (refs.length !== lastCol - firstCol + 1) return undefined;
  // Exact-shape guard: only the generator's own formula text computes; a
  // foreign formula resembling the shape stays fixture-passthrough.
  if (formula !== buildRowCheckFormula(firstCol + 1, lastCol + 1, Number(writtenRow))) {
    return undefined;
  }
  // A row shift (insert/deleteDimension) MOVES the formula cell but keeps
  // its written reference text; the real engine adjusts references. Mirror
  // the engine: resolve the referenced COLUMNS against the cell's ACTUAL
  // row so a shifted stub grid can never disagree with itself.
  const tokens: string[] = [];
  for (let col = firstCol; col <= lastCol; col += 1) {
    const cell = sheet.cell(row, col);
    const value = cell?.userEnteredValue;
    if (value === undefined) {
      tokens.push(renderRowCheckCell(null));
      continue;
    }
    if (typeof value.formulaValue === "string" || value.errorValue !== undefined) {
      return undefined;
    }
    const rendered = value.stringValue !== undefined
      ? { kind: "string" as const, value: value.stringValue }
      : value.numberValue !== undefined
        ? { kind: "number" as const, value: value.numberValue }
        : value.boolValue !== undefined
          ? { kind: "boolean" as const, value: value.boolValue }
          : null;
    tokens.push(renderRowCheckCell(rendered));
  }
  return tokens.join(SYNC_ROW_CHECK_DELIMITER);
}


/**
 * True when one `spreadsheets.get` requests a TAIL BAND of the receipt tab
 * (start row >= 2, i.e. below the header row). The historical full receipt
 * read starts at A1 and never matches, which is what lets the
 * `rejectBandedReceiptRange` fault target exactly the banded dispatch.
 */
function requestsBandedReceiptRange(request: GoogleSheetsApiGetSpreadsheetRequest): boolean {
  const pattern = new RegExp(`^'${GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME}'!A(?:[2-9]|[1-9]\\d+):`);
  return request.ranges.some((range) => pattern.test(range));
}

function rangeNamesSheet(range: string, title: string): boolean {
  const parsed = parseA1Range(range);
  return parsed !== undefined && parsed.sheetName === title;
}

interface ParsedA1Range {
  readonly sheetName: string;
  /** Inclusive 0-based start row of the requested band. */
  readonly startRow: number;
  /** Inclusive 0-based end row of the requested band. */
  readonly endRow: number;
  /** Inclusive 0-based start column of the requested band. */
  readonly startColumn: number;
  /** Inclusive 0-based end column of the requested band. */
  readonly endColumn: number;
}

function parseA1Range(range: string): ParsedA1Range | undefined {
  const match = /^'((?:[^']|'')*)'!([A-Za-z]+)(\d*):([A-Za-z]+)(\d*)$/.exec(range);
  if (match === null) return undefined;
  const [, name, startColumnText, startRowText, endColumnText, endRowText] = match;
  if (name === undefined || startColumnText === undefined || endColumnText === undefined) {
    return undefined;
  }
  return {
    sheetName: name.replace(/''/g, "'"),
    startColumn: columnLettersToIndex(startColumnText),
    endColumn: columnLettersToIndex(endColumnText),
    // Open row bounds mean the sheet's full height in the real API.
    startRow: startRowText === undefined || startRowText === "" ? 0 : Number(startRowText) - 1,
    endRow: endRowText === undefined || endRowText === "" ? 1_048_575 : Number(endRowText) - 1,
  };
}

/** Converts A1 column letters (A, B, ..., AA) to a 0-based index. */
function columnLettersToIndex(letters: string): number {
  let index = 0;
  for (const character of letters.toUpperCase()) {
    index = index * 26 + (character.charCodeAt(0) - 64);
  }
  return index - 1;
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
    case "addDimension": {
      // Grid growth only: the stub's sparse cell map never needs the extra
      // slots, but the reported gridProperties.columnCount must move so a
      // provisioning retry sees the width the real API would have grown to.
      const sheet = requireSheet(spreadsheet, request.sheetId);
      sheet.gridColumnCount = Math.max(sheet.gridColumns(), request.endIndex);
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

/** Shifts cells at/after `startRow` down by `count` rows. */
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
}

/** Computes the visible hash of a stub row over all headers (append rule). */
export function stubRowVisibleHash(
  sheet: StubSheet,
  rowNumber: number,
  headers: readonly string[],
): string {
  return computeSyncVisibleHash(stubRowFields(sheet, rowNumber, headers));
}
