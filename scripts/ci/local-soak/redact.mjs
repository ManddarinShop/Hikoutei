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
 * EXACT set of stale-write/compare-and-set (CAS) / conflict evidence codes
 * a raced local write may legitimately produce.
 *
 * Only these codes — the sync provider's guard/hash-mismatch codes — count
 * as a proven stale-write conflict for the race scenarios. Validation codes
 * (invalid scalar/query), transport/network failures, provisioning errors,
 * and any unknown code are NOT stale-write evidence and must never be
 * treated as an expected CAS conflict.
 */
export const CAS_STALE_CONFLICT_CODES = Object.freeze([
  "visible_guard_mismatch",
  "candidate_guard_mismatch",
  "repair_guard_mismatch",
  "invalid_deletion_guard",
  "postcondition_hash_mismatch",
]);

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
  // Exact stale-write/compare-and-set conflict evidence from the sync
  // provider contract (see CAS_STALE_CONFLICT_CODES). These are stable
  // public contract codes, allowlisted here so a real guard-mismatch code
  // redacts unchanged if it ever reaches an artifact.
  ...CAS_STALE_CONFLICT_CODES,
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
  // Legacy SDK artifact vocabulary, kept accepted ONLY for resume
  // compatibility. The classifier now aliases a `network_or_unknown` SDK
  // input to the canonical `network` class, so new artifacts record
  // `network`, never `network_or_unknown`.
  "network_or_unknown",
  "harness_error",
  "deadline_expired",
  "timeout",
  "network",
  "missing_tab",
  "missing_header",
  "missing_identity",
  // A direct human write whose postcondition could not be verified on the
  // intended identity row (value placed on another identity, an absent or
  // duplicated identity, or a duplicate value): a non-retryable harness
  // failure emitted by the direct client's identity-shift guard.
  "identity_shifted",
  // A direct-write tab's header row is malformed (empty header, duplicate
  // header, or a request to write the `id` column itself): a non-retryable
  // harness failure emitted before writing and during postcondition
  // promotion.
  "malformed_header",
  // A sheetId from an untrusted SDK response is not a non-negative safe
  // integer (null, string, fraction, NaN, negative, or out-of-safe-range):
  // a non-retryable harness failure so a malformed id never reaches an
  // update/delete request.
  "malformed_sheet_id",
  // A FULFILLED SDK response whose `data.sheets` is not an array (mutate
  // snapshot/read or cleanup list path): a non-retryable harness failure
  // emitted instead of a raw TypeError on a malformed payload, carrying no
  // raw payload.
  "malformed_reply",
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
  "scenario-error",
  // Scenario fail-closed categories (a sync-capable context that cannot run
  // a scenario is a recorded failure, never a local-mode skip): the live
  // observation client or spreadsheet is missing, or the run mode is
  // unknown/malformed.
  "live-context-incomplete",
  "unknown-mode",
  // Scenario limitation categories (recorded when an attack scenario's live
  // step is intentionally not fully exercised, never as an arbitrary
  // failure): recovery of an invalid human input was not directly observed,
  // and the close/reopen step of the reopen scenario was skipped because
  // the harness exposes no runner-owned runtime-replacement seam.
  "recovery-not-observed",
  "reopen-skipped",
  // The invalid human input's rejection could not be observed within the
  // bounded authority poll (the scenario records a truthful skip instead of
  // claiming an unobserved expected error).
  "rejection-not-observable",
  // The invalid human input was silently ACCEPTED into the authority — the
  // corruption/non-recovery failure this scenario hunts (a real failure).
  "invalid-accepted",
  // The local-vs-human race winner is nondeterministic and cannot be proven
  // from public reads alone; the scenario verifies observable invariants
  // (no duplicate, no endless retry) and records this limitation.
  "winner-not-verified",
  // The local-vs-human race winner WAS resolved by a bounded public-authority
  // observation (local or human value present in the authority, or the
  // delete provably committed), with no silent loss: the race outcome is a
  // verified ok.
  "race-winner-verified",
  // The invalid human input's dedicated row projection never appeared in the
  // Sheet within the bounded window, so the invalid write was never attempted
  // (the scenario records a truthful skip).
  "projection-not-ready",
  // The invalid human input was written but its cell value could not be
  // observed on the Sheet within the bound, so an unchanged authority cannot
  // be called a proven rejection (the scenario records a truthful skip).
  "sheet-evidence-unavailable",
  // The delete/recreate projection residue check is deferred to the cycle's
  // convergence check (which excludes tombstones); the scenario verifies
  // only the observable authority invariant.
  "projection-residue-deferred",
  // The shifted-human-edit race settled with the identity invariant intact:
  // the human edit landed on the intended identity row, or every rejection
  // was the fail-closed `identity_shifted` guard (a verified ok).
  "guard-invariant-verified",
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
 * True when a rejected write's error carries EXACT stale-write/CAS/conflict
 * evidence: a string `code` on {@link CAS_STALE_CONFLICT_CODES}. Only such
 * evidence classifies a rejection as an expected compare-and-set conflict;
 * a validation/transport/direct-write/unknown code is never treated as
 * stale/conflict.
 *
 * @param {unknown} error a rejected promise's reason.
 * @returns {boolean}
 */
export function isStaleConflictEvidence(error) {
  return error !== null && typeof error === "object" &&
    typeof error?.code === "string" && CAS_STALE_CONFLICT_CODES.includes(error.code);
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
 * True when a candidate is a status class a recorded artifact may carry:
 * a named class, a normalized `http_<NNN>`, the legacy `network_or_unknown`
 * artifact vocabulary, or the fixed redaction category `unknown` (which
 * {@link sanitizeStatusClass} emits for any unparseable status). This
 * mirrors {@link sanitizeStatusClass} so a written artifact (including one
 * whose status collapsed to `unknown`) is always accepted back on resume.
 *
 * @param {unknown} candidate
 * @returns {boolean}
 */
export function isKnownStatusClass(candidate) {
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  // The fixed redaction category (an unparseable status collapse) is a
  // value the sanitizer itself produces, so it must validate on resume.
  if (candidate === "unknown") return true;
  if (STATUS_CLASS_PATTERN.test(candidate)) return true;
  return KNOWN_STATUS_CLASSES.includes(candidate);
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
