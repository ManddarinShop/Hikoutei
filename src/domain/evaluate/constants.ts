/** Runtime values for row evaluation outcomes. */
export const ROW_OUTCOMES = {
  ACCEPTED: "accepted",
  PARTIALLY_ACCEPTED: "partially_accepted",
  CONFLICT: "conflict",
  QUARANTINE: "quarantine",
} as const;

/** Closed set of row evaluation outcome values. */
export type RowOutcome = (typeof ROW_OUTCOMES)[keyof typeof ROW_OUTCOMES];

/** Prefix used for deterministic quarantine identifiers. */
export const QUARANTINE_ID_PREFIX = "q-" as const;

/** Identifier shape returned for a quarantined row. */
export type QuarantineId = `${typeof QUARANTINE_ID_PREFIX}${string}`;

/** Keys used to encode values that cannot be represented directly. */
export const QUARANTINE_FINGERPRINT_KEYS = {
  INVALID_NUMBER: "invalidNumber",
  INVALID_TYPE: "invalidType",
  INVALID_BIGINT: "invalidBigInt",
  INVALID_SYMBOL: "invalidSymbol",
  INVALID_FUNCTION: "invalidFunction",
  INVALID_OBJECT: "invalidObject",
} as const;

/** Closed set of invalid-value fingerprint keys. */
export type QuarantineFingerprintKey =
  (typeof QUARANTINE_FINGERPRINT_KEYS)[keyof typeof QUARANTINE_FINGERPRINT_KEYS];

/** Fixed marker values used inside invalid-value fingerprints. */
export const QUARANTINE_FINGERPRINT_MARKERS = {
  UNDEFINED: "undefined",
  ANONYMOUS_FUNCTION: "anonymous",
  CYCLE: "cycle",
  PLAIN_OBJECT_TAG: "[object Object]",
} as const;

/** Closed set of fixed quarantine fingerprint markers. */
export type QuarantineFingerprintMarker =
  (typeof QUARANTINE_FINGERPRINT_MARKERS)[keyof typeof QUARANTINE_FINGERPRINT_MARKERS];

/** Runtime values for the repair decision attached to a quarantined row. */
export const QUARANTINE_REPAIR_STATUSES = {
  NOT_PLANNED: "not_planned",
  PLANNED: "planned",
} as const;

/** Closed set of quarantine repair decision statuses. */
export type QuarantineRepairStatus =
  (typeof QUARANTINE_REPAIR_STATUSES)[keyof typeof QUARANTINE_REPAIR_STATUSES];

/** Reasons why a quarantined row has no repair plan. */
export const QUARANTINE_REPAIR_NOT_PLANNED_REASONS = {
  QUARANTINE_ONLY: "quarantine_only",
  CANONICAL_UNAVAILABLE: "canonical_unavailable",
} as const;

/** Closed set of reasons for an unplanned quarantine repair. */
export type QuarantineRepairNotPlannedReason =
  (typeof QUARANTINE_REPAIR_NOT_PLANNED_REASONS)[keyof typeof QUARANTINE_REPAIR_NOT_PLANNED_REASONS];

/** Internal outcomes from attempting to build a system-field repair plan. */
export const REPAIR_PLAN_BUILD_STATUSES = {
  UNAVAILABLE: "unavailable",
  PLANNED: QUARANTINE_REPAIR_STATUSES.PLANNED,
} as const;

/** Closed set of internal repair-plan build outcomes. */
export type RepairPlanBuildStatus =
  (typeof REPAIR_PLAN_BUILD_STATUSES)[keyof typeof REPAIR_PLAN_BUILD_STATUSES];
