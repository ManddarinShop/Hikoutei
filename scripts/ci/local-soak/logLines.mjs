/**
 * JSONL validation for collected internal log files.
 *
 * The soak collector must never byte-copy arbitrary pre-existing `.txt` or
 * backup files into `collected-log.txt`: a leftover file at the log path
 * could carry secrets. Every line is therefore validated against a mirror
 * of the internal logger's serialization contract — the exact field set,
 * level vocabulary, and event/component/code/class allowlists from
 * `src/shared/observability/logEvents.ts` — and re-serialized in the
 * logger's canonical field order. Lines that are not JSON, carry unknown
 * fields, or carry non-allowlisted (secret-bearing) values are DROPPED,
 * never redacted-and-kept, so only logger-shaped lines can reach the
 * collection.
 *
 * The mirrors are deliberate duplicates of the library's constants (the
 * runner CLI runs under plain Node and cannot import `src/**` TypeScript);
 * `test/soak-artifacts.records.test.ts` asserts they stay in sync with
 * `logEvents.ts`, and the drop direction is always fail-safe: a future
 * library event/code/class that the mirror does not yet know is dropped
 * until the mirror is reviewed and updated.
 */

/** Every field the internal logger serializes (mirror of internalLog.ts). */
export const LOGGED_FIELD_NAMES = Object.freeze([
  "ts",
  "level",
  "event",
  "component",
  "code",
  "table",
  "errorClass",
  "retryable",
  "attempts",
  "durationMs",
  "counts",
]);

/** Emission levels the logger writes (mirror of HIKOUTEI_LOG_LEVELS). */
export const LOGGED_LEVELS = Object.freeze(["debug", "info", "warn", "error"]);

/** Stable dotted event names the logger may write (mirror of HIKOUTEI_LOG_EVENTS). */
export const LOGGED_EVENT_NAMES = Object.freeze([
  "hikoutei.runtime.opened",
  "hikoutei.runtime.open_failed",
  "hikoutei.runtime.closed",
  "hikoutei.runtime.close_failed",
  "hikoutei.em.flush_failed",
  "hikoutei.em.transactional_failed",
  "hikoutei.em.query_failed",
  "hikoutei.em.lifecycle_invalid",
  "hikoutei.sync.autostart_started",
  "hikoutei.sync.autostart_failed",
  "hikoutei.sync.service_start_failed",
  "hikoutei.transport.request_failed",
  "hikoutei.transport.response_invalid",
  "hikoutei.outbox.pass_failed",
  "hikoutei.outbox.pass_summary",
  "hikoutei.reconciliation.scan_failed",
  "hikoutei.polling.pass_failed",
  "hikoutei.polling.pass_summary",
]);

/** Stable component tags the logger may write (mirror of HIKOUTEI_LOG_COMPONENTS). */
export const LOGGED_COMPONENT_NAMES = Object.freeze([
  "runtime",
  "entity-manager",
  "sync-autostart",
  "sync-service",
  "transport",
  "outbox",
  "reconciliation",
  "polling",
]);

/**
 * Stable error codes the logger may write (mirror of HIKOUTEI_LOG_STABLE_CODES).
 */
export const LOGGED_STABLE_CODES = Object.freeze([
  // Public Hikoutei API lifecycle/sync codes.
  "invalid_entity_descriptor",
  "duplicate_entity",
  "unregistered_entity",
  "entity_primary_key_unavailable",
  "entity_primary_key_mutation",
  "unmanaged_entity",
  "invalid_scalar_value",
  "invalid_query",
  "entity_not_found",
  "entity_identity_conflict",
  "sync_startup_failed",
  "sync_spreadsheet_url_invalid",
  "sync_credentials_file_missing",
  "sync_credentials_invalid_json",
  "sync_credentials_field_missing",
  "sync_auth_failed",
  "sync_spreadsheet_access_denied",
  "sync_spreadsheet_not_found",
  "sync_provisioning_failed",
  // Sync sheets contract codes.
  "invalid_sync_effect_payload",
  "invalid_sync_provisioning",
  "invalid_sync_client_options",
  "invalid_sync_provider_response",
  "invalid_fake_sync_provider_input",
  // Google Sheets API transport codes.
  "google_sheets_api_timeout",
  "google_sheets_api_network_error",
  "google_sheets_api_http_error",
  "google_sheets_api_invalid_response",
  "google_sheets_api_request_start_refused",
  // Sync service bootstrap codes.
  "invalid_sync_service_options",
  "invalid_sync_projection_config",
  "sync_provider_unavailable",
  "sync_service_startup_failed",
  "sync_service_closed",
  // Existing-sheet adoption codes.
  "existing_sheet_adoption_dry_run_report",
  "existing_sheet_adoption_not_implemented",
  // Storage/schema/effect codes.
  "invalid_writer_lease_options",
  "invalid_sync_registration",
  "sync_registration_write_failed",
  "sync_registration_conflict",
  "sync_registry_target_unavailable",
  "invalid_observation_input",
  "observation_storage_inconsistent",
  "observation_audit_serialization_failed",
  "invalid_read_only_observation",
  "invalid_effect_options",
  "invalid_pending_effect",
  "effect_write_failed",
  "effect_replan_conflict",
  "invalid_effect_result",
  "invalid_projection_confirmation",
  "projection_confirmation_regression",
  "stale_writer_fence",
  "invalid_resolution_command",
  "resolution_command_identity_conflict",
  "resolution_storage_inconsistent",
  "resolution_effect_conflict",
  "resolution_target_unavailable",
  "invalid_stored_conflict",
  "schema_version_too_new",
  "schema_table_missing",
  "schema_index_missing",
  "schema_column_missing",
  "schema_version_invalid",
  "invalid_sql_script",
  // Canonical/observation/resolution evaluation codes.
  "canonical_state_required",
  "canonical_field_required",
  "base_field_revision_required",
  // Domain event-identity code.
  "duplicate_changed_field",
  // Mapped ORM facade codes.
  "invalid_entity_mapping",
  "duplicate_entity_mapping",
  "entity_mapping_not_found",
  "entity_primary_key_mismatch",
  "invalid_mapped_field_value",
  "writer_lease_unavailable",
  "row_binding_conflict",
  "canonical_commit_rejected",
  "projection_outbox_blocked",
  "observation_entity_mutation_failed",
  // Stable-encoding codes (src/shared/encoding/constants.ts, re-exported
  // from @hikoutei/kohkai). Raised by StableEncodingError during
  // flush/evidence paths.
  "unsupported_value_type",
  "non_finite_number",
  "invalid_date_format",
  "invalid_date_byte_length",
  "duplicate_object_key",
  "unpaired_high_surrogate",
  "unpaired_low_surrogate",
  "cyclic_value",
  // SQLite driver family (node:sqlite). Every SQLite-level failure in the
  // engine's driver throws with the single stable code ERR_SQLITE_ERROR;
  // the numeric SQLite result rides on errcode/errstr detail properties,
  // which are never logged.
  "ERR_SQLITE_ERROR",
]);

/**
 * Stable error class names the logger may write (mirror of
 * HIKOUTEI_LOG_STABLE_CLASSES).
 */
export const LOGGED_STABLE_CLASSES = Object.freeze([
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "EvalError",
  "URIError",
  "AggregateError",
  "HikouteiError",
  "TypedSheetsOrmError",
  "SyncSheetsContractError",
  "SyncServiceError",
  "StorageError",
  "EvaluationContractError",
  "StableEncodingError",
  "DuplicateChangedFieldError",
  "GoogleSheetsApiTransportError",
  "ValidationError",
  "CursorError",
  "OptimisticLockError",
  "MetadataError",
  "NotFoundError",
  "TransactionStateError",
  "DriverException",
  "ConnectionException",
  "ServerException",
  "ConstraintViolationException",
  "DatabaseObjectExistsException",
  "DatabaseObjectNotFoundException",
  "DeadlockException",
  "ForeignKeyConstraintViolationException",
  "CheckConstraintViolationException",
  "InvalidFieldNameException",
  "LockWaitTimeoutException",
  "NonUniqueFieldNameException",
  "NotNullConstraintViolationException",
  "ReadOnlyException",
  "SyntaxErrorException",
  "TableExistsException",
  "TableNotFoundException",
  "UniqueConstraintViolationException",
]);

/** Identifier shape shared by table names and counts keys. */
const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** ISO-8601 millisecond timestamp shape the logger always writes. */
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const FIELD_SET = new Set(LOGGED_FIELD_NAMES);
const LEVEL_SET = new Set(LOGGED_LEVELS);
const EVENT_SET = new Set(LOGGED_EVENT_NAMES);
const COMPONENT_SET = new Set(LOGGED_COMPONENT_NAMES);
const CODE_SET = new Set(LOGGED_STABLE_CODES);
const CLASS_SET = new Set(LOGGED_STABLE_CLASSES);

/** Result of validating one raw line. */
export const LOG_LINE_VALIDATION = Object.freeze({
  VALID: "valid",
  INVALID: "invalid",
});

/**
 * Validates one raw log line against the logger's serialization contract.
 *
 * Returns `valid` with the re-serialized canonical line, or `invalid` with
 * a stable reason. Empty lines, non-JSON text, non-object JSON, unknown
 * fields, and non-allowlisted (secret-bearing) values are all rejected —
 * the collector drops them instead of copying them.
 *
 * @param {string} rawLine one line read from a log file.
 * @returns {{ status: "valid", line: string } | { status: "invalid", reason: string }}
 */
export function sanitizeCollectedLogLine(rawLine) {
  const trimmed = String(rawLine).trim();
  if (trimmed === "") return { status: "invalid", reason: "empty-line" };
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { status: "invalid", reason: "not-json" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { status: "invalid", reason: "not-object" };
  }
  const record = parsed;
  for (const key of Object.keys(record)) {
    if (!FIELD_SET.has(key)) return { status: "invalid", reason: "unknown-field" };
  }
  if (typeof record.ts !== "string" || !TIMESTAMP_PATTERN.test(record.ts)) {
    return { status: "invalid", reason: "ts-unsafe" };
  }
  if (!LEVEL_SET.has(record.level)) {
    return { status: "invalid", reason: "level-unsafe" };
  }
  if (!EVENT_SET.has(record.event)) {
    return { status: "invalid", reason: "event-unsafe" };
  }
  if (record.component !== undefined && !COMPONENT_SET.has(record.component)) {
    return { status: "invalid", reason: "component-unsafe" };
  }
  if (record.code !== undefined && !CODE_SET.has(record.code)) {
    return { status: "invalid", reason: "code-unsafe" };
  }
  if (record.table !== undefined && !IDENTIFIER_PATTERN.test(record.table)) {
    return { status: "invalid", reason: "table-unsafe" };
  }
  if (record.errorClass !== undefined && !CLASS_SET.has(record.errorClass)) {
    return { status: "invalid", reason: "error-class-unsafe" };
  }
  if (record.retryable !== undefined && typeof record.retryable !== "boolean") {
    return { status: "invalid", reason: "retryable-unsafe" };
  }
  for (const key of ["attempts", "durationMs"]) {
    if (record[key] !== undefined &&
        (typeof record[key] !== "number" || !Number.isFinite(record[key]))) {
      return { status: "invalid", reason: `${key}-unsafe` };
    }
  }
  if (record.counts !== undefined) {
    if (record.counts === null ||
        typeof record.counts !== "object" ||
        Array.isArray(record.counts)) {
      return { status: "invalid", reason: "counts-unsafe" };
    }
    for (const [key, value] of Object.entries(record.counts)) {
      if (!IDENTIFIER_PATTERN.test(key) ||
          typeof value !== "number" ||
          !Number.isFinite(value)) {
        return { status: "invalid", reason: "counts-unsafe" };
      }
    }
  }
  // Re-serialize in the logger's canonical field order so only the known
  // shape ever reaches the collection.
  const line = {
    ts: record.ts,
    level: record.level,
    event: record.event,
    ...(record.component === undefined ? {} : { component: record.component }),
    ...(record.code === undefined ? {} : { code: record.code }),
    ...(record.table === undefined ? {} : { table: record.table }),
    ...(record.errorClass === undefined ? {} : { errorClass: record.errorClass }),
    ...(record.retryable === undefined ? {} : { retryable: record.retryable }),
    ...(record.attempts === undefined ? {} : { attempts: record.attempts }),
    ...(record.durationMs === undefined ? {} : { durationMs: record.durationMs }),
    ...(record.counts === undefined ? {} : { counts: record.counts }),
  };
  return { status: "valid", line: `${JSON.stringify(line)}\n` };
}
