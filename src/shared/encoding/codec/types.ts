/** Generic tagged date representation understood by stable_encode_v1. */
export interface StableCodecDateValue {
  readonly kind: "date";
  readonly value: string;
}

/** Values accepted by the generic stable encoding grammar. */
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
