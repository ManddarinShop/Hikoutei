/** Runtime values for operations observed on a Sheet row. */
export const ROW_OPERATIONS = {
  INSERT: "insert",
  UPDATE: "update",
  DELETE: "delete",
  RENAME: "rename",
} as const;

/** Closed set of row operations accepted by the evaluator. */
export type RowOperation = (typeof ROW_OPERATIONS)[keyof typeof ROW_OPERATIONS];

/** Runtime values for field ownership in canonical and manifest state. */
export const FIELD_OWNERSHIPS = {
  USER: "user",
  SYSTEM: "system",
} as const;

/** Closed set of field ownership values. */
export type FieldOwnership =
  (typeof FIELD_OWNERSHIPS)[keyof typeof FIELD_OWNERSHIPS];

/** Runtime values for the lifecycle state of a row-to-entity binding. */
export const ROW_BINDING_STATES = {
  CANDIDATE: "candidate",
  ACTIVE: "active",
  TOMBSTONED: "tombstoned",
  AMBIGUOUS: "ambiguous",
} as const;

/** Closed set of row-binding lifecycle states. */
export type RowBindingState =
  (typeof ROW_BINDING_STATES)[keyof typeof ROW_BINDING_STATES];

/** Runtime values describing evidence for an observed row deletion. */
export const DELETE_EVIDENCE = {
  DELETED_CONFIRMED: "deleted_confirmed",
  ANCHOR_LOST: "anchor_lost",
  UNAVAILABLE: "unavailable",
} as const;

/** Closed set of deletion evidence values. */
export type DeleteEvidence =
  (typeof DELETE_EVIDENCE)[keyof typeof DELETE_EVIDENCE];

/** Runtime values returned when a precondition validator succeeds. */
export const PRECONDITION_RESULTS = {
  VALID: "valid",
  INVALID: "invalid",
} as const;

/** Runtime values describing whether canonical state is available. */
export const CANONICAL_RESOLUTION_STATUSES = {
  AVAILABLE: "available",
  MISSING: "missing",
} as const;

/** Closed set of canonical-state resolution statuses. */
export type CanonicalResolutionStatus =
  (typeof CANONICAL_RESOLUTION_STATUSES)[keyof typeof CANONICAL_RESOLUTION_STATUSES];

/** Runtime values for reasons that quarantine an observed row. */
export const QUARANTINE_REASONS = {
  UNKNOWN_FIELD: "unknown_field",
  UNKNOWN_BASE_REVISION: "unknown_base_revision",
  AMBIGUOUS_IDENTITY: "ambiguous_identity",
  IDENTITY_TAMPERING: "identity_tampering",
  SCHEMA_DRIFT: "schema_drift",
  SYSTEM_FIELD_EDIT: "system_field_edit",
  MIXED_OWNERSHIP_EDIT: "mixed_ownership_edit",
  INVALID_CELL: "invalid_cell",
  FORMULA_UNSUPPORTED: "formula_unsupported",
  MERGED_CELL_UNSUPPORTED: "merged_cell_unsupported",
  CELL_ERROR: "cell_error",
  ANCHOR_LOST: "anchor_lost",
  INVALID_SNAPSHOT_METADATA: "invalid_snapshot_metadata",
  INVALID_EVENT: "invalid_event",
} as const;

/** Closed set of reasons that quarantine an observed row. */
export type QuarantineReason =
  (typeof QUARANTINE_REASONS)[keyof typeof QUARANTINE_REASONS];

/** Runtime values for canonical conflict lifecycle states. */
export const CONFLICT_STATUSES = {
  OPEN: "OPEN",
  NEEDS_REBASE: "NEEDS_REBASE",
  RESOLVED: "RESOLVED",
} as const;

/** Closed set of canonical conflict lifecycle states. */
export type ConflictStatus =
  (typeof CONFLICT_STATUSES)[keyof typeof CONFLICT_STATUSES];
