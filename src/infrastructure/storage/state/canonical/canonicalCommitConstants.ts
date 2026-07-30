/** Runtime tags used by the fenced canonical commit boundary. */

/** Runtime values returned by the canonical commit writer. */
export const CANONICAL_COMMIT_RESULT_KINDS = {
  APPLIED: "applied",
  STALE: "stale",
  FENCED_OUT: "fenced_out",
  INVALID: "invalid",
} as const;

/** Runtime values describing which canonical target became stale. */
export const CANONICAL_COMMIT_STALE_TARGETS = {
  ENTITY: "entity",
  FIELD: "field",
} as const;
