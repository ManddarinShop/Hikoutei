/** SQLite reads used to assemble one inbound User_Input polling state. */

import {
  CONFLICT_STATUSES,
} from "@hikoutei/contracts/domain/model/constants.js";
import {
  SYNC_PROJECTIONS,
} from "@hikoutei/contracts/sheets/constants.js";
import type {
  TypedSheetsEntityMapping,
} from "@hikoutei/contracts/sync-orm/mapping/contracts.js";
import {
  requireTypedSheetsEntityProjection,
} from "@hikoutei/contracts/sync-orm/mapping/projection.js";

import type { SqlExecutor } from "@hikoutei/contracts/storage/sql.js";

export interface RowBindingSqlRow {
  readonly row_binding_id: string;
  readonly logical_sheet_id: string;
  readonly anchor_reference: string;
  readonly entity_id: string | null;
  readonly state: string;
  readonly candidate_epoch: number;
}

export interface EntitySqlRow {
  readonly entity_id: string;
  readonly entity_revision: number;
  readonly status: string;
}

export interface EntityFieldSqlRow {
  readonly entity_id: string;
  readonly field_name: string;
  readonly normalized_value: string;
  readonly field_revision: number;
}

export interface BusinessKeySqlRow {
  readonly logical_sheet_id: string;
  readonly field_name: string;
  readonly normalized_key: string;
  readonly entity_id: string;
  readonly state: string;
}

export interface ConflictSqlRow {
  readonly conflict_id: string;
  readonly conflict_group_id: string | null;
  readonly event_id: string;
  readonly logical_sheet_id: string;
  readonly entity_id: string;
  readonly row_binding_id: string;
  readonly field_name: string;
  readonly user_value: string;
  readonly user_base_revision: number;
  readonly canonical_value_at_detection: string;
  readonly canonical_revision_at_detection: number;
  readonly current_canonical_value: string;
  readonly current_canonical_revision: number;
  readonly candidate_epoch: number;
  readonly candidate_visible_revision: number | null;
  readonly candidate_visible_hash: string | null;
  readonly status: string;
  readonly resolution_command_id: string | null;
}

export interface VisibleStateSqlRow {
  readonly physical_sheet_id: string;
  readonly row_binding_id: string;
  readonly confirmed_snapshot_hash: string;
  readonly confirmed_visible_revision: number;
  readonly confirmed_entity_revision: number | null;
}

export interface PendingEffectSqlRow {
  readonly row_binding_id: string;
}

export interface MappedPollingRows {
  readonly bindings: readonly RowBindingSqlRow[];
  readonly entities: readonly EntitySqlRow[];
  readonly fields: readonly EntityFieldSqlRow[];
  readonly businessKeys: readonly BusinessKeySqlRow[];
  readonly conflicts: readonly ConflictSqlRow[];
  readonly visible: readonly VisibleStateSqlRow[];
  /**
   * Bindings whose Sheet effect is still in the outbox (not yet delivered
   * or superseded). The check-column gate uses it to keep an in-flight OWN
   * write from reading as a false human-input mismatch.
   */
  readonly pendingEffects: readonly PendingEffectSqlRow[];
}

/** Reads all SQLite rows needed before User_Input snapshot inspection. */
export async function readMappedPollingRows(
  sql: SqlExecutor,
  mappings: readonly TypedSheetsEntityMapping[],
): Promise<MappedPollingRows> {
  const logicalSheetIds = unique(mappings.map((mapping) => mapping.logicalSheetId));
  const physicalSheetIds = unique(mappings.map((mapping) => requireTypedSheetsEntityProjection(
    mapping,
    SYNC_PROJECTIONS.USER_INPUT,
  ).physicalSheetId));
  const bindings = await sql.all<RowBindingSqlRow>(
    `SELECT row_binding_id, logical_sheet_id, anchor_reference, entity_id, state, candidate_epoch
     FROM row_binding
     WHERE logical_sheet_id IN (${placeholders(logicalSheetIds)})`,
    logicalSheetIds,
  );
  const entityIds = unique(bindings.flatMap((binding) =>
    binding.entity_id === null ? [] : [binding.entity_id],
  ));
  const entities = entityIds.length === 0
    ? []
    : await sql.all<EntitySqlRow>(
      `SELECT entity_id, entity_revision, status
       FROM entity_state
       WHERE entity_id IN (${placeholders(entityIds)})`,
      entityIds,
    );
  const fields = entityIds.length === 0
    ? []
    : await sql.all<EntityFieldSqlRow>(
      `SELECT entity_id, field_name, normalized_value, field_revision
       FROM entity_field_state
       WHERE entity_id IN (${placeholders(entityIds)})`,
      entityIds,
    );
  const businessKeys = await sql.all<BusinessKeySqlRow>(
    `SELECT logical_sheet_id, field_name, normalized_key, entity_id, state
     FROM business_key_index
     WHERE logical_sheet_id IN (${placeholders(logicalSheetIds)})`,
    logicalSheetIds,
  );
  const bindingIds = bindings.map((binding) => binding.row_binding_id);
  const conflicts = bindingIds.length === 0
    ? []
    : await sql.all<ConflictSqlRow>(
      `SELECT conflict_id, conflict_group_id, event_id, logical_sheet_id, entity_id,
              row_binding_id, field_name, user_value, user_base_revision,
              canonical_value_at_detection, canonical_revision_at_detection,
              current_canonical_value, current_canonical_revision, candidate_epoch,
              candidate_visible_revision, candidate_visible_hash,
              status, resolution_command_id
       FROM sync_conflict
       WHERE row_binding_id IN (${placeholders(bindingIds)})
         AND status IN ('${CONFLICT_STATUSES.OPEN}', '${CONFLICT_STATUSES.NEEDS_REBASE}')`,
      bindingIds,
    );
  const visible = await sql.all<VisibleStateSqlRow>(
    `SELECT physical_sheet_id, row_binding_id, confirmed_snapshot_hash,
            confirmed_visible_revision, confirmed_entity_revision
     FROM sheet_visible_state
     WHERE projection = ? AND physical_sheet_id IN (${placeholders(physicalSheetIds)})`,
    [SYNC_PROJECTIONS.USER_INPUT, ...physicalSheetIds],
  );
  // Undelivered outbox effects per binding. These are the statuses where
  // delivery of an OWN write is still in flight (queued, claimed, or
  // uncertain), so the remote row legitimately still shows the pre-write
  // values; conflict-blocked/blocked-candidate rows keep normal polling
  // observation. TERMINALLY FAILED effects are deliberately NOT in the
  // set: a failed effect will never deliver, so suppressing on it starves
  // inbound ingestion for the entire redrive window — and forever when the
  // failure is never superseded. The redrive's successor re-suppresses
  // when it is created. Statuses follow the outbox kernel CHECK constraint.
  const pendingEffects = await sql.all<PendingEffectSqlRow>(
    `SELECT DISTINCT row_binding_id
     FROM sheet_effect_outbox
     WHERE logical_sheet_id IN (${placeholders(logicalSheetIds)})
       AND row_binding_id IS NOT NULL
       AND status IN ('pending', 'processing', 'delivery_uncertain')`,
    logicalSheetIds,
  );
  return {
    bindings,
    entities,
    fields,
    businessKeys,
    conflicts,
    visible,
    pendingEffects,
  };
}

function placeholders(values: readonly string[]): string {
  if (values.length === 0) return "NULL";
  return values.map(() => "?").join(", ");
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
