/**
 * Structured error taxonomy for the `hikoutei setup` CLI.
 *
 * Every failure the setup flow can produce maps to a stable machine-readable
 * code plus a human message. Callers (the CLI entry, tests, and any wrapper)
 * branch on the code, never on message text. Most codes are phase-level: all
 * project-phase failures share one code, all service-account failures share
 * another, and so on; the message carries the specific detail. The 16 path-safety
 * carrier codes (CHECKPOINT_TEMP_*, OUTPUT_*, SETUP_WRITE_NO_PROGRESS,
 * SETUP_DIR_FSYNC_*, SETUP_RENAME_DURABLE_*) are operation-level: 16 distinct
 * codes cover 15 recoverable path-safety throw sites (OUTPUT_SYMLINK_REFUSED
 * and OUTPUT_NOT_REGULAR_FILE are each reused at two sites) so the boundary
 * catch can preserve machine-readable specificity instead of collapsing to a
 * generic write code.
 */

export const SETUP_ERROR_CODES = {
  /** gcloud CLI is not installed or `gcloud --version` fails. */
  GCLOUD_MISSING: "gcloud_missing",
  /** No active gcloud account, or `gcloud auth list` fails. */
  GCLOUD_NOT_LOGGED_IN: "gcloud_not_logged_in",
  /** The active gcloud account lacks the Drive scope needed to create and own the spreadsheet. */
  GCLOUD_DRIVE_ACCESS_REQUIRED: "gcloud_drive_access_required",
  /** The interactive `gcloud auth login --enable-gdrive-access --force` handoff did not complete successfully. */
  GCLOUD_LOGIN_FAILED: "gcloud_login_failed",
  /** The user access token could not be retrieved or validated through tokeninfo. */
  USER_TOKEN_FAILED: "user_token_failed",
  /** `gcloud projects create` failed for a reason other than "already exists". */
  PROJECT_CREATE_FAILED: "project_create_failed",
  /** An explicitly requested `--project` could not be verified with `gcloud projects describe`. */
  PROJECT_NOT_FOUND: "project_not_found",
  /** `gcloud config set project` failed. */
  PROJECT_SELECT_FAILED: "project_select_failed",
  /** `gcloud services enable sheets.googleapis.com` failed. */
  API_ENABLE_FAILED: "api_enable_failed",
  /** Service-account listing or creation failed. */
  SA_CREATE_FAILED: "sa_create_failed",
  /** Service-account key creation or securing (chmod 600) failed. */
  KEY_CREATE_FAILED: "key_create_failed",
  /** The service-account key outcome is unknown: an unmatched user-managed key exists in the cloud, or no credential and no post-baseline key appeared within the bounded propagation window on a reconcile-only resume. No key is created on resume and nothing is deleted automatically; the user inspects the cloud keys and intentionally resets the key checkpoint to start fresh. */
  KEY_CREATE_UNCERTAIN: "key_create_uncertain",
  /** Automatic setup is not supported on this platform (Windows); manual setup remains available. */
  UNSUPPORTED_PLATFORM: "unsupported_platform",
  /** Spreadsheet creation through the Sheets API failed (the file demonstrably does not exist). */
  SHEET_CREATE_FAILED: "sheet_create_failed",
  /** The spreadsheet create outcome is unknown and could not be reconciled by its marker; no second create is attempted. */
  SHEET_CREATE_UNCERTAIN: "sheet_create_uncertain",
  /** Another setup run holds the exclusive setup lock (an existing lock directory is never removed automatically). */
  SETUP_IN_PROGRESS: "setup_in_progress",
  /** The exclusive setup lock directory could not be created (filesystem failure other than EEXIST). */
  SETUP_LOCK_FAILED: "setup_lock_failed",
  /** Sharing the spreadsheet with the service account (or verifying the share) failed. */
  SHEET_SHARE_FAILED: "sheet_share_failed",
  /** The service-account key could not access the shared spreadsheet after retries. */
  SA_ACCESS_VERIFY_FAILED: "sa_access_verify_failed",
  /** The local setup state file (.hikoutei-setup-state.json) is malformed or unreadable. */
  SETUP_STATE_INVALID: "setup_state_invalid",
  /** The local setup state conflicts with the current run (owner/options/key mismatch). */
  SETUP_STATE_CONFLICT: "setup_state_conflict",
  /** The local setup state file could not be written atomically. */
  SETUP_STATE_WRITE_FAILED: "setup_state_write_failed",
  /** Writing/updating the .env output file failed. */
  OUTPUT_WRITE_FAILED: "output_write_failed",
  /** Command-line arguments are malformed (unknown flag, missing value, ...). */
  INVALID_ARGS: "invalid_args",

  // -- Path safety carrier codes (Phase 6) --
  // Typed codes thrown by the 15 recoverable path-safety sites so the
  // boundary catch preserves machine-readable specificity instead of
  // collapsing everything to the generic OUTPUT_WRITE_FAILED / SETUP_STATE_WRITE_FAILED.

  /** A pre-existing temp entry blocks the exclusive checkpoint temp create. */
  CHECKPOINT_TEMP_EXISTS: "checkpoint_temp_exists",
  /** Owner-only mode verification failed on the checkpoint temp descriptor. */
  CHECKPOINT_TEMP_PERMISSION_VERIFY_FAILED: "checkpoint_temp_permission_verify_failed",
  /** The checkpoint temp path was swapped before the rename could proceed. */
  CHECKPOINT_TEMP_PATH_CHANGED: "checkpoint_temp_path_changed",
  /** A symlink was found (or appeared) at the output path. */
  OUTPUT_SYMLINK_REFUSED: "output_symlink_refused",
  /** The output path is not a regular file (directory, FIFO, device, ...). */
  OUTPUT_NOT_REGULAR_FILE: "output_not_regular_file",
  /** The output path aliases a reserved file (key, checkpoint, ...). */
  OUTPUT_ALIASES_RESERVED: "output_aliases_reserved",
  /** A conflicting entry appeared at the env temp path. */
  OUTPUT_TEMP_CONFLICT: "output_temp_conflict",
  /** Owner-only mode verification failed on the env temp descriptor. */
  OUTPUT_TEMP_PERMISSION_VERIFY_FAILED: "output_temp_permission_verify_failed",
  /** The env temp path was swapped before the rename could proceed. */
  OUTPUT_TEMP_PATH_CHANGED: "output_temp_path_changed",
  /** The write loop made no progress (zero or negative byte count). */
  SETUP_WRITE_NO_PROGRESS: "setup_write_no_progress",
  /** Could not open the containing directory for the durability fsync. */
  SETUP_DIR_FSYNC_OPEN_FAILED: "setup_dir_fsync_open_failed",
  /** The directory fsync after rename failed (rename durability uncertain). */
  SETUP_RENAME_DURABLE_FAILED: "setup_rename_durable_failed",
  /** Could not close the containing directory after the durability fsync. */
  SETUP_DIR_FSYNC_CLOSE_FAILED: "setup_dir_fsync_close_failed",

  // -- Output-path durability codes (#448 per-path qualification) --
  /** Opening the directory containing the .env output failed during durability sync. */
  OUTPUT_DIR_FSYNC_OPEN_FAILED: "output_dir_fsync_open_failed",
  /** fsync of the rename in the directory containing the .env output failed. */
  OUTPUT_RENAME_DURABLE_FAILED: "setup_output_rename_durable_failed",
  /** Directory fsync after the .env rename could not be finalized. */
  OUTPUT_DIR_FSYNC_CLOSE_FAILED: "output_dir_fsync_close_failed",
} as const;

/** Union of every machine-readable setup error code. */
export type SetupErrorCode = (typeof SETUP_ERROR_CODES)[keyof typeof SETUP_ERROR_CODES];

/** Exit code for usage/argument errors. */
export const SETUP_ARG_ERROR_EXIT_CODE = 2;

/** Exit code for runtime failures. */
export const SETUP_RUNTIME_ERROR_EXIT_CODE = 1;

/** A structured setup failure: stable code plus a human-readable message. */
export interface SetupFailure {
  readonly code: SetupErrorCode;
  readonly message: string;
}

/** Builds a structured failure value. */
export function setupFailure(code: SetupErrorCode, message: string): SetupFailure {
  return { code, message };
}

/**
 * Typed internal carrier thrown by the 15 recoverable path-safety sites.
 *
 * The nearest boundary catch extracts the code when present and falls back
 * to the existing generic code (OUTPUT_WRITE_FAILED / SETUP_STATE_WRITE_FAILED)
 * for non-carrier errors. Messages are byte-identical to the previous raw
 * Error throws.
 */
export class SetupPathSafetyError extends Error {
  readonly code: SetupErrorCode;
  constructor(code: SetupErrorCode, message: string) {
    super(message);
    this.name = "SetupPathSafetyError";
    this.code = code;
  }
}

/** Builds a typed path-safety carrier error. */
export function setupPathSafetyError(code: SetupErrorCode, message: string): SetupPathSafetyError {
  return new SetupPathSafetyError(code, message);
}

/**
 * Extracts the carrier code from a caught error when it is a
 * `SetupPathSafetyError`; returns `undefined` for non-carrier errors so
 * the boundary catch can fall back to the existing generic code.
 */
export function carrierCode(error: unknown): SetupErrorCode | undefined {
  return error instanceof SetupPathSafetyError ? error.code : undefined;
}
