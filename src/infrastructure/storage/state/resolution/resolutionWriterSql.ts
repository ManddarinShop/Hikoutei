/** SQL statements for the fenced resolution-command state machine. */

import { FENCE_EXISTS_SQL } from "../../sync/shared/writerLease.js";

export { FENCE_EXISTS_SQL } from "../../sync/shared/writerLease.js";

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
         current_canonical_revision, candidate_epoch, status, resolution_command_id
  FROM sync_conflict
  WHERE logical_sheet_id = ? AND conflict_id = ?
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
