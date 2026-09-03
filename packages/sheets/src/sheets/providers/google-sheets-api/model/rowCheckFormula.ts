/**
 * Row-check formula builder for the User_Input check column.
 *
 * The provider writes ONE deterministic formula per created row into the
 * check column (the column directly after the registered range): a `&`
 * concatenation of one length-prefixed, type-tagged TOKEN term per user
 * data column of the row, joined by the shared delimiter. Each term is
 * `IF(ISNUMBER(ref),"n",IF(ISLOGICAL(ref),"b","s"))&LEN(ref)&":"&ref`,
 * mirroring the contracts leaf (`sheets/rowCheck.ts` →
 * {@link renderRowCheckCell}) token-for-token, so the computed string is
 * injective over the row's data vector (delimiter collisions and blank
 * permutations are encoded by the length prefix, not skipped) while the
 * formula stays compact enough that the narrow polling read keeps its
 * payload advantage.
 *
 * The Sheet's recalculation engine maintains the cell afterwards, so any
 * human edit to a data column of that row changes the visible check string
 * without a system write, and every system `updateCells` write to the row
 * (which preserves neighboring formulas — proven) recalcs on the next read.
 * The polling gate compares that computed string against the value derived
 * from canonical SQLite state (contracts `sheets/rowCheck.ts`) and only
 * escalates mismatched rows to targeted full-field reads.
 *
 * Branch equivalences the renderer mirrors: a blank or empty-string cell
 * concatenates to "" with LEN 0 under the `s` tag (`s0:`); a date cell
 * ISNUMBER-concatenates its bare serial; a boolean concatenates to
 * TRUE/FALSE under the `b` tag; an error or an unsupported render propagates
 * (or disagrees) as a MISMATCH — the safe direction. `ponytail`: ~70
 * formula chars per column; a Sheet's ~10k formula cap ceilings this at
 * roughly 140 data columns — beyond that, hash the row server-side instead
 * of encoding it.
 */

import {
  SYNC_ROW_CHECK_DELIMITER,
  SYNC_ROW_CHECK_LENGTH_SEPARATOR,
  SYNC_ROW_CHECK_TOKEN_TAGS,
} from "@hikoutei/contracts/sheets/rowCheck.js";
import { columnLetters } from "./valueNormalization.js";

/** Returns the row-check formula text (with leading `=`) for one row. */
export function buildRowCheckFormula(
  firstDataColumn: number,
  lastDataColumn: number,
  rowNumber: number,
): string {
  const terms: string[] = [];
  for (let column = firstDataColumn; column <= lastDataColumn; column += 1) {
    terms.push(buildRowCheckTerm(`${columnLetters(column)}${rowNumber}`));
  }
  return `=${terms.join(`&"${SYNC_ROW_CHECK_DELIMITER}"&`)}`;
}

/**
 * One column's token term for cell `ref`, generated from the shared
 * delimiter/tag constants so the formula and the SQLite-side renderer can
 * never drift apart silently. Text is the fallback tag (a blank or
 * empty-string cell renders exactly like the renderer's zero-length `s`
 * token); errors propagate through LEN/concatenation.
 */
function buildRowCheckTerm(ref: string): string {
  const text = SYNC_ROW_CHECK_TOKEN_TAGS.STRING;
  const number = SYNC_ROW_CHECK_TOKEN_TAGS.NUMBER;
  const bool = SYNC_ROW_CHECK_TOKEN_TAGS.BOOLEAN;
  return `IF(ISNUMBER(${ref}),"${number}",IF(ISLOGICAL(${ref}),"${bool}","${text}"))`
    + `&LEN(${ref})&"${SYNC_ROW_CHECK_LENGTH_SEPARATOR}"&${ref}`;
}
