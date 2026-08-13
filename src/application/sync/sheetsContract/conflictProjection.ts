/** Stable Sync_Conflicts audit projection schema and row materialization helpers. */

import type { SyncConflict } from "../../../domain/model/types.js";
import type { NormalizedCell } from "../../../shared/encoding/types.js";
import { CONFLICT_STATUSES } from "../../../domain/model/constants.js";
import { NORMALIZED_CELL_KINDS } from "../../../shared/encoding/constants.js";
import { PRESENCE_KINDS } from "../../../shared/state/constants.js";
import {
  STORAGE_ERROR_CODES,
  StorageError,
} from "../../../infrastructure/storage/errors.js";

/** Fixed audit headers shared by every entity-specific Sync_Conflicts tab. */
export const SYNC_CONFLICT_PROJECTION_HEADERS = [
  "Conflict_ID",
  "Conflict_Group_ID",
  "Event_ID",
  "Entity_ID",
  "Field_Name",
  "User_Value",
  "User_Base_Revision",
  "Canonical_Value_At_Detection",
  "Canonical_Revision_At_Detection",
  "Current_Canonical_Value",
  "Current_Canonical_Revision",
  "Candidate_Epoch",
  "Status",
  "Resolution",
  "Resolution_Command_ID",
] as const;

/** Registered range covering the fixed Sync_Conflicts audit schema. */
export const SYNC_CONFLICT_PROJECTION_REGISTERED_RANGE = "A:O";

/** Resolution value written when the canonical SQLite value wins automatically. */
export const SYNC_CONFLICT_RESOLUTIONS = {
  SYSTEM_WINS: "system_wins",
} as const;

/**
 * Builds the audit row for an unresolved conflict (OPEN or NEEDS_REBASE).
 *
 * The audit state union requires blank Resolution and Resolution_Command_ID
 * cells while a conflict is not resolved, and an unresolved conflict must
 * never carry a resolution command identity; only the RESOLVED variant
 * carries the system_wins marker and its durable command identity. Any
 * combination that would emit a command ID from an unresolved row is a
 * storage-consistency failure.
 */
export function openSyncConflictAuditProjectionFields(
  conflict: SyncConflict,
): Readonly<Record<string, NormalizedCell>> {
  if (conflict.status === CONFLICT_STATUSES.RESOLVED) {
    throw new StorageError(
      STORAGE_ERROR_CODES.RESOLUTION_STORAGE_INCONSISTENT,
      `resolved conflict ${conflict.conflictId} cannot be projected as unresolved`,
    );
  }
  if (conflict.resolutionCommandId.kind !== PRESENCE_KINDS.ABSENT) {
    throw new StorageError(
      STORAGE_ERROR_CODES.RESOLUTION_STORAGE_INCONSISTENT,
      `unresolved conflict ${conflict.conflictId} cannot carry a resolution command identity`,
    );
  }
  return auditProjectionFields(conflict, undefined, undefined);
}

/**
 * Builds the audit row for a system-wins resolved conflict.
 *
 * The audit state union requires a RESOLVED conflict carrying its applied
 * resolution command identity; projecting anything else as resolved is a
 * storage-consistency failure.
 */
export function resolvedSyncConflictAuditProjectionFields(
  conflict: SyncConflict,
): Readonly<Record<string, NormalizedCell>> {
  if (conflict.status !== CONFLICT_STATUSES.RESOLVED) {
    throw new StorageError(
      STORAGE_ERROR_CODES.RESOLUTION_STORAGE_INCONSISTENT,
      `conflict ${conflict.conflictId} is not RESOLVED and cannot carry a system-wins projection`,
    );
  }
  if (conflict.resolutionCommandId.kind !== PRESENCE_KINDS.PRESENT) {
    throw new StorageError(
      STORAGE_ERROR_CODES.RESOLUTION_STORAGE_INCONSISTENT,
      `resolved conflict ${conflict.conflictId} has no resolution command identity`,
    );
  }
  return auditProjectionFields(
    conflict,
    SYNC_CONFLICT_RESOLUTIONS.SYSTEM_WINS,
    conflict.resolutionCommandId.value,
  );
}

/** Materializes the shared audit columns for one conflict record. */
function auditProjectionFields(
  conflict: SyncConflict,
  resolution: (typeof SYNC_CONFLICT_RESOLUTIONS)[keyof typeof SYNC_CONFLICT_RESOLUTIONS] | undefined,
  resolutionCommandId: string | undefined,
): Readonly<Record<string, NormalizedCell>> {
  return {
    Conflict_ID: stringCell(conflict.conflictId),
    Conflict_Group_ID: conflict.conflictGroupId.kind === PRESENCE_KINDS.PRESENT
      ? stringCell(conflict.conflictGroupId.value)
      : null,
    Event_ID: stringCell(conflict.eventId),
    Entity_ID: stringCell(conflict.entityId),
    Field_Name: stringCell(conflict.fieldName),
    User_Value: conflict.userValue,
    User_Base_Revision: numberCell(conflict.userBaseRevision),
    Canonical_Value_At_Detection: conflict.canonicalValueAtDetection,
    Canonical_Revision_At_Detection: numberCell(conflict.canonicalRevisionAtDetection),
    Current_Canonical_Value: conflict.currentCanonicalValue,
    Current_Canonical_Revision: numberCell(conflict.currentCanonicalRevision),
    Candidate_Epoch: numberCell(conflict.candidateEpoch),
    Status: stringCell(conflict.status),
    Resolution: resolution === undefined ? null : stringCell(resolution),
    Resolution_Command_ID: resolutionCommandId === undefined
      ? null
      : stringCell(resolutionCommandId),
  };
}

function stringCell(value: string): NormalizedCell {
  return { kind: NORMALIZED_CELL_KINDS.STRING, value };
}

function numberCell(value: number): NormalizedCell {
  return { kind: NORMALIZED_CELL_KINDS.NUMBER, value };
}
