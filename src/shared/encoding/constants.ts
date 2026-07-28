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

/** Stable machine-readable error codes emitted by the encoder. */
export const STABLE_ENCODING_ERROR_CODES = {
  UNSUPPORTED_VALUE_TYPE: "unsupported_value_type",
  NON_FINITE_NUMBER: "non_finite_number",
  INVALID_DATE_FORMAT: "invalid_date_format",
  INVALID_DATE_BYTE_LENGTH: "invalid_date_byte_length",
  DUPLICATE_OBJECT_KEY: "duplicate_object_key",
  UNPAIRED_HIGH_SURROGATE: "unpaired_high_surrogate",
  UNPAIRED_LOW_SURROGATE: "unpaired_low_surrogate",
} as const;

/** Closed set of stable encoder error codes. */
export type StableEncodingErrorCode =
  (typeof STABLE_ENCODING_ERROR_CODES)[keyof typeof STABLE_ENCODING_ERROR_CODES];

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
