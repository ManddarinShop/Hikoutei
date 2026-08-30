/** Converts raw polling SQL rows into semantic lookup maps for observation. */

import {
  ROW_BINDING_STATES,
} from "@hikoutei/contracts/domain/model/constants.js";
import type {
  RowBindingContext,
  SyncConflict,
} from "@hikoutei/contracts/domain/model/types.js";
import type { NormalizedCell } from "@hikoutei/contracts/encoding/types.js";
import {
  parseNormalizedCell,
  requireConflictStatus,
} from "../../../../storage/state/resolution/resolutionWriterHelpers.js";
import { promoteCandidateVisibleEvidence } from "../../../../storage/state/resolution/candidateEvidence.js";
import {
  TYPED_SHEETS_ORM_ERROR_CODES,
  TypedSheetsOrmError,
} from "@hikoutei/contracts/sync-orm/errors.js";

import type {
  BusinessKeySqlRow,
  ConflictSqlRow,
  EntityFieldSqlRow,
  EntitySqlRow,
  RowBindingSqlRow,
  VisibleStateSqlRow,
} from "./MikroOrmUserInputPollingSql.js";

export interface VisibleProjectionState {
  readonly confirmedVisibleHash: string;
  readonly confirmedVisibleRevision: number;
  readonly confirmedEntityRevision: number | null;
}

export interface MappedPollingState {
  readonly bindingsByEntityId: ReadonlyMap<string, ReadonlyMap<string, RowBindingStateRecord>>;
  readonly entitiesById: ReadonlyMap<string, EntityStateRecord>;
  readonly businessKeysByLogicalAndField: ReadonlyMap<string, ReadonlyMap<string, ReadonlyMap<string, string>>>;
  readonly conflictsByBindingAndField: ReadonlyMap<string, ReadonlyMap<string, SyncConflict>>;
  readonly visibleRevisionsByPhysicalAndBinding: ReadonlyMap<string, ReadonlyMap<string, VisibleProjectionState>>;
}

export interface RowBindingStateRecord {
  readonly rowBindingId: string;
  readonly logicalSheetId: string;
  readonly anchorReference: string;
  readonly entityId: string | null;
  readonly state: RowBindingContext["bindingState"];
  readonly candidateEpoch: number;
}

export interface EntityStateRecord {
  readonly entityId: string;
  readonly entityRevision: number;
  readonly status: "active" | "tombstoned";
  readonly fields: ReadonlyMap<string, CanonicalFieldRecord>;
}

export interface CanonicalFieldRecord {
  readonly value: NormalizedCell;
  readonly fieldRevision: number;
}

/** Builds all lookup maps consumed by snapshot inspection and evaluation. */
export function buildPollingState(
  bindingRows: readonly RowBindingSqlRow[],
  entityRows: readonly EntitySqlRow[],
  fieldRows: readonly EntityFieldSqlRow[],
  businessKeyRows: readonly BusinessKeySqlRow[],
  conflictRows: readonly ConflictSqlRow[],
  visibleRows: readonly VisibleStateSqlRow[],
): MappedPollingState {
  return {
    bindingsByEntityId: buildRowBindings(bindingRows),
    entitiesById: buildEntityState(entityRows, buildCanonicalFields(fieldRows)),
    businessKeysByLogicalAndField: buildBusinessKeyIndex(businessKeyRows),
    conflictsByBindingAndField: buildConflicts(conflictRows),
    visibleRevisionsByPhysicalAndBinding: buildVisibleRevisions(visibleRows),
  };
}

function buildCanonicalFields(
  rows: readonly EntityFieldSqlRow[],
): ReadonlyMap<string, ReadonlyMap<string, CanonicalFieldRecord>> {
  const fieldsByEntity = new Map<string, Map<string, CanonicalFieldRecord>>();
  for (const row of rows) {
    const fields = fieldsByEntity.get(row.entity_id) ?? new Map();
    fields.set(row.field_name, {
      value: parseNormalizedCell(row.normalized_value, `${row.entity_id}.${row.field_name}`),
      fieldRevision: row.field_revision,
    });
    fieldsByEntity.set(row.entity_id, fields);
  }
  return fieldsByEntity;
}

function buildEntityState(
  rows: readonly EntitySqlRow[],
  fieldsByEntity: ReadonlyMap<string, ReadonlyMap<string, CanonicalFieldRecord>>,
): ReadonlyMap<string, EntityStateRecord> {
  const entitiesById = new Map<string, EntityStateRecord>();
  for (const row of rows) {
    if (row.status !== "active" && row.status !== "tombstoned") {
      throw new TypedSheetsOrmError(
        TYPED_SHEETS_ORM_ERROR_CODES.INVALID_ENTITY_MAPPING,
        `unknown canonical entity status: ${row.status}.`,
      );
    }
    entitiesById.set(row.entity_id, {
      entityId: row.entity_id,
      entityRevision: row.entity_revision,
      status: row.status,
      fields: fieldsByEntity.get(row.entity_id) ?? new Map(),
    });
  }
  return entitiesById;
}

function buildRowBindings(
  rows: readonly RowBindingSqlRow[],
): ReadonlyMap<string, ReadonlyMap<string, RowBindingStateRecord>> {
  const bindingsByEntityId = new Map<string, Map<string, RowBindingStateRecord>>();
  for (const row of rows) {
    if (!isRowBindingState(row.state)) {
      throw new TypedSheetsOrmError(
        TYPED_SHEETS_ORM_ERROR_CODES.INVALID_ENTITY_MAPPING,
        `unknown row binding state: ${row.state}.`,
      );
    }
    const record: RowBindingStateRecord = {
      rowBindingId: row.row_binding_id,
      logicalSheetId: row.logical_sheet_id,
      anchorReference: row.anchor_reference,
      entityId: row.entity_id,
      state: row.state,
      candidateEpoch: row.candidate_epoch,
    };
    if (row.entity_id !== null) {
      const byEntityId = bindingsByEntityId.get(row.logical_sheet_id) ?? new Map();
      byEntityId.set(row.entity_id, record);
      bindingsByEntityId.set(row.logical_sheet_id, byEntityId);
    }
  }
  return bindingsByEntityId;
}

function buildBusinessKeyIndex(
  rows: readonly BusinessKeySqlRow[],
): ReadonlyMap<string, ReadonlyMap<string, ReadonlyMap<string, string>>> {
  const businessKeysByLogicalAndField = new Map<string, Map<string, Map<string, string>>>();
  for (const row of rows) {
    if (row.state !== "active") continue;
    const byField = businessKeysByLogicalAndField.get(row.logical_sheet_id) ?? new Map();
    const byKey = byField.get(row.field_name) ?? new Map();
    byKey.set(row.normalized_key, row.entity_id);
    byField.set(row.field_name, byKey);
    businessKeysByLogicalAndField.set(row.logical_sheet_id, byField);
  }
  return businessKeysByLogicalAndField;
}

function buildConflicts(
  rows: readonly ConflictSqlRow[],
): ReadonlyMap<string, ReadonlyMap<string, SyncConflict>> {
  const conflictsByBindingAndField = new Map<string, Map<string, SyncConflict>>();
  for (const row of rows) {
    const byField = conflictsByBindingAndField.get(row.row_binding_id) ?? new Map();
    byField.set(row.field_name, {
      conflictId: row.conflict_id,
      conflictGroupId: nullablePresence(row.conflict_group_id),
      eventId: row.event_id,
      rowBindingId: row.row_binding_id,
      entityId: row.entity_id,
      fieldName: row.field_name,
      userValue: parseNormalizedCell(row.user_value, `${row.conflict_id}.user_value`),
      userBaseRevision: row.user_base_revision,
      canonicalValueAtDetection: parseNormalizedCell(
        row.canonical_value_at_detection,
        `${row.conflict_id}.canonical_value_at_detection`,
      ),
      canonicalRevisionAtDetection: row.canonical_revision_at_detection,
      currentCanonicalValue: parseNormalizedCell(
        row.current_canonical_value,
        `${row.conflict_id}.current_canonical_value`,
      ),
      currentCanonicalRevision: row.current_canonical_revision,
      candidateEpoch: row.candidate_epoch,
      candidateVisibleEvidence: promoteCandidateVisibleEvidence(
        row.candidate_visible_revision,
        row.candidate_visible_hash,
        row.conflict_id,
      ),
      status: requireConflictStatus(row.status),
      resolutionCommandId: nullablePresence(row.resolution_command_id),
    });
    conflictsByBindingAndField.set(row.row_binding_id, byField);
  }
  return conflictsByBindingAndField;
}

function buildVisibleRevisions(
  rows: readonly VisibleStateSqlRow[],
): ReadonlyMap<string, ReadonlyMap<string, VisibleProjectionState>> {
  const visibleRevisionsByPhysicalAndBinding = new Map<string, Map<string, VisibleProjectionState>>();
  for (const row of rows) {
    const byBinding = visibleRevisionsByPhysicalAndBinding.get(row.physical_sheet_id) ?? new Map();
    byBinding.set(row.row_binding_id, {
      confirmedVisibleHash: row.confirmed_snapshot_hash,
      confirmedVisibleRevision: row.confirmed_visible_revision,
      confirmedEntityRevision: row.confirmed_entity_revision,
    });
    visibleRevisionsByPhysicalAndBinding.set(row.physical_sheet_id, byBinding);
  }
  return visibleRevisionsByPhysicalAndBinding;
}

function isRowBindingState(value: string): value is RowBindingContext["bindingState"] {
  return value === ROW_BINDING_STATES.CANDIDATE ||
    value === ROW_BINDING_STATES.ACTIVE ||
    value === ROW_BINDING_STATES.TOMBSTONED ||
    value === ROW_BINDING_STATES.AMBIGUOUS;
}

function nullablePresence<T>(value: T | null) {
  return value === null
    ? { kind: "absent" as const }
    : { kind: "present" as const, value };
}
