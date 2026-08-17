/**
 * Stable internal log event names and component tags.
 *
 * Boundaries must emit only these constants so downstream log analysis can
 * key on stable strings. All names pass the identifier allowlist enforced by
 * `internalLog.ts`. Internal only — never exported from the root barrel.
 */

/** Dotted event names emitted at instrumented boundaries. */
export const HIKOUTEI_LOG_EVENTS = {
  /** Local or mapped runtime opened successfully. */
  RUNTIME_OPENED: "hikoutei.runtime.opened",
  /** Runtime open failed (storage init, descriptor resolution, provider). */
  RUNTIME_OPEN_FAILED: "hikoutei.runtime.open_failed",
  /** Runtime closed after stopping internal service work. */
  RUNTIME_CLOSED: "hikoutei.runtime.closed",
  /** Runtime close failed (provider close or shutdown hook). */
  RUNTIME_CLOSE_FAILED: "hikoutei.runtime.close_failed",
  /** EntityManager flush failed inside its provider transaction. */
  EM_FLUSH_FAILED: "hikoutei.em.flush_failed",
  /** A transactional() callback or its commit failed and rolled back. */
  EM_TRANSACTIONAL_FAILED: "hikoutei.em.transactional_failed",
  /** A find/findOne/count/findAndCount read failed. */
  EM_QUERY_FAILED: "hikoutei.em.query_failed",
  /** A lifecycle call (create/persist/remove) failed validation. */
  EM_LIFECYCLE_INVALID: "hikoutei.em.lifecycle_invalid",
  /** Sync auto-start succeeded and the service is running. */
  SYNC_AUTOSTART_STARTED: "hikoutei.sync.autostart_started",
  /** Sync auto-start failed (config, credentials, transport, provisioning). */
  SYNC_AUTOSTART_FAILED: "hikoutei.sync.autostart_failed",
  /** The internal sync service bootstrap failed and is cleaning up. */
  SYNC_SERVICE_START_FAILED: "hikoutei.sync.service_start_failed",
  /** One Google Sheets transport request failed (HTTP, timeout, network). */
  TRANSPORT_REQUEST_FAILED: "hikoutei.transport.request_failed",
  /** One Google Sheets response failed shape validation. */
  TRANSPORT_RESPONSE_INVALID: "hikoutei.transport.response_invalid",
  /** One effect-worker pass threw (claim/dispatch/postcondition error). */
  OUTBOX_PASS_FAILED: "hikoutei.outbox.pass_failed",
  /** Non-idle effect-worker pass summary (counts only). */
  OUTBOX_PASS_SUMMARY: "hikoutei.outbox.pass_summary",
  /** A reconciliation or User_Input cleanup scan failed (fail-open repair net). */
  RECONCILIATION_SCAN_FAILED: "hikoutei.reconciliation.scan_failed",
  /** A User_Input polling pass threw; the supervisor backs off and retries. */
  POLLING_PASS_FAILED: "hikoutei.polling.pass_failed",
  /** Non-idle polling pass summary (counts only, quarantines included). */
  POLLING_PASS_SUMMARY: "hikoutei.polling.pass_summary",
} as const;

/** Stable component tags naming the owning subsystem. */
export const HIKOUTEI_LOG_COMPONENTS = {
  RUNTIME: "runtime",
  ENTITY_MANAGER: "entity-manager",
  SYNC_AUTOSTART: "sync-autostart",
  SYNC_SERVICE: "sync-service",
  TRANSPORT: "transport",
  OUTBOX: "outbox",
  RECONCILIATION: "reconciliation",
  POLLING: "polling",
} as const;

/**
 * Explicit registry of every stable machine-readable error code the
 * internal log may carry in its `code` field.
 *
 * The literal strings mirror the `*_ERROR_CODES` constants across layers
 * (public API, sync sheets contract, Google Sheets transport, sync service,
 * storage, evaluation, mapped ORM) plus the SQLite driver family that can
 * surface through the persistence engine. This is a deliberate allowlist:
 * an unknown or arbitrary `error.code` (which could be an ID-like secret)
 * must never pass through to the log. A test asserts the registry stays in
 * sync with every `*_ERROR_CODES` constant in the repository.
 */
export const HIKOUTEI_LOG_STABLE_CODES = Object.freeze([
  // Public Hikoutei API lifecycle/sync codes (src/api/errors.ts).
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
  // Sync sheets contract codes (src/application/sync/sheetsContract/errors.ts).
  "invalid_sync_effect_payload",
  "invalid_sync_provisioning",
  "invalid_sync_client_options",
  "invalid_sync_provider_response",
  "invalid_fake_sync_provider_input",
  // Google Sheets API transport codes (src/adapter/sheets/providers/google-sheets-api/errors.ts).
  "google_sheets_api_timeout",
  "google_sheets_api_network_error",
  "google_sheets_api_http_error",
  "google_sheets_api_invalid_response",
  "google_sheets_api_request_start_refused",
  // Sync service bootstrap codes (src/application/sync/service/errors.ts).
  "invalid_sync_service_options",
  "invalid_sync_projection_config",
  "sync_provider_unavailable",
  "sync_service_startup_failed",
  "sync_service_closed",
  // Canonical/observation/resolution evaluation codes (src/domain/errors/evaluation.ts).
  "canonical_state_required",
  "canonical_field_required",
  "base_field_revision_required",
  // Storage/schema/effect codes (src/infrastructure/storage/errors.ts).
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
  // Mapped ORM facade codes (src/application/orm/errors.ts).
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
  // SQLite driver family (better-sqlite3 codes surfaced by the engine).
  "SQLITE_ERROR",
  "SQLITE_INTERNAL",
  "SQLITE_PERM",
  "SQLITE_ABORT",
  "SQLITE_BUSY",
  "SQLITE_LOCKED",
  "SQLITE_NOMEM",
  "SQLITE_READONLY",
  "SQLITE_INTERRUPT",
  "SQLITE_IOERR",
  "SQLITE_CORRUPT",
  "SQLITE_NOTFOUND",
  "SQLITE_FULL",
  "SQLITE_CANTOPEN",
  "SQLITE_PROTOCOL",
  "SQLITE_EMPTY",
  "SQLITE_SCHEMA",
  "SQLITE_TOOBIG",
  "SQLITE_CONSTRAINT",
  "SQLITE_MISMATCH",
  "SQLITE_MISUSE",
  "SQLITE_NOLFS",
  "SQLITE_AUTH",
  "SQLITE_FORMAT",
  "SQLITE_RANGE",
  "SQLITE_NOTADB",
  "SQLITE_NOTICE",
  "SQLITE_WARNING",
  "SQLITE_ROW",
  "SQLITE_DONE",
  "SQLITE_CONSTRAINT_UNIQUE",
  "SQLITE_CONSTRAINT_PRIMARYKEY",
  "SQLITE_CONSTRAINT_NOTNULL",
  "SQLITE_CONSTRAINT_CHECK",
  "SQLITE_CONSTRAINT_FOREIGNKEY",
  "SQLITE_CONSTRAINT_TRIGGER",
  "SQLITE_CONSTRAINT_DATATYPE",
] as const);

/**
 * Explicit registry of error class names the internal log may carry in its
 * `errorClass` field.
 *
 * Covers the JavaScript built-ins, the project's structured error classes,
 * and the current persistence engine's error families. Unknown class names
 * are redacted; losing a diagnostic detail is always safer than risking a
 * secret-like value in the log.
 */
export const HIKOUTEI_LOG_STABLE_CLASSES = Object.freeze([
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
  // MikroORM validation and driver exception families.
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
] as const);
