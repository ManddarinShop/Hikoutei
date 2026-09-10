import {
  EMPTY_ARRAY_LENGTH_ZERO,
  EMPTY_STRING_LENGTH_ZERO,
  NON_NEGATIVE_SAFE_INTEGER_MINIMUM,
  POSITIVE_SAFE_INTEGER_MINIMUM,
} from "./constants.js";

/** Checks whether an unknown value is a non-empty string. */
export function isNonEmptyString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length !== EMPTY_STRING_LENGTH_ZERO
  );
}

/** Checks whether an unknown value is a positive safe integer. */
export function isPositiveSafeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= POSITIVE_SAFE_INTEGER_MINIMUM
  );
}

/** Checks whether an unknown value is a non-negative safe integer. */
export function isNonNegativeSafeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= NON_NEGATIVE_SAFE_INTEGER_MINIMUM
  );
}

/** Checks whether a string is the canonical UTC ISO representation of a date. */
export function isCanonicalUtcIsoDate(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) {
    return false;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

/** Checks whether a list contains at least one item. */
export function isNonEmptyList<T>(values: readonly T[]): boolean {
  return values.length !== EMPTY_ARRAY_LENGTH_ZERO;
}
