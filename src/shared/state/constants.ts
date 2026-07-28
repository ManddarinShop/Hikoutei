/** Runtime tags for values that may be present or absent. */
export const PRESENCE_KINDS = {
  PRESENT: "present",
  ABSENT: "absent",
} as const;

/** Runtime tags for lookup results. */
export const LOOKUP_RESULT_KINDS = {
  FOUND: "found",
  NOT_FOUND: "not_found",
} as const;

/** Runtime tags for values that may apply to an operation. */
export const APPLICABILITY_KINDS = {
  APPLICABLE: "applicable",
  NOT_APPLICABLE: "not_applicable",
} as const;
