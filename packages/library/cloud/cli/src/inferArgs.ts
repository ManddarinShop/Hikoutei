/**
 * Pure command-line parsing for `hikoutei infer`.
 *
 * This module owns flag syntax and defaults only; it never touches the
 * filesystem, imports user modules, or contacts Google Sheets. The result is
 * an explicit union so the CLI entry can branch on help / valid / invalid
 * without inspecting message text.
 *
 * Infer (spike): read-only sampling of an existing spreadsheet tab to print
 * a copy-pasteable `defineTypedSheetsEntity(...)` block. The flow never
 * writes to the spreadsheet or provisions anything.
 */

import { setupFailure, type SetupFailure } from "./errors.js";

/** Machine-readable code shared with the setup taxonomy for argument errors. */
const SETUP_ERROR_CODES_INVALID_ARGS = "invalid_args" as const;

/** Default number of data rows sampled from the tab (header excluded). */
export const INFER_DEFAULT_LIMIT = 100;

/** Hard cap on sampled data rows so one run cannot page a whole spreadsheet. */
export const INFER_MAX_LIMIT = 1000;

/** Parsed and defaulted infer options handed to the infer flow. */
export interface InferOptions {
  /** Spreadsheet URL; falls back to `HIKOUTEI_SYNC_SPREADSHEET_URL`. */
  readonly spreadsheetUrl?: string;
  /** Existing tab to sample (required). */
  readonly tabName: string;
  /** PK header override; defaults to the first column. */
  readonly pkHeader?: string;
  /** Data rows sampled below the header row (1..1000, default 100). */
  readonly limit: number;
  /** Service-account key file; falls back to `GOOGLE_APPLICATION_CREDENTIALS`. */
  readonly credentialsPath?: string;
  /**
   * Descriptor-file path written after the block is printed (`--emit`).
   * The file carries the versioned JSON form of the same inference, so a
   * later `createTypedSheets({ descriptors })` / `adopt --descriptor`
   * reuses it without manual `--map` flags.
   */
  readonly emitPath?: string;
  /** Overwrite the `--emit` target when it already exists (`--force`). */
  readonly force: boolean;
}

/** Discriminated result of `parseInferArgs`. */
export type InferArgsParseResult =
  | { readonly status: "help"; readonly helpText: string }
  | { readonly status: "valid"; readonly options: InferOptions }
  | { readonly status: "invalid"; readonly failure: SetupFailure };

const INFER_FLAGS = {
  HELP: "--help",
  HELP_SHORT: "-h",
  SPREADSHEET: "--spreadsheet",
  TAB: "--tab",
  PK: "--pk",
  LIMIT: "--limit",
  CREDENTIALS: "--credentials",
  EMIT: "--emit",
  FORCE: "--force",
} as const;

const KNOWN_FLAGS = new Set<string>(Object.values(INFER_FLAGS));
const VALUE_FLAGS = new Set<string>([
  INFER_FLAGS.SPREADSHEET, INFER_FLAGS.TAB, INFER_FLAGS.PK,
  INFER_FLAGS.LIMIT, INFER_FLAGS.CREDENTIALS, INFER_FLAGS.EMIT,
]);

export const INFER_HELP_TEXT = [
  "hikoutei infer - sample an existing spreadsheet tab and print a",
  "copy-pasteable defineTypedSheetsEntity(...) block. Read-only: the",
  "spreadsheet is never written or provisioned.",
  "",
  "Usage: hikoutei infer --tab <TabName> [options]",
  "",
  "Required:",
  "  --tab <TabName>           Existing tab to sample.",
  "",
  "Options:",
  "  --spreadsheet <url>       Falls back to HIKOUTEI_SYNC_SPREADSHEET_URL.",
  "  --pk <header>             PK column header (default: the first column).",
  "  --limit <n>               Data rows sampled below the header",
  "                            (default 100, max 1000).",
  "  --credentials <path>      SA key file; falls back to",
  "                            GOOGLE_APPLICATION_CREDENTIALS.",
  "  --emit <path>             Write the versioned descriptor JSON file",
  "                            after printing the block (parent dirs must",
  "                            exist; refuses to overwrite unless --force).",
  "  --force                   Overwrite the --emit target when it exists.",
  "  -h, --help                Show this help.",
  "",
  "Exit codes: 0 success, 1 runtime failure (tab not found, empty tab,",
  "missing credentials), 2 argument errors.",
].join("\n");

/** Parses and defaults `hikoutei infer` arguments. */
export function parseInferArgs(argv: readonly string[]): InferArgsParseResult {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  let index = 0;
  while (index < argv.length) {
    const token = argv[index]!;
    if (token === INFER_FLAGS.HELP || token === INFER_FLAGS.HELP_SHORT) {
      return { status: "help", helpText: INFER_HELP_TEXT };
    }
    if (!KNOWN_FLAGS.has(token)) {
      return { status: "invalid", failure: setupFailure(SETUP_ERROR_CODES_INVALID_ARGS, `unknown flag "${token}"`) };
    }
    if (VALUE_FLAGS.has(token)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        return { status: "invalid", failure: setupFailure(SETUP_ERROR_CODES_INVALID_ARGS, `flag ${token} requires a value`) };
      }
      values.set(token, value);
      index += 2;
      continue;
    }
    flags.add(token);
    index += 1;
  }

  const tabName = values.get(INFER_FLAGS.TAB);
  if (tabName === undefined || tabName.trim() === "") {
    return { status: "invalid", failure: setupFailure(SETUP_ERROR_CODES_INVALID_ARGS, "missing required flag(s): --tab") };
  }

  const rawLimit = values.get(INFER_FLAGS.LIMIT) ?? String(INFER_DEFAULT_LIMIT);
  const limit = Number(rawLimit);
  if (!/^\d+$/.test(rawLimit) || !Number.isSafeInteger(limit) || limit < 1 || limit > INFER_MAX_LIMIT) {
    return {
      status: "invalid",
      failure: setupFailure(
        SETUP_ERROR_CODES_INVALID_ARGS,
        `--limit must be an integer between 1 and ${INFER_MAX_LIMIT}, received "${rawLimit}"`,
      ),
    };
  }

  const optional = (flag: string): string | undefined => {
    const value = values.get(flag);
    return value === undefined || value.trim() === "" ? undefined : value;
  };

  const spreadsheetUrl = optional(INFER_FLAGS.SPREADSHEET);
  const pkHeader = optional(INFER_FLAGS.PK);
  const credentialsPath = optional(INFER_FLAGS.CREDENTIALS);
  const rawEmit = values.get(INFER_FLAGS.EMIT);
  if (rawEmit !== undefined && rawEmit.trim() === "") {
    return { status: "invalid", failure: setupFailure(SETUP_ERROR_CODES_INVALID_ARGS, "flag --emit requires a non-empty path") };
  }

  return {
    status: "valid",
    options: {
      tabName,
      limit,
      force: flags.has(INFER_FLAGS.FORCE),
      ...(spreadsheetUrl === undefined ? {} : { spreadsheetUrl }),
      ...(pkHeader === undefined ? {} : { pkHeader }),
      ...(credentialsPath === undefined ? {} : { credentialsPath }),
      ...(rawEmit === undefined ? {} : { emitPath: rawEmit }),
    },
  };
}
