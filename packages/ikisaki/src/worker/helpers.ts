/** Small value and error helpers shared by effect-worker modules. */

import {
  LOOKUP_RESULT_KINDS,
  PRESENCE_KINDS,
  type Applicability,
  type LookupResult,
  type Presence,
} from "../state.js";
import {
  APPLICABILITY_KINDS,
} from "../state.js";

/** Redacts an unknown thrown value into a bounded diagnostic message. */
export function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : "unknown sync provider failure";
}

export type PresentValue<T> = {
  readonly kind: typeof PRESENCE_KINDS.PRESENT;
  readonly value: T;
};

/** Builds a present value with the shared presence tag. */
export function presentValue<T>(value: T): PresentValue<T> {
  return { kind: PRESENCE_KINDS.PRESENT, value };
}

/** Builds an absent value with the shared presence tag. */
export function absentValue<T>(): Presence<T> {
  return { kind: PRESENCE_KINDS.ABSENT };
}

export function isPresent<T>(value: Presence<T>): value is PresentValue<T> {
  return value.kind === PRESENCE_KINDS.PRESENT;
}

export function isAbsent<T>(value: Presence<T>): boolean {
  return value.kind === PRESENCE_KINDS.ABSENT;
}

export function lookupResult<T>(value: T | undefined): LookupResult<T> {
  return value === undefined
    ? { kind: LOOKUP_RESULT_KINDS.NOT_FOUND }
    : { kind: LOOKUP_RESULT_KINDS.FOUND, value };
}

export function applicabilityFromSqlNullable<T>(value: T | null): Applicability<T> {
  return value === null ? { kind: APPLICABILITY_KINDS.NOT_APPLICABLE } : { kind: APPLICABILITY_KINDS.APPLICABLE, value };
}

