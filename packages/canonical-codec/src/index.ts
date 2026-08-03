/**
 * Public entrypoint for the `@hikoutei/canonical-codec` package.
 *
 * Exposes only the runtime-neutral canonical codec contract: the
 * stable-encoding and canonical-JSON grammars, their value types, and the
 * structured error vocabulary. The encoders are runtime-neutral and share no
 * types with any host repository.
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
