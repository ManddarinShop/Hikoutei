import { CoreErrorException } from "../../../domain/errors/index.js";

/** Stable failures raised while assembling or running the internal sync service. */
export const SYNC_SERVICE_ERROR_CODES = {
  INVALID_OPTIONS: "invalid_sync_service_options",
  INVALID_PROJECTION_CONFIG: "invalid_sync_projection_config",
  PROVIDER_UNAVAILABLE: "sync_provider_unavailable",
  STARTUP_FAILED: "sync_service_startup_failed",
  /** Existing-sheet adoption dry-run finished; the full report rides on the error. */
  ADOPTION_DRY_RUN_REPORT: "existing_sheet_adoption_dry_run_report",
  /**
   * Adoption seeding refused: observed cell kinds would be quarantined by the
   * first polling pass (e.g. a numeric sheet column bound to a string
   * property). Fail-closed BEFORE any SQLite state is written (design §11
   * finding; Terra-promoted follow-up).
   */
  ADOPTION_CELL_KIND_MISMATCH: "existing_sheet_adoption_cell_kind_mismatch",
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
