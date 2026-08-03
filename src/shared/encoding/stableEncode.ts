/** Hikoutei compatibility facade for the generic stable_encode_v1 core. */

import { createHash } from "node:crypto";
import type { HikouteiStableHash } from "../identity/types.js";
import { StableEncodingError } from "../../domain/errors/stableEncoding.js";
import {
  StableCodecError,
  stableEncode as encodeStableValue,
} from "@hikoutei/canonical-codec";
import type { StableValue } from "./types.js";

/** Encodes a stable value while preserving Hikoutei's existing error contract. */
export function stableEncode(value: StableValue): Uint8Array {
  try {
    return encodeStableValue(value);
  } catch (error: unknown) {
    if (error instanceof StableCodecError) {
      throw new StableEncodingError(error.code, error.message);
    }
    throw error;
  }
}

/** Computes the SHA-256 fingerprint of Hikoutei's stable encoding. */
export function stableHash(value: StableValue): HikouteiStableHash {
  return createHash("sha256").update(stableEncode(value)).digest("hex") as HikouteiStableHash;
}
