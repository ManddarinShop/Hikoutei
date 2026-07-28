/** Protocol versions understood by the sync gateway contract. */
export const SYNC_GATEWAY_PROTOCOL_VERSIONS = {
  V1: "typed-sheets-sync-v1",
} as const;

export type SyncGatewayProtocolVersion =
  (typeof SYNC_GATEWAY_PROTOCOL_VERSIONS)[keyof typeof SYNC_GATEWAY_PROTOCOL_VERSIONS];

/** Projection labels accepted by the runtime gateway contract. */
export const SYNC_GATEWAY_PROJECTIONS = {
  USER_INPUT: "user_input",
  SYSTEM_STATE: "system_state",
  SYNC_CONFLICTS: "sync_conflicts",
} as const;

export type SyncGatewayProjection =
  (typeof SYNC_GATEWAY_PROJECTIONS)[keyof typeof SYNC_GATEWAY_PROJECTIONS];

/** Detail level used by normalized Sheet observation reads. */
export const SYNC_GATEWAY_SNAPSHOT_READ_MODES = {
  /** Reads formula, merge, error, and stable-cell metadata for reconciliation. */
  FULL: "full",
  /** Reads only user-editable literal values and row identity for polling. */
  USER_INPUT: "user_input",
} as const;

export type SyncGatewaySnapshotReadMode =
  (typeof SYNC_GATEWAY_SNAPSHOT_READ_MODES)[keyof typeof SYNC_GATEWAY_SNAPSHOT_READ_MODES];

/** Effect kinds that require special handling at the Apps Script boundary. */
export const SYNC_GATEWAY_EFFECT_KINDS = {
  RESOLUTION_DELETE: "resolution_delete",
  USER_INPUT_DELETE: "user_input_delete",
} as const;

/** Terminal and retryable statuses returned for one gateway effect. */
export const SYNC_GATEWAY_EFFECT_RESULT_STATUSES = {
  APPLIED: "applied",
  ALREADY_APPLIED: "already_applied",
  SUPERSEDED: "superseded",
  GUARD_MISMATCH: "guard_mismatch",
  REPAIR_REOBSERVE: "repair_reobserve",
  SCHEMA_ERROR: "schema_error",
  RETRYABLE_ERROR: "retryable_error",
} as const;

export type SyncGatewayEffectResultStatus =
  (typeof SYNC_GATEWAY_EFFECT_RESULT_STATUSES)[keyof typeof SYNC_GATEWAY_EFFECT_RESULT_STATUSES];

/** Result label returned when a fast-append row was accepted for writing. */
export const SYNC_GATEWAY_FAST_APPEND_STATUSES = {
  APPLIED: "applied",
} as const;

export type SyncGatewayFastAppendStatus =
  (typeof SYNC_GATEWAY_FAST_APPEND_STATUSES)[keyof typeof SYNC_GATEWAY_FAST_APPEND_STATUSES];

/** How much remote read-back the gateway performs before returning a write result. */
export const SYNC_GATEWAY_POSTCONDITION_MODES = {
  /** Read changed rows after the write and verify their target hashes inline. */
  INLINE: "inline",
  /** Return after the batched write is flushed; recovery reads verify later. */
  DEFERRED: "deferred",
} as const;

export type SyncGatewayPostconditionMode =
  (typeof SYNC_GATEWAY_POSTCONDITION_MODES)[keyof typeof SYNC_GATEWAY_POSTCONDITION_MODES];

/** Evidence level attached to a successful gateway write result. */
export const SYNC_GATEWAY_POSTCONDITION_STATUSES = {
  VERIFIED: "verified",
  ACKNOWLEDGED: "acknowledged",
  UNAVAILABLE: "unavailable",
} as const;

export type SyncGatewayPostconditionStatus =
  (typeof SYNC_GATEWAY_POSTCONDITION_STATUSES)[keyof typeof SYNC_GATEWAY_POSTCONDITION_STATUSES];

/** Read-back classification after a lost response or expired lease. */
export const SYNC_GATEWAY_POSTCONDITION_DISPOSITIONS = {
  APPLIED: "applied",
  UNAPPLIED: "unapplied",
  CHANGED: "changed",
  UNAVAILABLE: "unavailable",
} as const;

export type SyncGatewayPostconditionDisposition =
  (typeof SYNC_GATEWAY_POSTCONDITION_DISPOSITIONS)[keyof typeof SYNC_GATEWAY_POSTCONDITION_DISPOSITIONS];
