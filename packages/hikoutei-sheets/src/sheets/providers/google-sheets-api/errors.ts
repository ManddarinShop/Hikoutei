/**
 * Structured errors for the direct Google Sheets API outbound provider.
 *
 * The transport converts gaxios/network failures into
 * `GoogleSheetsApiTransportError` with explicit HTTP-status and stable-code
 * presence so the shared `classifyTransportOutcome` boundary can decide
 * between a proven pre-mutation rejection and an ambiguous delivery without
 * reading raw SDK error objects.
 */

import {
  DEFAULT_INVALID_PROVIDER_CLASSIFICATION,
  SYNC_INVALID_PROVIDER_OPERATIONS,
  SYNC_INVALID_PROVIDER_REASONS,
  SYNC_SHEETS_ERROR_CODES,
  SyncSheetsContractError,
  type SyncInvalidProviderClassification,
} from "@hikoutei/contracts/sheets/errors.js";
import { logHikouteiInternalEvent } from "@hikoutei-app-src/shared/observability/internalLog.js";
import {
  HIKOUTEI_LOG_COMPONENTS,
  HIKOUTEI_LOG_EVENTS,
} from "@hikoutei-app-src/shared/observability/logEvents.js";

// P8-B: the transport error contract moved to the contracts leaf (the shared
// `classifyTransportOutcome` boundary needs the class identity). The adapter
// module re-exports it so existing adapter-internal and public import paths
// stay valid.
export {
  GoogleSheetsApiTransportError,
  GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES,
} from "@hikoutei/contracts/sheets/transportError.js";
export type { GoogleSheetsApiTransportErrorCode } from "@hikoutei/contracts/sheets/transportError.js";

/**
 * Classification shared by every `spreadsheets.get` validation guard: a raw
 * get reply whose shape, cell value, or cell format fails closed is a
 * `get_reply` / `malformed_reply` invalid provider state. All model parsers
 * that promote `spreadsheets.get` payloads (`preflightParsing`,
 * `valueNormalization`, `preflightRows`, `observation`, and the `readRows`
 * read operations) route their raw GET guards through this constant so the
 * emitted redacted event always carries the stable pair instead of
 * collapsing to `unclassified`. The message (which may echo a payload
 * fragment, id, or URL) is never logged.
 */
export const GET_REPLY_MALFORMED: SyncInvalidProviderClassification = {
  operation: SYNC_INVALID_PROVIDER_OPERATIONS.GET_REPLY,
  reason: SYNC_INVALID_PROVIDER_REASONS.MALFORMED_REPLY,
};

/**
 * Throws the shared contract error for an invalid direct-provider request.
 *
 * Mirrors the Apps Script operation request boundary: invalid routes, effect
 * shapes, and provider options fail closed before any remote mutation.
 */
export function invalidProviderRequest(label: string, message: string): never {
  throw new SyncSheetsContractError(
    SYNC_SHEETS_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
    `${label} request is invalid: ${message}`,
  );
}

/**
 * Throws the shared contract error for an invalid remote Sheet/API state.
 *
 * Malformed SDK payloads, header drift, duplicate anchors/identities, and
 * receipt-schema drift are remote-state problems, not transport problems.
 * They surface to the worker as delivery-uncertain (the same way a throwing
 * Apps Script operation does) so the effect is probed rather than failed on
 * unverified evidence.
 *
 * `classification` carries the allowlisted provider operation/reason so the
 * redacted `hikoutei.transport.response_invalid` event (and the thrown error)
 * expose a stable safe category. Call sites that detect a proven fixture
 * branch pass a specific classification; everything else keeps the default
 * `unclassified` category. The message is never logged and never reaches
 * telemetry (it can echo remote payload fragments, ids, or URLs).
 */
export function invalidProviderState(
  message: string,
  classification: SyncInvalidProviderClassification = DEFAULT_INVALID_PROVIDER_CLASSIFICATION,
): never {
  // Boundary record for an invalid remote state: only the stable code and the
  // allowlisted operation/reason are logged, never the message (it can echo
  // remote payload fragments, ids, or URLs).
  logHikouteiInternalEvent({
    event: HIKOUTEI_LOG_EVENTS.TRANSPORT_RESPONSE_INVALID,
    level: "warn",
    component: HIKOUTEI_LOG_COMPONENTS.TRANSPORT,
    code: SYNC_SHEETS_ERROR_CODES.INVALID_PROVIDER_RESPONSE,
    errorClass: "SyncSheetsContractError",
    retryable: true,
    providerOperation: classification.operation,
    providerReason: classification.reason,
  });
  throw new SyncSheetsContractError(
    SYNC_SHEETS_ERROR_CODES.INVALID_PROVIDER_RESPONSE,
    `Google Sheets API provider: ${message}`,
    classification,
  );
}
