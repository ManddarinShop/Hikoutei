/**
 * Worker options validation extracted from the pipeline module.
 *
 * The bound constants and the `validateOptions` function enforce the same
 * constraints as the original typed-worker validation; no logic is changed.
 */

import type { EffectWorkerBaseOptions } from "./options.js";
import {
  DEFAULT_EFFECT_LEASE_DURATION_MS,
  DEFAULT_WRITER_LEASE_DURATION_MS,
  EFFECT_LEASE_PROVIDER_HEADROOM_MS,
} from "./constants.js";
import {
  WORKER_OPTIONS_ERROR_CODES,
  WorkerOptionsError,
} from "./optionContracts.js";

const EMPTY_STRING_LENGTH_ZERO = 0;
const NON_NEGATIVE_SAFE_INTEGER_MINIMUM = 0;
const POSITIVE_SAFE_INTEGER_MINIMUM = 1;

export function validateOptions(options: EffectWorkerBaseOptions): void {
  if (options.workerId.length === EMPTY_STRING_LENGTH_ZERO) {
    throw new WorkerOptionsError(WORKER_OPTIONS_ERROR_CODES.WORKER_ID_REQUIRED);
  }
  if (
    !Number.isSafeInteger(options.now) ||
    options.now < NON_NEGATIVE_SAFE_INTEGER_MINIMUM
  ) {
    throw new WorkerOptionsError(WORKER_OPTIONS_ERROR_CODES.TIME_INVALID);
  }
  if (
    !Number.isSafeInteger(options.maxEffects) ||
    options.maxEffects < POSITIVE_SAFE_INTEGER_MINIMUM
  ) {
    throw new WorkerOptionsError(WORKER_OPTIONS_ERROR_CODES.MAX_EFFECTS_POSITIVE_REQUIRED);
  }
  if (
    options.maxFastAppendCandidates !== undefined &&
    (!Number.isSafeInteger(options.maxFastAppendCandidates) ||
      options.maxFastAppendCandidates < POSITIVE_SAFE_INTEGER_MINIMUM)
  ) {
    throw new WorkerOptionsError(WORKER_OPTIONS_ERROR_CODES.MAX_FAST_APPEND_POSITIVE_REQUIRED);
  }
  if (
    options.appendDispatchIntervalMs !== undefined &&
    (!Number.isSafeInteger(options.appendDispatchIntervalMs) ||
      options.appendDispatchIntervalMs < NON_NEGATIVE_SAFE_INTEGER_MINIMUM)
  ) {
    throw new WorkerOptionsError(WORKER_OPTIONS_ERROR_CODES.APPEND_INTERVAL_NON_NEGATIVE_REQUIRED);
  }
  for (const [name, value] of [
    ["writerLeaseDurationMs", options.writerLeaseDurationMs],
    ["effectLeaseDurationMs", options.effectLeaseDurationMs],
    ["requestTimeoutMs", options.requestTimeoutMs],
    ["writerLeaseHeartbeatStaleMs", options.writerLeaseHeartbeatStaleMs],
  ] as const) {
    if (
      value !== undefined &&
      (!Number.isSafeInteger(value) || value < POSITIVE_SAFE_INTEGER_MINIMUM)
    ) {
      throw new WorkerOptionsError(WORKER_OPTIONS_ERROR_CODES.LEASE_DURATION_POSITIVE_REQUIRED, name);
    }
  }
  const writerLeaseDuration = options.writerLeaseDurationMs ?? DEFAULT_WRITER_LEASE_DURATION_MS;
  const effectLeaseDuration = options.effectLeaseDurationMs ?? DEFAULT_EFFECT_LEASE_DURATION_MS;
  if (writerLeaseDuration <= effectLeaseDuration) {
    throw new WorkerOptionsError(WORKER_OPTIONS_ERROR_CODES.WRITER_LEASE_HEADROOM_INVALID);
  }
  if (
    options.requestTimeoutMs !== undefined &&
    effectLeaseDuration <= options.requestTimeoutMs + EFFECT_LEASE_PROVIDER_HEADROOM_MS
  ) {
    throw new WorkerOptionsError(WORKER_OPTIONS_ERROR_CODES.EFFECT_LEASE_HEADROOM_INVALID);
  }
}
