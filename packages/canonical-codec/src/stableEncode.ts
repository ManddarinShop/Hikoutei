/**
 * Generic `stable_encode_v1` encoder without hashing or Hikoutei types.
 *
 * Mirrors the generic stable-encoding contract the Hikoutei repository previously
 * kept in `src/shared/encoding/codec/stableEncode.ts`. The encoder is
 * runtime-neutral (no Node, SQLite, or Google SDK types) and produces byte-stable
 * output suitable for cross-runtime fingerprinting.
 *
 * NOTE: Stage 1 scaffold. The function body is an intentional stub and will be
 * filled in during Stage 2 of the package-extraction plan.
 */

import type { StableCodecValue } from "./types.js";

const NOT_IMPLEMENTED =
  "@hikoutei/canonical-codec: Stage 1 scaffold (0.1.0); implementation lands in Stage 2.";

/**
 * Encodes a value into the versioned stable byte grammar.
 *
 * Stage 1 stub: throws until the implementation is migrated in Stage 2.
 */
export function stableEncode(value: StableCodecValue): Uint8Array {
  void value;
  throw new Error(`stableEncode is not implemented. ${NOT_IMPLEMENTED}`);
}
