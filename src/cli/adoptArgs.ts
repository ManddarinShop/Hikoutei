/**
 * Pure command-line parsing for `hikoutei adopt`.
 *
 * This module owns flag syntax and defaults only; it never touches the
 * filesystem, imports user modules, or contacts Google Sheets. The result is
 * an explicit union so the CLI entry can branch on help / valid / invalid
 * without inspecting message text.
 *
 * Adoption (MVP, design `design/existing-sheet-adoption-design.md`): one
 * entity at a time; the adopted tab becomes that entity's User_Input route.
 * The entity definitions are the APPLICATION's — the CLI loads them from a
 * module (`--entities`) that registers them as an import side effect.
 */

import { setupFailure, type SetupFailure } from "./errors.js";

/** Machine-readable code shared with the setup taxonomy for argument errors. */
const SETUP_ERROR_CODES_INVALID_ARGS = "invalid_args" as const;

/** Parsed and defaulted adoption options handed to the adopt flow. */
export interface AdoptOptions {
  /** Entity name to adopt (must match a registered descriptor name). */
  readonly entityName: string;
  /** The existing spreadsheet tab that becomes the User_Input route. */
  readonly tabName: string;
  /** PK source: a sheet header, or `"auto"` (default). */
  readonly identityFrom: string | "auto";
  /** Fresh System_State tab name; default `<tab>_System`. */
  readonly systemTabName?: string;
  /** Fresh Sync_Conflicts tab name; default `<tab>_Conflicts`. */
  readonly conflictsTabName?: string;
  /** `dry-run` (default) analyzes read-only; `adopt` performs the migration. */
  readonly mode: "dry-run" | "adopt";
  /** SQLite database path (default `./hikoutei.sqlite`). */
  readonly db: string;
  /** Spreadsheet URL; falls back to `HIKOUTEI_SYNC_SPREADSHEET_URL`. */
  readonly spreadsheetUrl?: string;
  /** Service-account key file; falls back to `GOOGLE_APPLICATION_CREDENTIALS`. */
  readonly credentialsPath?: string;
  /** Module that registers the application entities on import. */
  readonly entitiesModule?: string;
  /** §12 columnMap: sheet header → property bindings (from repeated --map). */
  readonly columnMap?: Readonly<Record<string, string>>;
  /** Skip the interactive confirmation in adopt mode. */
  readonly yes: boolean;
  /** Emit machine-readable JSON instead of a human report. */
  readonly json: boolean;
}

/** Discriminated result of `parseAdoptArgs`. */
export type AdoptArgsParseResult =
  | { readonly status: "help"; readonly helpText: string }
  | { readonly status: "valid"; readonly options: AdoptOptions }
  | { readonly status: "invalid"; readonly failure: SetupFailure };

const ADOPT_FLAGS = {
  HELP: "--help",
  HELP_SHORT: "-h",
  ENTITY: "--entity",
  TAB: "--tab",
  IDENTITY_FROM: "--identity-from",
  SYSTEM_TAB: "--system-tab",
  CONFLICTS_TAB: "--conflicts-tab",
  MODE: "--mode",
  DB: "--db",
  SPREADSHEET_URL: "--spreadsheet-url",
  CREDENTIALS: "--credentials",
  ENTITIES: "--entities",
  MAP: "--map",
  YES: "--yes",
  JSON: "--json",
} as const;

const KNOWN_FLAGS = new Set<string>(Object.values(ADOPT_FLAGS));
const VALUE_FLAGS = new Set<string>([
  ADOPT_FLAGS.ENTITY, ADOPT_FLAGS.TAB, ADOPT_FLAGS.IDENTITY_FROM,
  ADOPT_FLAGS.SYSTEM_TAB, ADOPT_FLAGS.CONFLICTS_TAB, ADOPT_FLAGS.MODE,
  ADOPT_FLAGS.DB, ADOPT_FLAGS.SPREADSHEET_URL, ADOPT_FLAGS.CREDENTIALS,
  ADOPT_FLAGS.ENTITIES, ADOPT_FLAGS.MAP,
]);

export const ADOPT_HELP_TEXT = [
  "hikoutei adopt - migrate an EXISTING spreadsheet tab into a Hikoutei-managed entity.",
  "",
  "The tab keeps every existing cell untouched; it becomes the entity's",
  "User_Input surface (human edits keep working), a fresh SQLite state is",
  "seeded from the existing rows, and a new System_State tab is provisioned",
  "and backfilled automatically. MVP constraints: ONE entity per run, an",
  "empty local state for that entity, and the managed columns must form a",
  "contiguous block (ignored columns sit LEFT of it).",
  "",
  "Usage: hikoutei adopt --entity <Name> --tab <TabName> [options]",
  "",
  "Required:",
  "  --entity <Name>           Entity name (must match a registered descriptor).",
  "  --tab <TabName>           Existing tab to adopt (never modified in-place",
  "                            beyond appending the row-id system column).",
  "",
  "Options:",
  "  --mode <dry-run|adopt>    dry-run (default) analyzes read-only and prints",
  "                            the report; adopt performs the migration.",
  "  --entities <module>       Module that registers the application entities",
  "                            on import (compiled JS or a loader-supported",
  "                            extension). Required for adopt.",
  "  --identity-from <header|auto>  PK column header; \"auto\" (default) prefers",
  "                            the PK property's header and appends a generated",
  "                            PK column when absent.",
  "  --map \"Header=property\"  §12 columnMap binding for legacy headers; repeat",
  "                            the flag for each column (e.g. --map \"Invoice",
  "                            No=invoiceNo\" --map \"총액\"=total\"). Mapped PK",
  "                            headers absorb the identityFrom alias.",
  "  --system-tab <name>       Fresh System_State tab (default <tab>_System).",
  "  --conflicts-tab <name>    Fresh Sync_Conflicts tab (default <tab>_Conflicts).",
  "  --db <path>               SQLite path (default ./hikoutei.sqlite).",
  "  --spreadsheet-url <url>   Falls back to HIKOUTEI_SYNC_SPREADSHEET_URL.",
  "  --credentials <path>      SA key file; falls back to",
  "                            GOOGLE_APPLICATION_CREDENTIALS.",
  "  --yes                     Skip the interactive confirmation (adopt mode).",
  "  --json                    Machine-readable output.",
  "  -h, --help                Show this help.",
  "",
  "Exit codes: 0 success (a ready dry-run also exits 0), 1 failure (a blocked",
  "dry-run, a declined confirmation, or a runtime error), 2 argument errors.",
].join("\n");

/** Parses and defaults `hikoutei adopt` arguments. */
export function parseAdoptArgs(argv: readonly string[]): AdoptArgsParseResult {
  const values = new Map<string, string>();
  const mapEntries: [string, string][] = [];
  const flags = new Set<string>();
  let index = 0;
  while (index < argv.length) {
    const token = argv[index]!;
    if (token === ADOPT_FLAGS.HELP || token === ADOPT_FLAGS.HELP_SHORT) {
      return { status: "help", helpText: ADOPT_HELP_TEXT };
    }
    if (!KNOWN_FLAGS.has(token)) {
      return { status: "invalid", failure: setupFailure(SETUP_ERROR_CODES_INVALID_ARGS, `unknown flag "${token}"`) };
    }
    if (VALUE_FLAGS.has(token)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        return { status: "invalid", failure: setupFailure(SETUP_ERROR_CODES_INVALID_ARGS, `flag ${token} requires a value`) };
      }
      if (token === ADOPT_FLAGS.MAP) {
        // §12: --map is REPEATABLE — every occurrence adds one header →
        // property binding.
        const separator = value.indexOf("=");
        if (separator <= 0 || separator === value.length - 1) {
          return { status: "invalid", failure: setupFailure(SETUP_ERROR_CODES_INVALID_ARGS, `--map requires "Header=property", received "${value}"`) };
        }
        mapEntries.push([value.slice(0, separator), value.slice(separator + 1)]);
      } else {
        values.set(token, value);
      }
      index += 2;
      continue;
    }
    flags.add(token);
    index += 1;
  }
  const columnMap = mapEntries.length === 0
    ? undefined
    : Object.fromEntries(mapEntries);

  const missing = [ADOPT_FLAGS.ENTITY, ADOPT_FLAGS.TAB].filter((flag) => !values.has(flag));
  if (missing.length > 0) {
    return { status: "invalid", failure: setupFailure(SETUP_ERROR_CODES_INVALID_ARGS, `missing required flag(s): ${missing.join(", ")}`) };
  }

  const rawMode = values.get(ADOPT_FLAGS.MODE) ?? "dry-run";
  if (rawMode !== "dry-run" && rawMode !== "adopt") {
    return { status: "invalid", failure: setupFailure(SETUP_ERROR_CODES_INVALID_ARGS, `--mode must be "dry-run" or "adopt", received "${rawMode}"`) };
  }
  if (rawMode === "adopt" && !values.has(ADOPT_FLAGS.ENTITIES)) {
    return { status: "invalid", failure: setupFailure(SETUP_ERROR_CODES_INVALID_ARGS, "adopt mode requires --entities <module> (the entity definitions live in application code)") };
  }

  const identityFrom = values.get(ADOPT_FLAGS.IDENTITY_FROM) ?? "auto";
  if (identityFrom.trim() === "") {
    return { status: "invalid", failure: setupFailure(SETUP_ERROR_CODES_INVALID_ARGS, "--identity-from must be a header name or \"auto\"") };
  }

  const optional = (flag: string): string | undefined => {
    const value = values.get(flag);
    return value === undefined || value.trim() === "" ? undefined : value;
  };

  const spreadsheetUrl = optional(ADOPT_FLAGS.SPREADSHEET_URL);
  const credentialsPath = optional(ADOPT_FLAGS.CREDENTIALS);
  const entitiesModule = optional(ADOPT_FLAGS.ENTITIES);
  const systemTabName = optional(ADOPT_FLAGS.SYSTEM_TAB);
  const conflictsTabName = optional(ADOPT_FLAGS.CONFLICTS_TAB);

  return {
    status: "valid",
    options: {
      entityName: values.get(ADOPT_FLAGS.ENTITY)!,
      tabName: values.get(ADOPT_FLAGS.TAB)!,
      identityFrom,
      mode: rawMode,
      db: values.get(ADOPT_FLAGS.DB) ?? process.env.HIKOUTEI_DB_PATH ?? "./hikoutei.sqlite",
      ...(spreadsheetUrl === undefined ? {} : { spreadsheetUrl }),
      ...(credentialsPath === undefined ? {} : { credentialsPath }),
      ...(entitiesModule === undefined ? {} : { entitiesModule }),
      ...(columnMap === undefined ? {} : { columnMap }),
      ...(systemTabName === undefined ? {} : { systemTabName }),
      ...(conflictsTabName === undefined ? {} : { conflictsTabName }),
      yes: flags.has(ADOPT_FLAGS.YES),
      json: flags.has(ADOPT_FLAGS.JSON),
    },
  };
}
