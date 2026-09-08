/**
 * Production wiring for `hikoutei infer`.
 *
 * Owns the real-world dependencies the pure core avoids: resolving the
 * spreadsheet id and credentials, reading one tab range through the Sheets
 * API (read-only — no writes, no provisioning), and mapping outcomes to
 * exit codes. Tests drive `runInferCli` with a fake reader and never touch
 * the network or credentials.
 *
 * Exit codes: 0 success, 1 runtime failure (tab not found, empty tab,
 * missing credentials, read failure), 2 argument errors.
 */

import { access } from "node:fs/promises";

import { GoogleAuth } from "google-auth-library";
import { sheets } from "@googleapis/sheets";

import { parseInferArgs, type InferOptions } from "./inferArgs.js";
import {
  INFER_ERROR_PREFIX,
  inferFromGrid,
  InferError,
  type InferTabGrid,
  type InferTabReader,
} from "./infer.js";
import {
  SETUP_ARG_ERROR_EXIT_CODE,
  SETUP_RUNTIME_ERROR_EXIT_CODE,
} from "./errors.js";
import { httpStatusOf } from "./sdkError.js";
import { SPREADSHEETS_SCOPE } from "./sheetsFactory.js";
import { isModuleMainEntry } from "./setup.js";

export interface RunInferCliInput {
  readonly options: InferOptions;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly reader: InferTabReader;
  readonly output: { readonly write: (text: string) => void };
  readonly error: { readonly write: (text: string) => void };
}

/**
 * Runs the infer flow. Never throws: every failure becomes a non-zero exit
 * code with a machine-readable `hikoutei-infer:<code>:` line on stderr.
 */
export async function runInferCli(input: RunInferCliInput): Promise<number> {
  const spreadsheetUrl = input.options.spreadsheetUrl ?? input.env.HIKOUTEI_SYNC_SPREADSHEET_URL;
  if (spreadsheetUrl === undefined || spreadsheetUrl.trim() === "") {
    input.error.write(
      `${INFER_ERROR_PREFIX}:invalid_args: missing spreadsheet URL — pass --spreadsheet <url> or set HIKOUTEI_SYNC_SPREADSHEET_URL.\n`,
    );
    return SETUP_ARG_ERROR_EXIT_CODE;
  }
  const spreadsheetId = parseInferSpreadsheetId(spreadsheetUrl);
  if (spreadsheetId === undefined) {
    input.error.write(
      `${INFER_ERROR_PREFIX}:spreadsheet_url_invalid: could not extract a spreadsheet ID — expected a URL of the form https://docs.google.com/spreadsheets/d/<SPREADSHEET_ID>/edit.\n`,
    );
    return SETUP_RUNTIME_ERROR_EXIT_CODE;
  }
  const credentialsPath = input.options.credentialsPath ?? input.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (credentialsPath === undefined || credentialsPath.trim() === "") {
    input.error.write(
      `${INFER_ERROR_PREFIX}:missing_credentials: no service-account credentials found — pass --credentials <path> or set GOOGLE_APPLICATION_CREDENTIALS (run \`npx hikoutei setup\` to provision them).\n`,
    );
    return SETUP_RUNTIME_ERROR_EXIT_CODE;
  }

  let grid: InferTabGrid;
  try {
    grid = await input.reader({ spreadsheetId, tabName: input.options.tabName, limit: input.options.limit });
  } catch (error: unknown) {
    return reportInferError(input, error);
  }

  try {
    const result = inferFromGrid(grid, { ...(input.options.pkHeader === undefined ? {} : { pkHeader: input.options.pkHeader }) });
    input.output.write(`${result.tsBlock}\n\n${result.summary}\n`);
    return 0;
  } catch (error: unknown) {
    return reportInferError(input, error);
  }
}

/** Maps an infer failure to the machine-readable CLI error line. */
function reportInferError(input: RunInferCliInput, error: unknown): number {
  const code = error instanceof InferError
    ? error.code
    : typeof (error as { code?: unknown })?.code === "string"
      ? (error as { code: string }).code
      : "unexpected";
  if (code === "invalid_args" || code === "pk_not_found") {
    const message = error instanceof Error ? error.message : String(error);
    input.error.write(`${INFER_ERROR_PREFIX}:${code === "pk_not_found" ? "invalid_args" : code}: ${message}\n`);
    return SETUP_ARG_ERROR_EXIT_CODE;
  }
  if (error instanceof InferError) {
    input.error.write(`${INFER_ERROR_PREFIX}:${error.code}: ${error.message}\n`);
    return SETUP_RUNTIME_ERROR_EXIT_CODE;
  }
  // Uncoded reader/SDK failures carry no safe detail (messages may embed
  // URLs or key material), so report the bare HTTP status when one exists.
  const status = httpStatusOf(error);
  input.error.write(
    `${INFER_ERROR_PREFIX}:${code}: ${status === undefined ? "could not sample the tab" : `sheet read failed with HTTP ${status}`}.\n`,
  );
  return SETUP_RUNTIME_ERROR_EXIT_CODE;
}

/**
 * Extracts the spreadsheet ID from a Google Sheets URL.
 *
 * Accepts `/spreadsheets/d/<ID>` and a top-level `/d/<ID>` right after the
 * host (with query/fragment/trailing suffixes tolerated); anything deeper
 * (e.g. `/document/d/<ID>`) is rejected. Mirrors the sync engine's
 * `parseSpreadsheetIdFromUrl` without importing its module graph.
 */
export function parseInferSpreadsheetId(url: string): string | undefined {
  if (typeof url !== "string" || url.trim() === "") return undefined;
  const withoutScheme = url.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "");
  const path = withoutScheme.split(/[?#]/, 1)[0] ?? "";
  const segments = path.split("/");
  const dIndex = segments.findIndex((segment) => segment === "d");
  if (dIndex < 0) return undefined;
  const previous = segments[dIndex - 1];
  if (previous !== "spreadsheets" && dIndex !== 1) return undefined;
  const id = segments[dIndex + 1];
  if (id === undefined || id.length === 0 || /[\s?#]/.test(id)) return undefined;
  return id;
}

/** Quotes a tab name for A1-notation ranges (single quotes doubled). */
function quoteA1TabName(tabName: string): string {
  return `'${tabName.replace(/'/g, "''")}'`;
}

/** Production reader: one read-only tab-range fetch through the Sheets API. */
async function createSheetsTabReader(credentialsPath: string): Promise<InferTabReader> {
  try {
    await access(credentialsPath);
  } catch {
    throw new InferError(
      "missing_credentials",
      `cannot read the credentials file — check the path or run \`npx hikoutei setup\`.`,
    );
  }
  // The boundary cast keeps any google-auth-library version mismatch between
  // the top-level package and googleapis-common contained in this module.
  const auth = new GoogleAuth({
    keyFile: credentialsPath,
    scopes: [SPREADSHEETS_SCOPE],
  }) as unknown as NonNullable<Parameters<typeof sheets>[0]["auth"]>;
  const client = sheets({ version: "v4", auth });
  return async (input): Promise<InferTabGrid> => {
    let data: unknown;
    try {
      const response = await client.spreadsheets.get({
        spreadsheetId: input.spreadsheetId,
        includeGridData: true,
        ranges: [`${quoteA1TabName(input.tabName)}!A1:ZZ${input.limit + 1}`],
        fields: "sheets(properties.title,data.rowData.values(userEnteredValue,effectiveValue,formattedValue,userEnteredFormat.numberFormat,effectiveFormat.numberFormat))",
      });
      data = response.data;
    } catch (error: unknown) {
      // A bad range is how the API reports an unknown tab (400); a missing
      // spreadsheet surfaces as 404. Anything else is a read failure whose
      // raw detail is never echoed (it may embed URLs or key material).
      const status = httpStatusOf(error);
      if (status === 400 || status === 404) {
        throw new InferError("tab_not_found", `Tab "${input.tabName}" was not found in the spreadsheet.`);
      }
      throw new InferError(
        "read_failed",
        status === undefined ? "could not sample the tab" : `sheet read failed with HTTP ${status}`,
      );
    }
    return extractInferGrid(data, input.tabName, input.limit);
  };
}

/**
 * Validates the raw `spreadsheets.get` grid payload for one tab.
 *
 * Untrusted SDK data: the response must list the requested tab and carry
 * grid rows; a tab without a header row is `empty_tab`. Throws `InferError`
 * (`tab_not_found`, `empty_tab`, `malformed_grid`); never echoes payloads.
 */
export function extractInferGrid(data: unknown, tabName: string, limit: number): InferTabGrid {
  if (!isRecord(data)) throw new InferError("malformed_grid", "the sheet read returned a non-object payload");
  const sheetsValue = data.sheets;
  if (!Array.isArray(sheetsValue) || sheetsValue.length === 0) {
    throw new InferError("tab_not_found", `Tab "${tabName}" was not found in the spreadsheet.`);
  }
  const sheet = sheetsValue.find((entry) => isRecord(entry) && isRecord(entry.properties) && entry.properties.title === tabName);
  if (sheet === undefined || !isRecord(sheet)) {
    throw new InferError("tab_not_found", `Tab "${tabName}" was not found in the spreadsheet.`);
  }
  const gridData = sheet.data;
  if (!Array.isArray(gridData) || gridData.length === 0) {
    throw new InferError("empty_tab", `Tab "${tabName}" has no header row.`);
  }
  const rowData: unknown[] = [];
  for (const grid of gridData) {
    if (!isRecord(grid) || grid.rowData === undefined) continue;
    if (!Array.isArray(grid.rowData)) throw new InferError("malformed_grid", "the sheet read returned a malformed grid");
    rowData.push(...grid.rowData);
  }
  if (rowData.length === 0) {
    throw new InferError("empty_tab", `Tab "${tabName}" has no header row.`);
  }
  const first = rowData[0];
  if (!isRecord(first) || !Array.isArray(first.values)) {
    throw new InferError("empty_tab", `Tab "${tabName}" has no header row.`);
  }
  return {
    tabName,
    headerCells: first.values,
    dataCells: rowData.slice(1, limit + 1).map((row) => {
      if (!isRecord(row)) return [];
      return Array.isArray(row.values) ? row.values : [];
    }),
  };
}

/**
 * Runs the `hikoutei infer` CLI with the given argument vector (without the
 * leading "infer" subcommand). Exported so the bin router can delegate and
 * tests can drive it with injected argv.
 */
export async function runInferMain(argv: readonly string[]): Promise<number> {
  const parsed = parseInferArgs(argv);
  if (parsed.status === "help") {
    process.stdout.write(`${parsed.helpText}\n`);
    return 0;
  }
  if (parsed.status === "invalid") {
    process.stderr.write(`${INFER_ERROR_PREFIX}:${parsed.failure.code}: ${parsed.failure.message}\n`);
    process.stderr.write("Run `hikoutei infer --help` for usage.\n");
    return SETUP_ARG_ERROR_EXIT_CODE;
  }

  const options = parsed.options;
  try {
    const credentialsPath = options.credentialsPath ?? process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (credentialsPath === undefined || credentialsPath.trim() === "") {
      process.stderr.write(
        `${INFER_ERROR_PREFIX}:missing_credentials: no service-account credentials found — pass --credentials <path> or set GOOGLE_APPLICATION_CREDENTIALS (run \`npx hikoutei setup\` to provision them).\n`,
      );
      return SETUP_RUNTIME_ERROR_EXIT_CODE;
    }
    const reader = await createSheetsTabReader(credentialsPath);
    return await runInferCli({ options, env: process.env, reader, output: process.stdout, error: process.stderr });
  } catch (error: unknown) {
    const code = error instanceof InferError ? error.code : "unexpected";
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${INFER_ERROR_PREFIX}:${code}: ${message}\n`);
    return SETUP_RUNTIME_ERROR_EXIT_CODE;
  }
}

// ESM entrypoint guard: run main() only when this file is the process entry,
// never when merely imported (see setup.ts for the same pattern).
if (isModuleMainEntry(process.argv[1], import.meta.url)) {
  runInferMain(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${INFER_ERROR_PREFIX}:unexpected: ${safeReason(error)}\n`);
      process.exitCode = SETUP_RUNTIME_ERROR_EXIT_CODE;
    });
}

/** Strict sanitizer: only Error-shaped reasons are ever printed. */
function safeReason(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
