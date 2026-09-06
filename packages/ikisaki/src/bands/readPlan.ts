/**
 * Pure read planning for the unified read engine (design/unified-read-engine.md).
 *
 * Every read lane (polling observation, preflight base, verification/probe)
 * historically built its own A1 ranges with unbounded row extent
 * (`X2:X1048576`), so each lane's largest single request grew with the
 * accumulated data and the 30k-row burst stress pushed all three lanes into
 * the 10 s read timeout at once. This module is the SINGLE planner those
 * lanes route through: given an authoritative committed row bound
 * (`gridProperties.rowCount` from the sheet's own enumeration), a column
 * span, and an evidence class, it emits row bands that never exceed the
 * shared per-range cell cap or the per-request byte estimate, and packs the
 * bands into at most `MAX_READ_RANGES_PER_REQUEST` ranges per request.
 *
 * Safety rules baked into the planning contract:
 * - The bound is an upper bound on what a read can return (content ≤ grid
 *   rows always holds at snapshot time); a too-low cached bound can never
 *   truncate coverage because the LAST band of every banded column stays
 *   open-ended (`<start>:<end>1048576`) unless the caller proves the row
 * * extent itself (explicit row sets and the verification spans, which are
 *   bounded by their own maximum row number).
 * - Byte estimates are deliberately conservative (each class constant is
 *   ≥ 2× the measured live average) and a per-class telemetry-calibrated
 *   multiplier only ever GROWS them: a mispredict shrinks the next pass's
 *   bands, it never loops or grows one request.
 * - Small tabs collapse to exactly one open-ended band per column, i.e. the
 *   byte-identical historical ranges; chunking activates only when the
 *   authoritative bound exceeds one chunk.
 */

import type { ParsedGridData, ParsedSheet, ParsedSpreadsheetDocument } from "./preflightContext.js";

/** Current hard grid limit of a real spreadsheet (1-based). */
export const SHEET_MAX_ROW = 1_048_576;

/**
 * Hard cap on cells per requested range, shared by EVERY lane (the API's
 * ~10 000-cell request-shape limit with margin; previously only the
 * verification lane enforced it).
 */
export const MAX_READ_CELLS_PER_RANGE = 9_500;

/**
 * Hard cap on ranges per `spreadsheets.get`, shared by every lane (unifies
 * the former `MAX_OBSERVATION_BAND_RANGES` / `MAX_VERIFY_RANGES_PER_REQUEST`).
 */
export const MAX_READ_RANGES_PER_REQUEST = 40;

/**
 * Per-BAND ESTIMATE target in bytes: one band plans to at most this many
 * estimated bytes (the chunking gate). A planning threshold, not a transport
 * guarantee: the constants below are conservative and the calibration
 * multiplier shrinks future bands whenever measured bytes/cell exceed the
 * estimate.
 */
export const READ_SOFT_TARGET_BYTES = 3_000_000;

/**
 * Per-request ESTIMATE ceiling: packed requests add bands until the summed
 * estimate would exceed this (each individual band is already ≤ the soft
 * target, so a request holds 1-2 near-maximal bands). With the ≥ 2× safety
 * margin baked into BYTES_PER_CELL the REAL response lands well under the
 * figure that streamed past the 10 s budget at the observed average.
 */
export const READ_HARD_MAX_BYTES = 5_000_000;

/**
 * Cell-evidence classes → conservative per-cell JSON byte estimates.
 * Each value is ≥ 2× the measured live `responseBytes ÷ cellsRequested`
 * average for its wire mask (~107–210 B/cell preflight/observation classes,
 * ~163 B/cell-band row-checks).
 * ponytail: fixture-scale calibration; recalibrate from live telemetry if
 * planning mispredicts > 2×.
 */
export const READ_BYTES_PER_CELL: Readonly<Record<ReadEvidence, number>> = {
  "values-only": 120,
  "row-checks": 400,
  "values+formats": 400,
  "rendering-complete": 450,
};

/** The evidence class of one planned read (drives bytes/cell + calibration). */
export type ReadEvidence =
  | "values-only"
  | "row-checks"
  | "values+formats"
  | "rendering-complete";

/** One planned A1 band plus the requested-cell count it plans to spend. */
export interface PlannedRange {
  /** A1 text (possibly open-ended `…1048576` for the last band of a column). */
  readonly range: string;
  /** Planned cells (bound-based estimate input; 0 when no bound is known). */
  readonly cells: number;
}

/**
 * Per-evidence-class calibration multiplier (≥ 1, capped). The engine
 * observes `responseBytes ÷ cellsRequested` per request; when the observed
 * bytes/cell exceed the class constant, future plans inflate their estimate
 * (smaller bands next pass). Never shrinks below the constant.
 */
export interface ReadCalibration {
  ratioFor(evidence: ReadEvidence): number;
  observe(evidence: ReadEvidence, cellsRequested: number, responseBytes: number): void;
}

/** Safety margin applied to the observed bytes/cell ratio. */
const CALIBRATION_SAFETY = 1.5;
/** Ceiling for one class's multiplier (bounds a pathological sample's damage). */
const CALIBRATION_MAX_RATIO = 20;

/** Builds a fresh provider-instance calibration tracker. */
export function createReadCalibration(): ReadCalibration {
  const ratios = new Map<ReadEvidence, number>();
  return {
    ratioFor: (evidence) => ratios.get(evidence) ?? 1,
    observe: (evidence, cellsRequested, responseBytes) => {
      if (cellsRequested <= 0 || responseBytes <= 0) return;
      const observed = responseBytes / cellsRequested / READ_BYTES_PER_CELL[evidence];
      const next = Math.min(
        CALIBRATION_MAX_RATIO,
        Math.max(ratios.get(evidence) ?? 1, observed * CALIBRATION_SAFETY),
      );
      ratios.set(evidence, next);
    },
  };
}

/** Estimated bytes for one planned band under the current calibration. */
export function estimatedRangeBytes(
  item: PlannedRange,
  evidence: ReadEvidence,
  calibration: ReadCalibration,
): number {
  return item.cells * READ_BYTES_PER_CELL[evidence] * calibration.ratioFor(evidence);
}

/** Rows one band of `columnCount` columns may request under both caps. */
export function rowsPerBand(
  columnCount: number,
  evidence: ReadEvidence,
  calibration: ReadCalibration,
): number {
  const cellBudget = Math.floor(
    READ_SOFT_TARGET_BYTES /
      (READ_BYTES_PER_CELL[evidence] * calibration.ratioFor(evidence)),
  );
  return Math.max(
    1,
    Math.floor(Math.min(MAX_READ_CELLS_PER_RANGE, cellBudget) / Math.max(1, columnCount)),
  );
}

/** Input for one column-span's row banding. */
export interface RowBandPlan {
  /** Quoted A1 sheet prefix INCLUDING the `!` (e.g. `'Users'!`). */
  readonly quote: string;
  readonly firstLetter: string;
  readonly lastLetter: string;
  readonly columnCount: number;
  /** First 1-based row to cover (1 includes the header row, 2 data only). */
  readonly fromRow: number;
  /**
   * Authoritative committed row bound (`gridProperties.rowCount`), or
   * `undefined` when no bound is known — then the lane keeps its historical
   * single open-ended band (correct, un-banded; the bound-driven chunking
   * activates exactly when an authoritative bound exists).
   */
  readonly rowBound: number | undefined;
  /** Upper row when the CALLER proves the extent (explicit row sets); the
   * last band then closes at this row instead of staying open-ended. */
  readonly exactLastRow?: number;
  readonly evidence: ReadEvidence;
  readonly calibration: ReadCalibration;
}

/**
 * Plans the row bands for one column span: contiguous chunks of at most
 * `rowsPerBand` rows and `MAX_READ_CELLS_PER_RANGE` cells each. The final
 * band stays OPEN (`:1048576`) so a stale-low bound can never truncate
 * coverage — unless the caller proved the extent via `exactLastRow`. A span
 * that fits one chunk collapses to the byte-identical historical single
 * open-ended range.
 */
export function planRowBands(plan: RowBandPlan): PlannedRange[] {
  const { quote, firstLetter, lastLetter, columnCount, fromRow, rowBound, exactLastRow, evidence, calibration } = plan;
  const lastRow = exactLastRow ?? rowBound;
  if (lastRow === undefined || lastRow < fromRow) {
    // No bound (legacy/unenumerated transport) or nothing to read: the
    // historical single open band; cells 0 keeps it out of byte packing
    // (it was never chunkable without a bound anyway).
    return [{
      range: `${quote}${firstLetter}${fromRow}:${lastLetter}${SHEET_MAX_ROW}`,
      cells: rowBound !== undefined && rowBound >= fromRow
        ? (Math.min(rowBound, lastRow ?? rowBound) - fromRow + 1) * columnCount
        : 0,
    }];
  }
  const rows = rowsPerBand(columnCount, evidence, calibration);
  const items: PlannedRange[] = [];
  let start = fromRow;
  while (start + rows - 1 < lastRow) {
    const end = start + rows - 1;
    items.push({
      range: `${quote}${firstLetter}${start}:${lastLetter}${end}`,
      cells: rows * columnCount,
    });
    start = end + 1;
  }
  const remainingRows = lastRow - start + 1;
  const openEnded = exactLastRow === undefined;
  items.push({
    range: `${quote}${firstLetter}${start}:${lastLetter}${openEnded ? SHEET_MAX_ROW : lastRow}`,
    cells: remainingRows * columnCount,
  });
  return items;
}

/**
 * Greedily packs planned bands into paced requests: each request holds at
 * most `MAX_READ_RANGES_PER_REQUEST` ranges and stays within the
 * `READ_HARD_MAX_BYTES` estimate (individual bands are chunked to the
 * softer 3 MB target, so one oversized tab spreads across requests while
 * small tabs of one logical read still share a single request — the
 * historical single-request shape).
 */
export function packReadRequests(
  items: readonly PlannedRange[],
  evidence: ReadEvidence,
  calibration: ReadCalibration,
): readonly (readonly PlannedRange[])[] {
  const requests: PlannedRange[][] = [];
  let current: PlannedRange[] = [];
  let currentBytes = 0;
  for (const item of items) {
    const bytes = estimatedRangeBytes(item, evidence, calibration);
    if (
      current.length > 0 &&
      (current.length + 1 > MAX_READ_RANGES_PER_REQUEST ||
        currentBytes + bytes > READ_HARD_MAX_BYTES)
    ) {
      requests.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(item);
    currentBytes += bytes;
  }
  if (current.length > 0) requests.push(current);
  return requests;
}

/**
 * Resolves one title's authoritative row bound from an enumeration (the
 * committed `gridProperties.rowCount`, exact) falling back to the
 * provider-instance bounds cache (refreshed by every engine response), so
 * lanes that enumerated never pay for a second metadata call.
 */
export function authoritativeRowBound(
  sheets: readonly ParsedSheet[],
  boundsCache: ReadonlyMap<string, number>,
  title: string,
): number | undefined {
  for (const sheet of sheets) {
    if (sheet.title === title) {
      return sheet.gridProperties?.rowCount ?? boundsCache.get(title);
    }
  }
  return boundsCache.get(title);
}

/**
 * Everything a model-layer lane needs from the engine WITHOUT importing the
 * operations layer: a paced-get factory (one per fields/evidence pair), the
 * authoritative bounds cache, and the shared calibration tracker. The
 * operations layer builds one per logical read via `createEngineRuntime`.
 */
export interface EngineRuntime {
  /** Builds the executor for one field mask + evidence class combination. */
  makeGet(fields: string, evidence: ReadEvidence): BandedGet;
  /** Provider-instance authoritative row bounds (title → grid rowCount). */
  readonly rowBounds: ReadonlyMap<string, number>;
  /** Provider-instance byte-estimate calibration (shared across lanes). */
  readonly calibration: ReadCalibration;
}

/**
 * Executes an already-packed band plan as SEQUENTIAL paced requests and
 * returns the reassembled document: every requested range's GridData in
 * request order, concatenated per sheet id, so each band's cells resolve
 * through the SAME accessors (`resolveGridCell`,
 * `synthesizeScopedTargetGrid`) that consume today's multi-range replies.
 */
export type BandedGet = (
  requests: readonly (readonly PlannedRange[])[],
) => Promise<ParsedSpreadsheetDocument & {
  /** Paced request slots consumed (telemetry/plan summary). */
  readonly requests: number;
  /** Summed RAW response bytes across the executed bands. */
  readonly bytes: number;
}>;
