/**
 * Public entrypoint for the `@hikoutei/canonical-codec` package.
 *
 * Exposes only the runtime-neutral canonical codec contract: the
 * stable-encoding and canonical-JSON grammars, their value types, and the
 * structured error vocabulary.
 *
 * Stage 1 scaffold (0.1.0): types, error classes, and error-code constants are
 * in place, but the encoder implementations are stubs that will be migrated
 * from the in-repo codec during Stage 2.
 */

export { canonicalJson, isCanonicalJsonValue } from "./canonicalJson.js";
export {
  CANONICAL_CODEC_ERROR_CODES,
  CanonicalCodecError,
  type CanonicalCodecErrorCode,
  StableCodecError,
  STABLE_ENCODING_ERROR_CODES,
  type StableEncodingErrorCode,
} from "./errors.js";
export { stableEncode } from "./stableEncode.js";
export type {
  CanonicalJsonValue,
  StableCodecDateValue,
  StableCodecValue,
} from "./types.js";
