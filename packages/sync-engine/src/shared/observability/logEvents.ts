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
 * storage, evaluation, mapped ORM, domain event identity, stable encoding)
 * plus the SQLite driver family that can surface through the persistence
 * engine. Intentionally out of scope: the CLI setup taxonomy
 * (`SETUP_ERROR_CODES` in `src/cli/errors.ts`) and the internal MCP
 * sync-status reader (`HIKOUTEI_SYNC_STATUS_ERROR_CODES` in
 * `src/internal/syncStatus.ts`) are separate tooling surfaces that never
 * route through the runtime log, and the canonical-codec family of
 * `@hikoutei/kohkai` is broader than the stable-encoding subset Hikoutei
 * actually raises. This is a deliberate allowlist: an unknown or arbitrary
 * `error.code` (which could be an ID-like secret) must never pass through
 * to the log. A test asserts the registry stays in sync with every
 * `*_ERROR_CODES` constant in the repository.
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
  // Sync sheets contract codes (packages/sync-engine/src/sync/sheetsContract/errors.ts).
  "invalid_sync_effect_payload",
  "invalid_sync_provisioning",
  "invalid_sync_client_options",
  "invalid_sync_provider_response",
  "invalid_fake_sync_provider_input",
  // Google Sheets API transport codes (@hikoutei/sheets sheets/providers/google-sheets-api/errors.ts).
  "google_sheets_api_timeout",
  "google_sheets_api_network_error",
  "google_sheets_api_http_error",
  "google_sheets_api_invalid_response",
  "google_sheets_api_request_start_refused",
  // Sync service bootstrap codes (packages/sync-engine/src/sync/service/errors.ts).
  "invalid_sync_service_options",
  "invalid_sync_projection_config",
  "sync_provider_unavailable",
  "sync_service_startup_failed",
  // Existing-sheet adoption (packages/sync-engine/src/sync/service/adopt/existingSheetAdoption.ts).
  "existing_sheet_adoption_dry_run_report",
  // Adoption seeding fail-closed cell validation (adopt/adoptionSeeding.ts).
  "existing_sheet_adoption_cell_kind_mismatch",

  // Storage/schema/effect codes (@hikoutei/storage storage/errors.ts).
  "invalid_writer_lease_options",
  "invalid_sync_registration",
  "sync_registration_write_failed",
  "sync_registration_conflict",
  "sync_registry_target_unavailable",
  "invalid_observation_input",
  "observation_storage_inconsistent",
  "observation_audit_serialization_failed",
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
  // Canonical/observation/resolution evaluation codes (src/domain/errors/evaluation.ts).
  "canonical_state_required",
  "canonical_field_required",
  "base_field_revision_required",
  // Domain event-identity code (src/domain/errors/identity.ts).
  "duplicate_changed_field",
  // Mapped ORM facade codes (packages/sync-engine/src/orm/errors.ts).
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
  // Stable-encoding codes (src/shared/encoding/constants.ts, re-exported from
  // @hikoutei/kohkai). Raised by StableEncodingError when canonical stable
  // bytes cannot be produced during flush/evidence paths.
  "unsupported_value_type",
  "non_finite_number",
  "invalid_date_format",
  "invalid_date_byte_length",
  "duplicate_object_key",
  "unpaired_high_surrogate",
  "unpaired_low_surrogate",
  "cyclic_value",
  // SQLite driver family (node:sqlite codes surfaced by the engine).
  // The persistence engine runs on MikroORM's NodeSqliteDialect over the
  // `node:sqlite` built-in (Node 22.5+), never better-sqlite3. In that
  // driver every SQLite-level failure (constraint, syntax, busy, corrupt,
  // ...) throws with the single stable code `ERR_SQLITE_ERROR`; the numeric
  // SQLite result rides on the `errcode`/`errstr` detail properties, which
  // are never logged. The node:sqlite JS API can also throw generic Node
  // codes (`ERR_INVALID_STATE`, `ERR_INVALID_ARG_TYPE`) on API misuse;
  // those are intentionally not allowlisted — they are not driver codes,
  // and the logged error class is the safe diagnostic.
  "ERR_SQLITE_ERROR",
] as const);

/**
 * Explicit registry of error class names the internal log may carry in its
 * `errorClass` field.
 *
 * Covers the JavaScript built-ins, the project's structured error classes,
 * and the current persistence engine's error families. Unknown class names
 * are redacted; losing a diagnostic detail is always safer than risking a
 * secret-like value in the log.
 *
 * Intentionally out of scope: the CLI setup taxonomy (a `SetupFailure`
 * value, never a class) and the MCP sync-status reader
 * (`HikouteiSyncStatusError` in `src/internal/syncStatus.ts`) are separate
 * tooling surfaces that never route through the runtime log, and the
 * internal storage sentinels (`FenceLostError`, `CanonicalStaleError`,
 * `AsyncFenceLostError`) are caught and converted into result kinds before
 * any boundary, so they never surface as thrown classes.
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
  "TypedSheetsOrmError",
  "SyncSheetsContractError",
  "SyncServiceError",
  "StorageError",
  "EvaluationContractError",
  "StableEncodingError",
  "DuplicateChangedFieldError",
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

/**
 * Explicit allowlist of provider-operation tags the internal log may carry in
 * its `providerOperation` field.
 *
 * Mirrors `SYNC_INVALID_PROVIDER_OPERATIONS` in
 * `packages/sync-engine/src/sync/sheetsContract/errors.ts`. Only proven invalid-
 * provider-state operations are allowed; anything else (including an ID-like
 * or secret value) is redacted by the internal log writer.
 */
export const HIKOUTEI_LOG_PROVIDER_OPERATIONS = Object.freeze([
  "preflight",
  "batch_update_reply",
  "get_reply",
  "postcondition_read",
  "unclassified",
] as const);

/**
 * Explicit allowlist of provider-reason codes the internal log may carry in
 * its `providerReason` field.
 *
 * Mirrors `SYNC_INVALID_PROVIDER_REASONS` in
 * `packages/sync-engine/src/sync/sheetsContract/errors.ts`. Every value is a stable
 * lowercase identifier with no ID/URL/payload content.
 */
export const HIKOUTEI_LOG_PROVIDER_REASONS = Object.freeze([
  "malformed_reply",
  "identity_already_exists",
  "missing_tab",
  "unclassified",
] as const);
