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
  GOOGLE_SHEETS_API_ROW_CHECK_HEADER,
} from "../constants.js";
import {
  GOOGLE_SHEETS_API_ENUMERATION_FIELDS,
  GOOGLE_SHEETS_API_PREFLIGHT_BASE_FIELDS,
  GOOGLE_SHEETS_API_PREFLIGHT_FIELDS,
} from "./preflightFields.js";
import {
  GoogleSheetsApiTransportError,
  invalidProviderState,
} from "../errors.js";
import { PRESENCE_KINDS } from "@hikoutei/contracts/state/constants.js";
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
import type { ReceiptReadCursor } from "./receiptCursor.js";
import {
  authoritativeRowBound,
  packReadRequests,
  planRowBands,
  type EngineRuntime,
  type PlannedRange,
  type ReadCalibration,
  type ReadEvidence,
} from "./readPlan.js";
import {
  apiNumberValue,
  apiStringValue,
  parseSheetPropertiesDocument,
  parseSpreadsheetDocument,
} from "./preflightParsing.js";
import {
  anchorColumnFor,
  checkColumnFor,
  findSheetByTitle,
  gridRowCells,
  indexRows,
  pickRegisteredGrid,
  readRows,
  requireSheetByTitle,
  requireSheetGrids,
  requireSingleGrid,
  resolveGridCell,
  synthesizeScopedTargetGrid,
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
  /**
   * True when at least one row's identity cell normalized to a NUMBER under
   * the values-only base read. A number format (absent from the base mask)
   * could re-normalize such a cell to a canonical date and change its
   * identity string, so identity duplicate detection is deferred to the
   * format-aware verification pass and the identity column is re-read there.
   */
  readonly identityNeedsFormatEvidence: boolean;
  readonly checkboxHeaders: readonly string[];
  /**
   * True when the target rows came from a values-only column-scoped base
   * read (so the scoped verification pass owns their hash/identity evidence);
   * false for every whole-table full-evidence read and downgrade.
   */
  readonly scopedBase: boolean;
  /**
   * 1-based absolute column of the User_Input system row-id column; undefined
   * for projections without one (system_state, sync_conflicts).
   */
  readonly anchorColumn: number | undefined;
  /**
   * 1-based absolute column of a PROVISIONED row-check formula column (the
   * column directly after the registered range whose row-1 header cell is
   * exactly `__hikoutei_row_check`), or `undefined` when the route has no
   * verified check column (every non-user_input route, and user_input tabs
   * not yet re-provisioned). Appends write the row's token-join formula
   * ONLY
   * when this is present, so a legacy tab never receives stray formulas and
   * an out-of-bounds `updateCells` (which cannot grow the grid) can never
   * abort a batch because of this feature.
   */
  readonly checkColumn: number | undefined;
  readonly receiptSheetId: Presence<number>;
  /** Receipt tab last content row; 0 when the tab is absent. */
  readonly receiptLastRow: number;
  /**
   * 1-based row of the FIRST parsed receipt (undefined when the read held no
   * receipt row). A banded read starting at the cursor row is trusted only
   * when this equals the band start: the known-applied receipt there is the
   * sentinel proving the cursor has not run ahead of the tab.
   */
  readonly receiptFirstRow: number | undefined;
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
  /**
   * Grid dimensions when the requesting mask included gridProperties. The
   * REAL API returns exactly the dimensions the field mask named (proven
   * live: a `gridProperties(rowCount)`-only mask carries no columnCount),
   * so each dimension is optional; a present malformed wrapper fails closed.
   */
  readonly gridProperties?: {
    readonly rowCount?: number;
    readonly columnCount?: number;
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
  /**
   * Grid data per sheet, ONE ENTRY PER REQUESTED RANGE (the API returns a
   * separate GridData per range of the same sheet, proven against the real
   * API). Single-range readers take the first entry through
   * `requireGridDataForSheet`; the verification reader consumes the whole
   * list because it requests many row bands of one tab in one atomic call.
   */
  readonly grids: ReadonlyMap<number, readonly ParsedGridData[]>;
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
  /** Receives the RAW transport document before parsing — telemetry measures
   * the true response size from it (the parsed result loses wire detail). */
  onRawResponse?: (raw: unknown) => void,
): Promise<readonly ParsedSheet[]> {
  const enumerationRequest: GoogleSheetsApiGetSpreadsheetRequest = {
    spreadsheetId,
    ranges: [],
    fields: GOOGLE_SHEETS_API_ENUMERATION_FIELDS,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
  const enumerationRaw = await transport.getSpreadsheet(enumerationRequest);
  // Fail-open by construction: telemetry must never change a read outcome.
  if (onRawResponse !== undefined) {
    try {
      onRawResponse(enumerationRaw);
    } catch {
      // Swallowed deliberately — size estimation is observational only.
    }
  }
  return parseSheetPropertiesDocument(enumerationRaw, "sheet enumeration");
}

/**
 * Read-shape options for one steady-state preflight data read.
 *
 * `scoped` narrows every TARGET tab read from the full registered grid to
 * the columns the dispatch actually needs tab-wide: the header row (full
 * registered width, 1 row), the identity column (unbounded height, so
 * identity duplicate detection keeps its whole-tab proof), and the system
 * anchor column (unbounded height, so `byAnchor` and anchor-shift checks
 * stay complete). The planned write rows' full fields come from the scoped
 * verification read, which consumes the positions this base read produces.
 *
 * `cursor` enables the receipt TAIL band read inside the SAME data request
 * (it never adds a paced call): only rows at/after the cursor's
 * `bandStartRow()` are requested (the cursor row is re-read as a sentinel),
 * and every parsed receipt merges into the cursor's cumulative memo, which
 * the resulting contexts expose as their `receipts` view. Absent cursor,
 * cursor below the first data row, sentinel blank, or a clipped grid all
 * fall back to the historical full `A1:F1048576` receipt read,
 * byte-identical to the pre-cursor behavior. The cursor is used by BOTH the
 * scoped fast-append base read and the historical-shape apply preflight.
 */
export interface PreflightReadShape {
  readonly scoped: boolean;
  readonly cursor?: ReceiptReadCursor;
}

/** The historical whole-table read shape (every fallback/recovery path). */
export const LEGACY_PREFLIGHT_READ_SHAPE: PreflightReadShape = { scoped: false };

/**
 * Builds the PLANNED preflight ranges for one or more routes, deduplicating
 * target tabs and adding the shared receipt tab once. The multi-route call
 * reads ALL needed tabs, so the enumerations and ranged reads are shared
 * across the routes of one spreadsheet.
 *
 * Phase 1 (unified read engine): every all-row band is planned against the
 * authoritative row bound (`rowBounds`, the enumerated
 * `gridProperties.rowCount`) and chunked to the shared per-range cell cap
 * and per-request byte estimate. A span that fits one chunk collapses to
 * the byte-identical historical OPEN band (`X2:X1048576`); a tab whose bound
 * exceeds one chunk expands into sequential bands whose LAST band stays
 * open so a stale-low bound can never truncate coverage. With no bound for
 * a title (a transport that never reports `gridProperties`) the historical
 * single open band is planned unchanged (correct, un-banded).
 */
export function buildPreflightRanges(
  routes: readonly PreflightRouteOptions[],
  receiptSheet: ParsedSheet | undefined,
  shape: PreflightReadShape = LEGACY_PREFLIGHT_READ_SHAPE,
  receiptBandStart: number | undefined = undefined,
  rowBounds: ReadonlyMap<string, number> = new Map(),
  calibration: ReadCalibration | undefined = undefined,
  evidence: ReadEvidence = "values-only",
): readonly PlannedRange[] {
  const seen = new Set<string>();
  const ranges: PlannedRange[] = [];
  const push = (items: readonly PlannedRange[]): void => {
    for (const item of items) {
      if (seen.has(item.range)) continue;
      seen.add(item.range);
      ranges.push(item);
    }
  };
  for (const route of routes) {
    push(scopedOrFullTargetRanges(route, shape.scoped, rowBounds, calibration, evidence));
  }
  if (receiptSheet !== undefined) {
    const receiptQuote = `${quoteA1SheetName(GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME)}!`;
    push(planRowBands({
      quote: receiptQuote,
      firstLetter: "A",
      lastLetter: columnLetters(GOOGLE_SHEETS_API_RECEIPT_HEADERS.length),
      columnCount: GOOGLE_SHEETS_API_RECEIPT_HEADERS.length,
      fromRow: receiptBandStart === undefined || receiptBandStart < 2 ? 1 : receiptBandStart,
      rowBound: rowBounds.get(GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME),
      evidence,
      ...(calibration === undefined ? { calibration: NO_CALIBRATION } : { calibration }),
    }));
  }
  return ranges;
}

/** Planning stand-in for callers that pass no calibration (never inflates). */
const NO_CALIBRATION = {
  ratioFor: () => 1,
  observe: () => undefined,
} as const;

/**
 * True when one route's TARGET read is column-scoped (header row + key-column
 * bands) rather than full-width: only key-column routes can hide non-key row
 * content from the base read, so this selects where the scoped-mode guards
 * (format-evidence deferral, contiguity fallback) apply.
 */
export function routeUsesColumnScope(
  route: PreflightRouteOptions,
  scoped: boolean,
): boolean {
  if (!scoped) return false;
  if (route.identityField.kind === "present" &&
      route.headers.indexOf(route.identityField.value) >= 0) {
    return true;
  }
  return anchorColumnFor(route.registeredRange, route.projection) !== undefined;
}

/** One route's planned target ranges for the requested read shape. */
function scopedOrFullTargetRanges(
  route: PreflightRouteOptions,
  scoped: boolean,
  rowBounds: ReadonlyMap<string, number>,
  calibration: ReadCalibration | undefined,
  evidence: ReadEvidence,
): PlannedRange[] {
  const parsedRange = parseRegisteredRange(route.registeredRange);
  const lastColumn = parsedRange.startColumn + parsedRange.columnCount - 1;
  const quote = `${quoteA1SheetName(route.sheetName)}!`;
  const calib = calibration ?? NO_CALIBRATION;
  const bound = rowBounds.get(route.sheetName);
  const fullSpan = (): PlannedRange[] => planRowBands({
    quote,
    firstLetter: "A",
    lastLetter: columnLetters(lastColumn),
    columnCount: lastColumn,
    fromRow: 1,
    rowBound: bound,
    evidence,
    calibration: calib,
  });
  // A user_input route's read additionally probes the single cell where a
  // provisioned row-check column header would sit (one 1-cell band; the
  // header is the only evidence that separates "provisioned" from "legacy",
  // and the probe never grows any existing range).
  const checkProbe = checkColumnFor(route.registeredRange, route.projection);
  const checkProbeItem: PlannedRange[] = checkProbe === undefined
    ? []
    : [{
      range: `${quote}${columnLetters(checkProbe)}1:${columnLetters(checkProbe)}1`,
      cells: 1,
    }];
  if (!scoped) return [...fullSpan(), ...checkProbeItem];
  const lastLetter = columnLetters(lastColumn);
  const headerBand: PlannedRange[] = [{
    range: `${quote}A1:${lastLetter}1`,
    cells: lastColumn,
  }];
  const columns: number[] = [];
  if (route.identityField.kind === "present") {
    const offset = route.headers.indexOf(route.identityField.value);
    if (offset >= 0) columns.push(parsedRange.startColumn + offset);
  }
  const anchorColumn = anchorColumnFor(route.registeredRange, route.projection);
  if (anchorColumn !== undefined) columns.push(anchorColumn);
  // A route whose registered range holds NEITHER key column cannot prove
  // dedupe/append identity from a column-scoped read: keep the full span.
  if (columns.length === 0) return [...fullSpan(), ...checkProbeItem];
  const ranges: PlannedRange[] = [...headerBand];
  for (const column of new Set(columns)) {
    const letter = columnLetters(column);
    ranges.push(...planRowBands({
      quote,
      firstLetter: letter,
      lastLetter: letter,
      columnCount: 1,
      fromRow: 2,
      rowBound: bound,
      evidence,
      calibration: calib,
    }));
  }
  ranges.push(...checkProbeItem);
  return ranges;
}

/**
 * Reads the preflight document(s) and builds every route's context, applying
 * the receipt-read cursor and its cumulative receipt memo.
 *
 * Phase 1 (unified read engine): the logical read runs through the engine
 * runtime — the planned bands of one build() execute as SEQUENTIAL paced
 * requests on the lane's pacing class when the authoritative row bound
 * forces chunking, and the per-range grids reassemble into one logical
 * document before parsing. A small tab is still exactly ONE request
 * (byte-identical single open-ended ranges).
 *
 * A banded read is trusted only when a parsed receipt sits EXACTLY at the
 * cursor row (the sentinel: the last known-applied receipt, proving the
 * cursor has not run ahead of the tab). A blank/shifted sentinel, a missing
 * band grid, or a transport rejection of the banded range (e.g. a cursor
 * beyond a shrunk tab) falls back to ONE historical full receipt read —
 * the full read is itself band-planned against the receipt tab's bound and
 * its bands are merged through `readReceiptsAggregate` (one cross-band
 * header/duplicate contract, then the unchanged cursor ladder). A
 * successful read merges every parsed receipt into the cursor's cumulative
 * memo and advances the cursor to the parsed tail; the contexts then expose
 * the MEMO (not just the band), so a re-dispatched effect is
 * replay-recognizable no matter how many cursor advances have passed its
 * receipt row. The cursor is NEVER advanced by a write. Memo overflow or a
 * receipt-coverage conflict resets the cursor and settles coverage with one
 * full receipt read (see `ReceiptReadCursor`).
 *
 * Two scoped-mode downgrades keep their historical REPLACE-the-scoped-read
 * semantics (never stack), each re-planned through the engine:
 * - while the shared receipt tab does not exist yet, the scoped column read
 *   is replaced by the historical whole-table full-evidence read (the
 *   stale-receipt-init branch already spends the third read on the refresh);
 * - when a column-scoped route's visible key rows are NOT a contiguous run
 *   from row 2, rows whose non-key columns hold content cannot be proven
 *   absent, so the dispatch re-reads the whole table full-evidence and runs
 *   the historical fail-closed validation over it instead of scoping.
 */
async function readPreflightContextsWithCursor(
  engine: EngineRuntime,
  routes: readonly PreflightRouteOptions[],
  sheets: readonly ParsedSheet[],
  receiptSheet: ParsedSheet | undefined,
  operation: SyncMissingTabOperation | undefined,
  fields: string,
  shape: PreflightReadShape,
): Promise<Map<string, PreflightContext>> {
  // A scoped base read is only safe inside the leased call budget while the
  // receipt tab already exists: a receipt-init dispatch must not stack the
  // identity-band verification read on top of the refresh read, and the
  // full-evidence whole-table read needs no verification at all.
  const scopedDowngrade = shape.scoped && receiptSheet === undefined;
  const effectiveShape: PreflightReadShape = scopedDowngrade
    ? (shape.cursor === undefined ? LEGACY_PREFLIGHT_READ_SHAPE : { scoped: false, cursor: shape.cursor })
    : shape;
  const effectiveFields = scopedDowngrade ? GOOGLE_SHEETS_API_PREFLIGHT_FIELDS : fields;
  const cursor = effectiveShape.cursor;
  // Authoritative row bounds: the enumeration's committed
  // `gridProperties.rowCount` (exact for this dispatch), falling back to the
  // provider-instance cache the engine keeps warm from every response.
  const rowBounds = new Map<string, number>();
  const titles = routes.map((route) => route.sheetName);
  if (receiptSheet !== undefined) titles.push(receiptSheet.title);
  for (const title of titles) {
    const bound = authoritativeRowBound(sheets, engine.rowBounds, title);
    if (bound !== undefined) rowBounds.set(title, bound);
  }
  // At the memo ceiling the band would expose an incomplete coverage map:
  // drop the cursor FIRST so this dispatch already runs the historical full
  // receipt read (its parsed map is complete on its own).
  if (cursor !== undefined && cursor.isAtCapacity()) cursor.reset();
  const bandStart = receiptSheet === undefined ? undefined : cursor?.bandStartRow();
  const build = async (
    receiptBandStart: number | undefined,
    buildShape: PreflightReadShape = effectiveShape,
    buildFields: string = effectiveFields,
  ): Promise<Map<string, PreflightContext>> => {
    const evidence: ReadEvidence = buildFields === GOOGLE_SHEETS_API_PREFLIGHT_FIELDS
      ? "values+formats"
      : "values-only";
    const planned = buildPreflightRanges(
      routes, receiptSheet, buildShape, receiptBandStart,
      rowBounds, engine.calibration, evidence,
    );
    const get = engine.makeGet(buildFields, evidence);
    const dataDocument = await get(packReadRequests(planned, evidence, engine.calibration));
    const contexts = new Map<string, PreflightContext>();
    for (const route of routes) {
      contexts.set(
        route.sheetName,
        buildRouteContext(dataDocument, sheets, route, operation, buildShape, receiptBandStart),
      );
    }
    return contexts;
  };
  let contexts: Map<string, PreflightContext>;
  if (bandStart === undefined) {
    contexts = await build(undefined);
  } else {
    let bandRejected = false;
    contexts = await build(bandStart).catch(async (error: unknown) => {
      // A banded range the API itself rejects (e.g. a start row beyond the
      // tab's rows) is cursor evidence, not a read failure: drop the cursor
      // and settle coverage with the historical full read run right here.
      // Exactly ONE recovery read — the sentinel check below compares the
      // rejected band's start row, so it must not fire on this full-read
      // result and re-read the whole tab a second time.
      if (!isRejectedReadRange(error)) throw error;
      bandRejected = true;
      cursor?.reset();
      return build(undefined);
    });
    if (!bandRejected) {
      const sentinel = contexts.values().next().value;
      if (sentinel === undefined || sentinel.receiptFirstRow !== bandStart) {
        // Untrusted cursor: settle with the historical full read and re-base.
        cursor?.reset();
        contexts = await build(undefined);
      }
    }
  }
  if (effectiveShape.scoped && hasScopedKeyRowGap(routes, contexts)) {
    // A column-scoped route shows blank key cells INSIDE its content area:
    // rows carrying content only in non-key columns cannot be proven
    // absent, so `nextAppendRow` and the required-identity validation must
    // come from a whole-table full-evidence read (historical semantics).
    // This fallback REPLACES the scoped read (it never stacks on top of a
    // verification read: the full-evidence context disables verification).
    contexts = await build(undefined,
      effectiveShape.cursor === undefined
        ? LEGACY_PREFLIGHT_READ_SHAPE
        : { scoped: false, cursor: effectiveShape.cursor },
      GOOGLE_SHEETS_API_PREFLIGHT_FIELDS);
  }
  if (cursor !== undefined) {
    for (const context of contexts.values()) {
      if (!cursor.mergeParsed(context.receipts)) {
        invalidProviderState(
          `receipt tab changed underneath this provider: effectId reappeared with different evidence`,
        );
      }
      cursor.advanceTo(context.receiptLastRow);
    }
    if (cursor.isOverCapacity()) {
      // Past the memo ceiling this instance degrades to the pre-cursor
      // historical full-read behavior (the parsed maps below are complete
      // for this dispatch because the next read runs un-banded).
      cursor.reset();
    } else {
      // Expose the cumulative coverage, not just this band's rows.
      for (const [name, context] of [...contexts]) {
        contexts.set(name, { ...context, receipts: cursor.memoView() });
      }
    }
  }
  return contexts;
}

/**
 * True when a column-scoped route's visible content rows are not exactly the
 * contiguous run rows 2..n. The provider writes every registered header on
 * every append, so a key-blank row inside the content area means human
 * drift whose non-key columns cannot be inspected from the scoped bands.
 */
function hasScopedKeyRowGap(
  routes: readonly PreflightRouteOptions[],
  contexts: ReadonlyMap<string, PreflightContext>,
): boolean {
  for (const route of routes) {
    if (!routeUsesColumnScope(route, true)) continue;
    const context = contexts.get(route.sheetName);
    if (context === undefined || !context.scopedBase) continue;
    for (let index = 0; index < context.rows.length; index += 1) {
      if (context.rows[index]!.rowNumber !== index + 2) return true;
    }
  }
  return false;
}

/** True for a transport rejection that invalidates a banded read request. */
function isRejectedReadRange(error: unknown): boolean {
  return error instanceof GoogleSheetsApiTransportError &&
    error.status.kind === PRESENCE_KINDS.PRESENT &&
    error.status.value === 400;
}

/**
 * Builds one preflight context for a single route from an enumerated sheet
 * list. The data read runs through the engine runtime (paced band requests
 * on the lane the runtime was built for), so a chunked plan is sequential
 * but lands as ONE reassembled logical document for the context builders.
 */
export async function readPreflightData(
  engine: EngineRuntime,
  route: PreflightRouteOptions,
  sheets: readonly ParsedSheet[],
  /** Field mask override; defaults to the values-only base mask. The
   * oversized-verification fallback passes the full-evidence preflight mask
   * to reproduce the historical whole-table read exactly. */
  fields: string = GOOGLE_SHEETS_API_PREFLIGHT_BASE_FIELDS,
  /** Read shape; defaults to the historical whole-table read. */
  shape: PreflightReadShape = LEGACY_PREFLIGHT_READ_SHAPE,
): Promise<PreflightContext> {
  const receiptSheet = findSheetByTitle(sheets, GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME);
  const contexts = await readPreflightContextsWithCursor(
    engine, [route], sheets, receiptSheet, undefined, fields, shape,
  );
  const context = contexts.get(route.sheetName);
  if (context === undefined) {
    invalidProviderState(`preflight context is missing for ${route.sheetName}`);
  }
  return context;
}

/**
 * Executes the planned reads across ALL needed tabs and builds a
 * PreflightContext for each route (keyed by its sheetName), sharing the
 * read across the routes of one spreadsheet. `operation` classifies an
 * invalid provider state (e.g. a missing tab) detected while building a
 * route context.
 */
export async function readPreflightDataForRoutes(
  engine: EngineRuntime,
  routes: readonly PreflightRouteOptions[],
  sheets: readonly ParsedSheet[],
  operation?: SyncMissingTabOperation,
  /** Field mask override; defaults to the values-only base mask (see
   * `readPreflightData`). */
  fields: string = GOOGLE_SHEETS_API_PREFLIGHT_BASE_FIELDS,
  /** Read shape; defaults to the historical whole-table read (see
   * `readPreflightData`). */
  shape: PreflightReadShape = LEGACY_PREFLIGHT_READ_SHAPE,
): Promise<ReadonlyMap<string, PreflightContext>> {
  const receiptSheet = findSheetByTitle(sheets, GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME);
  return readPreflightContextsWithCursor(
    engine, routes, sheets, receiptSheet, operation, fields, shape,
  );
}

/** Builds one route's preflight context from an already-fetched document. */
export function buildRouteContext(
  dataDocument: ParsedSpreadsheetDocument,
  sheets: readonly ParsedSheet[],
  route: PreflightRouteOptions,
  operation?: SyncMissingTabOperation,
  shape: PreflightReadShape = LEGACY_PREFLIGHT_READ_SHAPE,
  receiptBandStart?: number,
): PreflightContext {
  const targetSheet = requireSheetByTitle(sheets, route.sheetName, operation);
  const receiptSheet = findSheetByTitle(sheets, GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME);
  const parsedRange = parseRegisteredRange(route.registeredRange);
  // Scoped reads return several 1-row/1-column grids per tab; merge them
  // geometrically into one dense logical grid so the historical header,
  // blank-row, anchor, and normalization rules run unchanged over the cells
  // that were actually requested.
  const targetGrids = requireSheetGrids(dataDocument, targetSheet.sheetId);
  const targetData = shape.scoped || targetGrids.length > 1
    // A banded full-shape read (chunked against the authoritative row
    // bound) returns one GridData per band; synthesize them into the one
    // dense logical grid the historical header/blank-row/anchor rules run
    // over, exactly like the scoped path. Single-grid full reads keep the
    // strict `pickRegisteredGrid` malformed-reply contract.
    ? synthesizeScopedTargetGrid(targetGrids, parsedRange)
    : pickRegisteredGrid(targetGrids, parsedRange, targetSheet.sheetId);
  const anchorColumn = anchorColumnFor(route.registeredRange, route.projection);
  // Row-check column evidence: the provisioned header cell directly after
  // the registered range (read from the dedicated 1-cell probe band). A
  // missing/foreign header means a legacy tab: appends skip the formula
  // write and polling keeps the historical whole-table observation.
  const checkColumnAbsolute = checkColumnFor(route.registeredRange, route.projection);
  const checkHeaderRaw = checkColumnAbsolute === undefined
    ? undefined
    : apiStringValue(resolveGridCell(targetGrids, 1, checkColumnAbsolute));
  const checkColumn = checkHeaderRaw === GOOGLE_SHEETS_API_ROW_CHECK_HEADER
    ? checkColumnAbsolute
    : undefined;
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
  const rows = readRows(targetData, parsedRange, headers, identityField, anchorColumn, shape.scoped);
  // A numeric identity cell read WITHOUT format evidence may normalize to a
  // canonical-date identity once its format is known (verification pass), so
  // a base-read identity duplicate is not yet provable: defer the fail-closed
  // duplicate check to the format-aware re-index. This deferral only applies
  // to the values-only scoped base read; every legacy/full-evidence read
  // carries formats and keeps the immediate historical check, and without any
  // numeric identity cell no format can change an identity either way.
  const identityNeedsFormatEvidence = shape.scoped
    && identityField.kind === "present"
    && rows.some((row) => row.cells[identityField.value]?.kind === "number");
  const {
    byAnchor,
    byIdentity,
    nextAppendRow,
  } = indexRows(rows, { deferIdentityDupFailClosed: identityNeedsFormatEvidence });

  const checkboxHeaders = validateCheckboxHeaders(route.checkboxHeaders, headers);

  let receipts: ReadonlyMap<string, PreflightReceipt> = new Map<string, PreflightReceipt>();
  let receiptLastRow = 0;
  let receiptFirstRow: number | undefined;
  let receiptSheetId: Presence<number> = absentValue();
  if (receiptSheet !== undefined) {
    receiptSheetId = presentValue(receiptSheet.sheetId);
    // A banded receipt read may legitimately return NO grid (the whole tab
    // tail is empty because the cursor ran ahead of the content); the
    // sentinel check in the reader turns that into the full-read fallback,
    // so it must not fail closed here. Full reads keep the strict lookup.
    const receiptGrids = receiptBandStart === undefined
      ? requireSheetGrids(dataDocument, receiptSheet.sheetId)
      : dataDocument.grids.get(receiptSheet.sheetId) ?? [];
    if (receiptBandStart === undefined && receiptGrids.length === 0) {
      // A full-shape read must answer with at least the header grid; an
      // empty grid list is the proven malformed reply (same contract the
      // historical `requireSingleGrid` enforced).
      requireSingleGrid(receiptGrids, receiptSheet.sheetId);
    }
    if (receiptGrids.length > 0) {
      // Cross-band aggregate: one header contract, one global duplicate
      // effectId check, and the EXACT aggregate first/last parsed rows the
      // cursor sentinel ladder trusts (see `readReceiptsAggregate`).
      const parsedReceipts = readReceiptsAggregate(receiptGrids);
      receipts = parsedReceipts.receipts;
      receiptLastRow = parsedReceipts.lastRow;
      receiptFirstRow = parsedReceipts.firstParsedRow;
    }
  }

  return {
    sheetId: targetSheet.sheetId,
    title: targetSheet.title,
    startColumn: parsedRange.startColumn,
    // The verification pass is only ever needed for (and only valid on) a
    // values-only column-scoped base context; downgraded/fallback contexts
    // already carry whole-table full evidence.
    scopedBase: shape.scoped,
    headers,
    positions,
    rows,
    byAnchor,
    byIdentity,
    nextAppendRow,
    identityField,
    identityNeedsFormatEvidence,
    checkboxHeaders,
    anchorColumn,
    checkColumn,
    receiptSheetId,
    receiptLastRow,
    receiptFirstRow,
    receipts,
    existingSheetIds: sheets.map((sheet) => sheet.sheetId),
  };
}

// ---------------------------------------------------------------------------
// Receipt parsing
// ---------------------------------------------------------------------------

/**
 * Aggregates the receipt grids of ONE logical receipt read (a full or banded
 * tail read may span several sequential band requests; each band is one
 * GridData in request order).
 *
 * The aggregate preserves the EXACT contract a single-grid `readReceipts`
 * parse gives the cursor ladder, so band-splitting can never weaken
 * dedupe/replay:
 * - the header is validated fail-closed exactly when the FIRST grid starts
 *   at the header row (a full read validates once, on band one; tail bands
 *   start below the header and never check it);
 * - a duplicate effectId ANYWHERE across the bands fails closed, exactly
 *   like an in-band duplicate (the append-only tab has no legal duplicate);
 * - the result carries the ordered merged map plus the aggregate's EXACT
 *   first parsed row (the first nonblank receipt row of the first band that
 *   holds one — the value the cursor sentinel compares against
 *   `bandStartRow`) and last content row across all bands.
 */
export function readReceiptsAggregate(grids: readonly ParsedGridData[]): {
  readonly receipts: ReadonlyMap<string, PreflightReceipt>;
  readonly lastRow: number;
  readonly firstParsedRow: number | undefined;
} {
  const receipts = new Map<string, PreflightReceipt>();
  let lastRow = 1;
  let firstParsedRow: number | undefined;
  for (const grid of grids) {
    const parsed = readReceipts(grid);
    lastRow = Math.max(lastRow, parsed.lastRow);
    if (firstParsedRow === undefined) firstParsedRow = parsed.firstParsedRow;
    for (const [effectId, receipt] of parsed.receipts) {
      if (receipts.has(effectId)) {
        invalidProviderState(`receipt sheet contains duplicate effectId: ${effectId}`);
      }
      receipts.set(effectId, receipt);
    }
  }
  return { receipts, lastRow, firstParsedRow };
}

/**
 * Parses and validates the hidden receipt tab grid.
 *
 * Accepts a FULL grid (starts at the header row; the header is validated
 * fail-closed exactly like the historical read) or a TAIL BAND grid (starts
 * at or after row 2; no header check is possible, and every returned row is
 * parsed as a receipt). `firstParsedRow` lets the reader verify the band
 * sentinel (a parsed receipt exactly at the cursor row) before trusting the
 * band coverage.
 */
export function readReceipts(data: ParsedGridData): {
  readonly receipts: ReadonlyMap<string, PreflightReceipt>;
  readonly lastRow: number;
  readonly firstParsedRow: number | undefined;
} {
  const banded = data.startRow > 0;
  if (!banded) {
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
  }

  const receipts = new Map<string, PreflightReceipt>();
  let firstParsedRow: number | undefined;
  let lastRow = Math.max(1, data.startRow + data.rowData.length);
  for (let rowIndex = banded ? 0 : 1; rowIndex < data.rowData.length; rowIndex += 1) {
    const rawRow = data.rowData[rowIndex];
    if (rawRow === undefined) continue;
    const rowNumber = data.startRow + 1 + rowIndex;
    const values = gridRowCells(data, rowNumber, 1, GOOGLE_SHEETS_API_RECEIPT_HEADERS.length);
    const first = stringCellValue(values[0]);
    if (first === null) continue;
    const effectId = first;
    firstParsedRow ??= rowNumber;
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
  return { receipts, lastRow, firstParsedRow };
}

function stringCellValue(value: unknown): string | null {
  const raw = apiStringValue(value);
  return raw === undefined ? null : raw;
}

function numberCellValue(value: unknown): number | null {
  const raw = apiNumberValue(value);
  return raw === undefined ? null : raw;
}
