/**
 * Public structured errors for the engine-neutral Hikoutei surface.
 *
 * These codes describe configuration or lifecycle failures raised before or
 * during a local entity flush. They never encode provider-specific failures:
 * the application contract stays stable when the SQLite engine changes.
 *
 * The sync_* codes classify env-driven sync auto-start failures so an
 * application can tell a malformed spreadsheet URL, a missing or invalid
 * credentials file, an authentication/access problem, and a provisioning
 * failure apart without parsing messages. They are additive and never change
 * the local-only lifecycle codes above.
 */

import { CoreErrorException } from "../domain/errors/index.js";

/** Stable machine-readable codes raised by the public Hikoutei API. */
export const HIKOUTEI_ERROR_CODES = {
  /** Entity descriptor validation failed (bad name, table, properties, or keys). */
  INVALID_ENTITY_DESCRIPTOR: "invalid_entity_descriptor",
  /** Two registered entities share the same name or table. */
  DUPLICATE_ENTITY: "duplicate_entity",
  /** An entity reference passed to the manager was not registered at startup. */
  UNREGISTERED_ENTITY: "unregistered_entity",
  /** A managed entity is missing its required primary-key value before flush. */
  ENTITY_PRIMARY_KEY_UNAVAILABLE: "entity_primary_key_unavailable",
  /** A managed entity changed its primary key, which is immutable after create. */
  ENTITY_PRIMARY_KEY_MUTATION: "entity_primary_key_mutation",
  /** A lifecycle argument does not match a managed entity instance. */
  UNMANAGED_ENTITY: "unmanaged_entity",
  /** A scalar property value could not be stored in its declared column type. */
  INVALID_SCALAR_VALUE: "invalid_scalar_value",
  /** A query uses malformed operators, unsupported operator types, or invalid ordering. */
  INVALID_QUERY: "invalid_query",
  /** A provider transaction could not find the row targeted by a managed change. */
  ENTITY_NOT_FOUND: "entity_not_found",
  /** Two different managed objects claim one descriptor/primary-key identity. */
  ENTITY_IDENTITY_CONFLICT: "entity_identity_conflict",
  /** Sync auto-start failed for an uncategorized reason (timeout, network, option). */
  SYNC_STARTUP_FAILED: "sync_startup_failed",
  /** HIKOUTEI_SYNC_SPREADSHEET_URL does not contain a parseable spreadsheet ID. */
  SYNC_SPREADSHEET_URL_INVALID: "sync_spreadsheet_url_invalid",
  /** GOOGLE_APPLICATION_CREDENTIALS points at a missing or unreadable file. */
  SYNC_CREDENTIALS_FILE_MISSING: "sync_credentials_file_missing",
  /** The credentials file is not a JSON object. */
  SYNC_CREDENTIALS_INVALID_JSON: "sync_credentials_invalid_json",
  /** The credentials file is missing required service-account fields. */
  SYNC_CREDENTIALS_FIELD_MISSING: "sync_credentials_field_missing",
  /** The remote rejected the credentials (HTTP 401). */
  SYNC_AUTH_FAILED: "sync_auth_failed",
  /** The service account is not shared on the spreadsheet or lacks edit rights (HTTP 403). */
  SYNC_SPREADSHEET_ACCESS_DENIED: "sync_spreadsheet_access_denied",
  /** The spreadsheet does not exist or the ID is wrong (HTTP 404). */
  SYNC_SPREADSHEET_NOT_FOUND: "sync_spreadsheet_not_found",
  /** Sheet provisioning failed (schema drift, invalid tab, malformed payload). */
  SYNC_PROVISIONING_FAILED: "sync_provisioning_failed",
} as const;

/** Closed set of Hikoutei API error codes. */
export type HikouteiErrorCode =
  (typeof HIKOUTEI_ERROR_CODES)[keyof typeof HIKOUTEI_ERROR_CODES];

/**
 * Error raised by the public Hikoutei lifecycle or descriptor validation.
 *
 * The stable `code` lets applications branch on a configuration or lifecycle
 * failure without parsing a human-readable message. Provider-specific storage
 * failures keep their own error contracts and are never re-wrapped here.
 */
export class HikouteiError extends CoreErrorException<"hikoutei", HikouteiErrorCode> {
  constructor(code: HikouteiErrorCode, message: string) {
    super("hikoutei", code, message);
  }
}
