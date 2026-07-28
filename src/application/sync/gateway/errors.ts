import { CoreErrorException } from "../../../domain/errors/index.js";

/** Stable error categories emitted by the runtime sync gateway contract. */
export const SYNC_GATEWAY_ERROR_CODES = {
  INVALID_EFFECT_PAYLOAD: "invalid_sync_effect_payload",
  INVALID_PROVISIONING_DEFINITIONS: "invalid_sync_gateway_provisioning",
  INVALID_CLIENT_OPTIONS: "invalid_sync_gateway_client_options",
  INVALID_GATEWAY_RESPONSE: "invalid_sync_gateway_response",
  INVALID_FAKE_GATEWAY_INPUT: "invalid_fake_sync_gateway_input",
} as const;

export type SyncGatewayErrorCode =
  (typeof SYNC_GATEWAY_ERROR_CODES)[keyof typeof SYNC_GATEWAY_ERROR_CODES];

/** Error raised when a gateway payload or provisioning contract is invalid. */
export class SyncGatewayContractError extends CoreErrorException<
  "runtime.sync_gateway",
  SyncGatewayErrorCode
> {
  constructor(code: SyncGatewayErrorCode, message: string) {
    super("runtime.sync_gateway", code, message);
  }
}
