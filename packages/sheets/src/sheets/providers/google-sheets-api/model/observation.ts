/**
 * Observation model: row-anchor planning and full snapshot building.
 *
 * These helpers port the Apps Script observation operation's semantics to
 * the REST wire shapes: nonblank rows are detected with the checkbox rule,
 * anchors come from the User_Input tab's LAST system column (cell values,
 * never developer metadata), and every cell is classified merged / error /
 * formula / literal / blank with the same precedence and the same stableHash
 * evidence as the Apps Script source, so snapshot hashes are byte-compatible
 * across providers. The system column is excluded from user-field cells,
 * blank-row detection, and visible hashes.
 *
 * Every untrusted SDK payload is validated by the preflight guards before it
 * reaches this module; all functions here fail closed on drift (header
 * mismatch, duplicate anchors) exactly like the Apps Script source throws.
 */

import { createHash, randomUUID } from "node:crypto";
import type { NormalizedCell } from "@hikoutei/contracts/encoding/types.js";
import type { Presence } from "@hikoutei/contracts/state/index.js";
import { presentValue, absentValue } from "@hikoutei/contracts/state/index.js";
import { stableHash } from "@hikoutei/contracts/encoding/index.js";
import {
  CELL_OBSERVATION_KINDS,
} from "@hikoutei/contracts/encoding/constants.js";
import type { StableValue } from "@hikoutei/contracts/encoding/types.js";
import {
  SYNC_PROTOCOL_VERSIONS,
  SYNC_SNAPSHOT_READ_MODES,
  type SyncSnapshotReadMode,
} from "@hikoutei/contracts/sheets/constants.js";
import type {
  SyncSheetsSnapshot,
  SyncSnapshotCell,
  SyncSnapshotRow,
} from "@hikoutei/contracts/sheets/syncSheets.js";
import { invalidProviderState, GET_REPLY_MALFORMED } from "../errors.js";
import type {
  GoogleSheetsApiTransport,
  GoogleSheetsApiGetSpreadsheetRequest,
} from "../transport/googleSheetsApiTransport.js";
import {
  columnLetters,
  quoteA1SheetName,
  parseRegisteredRange,
} from "./valueNormalization.js";
import {
  GOOGLE_SHEETS_API_ANCHOR_VALUE_PREFIX,
  GOOGLE_SHEETS_API_ROW_ID_HEADER,
} from "../constants.js";
import {
  readRegisteredHeaders,
} from "./preflightHeaders.js";
import { GOOGLE_SHEETS_API_OBSERVATION_FIELDS } from "./preflightFields.js";
import { parseSpreadsheetDocument, requireApiContainer } from "./preflightParsing.js";
import {
  apiCellNumberFormat,
  gridRowCells,
  readAnchorIndex,
  requireGridDataForSheet,
  requireSheetGrids,
  synthesizeScopedTargetGrid,
} from "./preflightRows.js";
import type {
  ParsedGridData,
  ParsedMergedCell,
  ParsedSheet,
} from "./preflightContext.js";
import {
  computedValueFromApiCell,
  isComputedBlankCell,
  observationLiteralFromApiValue,
} from "./valueNormalization.js";

/** One tab requested by an observation/table-read batch. */
export interface ObservationGridTarget {
  readonly sheetName: string;
  readonly registeredRange: string;
  /**
   * Optional row-level scoping (the check-column polling gate). When
   * present, the tab is read as the header row plus row bands covering
   * ONLY these 1-based physical rows (full registered width), and the
   * returned grid is the geometric synthesis of those bands: rows outside
   * the bands resolve blank and are skipped by every downstream rule. A
   * band plan that would exceed the shared per-request range budget
   * degrades to the historical whole-table range (correct by construction).
   */
  readonly rowNumbers?: readonly number[];
}

/** Validated grid plus sheet identity for one observed tab. */
export interface ObservedTab {
  readonly sheetId: number;
  readonly title: string;
  readonly grid: ParsedGridData;
  /** Merged regions of this tab (sheet-level `merges` GridRange entries). */
  readonly merges: readonly ParsedMergedCell[];
}

/** Anchor planning inputs shared by ensureRowAnchors and observation. */
export interface AnchorPlanningTarget {
  readonly registeredRange: string;
  readonly headers: readonly string[];
  /** §12 columnMap: adopted-route physical headers (see the definition type). */
  readonly physicalHeaders?: readonly string[];
  readonly checkboxHeaders: readonly string[];
  /**
   * 1-based absolute column of the system row-id column; `undefined` for
   * projections without one (no anchors are planned or read).
   */
  readonly anchorColumn: number | undefined;
}

/** One anchor write planned for a missing anchor. */
export interface PlannedAnchorWrite {
  /** 0-based row index for the updateCells request. */
  readonly rowIndex: number;
  readonly anchor: string;
}

/** Result of one anchor-planning pass over a tab grid. */
export interface AnchorPlanResult {
  readonly assigned: number;
  readonly existing: number;
  readonly duplicateAnchors: readonly {
    readonly anchor: string;
    readonly rowNumbers: readonly number[];
  }[];
  readonly planned: readonly PlannedAnchorWrite[];
}

/** Full snapshot inputs; the projection and schemaVersion are wire fields. */
export interface SnapshotBuildTarget extends AnchorPlanningTarget {
  readonly sheetName: string;
  readonly projection: string;
  readonly schemaVersion: number;
  readonly readMode: SyncSnapshotReadMode;
  /**
   * §12 columnMap: adopted-route physical headers, positionally parallel to
   * `headers`. When present the grid's header row is validated against them
   * while cells stay keyed by the canonical `headers` (field names).
   */
  readonly physicalHeaders?: readonly string[];
}

/**
 * Reads the grids of several registered tabs in ONE `spreadsheets.get`
 * call. Every requested tab must exist and return grid data; the result is
 * keyed by tab name. The `fields` mask decides which metadata comes back
 * (full observation mask or the lighter user_input mask); `timeoutMs`
 * overrides the transport's per-request timeout for read calls.
 */
export async function readTabGrids(
  transport: GoogleSheetsApiTransport,
  spreadsheetId: string,
  targets: readonly ObservationGridTarget[],
  fields: string = GOOGLE_SHEETS_API_OBSERVATION_FIELDS,
  timeoutMs?: number,
  /** Receives the RAW transport document before parsing — telemetry measures
   * the true response size from it (the parsed result is a Map, which does
   * not serialize meaningfully). */
  onRawResponse?: (raw: unknown) => void,
): Promise<ReadonlyMap<string, ObservedTab>> {
  const tabs = new Map<string, ObservedTab>();
  if (targets.length === 0) return tabs;
  const ranges: string[] = [];
  // Per-target request order is preserved so the parsed per-sheet grid list
  // can be synthesized back into one logical grid.
  const bandedTargets = new Map<string, { readonly range: { readonly startColumn: number; readonly columnCount: number } }>();
  for (const target of targets) {
    const parsed = parseRegisteredRange(target.registeredRange);
    const bandRanges = target.rowNumbers === undefined
      ? []
      : rowBandRanges(target.sheetName, parsed, target.rowNumbers);
    if (bandRanges.length === 0) {
      ranges.push(`${quoteA1SheetName(target.sheetName)}!A1:${rangeEndColumnLetters(target.registeredRange)}1048576`);
      continue;
    }
    bandedTargets.set(target.sheetName, { range: parsed });
    ranges.push(...bandRanges);
  }
  const request: GoogleSheetsApiGetSpreadsheetRequest = {
    spreadsheetId,
    ranges,
    fields,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
  const raw = await transport.getSpreadsheet(request);
  // Fail-open by construction: the callback is telemetry-only, so a throwing
  // callback must never break the read path (same contract as the sink).
  if (onRawResponse !== undefined) {
    try {
      onRawResponse(raw);
    } catch {
      // Swallowed deliberately — size estimation is observational only.
    }
  }
  const document = parseSpreadsheetDocument(raw, "observation grid");
  for (const target of targets) {
    const sheet = findSheetByTitle(document.sheets, target.sheetName);
    if (sheet === undefined) {
      // A structurally valid GET can simply lack the requested tab; this is
      // generic observation/anchor context with no missing-tab taxonomy pair,
      // so it keeps the safe unclassified default.
      invalidProviderState(`Registered sync sheet does not exist: ${target.sheetName}`);
    }
    const banded = bandedTargets.get(target.sheetName);
    if (banded !== undefined) {
      // Banded reads return one GridData per requested band; merge them
      // geometrically into one dense logical grid so the historical header,
      // blank-row, anchor, and cell-classification rules run unchanged over
      // the cells that were actually requested (same synthesis the scoped
      // preflight base read uses).
      const grids = requireSheetGrids(document, sheet.sheetId);
      tabs.set(target.sheetName, {
        sheetId: sheet.sheetId,
        title: sheet.title,
        grid: synthesizeScopedTargetGrid(grids, banded.range),
        merges: sheet.merges ?? [],
      });
      continue;
    }
    // Fail closed unless the reply carries exactly one GridData for the
    // requested range shape: a missing grid violated the structural
    // expectation and a multi-grid reply does not match this reader's
    // one-range-per-sheet request (same contract as requireGridDataForSheet).
    const grid = requireGridDataForSheet(document, sheet.sheetId);
    tabs.set(target.sheetName, {
      sheetId: sheet.sheetId,
      title: sheet.title,
      grid,
      merges: sheet.merges ?? [],
    });
  }
  return tabs;
}

/** Hard cap on ranges per `spreadsheets.get` (shared with preflight verify). */
const MAX_OBSERVATION_BAND_RANGES = 40;

/**
 * Header row + grouped contiguous row bands over the full registered width
 * for one banded observation read. Returns an empty array (the caller
 * degrades to the whole-table range) when there are no rows or the band
 * plan would overflow the per-request range budget.
 */
function rowBandRanges(
  sheetName: string,
  range: { readonly startColumn: number; readonly columnCount: number },
  rowNumbers: readonly number[],
): string[] {
  const sorted = [...new Set(rowNumbers.filter((row) => row >= 2))].sort((a, b) => a - b);
  if (sorted.length === 0) return [];
  const quote = quoteA1SheetName(sheetName);
  const firstLetter = columnLetters(range.startColumn);
  const lastLetter = columnLetters(range.startColumn + range.columnCount - 1);
  const bands: string[] = [`${quote}!${firstLetter}1:${lastLetter}1`];
  let runStart = sorted[0]!;
  let previous = runStart;
  for (let index = 1; index <= sorted.length; index += 1) {
    const row = sorted[index];
    if (row !== undefined && row === previous + 1) {
      previous = row;
      continue;
    }
    bands.push(`${quote}!${firstLetter}${runStart}:${lastLetter}${previous}`);
    if (row === undefined) break;
    runStart = row;
    previous = row;
  }
  if (bands.length > MAX_OBSERVATION_BAND_RANGES) return [];
  return bands;
}

function findSheetByTitle(
  sheets: readonly ParsedSheet[],
  title: string,
): ParsedSheet | undefined {
  return sheets.find((sheet) => sheet.title === title);
}

/**
 * Plans anchors for every nonblank data row of one tab grid. Rows with more
 * than one anchor fail closed; missing anchors get a fresh
 * `sync-anchor:<uuid>` value; duplicate anchors across rows are reported as
 * evidence (never rewritten). Blank rows are skipped, matching the Apps
 * Script ensureAnchorsFromValues_ behavior. The system column is validated
 * (fail-closed on legacy tabs) and its cell value is the anchor source.
 */
export function planRowAnchors(
  tab: ObservedTab,
  target: AnchorPlanningTarget,
): AnchorPlanResult {
  const range = parseRegisteredRange(target.registeredRange);
  const anchorColumn = target.anchorColumn;
  if (anchorColumn !== undefined) {
    // user_input tabs must carry the system column; a legacy tab (provisioned
    // by an older version) fails closed with the re-provision message instead
    // of being silently assigned anchors in a new column.
    readRegisteredHeaders(
      tab.grid,
      range,
      target.headers,
      GOOGLE_SHEETS_API_ROW_ID_HEADER,
      target.physicalHeaders,
    );
  }
  const anchorsByRow = readAnchorIndex(tab.grid, anchorColumn);
  const checkboxIndexes = checkboxColumnIndexes(target.headers, target.checkboxHeaders);
  const anchorRows = new Map<string, number[]>();
  let assigned = 0;
  let existing = 0;
  const planned: PlannedAnchorWrite[] = [];

  // Only user_input tabs carry anchors (system_state and sync_conflicts rows
  // are identity-located), so a tab without a system column never plans or
  // counts anchors.
  if (anchorColumn === undefined) {
    return { assigned, existing, duplicateAnchors: [], planned };
  }

  for (let rowIndex = 0; rowIndex < tab.grid.rowData.length; rowIndex += 1) {
    const rowNumber = tab.grid.startRow + 1 + rowIndex;
    if (rowNumber < 2) continue;
    const values = gridRowCells(tab.grid, rowNumber, range.startColumn, range.columnCount);
    // The system column is invisible to the blank-row rule.
    const userValues = anchorColumn === undefined
      ? values
      : values.slice(0, range.columnCount - 1);
    if (isBlankRow(userValues, checkboxIndexes)) continue;
    const anchors = anchorsByRow.get(rowNumber) ?? [];
    if (anchors.length > 1) {
      invalidProviderState(`row has multiple sync anchors: ${rowNumber}`);
    }
    const anchor = anchors[0];
    if (anchor === undefined) {
      const value = `${GOOGLE_SHEETS_API_ANCHOR_VALUE_PREFIX}${randomUUID()}`;
      planned.push({ rowIndex: rowNumber - 1, anchor: value });
      assigned += 1;
      anchorRows.set(value, [rowNumber]);
    } else {
      existing += 1;
      const rows = anchorRows.get(anchor) ?? [];
      rows.push(rowNumber);
      anchorRows.set(anchor, rows);
    }
  }

  return {
    assigned,
    existing,
    duplicateAnchors: duplicateAnchorsFrom(anchorRows),
    planned,
  };
}

/**
 * Builds one full snapshot from a validated tab grid with EXACT parity to
 * the Apps Script observation source: per-cell precedence merged -> error ->
 * formula -> literal/blank, stableHash evidence (including stableHash(null)
 * for blank cells), and a snapshotHash over the wire-shaped snapshot object
 * with presence fields serialized as null.
 */
export function buildSnapshotFromTab(
  tab: ObservedTab,
  target: SnapshotBuildTarget,
): SyncSheetsSnapshot {
  const range = parseRegisteredRange(target.registeredRange);
  const anchorColumn = target.anchorColumn;
  const headers = readRegisteredHeaders(
    tab.grid,
    range,
    target.headers,
    anchorColumn === undefined ? undefined : GOOGLE_SHEETS_API_ROW_ID_HEADER,
    target.physicalHeaders,
  );
  const lightweight = target.readMode === SYNC_SNAPSHOT_READ_MODES.USER_INPUT;
  const anchorsByRow = readAnchorIndex(tab.grid, anchorColumn);
  const checkboxIndexes = checkboxColumnIndexes(headers, target.checkboxHeaders);
  const merged = lightweight ? new Map<string, string>() : mergedRangesFor(tab);

  const rows: SyncSnapshotRow[] = [];
  const unanchoredRows: number[] = [];
  const anchorRows = new Map<string, number[]>();

  for (let rowIndex = 0; rowIndex < tab.grid.rowData.length; rowIndex += 1) {
    const rowNumber = tab.grid.startRow + 1 + rowIndex;
    if (rowNumber < 2) continue;
    const values = gridRowCells(tab.grid, rowNumber, range.startColumn, range.columnCount);
    // The system column is invisible to the blank-row rule.
    const userValues = anchorColumn === undefined
      ? values
      : values.slice(0, range.columnCount - 1);
    if (isBlankRow(userValues, checkboxIndexes)) continue;
    const anchors = anchorsByRow.get(rowNumber) ?? [];
    if (anchors.length > 1) {
      invalidProviderState(`row has multiple sync anchors: ${rowNumber}`);
    }
    const anchor = anchors[0];
    if (anchor === undefined) {
      unanchoredRows.push(rowNumber);
    } else {
      const grouped = anchorRows.get(anchor) ?? [];
      grouped.push(rowNumber);
      anchorRows.set(anchor, grouped);
    }

    const cells: Record<string, SyncSnapshotCell> = {};
    headers.forEach((header, columnIndex) => {
      const value = values[columnIndex];
      const column = range.startColumn + columnIndex;
      cells[header] = observeCell(
        value,
        lightweight,
        merged.get(`${rowNumber}:${column}`),
      );
    });
    rows.push({
      rowNumber,
      physicalAnchor: anchor === undefined ? absentValue() : presentValue(anchor),
      visibleRevision: absentValue(),
      visibleHash: absentValue(),
      cells,
    });
  }

  const snapshotHash = stableHash(toWireSnapshot(target, headers, rows) as StableValue);
  return {
    protocolVersion: SYNC_PROTOCOL_VERSIONS.V1,
    sheetName: target.sheetName,
    registeredRange: target.registeredRange,
    projection: target.projection as SyncSheetsSnapshot["projection"],
    schemaVersion: target.schemaVersion,
    headers,
    rows,
    snapshotHash,
    unanchoredRows,
    duplicateAnchors: duplicateAnchorsFrom(anchorRows),
  };
}

/**
 * Classifies one cell exactly like the Apps Script normalizeCellObservation_:
 * the formula hash is computed from the raw formula first (so a merged anchor
 * cell with a formula keeps its formulaHash), then merged / error / formula
 * precedence, then the literal/blank branch with stableHash evidence.
 */
function observeCell(
  value: unknown,
  lightweight: boolean,
  mergeRange: string | undefined,
): SyncSnapshotCell {
  // A null cell marks a position outside the row's values array (blank); any
  // other non-record is a malformed CellData wrapper that must fail closed
  // rather than silently becoming a blank cell.
  if (value === null) {
    return literalObservation(null, lightweight);
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    invalidProviderState("Sheet cell value is not an object", GET_REPLY_MALFORMED);
  }
  const record = value as Record<string, unknown>;
  const entered = requireApiContainer(record.userEnteredValue, "Sheet cell userEnteredValue must be an object");
  const enteredRecord = recordLike(entered);
  const formula = enteredRecord?.formulaValue;
  const formulaHash = typeof formula === "string" && formula.length > 0
    ? sha256Hex(formula)
    : null;
  const numberFormat = apiCellNumberFormat(value);

  if (mergeRange !== undefined) {
    return {
      cellKind: CELL_OBSERVATION_KINDS.MERGED,
      normalizedCell: null,
      formulaHash: presenceOrAbsent(formulaHash),
      mergeRange: presentValue(mergeRange),
      errorCode: absentValue(),
      stableHash: absentValue(),
    };
  }
  if (lightweight) {
    // The Apps Script lightweight branch reads raw values only: formulas
    // resolve to their computed value, error cells to their error string,
    // and the error regex runs against the stringified raw value.
    const raw = computedValueFromApiCell(value, numberFormat);
    const display = displayString(raw);
    if (isDisplayedSheetError(display)) {
      return {
        cellKind: CELL_OBSERVATION_KINDS.ERROR,
        normalizedCell: null,
        formulaHash: absentValue(),
        mergeRange: absentValue(),
        errorCode: presentValue(display),
        stableHash: absentValue(),
      };
    }
    return literalObservation(raw, true);
  }
  const formatted = record.formattedValue;
  if (typeof formatted === "string" && isDisplayedSheetError(formatted)) {
    return {
      cellKind: CELL_OBSERVATION_KINDS.ERROR,
      normalizedCell: null,
      formulaHash: presenceOrAbsent(formulaHash),
      mergeRange: absentValue(),
      errorCode: presentValue(formatted),
      stableHash: absentValue(),
    };
  }
  if (enteredRecord !== undefined && enteredRecord.errorValue !== undefined) {
    return {
      cellKind: CELL_OBSERVATION_KINDS.ERROR,
      normalizedCell: null,
      formulaHash: presenceOrAbsent(formulaHash),
      mergeRange: absentValue(),
      errorCode: presentValue(errorDisplayString(record)),
      stableHash: absentValue(),
    };
  }
  if (formula !== undefined) {
    if (typeof formula !== "string") {
      invalidProviderState("Sheet cell formulaValue is not a string", GET_REPLY_MALFORMED);
    }
    return {
      cellKind: CELL_OBSERVATION_KINDS.FORMULA,
      normalizedCell: null,
      formulaHash: presenceOrAbsent(formulaHash),
      mergeRange: absentValue(),
      errorCode: absentValue(),
      stableHash: absentValue(),
    };
  }
  const normalized = observationLiteralFromApiValue(entered, numberFormat);
  if (normalized === undefined) {
    // A non-empty userEnteredValue with no recognized value field maps to the
    // Apps Script "unsupported_cell_value" error observation.
    return {
      cellKind: CELL_OBSERVATION_KINDS.ERROR,
      normalizedCell: null,
      formulaHash: absentValue(),
      mergeRange: absentValue(),
      errorCode: presentValue("unsupported_cell_value"),
      stableHash: absentValue(),
    };
  }
  return literalObservation(normalized, lightweight);
}

/** Converts a raw formula hash (null = no formula) to a Presence value. */
function presenceOrAbsent(value: string | null): Presence<string> {
  return value === null ? absentValue() : presentValue(value);
}

/**
 * Blank or literal observation with stableHash evidence (stableHash(null)
 * included for blank cells, byte-compatible with the Apps Script codec).
 */
function literalObservation(
  normalized: NormalizedCell,
  lightweight: boolean,
): SyncSnapshotCell {
  return {
    cellKind: normalized === null
      ? CELL_OBSERVATION_KINDS.BLANK
      : CELL_OBSERVATION_KINDS.LITERAL,
    normalizedCell: normalized,
    formulaHash: absentValue(),
    mergeRange: absentValue(),
    errorCode: absentValue(),
    stableHash: lightweight ? absentValue() : presentValue(stableHash(normalized)),
  };
}

/** Stringifies one normalized cell the way String(getValues) would. */
function displayString(normalized: NormalizedCell): string {
  if (normalized === null) return "";
  switch (normalized.kind) {
    case "string":
      return normalized.value;
    case "number":
      return String(normalized.value);
    case "boolean":
      return String(normalized.value);
    case "date":
      return normalized.value;
  }
}

/** Apps Script isDisplayedSheetError_ regex over the display value. */
function isDisplayedSheetError(value: string): boolean {
  return /^#(REF!|DIV\/0!|N\/A|VALUE!|NAME\?|NUM!|ERROR!|NULL!)$/.test(value);
}

/** Resolves the display string of an error cell (formatted value or message). */
function errorDisplayString(record: Record<string, unknown>): string {
  const formatted = record.formattedValue;
  if (typeof formatted === "string" && formatted.length > 0) return formatted;
  const entered = requireApiContainer(record.userEnteredValue, "Sheet cell userEnteredValue must be an object");
  const enteredRecord = recordLike(entered);
  const error = enteredRecord?.errorValue;
  const errorRecord = requireApiContainer(error, "Sheet cell errorValue must be an object");
  const message = errorRecord?.message;
  if (typeof message === "string" && message.length > 0) return message;
  invalidProviderState("Sheet error cell has no display string", GET_REPLY_MALFORMED);
}

/**
 * Builds the wire-shaped snapshot object the Apps Script codec hashes:
 * presence fields become null, rows carry visibleRevision/visibleHash nulls.
 */
function toWireSnapshot(
  target: SnapshotBuildTarget,
  headers: readonly string[],
  rows: SyncSheetsSnapshot["rows"],
): unknown {
  return {
    protocolVersion: SYNC_PROTOCOL_VERSIONS.V1,
    sheetName: target.sheetName,
    registeredRange: target.registeredRange,
    projection: target.projection,
    schemaVersion: target.schemaVersion,
    headers,
    rows: rows.map((row) => ({
      rowNumber: row.rowNumber,
      physicalAnchor: presenceToNull(row.physicalAnchor),
      visibleRevision: null,
      visibleHash: null,
      cells: Object.fromEntries(
        headers.map((header) => {
          const cell = row.cells[header];
          if (cell === undefined) {
            invalidProviderState(`snapshot cell is missing for header: ${header}`);
          }
          return [header, toWireCell(cell)];
        }),
      ),
    })),
  };
}

/** Serializes one observed cell to the Apps Script wire shape. */
function toWireCell(cell: SyncSnapshotCell): unknown {
  return {
    cellKind: cell.cellKind,
    normalizedCell: cell.normalizedCell,
    formulaHash: presenceToNull(cell.formulaHash),
    mergeRange: presenceToNull(cell.mergeRange),
    errorCode: presenceToNull(cell.errorCode),
    stableHash: presenceToNull(cell.stableHash),
  };
}

function presenceToNull(presence: Presence<string>): string | null {
  return presence.kind === "present" ? presence.value : null;
}

/** Builds the sorted duplicate-anchor evidence from an anchor grouping. */
function duplicateAnchorsFrom(
  anchorRows: ReadonlyMap<string, readonly number[]>,
): readonly { readonly anchor: string; readonly rowNumbers: readonly number[] }[] {
  return [...anchorRows.entries()]
    .filter(([, rows]) => rows.length > 1)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([anchor, rows]) => ({
      anchor,
      rowNumbers: [...rows].sort((left, right) => left - right),
    }));
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

/** Apps Script isBlankRow_ over computed values with the checkbox rule. */
function isBlankRow(
  values: readonly unknown[],
  checkboxIndexes: ReadonlySet<number>,
): boolean {
  return values.every((value, index) =>
    isComputedBlankCell(value, checkboxIndexes.has(index)));
}

/** Builds the A1 range end letters for one registered range. */
function rangeEndColumnLetters(registeredRange: string): string {
  const range = parseRegisteredRange(registeredRange);
  return columnLetters(range.startColumn + range.columnCount - 1);
}

/**
 * Returns the merged ranges of one tab as 1-based A1 strings by cell
 * coordinate. Every covered cell maps to the A1 notation of the WHOLE
 * merged range, matching the Apps Script mergedCellMap_. The ranges come
 * from the sheet-level `merges` GridRange array, not from grid data.
 */
function mergedRangesFor(tab: ObservedTab): ReadonlyMap<string, string> {
  const byCell = new Map<string, string>();
  for (const merged of tab.merges) {
    const a1 = mergedRangeA1(merged.startRowIndex, merged.endRowIndex,
      merged.startColumnIndex, merged.endColumnIndex);
    for (let row = merged.startRowIndex + 1; row <= merged.endRowIndex; row += 1) {
      for (let column = merged.startColumnIndex + 1; column <= merged.endColumnIndex; column += 1) {
        byCell.set(`${row}:${column}`, a1);
      }
    }
  }
  return byCell;
}

/** Converts a 0-based exclusive GridRange to 1-based inclusive A1 notation. */
function mergedRangeA1(
  startRowIndex: number,
  endRowIndex: number,
  startColumnIndex: number,
  endColumnIndex: number,
): string {
  const startCell = `${columnLetters(startColumnIndex + 1)}${startRowIndex + 1}`;
  const endRow = endRowIndex;
  const endColumn = endColumnIndex;
  if (endRow === startRowIndex + 1 && endColumn === startColumnIndex + 1) {
    return startCell;
  }
  return `${startCell}:${columnLetters(endColumn)}${endRow}`;
}

/** sha256 hex of one formula literal (node:crypto, UTF-8). */
function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function recordLike(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}
