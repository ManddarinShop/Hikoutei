/**
 * Shared state tags used by the consistency-queue contracts.
 *
 * These are structurally identical to the host application's shared state
 * tags so values flow across the package boundary without conversion.
 */

/** Runtime tags for values that may be present or absent. */
export const PRESENCE_KINDS = {
  PRESENT: "present",
  ABSENT: "absent",
} as const;

/** Runtime tags for lookup results. */
export const LOOKUP_RESULT_KINDS = {
  FOUND: "found",
  NOT_FOUND: "not_found",
} as const;

/** Runtime tags for values that may apply to an operation. */
export const APPLICABILITY_KINDS = {
  APPLICABLE: "applicable",
  NOT_APPLICABLE: "not_applicable",
} as const;

/** A value that is either present or explicitly absent. */
export type Presence<T> =
  | { readonly kind: typeof PRESENCE_KINDS.PRESENT; readonly value: T }
  | { readonly kind: typeof PRESENCE_KINDS.ABSENT };

/** A lookup that either found a value or explicitly found no value. */
export type LookupResult<T> =
  | { readonly kind: typeof LOOKUP_RESULT_KINDS.FOUND; readonly value: T }
  | { readonly kind: typeof LOOKUP_RESULT_KINDS.NOT_FOUND };

/** A value that applies to an operation or is not meaningful for it. */
export type Applicability<T> =
  | { readonly kind: typeof APPLICABILITY_KINDS.APPLICABLE; readonly value: T }
  | { readonly kind: typeof APPLICABILITY_KINDS.NOT_APPLICABLE };
