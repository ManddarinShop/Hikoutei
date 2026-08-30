import { APPLICABILITY_KINDS, PRESENCE_KINDS } from "./constants.js";
import type { Applicability, Presence } from "./types.js";

/** Wraps a value in an explicit present state. */
export function presentValue<T>(value: T): Presence<T> {
  return { kind: PRESENCE_KINDS.PRESENT, value };
}

/** Represents a value that is explicitly absent. */
export function absentValue<T>(): Presence<T> {
  return { kind: PRESENCE_KINDS.ABSENT };
}

/** Wraps a value in an explicit applicable state. */
export function applicableValue<T>(value: T): Applicability<T> {
  return { kind: APPLICABILITY_KINDS.APPLICABLE, value };
}

/** Represents a value that is not applicable to the current operation. */
export function notApplicableValue<T>(): Applicability<T> {
  return { kind: APPLICABILITY_KINDS.NOT_APPLICABLE };
}
