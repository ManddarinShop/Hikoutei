/** Shared numeric sentinels used when a zero value carries a specific meaning. */
export const EMPTY_STRING_LENGTH_ZERO = 0 as const;
export const EMPTY_ARRAY_LENGTH_ZERO = 0 as const;

/** Smallest value accepted by positive-safe-integer contracts. */
export const POSITIVE_SAFE_INTEGER_MINIMUM = 1 as const;

/** Smallest value accepted by non-negative-safe-integer contracts. */
export const NON_NEGATIVE_SAFE_INTEGER_MINIMUM = 0 as const;
