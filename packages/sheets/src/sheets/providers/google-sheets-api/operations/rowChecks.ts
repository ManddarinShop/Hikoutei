/**
 * Narrow row-check read for the formula check-column polling gate.
 *
 * Reads ONLY three single-column bands of each requested User_Input tab —
 * the identity (business-key) column, the system row-id (anchor) column,
 * and the row-check formula column — in ONE paced `spreadsheets.get` with a
 * values-only mask. At the 300-row/3-data-column stub scale the gated read
 * is ~500 bytes/row (dominated by the formula text the provenance check
 * transfers) versus ~1.25 KB/row for the historical whole-table
 * metadata-preserving observation on the same fixtures — and the REAL
 * observation read carries far heavier per-cell format wrappers (the live
 * polling pass measured 2.95 MB before this gate). The polling side diffs
 * each returned check string against the value derived from canonical
 * SQLite state and escalates ONLY mismatched rows to a targeted full-field
 * snapshot read, so clean tabs never read a data column.
 *
 * Row mapping uses the visible identity column: it is the key inbound
 * inspection already resolves by (business key → entity → canonical state),
 * and unlike the system row-id column it exists for every system-written
 * AND human-typed row, keeping unknown/duplicate-identity detection exact.
 * The anchor band is read ALONGSIDE it so a clean poll can still prove the
 * system row-id cell was not deleted, duplicated, or moved off its row —
 * the provider reports the observed anchor value and the polling gate
 * escalates any anomaly to the whole-table observation (the authoritative
 * row-mapping/orphan-evidence path).
 *
 * Check evidence carries FORMULA PROVENANCE: a row's check string is
 * reported ONLY when the check cell still holds the EXACT system-generated
 * formula for that row. A human (or paste) that replaced the cell with a
 * literal equal to the current expected string, a foreign formula, or a
 * blank cell yields NO check evidence, so the gate can never be satisfied
 * by a stale copy and the row falls through to the full-field read.
 *
 * `status` is `checks_unavailable` when the tab has no provisioned check
 * column (the cell directly after the registered range does not carry the
 * `__hikoutei_row_check` header); callers then fall back to the historical
 * whole-table observation for that tab (mixed mode). A missing tab or a
 * malformed payload fails closed like every other provider read.
 */

import type { NormalizedCell } from "@hikoutei/contracts/encoding/types.js";
import type {
  ReadSyncRowChecksRequest,
  SyncRowCheckRow,
  SyncRowChecksResult,
} from "@hikoutei/contracts/sheets/syncSheets.js";
import { absentValue, presentValue } from "@hikoutei/contracts/state/index.js";
import { SYNC_ROW_CHECK_HEADER } from "@hikoutei/contracts/sheets/rowCheck.js";
import { SYNC_PROJECTIONS } from "@hikoutei/contracts/sheets/constants.js";
import { GOOGLE_SHEETS_API_ROW_CHECK_FIELDS } from "../model/preflightFields.js";
import { invalidProviderRequest } from "../errors.js";
import type { ParsedGridData } from "../model/preflightContext.js";
import { apiStringValue } from "../model/preflightParsing.js";
import {
  anchorColumnFor,
  anchorFromColumnValue,
  apiCellNumberFormat,
  checkColumnFor,
  resolveGridCell,
} from "../model/preflightRows.js";
import { buildRowCheckFormula } from "../model/rowCheckFormula.js";
import {
  columnLetters,
  computedValueFromApiCell,
  parseRegisteredRange,
  quoteA1SheetName,
} from "../model/valueNormalization.js";
import {
  definitionForPhysicalSheet,
  validateRoute,
  type GoogleSheetsApiProviderDeps,
} from "./shared.js";
import { createBandedGet, ensureSheetRowBounds } from "./readEngine.js";
import {
  packReadRequests,
  planRowBands,
  type PlannedRange,
  type ReadEvidence,
} from "../model/readPlan.js";

/** Reads several registered tabs' check bands through ONE REST read. */
export async function readRowChecksBatch(
  deps: GoogleSheetsApiProviderDeps,
  requests: readonly ReadSyncRowChecksRequest[],
): Promise<readonly SyncRowChecksResult[]> {
  if (requests.length === 0) return [];
  const routes = requests.map((request) => {
    const definition = definitionForPhysicalSheet(deps, request.physicalSheetId);
    validateRoute(request, definition);
    if (request.projection !== SYNC_PROJECTIONS.USER_INPUT) {
      invalidProviderRequest(
        "row-check read",
        `row checks require the user_input projection: ${request.physicalSheetId}`,
      );
    }
    const identityColumn = definition.headers.indexOf(request.identityField);
    if (identityColumn < 0) {
      invalidProviderRequest(
        "row-check read",
        `identity field is not a registered header: ${request.identityField}`,
      );
    }
    const range = parseRegisteredRange(request.registeredRange);
    const checkColumn = checkColumnFor(request.registeredRange, request.projection);
    if (checkColumn === undefined) {
      invalidProviderRequest("row-check read", "registered range has no check column slot");
    }
    const anchorColumn = anchorColumnFor(request.registeredRange, request.projection);
    if (anchorColumn === undefined) {
      invalidProviderRequest("row-check read", "registered range has no anchor column");
    }
    return {
      request,
      identityAbsolute: range.startColumn + identityColumn,
      anchorAbsolute: anchorColumn!,
      // The system formula spans the user data columns only: range start
      // through the column BEFORE the trailing system row-id column (which
      // is directly left of the check column).
      firstDataColumn: range.startColumn,
      lastDataColumn: checkColumn! - 2,
      checkAbsolute: checkColumn!,
    };
  });
  // Three narrow column bands per tab (identity + anchor + check), headers
  // included so the row-1 cells decide check-column availability. Unified
  // read engine: each column band is chunked against the tab's authoritative
  // row bound (cold titles settled by one polling-lane metadata enumeration)
  // and the chunks run as sequential paced polling requests, each ≤ 40
  // ranges ∧ ≤ the row-checks byte estimate — a 30k-row tab no longer pins
  // one 3 × 1048576-cell request to the 10 s read timeout. The LAST band of
  // every column stays open-ended, so a human row added past the cached
  // bound between refreshes is still served (in the last band).
  const evidence: ReadEvidence = "row-checks";
  await ensureSheetRowBounds(deps, "polling", routes.map((route) => route.request.sheetName));
  const items: PlannedRange[] = [];
  for (const route of routes) {
    const quote = `${quoteA1SheetName(route.request.sheetName)}!`;
    const rowBound = deps.sheetRowBounds.get(route.request.sheetName);
    for (const column of [route.identityAbsolute, route.anchorAbsolute, route.checkAbsolute]) {
      const letter = columnLetters(column);
      items.push(...planRowBands({
        quote,
        firstLetter: letter,
        lastLetter: letter,
        columnCount: 1,
        fromRow: 1,
        rowBound,
        evidence,
        calibration: deps.readCalibration,
      }));
    }
  }
  const get = createBandedGet(deps, "polling", GOOGLE_SHEETS_API_ROW_CHECK_FIELDS, evidence, "row-check read");
  const document = await get(packReadRequests(items, evidence, deps.readCalibration));
  return routes.map((route) => {
    const sheet = document.sheets.find((candidate) =>
      candidate.title === route.request.sheetName);
    if (sheet === undefined) {
      invalidProviderRequest(
        "row-check read",
        `registered sync sheet does not exist: ${route.request.sheetName}`,
      );
    }
    const grids = document.grids.get(sheet!.sheetId) ?? [];
    return buildRowChecksResult(route, grids);
  });
}

/** Normalizes one requested band's cells into a row-check result. */
function buildRowChecksResult(
  route: {
    readonly request: ReadSyncRowChecksRequest;
    readonly identityAbsolute: number;
    readonly anchorAbsolute: number;
    readonly firstDataColumn: number;
    readonly lastDataColumn: number;
    readonly checkAbsolute: number;
  },
  grids: readonly ParsedGridData[],
): SyncRowChecksResult {
  // Availability = the provisioned header cell directly after the range.
  // Anything else (absent, blank, foreign) is a legacy/collision tab.
  const checkHeader = apiStringValue(
    resolveGridCell(grids, 1, route.checkAbsolute),
  );
  const status = checkHeader === SYNC_ROW_CHECK_HEADER
    ? "checks_available" as const
    : "checks_unavailable" as const;
  let maxRow = 1;
  for (const grid of grids) {
    maxRow = Math.max(maxRow, grid.startRow + grid.rowData.length);
  }
  const rows: SyncRowCheckRow[] = [];
  for (let rowNumber = 2; rowNumber <= maxRow; rowNumber += 1) {
    const identityCell = resolveGridCell(grids, rowNumber, route.identityAbsolute);
    const checkCell = resolveGridCell(grids, rowNumber, route.checkAbsolute);
    const identity = toComputedCell(identityCell);
    const anchor = anchorFromColumnValue(
      resolveGridCell(grids, rowNumber, route.anchorAbsolute),
    );
    const checkText = provenCheckText(checkCell, route, rowNumber);
    // A row is visible when the identity or check band holds content —
    // EXACTLY the historical rule where an anchor-only row stays invisible
    // to every read (the system row-id column never marks content).
    // Key-blank drift inside the content area surfaces to the caller as an
    // invalid identity (the polling decision escalates it); rows hidden
    // entirely below the last visible row are the documented scoped-read
    // ceiling the periodic forceFull safety scan covers (see
    // preflightRows.ts readRows docs).
    if (identity === null && checkText === null) continue;
    rows.push({
      rowNumber,
      identity,
      anchor: anchor === undefined ? absentValue() : presentValue(anchor),
      check: checkText === null ? absentValue() : presentValue(checkText),
    });
  }
  return {
    sheetName: route.request.sheetName,
    registeredRange: route.request.registeredRange,
    status,
    rows,
  };
}

/** Values-only (getValues) normalization of one band cell. */
function toComputedCell(cell: unknown): NormalizedCell {
  if (cell === null) return null;
  return computedValueFromApiCell(cell, apiCellNumberFormat(cell));
}

/**
 * Display string of one check cell, gated on FORMULA PROVENANCE: the cell
 * must still carry the EXACT system-generated row formula (the mask
 * returns `userEnteredValue.formulaValue` for formula cells). A literal
 * replacement, a foreign formula, or a blank cell yields `null` — no check
 * evidence — so a pasted stale string can never pass the gate, and the
 * gate's absent-check rule routes the row to the full-field read.
 */
function provenCheckText(
  cell: unknown,
  route: { readonly firstDataColumn: number; readonly lastDataColumn: number },
  rowNumber: number,
): string | null {
  if (cell === null || typeof cell !== "object") return null;
  const entered = (cell as Record<string, unknown>).userEnteredValue;
  const formula = entered !== null && typeof entered === "object"
    ? (entered as Record<string, unknown>).formulaValue
    : undefined;
  if (typeof formula !== "string"
    || formula !== buildRowCheckFormula(
      route.firstDataColumn,
      route.lastDataColumn,
      rowNumber,
    )) {
    return null;
  }
  const value = toComputedCell(cell);
  if (value === null) return null;
  if (value.kind === "string") return value.value;
  return String(value.value);
}
