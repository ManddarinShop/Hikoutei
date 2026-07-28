/** Runtime values shared by the observation receipt and append contracts. */

/** Runtime kinds returned when an observation occurrence is appended. */
export const OBSERVATION_APPEND_RESULT_KINDS = {
  NEW: "new",
  PENDING_REPLAY: "pending_replay",
  DUPLICATE: "duplicate",
  INTEGRITY_COLLISION: "integrity_collision",
} as const;

/** Closed set of observation append result kinds. */
export type ObservationAppendResultKind =
  (typeof OBSERVATION_APPEND_RESULT_KINDS)[keyof typeof OBSERVATION_APPEND_RESULT_KINDS];

/** Runtime states persisted for an observation receipt. */
export const OBSERVATION_RECEIPT_STATES = {
  PENDING: "pending",
  EVALUATED: "evaluated",
  DUPLICATE: "duplicate",
  QUARANTINED: "quarantined",
} as const;

/** Closed set of observation receipt states. */
export type ObservationReceiptState =
  (typeof OBSERVATION_RECEIPT_STATES)[keyof typeof OBSERVATION_RECEIPT_STATES];

/** Receipt states allowed when an observation is completed. */
export const OBSERVATION_COMPLETION_STATES = {
  EVALUATED: OBSERVATION_RECEIPT_STATES.EVALUATED,
  DUPLICATE: OBSERVATION_RECEIPT_STATES.DUPLICATE,
  QUARANTINED: OBSERVATION_RECEIPT_STATES.QUARANTINED,
} as const;

/** Closed set of terminal observation completion states. */
export type ObservationCompletionState =
  (typeof OBSERVATION_COMPLETION_STATES)[keyof typeof OBSERVATION_COMPLETION_STATES];

/** Runtime kinds returned after one observed row is persisted. */
export const OBSERVATION_WRITE_RESULT_KINDS = {
  FENCED_OUT: "fenced_out",
  STALE: "stale",
  DUPLICATE: "duplicate",
  QUARANTINED: "quarantined",
  PERSISTED: "persisted",
} as const;

/** Closed set of one-row observation write result kinds. */
export type ObservationWriteResultKind =
  (typeof OBSERVATION_WRITE_RESULT_KINDS)[keyof typeof OBSERVATION_WRITE_RESULT_KINDS];

/** Runtime reasons why one observation was identified as a duplicate. */
export const OBSERVATION_DUPLICATE_REASONS = {
  OBSERVATION: "observation",
  EVENT: "event",
  CANDIDATE: "candidate",
} as const;

/** Closed set of observation duplicate reasons. */
export type ObservationDuplicateReason =
  (typeof OBSERVATION_DUPLICATE_REASONS)[keyof typeof OBSERVATION_DUPLICATE_REASONS];

/** Runtime discriminators for receipt/event identity quarantine records. */
export const OBSERVATION_INTEGRITY_DISCRIMINATORS = {
  OBSERVATION_KEY_PAYLOAD_MISMATCH: "observation_key_payload_mismatch",
  EVENT_KEY_PAYLOAD_MISMATCH: "event_key_payload_mismatch",
} as const;

/** Closed set of identity mismatch quarantine discriminators. */
export type ObservationIntegrityDiscriminator =
  (typeof OBSERVATION_INTEGRITY_DISCRIMINATORS)[keyof typeof OBSERVATION_INTEGRITY_DISCRIMINATORS];
