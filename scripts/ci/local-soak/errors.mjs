/**
 * Stable redacted error description and tag helpers.
 * Depends only on the redaction allowlists.
 */
import { sanitizeErrorClass, sanitizeStableCode } from "./redact.mjs";

/** Extracts the error name and optional raw code for sanitization. */
export function describeError(error) {
  const errorClass = error !== null && typeof error === "object" &&
    typeof error?.name === "string" && error.name.length > 0
    ? error.name
    : "unknown";
  const code = error !== null && typeof error === "object" &&
    typeof error?.code === "string"
    ? error.code
    : undefined;
  return { errorClass, code };
}

/** Stable redacted tag for progress lines (never the raw message). */
export function stableErrorTag(error) {
  const described = describeError(error);
  // The class name passes the stable allowlist: a custom error class name
  // can embed a path, URL, or id-like token and must never reach stderr.
  const errorClass = sanitizeErrorClass(described.errorClass);
  const code = described.code === undefined ? undefined : sanitizeStableCode(described.code);
  return code === undefined || code === "unknown"
    ? errorClass
    : `${errorClass} (${code})`;
}
