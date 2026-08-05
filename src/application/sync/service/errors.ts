import { CoreErrorException } from "../../../domain/errors/index.js";

/** Stable failures raised while assembling or running the internal sync service. */
export const SYNC_SERVICE_ERROR_CODES = {
  INVALID_OPTIONS: "invalid_sync_service_options",
  INVALID_PROJECTION_CONFIG: "invalid_sync_projection_config",
  PROVIDER_UNAVAILABLE: "sync_provider_unavailable",
  STARTUP_FAILED: "sync_service_startup_failed",
  CLOSED: "sync_service_closed",
} as const;

export type SyncServiceErrorCode =
  (typeof SYNC_SERVICE_ERROR_CODES)[keyof typeof SYNC_SERVICE_ERROR_CODES];

/** Internal service error; never re-exported from the root public API. */
export class SyncServiceError extends CoreErrorException<
  "application.sync_service",
  SyncServiceErrorCode
> {
  public constructor(code: SyncServiceErrorCode, message: string) {
    super("application.sync_service", code, message);
  }
}
