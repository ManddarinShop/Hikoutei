/**
 * Low-level typeof guards used by the canonical codec.
 *
 * These mirror the runtime-neutral helpers the Hikoutei repository previously
 * kept under `src/shared/encoding/typeGuards.ts` and `.../constants.ts`. They
 * are first-class in this package so the codec has no external dependency.
 *
 * NOTE: Stage 1 scaffold. The function bodies are intentionally stubs and will
 * be filled in during Stage 2 of the package-extraction plan.
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

const NOT_IMPLEMENTED =
  "@hikoutei/canonical-codec: Stage 1 scaffold (0.1.0); implementation lands in Stage 2.";

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
/**
 * Checks a JavaScript value against a shared `typeof` name and narrows it.
 *
 * Stage 1 stub: throws until the implementation is migrated in Stage 2.
 */
export function isJavaScriptType(value: unknown, type: JavaScriptTypeName): boolean {
  throw new Error(`isJavaScriptType is not implemented. ${NOT_IMPLEMENTED}`);
}

/**
 * Checks whether a value is a non-null, non-array object record.
 *
 * Stage 1 stub: throws until the implementation is migrated in Stage 2.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  throw new Error(`isRecord is not implemented. ${NOT_IMPLEMENTED}`);
}
