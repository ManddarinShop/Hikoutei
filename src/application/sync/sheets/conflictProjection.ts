/** Stable Sync_Conflicts audit projection schema and row materialization helpers. */

import type { SyncConflict, NormalizedCell } from "../../../domain/index.js";
import { NORMALIZED_CELL_KINDS } from "../../../shared/encoding/constants.js";
import { PRESENCE_KINDS } from "../../../shared/state/constants.js";

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

/** Builds the system-owned audit row for one automatically resolved conflict. */
export function syncConflictProjectionFields(
  conflict: SyncConflict,
  resolution: keyof typeof SYNC_CONFLICT_RESOLUTIONS,
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
    Resolution: stringCell(SYNC_CONFLICT_RESOLUTIONS[resolution]),
    Resolution_Command_ID: conflict.resolutionCommandId.kind === PRESENCE_KINDS.PRESENT
      ? stringCell(conflict.resolutionCommandId.value)
      : null,
  };
}

function stringCell(value: string): NormalizedCell {
  return { kind: NORMALIZED_CELL_KINDS.STRING, value };
}

function numberCell(value: number): NormalizedCell {
  return { kind: NORMALIZED_CELL_KINDS.NUMBER, value };
}
