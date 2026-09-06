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

/** One entity's spec parsed from a single repeatable `--adopt` flag. */
export interface AdoptCliEntitySpec {
  /** Entity name to adopt (must match a registered descriptor name). */
  readonly entityName: string;
  /** The existing spreadsheet tab that becomes the User_Input route. */
  readonly tabName: string;
  /** §12 columnMap: sheet header → property bindings (from inline `;Header=prop` pairs). */
  readonly columnMap?: Readonly<Record<string, string>>;
}

/** Parsed and defaulted adoption options handed to the adopt flow. */
export interface AdoptOptions {
  /**
   * Multi-entity adoption from repeated `--adopt` flags (mutually exclusive
   * with the legacy single `--entity`/`--tab` path). When present, the legacy
   * `entityName`/`tabName`/`columnMap` fields are absent.
   */
  readonly adopts?: readonly AdoptCliEntitySpec[];
  /** Entity name to adopt (legacy single-entity path; absent with `--adopt`). */
  readonly entityName?: string;
  /** The existing spreadsheet tab that becomes the User_Input route. */
  readonly tabName?: string;
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
  ADOPT: "--adopt",
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
  ADOPT_FLAGS.ADOPT, ADOPT_FLAGS.ENTITY, ADOPT_FLAGS.TAB,
  ADOPT_FLAGS.IDENTITY_FROM, ADOPT_FLAGS.SYSTEM_TAB,
  ADOPT_FLAGS.CONFLICTS_TAB, ADOPT_FLAGS.MODE, ADOPT_FLAGS.DB,
  ADOPT_FLAGS.SPREADSHEET_URL, ADOPT_FLAGS.CREDENTIALS,
  ADOPT_FLAGS.ENTITIES, ADOPT_FLAGS.MAP,
]);

export const ADOPT_HELP_TEXT = [
  "hikoutei adopt - migrate an EXISTING spreadsheet tab into a Hikoutei-managed entity.",
  "",
  "The tab keeps every existing cell untouched; it becomes the entity's",
  "User_Input surface (human edits keep working), a fresh SQLite state is",
  "seeded from the existing rows, and a new System_State tab is provisioned",
  "and backfilled automatically. Constraints: each adopted entity starts",
  "from an empty local state, and the managed columns must form a",
  "contiguous block (ignored columns sit LEFT of it).",
  "",
  "Usage: hikoutei adopt --entity <Name> --tab <TabName> [options]",
  "",
  "Required:",
  "  --entity <Name>           Entity name (must match a registered descriptor).",
  "  --tab <TabName>           Existing tab to adopt (never modified in-place",
  "                            beyond appending the row-id system column).",
  "",
  "Multi-entity (repeat --adopt once per entity; mutually exclusive with",
  "--entity/--tab):",
  "  --adopt \"Entity=Tab[;Header=property;...]\"",
  "                            Adopt one entity from an existing tab. The",
  "                            columnMap rides inline as `;Header=property`",
  "                            pairs (e.g. --adopt \"Invoices=Invoices;Invoice",
  "                            No=invoiceNo\" --adopt \"Customers=Customers\").",
  "                            With EXACTLY ONE --adopt entry the legacy",
  "                            per-run flags (--identity-from/--system-tab/",
  "                            --conflicts-tab/--map) apply to it; with several",
  "                            they are rejected and the columnMap must be",
  "                            encoded inline.",
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
  const adoptEntries: AdoptCliEntitySpec[] = [];
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
      } else if (token === ADOPT_FLAGS.ADOPT) {
        // --adopt is REPEATABLE: one entity per occurrence. The value is
        // "<Entity>=<Tab>[;Header=property;...]", so the columnMap rides
        // inline rather than via the separate legacy --map flag.
        const entry = parseAdoptValue(value);
        if (entry === undefined) {
          return { status: "invalid", failure: setupFailure(SETUP_ERROR_CODES_INVALID_ARGS, `--adopt requires "<Entity>=<Tab>[;Header=property;...]", received "${value}"`) };
        }
        adoptEntries.push(entry);
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

  // The `--adopt` path is mutually exclusive with the legacy single-entity
  // `--entity`/`--tab` flags: mixing two adoption styles is an argument error.
  const multi = adoptEntries.length > 0;
  if (multi && (values.has(ADOPT_FLAGS.ENTITY) || values.has(ADOPT_FLAGS.TAB))) {
    return { status: "invalid", failure: setupFailure(SETUP_ERROR_CODES_INVALID_ARGS, "mixing --adopt with --entity/--tab is not supported — use one adoption style only") };
  }
  // Legacy per-run flags only make sense for a SINGLE entity. With multiple
  // --adopt entries they cannot be scoped, so reject them and require the
  // columnMap to be encoded inline (which --adopt already supports).
  if (multi && adoptEntries.length > 1) {
    const legacyPerRun = values.has(ADOPT_FLAGS.IDENTITY_FROM)
      || values.has(ADOPT_FLAGS.SYSTEM_TAB)
      || values.has(ADOPT_FLAGS.CONFLICTS_TAB)
      || mapEntries.length > 0;
    if (legacyPerRun) {
      return { status: "invalid", failure: setupFailure(SETUP_ERROR_CODES_INVALID_ARGS, "per-run flags (--identity-from/--system-tab/--conflicts-tab/--map) apply only to a single --adopt entry; encode the columnMap inline in each --adopt instead") };
    }
  }

  if (!multi) {
    const missing = [ADOPT_FLAGS.ENTITY, ADOPT_FLAGS.TAB].filter((flag) => !values.has(flag));
    if (missing.length > 0) {
      return { status: "invalid", failure: setupFailure(SETUP_ERROR_CODES_INVALID_ARGS, `missing required flag(s): ${missing.join(", ")}`) };
    }
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

  // Shared options for both paths (identityFrom/systemTabName/conflictsTabName
  // are consumed by the flow only for a SINGLE --adopt entry or the legacy
  // path).
  const commonOptions = {
    identityFrom,
    mode: rawMode,
    db: values.get(ADOPT_FLAGS.DB) ?? process.env.HIKOUTEI_DB_PATH ?? "./hikoutei.sqlite",
    ...(spreadsheetUrl === undefined ? {} : { spreadsheetUrl }),
    ...(credentialsPath === undefined ? {} : { credentialsPath }),
    ...(entitiesModule === undefined ? {} : { entitiesModule }),
    ...(systemTabName === undefined ? {} : { systemTabName }),
    ...(conflictsTabName === undefined ? {} : { conflictsTabName }),
    yes: flags.has(ADOPT_FLAGS.YES),
    json: flags.has(ADOPT_FLAGS.JSON),
  } as const;

  return {
    status: "valid",
    options: multi
      // A single --adopt entry behaves like the legacy path: the per-run
      // --map columnMap is scoped to that one entity and must ride through
      // (F2). With several entries --map is rejected above.
      ? (adoptEntries.length === 1
          ? { ...commonOptions, adopts: adoptEntries, ...(columnMap === undefined ? {} : { columnMap }) }
          : { ...commonOptions, adopts: adoptEntries })
      : {
          ...commonOptions,
          entityName: values.get(ADOPT_FLAGS.ENTITY)!,
          tabName: values.get(ADOPT_FLAGS.TAB)!,
          ...(columnMap === undefined ? {} : { columnMap }),
        },
  };
}

/**
 * Parses one `--adopt` value of the form
 * `<Entity>=<Tab>[;Header=property;Header2=property2]`. Returns `undefined`
 * when the shape is malformed (missing `=`/tab, or an empty map binding).
 */
function parseAdoptValue(value: string): AdoptCliEntitySpec | undefined {
  const eq = value.indexOf("=");
  if (eq <= 0 || eq === value.length - 1) return undefined;
  const entityName = value.slice(0, eq).trim();
  if (entityName === "") return undefined;

  const segments = value.slice(eq + 1).split(";");
  const tabName = segments[0]!.trim();
  if (tabName === "") return undefined;

  const mapEntries: [string, string][] = [];
  for (const segment of segments.slice(1)) {
    if (segment.trim() === "") continue;
    const sep = segment.indexOf("=");
    if (sep <= 0 || sep === segment.length - 1) return undefined;
    mapEntries.push([segment.slice(0, sep).trim(), segment.slice(sep + 1).trim()]);
  }
  const columnMap = mapEntries.length === 0 ? undefined : Object.fromEntries(mapEntries);
  return { entityName, tabName, ...(columnMap === undefined ? {} : { columnMap }) };
}
