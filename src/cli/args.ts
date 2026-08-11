/**
 * Pure command-line parsing for `hikoutei setup`.
 *
 * This module owns flag syntax and defaults only; it never touches gcloud,
 * the filesystem, or the network. The result is an explicit union so the CLI
 * entry can branch on help / valid / invalid without inspecting message text.
 */

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
  "spreadsheet for Hikoutei sync, then write a ready-to-use .env file.",
  "",
  "Prerequisites: the gcloud CLI is installed and `gcloud auth login` has been",
  "run once (an active account is required).",
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
  "  --dry-run                  Print the exact gcloud command sequence and",
  "                             simulated outcomes without executing anything.",
  "  -h, --help                 Show this help and exit.",
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
          projectId = value;
          break;
        case SETUP_FLAGS.SA_NAME:
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
