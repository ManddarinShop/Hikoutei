/**
 * Canonical JSON encoder for signed payloads.
 *
 * Mirrors the generic canonical-JSON contract the Hikoutei repository previously
 * kept in `src/shared/encoding/codec/canonicalJson.ts`. Canonical JSON sorts
 * object keys, rejects sparse arrays, rejects non-finite numbers, and produces
 * byte-stable text suitable for signing.
 *
 * NOTE: Stage 1 scaffold. The function bodies are intentional stubs and will be
 * filled in during Stage 2 of the package-extraction plan.
 */

import type { CanonicalJsonValue } from "./types.js";

const NOT_IMPLEMENTED =
  "@hikoutei/canonical-codec: Stage 1 scaffold (0.1.0); implementation lands in Stage 2.";

/**
 * Checks whether a value belongs to the canonical JSON input grammar.
 *
 * Stage 1 stub: throws until the implementation is migrated in Stage 2.
 */
export function isCanonicalJsonValue(value: unknown): value is CanonicalJsonValue {
  throw new Error(`isCanonicalJsonValue is not implemented. ${NOT_IMPLEMENTED}`);
}

/**
 * Encodes a JSON-compatible value with the versioned signed-payload rules.
 *
 * Stage 1 stub: throws until the implementation is migrated in Stage 2.
 */
export function canonicalJson(value: unknown): string {
  void value;
  throw new Error(`canonicalJson is not implemented. ${NOT_IMPLEMENTED}`);
}
