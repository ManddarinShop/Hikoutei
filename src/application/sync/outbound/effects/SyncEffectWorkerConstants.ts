/** Constants and durable status contracts shared by the effect worker modules. */

import type { EffectKind, EffectStatus, EffectTargetKind } from "../../../../domain/index.js";
import { CONFLICT_STATUSES } from "../../../../domain/model/constants.js";
import { SYNC_EFFECT_RECOVERY_ERROR_CODES } from "../../../../infrastructure/storage/sync/effectOutbox.js";
import { SYNC_GATEWAY_PROJECTIONS } from "../../gateway/constants.js";

export const DEFAULT_WORKER_ROLE = "sync-effect-worker";
export const DEFAULT_WRITER_LEASE_DURATION_MS = 60_000;
export const DEFAULT_EFFECT_LEASE_DURATION_MS = 30_000;

export const SYNC_EFFECT_KINDS = {
  SYSTEM_PROJECTION: "system_projection",
  CANDIDATE_RECONCILE: "candidate_reconcile",
  SYSTEM_REPAIR: "system_repair",
  RESOLUTION_PROJECTION: "resolution_projection",
  RESOLUTION_DELETE: "resolution_delete",
  USER_INPUT_DELETE: "user_input_delete",
} as const satisfies Record<string, EffectKind>;

export const EFFECT_TARGET_KINDS = {
  ENTITY: "entity",
  ROW_BINDING: "row_binding",
  PROJECTION_ROW: "projection_row",
  CONFLICT: "conflict",
} as const satisfies Record<string, EffectTargetKind>;

export const OUTBOX_EFFECT_STATUSES = {
  FAILED: "failed",
  APPLIED: "applied",
  BLOCKED_CANDIDATE: "blocked_candidate",
  SUPERSEDED: "superseded",
  CONFLICT: "conflict",
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

export const USER_INPUT_CANDIDATE_BLOCK_SQL = `
    SELECT 1 AS blocked
    FROM sheet_visible_field_state AS visible
    LEFT JOIN sync_conflict AS conflict
      ON conflict.conflict_id = visible.active_candidate_conflict_id
    WHERE visible.physical_sheet_id = ?
      AND visible.projection = '${SYNC_GATEWAY_PROJECTIONS.USER_INPUT}'
      AND visible.row_binding_id = ?
      AND visible.field_name IN (__FIELD_NAMES__)
      AND visible.active_candidate_conflict_id IS NOT NULL
      AND visible.active_candidate_hash IS NOT NULL
      AND (conflict.conflict_id IS NULL OR conflict.status IN (
        '${CONFLICT_STATUSES.OPEN}', '${CONFLICT_STATUSES.NEEDS_REBASE}'
      ))
    LIMIT 1
  `;
