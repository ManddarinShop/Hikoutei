/** Public contracts for durable effect outbox rows and transitions. */

import type {
  Applicability,
  EffectKind,
  EffectStatus,
  EffectTargetKind,
  Presence,
} from "../../../../domain/index.js";
import type { FencingContext } from "../shared/writerLease.js";
import type {
  HikouteiEffectDedupeKey,
  HikouteiEffectId,
  HikouteiPayloadHash,
  HikouteiPhysicalSheetId,
  HikouteiRowBindingId,
  HikouteiVisibleHash,
} from "../../../../shared/identity/types.js";

export const SYNC_EFFECT_RECOVERY_ERROR_CODES = {
  LEASE_EXPIRED_REQUIRES_POSTCONDITION: "lease_expired_requires_postcondition",
  DELIVERY_UNCERTAIN_REQUIRES_PROBE: "delivery_uncertain_requires_probe",
  PROVIDER_RETRYABLE_ERROR: "provider_retryable_error",
  POSTCONDITION_READ_FAILED: "postcondition_read_failed",
  POSTCONDITION_UNAVAILABLE: "postcondition_unavailable",
  POSTCONDITION_UNAPPLIED_REQUIRES_REDRIVE: "postcondition_unapplied_requires_redrive",
  /**
   * Code persisted by pre-rename workers as `gateway_retryable_error`.
   * Accepted alongside PROVIDER_RETRYABLE_ERROR so failed rows written before
   * the provider rename stay recoverable instead of stranding permanently.
   */
  LEGACY_GATEWAY_RETRYABLE_ERROR: "gateway_retryable_error",
} as const;

export type ClaimResult =
  | {
      readonly effectId: string;
      readonly claimToken: string;
      readonly status: "claimed";
    }
  | {
      readonly effectId: string;
      readonly claimToken: string;
      readonly status: "not_claimed";
      readonly reason: "stale_fencing" | "not_claimable";
    };

/** Input required to claim an effect with the current worker fence. */
export interface ClaimEffectOptions extends FencingContext {
  readonly effectId: string;
  readonly claimToken: string;
  /** Durable identity for the remote dispatch represented by this claim. */
  readonly dispatchId?: string;
  readonly leaseDurationMs: number;
}

/** Extends an in-flight effect lease without changing its claim token. */
export interface RenewEffectLeaseOptions extends FencingContext {
  readonly effectId: string;
  readonly claimToken: string;
  readonly leaseDurationMs: number;
}

interface ApplyResultOptionsBase extends FencingContext {
  readonly effectId: string;
  readonly claimToken: string;
  readonly lastErrorCode: Presence<string>;
  readonly lastErrorMessage: Presence<string>;
}

/** A result that may advance confirmed projection state. */
export interface AppliedEffectResultOptions extends ApplyResultOptionsBase {
  readonly status: "applied";
  /** Provider read-back evidence committed with the applied outbox result. */
  readonly projectionConfirmation?: EffectProjectionConfirmation;
}

/** A result that closes an effect without advancing confirmed projection state. */
export interface NonAppliedEffectResultOptions extends ApplyResultOptionsBase {
  readonly status: "blocked_candidate" | "superseded" | "conflict" | "failed";
  readonly projectionConfirmation?: never;
}

/** Operation-specific apply input with impossible confirmation/status pairs removed. */
export type ApplyResultOptions =
  | AppliedEffectResultOptions
  | NonAppliedEffectResultOptions;

/** Confirmed projection state returned only after a provider postcondition read. */
export interface EffectProjectionConfirmation {
  readonly physicalSheetId: string;
  readonly projection: string;
  readonly rowBindingId: string;
  readonly visibleRevision: number;
  readonly visibleHash: string;
  readonly entityRevision: Applicability<number>;
  readonly fieldHashes: Readonly<Record<string, string>>;
}

/** A pending outbox row prepared by the writer transaction. */
export interface NewEffect {
  readonly effectId: string;
  readonly effectKind: EffectKind;
  readonly commitId: string;
  readonly logicalSheetId: string;
  readonly physicalSheetId: string;
  readonly projection: string;
  readonly rowBindingId: Presence<string>;
  readonly conflictId: Presence<string>;
  readonly targetKind: EffectTargetKind;
  readonly targetId: string;
  readonly targetEntityRevision: Applicability<number>;
  readonly targetFieldRevisionHash: Applicability<string>;
  readonly targetCanonicalCommitId: Applicability<string>;
  readonly expectedVisibleRevision: number;
  readonly expectedVisibleHash: string;
  readonly repairGuardHash: Presence<string>;
  readonly sourceQuarantineId: Presence<string>;
  readonly payloadJson: string;
  readonly payloadHash: string;
  readonly effectDedupeKey: string;
  readonly streamSequence: number;
}

export interface RetryClaimedEffectOptions
  extends Pick<FencingContext, "role" | "writerEpoch" | "fencingToken" | "now"> {
  readonly effectId: string;
  readonly claimToken: string;
  readonly lastErrorCode: string;
  readonly lastErrorMessage: string;
  /** Durable retry time; defaults to a short bounded delay at the SQL boundary. */
  readonly nextAttemptAt?: number;
}

/** Moves a claimed effect into durable ambiguous-delivery recovery. */
export interface MarkDeliveryUncertainOptions
  extends Pick<FencingContext, "role" | "writerEpoch" | "fencingToken" | "now"> {
  readonly effectId: string;
  readonly claimToken: string;
  readonly uncertainSince: number;
  readonly nextProbeAt: number;
  readonly lastErrorCode: string;
  readonly lastErrorMessage: string;
}

export interface PendingEffect {
  readonly effect_id: HikouteiEffectId;
  readonly effect_kind: EffectKind;
  readonly commit_id: string;
  readonly logical_sheet_id: string;
  readonly physical_sheet_id: HikouteiPhysicalSheetId;
  readonly projection: string;
  readonly row_binding_id: HikouteiRowBindingId | null;
  readonly conflict_id: string | null;
  readonly target_kind: EffectTargetKind;
  readonly target_id: string;
  readonly target_entity_revision: number | null;
  readonly target_field_revision_hash: string | null;
  readonly target_canonical_commit_id: string | null;
  readonly expected_visible_revision: number;
  readonly expected_visible_hash: HikouteiVisibleHash | "";
  readonly repair_guard_hash: string | null;
  readonly source_quarantine_id: string | null;
  readonly payload_json: string;
  readonly payload_hash: HikouteiPayloadHash;
  readonly effect_dedupe_key: HikouteiEffectDedupeKey;
  readonly stream_sequence: number;
  readonly created_at: number;
  readonly next_attempt_at: number | null;
  readonly uncertain_since: number | null;
  readonly next_probe_at: number | null;
  readonly dispatch_id: string | null;
  readonly status: EffectStatus;
}
