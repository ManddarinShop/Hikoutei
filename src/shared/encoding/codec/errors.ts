/** Generic error codes emitted by the internal canonical codec boundary. */
export const CANONICAL_CODEC_ERROR_CODES = {
  UNSUPPORTED_VALUE_TYPE: "unsupported_value_type",
  NON_FINITE_NUMBER: "non_finite_number",
  INVALID_DATE_FORMAT: "invalid_date_format",
  INVALID_DATE_BYTE_LENGTH: "invalid_date_byte_length",
  DUPLICATE_OBJECT_KEY: "duplicate_object_key",
  UNPAIRED_HIGH_SURROGATE: "unpaired_high_surrogate",
  UNPAIRED_LOW_SURROGATE: "unpaired_low_surrogate",
  INVALID_JSON_VALUE: "invalid_json_value",
  CYCLIC_VALUE: "cyclic_value",
} as const;

/** Closed set of generic canonical codec error codes. */
export type CanonicalCodecErrorCode =
  (typeof CANONICAL_CODEC_ERROR_CODES)[keyof typeof CANONICAL_CODEC_ERROR_CODES];

/** Stable encoding error codes retained as a compatibility subset. */
export const STABLE_ENCODING_ERROR_CODES = {
  UNSUPPORTED_VALUE_TYPE: CANONICAL_CODEC_ERROR_CODES.UNSUPPORTED_VALUE_TYPE,
  NON_FINITE_NUMBER: CANONICAL_CODEC_ERROR_CODES.NON_FINITE_NUMBER,
  INVALID_DATE_FORMAT: CANONICAL_CODEC_ERROR_CODES.INVALID_DATE_FORMAT,
  INVALID_DATE_BYTE_LENGTH: CANONICAL_CODEC_ERROR_CODES.INVALID_DATE_BYTE_LENGTH,
  DUPLICATE_OBJECT_KEY: CANONICAL_CODEC_ERROR_CODES.DUPLICATE_OBJECT_KEY,
  UNPAIRED_HIGH_SURROGATE: CANONICAL_CODEC_ERROR_CODES.UNPAIRED_HIGH_SURROGATE,
  UNPAIRED_LOW_SURROGATE: CANONICAL_CODEC_ERROR_CODES.UNPAIRED_LOW_SURROGATE,
  CYCLIC_VALUE: CANONICAL_CODEC_ERROR_CODES.CYCLIC_VALUE,
} as const;

/** Closed set of stable encoding error codes. */
export type StableEncodingErrorCode =
  (typeof STABLE_ENCODING_ERROR_CODES)[keyof typeof STABLE_ENCODING_ERROR_CODES];

/** Error raised by generic codec functions before a Hikoutei adapter maps it. */
export class CanonicalCodecError extends Error {
  readonly code: CanonicalCodecErrorCode;

  constructor(code: CanonicalCodecErrorCode, message: string) {
    super(message);
    this.name = "CanonicalCodecError";
    this.code = code;
  }
}

/** Stable-encoding-specific generic error with a narrowed compatibility code set. */
export class StableCodecError extends CanonicalCodecError {
  declare readonly code: StableEncodingErrorCode;

  constructor(code: StableEncodingErrorCode, message: string) {
    super(code, message);
    this.name = "StableCodecError";
  }
}
