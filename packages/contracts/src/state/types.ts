import {
  APPLICABILITY_KINDS,
  LOOKUP_RESULT_KINDS,
  PRESENCE_KINDS,
} from "./constants.js";

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
