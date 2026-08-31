/**
 * Transport-boundary error the dispatcher raises for a failed remote call.
 *
 * The worker never inspects raw transport errors: the dispatcher classifies
 * them and throws this typed error so the worker can decide between the
 * terminal failure path (the remote proved the operation did not run) and
 * the postcondition probe path (the remote state is unknown).
 */

/** Stable classification of one failed remote dispatch. */
export const DISPATCH_TRANSPORT_OUTCOME_KINDS = {
  /**
   * The remote returned a structured rejection that proves no operation ran
   * (for example a pre-mutation 4xx validation failure). The effect can be
   * closed as failed without read-back.
   */
  EXPLICIT_REMOTE_FAILURE: "explicit_remote_failure",
  /**
   * The transport gave no usable answer (timeout, network error, lost
   * connection, malformed reply). The remote may or may not have committed
   * the write, so the worker must recover through a postcondition probe.
   */
  DELIVERY_UNCERTAIN: "delivery_uncertain",
} as const;

export type DispatchTransportOutcomeKind =
  (typeof DISPATCH_TRANSPORT_OUTCOME_KINDS)[keyof typeof DISPATCH_TRANSPORT_OUTCOME_KINDS];

/** A classified remote failure with redacted, safe diagnostics. */
export interface DispatchTransportOutcome {
  readonly kind: DispatchTransportOutcomeKind;
  readonly message: string;
}

/** Error thrown by a dispatcher after classifying a failed remote call. */
export class DispatchTransportError extends Error implements DispatchTransportOutcome {
  readonly kind: DispatchTransportOutcomeKind;

  constructor(kind: DispatchTransportOutcomeKind, message: string) {
    super(message);
    this.name = "DispatchTransportError";
    this.kind = kind;
  }
}

/** Returns whether a thrown value is a classified dispatcher transport error. */
export function isDispatchTransportError(error: unknown): error is DispatchTransportError {
  return error instanceof DispatchTransportError;
}

// ---------------------------------------------------------------------------
// Adaptive batch option validation
// ---------------------------------------------------------------------------

/** Stable error codes for adaptive batch option validation. */
export const ADAPTIVE_BATCH_ERROR_CODES = {
  POSITIVE_INTEGER_REQUIRED: "adaptive_positive_integer_required",
  NON_NEGATIVE_INTEGER_REQUIRED: "adaptive_non_negative_integer_required",
  LIMIT_ORDER_INVALID: "adaptive_limit_order_invalid",
} as const;

export type AdaptiveBatchErrorCode =
  (typeof ADAPTIVE_BATCH_ERROR_CODES)[keyof typeof ADAPTIVE_BATCH_ERROR_CODES];

const adaptiveBatchMessages: Record<AdaptiveBatchErrorCode, (label?: string) => string> = {
  [ADAPTIVE_BATCH_ERROR_CODES.POSITIVE_INTEGER_REQUIRED]: (label) =>
    `adaptive ${label} must be a positive safe integer`,
  [ADAPTIVE_BATCH_ERROR_CODES.NON_NEGATIVE_INTEGER_REQUIRED]: (label) =>
    `adaptive ${label} must be a non-negative safe integer`,
  [ADAPTIVE_BATCH_ERROR_CODES.LIMIT_ORDER_INVALID]: () =>
    "adaptive effect batch limits must satisfy minimum <= initial <= maximum",
};

/** Typed error for adaptive batch option validation failures. */
export class AdaptiveBatchOptionsError extends RangeError {
  readonly code: AdaptiveBatchErrorCode;

  constructor(code: AdaptiveBatchErrorCode, label?: string) {
    super(adaptiveBatchMessages[code](label));
    this.name = "AdaptiveBatchOptionsError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Supervisor option validation
// ---------------------------------------------------------------------------

/** Stable error codes for effect-worker supervisor option validation. */
export const SUPERVISOR_OPTIONS_ERROR_CODES = {
  WORKER_ID_REQUIRED: "sync_effect_supervisor_worker_id_required",
  POSITIVE_INTEGER_REQUIRED: "sync_effect_supervisor_positive_integer_required",
  NON_NEGATIVE_INTEGER_REQUIRED: "sync_effect_supervisor_non_negative_integer_required",
  BACKOFF_ORDER_INVALID: "sync_effect_supervisor_backoff_order_invalid",
} as const;

export type SupervisorOptionsErrorCode =
  (typeof SUPERVISOR_OPTIONS_ERROR_CODES)[keyof typeof SUPERVISOR_OPTIONS_ERROR_CODES];

const supervisorMessages: Record<SupervisorOptionsErrorCode, (label: string) => string> = {
  [SUPERVISOR_OPTIONS_ERROR_CODES.WORKER_ID_REQUIRED]: () =>
    "sync effect supervisor worker ID is required",
  [SUPERVISOR_OPTIONS_ERROR_CODES.POSITIVE_INTEGER_REQUIRED]: (label) =>
    `sync effect supervisor ${label} must be a positive safe integer`,
  [SUPERVISOR_OPTIONS_ERROR_CODES.NON_NEGATIVE_INTEGER_REQUIRED]: (label) =>
    `sync effect supervisor ${label} must be a non-negative safe integer`,
  [SUPERVISOR_OPTIONS_ERROR_CODES.BACKOFF_ORDER_INVALID]: () =>
    "sync effect supervisor maximum error backoff must be at least the initial backoff",
};

/** Typed error for supervisor option validation failures. */
export class SupervisionOptionsError extends RangeError {
  readonly code: SupervisorOptionsErrorCode;

  constructor(code: SupervisorOptionsErrorCode, label = "") {
    super(supervisorMessages[code](label));
    this.name = "SupervisionOptionsError";
    this.code = code;
  }
}
