/** Capability checks for the gateway supplied to the effect worker. */

import type {
  SyncEffectWorkerGateway,
  SyncEffectWorkerFullGateway,
} from "../../gateway/syncGateway.js";

/** Returns the full gateway only when every regular recovery capability exists. */
export function isFullEffectGateway(
  gateway: SyncEffectWorkerGateway,
): SyncEffectWorkerFullGateway | undefined {
  const candidate = gateway as Partial<SyncEffectWorkerFullGateway>;
  if (
    typeof candidate.applyEffects !== "function" ||
    typeof candidate.readEffectPostcondition !== "function" ||
    typeof candidate.readEffectPostconditions !== "function"
  ) {
    return undefined;
  }
  return gateway as SyncEffectWorkerFullGateway;
}
