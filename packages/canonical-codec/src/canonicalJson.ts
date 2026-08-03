/**
 * Canonical JSON encoder for signed payloads.
 *
 * Canonical JSON sorts object keys, rejects sparse arrays, rejects non-finite
 * numbers, and rejects cyclic structures, producing byte-stable text suitable
 * for cross-runtime signing. The grammar and bytes mirror the deployed Apps
 * Script gateway so the two runtimes agree on every payload hash.
 */

import {
  CANONICAL_CODEC_ERROR_CODES,
  CanonicalCodecError,
} from "./errors.js";
import { isRecord } from "./guards.js";
import type { CanonicalJsonValue } from "./types.js";

/** Checks whether a value belongs to the canonical JSON input grammar. */
export function isCanonicalJsonValue(value: unknown): value is CanonicalJsonValue {
  return isCanonicalJsonValueInternal(value, new Set<object>());
}

/** Encodes a JSON-compatible value with the versioned signed-payload rules. */
export function canonicalJson(value: unknown): string {
  return encodeCanonicalJson(value, new Set<object>());
}

function isCanonicalJsonValueInternal(
  value: unknown,
  ancestors: Set<object>,
): value is CanonicalJsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    if (!isDenseArray(value) || ancestors.has(value)) return false;
    ancestors.add(value);
    try {
      return value.every((item) => isCanonicalJsonValueInternal(item, ancestors));
    } finally {
      ancestors.delete(value);
    }
  }
  if (!isPlainRecord(value) || ancestors.has(value)) return false;
  ancestors.add(value);
  try {
    return Object.values(value).every((item) => isCanonicalJsonValueInternal(item, ancestors));
  } finally {
    ancestors.delete(value);
  }
}

function encodeCanonicalJson(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return canonicalNumber(value);
  if (Array.isArray(value)) {
    if (!isDenseArray(value)) throw invalidJsonValue("canonical JSON arrays must be dense");
    enterContainer(value, ancestors);
    try {
      return `[${value.map((item) => encodeCanonicalJson(item, ancestors)).join(",")}]`;
    } finally {
      ancestors.delete(value);
    }
  }
  if (isPlainRecord(value)) {
    enterContainer(value, ancestors);
    try {
      const entries = Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${encodeCanonicalJson(value[key], ancestors)}`);
      return `{${entries.join(",")}}`;
    } finally {
      ancestors.delete(value);
    }
  }
  throw invalidJsonValue("canonical JSON value is not supported");
}

function canonicalNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new CanonicalCodecError(
      CANONICAL_CODEC_ERROR_CODES.NON_FINITE_NUMBER,
      "canonical JSON numbers must be finite",
    );
  }
  return (value === 0 ? "0" : value.toString())
    .replace(/e\+/, "e")
    .replace(/e(-?)0+(\d+)/, "e$1$2");
}

function isDenseArray(value: readonly unknown[]): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) return false;
  }
  return true;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function enterContainer(value: object, ancestors: Set<object>): void {
  if (ancestors.has(value)) {
    throw new CanonicalCodecError(
      CANONICAL_CODEC_ERROR_CODES.CYCLIC_VALUE,
      "canonical JSON value cannot contain cycles",
    );
  }
  ancestors.add(value);
}

function invalidJsonValue(message: string): CanonicalCodecError {
  return new CanonicalCodecError(CANONICAL_CODEC_ERROR_CODES.INVALID_JSON_VALUE, message);
}
