import { CoreErrorException } from "../../../domain/errors/index.js";

/** Stable error categories emitted by the runtime sync provider contract. */
export const SYNC_SHEETS_ERROR_CODES = {
  INVALID_EFFECT_PAYLOAD: "invalid_sync_effect_payload",
  INVALID_PROVISIONING_DEFINITIONS: "invalid_sync_provisioning",
  INVALID_CLIENT_OPTIONS: "invalid_sync_client_options",
  INVALID_PROVIDER_RESPONSE: "invalid_sync_provider_response",
  INVALID_FAKE_PROVIDER_INPUT: "invalid_fake_sync_provider_input",
} as const;

export type SyncSheetsErrorCode =
  (typeof SYNC_SHEETS_ERROR_CODES)[keyof typeof SYNC_SHEETS_ERROR_CODES];

/** Error raised when a provider payload or provisioning contract is invalid. */
export class SyncSheetsContractError extends CoreErrorException<
  "runtime.sync_sheets",
  SyncSheetsErrorCode
> {
  constructor(code: SyncSheetsErrorCode, message: string) {
    super("runtime.sync_sheets", code, message);
  }
}
