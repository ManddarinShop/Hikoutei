import { CoreErrorException } from "../../../../domain/errors/index.js";

/** Stable failure categories for the versioned Sheets gateway boundary. */
export const SYNC_SHEETS_GATEWAY_ERROR_CODES = {
  INVALID_REQUEST: "invalid_gateway_request",
  PROTOCOL_MISMATCH: "gateway_protocol_mismatch",
  UNAVAILABLE: "gateway_unavailable",
  LEASE_CONFLICT: "gateway_lease_conflict",
  LEASE_EXPIRED: "gateway_lease_expired",
  REQUEST_IN_FLIGHT: "gateway_request_in_flight",
} as const;

export type SyncSheetsGatewayErrorCode =
  (typeof SYNC_SHEETS_GATEWAY_ERROR_CODES)[keyof typeof SYNC_SHEETS_GATEWAY_ERROR_CODES];

/** Error raised when a worker cannot safely use the Sheets gateway. */
export class SyncSheetsGatewayError extends CoreErrorException<
  "runtime.sync_sheets_gateway",
  SyncSheetsGatewayErrorCode
> {
  constructor(code: SyncSheetsGatewayErrorCode, message: string) {
    super("runtime.sync_sheets_gateway", code, message);
  }
}
