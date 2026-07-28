/** Small value and error helpers shared by effect-worker modules. */

import type { Applicability, LookupResult, Presence } from "../../../domain/index.js";
import {
  APPLICABILITY_KINDS,
  LOOKUP_RESULT_KINDS,
  PRESENCE_KINDS,
} from "../../../shared/state/constants.js";
import {
  STORAGE_ERROR_CODES,
  StorageError,
} from "../../../infrastructure/storage/errors.js";

export function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : "unknown sync gateway failure";
}

export interface CandidateBlockSqlRow {
  readonly blocked: number;
}

export type PresentValue<T> = {
  readonly kind: typeof PRESENCE_KINDS.PRESENT;
  readonly value: T;
};

export function presentValue<T>(value: T): Presence<T> {
  return { kind: PRESENCE_KINDS.PRESENT, value };
}

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
  return value === null
    ? { kind: APPLICABILITY_KINDS.NOT_APPLICABLE }
    : { kind: APPLICABILITY_KINDS.APPLICABLE, value };
}

export function throwWorkerError(message: string): never {
  throw new StorageError(STORAGE_ERROR_CODES.INVALID_PENDING_EFFECT, message);
}

