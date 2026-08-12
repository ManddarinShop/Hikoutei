/**
 * Pure command-line parsing for `hikoutei setup`.
 *
 * This module owns flag syntax and defaults only; it never touches gcloud,
 * the filesystem, or the network. The result is an explicit union so the CLI
 * entry can branch on help / valid / invalid without inspecting message text.
 */

import { isValidGcpProjectId, isValidServiceAccountName } from "./checkpoint.js";
import { SETUP_ERROR_CODES, setupFailure, type SetupFailure } from "./errors.js";

/** Default service-account name when `--sa-name` is not given. */
export const DEFAULT_SA_NAME = "hikoutei-sa";

/** Default output file name (resolved against the current directory by main). */
export const DEFAULT_OUTPUT_FILE_NAME = ".env";

/** Parsed and defaulted setup options handed to the setup flow. */
export interface SetupOptions {
  /** Existing Google Cloud project id; when absent the flow creates one. */
  readonly projectId?: string;
  /** Service-account name within the project. */
  readonly saName: string;
  /** Spreadsheet title; when absent the flow derives `hikoutei-sync-<project>`. */
  readonly spreadsheetTitle?: string;
  /** Output .env path (relative to the current directory). */
  readonly output: string;
  /** Skip interactive confirmation. */
  readonly yes: boolean;
  /** Print the planned command sequence without executing anything. */
  readonly dryRun: boolean;
}

/** Discriminated result of `parseSetupArgs`. */
export type SetupArgsParseResult =
  | { readonly status: "help"; readonly helpText: string }
  | { readonly status: "valid"; readonly options: SetupOptions }
  | { readonly status: "invalid"; readonly failure: SetupFailure };

const SETUP_FLAGS = {
  HELP: "--help",
  HELP_SHORT: "-h",
  PROJECT: "--project",
  SA_NAME: "--sa-name",
  SPREADSHEET_TITLE: "--spreadsheet-title",
  OUTPUT: "--output",
  YES: "--yes",
  DRY_RUN: "--dry-run",
} as const;

export const SETUP_HELP_TEXT = [
  "hikoutei setup - bootstrap a Google Cloud project, service account, key, and",
  "a human-owned spreadsheet for Hikoutei sync, then write a ready-to-use .env file.",
  "",
  "Prerequisites: the gcloud CLI is installed and `gcloud auth login",
  "--enable-gdrive-access` has been run once. Setup creates the spreadsheet as",
  "the logged-in user and shares it with the service account as a writer, so the",
  "active account must grant Drive access.",
  "",
  "Usage:",
  "  hikoutei setup [options]",
  "",
  "Options:",
  "  --project <id>             Use an existing Google Cloud project instead of",
  "                             creating one (verified with `gcloud projects",
  "                             describe`).",
  "  --sa-name <name>           Service-account name (default: hikoutei-sa).",
  "  --spreadsheet-title <title> Title of the spreadsheet to create (default:",
  "                             hikoutei-sync-<project>).",
  "  --output <path>            .env file to write or update (default: .env in",
  "                             the current directory).",
  "  --yes                      Skip interactive confirmation (non-interactive",
  "                             mode).",
  "  --dry-run                  Print the exact command sequence and",
  "                             simulated outcomes without executing anything",
  "                             (read-only local path-safety checks only;",
  "                             no subprocess, network, cloud, or file",
  "                             mutations; the gcloud key create shows the",
  "                             private staging placeholder",
  "                             <private-key-staging-dir>/key.json — never the",
  "                             final key path).",
  "  -h, --help                 Show this help and exit.",
  "",
  "Automatic setup runs on macOS and Linux. On Windows, non-dry-run setup",
  "is refused before any subprocess, network, cloud, lock, checkpoint, key,",
  "or file mutation (Windows cannot guarantee no-follow or owner-only ACL",
  "semantics); manual setup remains available.",
  "",
  "Interrupted runs resume from .hikoutei-setup-state.json in the current",
  "directory. A spreadsheet create whose outcome is unknown is reconciled by",
  "its creation marker on the next run; setup never creates a second",
  "spreadsheet. A create rejected up front (HTTP 400/403) with no matching",
  "file rolls the checkpoint back to key_ready so a corrected rerun starts a",
  "fresh marker. The service-account key is created under a write-ahead",
  "contract: the user-managed key list is recorded as a baseline before the",
  "single gcloud key create, and key_create_started/key_ready checkpoints",
  "let a crashed run recover a staged or installed key instead of creating a",
  "second one. Only the invocation that just persisted key_create_started",
  "may issue the one key create; resumed runs are reconcile-only and poll",
  "the key list plus staged/final evidence for up to two minutes (2, 4, 8,",
  "16, 30, 30, 30 s) before failing with key_create_uncertain — the create",
  "is never retried automatically. An unmatched user-managed key with no",
  "local credential is never deleted automatically: setup fails with",
  "key_create_uncertain and you inspect the key list in the Google Cloud",
  "console before rerunning (verified-absent states require removing the",
  "setup state file to reset the key checkpoint).",
  "Reused keys are enforced to owner-only mode 600.",
  "An exclusive lock directory (.hikoutei-setup-state.json.lock)",
  "prevents concurrent runs and is never removed automatically: a leftover",
  "lock directory (for example after a crash) requires manual removal only",
  "when you are certain no setup is running.",
  "Starting fresh requires removing or moving BOTH the checkpoint and the",
  "service-account key file (or passing --project <id> to recover an",
  "existing key); checkpointed or identity-matched cloud resources are",
  "reused, and setup never deletes cloud resources.",
  "",
].join("\n");

/** True when the flag is a value flag; used to accept `--flag value` and `--flag=value`. */
const VALUE_FLAGS = [
  SETUP_FLAGS.PROJECT,
  SETUP_FLAGS.SA_NAME,
  SETUP_FLAGS.SPREADSHEET_TITLE,
  SETUP_FLAGS.OUTPUT,
] as const;

/**
 * Parses raw argv (without node/script) into setup options.
 *
 * `--flag value` and `--flag=value` are both accepted. A leading `setup`
 * token is ignored so the npm bin works both as `hikoutei setup ...` and as
 * `node dist/cli/setup.js ...`. Unknown flags, missing values, boolean flags
 * given a value, and other positional arguments are rejected with
 * `invalid_args`. `--help` short-circuits with the help text.
 */
export function parseSetupArgs(argv: readonly string[]): SetupArgsParseResult {
  // `npx hikoutei setup ...` invokes the bin with `setup` as the first arg.
  const args = argv.length > 0 && argv[0] === "setup" ? argv.slice(1) : argv;
  let projectId: string | undefined;
  let saName = DEFAULT_SA_NAME;
  let spreadsheetTitle: string | undefined;
  let output = DEFAULT_OUTPUT_FILE_NAME;
  let yes = false;
  let dryRun = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string;

    if (arg === SETUP_FLAGS.HELP || arg === SETUP_FLAGS.HELP_SHORT) {
      return { status: "help", helpText: SETUP_HELP_TEXT };
    }
    if (arg === SETUP_FLAGS.YES) {
      yes = true;
      continue;
    }
    if (arg === SETUP_FLAGS.DRY_RUN) {
      dryRun = true;
      continue;
    }

    const equalsIndex = arg.indexOf("=");
    const flagName = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
    if ((VALUE_FLAGS as readonly string[]).includes(flagName)) {
      const value = equalsIndex === -1 ? args[index + 1] : arg.slice(equalsIndex + 1);
      if (value === undefined || value === "" || (equalsIndex === -1 && value.startsWith("-"))) {
        return {
          status: "invalid",
          failure: setupFailure(SETUP_ERROR_CODES.INVALID_ARGS, `${flagName} requires a value`),
        };
      }
      switch (flagName) {
        case SETUP_FLAGS.PROJECT:
          // Strict GCP project id format (the canonical shared guard): an
          // option-like or malformed value (for example `--project=--flag`)
          // is rejected BEFORE it can reach gcloud, an API, or a file.
          if (!isValidGcpProjectId(value)) {
            return {
              status: "invalid",
              failure: setupFailure(
                SETUP_ERROR_CODES.INVALID_ARGS,
                `invalid value for ${flagName}: GCP project ids must start with a lowercase ` +
                  `letter and contain only lowercase letters, digits, and hyphens (6-30 characters)`,
              ),
            };
          }
          projectId = value;
          break;
        case SETUP_FLAGS.SA_NAME:
          // Strict service-account name format (the canonical shared guard):
          // an option-like or malformed value (for example
          // `--sa-name=--flag`) is rejected before it can reach gcloud, an
          // API, or a file.
          if (!isValidServiceAccountName(value)) {
            return {
              status: "invalid",
              failure: setupFailure(
                SETUP_ERROR_CODES.INVALID_ARGS,
                `invalid value for ${flagName}: service-account names must start with a ` +
                  `lowercase letter and contain only lowercase letters, digits, and hyphens ` +
                  `(6-30 characters)`,
              ),
            };
          }
          saName = value;
          break;
        case SETUP_FLAGS.SPREADSHEET_TITLE:
          spreadsheetTitle = value;
          break;
        case SETUP_FLAGS.OUTPUT:
          output = value;
          break;
      }
      if (equalsIndex === -1) {
        index += 1;
      }
      continue;
    }
    if (arg.startsWith("-")) {
      return {
        status: "invalid",
        failure: setupFailure(SETUP_ERROR_CODES.INVALID_ARGS, `unknown flag: ${arg}`),
      };
    }
    return {
      status: "invalid",
      failure: setupFailure(SETUP_ERROR_CODES.INVALID_ARGS, `unexpected argument: ${arg}`),
    };
  }

  return {
    status: "valid",
    options: {
      ...(projectId !== undefined ? { projectId } : {}),
      ...(spreadsheetTitle !== undefined ? { spreadsheetTitle } : {}),
      saName,
      output,
      yes,
      dryRun,
    },
  };
}
