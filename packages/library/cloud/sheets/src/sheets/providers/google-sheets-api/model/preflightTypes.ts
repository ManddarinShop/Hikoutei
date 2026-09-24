/**
 * Shared declaration-only preflight types for the bulk preflight.
 *
 * This is a leaf module: it imports only external contract/engine types and
 * must never import sibling model helpers, so type-only consumers can depend
 * on it without closing an import cycle back to `preflightContext.ts`
 * (which owns the context assembly runtime). `preflightContext.ts`
 * re-exports these types from its old path for compatibility.
 */

import type { NormalizedCell } from "@hikoutei/contracts/encoding/types.js";
import type { Presence } from "@hikoutei/contracts/state/index.js";
import type { ReceiptReadCursor } from "@hikoutei/ikisaki";

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
  readonly cursor?: ReceiptReadCursor<PreflightReceipt>;
}
