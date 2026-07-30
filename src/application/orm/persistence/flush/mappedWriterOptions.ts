/** Validated writer settings shared by mapped flush and inbound polling. */

import { randomUUID } from "node:crypto";

import {
  EMPTY_STRING_LENGTH_ZERO,
  POSITIVE_SAFE_INTEGER_MINIMUM,
} from "../../../../domain/index.js";
import {
  TYPED_SHEETS_ORM_ERROR_CODES,
  TypedSheetsOrmError,
} from "../../errors.js";
import {
  DEFAULT_MAPPED_WRITER_LEASE_DURATION_MS,
  DEFAULT_MAPPED_WRITER_ROLE,
  type ResolvedWriterOptions,
  type TypedSheetsEntityWriterOptions,
} from "../support/contracts.js";

/** Resolves and validates writer identity/options used by mapped persistence. */
export function resolveTypedSheetsEntityWriterOptions(
  options: TypedSheetsEntityWriterOptions,
): ResolvedWriterOptions {
  if (options.writerId.length === EMPTY_STRING_LENGTH_ZERO) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.INVALID_ENTITY_MAPPING,
      "mapped writer ID is required.",
    );
  }
  const role = options.role ?? DEFAULT_MAPPED_WRITER_ROLE;
  const leaseDurationMs = options.leaseDurationMs ?? DEFAULT_MAPPED_WRITER_LEASE_DURATION_MS;
  if (
    role.length === EMPTY_STRING_LENGTH_ZERO ||
    !Number.isSafeInteger(leaseDurationMs) ||
    leaseDurationMs < POSITIVE_SAFE_INTEGER_MINIMUM
  ) {
    throw new TypedSheetsOrmError(
      TYPED_SHEETS_ORM_ERROR_CODES.INVALID_ENTITY_MAPPING,
      "mapped writer role and lease duration must be valid.",
    );
  }
  return {
    writerId: options.writerId,
    role,
    leaseDurationMs,
    now: options.now ?? (() => Date.now()),
    createId: options.createId ?? randomUUID,
    onTiming: options.onTiming,
  };
}
