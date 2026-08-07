/**
 * Generic worker contracts: the claimed-effect item carried through one pass.
 *
 * The dispatcher, result, timing, report, options, and storage contracts live
 * in their role modules (`dispatcher.ts`, `timing.ts`, `report.ts`,
 * `options.ts`, `storage.ts`). The worker reasons only about kernel rows and
 * these contracts; it never interprets effect payloads.
 */

import type { PendingEffect } from "../contracts.js";
import type { Presence } from "../state.js";

/** One claimed effect held by a worker pass. */
export interface ClaimedEffect {
  readonly pending: PendingEffect;
  readonly claimToken: string;
  /**
   * Present with the dispatcher's validation message when the opaque payload
   * cannot be parsed; such effects are failed before dispatch.
   */
  readonly invalidPayloadError: Presence<string>;
}
