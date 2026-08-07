/**
 * Durable effect operation, target, and lifecycle tags.
 *
 * The effect payload itself stays opaque to the queue; only the operation
 * kind, target route, and lifecycle status participate in queue mechanics.
 * These runtime values and their string spellings are persisted and must
 * never change.
 */

/** Runtime values for durable outbox effect operations. */
export const EFFECT_KINDS = {
  SYSTEM_PROJECTION: "system_projection",
  CANDIDATE_RECONCILE: "candidate_reconcile",
  SYSTEM_REPAIR: "system_repair",
  RESOLUTION_PROJECTION: "resolution_projection",
  RESOLUTION_DELETE: "resolution_delete",
  USER_INPUT_DELETE: "user_input_delete",
} as const;

/** Closed set of durable outbox effect operations. */
export type EffectKind = (typeof EFFECT_KINDS)[keyof typeof EFFECT_KINDS];

/** Runtime values for the target domain of one durable effect. */
export const EFFECT_TARGET_KINDS = {
  ENTITY: "entity",
  ROW_BINDING: "row_binding",
  PROJECTION_ROW: "projection_row",
  CONFLICT: "conflict",
} as const;

/** Closed set of durable effect targets. */
export type EffectTargetKind =
  (typeof EFFECT_TARGET_KINDS)[keyof typeof EFFECT_TARGET_KINDS];

/** Runtime values for durable effect lifecycle status. */
export const EFFECT_STATUSES = {
  PENDING: "pending",
  PROCESSING: "processing",
  DELIVERY_UNCERTAIN: "delivery_uncertain",
  APPLIED: "applied",
  BLOCKED_CANDIDATE: "blocked_candidate",
  SUPERSEDED: "superseded",
  CONFLICT: "conflict",
  FAILED: "failed",
} as const;

/** Closed set of durable effect lifecycle status values. */
export type EffectStatus = (typeof EFFECT_STATUSES)[keyof typeof EFFECT_STATUSES];
