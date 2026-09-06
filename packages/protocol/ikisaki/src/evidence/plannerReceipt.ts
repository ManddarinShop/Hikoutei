/**
 * Neutral receipt construction and result encoding for effect planning.
 *
 * The planner produces per-effect outcomes; these encoders translate them
 * into provider results with the same semantics the Sheets provider has
 * always returned (applied/already_applied carry receipt-backed evidence;
 * every other outcome carries a reason and no evidence), including the
 * deferred-mode postcondition relabeling. Providers map the neutral coded
 * results onto their own contract types at the boundary.
 */

/** Neutral receipt evidence produced by the planner for one effect. */
export interface PlannedReceiptEvidence {
  readonly effectId: string;
  readonly payloadHash: string;
  readonly status: "applied";
  readonly visibleHash: string;
  readonly visibleRevision: number;
}

/** Neutral terminal/non-terminal planner outcome for one effect. */
export type PlannedOutcomeEvidence =
  | {
    readonly kind: "applied";
    readonly effectId: string;
    readonly payloadHash: string;
    readonly receipt: PlannedReceiptEvidence;
    readonly created: boolean;
    readonly deletion: boolean;
  }
  | {
    readonly kind: "already_applied";
    readonly effectId: string;
    readonly payloadHash: string;
    readonly receipt: PlannedReceiptEvidence;
  }
  | {
    readonly kind: "guard_mismatch";
    readonly effectId: string;
    readonly payloadHash: string;
    readonly reason: string;
  }
  | {
    readonly kind: "repair_reobserve";
    readonly effectId: string;
    readonly payloadHash: string;
    readonly reason: string;
  }
  | {
    readonly kind: "schema_error";
    readonly effectId: string;
    readonly payloadHash: string;
    readonly reason: string;
  }
  | {
    readonly kind: "retryable_error";
    readonly effectId: string;
    readonly payloadHash: string;
    readonly reason: string;
  };

/** Neutral provider result coded from one planned outcome. */
export interface CodedEffectResult {
  readonly effectId: string;
  readonly payloadHash: string;
  readonly status:
    | "applied"
    | "already_applied"
    | "guard_mismatch"
    | "repair_reobserve"
    | "schema_error"
    | "retryable_error";
  /** Receipt-backed evidence; present only on applied/already_applied. */
  readonly visibleRevision: number | undefined;
  readonly visibleHash: string | undefined;
  /** Failure reason; present only on non-applied outcomes. */
  readonly reason: string | undefined;
  /**
   * Evidence level: `verified` after an inline read-back, `acknowledged`
   * after a deferred write, `unavailable` when no evidence exists.
   */
  readonly postcondition: "verified" | "acknowledged" | "unavailable";
}

/** Builds a receipt record for one applied effect. */
export function makeReceiptEvidence(
  effectId: string,
  payloadHash: string,
  visibleHash: string,
  visibleRevision: number,
): PlannedReceiptEvidence {
  return {
    effectId,
    payloadHash,
    status: "applied",
    visibleHash,
    visibleRevision,
  };
}

/** Encodes a planned outcome as a neutral provider result. */
export function encodeOutcomeResultEvidence(
  outcome: PlannedOutcomeEvidence,
): CodedEffectResult {
  switch (outcome.kind) {
    case "applied":
    case "already_applied":
      return {
        effectId: outcome.effectId,
        payloadHash: outcome.payloadHash,
        status: outcome.kind,
        visibleRevision: outcome.receipt.visibleRevision,
        visibleHash: outcome.receipt.visibleHash,
        reason: undefined,
        postcondition: "verified",
      };
    case "guard_mismatch":
    case "repair_reobserve":
    case "schema_error":
    case "retryable_error":
      return {
        effectId: outcome.effectId,
        payloadHash: outcome.payloadHash,
        status: outcome.kind,
        visibleRevision: undefined,
        visibleHash: undefined,
        reason: outcome.reason,
        postcondition: "unavailable",
      };
  }
}

/** Builds a schema_error result without any receipt-backed evidence. */
export function encodeSchemaErrorResultEvidence(
  effectId: string,
  payloadHash: string,
  reason: string,
): CodedEffectResult {
  return {
    effectId,
    payloadHash,
    status: "schema_error",
    visibleRevision: undefined,
    visibleHash: undefined,
    reason,
    postcondition: "unavailable",
  };
}

/** Applies the deferred-mode postcondition relabeling for applied results. */
export function withDeferredPostconditionEvidence(
  result: CodedEffectResult,
): CodedEffectResult {
  if (
    (result.status === "applied" || result.status === "already_applied") &&
    result.postcondition === "verified"
  ) {
    return { ...result, postcondition: "acknowledged" };
  }
  return result;
}
