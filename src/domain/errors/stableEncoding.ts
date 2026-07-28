import type { StableEncodingErrorCode } from "../../shared/encoding/constants.js";
import { CoreErrorException } from "./types.js";

/** A structured failure raised when stable encoding cannot produce bytes. */
export class StableEncodingError extends CoreErrorException<
  "stable_encode",
  StableEncodingErrorCode
> {
  constructor(code: StableEncodingErrorCode, message: string) {
    super("stable_encode", code, message);
  }
}
