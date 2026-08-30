import { REGISTERED_PROJECTION_KINDS } from "../domain/model/constants.js";
import type { RegisteredProjectionKind } from "../domain/model/constants.js";

/** Protocol versions understood by the sync provider contract. */
export const SYNC_PROTOCOL_VERSIONS = {
  V1: "typed-sheets-sync-v1",
} as const;

export type SyncProtocolVersion =
  (typeof SYNC_PROTOCOL_VERSIONS)[keyof typeof SYNC_PROTOCOL_VERSIONS];

/** Projection labels accepted by the runtime provider contract. */
export const SYNC_PROJECTIONS = {
  USER_INPUT: REGISTERED_PROJECTION_KINDS.USER_INPUT,
  SYSTEM_STATE: REGISTERED_PROJECTION_KINDS.SYSTEM_STATE,
  SYNC_CONFLICTS: REGISTERED_PROJECTION_KINDS.SYNC_CONFLICTS,
} as const satisfies Record<string, RegisteredProjectionKind>;

export type SyncProjectionKind = RegisteredProjectionKind;

/** Detail level used by normalized Sheet observation reads. */
export const SYNC_SNAPSHOT_READ_MODES = {
  /** Reads formula, merge, error, and stable-cell metadata for reconciliation. */
  FULL: "full",
  /** Reads only user-editable literal values and row identity for polling. */
  USER_INPUT: "user_input",
} as const;

export type SyncSnapshotReadMode =
  (typeof SYNC_SNAPSHOT_READ_MODES)[keyof typeof SYNC_SNAPSHOT_READ_MODES];

/** Effect kinds that require special handling at the provider boundary. */
export const SYNC_DELETE_EFFECT_KINDS = {
  RESOLUTION_DELETE: "resolution_delete",
  USER_INPUT_DELETE: "user_input_delete",
} as const;

/** Terminal and retryable statuses returned for one provider effect. */
export const SYNC_EFFECT_RESULT_STATUSES = {
  APPLIED: "applied",
  ALREADY_APPLIED: "already_applied",
  SUPERSEDED: "superseded",
  GUARD_MISMATCH: "guard_mismatch",
  REPAIR_REOBSERVE: "repair_reobserve",
  SCHEMA_ERROR: "schema_error",
  RETRYABLE_ERROR: "retryable_error",
} as const;

export type SyncEffectResultStatus =
  (typeof SYNC_EFFECT_RESULT_STATUSES)[keyof typeof SYNC_EFFECT_RESULT_STATUSES];

/** Result label returned when a fast-append row was accepted for writing. */
export const SYNC_FAST_APPEND_STATUSES = {
  APPLIED: "applied",
} as const;

export type SyncFastAppendStatus =
  (typeof SYNC_FAST_APPEND_STATUSES)[keyof typeof SYNC_FAST_APPEND_STATUSES];

/** How much remote read-back the provider performs before returning a write result. */
export const SYNC_POSTCONDITION_MODES = {
  /** Read changed rows after the write and verify their target hashes inline. */
  INLINE: "inline",
  /** Return after the batched write is flushed; recovery reads verify later. */
  DEFERRED: "deferred",
} as const;

export type SyncPostconditionMode =
  (typeof SYNC_POSTCONDITION_MODES)[keyof typeof SYNC_POSTCONDITION_MODES];

/** Evidence level attached to a successful provider write result. */
export const SYNC_POSTCONDITION_STATUSES = {
  VERIFIED: "verified",
  ACKNOWLEDGED: "acknowledged",
  UNAVAILABLE: "unavailable",
} as const;

export type SyncPostconditionStatus =
  (typeof SYNC_POSTCONDITION_STATUSES)[keyof typeof SYNC_POSTCONDITION_STATUSES];

/** Read-back classification after a lost response or expired lease. */
export const SYNC_POSTCONDITION_DISPOSITIONS = {
  APPLIED: "applied",
  UNAPPLIED: "unapplied",
  CHANGED: "changed",
  UNAVAILABLE: "unavailable",
} as const;

export type SyncPostconditionDisposition =
  (typeof SYNC_POSTCONDITION_DISPOSITIONS)[keyof typeof SYNC_POSTCONDITION_DISPOSITIONS];
