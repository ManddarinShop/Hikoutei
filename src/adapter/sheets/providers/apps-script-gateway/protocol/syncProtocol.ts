/** Canonical JSON and hashing helpers shared by the thin operation protocol. */

import { createHash } from "node:crypto";
import { JAVASCRIPT_TYPE_NAMES } from "../../../../../shared/encoding/constants.js";
import { isJavaScriptType, isRecord } from "../../../../../shared/encoding/typeGuards.js";
import {
  SYNC_GATEWAY_ENCODINGS,
  SYNC_GATEWAY_HASH_ALGORITHMS,
  SYNC_JSON_LITERAL_TOKENS,
} from "./constants.js";
import {
  SYNC_GATEWAY_PROTOCOL_ERROR_CODES,
  SyncGatewayProtocolError,
} from "../errors.js";
import type { SyncJsonValue } from "./types.js";
export type { SyncJsonValue } from "./types.js";

/** Checks whether an unknown value is safe to send through the signed JSON boundary. */
export function isSyncJsonValue(value: unknown): value is SyncJsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isSyncJsonValue);
  return isRecord(value) && isPlainObject(value) && Object.values(value).every(isSyncJsonValue);
}

/** Promotes a JSON-compatible value or throws the protocol error used by signing. */
export function requireSyncJsonValue(value: unknown): SyncJsonValue {
  if (!isSyncJsonValue(value)) {
    throw new SyncGatewayProtocolError(
      SYNC_GATEWAY_PROTOCOL_ERROR_CODES.INVALID_JSON_VALUE,
      "sync gateway payload must contain JSON values only",
    );
  }
  return value;
}

/** Canonical JSON used for payload hashes and cross-runtime HMAC inputs. */
export function canonicalSyncJson(value: unknown): string {
  if (value === null) return SYNC_JSON_LITERAL_TOKENS.NULL;
  if (value === true) return SYNC_JSON_LITERAL_TOKENS.TRUE;
  if (value === false) return SYNC_JSON_LITERAL_TOKENS.FALSE;
  if (isJavaScriptType(value, JAVASCRIPT_TYPE_NAMES.STRING)) return JSON.stringify(value);
  if (isJavaScriptType(value, JAVASCRIPT_TYPE_NAMES.NUMBER)) return canonicalNumber(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalSyncJson(item)).join(",")}]`;
  if (isRecord(value) && isPlainObject(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalSyncJson(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  throw new SyncGatewayProtocolError(
    SYNC_GATEWAY_PROTOCOL_ERROR_CODES.INVALID_JSON_VALUE,
    "sync gateway payload must contain JSON values only",
  );
}

/** SHA-256 helper shared by envelope and effect payload verification. */
export function syncSha256Hex(value: string): string {
  return createHash(SYNC_GATEWAY_HASH_ALGORITHMS.SHA256)
    .update(value, SYNC_GATEWAY_ENCODINGS.UTF8)
    .digest("hex");
}


function canonicalNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new SyncGatewayProtocolError(
      SYNC_GATEWAY_PROTOCOL_ERROR_CODES.NON_FINITE_NUMBER,
      "sync gateway payload numbers must be finite",
    );
  }
  return (value === 0 ? "0" : value.toString()).replace(/e\+/, "e").replace(/e(-?)0+(\d+)/, "e$1$2");
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
