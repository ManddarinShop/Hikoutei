/**
 * Projection provisioning for the Google Sheets API sync provider.
 *
 * Creates missing tabs and their header rows, or verifies existing tabs, in
 * ONE atomic batchUpdate. An existing tab with no content anywhere in its
 * used grid gets its headers initialized; an existing tab with content must
 * match the registered headers exactly (order, duplicates, width), otherwise
 * provisioning fails closed BEFORE any mutation. The operation is idempotent:
 * a retry after a lost response re-enumerates, sees the exact headers, and
 * succeeds without rewriting anything.
 */

import type { SyncSheetsProvisionRoute } from "../../../../../application/sync/sheetsContract/sheetsProvisioning.js";
import {
  GOOGLE_SHEETS_API_PROVISION_ENUMERATION_FIELDS,
  GOOGLE_SHEETS_API_PROVISION_FIELDS,
  gridHeaderCells,
  parseSpreadsheetDocument,
  type ParsedGridData,
} from "../model/preflight.js";
import { invalidProviderRequest, invalidProviderState } from "../errors.js";
import type { GoogleSheetsApiWriteRequest } from "../transport/googleSheetsApiTransport.js";
import { allocateSheetId } from "../model/sheetIdAllocator.js";
import {
  columnLetters,
  parseRegisteredRange,
  quoteA1SheetName,
} from "../model/valueNormalization.js";
import {
  requireValidBatchUpdateReply,
  runRead,
  runWrite,
  type GoogleSheetsApiProviderDeps,
} from "./shared.js";

/**
 * Creates missing tabs and their header rows, or verifies existing tabs,
 * in ONE atomic batchUpdate. An existing tab with no content anywhere in
 * its used grid gets its headers initialized; an existing tab with content
 * must match the registered headers exactly (order, duplicates, width),
 * otherwise provisioning fails closed BEFORE any mutation. The operation
 * is idempotent: a retry after a lost response re-enumerates, sees the
 * exact headers, and succeeds without rewriting anything.
 */
export async function provisionRegistry(
  deps: GoogleSheetsApiProviderDeps,
  registrations: readonly SyncSheetsProvisionRoute[],
): Promise<{
  readonly registrations: readonly Omit<SyncSheetsProvisionRoute, "headers">[];
  readonly createdSheets: readonly string[];
  readonly initializedHeaders: readonly string[];
}> {
  validateProvisionRegistrations(registrations);

  // Enumerate every tab (no ranges, hidden included) with grid dimensions.
  const enumerationRaw = await runRead(deps, () =>
    deps.transport.getSpreadsheet({
      spreadsheetId: deps.spreadsheetId,
      ranges: [],
      fields: GOOGLE_SHEETS_API_PROVISION_ENUMERATION_FIELDS,
      timeoutMs: deps.readTimeoutMs,
    }));
  const sheets = parseSpreadsheetDocument(enumerationRaw, "provisioning enumeration");
  const existingByTitle = new Map(
    sheets.sheets.map((sheet) => [sheet.title, sheet] as const),
  );

  // Read the full used grid of every existing registered tab (values plus
  // formats). Missing tabs need no data read; they are created below.
  const dataTargets = registrations.filter((registration) =>
    existingByTitle.has(registration.sheetName));
  const grids = new Map<string, ParsedGridData>();
  if (dataTargets.length > 0) {
    const ranges = dataTargets.map((registration) => {
      const existing = existingByTitle.get(registration.sheetName);
      if (existing === undefined) {
        invalidProviderState(`Registered sync sheet does not exist: ${registration.sheetName}`);
      }
      const endColumn = provisionGridEndColumn(registration, existing);
      return `${quoteA1SheetName(registration.sheetName)}!A1:${columnLetters(endColumn)}1048576`;
    });
    const dataRaw = await runRead(deps, () =>
      deps.transport.getSpreadsheet({
        spreadsheetId: deps.spreadsheetId,
        ranges,
        fields: GOOGLE_SHEETS_API_PROVISION_FIELDS,
        timeoutMs: deps.readTimeoutMs,
      }));
    const document = parseSpreadsheetDocument(dataRaw, "provisioning grid");
    for (const registration of dataTargets) {
      const existing = existingByTitle.get(registration.sheetName);
      if (existing === undefined) {
        invalidProviderState(`Registered sync sheet does not exist: ${registration.sheetName}`);
      }
      const grid = document.grids.get(existing.sheetId);
      if (grid === undefined) {
        invalidProviderState(`grid data is missing for sheet ${existing.sheetId}`);
      }
      grids.set(registration.sheetName, grid);
    }
  }

  // Plan all mutations: addSheet + header writes for missing tabs, header
  // writes for truly-empty tabs, exact-match verification for content tabs.
  const requests: GoogleSheetsApiWriteRequest[] = [];
  const createdSheets: string[] = [];
  const initializedHeaders: string[] = [];
  const usedSheetIds = new Set(sheets.sheets.map((sheet) => sheet.sheetId));
  for (const registration of registrations) {
    const range = parseRegisteredRange(registration.registeredRange);
    const existing = existingByTitle.get(registration.sheetName);
    const headerCells = registration.headers.map((header) => ({
      userEnteredValue: { stringValue: header },
    }));
    if (existing === undefined) {
      const sheetId = allocateSheetId(usedSheetIds);
      usedSheetIds.add(sheetId);
      requests.push({ kind: "addSheet", title: registration.sheetName, sheetId });
      requests.push({
        kind: "updateCells",
        sheetId,
        startRowIndex: 0,
        startColumnIndex: range.startColumn - 1,
        rows: [headerCells],
        fields: "userEnteredValue",
      });
      createdSheets.push(registration.sheetName);
      initializedHeaders.push(registration.sheetName);
      continue;
    }
    const grid = grids.get(registration.sheetName);
    if (grid === undefined) {
      invalidProviderState(`provisioning grid is missing for ${registration.sheetName}`);
    }
    if (!gridHasContent(grid)) {
      // Truly empty tab: initialize the header row only.
      requests.push({
        kind: "updateCells",
        sheetId: existing.sheetId,
        startRowIndex: 0,
        startColumnIndex: range.startColumn - 1,
        rows: [headerCells],
        fields: "userEnteredValue",
      });
      initializedHeaders.push(registration.sheetName);
      continue;
    }
    // Content tab: the header row must match the registered schema exactly.
    assertProvisioningHeaders(grid, registration);
  }

  if (requests.length > 0) {
    const response = await runWrite(deps, () =>
      deps.transport.batchUpdate({
        spreadsheetId: deps.spreadsheetId,
        requests,
      }));
    requireValidBatchUpdateReply(response, requests.length);
  }

  return {
    registrations: registrations.map(({ headers: _headers, ...route }) => route),
    createdSheets,
    initializedHeaders,
  };
}

/** Validates provisioning registrations before any transport call. */
function validateProvisionRegistrations(
  registrations: readonly SyncSheetsProvisionRoute[],
): void {
  if (registrations.length === 0) {
    invalidProviderRequest("provisioning", "registrations must not be empty");
  }
  const tabNames = new Set<string>();
  for (const registration of registrations) {
    if (registration.sheetName.trim() === "") {
      invalidProviderRequest("provisioning", "sheetName must be non-empty");
    }
    if (tabNames.has(registration.sheetName)) {
      invalidProviderRequest(
        "provisioning",
        `cannot repeat a tab name: ${registration.sheetName}`,
      );
    }
    tabNames.add(registration.sheetName);
    const range = parseRegisteredRange(registration.registeredRange);
    if (range.columnCount !== registration.headers.length) {
      invalidProviderRequest(
        "provisioning",
        `headers do not match registeredRange for ${registration.sheetName}`,
      );
    }
    if (registration.headers.length === 0 ||
        registration.headers.some((header) => header.trim() === "")) {
      invalidProviderRequest(
        "provisioning",
        `headers must contain non-empty names for ${registration.sheetName}`,
      );
    }
    if (new Set(registration.headers).size !== registration.headers.length) {
      invalidProviderRequest(
        "provisioning",
        `headers must not contain duplicates for ${registration.sheetName}`,
      );
    }
  }
}

/**
 * Builds the provisioning data-read end column: the sheet's actual grid
 * width when the enumeration supplied it (so content anywhere in the tab
 * decides emptiness), otherwise the registered range's end column and
 * emptiness is judged only from the returned grid.
 */
function provisionGridEndColumn(
  registration: SyncSheetsProvisionRoute,
  existing: { readonly gridProperties?: { readonly rowCount: number; readonly columnCount: number } },
): number {
  const parsed = parseRegisteredRange(registration.registeredRange);
  const registeredEnd = parsed.startColumn + parsed.columnCount - 1;
  const gridColumns = existing.gridProperties?.columnCount;
  if (gridColumns === undefined) return registeredEnd;
  return Math.max(gridColumns, registeredEnd);
}

/**
 * Returns whether a provisioning grid has any content anywhere.
 *
 * Only cells with an actual ENTERED value count (a userEnteredValue carrying
 * stringValue/numberValue/boolValue/formulaValue). Blank `{}` cells and
 * format-only cells (userEnteredFormat without a value) are ignored, matching
 * the Apps Script `getLastRow()/getLastColumn()` semantics provisioning was
 * ported from — a blank-but-formatted tab is still initialized, never judged
 * as a content tab that must match headers.
 */
function gridHasContent(grid: ParsedGridData): boolean {
  for (const row of grid.rowData) {
    for (const value of row.values) {
      if (cellHasEnteredValue(value)) return true;
    }
  }
  return false;
}

/** Returns whether one API cell carries a real entered value. */
function cellHasEnteredValue(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const entered = (value as Record<string, unknown>).userEnteredValue;
  if (entered === null || typeof entered !== "object" || Array.isArray(entered)) return false;
  const enteredRecord = entered as Record<string, unknown>;
  return enteredRecord.stringValue !== undefined ||
    enteredRecord.numberValue !== undefined ||
    enteredRecord.boolValue !== undefined ||
    enteredRecord.formulaValue !== undefined;
}

/**
 * Verifies one content tab's header row against the registered schema:
 * exact order, non-empty strings, no duplicates, and full registered-range
 * coverage. Any drift fails closed BEFORE any mutation, mirroring the Apps
 * Script "operational provisioning header mismatch" behavior (including a
 * blank header row on a tab whose content lives outside the registered
 * range).
 */
function assertProvisioningHeaders(
  grid: ParsedGridData,
  registration: SyncSheetsProvisionRoute,
): void {
  const range = parseRegisteredRange(registration.registeredRange);
  const headerValues = gridHeaderCells(grid, range);
  const actual = headerValues.map((value, index) => {
    const raw = provisioningHeaderString(value);
    if (raw === null) {
      invalidProviderState(
        `operational provisioning header mismatch: ${registration.sheetName}` +
        ` (header is missing at column ${index + 1})`,
      );
    }
    return raw;
  });
  if (new Set(actual).size !== actual.length) {
    invalidProviderState(
      `operational provisioning header mismatch: ${registration.sheetName} (duplicate header)`,
    );
  }
  if (
    actual.length !== registration.headers.length ||
    actual.some((header, index) => header !== registration.headers[index])
  ) {
    invalidProviderState(
      `operational provisioning header mismatch: ${registration.sheetName}`,
    );
  }
}

/**
 * Reads a provisioning header cell as its raw string: string values as-is,
 * numbers and booleans stringified (the Apps Script source compares
 * `String(actual) === String(expected)`), anything else treated as missing.
 */
function provisioningHeaderString(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const entered = record.userEnteredValue;
  if (entered === null || typeof entered !== "object") return null;
  const enteredRecord = entered as Record<string, unknown>;
  if (enteredRecord.stringValue !== undefined) {
    return typeof enteredRecord.stringValue === "string" ? enteredRecord.stringValue : null;
  }
  if (enteredRecord.numberValue !== undefined) {
    return typeof enteredRecord.numberValue === "number" && Number.isFinite(enteredRecord.numberValue)
      ? String(enteredRecord.numberValue)
      : null;
  }
  if (enteredRecord.boolValue !== undefined) {
    return typeof enteredRecord.boolValue === "boolean" ? String(enteredRecord.boolValue) : null;
  }
  return null;
}
