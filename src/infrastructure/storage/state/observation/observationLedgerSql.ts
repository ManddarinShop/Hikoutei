/** SQL statements used by the observation receipt and event ledger. */

import { OBSERVATION_RECEIPT_STATES } from "./observationConstants.js";

export const READ_OBSERVATION_RECEIPT_SQL = `
  SELECT representative_payload_hash, event_id, state
  FROM observation_receipt
  WHERE logical_sheet_id = ? AND observation_key = ?
`;

export const INSERT_EVENT_OBSERVATION_SQL = `
  INSERT INTO event_observation (
    observation_id, logical_sheet_id, physical_sheet_id, observation_key, event_id,
    source, payload_json, payload_hash, detected_at, received_at, ingress_actor_id,
    editor_actor_id, editor_actor_source
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

export const INSERT_OBSERVATION_RECEIPT_SQL = `
  INSERT INTO observation_receipt (
    logical_sheet_id, observation_key, representative_payload_hash,
    first_observation_id, last_observation_id, event_id, state,
    first_seen_at, last_seen_at
  ) VALUES (?, ?, ?, ?, ?, NULL, '${OBSERVATION_RECEIPT_STATES.PENDING}', ?, ?)
`;

export const UPDATE_OBSERVATION_RECEIPT_REPLAY_SQL = `
  UPDATE observation_receipt
  SET last_observation_id = ?, last_seen_at = ?, state = ?
  WHERE logical_sheet_id = ? AND observation_key = ?
`;

export const UPDATE_EVENT_OBSERVATION_EVENT_SQL = `
  UPDATE event_observation
  SET event_id = ?
  WHERE observation_id = ?
`;

export const COMPLETE_OBSERVATION_RECEIPT_SQL = `
  UPDATE observation_receipt
  SET event_id = ?, state = ?
  WHERE logical_sheet_id = ? AND observation_key = ?
`;

export const READ_ROW_BINDING_SQL = `
  SELECT entity_id, state
  FROM row_binding
  WHERE row_binding_id = ? AND logical_sheet_id = ?
`;

export const READ_ACTIVE_CANDIDATE_SQL = `
  SELECT visible.active_candidate_conflict_id, visible.active_candidate_hash,
         visible.candidate_epoch, conflict.event_id, conflict.status
  FROM sheet_visible_field_state AS visible
  JOIN sync_conflict AS conflict
    ON conflict.conflict_id = visible.active_candidate_conflict_id
  WHERE visible.physical_sheet_id = ? AND visible.projection = ?
    AND visible.row_binding_id = ? AND visible.field_name = ?
    AND visible.active_candidate_conflict_id IS NOT NULL
    AND visible.active_candidate_hash IS NOT NULL
`;

export const READ_EVENT_BY_KEY_SQL = `
  SELECT event_id, payload_hash, event_sequence
  FROM event_log
  WHERE logical_sheet_id = ? AND event_key = ?
`;

export const READ_NEXT_EVENT_SEQUENCE_SQL = `
  SELECT COALESCE(MAX(event_sequence), 0) + 1 AS next_sequence
  FROM event_log
  WHERE logical_sheet_id = ?
`;

export const INSERT_EVENT_LOG_SQL = `
  INSERT INTO event_log (
    event_id, logical_sheet_id, physical_sheet_id, event_key, payload_hash,
    event_sequence, batch_id, row_binding_id, operation, status, received_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

export const INSERT_EVENT_ROW_SQL = `
  INSERT INTO event_row (event_id, before_row_json, after_row_json, before_hash, after_hash)
  VALUES (?, ?, ?, ?, ?)
`;

export const INSERT_EVENT_FIELD_SQL = `
  INSERT INTO event_field (
    event_id, field_name, previous_value, next_value, base_field_revision
  ) VALUES (?, ?, ?, ?, ?)
`;

export const UPDATE_VISIBLE_ROW_OBSERVED_HASH_SQL = `
  UPDATE sheet_visible_state
  SET last_observed_hash = ?
  WHERE physical_sheet_id = ? AND projection = ? AND row_binding_id = ?
`;

export const UPDATE_VISIBLE_FIELD_OBSERVED_HASH_SQL = `
  UPDATE sheet_visible_field_state
  SET last_observed_field_hash = ?
  WHERE physical_sheet_id = ? AND projection = ?
    AND row_binding_id = ? AND field_name = ?
`;

export const READ_EVENT_BATCH_SQL = `
  SELECT logical_sheet_id, physical_sheet_id, source, projection, atomicity, base_snapshot_hash
  FROM event_batch
  WHERE batch_id = ?
`;

export const INSERT_EVENT_BATCH_SQL = `
  INSERT INTO event_batch (
    batch_id, logical_sheet_id, physical_sheet_id, source, projection, atomicity, base_snapshot_hash
  ) VALUES (?, ?, ?, ?, ?, ?, ?)
`;
