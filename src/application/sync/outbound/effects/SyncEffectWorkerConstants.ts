/** Constants and durable status contracts shared by the effect worker modules. */

import type { EffectKind, EffectStatus, EffectTargetKind } from "../../../../domain/index.js";
import {
  EFFECT_KINDS as CANONICAL_EFFECT_KINDS,
  EFFECT_STATUSES as CANONICAL_EFFECT_STATUSES,
  EFFECT_TARGET_KINDS as CANONICAL_EFFECT_TARGET_KINDS,
} from "../../../../domain/model/constants.js";
import { SYNC_EFFECT_RECOVERY_ERROR_CODES } from "../../../../infrastructure/storage/sync/outbound/effectOutbox.js";

export const DEFAULT_WORKER_ROLE = "sync-effect-worker";
export const DEFAULT_WRITER_LEASE_DURATION_MS = 60_000;
export const DEFAULT_EFFECT_LEASE_DURATION_MS = 30_000;

export const SYNC_EFFECT_KINDS = CANONICAL_EFFECT_KINDS satisfies Record<string, EffectKind>;

export const EFFECT_TARGET_KINDS = CANONICAL_EFFECT_TARGET_KINDS satisfies Record<string, EffectTargetKind>;

export const OUTBOX_EFFECT_STATUSES = {
  FAILED: CANONICAL_EFFECT_STATUSES.FAILED,
  APPLIED: CANONICAL_EFFECT_STATUSES.APPLIED,
  BLOCKED_CANDIDATE: CANONICAL_EFFECT_STATUSES.BLOCKED_CANDIDATE,
  SUPERSEDED: CANONICAL_EFFECT_STATUSES.SUPERSEDED,
  CONFLICT: CANONICAL_EFFECT_STATUSES.CONFLICT,
} as const satisfies Record<string, EffectStatus>;

export const WORKER_ERROR_CODES = {
  INVALID_EFFECT_PAYLOAD: "invalid_effect_payload",
  ACTIVE_CANDIDATE_PRESERVED: "active_candidate_preserved",
  GATEWAY_SUPERSEDED: "gateway_superseded",
  CANDIDATE_GUARD_MISMATCH: "candidate_guard_mismatch",
  VISIBLE_GUARD_MISMATCH: "visible_guard_mismatch",
  GATEWAY_SCHEMA_ERROR: "gateway_schema_error",
  GATEWAY_RETRYABLE_ERROR: SYNC_EFFECT_RECOVERY_ERROR_CODES.GATEWAY_RETRYABLE_ERROR,
  POSTCONDITION_READ_FAILED: SYNC_EFFECT_RECOVERY_ERROR_CODES.POSTCONDITION_READ_FAILED,
  POSTCONDITION_APPLIED_WITHOUT_VISIBLE_STATE: "postcondition_applied_without_visible_state",
  POSTCONDITION_UNAVAILABLE: SYNC_EFFECT_RECOVERY_ERROR_CODES.POSTCONDITION_UNAVAILABLE,
  POSTCONDITION_CHANGED: "postcondition_changed",
  POSTCONDITION_UNAPPLIED_REQUIRES_REDRIVE:
    SYNC_EFFECT_RECOVERY_ERROR_CODES.POSTCONDITION_UNAPPLIED_REQUIRES_REDRIVE,
  REPAIR_REOBSERVE_REQUIRES_WRITER_REPLAN: "repair_reobserve_requires_writer_replan",
  REPAIR_REPLAN_FAILED: "repair_replan_failed",
  REPAIR_REPLAN_DEFERRED: "repair_replan_deferred",
  GATEWAY_CAPABILITY_MISSING: "gateway_capability_missing",
} as const;

export type SyncEffectWorkerErrorCode =
  (typeof WORKER_ERROR_CODES)[keyof typeof WORKER_ERROR_CODES];
