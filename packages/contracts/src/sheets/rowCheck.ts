/**
 * Row-level change-detection check column (shared semantics leaf).
 *
 * The User_Input projection carries one extra column IMMEDIATELY AFTER the
 * registered range holding a deterministic formula the system writes at row
 * creation: a `&`-concatenation of one LENGTH-PREFIXED, TYPE-TAGGED token
 * per user data column of the row (see {@link renderRowCheckCell}). The
 * Sheet's recalculation engine maintains the cell, so a human edit to any
 * data column changes the visible check string without any system
 * involvement. Inbound polling then reads ONLY that column (plus the
 * identity and system row-id bands for row mapping), compares each row's
 * observed check string against the value SQLite derives deterministically
 * from the canonical field state, and escalates only mismatched rows to a
 * targeted full-field read. A match therefore skips the row's data columns
 * entirely.
 *
 * This module is the SINGLE source for the token semantics both sides must
 * share: the provider builds the formula from the same delimiter/tag
 * constants, and the polling side renders the expected string with
 * {@link computeRowCheckValue}. The encoding is INJECTIVE (collision-free)
 * and type-aware by construction:
 *
 * - every column contributes EXACTLY ONE positional token
 *   `<typeTag><charLength>:<renderedValue>`, so the length prefix (not the
 *   delimiter) defines token boundaries: a delimiter INSIDE a value
 *   (["a|b", "c"] vs ["a", "b|c"]) can never fake a boundary;
 * - blank permutations cannot collapse: a value moved across a blank
 *   boundary changes which POSITION carries the text (`"z"|""` vs
 *   `""|"z"` render `s1:z|s0:`, never the same string);
 * - the first character of every token is its type tag (`s` text — also
 *   blank/empty string, which are visually identical in a Sheet; `n`
 *   number or date serial; `b` boolean), so the string "12" (`s2:12`)
 *   never equals the number 12 (`n2:12`).
 *
 * Safety direction: every renderer disagreement (a Sheet locale that
 * renders a decimal with a comma, an emoji whose Sheet LEN counts code
 * points while JavaScript counts UTF-16 units, scientific-notation
 * ceilings) produces a MISMATCH, which degrades to the historical
 * targeted full-field read — a false-dirty row can never hide a real
 * human edit. Known ceilings of the design itself: a human who replaces
 * the check cell with a literal, a foreign formula, or a same-result copy
 * of the system formula (the provider verifies the cell still holds the
 * EXACT generated formula and reports no check evidence otherwise), and a
 * hidden row below the last visible row; the periodic forceFull safety
 * scan is the backstop, exactly like the scoped-preflight gaps documented
 * in `preflightRows.ts`.
 */

import type { NormalizedCell } from "../encoding/types.js";

/**
 * Header of the system-owned row-check column, written by provisioning
 * directly after the registered range's last column of a User_Input tab.
 * The cell is outside every registered range, so no existing read, hash,
 * or blank-row rule ever sees it; only the check-column reader and the
 * append formula writer touch it.
 */
export const SYNC_ROW_CHECK_HEADER = "__hikoutei_row_check";

/** Separator between positional tokens (never part of a token body). */
export const SYNC_ROW_CHECK_DELIMITER = "|";

/** Separator between a token's `<tag><length>` header and its body. */
export const SYNC_ROW_CHECK_LENGTH_SEPARATOR = ":";

/** Token type tags. A token is exactly `tag + charLength + ":" + body`. */
export const SYNC_ROW_CHECK_TOKEN_TAGS = {
  /** Text — a blank or empty-string cell renders as the zero-length body. */
  STRING: "s",
  /** Number — or date cell rendered as its numeric serial. */
  NUMBER: "n",
  /** Boolean; body is `TRUE`/`FALSE` (what the Sheet concatenates). */
  BOOLEAN: "b",
} as const;

/**
 * Builds one length-prefixed token. The length is the BODY's character
 * count, so decoding (and any collision analysis) skips exactly that many
 * characters after the `:` — the body may contain the delimiter, the tag
 * characters, or digits without ever faking a boundary.
 */
export function rowCheckToken(tag: string, body: string): string {
  return `${tag}${body.length}${SYNC_ROW_CHECK_LENGTH_SEPARATOR}${body}`;
}

/**
 * Renders one normalized cell as its positional check TOKEN. Every column
 * always contributes exactly one token (a blank or empty string renders as
 * the zero-length `s` token), so the joined string is injective over the
 * column vector. Numbers (and date serials) render in JavaScript standard
 * form and booleans as `TRUE`/`FALSE`; the live experiment proved the
 * Sheet's `&`-concatenation renders the tested int/decimal/bool values
 * byte-for-byte identically, and any untested shape that disagrees renders
 * as a MISMATCH — the safe direction (per-row targeted full-field read).
 */
export function renderRowCheckCell(cell: NormalizedCell): string {
  if (cell === null) return rowCheckToken(SYNC_ROW_CHECK_TOKEN_TAGS.STRING, "");
  switch (cell.kind) {
    case "string":
      // A stored empty string and a blank cell are visually identical in a
      // Sheet (both concatenate to "" and count as length 0); the Sheet-side
      // formula agrees with this equivalence.
      return rowCheckToken(SYNC_ROW_CHECK_TOKEN_TAGS.STRING, cell.value);
    case "number":
      return rowCheckToken(SYNC_ROW_CHECK_TOKEN_TAGS.NUMBER, String(cell.value));
    case "boolean":
      return rowCheckToken(
        SYNC_ROW_CHECK_TOKEN_TAGS.BOOLEAN,
        cell.value ? "TRUE" : "FALSE",
      );
    case "date": {
      // A date cell holds a numeric serial (with a display format); the
      // Sheet formula sees ISNUMBER and concatenates the bare serial.
      return rowCheckToken(
        SYNC_ROW_CHECK_TOKEN_TAGS.NUMBER,
        String(rowCheckDateSerialFromIso(cell.value)),
      );
    }
  }
}

/**
 * Computes the expected row-check string from canonical field values in
 * COLUMN ORDER. Returns `null` when any header's canonical value is not
 * available — callers must treat a null expectation as "not derivable" and
 * route the row through the historical full-field read instead of guessing.
 * The result always carries one delimiter-separated token per header.
 */
export function computeRowCheckValue(
  headers: readonly string[],
  cellOf: (header: string) => NormalizedCell | undefined,
): string | null {
  const parts: string[] = [];
  for (const header of headers) {
    const cell = cellOf(header);
    if (cell === undefined) return null;
    parts.push(renderRowCheckCell(cell));
  }
  return parts.join(SYNC_ROW_CHECK_DELIMITER);
}

/**
 * Excel/Sheets 1900-system serial for a canonical UTC ISO date: whole (or
 * fractional) days since 1899-12-30 UTC. Same formula as the provider's
 * `dateSerialFromIso`; the provider delegates here so the write-side cell
 * value and the polling-side expected rendering can never drift.
 */
export function rowCheckDateSerialFromIso(iso: string): number {
  return (Date.parse(iso) - Date.UTC(1899, 11, 30)) / 86_400_000;
}
