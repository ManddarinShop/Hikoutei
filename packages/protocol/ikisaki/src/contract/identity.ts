/**
 * Semantic brands for queue identifiers and evidence values.
 *
 * These brands prevent unrelated IDs and hashes from being mixed inside the
 * queue contracts while remaining plain strings at SQLite and JSON boundaries.
 * They are the package's own brands: the host application never needs to name
 * them because every package input accepts plain strings and every branded
 * output remains a plain string at runtime.
 */

import {
  isNonEmptyString,
  isNonNegativeSafeInteger,
} from "./validation.js";
import { KERNEL_INPUT_ERROR_CODES, KernelInputError } from "./errors.js";

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

export type OutboxEffectId = SemanticString<"effect-id">;
export type OutboxEffectDedupeKey = SemanticString<"effect-dedupe-key">;
export type OutboxPayloadHash = SemanticString<"payload-hash">;
export type OutboxPhysicalSheetId = SemanticString<"physical-sheet-id">;
export type OutboxRowBindingId = SemanticString<"row-binding-id">;
export type OutboxVisibleHash = SemanticString<"visible-hash">;
export type OutboxRevision = SemanticRevision;

/** Promotes a validated non-empty string to one semantic string type. */
export function requireSemanticString<Label extends string>(
  value: unknown,
  label: string,
): SemanticString<Label> {
  if (!isNonEmptyString(value)) {
    throw new KernelInputError(KERNEL_INPUT_ERROR_CODES.NON_EMPTY_STRING_REQUIRED, label);
  }
  return value as SemanticString<Label>;
}

/** Checks whether an unknown value is a non-negative safe integer revision. */
export function isSemanticRevision(value: unknown): value is OutboxRevision {
  return isNonNegativeSafeInteger(value);
}
