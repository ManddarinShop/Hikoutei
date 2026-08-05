/** Constants and durable status contracts shared by the effect worker modules. */

import type { EffectKind, EffectStatus, EffectTargetKind } from "../../../../domain/index.js";
import {
  EFFECT_KINDS as CANONICAL_EFFECT_KINDS,
  EFFECT_STATUSES as CANONICAL_EFFECT_STATUSES,
  EFFECT_TARGET_KINDS as CANONICAL_EFFECT_TARGET_KINDS,
} from "../../../../domain/model/constants.js";
import { SYNC_EFFECT_RECOVERY_ERROR_CODES } from "../../../../infrastructure/storage/sync/outbound/effectOutbox.js";

export const DEFAULT_WORKER_ROLE = "sync-effect-worker";
/** Outbound writer lease must outlive the longest remote effect request. */
export const DEFAULT_WRITER_LEASE_DURATION_MS = 180_000;
/** Minimum headroom between the remote timeout and the effect lease. */
export const EFFECT_LEASE_PROVIDER_HEADROOM_MS = 30_000;
/** Must exceed the 60-second provider transport timeout plus recovery margin. */
export const DEFAULT_EFFECT_LEASE_DURATION_MS = 120_000;

/**
 * Maximum effects one provider `applyEffects` call will acknowledge.
 *
 * The remote provider caps a single bounded effect batch (see
 * `MAX_EFFECTS_PER_REQUEST` in the Google Sheets API provider defaults).
 * Chunking each physical route's dispatch to this limit keeps every request
 * inside that batch, so an oversized configured worker limit (`maxEffects`)
 * does not turn one route into repeated partial (`hasMore`) responses and the
 * deferred/requeue churn they cause.
 */
export const EFFECT_BATCH_LIMIT = 20;
/**
 * Maximum number of effects leased before dispatch starts. Selection may use a
 * larger SQLite upper bound, but a worker pass must not lease an unbounded
 * backlog while a remote batch is in flight.
 */
export const MAX_IN_FLIGHT_EFFECTS = EFFECT_BATCH_LIMIT;
/**
 * Maximum eligible fast-append rows one worker pass may select/claim in the
 * real provider runtime. The bulk append operation writes the whole reserved
 * target range in one `spreadsheets.batchUpdate` request (an atomic
 * target-plus-receipt batch), so a bulk pass can claim this many append
 * candidates while regular and recovery effects keep the bounded 20-effect
 * window below.
 */
export const FAST_APPEND_BATCH_CANDIDATE_LIMIT = 1_000;
/**
 * Minimum interval between fast-append request starts in the real provider
 * runtime. The adaptive batch controller remembers the last append request
 * start across supervisor passes and waits only the remaining time before the
 * next append request; regular applyEffects calls never wait on this throttle.
 */
export const APPEND_DISPATCH_THROTTLE_INTERVAL_MS = 1_100;

export const SYNC_EFFECT_KINDS = CANONICAL_EFFECT_KINDS satisfies Record<string, EffectKind>;

export const EFFECT_TARGET_KINDS = CANONICAL_EFFECT_TARGET_KINDS satisfies Record<string, EffectTargetKind>;

export const OUTBOX_EFFECT_STATUSES = {
  DELIVERY_UNCERTAIN: CANONICAL_EFFECT_STATUSES.DELIVERY_UNCERTAIN,
  FAILED: CANONICAL_EFFECT_STATUSES.FAILED,
  APPLIED: CANONICAL_EFFECT_STATUSES.APPLIED,
  BLOCKED_CANDIDATE: CANONICAL_EFFECT_STATUSES.BLOCKED_CANDIDATE,
  SUPERSEDED: CANONICAL_EFFECT_STATUSES.SUPERSEDED,
  CONFLICT: CANONICAL_EFFECT_STATUSES.CONFLICT,
} as const satisfies Record<string, EffectStatus>;

export const WORKER_ERROR_CODES = {
  INVALID_EFFECT_PAYLOAD: "invalid_effect_payload",
  ACTIVE_CANDIDATE_PRESERVED: "active_candidate_preserved",
  PROVIDER_SUPERSEDED: "provider_superseded",
  CANDIDATE_GUARD_MISMATCH: "candidate_guard_mismatch",
  VISIBLE_GUARD_MISMATCH: "visible_guard_mismatch",
  PROVIDER_SCHEMA_ERROR: "provider_schema_error",
  PROVIDER_REMOTE_ERROR: "provider_remote_error",
  PROVIDER_RETRYABLE_ERROR: SYNC_EFFECT_RECOVERY_ERROR_CODES.PROVIDER_RETRYABLE_ERROR,
  DELIVERY_UNCERTAIN_REQUIRES_PROBE:
    SYNC_EFFECT_RECOVERY_ERROR_CODES.DELIVERY_UNCERTAIN_REQUIRES_PROBE,
  POSTCONDITION_READ_FAILED: SYNC_EFFECT_RECOVERY_ERROR_CODES.POSTCONDITION_READ_FAILED,
  POSTCONDITION_APPLIED_WITHOUT_VISIBLE_STATE: "postcondition_applied_without_visible_state",
  POSTCONDITION_UNAVAILABLE: SYNC_EFFECT_RECOVERY_ERROR_CODES.POSTCONDITION_UNAVAILABLE,
  POSTCONDITION_CHANGED: "postcondition_changed",
  POSTCONDITION_UNAPPLIED_REQUIRES_REDRIVE:
    SYNC_EFFECT_RECOVERY_ERROR_CODES.POSTCONDITION_UNAPPLIED_REQUIRES_REDRIVE,
  REPAIR_REOBSERVE_REQUIRES_WRITER_REPLAN: "repair_reobserve_requires_writer_replan",
  REPAIR_REPLAN_FAILED: "repair_replan_failed",
  REPAIR_REPLAN_DEFERRED: "repair_replan_deferred",
  PROVIDER_CAPABILITY_MISSING: "provider_capability_missing",
} as const;

export type SyncEffectWorkerErrorCode =
  (typeof WORKER_ERROR_CODES)[keyof typeof WORKER_ERROR_CODES];
