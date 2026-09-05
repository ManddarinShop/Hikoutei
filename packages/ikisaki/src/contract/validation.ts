/**
 * Minimal runtime validation helpers used by the queue kernel.
 *
 * These are small ports of the host application's shared validators, kept
 * inside the package so the kernel needs no host imports.
 */

const EMPTY_STRING_LENGTH_ZERO = 0;
const NON_NEGATIVE_SAFE_INTEGER_MINIMUM = 0;

const JAVASCRIPT_TYPE_NAMES = {
  STRING: "string",
  NUMBER: "number",
  OBJECT: "object",
} as const;

/** Checks whether a JavaScript value has a given typeof name. */
function isJavaScriptType(
  value: unknown,
  type: typeof JAVASCRIPT_TYPE_NAMES.STRING,
): value is string;
function isJavaScriptType(
  value: unknown,
  type: typeof JAVASCRIPT_TYPE_NAMES.NUMBER,
): value is number;
function isJavaScriptType(
  value: unknown,
  type: typeof JAVASCRIPT_TYPE_NAMES.OBJECT,
): value is object | null;
function isJavaScriptType(value: unknown, type: string): boolean {
  return typeof value === type;
}

/** Checks whether an unknown value is a non-empty string. */
export function isNonEmptyString(value: unknown): value is string {
  return (
    isJavaScriptType(value, JAVASCRIPT_TYPE_NAMES.STRING) &&
    value.length !== EMPTY_STRING_LENGTH_ZERO
  );
}

/** Checks whether an unknown value is a non-negative safe integer. */
export function isNonNegativeSafeInteger(value: unknown): value is number {
  return (
    isJavaScriptType(value, JAVASCRIPT_TYPE_NAMES.NUMBER) &&
    Number.isSafeInteger(value) &&
    value >= NON_NEGATIVE_SAFE_INTEGER_MINIMUM
  );
}

/** Checks whether a value is a non-null, non-array object record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    isJavaScriptType(value, JAVASCRIPT_TYPE_NAMES.OBJECT) &&
    value !== null &&
    !Array.isArray(value)
  );
}
