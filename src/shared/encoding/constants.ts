/** Runtime names returned by JavaScript's typeof operator. */
export const JAVASCRIPT_TYPE_NAMES = {
  UNDEFINED: "undefined",
  OBJECT: "object",
  BOOLEAN: "boolean",
  NUMBER: "number",
  BIGINT: "bigint",
  STRING: "string",
  SYMBOL: "symbol",
  FUNCTION: "function",
} as const;

/** Closed set of JavaScript typeof result names. */
export type JavaScriptTypeName =
  (typeof JAVASCRIPT_TYPE_NAMES)[keyof typeof JAVASCRIPT_TYPE_NAMES];

export {
  STABLE_ENCODING_ERROR_CODES,
  type StableEncodingErrorCode,
} from "./codec/errors.js";

/** Runtime values for normalized cell value kinds. */
export const NORMALIZED_CELL_KINDS = {
  STRING: "string",
  NUMBER: "number",
  BOOLEAN: "boolean",
  DATE: "date",
} as const;

/** Closed set of normalized cell value kinds. */
export type NormalizedCellKind =
  (typeof NORMALIZED_CELL_KINDS)[keyof typeof NORMALIZED_CELL_KINDS];

/** Runtime values for physical Sheet cell observation kinds. */
export const CELL_OBSERVATION_KINDS = {
  BLANK: "blank",
  LITERAL: "literal",
  FORMULA: "formula",
  MERGED: "merged",
  ERROR: "error",
} as const;

/** Closed set of physical Sheet cell observation kinds. */
export type CellObservationKind =
  (typeof CELL_OBSERVATION_KINDS)[keyof typeof CELL_OBSERVATION_KINDS];
