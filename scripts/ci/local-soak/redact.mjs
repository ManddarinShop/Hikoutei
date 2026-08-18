/**
 * Runtime redaction allowlists for soak artifacts and diagnostics.
 *
 * Every `code`, `reason`, `errorClass`, `statusClass`, table name, and
 * count key/value that can reach JSONL, the summary, the collected log,
 * or the console goes through one of these sanitizers. Unknown values map
 * to fixed safe categories (`unknown`) so an arbitrary error code,
 * message fragment, path, URL, email, or id-like token can never pass
 * through to a durable record. Counts stay numeric and table names stay
 * allowlisted.
 */

import { HIKOUTEI_ERROR_CODES } from "hikoutei";

/** Stable error codes the workload treats as expected validation results. */
export const EXPECTED_ERROR_CODES = Object.freeze({
  invalidField: HIKOUTEI_ERROR_CODES.INVALID_SCALAR_VALUE,
  invalidQuery: HIKOUTEI_ERROR_CODES.INVALID_QUERY,
  unmanagedEntity: HIKOUTEI_ERROR_CODES.UNMANAGED_ENTITY,
});

/**
 * Explicit allowlist of every stable machine-readable error code the soak
 * records in artifacts. Unknown codes (arbitrary `error.code` values from
 * third-party or future provider layers) must never reach artifacts as
 * free text — they could be ID-like secrets — so they map to the fixed
 * `unknown` category instead.
 */
export const KNOWN_STABLE_CODES = Object.freeze([
  ...Object.values(HIKOUTEI_ERROR_CODES),
  // Internal sync/sheets contract codes that can surface in live mode.
  "invalid_sync_effect_payload",
  "invalid_sync_provisioning",
  "invalid_sync_client_options",
  "invalid_sync_provider_response",
  "invalid_fake_sync_provider_input",
  "google_sheets_api_timeout",
  "google_sheets_api_network_error",
  "google_sheets_api_http_error",
  "google_sheets_api_invalid_response",
  "google_sheets_api_request_start_refused",
]);

/**
 * Stable error class names the soak may record in `errorClass` fields.
 *
 * Covers the harness's own error types, the library's public error class,
 * and the JS built-ins. Any other constructor name (which could embed a
 * path or id-like text) maps to the fixed `unknown` category.
 */
export const KNOWN_STABLE_CLASSES = Object.freeze([
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "EvalError",
  "URIError",
  "AggregateError",
  "HikouteiError",
  "SyncSheetsContractError",
  "GoogleSheetsApiTransportError",
  "SoakAssertionError",
  "SoakReopenCleanupError",
  "SoakDeadlineExpiredError",
  "DirectSheetsError",
]);

/**
 * Stable remote status classes the harness may record.
 *
 * `http_<NNN>` covers classified HTTP statuses; the named classes cover
 * transport failures, harness-local validation, and the run-deadline abort.
 * Any other provider string (an SDK code or payload fragment) maps to
 * `unknown`.
 */
const STATUS_CLASS_PATTERN = /^http_[1-5]\d\d$/;
const KNOWN_STATUS_CLASSES = Object.freeze([
  "network_or_unknown",
  "harness_error",
  "deadline_expired",
]);

/**
 * Stable redacted failure categories recorded in artifacts. Never a raw
 * message, id, value, or provider payload.
 */
export const FAILURE_REASON_CODES = Object.freeze({
  /** A transactional() rollback postcondition failed to verify. */
  ROLLBACK_VERIFICATION: "rollback-verification",
  /** A query result did not match the oracle (page, count, presence). */
  QUERY_MISMATCH: "query-mismatch",
  /** A findOne row existed (or was missing) contrary to the oracle. */
  PRESENCE_MISMATCH: "presence-mismatch",
  /** A loaded row's field values did not match the oracle snapshot. */
  ROW_VALUE_MISMATCH: "row-value-mismatch",
  /** A fork/identity-map contract was violated. */
  IDENTITY_CONTRACT: "identity-contract",
  /** A replay found an existing row whose content differs from the plan. */
  RECONCILE_MISMATCH: "reconcile-mismatch",
  /** An expected_* op received a different error code than documented. */
  UNEXPECTED_ERROR_CODE: "unexpected-error-code",
  /** The planned operation kind is not implemented. */
  UNKNOWN_OPERATION: "unknown-operation",
  /** Anything else: an unexpected library/provider/validation throw. */
  UNEXPECTED_THROW: "unexpected-throw",
});

/**
 * Every stable `reason` value that may be recorded across operation,
 * probe, convergence, and abort records. Unknown reasons map to the fixed
 * `unknown` category.
 */
export const KNOWN_REASON_CODES = Object.freeze([
  ...Object.values(FAILURE_REASON_CODES),
  "local-mode",
  "no-string-field",
  "human-edit-not-accepted",
  "probe-error",
  "cycle-error",
  "reopen-cleanup-failed",
  // Startup/reopen completed after the run's epoch deadline expired: the
  // runtime was closed and the cycle aborted with this stable category.
  "deadline-expired",
  // Resume recovery reasons persisted in redacted state/summary.
  "interrupted-cycle-reconciled",
  "completed-cycle-checkpoint",
  "stale-in-flight-marker",
]);

/** All accepted soak table names (`--tables` vocabulary). */
export const KNOWN_TABLE_NAMES = Object.freeze([
  "soak_customers",
  "soak_orders",
  "soak_inventory_items",
  "soak_tasks",
  "soak_audit_events",
  "soak_feature_flags",
]);

/** All accepted soak entity names (operation-record `table` vocabulary). */
export const KNOWN_ENTITY_NAMES = Object.freeze([
  "SoakCustomer",
  "SoakOrder",
  "SoakInventoryItem",
  "SoakTask",
  "SoakAuditEvent",
  "SoakFeatureFlag",
]);

/** Identifier shape shared by count keys and table names. */
const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/**
 * Stable status vocabulary allowed in `status` fields of walked records:
 * operation, probe, convergence, reopen, summary, recovery, and checkpoint
 * statuses. Any other string collapses to the fixed `unknown` category.
 */
const KNOWN_RECORD_STATUSES = Object.freeze([
  "ok",
  "skipped",
  "failed",
  "expected_error",
  "passed",
  "recovered",
  "in-flight",
  "completed",
]);

/**
 * Maps one candidate error code to the artifact-safe value: the code
 * itself when allowlisted, otherwise the fixed `unknown` category.
 */
export function sanitizeStableCode(candidate) {
  return typeof candidate === "string" && KNOWN_STABLE_CODES.includes(candidate)
    ? candidate
    : "unknown";
}

/**
 * Maps one candidate error class name to the artifact-safe value.
 *
 * Unknown class names (which could carry path or id-like text) become the
 * fixed `unknown` category.
 */
export function sanitizeErrorClass(candidate) {
  return typeof candidate === "string" && KNOWN_STABLE_CLASSES.includes(candidate)
    ? candidate
    : "unknown";
}

/**
 * Maps one candidate remote status class to the artifact-safe value.
 *
 * Numeric HTTP statuses are normalized to `http_<NNN>`; known named
 * classes pass through; every other string (an SDK code or payload
 * fragment) becomes `unknown`.
 */
export function sanitizeStatusClass(candidate) {
  if (typeof candidate !== "string" || candidate.length === 0) return "unknown";
  if (STATUS_CLASS_PATTERN.test(candidate)) return candidate;
  return KNOWN_STATUS_CLASSES.includes(candidate) ? candidate : "unknown";
}

/**
 * Maps one candidate reason category to the artifact-safe value.
 *
 * Only the stable reason vocabulary passes; anything else becomes the
 * fixed `unknown` category.
 */
export function sanitizeReason(candidate) {
  return typeof candidate === "string" && KNOWN_REASON_CODES.includes(candidate)
    ? candidate
    : "unknown";
}

/**
 * Maps one candidate table/entity name to the artifact-safe value.
 *
 * Only the soak vocabulary passes; identifier-shaped but unknown names
 * also collapse to `unknown` so a future entity rename can never leak a
 * new name into durable artifacts before it is reviewed.
 */
export function sanitizeTableName(candidate) {
  return typeof candidate === "string" &&
    (KNOWN_TABLE_NAMES.includes(candidate) || KNOWN_ENTITY_NAMES.includes(candidate))
    ? candidate
    : "unknown";
}

/**
 * Sanitizes a counts record: identifier-shaped keys keep only finite
 * numeric values; every other key/value is dropped. Never returns a
 * non-object; returns `undefined` when nothing numeric remains.
 *
 * @param {unknown} value
 * @returns {Record<string, number> | undefined}
 */
export function sanitizeCounts(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const sanitized = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (!IDENTIFIER_PATTERN.test(key)) continue;
    if (typeof entryValue !== "number" || !Number.isFinite(entryValue)) continue;
    sanitized[key] = entryValue;
  }
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

/**
 * Recursively sanitizes every redaction-sensitive field of one record.
 *
 * Strict allowlist walker: only KNOWN cycle/operation/probe/convergence/
 * reopen/abort fields survive. Known string fields map through their
 * allowlists (`code`, `reason`, `errorClass`, `statusClass`, `table`,
 * `status`), counts records are normalized to numeric identifier keys, and
 * nested objects are walked in place. Numeric counters and booleans pass
 * under identifier-shaped keys only; `null` and free-form strings under
 * unknown keys (`message`, `stack`, `payload`, `id`, `value`, `url`,
 * `path`, or arbitrary nested strings) are DROPPED, never copied, so a
 * crafted record can never smuggle text into a durable artifact.
 *
 * @param {unknown} value
 * @returns {unknown} a sanitized deep copy.
 */
export function sanitizeRecordFields(value) {
  if (Array.isArray(value)) {
    // Array elements pass the same rules; dropped entries are removed.
    const sanitized = [];
    for (const element of value) {
      const entry = sanitizeRecordFields(element);
      if (entry !== undefined) sanitized.push(entry);
    }
    return sanitized;
  }
  if (value === null || typeof value !== "object") {
    // Primitive values survive only as safe scalar categories: finite
    // numbers and booleans pass; free-form strings and null never do
    // (string fields are handled exclusively by their allowlisted keys
    // above, which are only reachable inside objects).
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "boolean") return value;
    return undefined;
  }
  const record = value;
  const result = {};
  for (const [key, entryValue] of Object.entries(record)) {
    if (key === "code") {
      result[key] = sanitizeStableCode(entryValue);
      continue;
    }
    if (key === "reason") {
      result[key] = sanitizeReason(entryValue);
      continue;
    }
    if (key === "errorClass") {
      result[key] = sanitizeErrorClass(entryValue);
      continue;
    }
    if (key === "statusClass") {
      result[key] = sanitizeStatusClass(entryValue);
      continue;
    }
    if (key === "table" || key === "tableName") {
      result[key] = sanitizeTableName(entryValue);
      continue;
    }
    if (key === "status") {
      // Known statuses pass; anything else maps to the fixed safe category
      // so a provider/SDK string can never reach an artifact as free text.
      result[key] = typeof entryValue === "string" && KNOWN_RECORD_STATUSES.includes(entryValue)
        ? entryValue
        : "unknown";
      continue;
    }
    if (key === "scan") {
      // The reopen full-scan evidence (ok/failed) is a fixed vocabulary,
      // exactly like `status`; anything else maps to the safe category so
      // free text can never reach an artifact under this key.
      result[key] = typeof entryValue === "string" && KNOWN_RECORD_STATUSES.includes(entryValue)
        ? entryValue
        : "unknown";
      continue;
    }
    if (key === "counts") {
      const sanitized = sanitizeCounts(entryValue);
      if (sanitized !== undefined) result[key] = sanitized;
      continue;
    }
    // Numeric counters and booleans survive under identifier-shaped keys
    // (counts, table names as reopen count keys, cycle numbers, flags).
    // Nested objects are walked; every other value — free-form strings,
    // null, non-identifier keys — is dropped.
    if (IDENTIFIER_PATTERN.test(key)) {
      if (typeof entryValue === "number" && Number.isFinite(entryValue)) {
        result[key] = entryValue;
        continue;
      }
      if (typeof entryValue === "boolean") {
        result[key] = entryValue;
        continue;
      }
      if (entryValue !== null && typeof entryValue === "object") {
        const nested = sanitizeRecordFields(entryValue);
        // Empty objects after sanitization carry no safe information and
        // are dropped with their key (a `payload`/`detail` that contained
        // only secrets must not survive as an empty shell).
        if (nested !== undefined && Object.keys(nested).length > 0) {
          result[key] = nested;
        }
        continue;
      }
    }
    // Unknown/free-form keys and values are dropped.
  }
  return result;
}
