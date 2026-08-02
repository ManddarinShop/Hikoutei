/**
 * `stable_encode_v1` — deterministic cross-runtime byte encoding.
 *
 * Grammar (no whitespace between tokens):
 *
 * ```
 * null      := "n"
 * boolean   := "b0" | "b1"
 * string    := "s" <utf8ByteLength> ":" <NFC UTF-8 bytes>
 * number    := "f" <asciiByteLength> ":" <canonical finite decimal>
 * date      := "d" "24" ":" <UTC YYYY-MM-DDTHH:mm:ss.SSSZ>
 * array     := "a" <count> "[" <value>* "]"
 * object    := "o" <count> "{" (<encoded string key> <value>)* "}"
 * ```
 *
 * Rules:
 * - string and object key bytes are NFC-normalized then UTF-8 byte-length prefixed
 * - object keys are sorted by UTF-8 byte lexicographic order
 * - array order is preserved
 * - number is the shortest round-trip decimal of its IEEE-754 binary64 value
 * - -0 is unified to 0; NaN/Infinity are rejected
 * - date payload is always 24 bytes: YYYY-MM-DDTHH:mm:ss.SSSZ
 *
 * The SHA-256 hex of the encoded bytes is the canonical fingerprint.
 */

import { createHash } from "node:crypto";
import {
  JAVASCRIPT_TYPE_NAMES,
  NORMALIZED_CELL_KINDS,
  STABLE_ENCODING_ERROR_CODES,
} from "./constants.js";
import { isJavaScriptType } from "./typeGuards.js";
import type { HikouteiStableHash } from "../identity/types.js";
import { isCanonicalUtcIsoDate } from "../validation.js";
import type { DateValue, StableValue } from "./types.js";
import { StableEncodingError } from "../../domain/errors/stableEncoding.js";

/**
 * Encodes a stable value to its canonical byte sequence.
 * Throws on unsupported values (NaN, Infinity, non-finite numbers).
 */
export function stableEncode(value: StableValue): Uint8Array {
  const chunks: Uint8Array[] = [];
  encodeValue(value, chunks);
  return concat(chunks);
}

/** SHA-256 hex of the stable encoding. This is the canonical fingerprint. */
export function stableHash(value: StableValue): HikouteiStableHash {
  return createHash("sha256").update(stableEncode(value)).digest("hex") as HikouteiStableHash;
}

function encodeValue(value: StableValue, chunks: Uint8Array[]): void {
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
  if (isJavaScriptType(value, JAVASCRIPT_TYPE_NAMES.NUMBER)) {
    encodeNumber(value, chunks);
    return;
  }
  if (isJavaScriptType(value, JAVASCRIPT_TYPE_NAMES.STRING)) {
    encodeString(value, chunks);
    return;
  }
  if (isDateValue(value)) {
    encodeDate(value.value, chunks);
    return;
  }
  if (Array.isArray(value)) {
    encodeArray(value, chunks);
    return;
  }
  if (isJavaScriptType(value, JAVASCRIPT_TYPE_NAMES.OBJECT)) {
    encodeObject(value as Record<string, StableValue>, chunks);
    return;
  }
  throw new StableEncodingError(
    STABLE_ENCODING_ERROR_CODES.UNSUPPORTED_VALUE_TYPE,
    `stable_encode: unsupported value type: ${typeof value}`,
  );
}

function encodeNumber(value: number, chunks: Uint8Array[]): void {
  if (!Number.isFinite(value)) {
    throw new StableEncodingError(
      STABLE_ENCODING_ERROR_CODES.NON_FINITE_NUMBER,
      `stable_encode: non-finite number: ${value}`,
    );
  }
  const unified = value === 0 ? 0 : value; // unify -0 to 0
  const decimal = shortestRoundTripDecimal(unified);
  const encoded = ascii(decimal);
  const lengthPrefix = ascii(`f${encoded.length}:`);
  chunks.push(lengthPrefix, encoded);
}

function encodeString(value: string, chunks: Uint8Array[]): void {
  const nfc = normalizeScalarString(value);
  const bytes = textEncode(nfc);
  const lengthPrefix = ascii(`s${bytes.length}:`);
  chunks.push(lengthPrefix, bytes);
}

function encodeDate(iso: string, chunks: Uint8Array[]): void {
  if (!isCanonicalUtcIsoDate(iso)) {
    throw new StableEncodingError(
      STABLE_ENCODING_ERROR_CODES.INVALID_DATE_FORMAT,
      `stable_encode: invalid date format: ${iso}`,
    );
  }
  const bytes = textEncode(iso);
  if (bytes.length !== 24) {
    throw new StableEncodingError(
      STABLE_ENCODING_ERROR_CODES.INVALID_DATE_BYTE_LENGTH,
      `stable_encode: date must be exactly 24 bytes, got ${bytes.length}`,
    );
  }
  chunks.push(ascii("d24:"), bytes);
}

function encodeArray(values: readonly StableValue[], chunks: Uint8Array[]): void {
  chunks.push(ascii(`a${values.length}[`));
  for (const v of values) {
    encodeValue(v, chunks);
  }
  chunks.push(ascii("]"));
}

function encodeObject(obj: Record<string, StableValue>, chunks: Uint8Array[]): void {
  const keys = Object.keys(obj);
  const entries: Array<[Uint8Array, string, StableValue]> = [];
  const normalizedKeys = new Set<string>();
  for (const key of keys) {
    const nfcKey = normalizeScalarString(key);
    if (normalizedKeys.has(nfcKey)) {
      throw new StableEncodingError(
        STABLE_ENCODING_ERROR_CODES.DUPLICATE_OBJECT_KEY,
        `stable_encode: duplicate object key after NFC normalization: ${nfcKey}`,
      );
    }
    normalizedKeys.add(nfcKey);
    const encodedKey = textEncode(nfcKey);
    entries.push([encodedKey, nfcKey, obj[key]!]);
  }
  entries.sort((a, b) => compareBytes(a[0], b[0]));
  chunks.push(ascii(`o${entries.length}{`));
  for (const [encodedKey, , val] of entries) {
    const lengthPrefix = ascii(`s${encodedKey.length}:`);
    chunks.push(lengthPrefix, encodedKey);
    encodeValue(val, chunks);
  }
  chunks.push(ascii("}"));
}

/**
 * Produces the shortest decimal representation that round-trips to the same
 * IEEE-754 binary64 value.
 *
 * - Uses the V8 `toString` which already gives shortest round-trip for most
 *   numbers. We normalize exponent format to use lowercase `e` with no leading
 *   zero in the exponent.
 * - Integers are emitted without a decimal point.
 */
function shortestRoundTripDecimal(value: number): string {
  const str = value.toString();
  // Normalize exponent: V8 uses "e+21" or "e-7", we want "e21" and "e-7"
  return str.replace(/e([+-])0*(\d)/, (_, sign, digit) => {
    const expSign = sign === "-" ? "-" : "";
    return `e${expSign}${digit}`;
  }).replace(/e\+/, "e");
}

function isDateValue(value: unknown): value is DateValue {
  return (
    isJavaScriptType(value, JAVASCRIPT_TYPE_NAMES.OBJECT) &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 2 &&
    (value as Record<string, unknown>).kind === NORMALIZED_CELL_KINDS.DATE &&
    isJavaScriptType(
      (value as Record<string, unknown>).value,
      JAVASCRIPT_TYPE_NAMES.STRING,
    )
  );
}

/** Rejects unpaired UTF-16 surrogates instead of letting TextEncoder replace them. */
function normalizeScalarString(value: string): string {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        throw new StableEncodingError(
          STABLE_ENCODING_ERROR_CODES.UNPAIRED_HIGH_SURROGATE,
          "stable_encode: string contains an unpaired high surrogate",
        );
      }
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new StableEncodingError(
        STABLE_ENCODING_ERROR_CODES.UNPAIRED_LOW_SURROGATE,
        "stable_encode: string contains an unpaired low surrogate",
      );
    }
  }
  return value.normalize("NFC");
}

function ascii(s: string): Uint8Array {
  return textEncode(s);
}

function textEncode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) {
    total += c.length;
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    result.set(c, offset);
    offset += c.length;
  }
  return result;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const min = Math.min(a.length, b.length);
  for (let i = 0; i < min; i++) {
    if (a[i]! < b[i]!) return -1;
    if (a[i]! > b[i]!) return 1;
  }
  return a.length - b.length;
}
