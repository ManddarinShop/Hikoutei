/**
 * Scoped preflight verification: the second, row-scoped, format-evidence read.
 *
 * The every-dispatch base preflight read is values-only (see
 * `GOOGLE_SHEETS_API_PREFLIGHT_BASE_FIELDS`). Because a `numberValue` cell
 * rendered with the canonical date number format normalizes to a `date`
 * kind (and, for identity columns, to a completely different identity
 * string), any cell whose normalization can depend on a number format must
 * be re-read WITH format evidence before its hash or identity is trusted:
 *
 * - every existing row a batch resolves for a CAS/replay/deletion hash
 *   (row-banded: full registered column span, values + BOTH number-format
 *   sources, parsed exactly like the historical full-mask read), and
 * - the whole identity column when any identity cell read as a number under
 *   the base mask (column-banded), so identity duplicate detection cannot
 *   drift for date-formatted numeric identities.
 *
 * The bands are fetched in ONE ranged `spreadsheets.get` (the real API
 * returns one GridData per requested range, in order — verified against the
 * live API), so every verification cell's value and both its formats come
 * from a single sheet snapshot; base-read values are NEVER merged with
 * verification formats. If the bands would exceed the per-request range
 * budget, the caller falls back to the historical whole-table full-evidence
 * read instead, which is correct by construction.
 *
 * Between the base read and the verification read a human can shift rows.
 * That is fail-closed by revalidating the row anchor inside the verification
 * snapshot (a present, different anchor proves a shift and blanks the row so
 * planning cannot accept it) and by the CAS hash itself.
 */

import type { NormalizedCell } from "@hikoutei/contracts/encoding/types.js";
import { absentValue, presentValue } from "@hikoutei/contracts/state/index.js";
import { invalidProviderState, GET_REPLY_MALFORMED } from "../errors.js";
import {
  columnLetters,
  dateSerialFromIso,
  identityFromNormalizedCell,
  isBlankApiCell,
  normalizedCellFromApiValue,
  quoteA1SheetName,
} from "./valueNormalization.js";
import {
  anchorFromColumnValue,
  apiCellNumberFormat,
  indexRows,
  resolveGridCell,
} from "./preflightRows.js";
import {
  MAX_READ_CELLS_PER_RANGE,
  MAX_READ_RANGES_PER_REQUEST,
  planRowBands,
  type PlannedRange,
  type ReadCalibration,
} from "./readPlan.js";
import type {
  ParsedGridData,
  PreflightContext,
  PreflightRow,
} from "./preflightContext.js";

/**
 * Hard cap on ranges per `spreadsheets.get`, shared engine-wide (the
 * historical per-lane copies unified into `MAX_READ_RANGES_PER_REQUEST`).
 */
export const MAX_VERIFY_RANGES_PER_REQUEST = MAX_READ_RANGES_PER_REQUEST;

/** The real API rejects a single requested range above 10,000 cells. */
export const MAX_VERIFY_CELLS_PER_RANGE = MAX_READ_CELLS_PER_RANGE;

/**
 * Discriminated outcome of planning one route's verification read. The
 * pre-engine `overflow` member (and its whole-table full-evidence fallback)
 * is REMOVED: a band plan exceeding the per-request range/byte budget now
 * expands into additional sequential band requests instead of degrading to
 * one uncapped whole-table read (unified read engine §5 step 5).
 */
export type PreflightVerificationPlan =
  | { readonly kind: "none" }
  | { readonly kind: "ranges"; readonly items: readonly PlannedRange[] };

/** Serial-string aliases of an ISO-shaped identity (empty otherwise). */
export function identitySerialAliases(identity: string): readonly string[] {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(identity)) return [];
  const serial = dateSerialFromIso(identity);
  return Number.isFinite(serial) ? [String(serial)] : [];
}

/**
 * Builds the verification plan for one route: the row bands for resolved
 * CAS/replay rows plus, when the route's identity cells need format
 * evidence, the whole identity column band. Returns `"none"` when no
 * verification read is needed at all (pure-insert batch, no numeric
 * identity). Every band is chunked to the shared per-range cell cap AND
 * the per-evidence-class byte budget; a plan exceeding one request's range
 * budget expands into additional sequential requests at packing time (the
 * caller never degrades to a whole-table read).
 *
 * `exactLastRow` band ends are CLOSED (the planned extent is proven by the
 * context/target set), so every hashed cell still sits in exactly one band
 * of one server snapshot.
 */
export function planPreflightVerification(
  context: PreflightContext,
  targetRowNumbers: readonly number[],
  calibration: ReadCalibration,
): PreflightVerificationPlan {
  const items: PlannedRange[] = [];
  if (context.identityNeedsFormatEvidence) {
    items.push(...identityColumnItems(context, calibration));
  }
  const targets = [...new Set(targetRowNumbers)].sort((a, b) => a - b);
  if (targets.length > 0) {
    items.push(...rowBandItems(context, targets, calibration));
  }
  if (items.length === 0) return { kind: "none" };
  return { kind: "ranges", items };
}

/**
 * Replaces the verification-relevant state of a base preflight context from
 * ONE verification document's grids (the ordered per-range GridData list of
 * the route's tab), producing a context whose hashes, identities, and
 * duplicate checks are format-exact.
 *
 * Contract with the caller: every banded cell's value AND both format
 * sources come from the same request, so a human edit between the base read
 * and this read can never mix a base value with a verification format into
 * one hash. Rows whose base anchor is present but whose verification anchor
 * is missing or different are provably shifted (e.g. a human row inserted
 * above the target) and blank out (fail closed); rows banded but absent/blank
 * in the snapshot are treated the same way.
 * Identity values for all rows are rebuilt from the identity-column band
 * when present. The identity duplicate check (deferred at base indexing for
 * numeric identities) re-runs fail-closed here.
 */
export function patchPreflightContext(
  context: PreflightContext,
  grids: readonly ParsedGridData[],
  targetRowNumbers: readonly number[],
  options: { readonly includeIdentityBand: boolean },
): PreflightContext {
  const targets = new Set(targetRowNumbers);
  const baseByNumber = new Map<number, PreflightRow>();
  for (const row of context.rows) baseByNumber.set(row.rowNumber, row);
  const rowNumbers = new Set<number>(context.rows.map((row) => row.rowNumber));
  for (const target of targets) rowNumbers.add(target);
  const identityColumn = options.includeIdentityBand
    ? identityColumnPosition(context)
    : undefined;

  const patched: PreflightRow[] = [];
  for (const rowNumber of [...rowNumbers].sort((a, b) => a - b)) {
    const base = baseByNumber.get(rowNumber);
    if (!targets.has(rowNumber)) {
      // Not banded: cells stay values-only (never hashed); only the identity
      // string can change under format evidence, so re-derive it from the
      // identity column band.
      if (identityColumn === undefined || base === undefined) {
        if (base !== undefined) patched.push(base);
        continue;
      }
      patched.push(rederiveIdentity(context, base, grids, identityColumn));
      continue;
    }
    const verified = normalizeVerifiedRow(context, grids, rowNumber);
    if (verified === null || base === undefined) {
      // Row blank/vanished in the verification snapshot: keep it (a brand-new
      // row for the inline verify pass) only when it carries content.
      if (verified !== null) patched.push(verified);
      else if (base !== undefined) patched.push(blankPreflightRow(context, rowNumber));
      continue;
    }
    // Anchor revalidation (fail closed): a present base anchor paired with a
    // MISSING or different verification anchor proves the banded row number no
    // longer holds the base row — e.g. a human row inserted above shifts a
    // nonblank, anchor-less row into the band. Any such mismatch blanks the
    // context so the write is refused instead of applied to shifted evidence.
    if (
      base.physicalAnchor.kind === "present" &&
      (verified.physicalAnchor.kind !== "present" ||
        verified.physicalAnchor.value !== base.physicalAnchor.value)
    ) {
      patched.push(blankPreflightRow(context, rowNumber));
      continue;
    }
    patched.push(verified);
  }

  // Fail-closed identity duplicate check on the format-aware identities
  // (this is where a deferred base-read duplicate either resolves — two
  // different format-rendered identities — or finally throws).
  const { byAnchor, byIdentity, nextAppendRow } = indexRows(patched);
  return {
    ...context,
    rows: patched,
    byAnchor,
    byIdentity,
    nextAppendRow,
    // Once every identity has been re-derived from the format-aware band,
    // later verification passes on this context no longer need the band.
    identityNeedsFormatEvidence: options.includeIdentityBand
      ? false
      : context.identityNeedsFormatEvidence,
  };
}

/** Normalizes one verification-snapshot row; null when blank/vanished. */
function normalizeVerifiedRow(
  context: PreflightContext,
  grids: readonly ParsedGridData[],
  rowNumber: number,
): PreflightRow | null {
  const cells: Record<string, NormalizedCell> = {};
  let blank = true;
  context.headers.forEach((header, index) => {
    const cell = resolveGridCell(grids, rowNumber, context.startColumn + index);
    if (!isBlankApiCell(cell)) blank = false;
    const numberFormat = apiCellNumberFormat(cell);
    cells[header] = normalizedCellFromApiValue(
      cell === null || cell === undefined
        ? undefined
        : (cell as Record<string, unknown>).userEnteredValue,
      numberFormat,
    );
  });
  if (blank) return null;
  const anchor = context.anchorColumn === undefined
    ? undefined
    : anchorFromColumnValue(resolveGridCell(grids, rowNumber, context.anchorColumn));
  let identity = absentValue() as PreflightRow["identity"];
  if (context.identityField.kind === "present") {
    const value = identityFromNormalizedCell(
      cells[context.identityField.value] ?? null,
    );
    if (value !== null) identity = presentValue(value);
  }
  return {
    rowNumber,
    physicalAnchor: anchor === undefined ? absentValue() : presentValue(anchor),
    cells,
    identity,
  };
}

/** Rebuilds one row's identity from the format-aware identity column band. */
function rederiveIdentity(
  context: PreflightContext,
  base: PreflightRow,
  grids: readonly ParsedGridData[],
  identityColumn: number,
): PreflightRow {
  const cell = resolveGridCell(grids, base.rowNumber, identityColumn);
  const normalized = normalizedCellFromApiValue(
    cell === null || cell === undefined
      ? undefined
      : (cell as Record<string, unknown>).userEnteredValue,
    apiCellNumberFormat(cell),
  );
  const value = identityFromNormalizedCell(normalized);
  const identity = value === null ? absentValue<string>() : presentValue(value);
  const unchanged = identity.kind === base.identity.kind &&
    (identity.kind !== "present" ||
      (base.identity.kind === "present" && identity.value === base.identity.value));
  if (unchanged) return base;
  return { ...base, identity };
}

/** A row provably vanished/shifted between reads: no usable evidence left. */
function blankPreflightRow(context: PreflightContext, rowNumber: number): PreflightRow {
  const cells: Record<string, NormalizedCell> = {};
  for (const header of context.headers) cells[header] = null;
  return {
    rowNumber,
    physicalAnchor: absentValue(),
    cells,
    identity: absentValue(),
  };
}

/** Absolute 1-based identity-column position, when the route has one. */
function identityColumnPosition(context: PreflightContext): number | undefined {
  if (context.identityField.kind !== "present") return undefined;
  const offset = context.positions.get(context.identityField.value);
  return offset === undefined ? undefined : context.startColumn + offset;
}

/** The identity-column full-data-row bands (one column, rows 2..last). */
function identityColumnItems(
  context: PreflightContext,
  calibration: ReadCalibration,
): PlannedRange[] {
  const column = identityColumnPosition(context);
  const lastRow = context.rows.length === 0
    ? 0
    : context.rows[context.rows.length - 1]!.rowNumber;
  if (column === undefined || lastRow < 2) return [];
  const letter = columnLetters(column);
  return planRowBands({
    quote: `${quoteA1SheetName(context.title)}!`,
    firstLetter: letter,
    lastLetter: letter,
    columnCount: 1,
    fromRow: 2,
    rowBound: lastRow,
    // The planned extent is proven by the context rows: close the last band
    // at `lastRow` instead of staying open (no unbounded extra rows).
    exactLastRow: lastRow,
    evidence: "values+formats",
    calibration,
  });
}

/** Row-band plans over the full registered column span of the route. */
function rowBandItems(
  context: PreflightContext,
  sortedRows: readonly number[],
  calibration: ReadCalibration,
): PlannedRange[] {
  const first = context.startColumn;
  const last = context.anchorColumn !== undefined
    ? Math.max(context.anchorColumn, context.startColumn + context.headers.length - 1)
    : context.startColumn + context.headers.length - 1;
  const columnCount = last - first + 1;
  if (columnCount < 1) {
    invalidProviderState("verification column span is invalid", GET_REPLY_MALFORMED);
  }
  const quote = `${quoteA1SheetName(context.title)}!`;
  const firstLetter = columnLetters(first);
  const lastLetter = columnLetters(last);
  const items: PlannedRange[] = [];
  // Merge contiguous runs (the historical behavior), then chunk each run at
  // the cell/byte caps. The run END is the proven extent, so bands close.
  let runStart = sortedRows[0]!;
  let previous = runStart;
  const flush = (end: number): void => {
    items.push(...planRowBands({
      quote,
      firstLetter,
      lastLetter,
      columnCount,
      fromRow: runStart,
      rowBound: end,
      exactLastRow: end,
      evidence: "values+formats",
      calibration,
    }));
  };
  for (let index = 1; index <= sortedRows.length; index += 1) {
    const row = sortedRows[index] ?? Number.NaN;
    if (row === previous + 1) {
      previous = row;
      continue;
    }
    flush(previous);
    if (Number.isNaN(row)) break;
    runStart = row;
    previous = row;
  }
  return items;
}

/**
 * Resolves raw CellData across an ordered per-range GridData list.
 *
 * The accessor lives with the row-reading helpers (shared with the scoped
 * base-read synthesis); re-exported here so verification readers keep one
 * import surface.
 */
export { resolveGridCell as resolveVerifyCell };
