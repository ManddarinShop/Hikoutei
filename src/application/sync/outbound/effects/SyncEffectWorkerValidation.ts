/** Validates construction options before an effect-worker pass starts. */

import {
  EMPTY_STRING_LENGTH_ZERO,
  NON_NEGATIVE_SAFE_INTEGER_MINIMUM,
  POSITIVE_SAFE_INTEGER_MINIMUM,
} from "../../../../domain/index.js";
import { throwWorkerError } from "./SyncEffectWorkerHelpers.js";
import type { SyncEffectWorkerBaseOptions } from "./SyncEffectWorkerContracts.js";

/** Rejects invalid worker identity, clock, batch, and lease options. */
export function validateSyncEffectWorkerOptions(
  options: SyncEffectWorkerBaseOptions,
): void {
  if (options.workerId.length === EMPTY_STRING_LENGTH_ZERO) {
    throwWorkerError("effect worker ID is required");
  }
  if (
    !Number.isSafeInteger(options.now) ||
    options.now < NON_NEGATIVE_SAFE_INTEGER_MINIMUM
  ) {
    throwWorkerError("effect worker time must be a non-negative safe integer");
  }
  if (
    !Number.isSafeInteger(options.maxEffects) ||
    options.maxEffects < POSITIVE_SAFE_INTEGER_MINIMUM
  ) {
    throwWorkerError("effect worker maxEffects must be a positive safe integer");
  }
  for (const [name, value] of [
    ["writerLeaseDurationMs", options.writerLeaseDurationMs],
    ["effectLeaseDurationMs", options.effectLeaseDurationMs],
  ] as const) {
    if (
      value !== undefined &&
      (!Number.isSafeInteger(value) || value < POSITIVE_SAFE_INTEGER_MINIMUM)
    ) {
      throwWorkerError(name + " must be a positive safe integer");
    }
  }
}
