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
