/** Public contracts for durable effect outbox rows and transitions. */

import type {
  Applicability,
  EffectKind,
  EffectTargetKind,
  Presence,
} from "../../../../domain/index.js";
import type { FencingContext } from "../shared/writerLease.js";

export const SYNC_EFFECT_RECOVERY_ERROR_CODES = {
  LEASE_EXPIRED_REQUIRES_POSTCONDITION: "lease_expired_requires_postcondition",
  GATEWAY_RETRYABLE_ERROR: "gateway_retryable_error",
  POSTCONDITION_READ_FAILED: "postcondition_read_failed",
  POSTCONDITION_UNAVAILABLE: "postcondition_unavailable",
  POSTCONDITION_UNAPPLIED_REQUIRES_REDRIVE: "postcondition_unapplied_requires_redrive",
} as const;

export interface ClaimResult {
  readonly effectId: string;
  readonly claimToken: string;
  readonly success: boolean;
  readonly reason: "claimed" | "stale_fencing" | "not_claimable";
}

/** Input required to claim an effect with the current worker fence. */
export interface ClaimEffectOptions extends FencingContext {
  readonly effectId: string;
  readonly claimToken: string;
  readonly leaseDurationMs: number;
}

export interface ApplyResultOptions extends FencingContext {
  readonly effectId: string;
  readonly claimToken: string;
  readonly status: "applied" | "blocked_candidate" | "superseded" | "conflict" | "failed";
  readonly lastErrorCode: Presence<string>;
  readonly lastErrorMessage: Presence<string>;
  /** Gateway read-back evidence that advances confirmed projection state in the
   * same savepoint as an applied outbox result. */
  readonly projectionConfirmation?: EffectProjectionConfirmation;
}

/** Confirmed projection state returned only after a gateway postcondition read. */
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
}

export interface PendingEffect {
  readonly effect_id: string;
  readonly effect_kind: string;
  readonly commit_id: string;
  readonly logical_sheet_id: string;
  readonly physical_sheet_id: string;
  readonly projection: string;
  readonly row_binding_id: string | null;
  readonly conflict_id: string | null;
  readonly target_kind: string;
  readonly target_id: string;
  readonly target_entity_revision: number | null;
  readonly target_field_revision_hash: string | null;
  readonly target_canonical_commit_id: string | null;
  readonly expected_visible_revision: number;
  readonly expected_visible_hash: string;
  readonly repair_guard_hash: string | null;
  readonly source_quarantine_id: string | null;
  readonly payload_json: string;
  readonly payload_hash: string;
  readonly effect_dedupe_key: string;
  readonly stream_sequence: number;
  readonly created_at: number;
  readonly status: string;
}
