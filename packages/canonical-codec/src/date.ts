/**
 * Canonical UTC date validation for the codec's tagged date path.
 *
 * The stable-encoding date path only accepts a fixed-width UTC ISO-8601 string
 * so that dates encode to identical bytes across runtimes.
 */

import { isJavaScriptType, JAVASCRIPT_TYPE_NAMES } from "./guards.js";

/** Checks whether a string is the canonical UTC ISO representation of a date. */
export function isCanonicalUtcIsoDate(value: unknown): value is string {
  if (
    !isJavaScriptType(value, JAVASCRIPT_TYPE_NAMES.STRING) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) {
    return false;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}
