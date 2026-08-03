/** Canonical JSON and hashing helpers shared by the thin operation protocol. */

import { createHash } from "node:crypto";
import {
  canonicalJson,
  isCanonicalJsonValue,
  CANONICAL_CODEC_ERROR_CODES,
  CanonicalCodecError,
} from "@hikoutei/kohkai";
import {
  SYNC_GATEWAY_ENCODINGS,
  SYNC_GATEWAY_HASH_ALGORITHMS,
} from "./constants.js";
import {
  SYNC_GATEWAY_PROTOCOL_ERROR_CODES,
  SyncGatewayProtocolError,
} from "../errors.js";
import type { SyncJsonValue } from "./types.js";
export type { SyncJsonValue } from "./types.js";

/** Checks whether an unknown value is safe to send through the signed JSON boundary. */
export function isSyncJsonValue(value: unknown): value is SyncJsonValue {
  return isCanonicalJsonValue(value);
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
  try {
    return canonicalJson(value);
  } catch (error: unknown) {
    throwProtocolCodecError(error);
  }
}

/** SHA-256 helper shared by envelope and effect payload verification. */
export function syncSha256Hex(value: string): string {
  return createHash(SYNC_GATEWAY_HASH_ALGORITHMS.SHA256)
    .update(value, SYNC_GATEWAY_ENCODINGS.UTF8)
    .digest("hex");
}

function throwProtocolCodecError(error: unknown): never {
  if (error instanceof CanonicalCodecError) {
    const code = error.code === CANONICAL_CODEC_ERROR_CODES.NON_FINITE_NUMBER
      ? SYNC_GATEWAY_PROTOCOL_ERROR_CODES.NON_FINITE_NUMBER
      : SYNC_GATEWAY_PROTOCOL_ERROR_CODES.INVALID_JSON_VALUE;
    throw new SyncGatewayProtocolError(code, error.message);
  }
  throw error;
}
