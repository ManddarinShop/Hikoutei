/**
 * Spreadsheet creation for `hikoutei setup`.
 *
 * The setup CLI creates the sync spreadsheet with the freshly provisioned
 * service-account key, so the service account owns the spreadsheet and no
 * sharing step is needed. The production implementation uses
 * google-auth-library plus @googleapis/sheets (already root dependencies);
 * tests inject a fake creator, so unit tests never touch the network.
 *
 * The API response is treated as untrusted input: it is validated by a
 * runtime guard before it is promoted into the internal result shape.
 */

import { GoogleAuth } from "google-auth-library";
import { sheets } from "@googleapis/sheets";

/** OAuth scope required to create and write spreadsheets. */
export const SPREADSHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

/** Template for the human-facing spreadsheet edit URL. */
export const SPREADSHEET_EDIT_URL_TEMPLATE = "https://docs.google.com/spreadsheets/d/<id>/edit";

export interface SpreadsheetCreateRequest {
  /** Absolute path to the service-account key JSON file. */
  readonly keyPath: string;
  /** Spreadsheet title to create. */
  readonly title: string;
}

export interface SpreadsheetCreateResult {
  readonly spreadsheetId: string;
  readonly spreadsheetUrl: string;
}

/** Creates a spreadsheet as the service account identified by `keyPath`. */
export type SpreadsheetCreator = (
  request: SpreadsheetCreateRequest,
) => Promise<SpreadsheetCreateResult>;

/** SDK-boundary auth type; mirrors the provider transport's containment cast. */
type SheetsAuth = NonNullable<Parameters<typeof sheets>[0]["auth"]>;

/**
 * Production spreadsheet creator.
 *
 * Authenticates with the given service-account key file and calls
 * `spreadsheets.create`. Throws on failure; the setup flow maps any throw to
 * the `sheet_create_failed` error code. The key file path is never included
 * in error output.
 */
export function createGoogleSheetsSpreadsheetCreator(): SpreadsheetCreator {
  return async (request: SpreadsheetCreateRequest): Promise<SpreadsheetCreateResult> => {
    // google-auth-library may resolve to a version nested under googleapis-common
    // that differs from the top-level one; the boundary cast keeps any SDK
    // version mismatch contained in this module.
    const auth = new GoogleAuth({
      keyFile: request.keyPath,
      scopes: [SPREADSHEETS_SCOPE],
    }) as unknown as SheetsAuth;
    const client = sheets({ version: "v4", auth });
    const response = await client.spreadsheets.create({
      requestBody: { properties: { title: request.title } },
    });
    return extractSpreadsheetCreateResult(response.data);
  };
}

/** Builds the public edit URL for a spreadsheet id. */
export function spreadsheetEditUrl(spreadsheetId: string): string {
  return SPREADSHEET_EDIT_URL_TEMPLATE.replace("<id>", spreadsheetId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates the raw `spreadsheets.create` payload and promotes it into the
 * internal result shape.
 *
 * The response is untrusted SDK data, so `spreadsheetId` must be proven to be
 * a non-empty string. When the API omits `spreadsheetUrl` (it can), the URL
 * is derived from the id deterministically.
 */
export function extractSpreadsheetCreateResult(data: unknown): SpreadsheetCreateResult {
  if (!isRecord(data)) {
    throw new Error("spreadsheets.create returned a non-object payload");
  }
  const { spreadsheetId, spreadsheetUrl } = data;
  if (typeof spreadsheetId !== "string" || spreadsheetId === "") {
    throw new Error("spreadsheets.create response is missing a spreadsheet id");
  }
  if (typeof spreadsheetUrl === "string" && spreadsheetUrl !== "") {
    return { spreadsheetId, spreadsheetUrl };
  }
  return { spreadsheetId, spreadsheetUrl: spreadsheetEditUrl(spreadsheetId) };
}
