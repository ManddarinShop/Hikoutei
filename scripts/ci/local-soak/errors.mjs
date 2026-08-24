/**
 * Stable redacted error description and tag helpers.
 * Depends only on the redaction allowlists.
 */
import { sanitizeErrorClass, sanitizeStableCode, sanitizeStatusClass } from "./redact.mjs";

/** Extracts the error name and optional raw code/status class for sanitization. */
export function describeError(error) {
  const errorClass = error !== null && typeof error === "object" &&
    typeof error?.name === "string" && error.name.length > 0
    ? error.name
    : "unknown";
  const code = error !== null && typeof error === "object" &&
    typeof error?.code === "string"
    ? error.code
    : undefined;
  const statusClass = error !== null && typeof error === "object" &&
    typeof error?.statusClass === "string"
    ? error.statusClass
    : undefined;
  return { errorClass, code, statusClass };
}

/** Stable redacted tag for progress lines (never the raw message). */
export function stableErrorTag(error) {
  const described = describeError(error);
  // The class name passes the stable allowlist: a custom error class name
  // can embed a path, URL, or id-like token and must never reach stderr.
  const errorClass = sanitizeErrorClass(described.errorClass);
  const code = described.code === undefined ? undefined : sanitizeStableCode(described.code);
  const statusClass = described.statusClass === undefined
    ? undefined
    : sanitizeStatusClass(described.statusClass);
  // Prefer a known non-unknown code; otherwise a known non-unknown status
  // class; otherwise the class name only. A sanitized `unknown` code must
  // never shadow a valid status class.
  const stable =
    code !== undefined && code !== "unknown" ? code
    : statusClass !== undefined && statusClass !== "unknown" ? statusClass
    : undefined;
  return stable === undefined
    ? errorClass
    : `${errorClass} (${stable})`;
}
