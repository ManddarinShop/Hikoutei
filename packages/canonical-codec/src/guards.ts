/**
 * Low-level typeof guards used by the canonical codec.
 *
 * These runtime-neutral helpers are first-class in this package so the codec
 * has no external dependency and no package source imports repository source.
 */

/** Runtime names returned by JavaScript's `typeof` operator. */
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

/** Closed set of JavaScript `typeof` result names. */
export type JavaScriptTypeName =
  (typeof JAVASCRIPT_TYPE_NAMES)[keyof typeof JAVASCRIPT_TYPE_NAMES];

export function isJavaScriptType(
  value: unknown,
  type: typeof JAVASCRIPT_TYPE_NAMES.STRING,
): value is string;
export function isJavaScriptType(
  value: unknown,
  type: typeof JAVASCRIPT_TYPE_NAMES.NUMBER,
): value is number;
export function isJavaScriptType(
  value: unknown,
  type: typeof JAVASCRIPT_TYPE_NAMES.BOOLEAN,
): value is boolean;
export function isJavaScriptType(
  value: unknown,
  type: typeof JAVASCRIPT_TYPE_NAMES.BIGINT,
): value is bigint;
export function isJavaScriptType(
  value: unknown,
  type: typeof JAVASCRIPT_TYPE_NAMES.SYMBOL,
): value is symbol;
export function isJavaScriptType(
  value: unknown,
  type: typeof JAVASCRIPT_TYPE_NAMES.UNDEFINED,
): value is undefined;
export function isJavaScriptType(
  value: unknown,
  type: typeof JAVASCRIPT_TYPE_NAMES.OBJECT,
): value is object | null;
export function isJavaScriptType(
  value: unknown,
  type: typeof JAVASCRIPT_TYPE_NAMES.FUNCTION,
): value is { readonly name?: string };
/** Checks a JavaScript value against a shared `typeof` name and narrows it. */
export function isJavaScriptType(value: unknown, type: JavaScriptTypeName): boolean {
  return typeof value === type;
}

/** Checks whether a value is a non-null, non-array object record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    isJavaScriptType(value, JAVASCRIPT_TYPE_NAMES.OBJECT) &&
    value !== null &&
    !Array.isArray(value)
  );
}
