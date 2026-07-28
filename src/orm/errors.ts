/**
 * Structured errors raised by the public typed-sheets ORM composition layer.
 *
 * Storage failures retain their existing `StorageError` contract. These codes
 * describe configuration or lifecycle failures before a storage primitive can
 * safely continue.
 */

import { CoreErrorException } from "../core/errors/index.js";

/** Stable codes emitted by entity mapping and mapped lifecycle helpers. */
export const TYPED_SHEETS_ORM_ERROR_CODES = {
  INVALID_ENTITY_MAPPING: "invalid_entity_mapping",
  DUPLICATE_ENTITY_MAPPING: "duplicate_entity_mapping",
  ENTITY_MAPPING_NOT_FOUND: "entity_mapping_not_found",
  ENTITY_PRIMARY_KEY_UNAVAILABLE: "entity_primary_key_unavailable",
  ENTITY_PRIMARY_KEY_MISMATCH: "entity_primary_key_mismatch",
  ENTITY_PRIMARY_KEY_MUTATION: "entity_primary_key_mutation",
  INVALID_MAPPED_FIELD_VALUE: "invalid_mapped_field_value",
  WRITER_LEASE_UNAVAILABLE: "writer_lease_unavailable",
  ROW_BINDING_CONFLICT: "row_binding_conflict",
  CANONICAL_COMMIT_REJECTED: "canonical_commit_rejected",
  PROJECTION_OUTBOX_BLOCKED: "projection_outbox_blocked",
  OBSERVATION_ENTITY_MUTATION_FAILED: "observation_entity_mutation_failed",
} as const;

/** Closed set of typed-sheets ORM composition error codes. */
export type TypedSheetsOrmErrorCode =
  (typeof TYPED_SHEETS_ORM_ERROR_CODES)[keyof typeof TYPED_SHEETS_ORM_ERROR_CODES];

/**
 * Error raised when mapping metadata or its lifecycle plan is unsafe.
 *
 * The stable `code` lets applications distinguish a bad entity mapping from a
 * temporary writer-lease race without parsing an English error message.
 */
export class TypedSheetsOrmError extends CoreErrorException<
  "typed_sheets_orm",
  TypedSheetsOrmErrorCode
> {
  constructor(code: TypedSheetsOrmErrorCode, message: string) {
    super("typed_sheets_orm", code, message);
  }
}
