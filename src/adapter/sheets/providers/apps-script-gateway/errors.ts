import { CoreErrorException } from "../../../../domain/errors/index.js";
import { PRESENCE_KINDS } from "../../../../shared/state/index.js";
import type { Presence } from "../../../../shared/state/index.js";
import {
  SYNC_GATEWAY_ERROR_CODES,
  SyncGatewayContractError,
} from "../../../../application/sync/gateway/errors.js";

/** Stable error categories emitted by the signed gateway protocol. */
export const SYNC_GATEWAY_PROTOCOL_ERROR_CODES = {
  INVALID_OPERATION: "invalid_sync_gateway_operation",
  INVALID_SECRET: "invalid_sync_gateway_secret",
  INVALID_ISSUED_AT: "invalid_sync_gateway_issued_at",
  INVALID_EXPIRY: "invalid_sync_gateway_expiry",
  INVALID_SHEET_ID: "invalid_sync_gateway_sheet_id",
  INVALID_ACTOR_ID: "invalid_sync_gateway_actor_id",
  INVALID_KEY_ID: "invalid_sync_gateway_key_id",
  INVALID_REQUEST_ID: "invalid_sync_gateway_request_id",
  INVALID_CLIENT_OPTIONS: "invalid_sync_gateway_client_options",
  INVALID_OPERATION_SOURCE: "invalid_sync_gateway_operation_source",
  INVALID_JSON_VALUE: "invalid_sync_gateway_json_value",
  NON_FINITE_NUMBER: "non_finite_sync_gateway_number",
} as const;

export type SyncGatewayProtocolErrorCode =
  (typeof SYNC_GATEWAY_PROTOCOL_ERROR_CODES)[keyof typeof SYNC_GATEWAY_PROTOCOL_ERROR_CODES];

/** Structured error for invalid protocol inputs and payload values. */
export class SyncGatewayProtocolError extends CoreErrorException<
  "adapter.sync_gateway",
  SyncGatewayProtocolErrorCode
> {
  constructor(code: SyncGatewayProtocolErrorCode, message: string) {
    super("adapter.sync_gateway", code, message);
  }
}

/** Stable errors emitted by the Node-side Apps Script transport client. */
export const SYNC_GATEWAY_CLIENT_ERROR_CODES = {
  HTTP_ERROR: "sync_gateway_http_error",
  INVALID_RESPONSE: "invalid_sync_gateway_response",
  NETWORK_ERROR: "sync_gateway_network_error",
  INVALID_REDIRECT: "sync_gateway_invalid_redirect",
  REMOTE_ERROR: "sync_gateway_remote_error",
  TIMEOUT: "sync_gateway_timeout",
} as const;

export type SyncGatewayClientErrorCode =
  (typeof SYNC_GATEWAY_CLIENT_ERROR_CODES)[keyof typeof SYNC_GATEWAY_CLIENT_ERROR_CODES];

/** Structured transport error with explicit HTTP-status and remote-code presence. */
export class AppsScriptSyncGatewayError extends CoreErrorException<
  "adapter.sync_gateway",
  SyncGatewayClientErrorCode
> {
  readonly status: Presence<number>;
  readonly remoteCode: Presence<string>;

  constructor(
    code: SyncGatewayClientErrorCode,
    message: string,
    status: Presence<number>,
    remoteCode: Presence<string> = { kind: PRESENCE_KINDS.ABSENT },
  ) {
    super("adapter.sync_gateway", code, message);
    this.status = status;
    this.remoteCode = remoteCode;
  }
}

/** Throws the shared contract error used when an operation request is invalid. */
export function invalidOperationRequest(
  operationLabel: string,
  message: string,
): never {
  throw new SyncGatewayContractError(
    SYNC_GATEWAY_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
    `${operationLabel} request is invalid: ${message}`,
  );
}

/** Throws the shared contract error used when an operation response is invalid. */
export function invalidOperationResponse(
  operationLabel: string,
  message: string,
): never {
  throw new SyncGatewayContractError(
    SYNC_GATEWAY_ERROR_CODES.INVALID_GATEWAY_RESPONSE,
    `${operationLabel} response is invalid: ${message}`,
  );
}
