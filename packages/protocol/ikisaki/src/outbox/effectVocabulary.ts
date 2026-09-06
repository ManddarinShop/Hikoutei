/**
 * Protocol-owned persisted outbox vocabulary.
 *
 * The kernel owns the outbox table it writes (`sql/schema.ts`), so it owns
 * these value tables for decoding persisted rows and emitting lifecycle
 * transitions. They mirror the entity-owned canonical tables in
 * `@hikoutei/contracts` `domain/model/constants.ts` value-for-value (pinned
 * by `test/outbox-contract-drift.test.ts`) and must never be imported from
 * there: this module keeps the kernel free of entity imports (see the
 * protocol import-boundary gate). The worker routes dispatch buckets on the
 * opaque `dispatchClass` label, never on these values.
 *
 * Keep-criterion, per table: `target_kind` / `status` / `dispatch_class`
 * spellings are required by the outbox SQL CHECK constraints in
 * `sql/schema.ts`; `effect_kind` has NO CHECK — its table is pinned only by
 * the decode guard plus the drift test (`test/outbox-contract-drift.test.ts`).
 */

/** Runtime values for durable outbox effect operations (decode guard). */
export const OUTBOX_EFFECT_KINDS = {
  SYSTEM_PROJECTION: "system_projection",
  CANDIDATE_RECONCILE: "candidate_reconcile",
  SYSTEM_REPAIR: "system_repair",
  RESOLUTION_PROJECTION: "resolution_projection",
  RESOLUTION_DELETE: "resolution_delete",
  USER_INPUT_DELETE: "user_input_delete",
} as const;

/** Closed set of durable outbox effect operations. */
export type OutboxEffectKind =
  (typeof OUTBOX_EFFECT_KINDS)[keyof typeof OUTBOX_EFFECT_KINDS];

/** Runtime values for the target domain of one durable effect (decode guard). */
export const OUTBOX_EFFECT_TARGET_KINDS = {
  ENTITY: "entity",
  ROW_BINDING: "row_binding",
  PROJECTION_ROW: "projection_row",
  CONFLICT: "conflict",
} as const;

/** Closed set of durable effect targets. */
export type OutboxEffectTargetKind =
  (typeof OUTBOX_EFFECT_TARGET_KINDS)[keyof typeof OUTBOX_EFFECT_TARGET_KINDS];

/**
 * Runtime values for durable effect lifecycle status.
 *
 * The worker emits these values and the outbox SQL CHECK constraint in
 * `sql/schema.ts` requires them; the spellings are persisted and must never
 * change.
 */
export const OUTBOX_EFFECT_STATUSES = {
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
export type OutboxEffectStatus =
  (typeof OUTBOX_EFFECT_STATUSES)[keyof typeof OUTBOX_EFFECT_STATUSES];
