/**
 * Structured classification of a Gateway transport outcome.
 *
 * The Apps Script transport can fail for three very different reasons that the
 * effect worker must not treat the same way:
 *
 * - `success`: a decoded, valid envelope was returned.
 * - `explicit_remote_failure`: the remote returned a structured rejection that
 *   proves no operation ran (e.g. a signed-envelope validation failure). The
 *   remote state is known, so the effect can transition to a terminal failure
 *   state.
 * - `delivery_uncertain`: the transport gave no usable answer (timeout,
 *   network error, non-JSON/404 response, lost connection), or the Gateway
 *   failed during/after operation execution (`operation_failed`,
 *   `internal_error`). The remote may or may not have committed the write, so
 *   the effect must be recovered through a postcondition probe rather than
 *   immediately redriven. Per-effect guard/schema/identity rejections are not
 *   transport errors at all: they arrive as per-effect result statuses in a
 *   successful envelope and keep their existing terminal handling.
 *
 * This boundary lets future durable `delivery_uncertain` state and recovery
 * barriers classify a thrown transport error without re-deriving the rules at
 * every call site. It never weakens correctness: an uncertain outcome is never
 * promoted to `success`, and a proven pre-mutation rejection is never
 * reclassified as a retryable transport error.
 */

import { AppsScriptSyncGatewayError, SYNC_GATEWAY_CLIENT_ERROR_CODES } from "../../../adapter/sheets/providers/apps-script-gateway/errors.js";
import { GoogleSheetsApiTransportError, GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES } from "../../../adapter/sheets/providers/google-sheets-api/errors.js";
import { PRESENCE_KINDS } from "../../../shared/state/index.js";
import type { Presence } from "../../../shared/state/types.js";

export const TRANSPORT_OUTCOME_KINDS = {
  SUCCESS: "success",
  EXPLICIT_REMOTE_FAILURE: "explicit_remote_failure",
  DELIVERY_UNCERTAIN: "delivery_uncertain",
} as const;

export type TransportOutcomeKind =
  (typeof TRANSPORT_OUTCOME_KINDS)[keyof typeof TRANSPORT_OUTCOME_KINDS];

/** A classified transport outcome with redacted, safe diagnostics. */
export interface TransportOutcome {
  readonly kind: TransportOutcomeKind;
  readonly httpStatus: Presence<number>;
  /** Stable client/remote code without payload or secret material. */
  readonly code: Presence<string>;
  readonly message: string;
}

/**
 * Classifies a value thrown by the Gateway transport.
 *
 * `undefined`/`null` means no error was observed and is classified as success;
 * callers should normally pass a caught error. Any non-transport error is left
 * as `delivery_uncertain` rather than `success` because the caller cannot prove
 * the remote state either way.
 */
export function classifyTransportOutcome(error: unknown): TransportOutcome {
  if (error === undefined || error === null) {
    return {
      kind: TRANSPORT_OUTCOME_KINDS.SUCCESS,
      httpStatus: { kind: PRESENCE_KINDS.ABSENT },
      code: { kind: PRESENCE_KINDS.ABSENT },
      message: "",
    };
  }
  if (error instanceof AppsScriptSyncGatewayError) {
    const kind = isDeliveryUncertain(error)
      ? TRANSPORT_OUTCOME_KINDS.DELIVERY_UNCERTAIN
      : TRANSPORT_OUTCOME_KINDS.EXPLICIT_REMOTE_FAILURE;
    return {
      kind,
      httpStatus: error.status,
      code: error.remoteCode,
      message: error.message,
    };
  }
  if (error instanceof GoogleSheetsApiTransportError) {
    const kind = isGoogleSheetsApiDeliveryUncertain(error)
      ? TRANSPORT_OUTCOME_KINDS.DELIVERY_UNCERTAIN
      : TRANSPORT_OUTCOME_KINDS.EXPLICIT_REMOTE_FAILURE;
    return {
      kind,
      httpStatus: error.status,
      code: error.remoteCode,
      message: error.message,
    };
  }
  // Unknown transport/Node error: assume the remote state is unverifiable.
  return {
    kind: TRANSPORT_OUTCOME_KINDS.DELIVERY_UNCERTAIN,
    httpStatus: { kind: PRESENCE_KINDS.ABSENT },
    code: { kind: PRESENCE_KINDS.ABSENT },
    message: error instanceof Error ? error.message : "Unexpected transport failure",
  };
}

/** Returns true when the remote state cannot be proven either way. */
export function isDeliveryUncertainOutcome(outcome: TransportOutcome): boolean {
  return outcome.kind === TRANSPORT_OUTCOME_KINDS.DELIVERY_UNCERTAIN;
}

/** Stable remote codes emitted by Code.gs that prove the request never mutated the Sheet. */
const PRE_MUTATION_REMOTE_CODES = new Set([
  "method_not_allowed",
  "invalid_request",
  "invalid_json",
  "unsupported_protocol",
  "unsupported_operation",
  "invalid_envelope",
  "invalid_request_id",
  "invalid_time",
  "invalid_expiry",
  "gateway_not_configured",
  "sheet_not_allowlisted",
  "unknown_key",
  "invalid_payload",
  "body_hash_mismatch",
  "invalid_signature",
  "sheet_open_failed",
]);

/**
 * Remote codes the Gateway emits only after an operation may have partially
 * mutated the Sheet. `operation_failed` aborts the batch at the first throwing
 * operation (writes from earlier phases can already be durable), and
 * `internal_error` escapes the top-level handler after any number of phases.
 */
const AMBIGUOUS_MUTATION_REMOTE_CODES = new Set(["operation_failed", "internal_error"]);

/**
 * Returns true when the Apps Script transport error implies an ambiguous
 * delivery. Non-success HTTP responses are not proof that a mutating batch did
 * not begin: Apps Script/proxy failures can be emitted after a partial remote
 * write. Only a structured 2xx operation result can provide per-effect
 * rejection evidence to the worker.
 */
export function isDeliveryUncertain(error: AppsScriptSyncGatewayError): boolean {
  if (
    error.code === SYNC_GATEWAY_CLIENT_ERROR_CODES.TIMEOUT ||
    error.code === SYNC_GATEWAY_CLIENT_ERROR_CODES.NETWORK_ERROR ||
    error.code === SYNC_GATEWAY_CLIENT_ERROR_CODES.INVALID_RESPONSE ||
    error.code === SYNC_GATEWAY_CLIENT_ERROR_CODES.INVALID_REDIRECT
  ) {
    return true;
  }
  if (error.code === SYNC_GATEWAY_CLIENT_ERROR_CODES.REMOTE_ERROR) {
    // Batch-level failures emitted during or after operation execution can
    // follow a partial remote mutation, so they must be probed instead of
    // treated as terminal. Only codes the Gateway emits before any operation
    // runs are provably non-mutating and may fail the batch explicitly.
    if (error.remoteCode.kind === PRESENCE_KINDS.PRESENT) {
      if (AMBIGUOUS_MUTATION_REMOTE_CODES.has(error.remoteCode.value)) return true;
      if (PRE_MUTATION_REMOTE_CODES.has(error.remoteCode.value)) return false;
    }
    // An unrecognized structured failure cannot prove that no mutation began.
    return true;
  }
  if (error.status.kind !== PRESENCE_KINDS.PRESENT) return false;
  const status = error.status.value;
  return status === 404 || status === 408 || status === 429 || status >= 500;
}

/**
 * Returns true when the direct Sheets transport error implies an ambiguous
 * delivery.
 *
 * Google API non-2xx responses prove the batch did not execute only for the
 * pre-mutation rejection statuses below; timeouts, network failures, and
 * proxy-emitted 408/429/5xx responses can follow a committed write, and a
 * malformed 2xx reply cannot prove what was applied. Those are recovered
 * through the postcondition probe path, never closed as success.
 */
export function isGoogleSheetsApiDeliveryUncertain(
  error: GoogleSheetsApiTransportError,
): boolean {
  if (
    error.code === GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.TIMEOUT ||
    error.code === GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.NETWORK_ERROR ||
    error.code === GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.INVALID_RESPONSE
  ) {
    return true;
  }
  if (error.status.kind !== PRESENCE_KINDS.PRESENT) return true;
  const status = error.status.value;
  if (status === 400 || status === 401 || status === 403 || status === 404) {
    // The API rejected the request before executing any part of the batch.
    return false;
  }
  return true;
}
