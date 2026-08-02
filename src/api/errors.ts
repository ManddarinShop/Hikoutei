/**
 * Public structured errors for the engine-neutral Hikoutei surface.
 *
 * These codes describe configuration or lifecycle failures raised before or
 * during a local entity flush. They never encode provider-specific failures:
 * the application contract stays stable when the SQLite engine changes.
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
  /** A provider transaction could not find the row targeted by a managed change. */
  ENTITY_NOT_FOUND: "entity_not_found",
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
