import { APPLICABILITY_KINDS, PRESENCE_KINDS } from "./state.js";
import type { Applicability, Presence } from "./state.js";

/** Converts an internal state value to SQLite's nullable column representation. */
export function toSqlNullable<T>(value: Presence<T> | Applicability<T>): T | null {
  return value.kind === PRESENCE_KINDS.PRESENT || value.kind === APPLICABILITY_KINDS.APPLICABLE
    ? value.value
    : null;
}

/** Converts a nullable SQLite column back into an explicit internal presence state. */
export function fromSqlNullable<T>(value: T | null): Presence<T> {
  return value === null
    ? { kind: PRESENCE_KINDS.ABSENT }
    : { kind: PRESENCE_KINDS.PRESENT, value };
}
