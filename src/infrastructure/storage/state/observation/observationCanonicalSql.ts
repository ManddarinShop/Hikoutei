/** SQL statements used by canonical and conflict observation persistence. */

import {
  CONFLICT_STATUSES,
  ROW_BINDING_STATES,
} from "../../../../domain/model/constants.js";

export const ADVANCE_ROW_BINDING_CANDIDATE_EPOCH_SQL = `
  UPDATE row_binding
  SET candidate_epoch = CASE
    WHEN candidate_epoch < ? THEN ?
    ELSE candidate_epoch
  END
  WHERE row_binding_id = ? AND logical_sheet_id = ?
`;

export const ACTIVATE_INSERTED_ROW_BINDING_SQL = `
  UPDATE row_binding
  SET entity_id = ?, state = '${ROW_BINDING_STATES.ACTIVE}'
  WHERE row_binding_id = ? AND logical_sheet_id = ?
    AND state = '${ROW_BINDING_STATES.CANDIDATE}' AND entity_id IS NULL
`;

export const TOMBSTONE_DELETED_ROW_BINDING_SQL = `
  UPDATE row_binding
  SET state = '${ROW_BINDING_STATES.TOMBSTONED}'
  WHERE row_binding_id = ? AND logical_sheet_id = ?
    AND state = '${ROW_BINDING_STATES.ACTIVE}' AND entity_id = ?
`;

export const DEACTIVATE_ENTITY_BUSINESS_KEYS_SQL = `
  UPDATE business_key_index
  SET state = 'inactive'
  WHERE logical_sheet_id = ? AND entity_id = ? AND state = 'active'
`;

export const RETIRE_BUSINESS_KEY_SQL = `
  UPDATE business_key_index
  SET state = 'inactive'
  WHERE logical_sheet_id = ? AND field_name = ? AND normalized_key = ?
    AND entity_id = ? AND state = 'active'
`;

export const READ_ACTIVE_BUSINESS_KEY_SQL = `
  SELECT entity_id
  FROM business_key_index
  WHERE logical_sheet_id = ? AND field_name = ? AND normalized_key = ? AND state = 'active'
`;

export const INSERT_ACTIVE_BUSINESS_KEY_SQL = `
  INSERT INTO business_key_index (
    logical_sheet_id, field_name, normalized_key, entity_id, state
  ) VALUES (?, ?, ?, ?, 'active')
`;

export const REBASE_ACTIVE_CONFLICT_SQL = `
  UPDATE sync_conflict
  SET current_canonical_value = ?, current_canonical_revision = ?,
      status = '${CONFLICT_STATUSES.NEEDS_REBASE}', last_rebased_commit_id = ?, updated_at = ?
  WHERE conflict_id = ?
    AND status IN ('${CONFLICT_STATUSES.OPEN}', '${CONFLICT_STATUSES.NEEDS_REBASE}')
`;

export const INSERT_SYNC_CONFLICT_SQL = `
  INSERT INTO sync_conflict (
    conflict_id, conflict_group_id, event_id, logical_sheet_id, entity_id, row_binding_id,
    field_name, user_value, user_base_revision, canonical_value_at_detection,
    canonical_revision_at_detection, current_canonical_value, current_canonical_revision,
    candidate_epoch, status, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '${CONFLICT_STATUSES.OPEN}', ?, ?)
`;

export const UPSERT_VISIBLE_FIELD_STATE_SQL = `
  INSERT INTO sheet_visible_field_state (
    physical_sheet_id, projection, row_binding_id, field_name,
    confirmed_field_hash, confirmed_visible_revision,
    active_candidate_conflict_id, active_candidate_hash, candidate_epoch,
    last_observed_field_hash
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(physical_sheet_id, projection, row_binding_id, field_name)
  DO UPDATE SET
    active_candidate_conflict_id = excluded.active_candidate_conflict_id,
    active_candidate_hash = excluded.active_candidate_hash,
    candidate_epoch = excluded.candidate_epoch,
    last_observed_field_hash = excluded.last_observed_field_hash
`;

export const READ_MAX_CANDIDATE_EPOCH_SQL = `
  SELECT MAX(candidate_epoch) AS max_epoch
  FROM sync_conflict
  WHERE row_binding_id = ? AND field_name = ?
`;
