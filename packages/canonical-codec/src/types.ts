/**
 * Public value types for the canonical codec grammar.
 *
 * These types describe the runtime-neutral inputs that the canonical codec
 * (this package) accepts. They mirror the generic codec contract that the
 * Hikoutei repository previously kept under `src/shared/encoding/codec`. They
 * deliberately contain no Google SDK, SQLite, Node, or platform-specific types.
 */

/** Generic tagged date representation understood by `stable_encode_v1`. */
export interface StableCodecDateValue {
  readonly kind: "date";
  readonly value: string;
}

/**
 * Values accepted by the generic stable encoding grammar.
 *
 * Scalars, arrays, dates, and objects with string keys. Objects shaped like
 * {@link StableCodecDateValue} are encoded as dates, not as plain objects.
 */
export type StableCodecValue =
  | null
  | boolean
  | number
  | string
  | StableCodecDateValue
  | readonly StableCodecValue[]
  | { readonly [key: string]: StableCodecValue };

/** JSON values accepted by the generic canonical JSON grammar. */
export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };
