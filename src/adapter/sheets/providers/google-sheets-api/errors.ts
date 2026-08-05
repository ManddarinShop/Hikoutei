/**
 * Structured errors for the direct Google Sheets API outbound provider.
 *
 * The transport converts gaxios/network failures into
 * `GoogleSheetsApiTransportError` with explicit HTTP-status and stable-code
 * presence so the shared `classifyTransportOutcome` boundary can decide
 * between a proven pre-mutation rejection and an ambiguous delivery without
 * reading raw SDK error objects.
 */

import { CoreErrorException } from "../../../../domain/errors/index.js";
import { PRESENCE_KINDS } from "../../../../shared/state/index.js";
import type { Presence } from "../../../../shared/state/index.js";
import {
  SYNC_GATEWAY_ERROR_CODES,
  SyncGatewayContractError,
} from "../../../../application/sync/gateway/errors.js";

/** Stable transport error categories emitted by the direct provider. */
export const GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES = {
  /** The request exceeded its timeout; the remote may still have committed. */
  TIMEOUT: "google_sheets_api_timeout",
  /** No usable HTTP response (DNS/socket/fetch failure). */
  NETWORK_ERROR: "google_sheets_api_network_error",
  /** The API returned a non-2xx HTTP status. */
  HTTP_ERROR: "google_sheets_api_http_error",
  /** A 2xx response whose structure cannot prove what was applied. */
  INVALID_RESPONSE: "google_sheets_api_invalid_response",
} as const;

export type GoogleSheetsApiTransportErrorCode =
  (typeof GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES)[keyof typeof GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES];

/**
 * Provider-neutral transport error with explicit status/code presence.
 *
 * `status` is the HTTP status when one was observed; `code` carries a stable
 * remote/network code (API error status such as INVALID_ARGUMENT, or a Node
 * error code such as ECONNRESET) — never a URL, credential, or payload.
 */
export class GoogleSheetsApiTransportError extends CoreErrorException<
  "adapter.google_sheets_api",
  GoogleSheetsApiTransportErrorCode
> {
  readonly status: Presence<number>;
  readonly remoteCode: Presence<string>;

  public constructor(
    code: GoogleSheetsApiTransportErrorCode,
    message: string,
    status: Presence<number>,
    remoteCode: Presence<string> = { kind: PRESENCE_KINDS.ABSENT },
  ) {
    super("adapter.google_sheets_api", code, message);
    this.status = status;
    this.remoteCode = remoteCode;
  }
}

/**
 * Throws the shared contract error for an invalid direct-provider request.
 *
 * Mirrors the Apps Script operation request boundary: invalid routes, effect
 * shapes, and provider options fail closed before any remote mutation.
 */
export function invalidProviderRequest(label: string, message: string): never {
  throw new SyncGatewayContractError(
    SYNC_GATEWAY_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
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
 */
export function invalidProviderState(message: string): never {
  throw new SyncGatewayContractError(
    SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
    `Google Sheets API provider: ${message}`,
  );
}
