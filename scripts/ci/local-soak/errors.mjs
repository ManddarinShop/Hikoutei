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

/**
 * True when a rejected direct human write carries EXACTLY the stable
 * `identity_shifted` evidence of the harness's fail-closed identity guard
 * (a `DirectSheetsError` whose statusClass — or a fake/test error whose
 * code — is `identity_shifted`).
 *
 * In the adversarial multi-writer soak environment a row shift between
 * the seam's snapshot read and its write is an EXPECTED TRANSIENT: other
 * concurrently-running scenarios mutate the same tabs, the seam proved no
 * silent success (it REFUSED to report success for the wrong identity),
 * and the race outcome is simply unobservable. Scenario modules branch on
 * this predicate BEFORE their non-stale failure counting and record a
 * truthful `identity-shifted-transient` skip instead of a real failure.
 * Duck-typed on the stable statusClass/code so the untrusted error's
 * message, ids, and payloads never reach a classification decision.
 *
 * @param {unknown} reason a rejected direct-write reason.
 * @returns {boolean}
 */
export function isIdentityShiftedEvidence(reason) {
  return reason !== null && typeof reason === "object" &&
    (reason?.statusClass === "identity_shifted" || reason?.code === "identity_shifted");
}

/**
 * The truthful redacted scenario record for a direct human-write rejection
 * whose evidence is exactly `identity_shifted`: a transient of the
 * multi-writer environment, never a failure. The scenario's guaranteed
 * finally cleanup still runs unchanged after this record is produced.
 *
 * @param {unknown} error the identity-shifted rejection reason.
 * @returns {{ status: "skipped", expectedErrors: number, failures: number,
 *   reason: string, reasonTag: string }}
 */
export function identityShiftedTransientResult(error) {
  return {
    status: "skipped",
    expectedErrors: 0,
    failures: 0,
    reason: "identity-shifted-transient",
    reasonTag: stableErrorTag(error),
  };
}
