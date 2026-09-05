/**
 * SQL statements used by the effect outbox state machine.
 *
 * Column and table names are persisted contract: they must never change even
 * though the kernel treats their values as opaque route/evidence keys.
 */

import { SYNC_EFFECT_RECOVERY_ERROR_CODES } from "../contract/contracts.js";
import { WORKER_ERROR_CODES } from "../worker/constants.js";
import { FENCE_EXISTS_SQL } from "./writerLease.js";

export { FENCE_EXISTS_SQL } from "./writerLease.js";

/**
 * The recoverable `failed` error codes that the worker retries on its own.
 *
 * This set is the single source of truth: the SQL fragment below and the
 * terminal-failed-head recovery check in the reconciliation scanner both
 * derive from it. A `failed` head whose `last_error_code` is NOT in this set
 * is terminal (for example `delivery_uncertain_timeout`) and must be
 * superseded by a scanner repair effect before its stream can progress.
 */
export const RECOVERABLE_EFFECT_ERROR_CODES: ReadonlySet<string> = new Set([
  SYNC_EFFECT_RECOVERY_ERROR_CODES.LEASE_EXPIRED_REQUIRES_POSTCONDITION,
  SYNC_EFFECT_RECOVERY_ERROR_CODES.PROVIDER_RETRYABLE_ERROR,
  // Pre-rename databases may carry the legacy provider code; failed rows
  // written with it must stay recoverable, not strand permanently.
  SYNC_EFFECT_RECOVERY_ERROR_CODES.LEGACY_GATEWAY_RETRYABLE_ERROR,
  SYNC_EFFECT_RECOVERY_ERROR_CODES.POSTCONDITION_READ_FAILED,
  SYNC_EFFECT_RECOVERY_ERROR_CODES.POSTCONDITION_UNAVAILABLE,
  SYNC_EFFECT_RECOVERY_ERROR_CODES.POSTCONDITION_UNAPPLIED_REQUIRES_REDRIVE,
]);
// The recoverable set gates only `failed` heads; `pending` requeues (e.g. lease_recovered_requeue) bypass this check.

export const RECOVERABLE_EFFECT_ERROR_CODE_SQL = [...RECOVERABLE_EFFECT_ERROR_CODES]
  .map((code) => `'${code}'`)
  .join(", ");

/**
 * Returns true when a `failed` effect's error code keeps it on the retry path.
 *
 * Recoverable failed heads stay owned by the worker retry loop and must not
 * be superseded by reconciliation; terminal failed heads (non-recoverable
 * codes such as `delivery_uncertain_timeout`) are superseded so a repair can
 * become the stream head.
 */
export function isRecoverableEffectErrorCode(code: string | null | undefined): boolean {
  return code !== null && code !== undefined && RECOVERABLE_EFFECT_ERROR_CODES.has(code);
}

export const CLAIM_EFFECT_SQL = `
  UPDATE sheet_effect_outbox AS candidate
  SET status = 'processing', claim_token = ?, writer_epoch = ?, lease_until = ?,
      dispatch_id = ?, next_attempt_at = NULL, next_probe_at = NULL,
      attempts = attempts + 1
  WHERE candidate.effect_id = ?
    AND candidate.status IN ('pending', 'failed', 'delivery_uncertain')
    AND (
      candidate.status = 'pending'
      OR (candidate.status = 'failed' AND
        (candidate.next_attempt_at IS NULL OR candidate.next_attempt_at <= ?))
      OR (candidate.status = 'delivery_uncertain' AND
        (candidate.next_probe_at IS NULL OR candidate.next_probe_at <= ?))
    )
    AND EXISTS (${FENCE_EXISTS_SQL})
    AND NOT EXISTS (
      SELECT 1
      FROM sheet_effect_outbox AS predecessor
      WHERE predecessor.logical_sheet_id = candidate.logical_sheet_id
        AND predecessor.target_kind = candidate.target_kind
        AND predecessor.target_id = candidate.target_id
        AND predecessor.stream_sequence < candidate.stream_sequence
        AND predecessor.status NOT IN ('applied', 'superseded')
    )
`;

export const RENEW_EFFECT_LEASE_SQL = `
  UPDATE sheet_effect_outbox
  SET lease_until = ?
  WHERE effect_id = ? AND status = 'processing' AND claim_token = ?
    AND writer_epoch = ? AND lease_until IS NOT NULL AND lease_until > ?
    AND EXISTS (${FENCE_EXISTS_SQL})
`;

export const INSERT_PENDING_EFFECT_SQL = `
  INSERT INTO sheet_effect_outbox (
    effect_id, effect_kind, commit_id, logical_sheet_id, physical_sheet_id,
    projection, row_binding_id, conflict_id, target_kind, target_id,
    target_entity_revision, target_field_revision_hash, target_canonical_commit_id,
    expected_visible_revision, expected_visible_hash, repair_guard_hash,
    source_quarantine_id, payload_json, payload_hash, effect_dedupe_key,
    stream_sequence, created_at, status
  )
  SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending'
  WHERE EXISTS (${FENCE_EXISTS_SQL})
`;

export const APPLY_EFFECT_RESULT_SQL = `
  UPDATE sheet_effect_outbox
  SET status = ?, last_error_code = ?, last_error_message = ?,
      claim_token = NULL, lease_until = NULL, next_attempt_at = NULL,
      next_probe_at = NULL, uncertain_since = NULL
  WHERE effect_id = ?
    AND status = 'processing'
    AND claim_token = ?
    AND writer_epoch = ?
    AND lease_until IS NOT NULL
    AND lease_until > ?
    AND EXISTS (${FENCE_EXISTS_SQL})
`;

export const SUPERSEDE_EFFECT_SQL = `
  UPDATE sheet_effect_outbox
  SET status = 'superseded', supersedes_effect_id = ?
  WHERE effect_id = ?
    AND status IN ('pending', 'processing', 'delivery_uncertain', 'blocked_candidate', 'conflict', 'failed')
    AND EXISTS (${FENCE_EXISTS_SQL})
`;

export const INSERT_REPLANNED_EFFECT_SQL = `
  INSERT INTO sheet_effect_outbox (
    effect_id, effect_kind, commit_id, logical_sheet_id, physical_sheet_id,
    projection, row_binding_id, conflict_id, target_kind, target_id,
    target_entity_revision, target_field_revision_hash, target_canonical_commit_id,
    expected_visible_revision, expected_visible_hash, repair_guard_hash,
    source_quarantine_id, payload_json, payload_hash, effect_dedupe_key,
    stream_sequence, predecessor_effect_id, created_at, status
  )
  SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending'
  WHERE EXISTS (${FENCE_EXISTS_SQL})
`;

export const RECOVER_EXPIRED_LEASES_SQL = `
  UPDATE sheet_effect_outbox
  SET status = 'delivery_uncertain', claim_token = NULL, lease_until = NULL,
      uncertain_since = COALESCE(uncertain_since, ?), next_probe_at = ?,
      last_error_code = '${SYNC_EFFECT_RECOVERY_ERROR_CODES.LEASE_EXPIRED_REQUIRES_POSTCONDITION}',
      last_error_message = 'Read the remote postcondition before retrying this effect.'
  WHERE status = 'processing' AND lease_until IS NOT NULL AND lease_until <= ?
    AND EXISTS (${FENCE_EXISTS_SQL})
`;

export const REQUEUE_CLAIMED_EFFECT_SQL = `
  UPDATE sheet_effect_outbox
  SET status = 'pending', claim_token = NULL, lease_until = NULL,
      next_attempt_at = ?, uncertain_since = NULL, next_probe_at = NULL,
      last_error_code = ?, last_error_message = ?
  WHERE effect_id = ? AND status = 'processing' AND claim_token = ?
    AND writer_epoch = ? AND lease_until IS NOT NULL AND lease_until > ?
    AND EXISTS (${FENCE_EXISTS_SQL})
`;

export const RELEASE_UNPROCESSED_EFFECT_SQL = `
  UPDATE sheet_effect_outbox
  SET status = 'pending', claim_token = NULL, lease_until = NULL,
      next_attempt_at = ?, uncertain_since = NULL, next_probe_at = NULL,
      last_error_code = ?, last_error_message = ?
  WHERE effect_id = ? AND status = 'processing' AND claim_token = ?
    AND writer_epoch = ? AND lease_until IS NOT NULL AND lease_until > ?
    AND EXISTS (${FENCE_EXISTS_SQL})
`;

/** Error code/message pairs keyed by release reason. */
export const RELEASE_UNPROCESSED_EFFECT_REASON = {
  provider_batch: {
    code: WORKER_ERROR_CODES.PROVIDER_BATCH_DEFERRED,
    message: "Provider acknowledged a bounded batch before this effect.",
  },
  lease_recovered: {
    code: WORKER_ERROR_CODES.LEASE_RECOVERED_REQUEUE,
    message: "Requeued after writer-lease recovery; no provider acknowledgement.",
  },
} as const;

export const MARK_DELIVERY_UNCERTAIN_SQL = `
  UPDATE sheet_effect_outbox
  SET status = 'delivery_uncertain', claim_token = NULL, lease_until = NULL,
      uncertain_since = COALESCE(uncertain_since, ?), next_probe_at = ?,
      last_error_code = ?, last_error_message = ?
  WHERE effect_id = ? AND status = 'processing' AND claim_token = ?
    AND writer_epoch = ? AND lease_until IS NOT NULL AND lease_until > ?
    AND EXISTS (${FENCE_EXISTS_SQL})
`;

export const SELECT_PENDING_EFFECTS_BY_TARGET_SQL = `
  SELECT effect_id, effect_kind, commit_id, logical_sheet_id, physical_sheet_id,
         projection, row_binding_id, conflict_id, target_kind, target_id,
         target_entity_revision, target_field_revision_hash, target_canonical_commit_id,
         expected_visible_revision, expected_visible_hash, repair_guard_hash,
         source_quarantine_id, payload_json, payload_hash, effect_dedupe_key,
         stream_sequence, created_at, next_attempt_at, uncertain_since,
         next_probe_at, dispatch_id, status
  FROM sheet_effect_outbox
  WHERE logical_sheet_id = ? AND target_kind = ? AND target_id = ?
    AND status = 'pending'
    AND NOT EXISTS (
      SELECT 1
      FROM sheet_effect_outbox AS predecessor
      WHERE predecessor.logical_sheet_id = sheet_effect_outbox.logical_sheet_id
        AND predecessor.target_kind = sheet_effect_outbox.target_kind
        AND predecessor.target_id = sheet_effect_outbox.target_id
        AND predecessor.stream_sequence < sheet_effect_outbox.stream_sequence
        AND predecessor.status NOT IN ('applied', 'superseded')
    )
  ORDER BY stream_sequence
`;

export const SELECT_READY_EFFECTS_SQL = `
  SELECT effect_id, effect_kind, commit_id, logical_sheet_id, physical_sheet_id,
         projection, row_binding_id, conflict_id, target_kind, target_id,
         target_entity_revision, target_field_revision_hash, target_canonical_commit_id,
         expected_visible_revision, expected_visible_hash, repair_guard_hash,
         source_quarantine_id, payload_json, payload_hash, effect_dedupe_key,
         stream_sequence, created_at, next_attempt_at, uncertain_since,
         next_probe_at, dispatch_id, status
  FROM sheet_effect_outbox AS candidate
  WHERE (
    (candidate.status = 'pending' AND
      (candidate.next_attempt_at IS NULL OR candidate.next_attempt_at <= ?))
    OR (
      candidate.status = 'failed'
      AND candidate.last_error_code IN (${RECOVERABLE_EFFECT_ERROR_CODE_SQL})
      AND (candidate.next_attempt_at IS NULL OR candidate.next_attempt_at <= ?)
    )
    OR (
      candidate.status = 'delivery_uncertain'
      AND (candidate.next_probe_at IS NULL OR candidate.next_probe_at <= ?)
    )
  )
    AND NOT EXISTS (
      SELECT 1
      FROM sheet_effect_outbox AS predecessor
      WHERE predecessor.logical_sheet_id = candidate.logical_sheet_id
        AND predecessor.target_kind = candidate.target_kind
        AND predecessor.target_id = candidate.target_id
        AND predecessor.stream_sequence < candidate.stream_sequence
        AND predecessor.status NOT IN ('applied', 'superseded')
    )
  ORDER BY candidate.logical_sheet_id, candidate.physical_sheet_id,
           candidate.target_kind, candidate.target_id, candidate.stream_sequence
  LIMIT ?
`;

/**
 * Bounded head-of-line selection restricted to potential fast-append rows.
 *
 * Only the SQL-visible append shape is filtered here (pending status,
 * readiness, predecessor ordering, and the revision-zero baseline on the
 * system-state and sync-conflict routes); the caller re-validates each
 * returned row's payload before claiming. Rows that fail that payload
 * validation drain through the regular claim path instead.
 */
export const SELECT_READY_FAST_APPEND_EFFECTS_SQL = `
  SELECT effect_id, effect_kind, commit_id, logical_sheet_id, physical_sheet_id,
         projection, row_binding_id, conflict_id, target_kind, target_id,
         target_entity_revision, target_field_revision_hash, target_canonical_commit_id,
         expected_visible_revision, expected_visible_hash, repair_guard_hash,
         source_quarantine_id, payload_json, payload_hash, effect_dedupe_key,
         stream_sequence, created_at, next_attempt_at, uncertain_since,
         next_probe_at, dispatch_id, status
  FROM sheet_effect_outbox AS candidate
  WHERE candidate.status = 'pending'
    AND (candidate.next_attempt_at IS NULL OR candidate.next_attempt_at <= ?)
    AND candidate.effect_kind IN ('system_projection', 'resolution_projection')
    AND candidate.projection IN ('system_state', 'sync_conflicts')
    AND candidate.target_kind IN ('entity', 'conflict')
    AND candidate.expected_visible_revision = 0
    AND candidate.expected_visible_hash = ''
    AND NOT EXISTS (
      SELECT 1
      FROM sheet_effect_outbox AS predecessor
      WHERE predecessor.logical_sheet_id = candidate.logical_sheet_id
        AND predecessor.target_kind = candidate.target_kind
        AND predecessor.target_id = candidate.target_id
        AND predecessor.stream_sequence < candidate.stream_sequence
        AND predecessor.status NOT IN ('applied', 'superseded')
    )
  ORDER BY candidate.logical_sheet_id, candidate.physical_sheet_id,
           candidate.target_kind, candidate.target_id, candidate.stream_sequence
  LIMIT ?
`;

export const COUNT_PENDING_OR_PROCESSING_EFFECTS_SQL = `
  SELECT COUNT(*) AS count
  FROM sheet_effect_outbox
  WHERE status IN ('pending', 'processing', 'delivery_uncertain')
`;

/**
 * Counts claimable drain work and terminal failed heads in one read.
 *
 * `busy_count` counts only work the first reconciliation scan must defer
 * for: `processing`/`delivery_uncertain` effects in flight, plus `pending`
 * effects that are genuinely claimable heads (no earlier same-stream
 * predecessor outside `applied`/`superseded`). A `pending` follower behind
 * a `conflict` or `blocked_candidate` predecessor is NOT claimable drain
 * work — it stays behind the candidate-pipeline lifecycle state until a
 * later effect supersedes it, so counting it would defer the first scan
 * forever and suppress the recovery that unblocks the stream.
 *
 * `terminal_failed_count` counts `failed` heads whose error code is NULL or
 * outside the recoverable set (a NULL code is treated as terminal so SQL
 * three-valued `NOT IN` cannot hide it): those heads block their streams
 * and must force the first scan even while the outbox is otherwise busy.
 */
export const READ_OUTBOX_SCAN_READINESS_SQL = `
  SELECT
    (SELECT COUNT(*) FROM sheet_effect_outbox AS candidate
      WHERE candidate.status IN ('processing', 'delivery_uncertain')
         OR (candidate.status = 'pending' AND NOT EXISTS (
              SELECT 1
              FROM sheet_effect_outbox AS predecessor
              WHERE predecessor.logical_sheet_id = candidate.logical_sheet_id
                AND predecessor.target_kind = candidate.target_kind
                AND predecessor.target_id = candidate.target_id
                AND predecessor.stream_sequence < candidate.stream_sequence
                AND predecessor.status NOT IN ('applied', 'superseded')
            ))) AS busy_count,
    (SELECT COUNT(*) FROM sheet_effect_outbox
      WHERE status = 'failed'
        AND (last_error_code IS NULL
          OR last_error_code NOT IN (${RECOVERABLE_EFFECT_ERROR_CODE_SQL}))) AS terminal_failed_count
`;

/**
 * Durable projection tag of the System_State projection (persisted contract).
 *
 * System_State is the one projection the startup path treats specially:
 * while its effects are still in flight, the first polling pass and external
 * convergence barriers defer so they cannot compete with the initial
 * System_State drain on the shared request limiter.
 */
export const SYSTEM_STATE_PROJECTION = "system_state" as const;

/**
 * Counts System_State effects that are still in flight (nonterminal).
 *
 * `processing`/`delivery_uncertain` effects are always in flight, plus
 * `pending` effects that are genuinely claimable heads (no earlier
 * same-stream predecessor outside `applied`/`superseded`). A `pending`
 * follower behind a `conflict` or `blocked_candidate` predecessor is NOT
 * claimable drain work — it stays behind the candidate-pipeline lifecycle
 * state until a later effect supersedes it, so counting it would defer the
 * first polling pass (or an external convergence barrier) forever and
 * suppress the polling/reconciliation pass that unblocks the stream.
 *
 * This mirrors the claimable-head semantics of
 * `READ_OUTBOX_SCAN_READINESS_SQL`: terminal lifecycle states — applied,
 * superseded, failed, conflict, blocked_candidate — never defer the
 * polling/readiness gate, so a terminal failed head or an open conflict
 * cannot stall the first polling pass forever.
 */
export const COUNT_ACTIVE_SYSTEM_STATE_EFFECTS_SQL = `
  SELECT COUNT(*) AS count
  FROM sheet_effect_outbox AS candidate
  WHERE candidate.projection = '${SYSTEM_STATE_PROJECTION}'
    AND (
      candidate.status IN ('processing', 'delivery_uncertain')
      OR (candidate.status = 'pending' AND NOT EXISTS (
        SELECT 1
        FROM sheet_effect_outbox AS predecessor
        WHERE predecessor.logical_sheet_id = candidate.logical_sheet_id
          AND predecessor.target_kind = candidate.target_kind
          AND predecessor.target_id = candidate.target_id
          AND predecessor.stream_sequence < candidate.stream_sequence
          AND predecessor.status NOT IN ('applied', 'superseded')
      ))
    )
`;

/** Reads the durable confirmed revision for one projection binding. */
export const READ_CONFIRMED_VISIBLE_REVISION_SQL = `
  SELECT confirmed_visible_revision
  FROM sheet_visible_state
  WHERE physical_sheet_id = ? AND projection = ? AND row_binding_id = ?
`;

export const UPSERT_VISIBLE_STATE_SQL = `
  INSERT INTO sheet_visible_state (
    physical_sheet_id, projection, row_binding_id, confirmed_snapshot_hash,
    confirmed_visible_revision, confirmed_entity_revision, last_observed_hash
  ) VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(physical_sheet_id, projection, row_binding_id)
  DO UPDATE SET
    confirmed_snapshot_hash = excluded.confirmed_snapshot_hash,
    confirmed_visible_revision = excluded.confirmed_visible_revision,
    confirmed_entity_revision = excluded.confirmed_entity_revision,
    last_observed_hash = excluded.last_observed_hash
  WHERE sheet_visible_state.confirmed_visible_revision <= excluded.confirmed_visible_revision
`;

export const UPSERT_VISIBLE_FIELD_STATE_SQL = `
  INSERT INTO sheet_visible_field_state (
    physical_sheet_id, projection, row_binding_id, field_name,
    confirmed_field_hash, confirmed_visible_revision, candidate_epoch,
    last_observed_field_hash
  ) VALUES (?, ?, ?, ?, ?, ?, 0, ?)
  ON CONFLICT(physical_sheet_id, projection, row_binding_id, field_name)
  DO UPDATE SET
    confirmed_field_hash = excluded.confirmed_field_hash,
    confirmed_visible_revision = excluded.confirmed_visible_revision,
    last_observed_field_hash = excluded.last_observed_field_hash
  WHERE sheet_visible_field_state.confirmed_visible_revision <= excluded.confirmed_visible_revision
`;
