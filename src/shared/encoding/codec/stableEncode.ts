/** Generic `stable_encode_v1` implementation without hashing or Hikoutei types. */

import { isCanonicalUtcIsoDate } from "../../validation.js";
import { isRecord } from "../typeGuards.js";
import {
  CANONICAL_CODEC_ERROR_CODES,
  CanonicalCodecError,
} from "./errors.js";
import type { StableCodecDateValue } from "./types.js";

/** Encodes a value into the versioned stable byte grammar. */
export function stableEncode(value: unknown): Uint8Array {
  const chunks: Uint8Array[] = [];
  encodeValue(value, chunks, new Set<object>());
  return concat(chunks);
}

function encodeValue(
  value: unknown,
  chunks: Uint8Array[],
  ancestors: Set<object>,
): void {
  if (value === null) {
    chunks.push(ascii("n"));
    return;
  }
  if (value === true) {
    chunks.push(ascii("b1"));
    return;
  }
  if (value === false) {
    chunks.push(ascii("b0"));
    return;
  }
  if (typeof value === "number") {
    encodeNumber(value, chunks);
    return;
  }
  if (typeof value === "string") {
    encodeString(value, chunks);
    return;
  }
  if (isDateValue(value)) {
    encodeDate(value.value, chunks);
    return;
  }
  if (Array.isArray(value)) {
    encodeArray(value, chunks, ancestors);
    return;
  }
  if (isPlainRecord(value)) {
    encodeObject(value, chunks, ancestors);
    return;
  }
  throw new CanonicalCodecError(
    CANONICAL_CODEC_ERROR_CODES.UNSUPPORTED_VALUE_TYPE,
    `stable_encode: unsupported value type: ${typeof value}`,
  );
}

function encodeNumber(value: number, chunks: Uint8Array[]): void {
  if (!Number.isFinite(value)) {
    throw new CanonicalCodecError(
      CANONICAL_CODEC_ERROR_CODES.NON_FINITE_NUMBER,
      `stable_encode: non-finite number: ${value}`,
    );
  }
  const unified = value === 0 ? 0 : value;
  const decimal = shortestRoundTripDecimal(unified);
  const encoded = ascii(decimal);
  chunks.push(ascii(`f${encoded.length}:`), encoded);
}

function encodeString(value: string, chunks: Uint8Array[]): void {
  const nfc = normalizeScalarString(value);
  const bytes = textEncode(nfc);
  chunks.push(ascii(`s${bytes.length}:`), bytes);
}

function encodeDate(iso: string, chunks: Uint8Array[]): void {
  if (!isCanonicalUtcIsoDate(iso)) {
    throw new CanonicalCodecError(
      CANONICAL_CODEC_ERROR_CODES.INVALID_DATE_FORMAT,
      `stable_encode: invalid date format: ${iso}`,
    );
  }
  const bytes = textEncode(iso);
  if (bytes.length !== 24) {
    throw new CanonicalCodecError(
      CANONICAL_CODEC_ERROR_CODES.INVALID_DATE_BYTE_LENGTH,
      `stable_encode: date must be exactly 24 bytes, got ${bytes.length}`,
    );
  }
  chunks.push(ascii("d24:"), bytes);
}

function encodeArray(
  values: readonly unknown[],
  chunks: Uint8Array[],
  ancestors: Set<object>,
): void {
  enterContainer(values, ancestors);
  try {
    chunks.push(ascii(`a${values.length}[`));
    for (const value of values) encodeValue(value, chunks, ancestors);
    chunks.push(ascii("]"));
  } finally {
    ancestors.delete(values);
  }
}

function encodeObject(
  obj: Record<string, unknown>,
  chunks: Uint8Array[],
  ancestors: Set<object>,
): void {
  enterContainer(obj, ancestors);
  try {
    const entries: Array<[Uint8Array, unknown]> = [];
    const normalizedKeys = new Set<string>();
    for (const key of Object.keys(obj)) {
      const nfcKey = normalizeScalarString(key);
      if (normalizedKeys.has(nfcKey)) {
        throw new CanonicalCodecError(
          CANONICAL_CODEC_ERROR_CODES.DUPLICATE_OBJECT_KEY,
          `stable_encode: duplicate object key after NFC normalization: ${nfcKey}`,
        );
      }
      normalizedKeys.add(nfcKey);
      entries.push([textEncode(nfcKey), obj[key]]);
    }
    entries.sort((a, b) => compareBytes(a[0], b[0]));
    chunks.push(ascii(`o${entries.length}{`));
    for (const [encodedKey, value] of entries) {
      chunks.push(ascii(`s${encodedKey.length}:`), encodedKey);
      encodeValue(value, chunks, ancestors);
    }
    chunks.push(ascii("}"));
  } finally {
    ancestors.delete(obj);
  }
}

function shortestRoundTripDecimal(value: number): string {
  const str = value.toString();
  return str
    .replace(/e([+-])0*(\d)/, (_, sign: string, digit: string) => {
      const exponentSign = sign === "-" ? "-" : "";
      return `e${exponentSign}${digit}`;
    })
    .replace(/e\+/, "e");
}

function isDateValue(value: unknown): value is StableCodecDateValue {
  return (
    isPlainRecord(value) &&
    Object.keys(value).length === 2 &&
    Object.prototype.hasOwnProperty.call(value, "kind") &&
    Object.prototype.hasOwnProperty.call(value, "value") &&
    value.kind === "date" &&
    typeof value.value === "string"
  );
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
      "stable_encode: cyclic value is not supported",
    );
  }
  ancestors.add(value);
}

function normalizeScalarString(value: string): string {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        throw new CanonicalCodecError(
          CANONICAL_CODEC_ERROR_CODES.UNPAIRED_HIGH_SURROGATE,
          "stable_encode: string contains an unpaired high surrogate",
        );
      }
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new CanonicalCodecError(
        CANONICAL_CODEC_ERROR_CODES.UNPAIRED_LOW_SURROGATE,
        "stable_encode: string contains an unpaired low surrogate",
      );
    }
  }
  return value.normalize("NFC");
}

function ascii(value: string): Uint8Array {
  return textEncode(value);
}

function textEncode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const min = Math.min(a.length, b.length);
  for (let index = 0; index < min; index += 1) {
    if (a[index]! < b[index]!) return -1;
    if (a[index]! > b[index]!) return 1;
  }
  return a.length - b.length;
}
