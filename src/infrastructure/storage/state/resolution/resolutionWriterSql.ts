/** SQL statements for the fenced resolution-command state machine. */

import { FENCE_EXISTS_SQL } from "@hikoutei/ikisaki";

export { FENCE_EXISTS_SQL } from "@hikoutei/ikisaki";

export const FIND_EXISTING_COMMAND_SQL = `
  SELECT command_id, request_key, action, actor_id, role, target_conflict_id,
         expected_revision, active_candidate_hash, expected_candidate_epoch,
         payload_hash, status
  FROM resolution_command
  WHERE command_id = ? OR request_key = ?
`;

export const READ_CONFLICT_SQL = `
  SELECT conflict_id, conflict_group_id, event_id, row_binding_id, entity_id, field_name,
         user_value, user_base_revision, canonical_value_at_detection,
         canonical_revision_at_detection, current_canonical_value,
         current_canonical_revision, candidate_epoch,
         candidate_visible_revision, candidate_visible_hash,
         status, resolution_command_id
  FROM sync_conflict
  WHERE logical_sheet_id = ? AND conflict_id = ?
`;

/**
 * Reads conflict ids that carry a durable pending resolution command for one
 * logical sheet. `resolution_command` has no logical-sheet column, so the
 * conflict table supplies the scope through the command's target.
 */
export const READ_PENDING_CONFLICT_IDS_SQL = `
  SELECT DISTINCT c.conflict_id AS conflict_id
  FROM resolution_command rc
  JOIN sync_conflict c ON c.conflict_id = rc.target_conflict_id
  WHERE c.logical_sheet_id = ? AND rc.status = 'pending'
  ORDER BY c.conflict_id
`;

/** Reads every durable pending command targeting one conflict. */
export const READ_PENDING_COMMANDS_FOR_CONFLICT_SQL = `
  SELECT command_id, request_key, action, actor_id, role, target_conflict_id,
         expected_revision, active_candidate_hash, expected_candidate_epoch,
         payload_hash, status
  FROM resolution_command
  WHERE target_conflict_id = ? AND status = 'pending'
  ORDER BY command_id
`;

/** Marks one durable pending command stale idempotently (status guarded). */
export const MARK_PENDING_COMMAND_STALE_SQL = `
  UPDATE resolution_command
  SET status = 'stale'
  WHERE command_id = ? AND status = 'pending'
    AND EXISTS (${FENCE_EXISTS_SQL})
`;

/**
 * Stales every pending automatic command superseded by a newer resolution
 * identity.
 *
 * Only the latest automatic generation for a conflict may stay pending; older
 * generations are obsolete the moment a newer canonical revision is planned.
 * Manual or unknown pending commands are never superseded by polling-owned
 * planning: actor, action, and identity prefix must all match one of the two
 * automatic identities (retired legacy `sync:auto-system-wins` and current
 * implicit `sync:system-wins`).
 */
export const STALE_SUPERSEDED_PENDING_COMMANDS_SQL = `
  UPDATE resolution_command
  SET status = 'stale'
  WHERE target_conflict_id = ? AND command_id != ? AND status = 'pending'
    AND action = 'acknowledge_system'
    AND (
      (actor_id = 'sync:system-wins' AND command_id LIKE 'sync:system-wins:%')
      OR (actor_id = 'sync:auto-system-wins' AND command_id LIKE 'auto-system-wins:%')
    )
    AND EXISTS (${FENCE_EXISTS_SQL})
`;

/** Rebases an unresolved conflict to the current canonical field state. */
export const REBASE_ACTIVE_CONFLICT_SQL = `
  UPDATE sync_conflict
  SET current_canonical_value = ?, current_canonical_revision = ?,
      status = 'NEEDS_REBASE', last_rebased_commit_id = ?, updated_at = ?
  WHERE conflict_id = ?
    AND status IN ('OPEN', 'NEEDS_REBASE')
    AND EXISTS (${FENCE_EXISTS_SQL})
`;

export const READ_ACTIVE_CANDIDATE_POINTER_SQL = `
  SELECT physical_sheet_id, projection, candidate_epoch, active_candidate_hash
  FROM sheet_visible_field_state
  WHERE row_binding_id = ? AND field_name = ?
    AND active_candidate_conflict_id = ?
    AND active_candidate_hash IS NOT NULL
`;

export const INSERT_PROCESSING_COMMAND_SQL = `
  INSERT INTO resolution_command (
    command_id, request_key, action, actor_id, role, target_conflict_id,
    expected_revision, active_candidate_hash, expected_candidate_epoch,
    payload_hash, status, issued_at
  )
  SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', ?
  WHERE EXISTS (${FENCE_EXISTS_SQL})
`;

/** Records a deferred automatic resolution without claiming it for execution. */
export const INSERT_PENDING_COMMAND_SQL = `
  INSERT INTO resolution_command (
    command_id, request_key, action, actor_id, role, target_conflict_id,
    expected_revision, active_candidate_hash, expected_candidate_epoch,
    payload_hash, status, issued_at
  )
  SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?
  WHERE NOT EXISTS (
    SELECT 1 FROM resolution_command
    WHERE command_id = ? OR request_key = ?
  )
    AND EXISTS (${FENCE_EXISTS_SQL})
`;

/** Promotes a durable deferred command only after its predecessor is gone. */
export const MARK_PENDING_COMMAND_PROCESSING_SQL = `
  UPDATE resolution_command
  SET status = 'processing'
  WHERE command_id = ? AND request_key = ? AND status = 'pending'
    AND EXISTS (${FENCE_EXISTS_SQL})
`;

export const MARK_CONFLICT_RESOLVED_SQL = `
  UPDATE sync_conflict
  SET status = 'RESOLVED', resolution_command_id = ?, updated_at = ?
  WHERE conflict_id = ? AND status IN ('OPEN', 'NEEDS_REBASE')
    AND current_canonical_revision = ? AND candidate_epoch = ?
    AND EXISTS (${FENCE_EXISTS_SQL})
`;

export const CLEAR_ACTIVE_CANDIDATE_POINTER_SQL = `
  UPDATE sheet_visible_field_state
  SET active_candidate_conflict_id = NULL, active_candidate_hash = NULL,
      candidate_epoch = candidate_epoch + 1
  WHERE physical_sheet_id = ? AND projection = ?
    AND row_binding_id = ? AND field_name = ?
    AND active_candidate_conflict_id = ? AND candidate_epoch = ?
    AND EXISTS (${FENCE_EXISTS_SQL})
`;

export const ADVANCE_ROW_BINDING_CANDIDATE_EPOCH_SQL = `
  UPDATE row_binding
  SET candidate_epoch = CASE
    WHEN candidate_epoch <= ? THEN ?
    ELSE candidate_epoch
  END
  WHERE row_binding_id = ? AND logical_sheet_id = ?
    AND EXISTS (${FENCE_EXISTS_SQL})
`;

/**
 * Supersedes pending User_Input candidate_reconcile rewrites for one row
 * binding the moment the conflict that owned the row resolves.
 *
 * A cleanup or repair scan can enqueue a full-row rewrite carrying a stale
 * canonical snapshot while a conflict is open. Such rewrites stream under the
 * physical anchor (`target_id` = anchor) instead of the binding stream key
 * (`projection-row:<sheet>:<binding>`), so the resolution's normal
 * supersede-and-replan lookup never sees them, and the worker candidate gate
 * blocks them only while the conflict stays OPEN or NEEDS_REBASE. Once a
 * resolution command applies, the gate opens and the stale rewrite would
 * otherwise deliver (it was enqueued before the resolution's own fresh
 * reconcile, whose visible-hash CAS it then breaks) and overwrite the row
 * with a stale value. The resolution's reconcile is now authoritative for
 * the row, so any such pending rewrite is superseded in the same
 * transaction. Only non-terminal `pending` rewrites are touched:
 * in-flight (`processing`/`delivery_uncertain`) writes are left to settle
 * and `blocked_candidate` heads are already terminal and converge through a
 * later re-scan.
 */
export const SUPERSEDE_PENDING_USER_INPUT_REWRITES_SQL = `
  UPDATE sheet_effect_outbox
  SET status = 'superseded', supersedes_effect_id = ?
  WHERE logical_sheet_id = ?
    AND projection = 'user_input'
    AND effect_kind = 'candidate_reconcile'
    AND row_binding_id = ?
    AND effect_id != ?
    AND status = 'pending'
    AND EXISTS (${FENCE_EXISTS_SQL})
`;

export const MARK_COMMAND_APPLIED_SQL = `
  UPDATE resolution_command
  SET status = 'applied', applied_commit_id = ?
  WHERE command_id = ? AND status = 'processing'
    AND EXISTS (${FENCE_EXISTS_SQL})
`;

export const MARK_CONFLICT_STALE_SQL = `
  UPDATE sync_conflict
  SET status = ?, updated_at = ?
  WHERE conflict_id = ? AND status IN ('OPEN', 'NEEDS_REBASE')
    AND EXISTS (${FENCE_EXISTS_SQL})
`;

export const MARK_COMMAND_STALE_SQL = `
  UPDATE resolution_command
  SET status = 'stale'
  WHERE command_id = ? AND status = 'processing'
    AND EXISTS (${FENCE_EXISTS_SQL})
`;

export const MARK_COMMAND_REJECTED_SQL = `
  UPDATE resolution_command
  SET status = 'rejected'
  WHERE command_id = ? AND status = 'processing'
    AND EXISTS (${FENCE_EXISTS_SQL})
`;

export const READ_EFFECT_DEDUPE_SQL = `
  SELECT effect_kind, commit_id, logical_sheet_id, physical_sheet_id,
         projection, target_kind, target_id, payload_hash
  FROM sheet_effect_outbox
  WHERE effect_dedupe_key = ?
`;

export const READ_REGISTERED_PROJECTION_SQL = `
  SELECT logical_sheet_id, projection, enabled
  FROM physical_sheet_registry
  WHERE physical_sheet_id = ?
`;

/**
 * Finds an in-flight predecessor that could still materialize after a
 * replacement. `delivery_uncertain` counts as in-flight because the remote
 * write may still commit after a lost response; resolution successors must
 * wait until that predecessor is probe-settled.
 */
export const READ_PROCESSING_PREDECESSOR_SQL = `
  SELECT effect_id
  FROM sheet_effect_outbox
  WHERE logical_sheet_id = ? AND target_kind = ? AND target_id = ?
    AND stream_sequence < ? AND status IN ('processing', 'delivery_uncertain')
  ORDER BY stream_sequence
  LIMIT 1
`;
