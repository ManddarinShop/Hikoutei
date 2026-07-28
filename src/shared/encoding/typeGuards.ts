import { JAVASCRIPT_TYPE_NAMES } from "./constants.js";
import type { JavaScriptTypeName } from "./constants.js";

/** Checks a JavaScript value against a shared typeof name and narrows it. */
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
