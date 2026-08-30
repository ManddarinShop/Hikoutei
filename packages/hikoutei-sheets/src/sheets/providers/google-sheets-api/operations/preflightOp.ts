/**
 * Preflight and observation-target operations for the Google Sheets API
 * sync provider.
 *
 * `readPreflight` performs the two paced transport calls every outbound
 * effect operation needs (range-less sheet enumeration for hidden receipt
 * tab discovery, plus one bounded data read of the target and receipt tabs).
 * `observationTargetFor` validates one observation request and derives its
 * snapshot build target, failing closed on unknown read modes.
 */

import type { ReadSyncSnapshotRequest } from "@hikoutei/contracts/sheets/syncSheets.js";
import { requireSyncSnapshotReadMode } from "@hikoutei/contracts/sheets/validation.js";
import {
  SYNC_SNAPSHOT_READ_MODES,
  SYNC_PROJECTIONS,
} from "@hikoutei/contracts/sheets/constants.js";
import { SYNC_SHEETS_ERROR_CODES } from "@hikoutei/contracts/sheets/errors.js";
import type {
  SyncMissingTabOperation,
} from "@hikoutei/contracts/sheets/errors.js";
import type { RegisteredSyncProjectionDefinition } from "@hikoutei/contracts/sheets/sheetsProvisioning.js";
import type { Presence } from "@hikoutei/contracts/state/index.js";
import { presentValue } from "@hikoutei/contracts/state/index.js";
import { PRESENCE_KINDS } from "@hikoutei/contracts/state/constants.js";
import { invalidProviderRequest } from "../errors.js";
import {
  GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES,
  GoogleSheetsApiTransportError,
} from "../errors.js";
import {
  GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME,
  GOOGLE_SHEETS_API_MISSING_RANGE_REMOTE_CODE,
} from "../constants.js";
import { GOOGLE_SHEETS_API_PREFLIGHT_FIELDS } from "../model/preflightFields.js";
import {
  enumerateSheetProperties,
  readPreflightData,
  readPreflightDataForRoutes,
  readReceipts,
  type ParsedSpreadsheetDocument,
  type PreflightContext,
} from "../model/preflightContext.js";
import {
  anchorColumnFor,
  findSheetByTitle,
  requireGridDataForSheet,
} from "../model/preflightRows.js";
import { parseSpreadsheetDocument } from "../model/preflightParsing.js";
import { quoteA1SheetName } from "../model/valueNormalization.js";
import type { GoogleSheetsApiGetSpreadsheetRequest } from "../transport/googleSheetsApiTransport.js";
import type { SnapshotBuildTarget } from "../model/observation.js";
import {
  definitionForPhysicalSheet,
  runRead,
  validateRoute,
  type GoogleSheetsApiProviderDeps,
  type RequestStartPacing,
} from "./shared.js";

/**
 * Reads the target and receipt tabs for one route. Paced on the PREFLIGHT read
 * class by default; pass `pacing: "write"` for a postcondition/verify read
 * that serializes against writes.
 */
export async function readPreflight(
  deps: GoogleSheetsApiProviderDeps,
  request: {
    readonly sheetName: string;
    readonly registeredRange: string;
  },
  definition: RegisteredSyncProjectionDefinition,
  routeOptions: {
    readonly identityField: Presence<string>;
    readonly checkboxHeaders: readonly string[];
  },
  pacing: RequestStartPacing = "preflight",
): Promise<PreflightContext> {
  // Each preflight performs two paced transport calls: a range-less sheet
  // enumeration (hidden receipt tab discovery) plus one ranged data read.
  const sheets = await runRead(deps, () =>
    enumerateSheetProperties(deps.transport, deps.spreadsheetId, deps.readTimeoutMs), pacing);
  return runRead(deps, () =>
    readPreflightData(deps.transport, {
      spreadsheetId: deps.spreadsheetId,
      sheetName: request.sheetName,
      registeredRange: request.registeredRange,
      headers: definition.headers,
      ...(definition.physicalHeaders === undefined ? {} : { physicalHeaders: definition.physicalHeaders }),
      identityField: routeOptions.identityField,
      checkboxHeaders: routeOptions.checkboxHeaders,
      projection: definition.sheet.projection,
    }, sheets, deps.readTimeoutMs), pacing);
}

/**
 * Reads the target and receipt tabs for MANY routes with ONE enumeration and
 * ONE ranged read covering all needed tabs, then builds a PreflightContext per
 * route keyed by its sheetName. Paced on the PREFLIGHT read class by default;
 * pass `pacing: "write"` for a postcondition/verify read that serializes
 * against writes.
 *
 * `operation` classifies an invalid provider state (such as a missing tab)
 * detected during the read; it defaults to the preflight step. The
 * postcondition-recovery path passes its own operation so a missing tab there
 * is reported as `postcondition_read` rather than `preflight`.
 */
export async function readPreflightForRoutes(
  deps: GoogleSheetsApiProviderDeps,
  routes: ReadonlyArray<{
    readonly sheetName: string;
    readonly registeredRange: string;
    readonly definition: RegisteredSyncProjectionDefinition;
    readonly routeOptions: {
      readonly identityField: Presence<string>;
      readonly checkboxHeaders: readonly string[];
    };
  }>,
  operation?: SyncMissingTabOperation,
  pacing: RequestStartPacing = "preflight",
): Promise<ReadonlyMap<string, PreflightContext>> {
  const sheets = await runRead(deps, () =>
    enumerateSheetProperties(deps.transport, deps.spreadsheetId, deps.readTimeoutMs), pacing);
  return runRead(deps, () =>
    readPreflightDataForRoutes(
      deps.transport,
      routes.map((route) => ({
        spreadsheetId: deps.spreadsheetId,
        sheetName: route.sheetName,
        registeredRange: route.registeredRange,
        headers: route.definition.headers,
        ...(route.definition.physicalHeaders === undefined ? {} : { physicalHeaders: route.definition.physicalHeaders }),
        identityField: route.routeOptions.identityField,
        checkboxHeaders: route.routeOptions.checkboxHeaders,
        projection: route.definition.sheet.projection,
      })),
      sheets,
      deps.readTimeoutMs,
      operation,
    ), pacing);
}

/** Validates one observation request and derives its snapshot target. */
export function observationTargetFor(
  deps: GoogleSheetsApiProviderDeps,
  request: ReadSyncSnapshotRequest,
): SnapshotBuildTarget {
  const definition = definitionForPhysicalSheet(deps, request.physicalSheetId);
  validateRoute(request, definition);
  // Fail closed on unknown readMode strings (same shared guard as the Apps
  // Script observation operation) instead of silently reading in full mode.
  const readMode = request.readMode === undefined
    ? SYNC_SNAPSHOT_READ_MODES.FULL
    : requireSyncSnapshotReadMode(
      request.readMode,
      "Google Sheets API observation readMode",
      SYNC_SHEETS_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
    );
  if (
    readMode === SYNC_SNAPSHOT_READ_MODES.USER_INPUT &&
    request.projection !== SYNC_PROJECTIONS.USER_INPUT
  ) {
    invalidProviderRequest(
      "observation",
      "user_input readMode requires the user_input projection",
    );
  }
  return {
    sheetName: request.sheetName,
    registeredRange: request.registeredRange,
    projection: request.projection,
    schemaVersion: request.schemaVersion,
    headers: definition.headers,
    ...(definition.physicalHeaders === undefined ? {} : { physicalHeaders: definition.physicalHeaders }),
    checkboxHeaders: definition.checkboxHeaders ?? [],
    readMode,
    anchorColumn: anchorColumnFor(request.registeredRange, request.projection),
  };
}

/**
 * Re-validates the shared receipt tab when a preflight observed it absent.
 *
 * A read-ahead preflight can run concurrently with another route's write and
 * observe the shared receipt tab before that write creates it. Two such
 * preflights would both build a batch containing a duplicate `addSheet`, and
 * the second write would fail with a 400 that could permanently fail its
 * effects. The write stage calls this under the mutation lane (via the
 * coordinator's `runSerializedInner`) so only the first write creates the tab;
 * a later write sees it present and appends instead. The re-read is paced on
 * the WRITE lane so it serializes against competing writes. Returns the
 * original context unchanged when the tab is still absent (the caller creates
 * it atomically with the target+receipt batch).
 *
 * The refresh is exactly ONE paced write-lane ranged `spreadsheets.get` of the
 * receipt tab by title: a tab that now exists returns its properties
 * (sheetId) and grid data together, and a still-absent tab is proven by an
 * empty intersection or by the API's proven missing-range 400 rejection,
 * which is classified as still-absent so the caller creates the tab. The
 * single read keeps the complete stale-receipt-refresh branch (two preflight
 * reads + this read + the write, one bounded admission wait each) inside the
 * leased fast-append/legacy bound that `validateEffectLeaseHeadroom` counts;
 * a separate range-less enumeration here would add one more paced request
 * and let the branch outlive the default effect lease.
 */
export async function refreshReceiptForWrite(
  deps: GoogleSheetsApiProviderDeps,
  context: PreflightContext,
): Promise<PreflightContext> {
  if (context.receiptSheetId.kind === PRESENCE_KINDS.PRESENT) return context;
  // The refresh is part of a write/initialization critical section (it
  // re-reads a tab that the current batch is about to create or append to), so
  // it is paced on the WRITE limiter to serialize against competing writes
  // instead of competing with the read burst.
  const dataRequest: GoogleSheetsApiGetSpreadsheetRequest = {
    spreadsheetId: deps.spreadsheetId,
    ranges: [`${quoteA1SheetName(GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME)}!A1:F1048576`],
    fields: GOOGLE_SHEETS_API_PREFLIGHT_FIELDS,
    ...(deps.readTimeoutMs === undefined ? {} : { timeoutMs: deps.readTimeoutMs }),
  };
  let dataDocument: ParsedSpreadsheetDocument;
  try {
    const dataRaw = await runRead(deps, () => deps.transport.getSpreadsheet(dataRequest), "write");
    dataDocument = parseSpreadsheetDocument(dataRaw, "grid data");
  } catch (error: unknown) {
    // The real API rejects a range that names a missing tab with a proven
    // pre-mutation 400; for this fixed, quoted range that proves the receipt
    // tab is still absent, so the caller creates it atomically. Every other
    // failure (timeout, network, 429/5xx, other 4xx, malformed reply) keeps
    // its own delivery-uncertain/invalid classification.
    if (isMissingRangeRejection(error)) return context;
    throw error;
  }
  const receiptSheet = findSheetByTitle(dataDocument.sheets, GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME);
  if (receiptSheet === undefined) return context;
  const receiptData = requireGridDataForSheet(dataDocument, receiptSheet.sheetId);
  const parsedReceipts = readReceipts(receiptData);
  return {
    ...context,
    receiptSheetId: presentValue(receiptSheet.sheetId),
    receiptLastRow: parsedReceipts.lastRow,
    receipts: parsedReceipts.receipts,
  };
}

/**
 * True for the API's proven missing-range rejection of the refresh's fixed
 * receipt-tab range: HTTP 400 carrying the canonical INVALID_ARGUMENT remote
 * status. Any other transport failure — including other 400s with a different
 * or absent remote code — must propagate with its own classification instead
 * of being read as proof the receipt tab is absent.
 */
function isMissingRangeRejection(error: unknown): boolean {
  return error instanceof GoogleSheetsApiTransportError &&
    error.code === GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.HTTP_ERROR &&
    error.status.kind === PRESENCE_KINDS.PRESENT &&
    error.status.value === 400 &&
    error.remoteCode.kind === PRESENCE_KINDS.PRESENT &&
    error.remoteCode.value === GOOGLE_SHEETS_API_MISSING_RANGE_REMOTE_CODE;
}
