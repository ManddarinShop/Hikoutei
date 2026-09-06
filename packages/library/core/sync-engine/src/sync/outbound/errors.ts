import { CoreErrorException } from "@hikoutei/contracts/domain/errors/index.js";

// ---------------------------------------------------------------------------
// Persisted-value contract validation errors (dispatcherSupport)
// ---------------------------------------------------------------------------

/**
 * Stable error codes for persisted outbox value contract violations.
 *
 * Raised inside `toProviderEffect` when a persisted `effect_kind`,
 * `projection`, or `target_kind` does not match the closed union in
 * `@hikoutei/contracts`. The message carries the persisted value verbatim
 * for diagnostic traceability (it is never logged by the runtime).
 */
export const SYNC_EFFECT_CONTRACT_ERROR_CODES = {
  UNSUPPORTED_SYNC_EFFECT_KIND: "unsupported_sync_effect_kind",
  UNSUPPORTED_SYNC_PROJECTION: "unsupported_sync_projection",
  UNSUPPORTED_SYNC_EFFECT_TARGET_KIND: "unsupported_sync_effect_target_kind",
} as const;

export type SyncEffectContractErrorCode =
  (typeof SYNC_EFFECT_CONTRACT_ERROR_CODES)[keyof typeof SYNC_EFFECT_CONTRACT_ERROR_CODES];

const effectContractMessages: Record<SyncEffectContractErrorCode, (value: string) => string> = {
  [SYNC_EFFECT_CONTRACT_ERROR_CODES.UNSUPPORTED_SYNC_EFFECT_KIND]: (v) =>
    "unsupported sync effect kind: " + v,
  [SYNC_EFFECT_CONTRACT_ERROR_CODES.UNSUPPORTED_SYNC_PROJECTION]: (v) =>
    "unsupported sync projection: " + v,
  [SYNC_EFFECT_CONTRACT_ERROR_CODES.UNSUPPORTED_SYNC_EFFECT_TARGET_KIND]: (v) =>
    "unsupported sync effect target kind: " + v,
};

/**
 * Thrown when a persisted outbox value fails its contracts-level closed-union
 * check. Carries `domain` and `code` for structured observation while keeping
 * the message byte-identical to the original raw `Error`.
 */
export class SyncEffectContractError extends CoreErrorException<
  "sync.outbound",
  SyncEffectContractErrorCode
> {
  constructor(code: SyncEffectContractErrorCode, persistedValue: string) {
    super("sync.outbound", code, effectContractMessages[code](persistedValue));
  }
}
