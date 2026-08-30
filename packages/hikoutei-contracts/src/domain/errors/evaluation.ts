import { CoreErrorException } from "./types.js";

/** Stable error codes for evaluator contract violations. */
export const EVALUATION_ERROR_CODES = {
  CANONICAL_STATE_REQUIRED: "canonical_state_required",
  CANONICAL_FIELD_REQUIRED: "canonical_field_required",
  BASE_FIELD_REVISION_REQUIRED: "base_field_revision_required",
} as const;

export type EvaluationErrorCode =
  (typeof EVALUATION_ERROR_CODES)[keyof typeof EVALUATION_ERROR_CODES];

/** Raised when an internal evaluator contract cannot produce a valid result. */
export class EvaluationContractError extends CoreErrorException<
  "evaluation",
  EvaluationErrorCode
> {
  constructor(code: EvaluationErrorCode, message: string) {
    super("evaluation", code, message);
  }
}
