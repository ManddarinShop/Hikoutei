/**
 * Internal semantic brands for identifiers and evidence values.
 *
 * These brands prevent unrelated IDs and hashes from being mixed inside the
 * sync/storage engine while remaining plain strings at SQLite and JSON
 * boundaries. They are intentionally not exported from the public root API.
 */

import {
  isNonEmptyString,
  isNonNegativeSafeInteger,
} from "../validation.js";
import {
  CONTRACTS_INPUT_ERROR_CODES,
  ContractsInputError,
} from "../domain/errors/input.js";

declare const semanticStringBrand: unique symbol;
declare const semanticNumberBrand: unique symbol;

/** A string carrying a compile-time semantic label. */
export type SemanticString<Label extends string> = string & {
  readonly [semanticStringBrand]: Label;
};

/** A non-negative safe integer carrying a compile-time semantic label. */
export type SemanticRevision<Label extends string = "revision"> = number & {
  readonly [semanticNumberBrand]: Label;
};

export type HikouteiEntityId = SemanticString<"entity-id">;
export type HikouteiCanonicalEntityId = SemanticString<"canonical-entity-id">;
export type HikouteiRowBindingId = SemanticString<"row-binding-id">;
export type HikouteiEffectId = SemanticString<"effect-id">;
export type HikouteiEffectDedupeKey = SemanticString<"effect-dedupe-key">;
export type HikouteiPhysicalSheetId = SemanticString<"physical-sheet-id">;
export type HikouteiStableHash = SemanticString<"stable-hash">;
export type HikouteiBusinessKeyHash = SemanticString<"business-key-hash">;
export type HikouteiPayloadHash = SemanticString<"payload-hash">;
export type HikouteiVisibleHash = SemanticString<"visible-hash">;
export type HikouteiSnapshotHash = SemanticString<"snapshot-hash">;
export type HikouteiRequestId = SemanticString<"request-id">;
export type HikouteiClaimToken = SemanticString<"claim-token">;
export type HikouteiRevision = SemanticRevision;

/** Promotes a validated non-empty string to one semantic string type. */
export function requireSemanticString<Label extends string>(
  value: unknown,
  label: string,
): SemanticString<Label> {
  if (!isNonEmptyString(value)) {
    throw new ContractsInputError(CONTRACTS_INPUT_ERROR_CODES.NON_EMPTY_STRING_REQUIRED, label);
  }
  return value as SemanticString<Label>;
}

/** Promotes a validated non-negative safe integer to a revision type. */
export function requireSemanticRevision<Label extends string = "revision">(
  value: unknown,
  label = "revision",
): SemanticRevision<Label> {
  if (!isNonNegativeSafeInteger(value)) {
    throw new ContractsInputError(CONTRACTS_INPUT_ERROR_CODES.NON_NEGATIVE_INTEGER_REQUIRED, label);
  }
  return value as SemanticRevision<Label>;
}

/** Checks whether an unknown value is a non-negative safe integer revision. */
export function isSemanticRevision(value: unknown): value is HikouteiRevision {
  return isNonNegativeSafeInteger(value);
}

/** Promotes a stable hash after checking the representation used by storage. */
export function requireHash<Label extends string>(
  value: unknown,
  label: string,
): SemanticString<Label> {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value)) {
    throw new ContractsInputError(CONTRACTS_INPUT_ERROR_CODES.SHA256_HASH_REQUIRED, label);
  }
  return value as SemanticString<Label>;
}
