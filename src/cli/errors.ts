/**
 * Structured error taxonomy for the `hikoutei setup` CLI.
 *
 * Every failure the setup flow can produce maps to a stable machine-readable
 * code plus a human message. Callers (the CLI entry, tests, and any wrapper)
 * branch on the code, never on message text. Codes are phase-level: all
 * project-phase failures share one code, all service-account failures share
 * another, and so on; the message carries the specific detail.
 */

export const SETUP_ERROR_CODES = {
  /** gcloud CLI is not installed or `gcloud --version` fails. */
  GCLOUD_MISSING: "gcloud_missing",
  /** No active gcloud account, or `gcloud auth list` fails. */
  GCLOUD_NOT_LOGGED_IN: "gcloud_not_logged_in",
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
  /** Spreadsheet creation through the Sheets API failed. */
  SHEET_CREATE_FAILED: "sheet_create_failed",
  /** Writing/updating the .env output file failed. */
  OUTPUT_WRITE_FAILED: "output_write_failed",
  /** Command-line arguments are malformed (unknown flag, missing value, ...). */
  INVALID_ARGS: "invalid_args",
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
