/** Stable error categories shared by the storage layer. */
export const STORAGE_ERROR_CODES = {
  INVALID_WRITER_LEASE_OPTIONS: "invalid_writer_lease_options",
  INVALID_SYNC_REGISTRATION: "invalid_sync_registration",
  SYNC_REGISTRATION_WRITE_FAILED: "sync_registration_write_failed",
  SYNC_REGISTRATION_CONFLICT: "sync_registration_conflict",
  SYNC_REGISTRY_TARGET_UNAVAILABLE: "sync_registry_target_unavailable",
  INVALID_OBSERVATION_INPUT: "invalid_observation_input",
  OBSERVATION_STORAGE_INCONSISTENT: "observation_storage_inconsistent",
  OBSERVATION_AUDIT_SERIALIZATION_FAILED: "observation_audit_serialization_failed",
  /** Compatibility code for the still-supported internal observation path. */
  INVALID_READ_ONLY_OBSERVATION: "invalid_read_only_observation",
  INVALID_EFFECT_OPTIONS: "invalid_effect_options",
  INVALID_PENDING_EFFECT: "invalid_pending_effect",
  EFFECT_WRITE_FAILED: "effect_write_failed",
  EFFECT_REPLAN_CONFLICT: "effect_replan_conflict",
  INVALID_EFFECT_RESULT: "invalid_effect_result",
  INVALID_PROJECTION_CONFIRMATION: "invalid_projection_confirmation",
  PROJECTION_CONFIRMATION_REGRESSION: "projection_confirmation_regression",
  STALE_WRITER_FENCE: "stale_writer_fence",
  INVALID_RESOLUTION_COMMAND: "invalid_resolution_command",
  RESOLUTION_COMMAND_IDENTITY_CONFLICT: "resolution_command_identity_conflict",
  RESOLUTION_STORAGE_INCONSISTENT: "resolution_storage_inconsistent",
  RESOLUTION_EFFECT_CONFLICT: "resolution_effect_conflict",
  RESOLUTION_TARGET_UNAVAILABLE: "resolution_target_unavailable",
  INVALID_STORED_CONFLICT: "invalid_stored_conflict",
  SCHEMA_VERSION_TOO_NEW: "schema_version_too_new",
  SCHEMA_TABLE_MISSING: "schema_table_missing",
  SCHEMA_INDEX_MISSING: "schema_index_missing",
  SCHEMA_COLUMN_MISSING: "schema_column_missing",
  SCHEMA_VERSION_INVALID: "schema_version_invalid",
  INVALID_SQL_SCRIPT: "invalid_sql_script",
} as const;

export type StorageErrorCode =
  (typeof STORAGE_ERROR_CODES)[keyof typeof STORAGE_ERROR_CODES];

/** Error raised when storage input, schema, or runtime prerequisites are invalid. */
export class StorageError extends Error {
  readonly code: StorageErrorCode;

  constructor(code: StorageErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StorageError";
    this.code = code;
  }
}
