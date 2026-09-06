/**
 * Neutral row-check formula builder for the check-column polling gate.
 *
 * The host writes ONE deterministic formula per created row into the check
 * column (the column directly after the registered range): a `&`
 * concatenation of one length-prefixed, type-tagged TOKEN term per data
 * column of the row, joined by the shared delimiter. Each term is
 * `IF(ISNUMBER(ref),"n",IF(ISLOGICAL(ref),"b","s"))&LEN(ref)&":"&ref`,
 * mirroring the host-side canonical renderer token-for-token, so the
 * computed string is injective over the row's data vector (delimiter
 * collisions and blank permutations are encoded by the length prefix, not
 * skipped).
 *
 * The grid's recalculation engine maintains the cell afterwards, so any
 * edit to a data column of that row changes the visible check string
 * without a host write. The polling gate compares that computed string
 * against the value derived from canonical state and only escalates
 * mismatched rows to targeted full-field reads.
 *
 * The builder is host-neutral: the delimiter, length separator, and token
 * tags come from the caller's vocabulary (single-sourced in the host's
 * check-encoding contract so the formula and the canonical renderer can
 * never drift apart silently), and column addressing comes from the
 * caller's column-letter function. `ponytail`: ~70 formula chars per
 * column; a grid's ~10k formula cap ceilings this at roughly 140 data
 * columns — beyond that, hash the row host-side instead of encoding it.
 */

/** Token type tags for one length-prefixed check token. */
export interface RowCheckTokenTags {
  /** Text — a blank or empty-string cell renders as the zero-length body. */
  readonly STRING: string;
  /** Number — or date cell rendered as its numeric serial. */
  readonly NUMBER: string;
  /** Boolean; body is `TRUE`/`FALSE` (what the grid concatenates). */
  readonly BOOLEAN: string;
}

/**
 * Everything the formula builder needs from the host's check encoding.
 * The host binds this once at its boundary from its single-sourced
 * delimiter/separator/tag constants.
 */
export interface RowCheckFormulaVocabulary {
  /** Separator between positional tokens (never part of a token body). */
  readonly delimiter: string;
  /** Separator between a token's `<tag><length>` header and its body. */
  readonly lengthSeparator: string;
  /** Token type tags. A token is exactly `tag + charLength + ":" + body`. */
  readonly tags: RowCheckTokenTags;
}

/**
 * Returns the row-check formula text (with leading `=`) for one row,
 * spanning the 1-based data columns `firstDataColumn..lastDataColumn`.
 */
export function buildRowCheckFormula(
  firstDataColumn: number,
  lastDataColumn: number,
  rowNumber: number,
  vocabulary: RowCheckFormulaVocabulary,
  columnLetterOf: (column: number) => string,
): string {
  const terms: string[] = [];
  for (let column = firstDataColumn; column <= lastDataColumn; column += 1) {
    terms.push(buildRowCheckTerm(`${columnLetterOf(column)}${rowNumber}`, vocabulary));
  }
  return `=${terms.join(`&"${vocabulary.delimiter}"&`)}`;
}

/**
 * One column's token term for cell `ref`, generated from the shared
 * vocabulary so the formula and the canonical renderer can never drift
 * apart silently. Text is the fallback tag (a blank or empty-string cell
 * renders exactly like the renderer's zero-length `s` token); errors
 * propagate through LEN/concatenation.
 */
function buildRowCheckTerm(ref: string, vocabulary: RowCheckFormulaVocabulary): string {
  const text = vocabulary.tags.STRING;
  const number = vocabulary.tags.NUMBER;
  const bool = vocabulary.tags.BOOLEAN;
  return `IF(ISNUMBER(${ref}),"${number}",IF(ISLOGICAL(${ref}),"${bool}","${text}"))`
    + `&LEN(${ref})&"${vocabulary.lengthSeparator}"&${ref}`;
}
