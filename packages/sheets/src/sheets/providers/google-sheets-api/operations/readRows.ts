/**
 * Values-only table reads and observation snapshots for the Google Sheets
 * API sync provider.
 *
 * `readRowsBatch` serves several registered tables through ONE
 * `spreadsheets.get` call (fail-closed on missing tabs, header drift, or
 * malformed payloads). The snapshot operations share one grid read per
 * batch, write missing row anchors in ONE atomic batch, and re-read once so
 * committed anchors appear in every snapshot.
 */

import type {
  ReadSyncSnapshotRequest,
  ReadSyncTableRowsRequest,
  SyncObservedSnapshot,
  SyncSheetsSnapshot,
  SyncTableRowsResult,
} from "@hikoutei/contracts/sheets/syncSheets.js";
import {
  SYNC_SHEETS_ERROR_CODES,
  SyncSheetsContractError,
} from "@hikoutei/contracts/sheets/errors.js";
import {
  SYNC_SNAPSHOT_READ_MODES,
  type SyncSnapshotReadMode,
} from "@hikoutei/contracts/sheets/constants.js";
import {
  GOOGLE_SHEETS_API_LIGHTWEIGHT_OBSERVATION_FIELDS,
  GOOGLE_SHEETS_API_OBSERVATION_FIELDS,
  GOOGLE_SHEETS_API_VALUES_FIELDS,
} from "../model/preflightFields.js";
import { parseSpreadsheetDocument } from "../model/preflightParsing.js";
import type { ParsedGridData } from "../model/preflightContext.js";
import { invalidProviderState, GET_REPLY_MALFORMED } from "../errors.js";
import type { GoogleSheetsApiWriteRequest } from "../transport/googleSheetsApiTransport.js";
import {
  buildSnapshotFromTab,
  planRowAnchors,
  readTabGrids,
  type AnchorPlanResult,
  type ObservedTab,
  type SnapshotBuildTarget,
} from "../model/observation.js";
import { buildTableRowsFromGrid } from "../model/tableRead.js";
import { anchorColumnFor } from "../model/preflightRows.js";
import {
  columnLetters,
  parseRegisteredRange,
  quoteA1SheetName,
} from "../model/valueNormalization.js";
import {
  createRawResponseMeta,
  definitionForPhysicalSheet,
  requireValidBatchUpdateReply,
  runRead,
  runWrite,
  validateRoute,
  type GoogleSheetsApiProviderDeps,
} from "./shared.js";
import { observationTargetFor } from "./preflightOp.js";

/** Reads one registered table's literal values with one REST read. */
export async function readRows(
  deps: GoogleSheetsApiProviderDeps,
  request: ReadSyncTableRowsRequest,
): Promise<SyncTableRowsResult> {
  const [result] = await readRowsBatch(deps, [request]);
  if (result === undefined) {
    invalidProviderState("table read returned no result");
  }
  return result;
}

/**
 * Reads several registered tables through ONE `spreadsheets.get` call.
 * Results are returned in request order; a missing tab, header drift, or
 * malformed payload fails closed before any result is produced.
 */
export async function readRowsBatch(
  deps: GoogleSheetsApiProviderDeps,
  requests: readonly ReadSyncTableRowsRequest[],
): Promise<readonly SyncTableRowsResult[]> {
  if (requests.length === 0) return [];
  const routes = requests.map((request) => {
    const definition = definitionForPhysicalSheet(deps, request.physicalSheetId);
    validateRoute(request, definition);
    if (
      request.headers.length !== definition.headers.length ||
      request.headers.some((header, index) => header !== definition.headers[index])
    ) {
      throw new SyncSheetsContractError(
        SYNC_SHEETS_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
        "sync provider table read headers do not match the registered projection " +
        definition.sheet.physicalSheetId,
      );
    }
    return { request, definition };
  });
  const raw = await runRead(deps, () =>
    deps.transport.getSpreadsheet({
      spreadsheetId: deps.spreadsheetId,
      ranges: routes.map(({ request }) =>
        `${quoteA1SheetName(request.sheetName)}!A1:${rangeEndColumnLetters(request.registeredRange)}1048576`),
      fields: GOOGLE_SHEETS_API_VALUES_FIELDS,
      timeoutMs: deps.readTimeoutMs,
    }));
  const document = parseSpreadsheetDocument(raw, "table read");
  const results: SyncTableRowsResult[] = [];
  for (const { request, definition } of routes) {
    const sheet = document.sheets.find((candidate) => candidate.title === request.sheetName);
    if (sheet === undefined) {
      // A structurally valid GET can simply lack the requested tab; a generic
      // table read has no missing-tab taxonomy pair, so it keeps the safe
      // unclassified default.
      invalidProviderState(`Registered sync sheet does not exist: ${request.sheetName}`);
    }
    const grid = document.grids.get(sheet.sheetId);
    if (grid === undefined) {
      // The request explicitly required grid data for a present tab.
      invalidProviderState(`grid data is missing for sheet ${sheet.sheetId}`, GET_REPLY_MALFORMED);
    }
    const rows = buildTableRowsFromGrid(grid, {
      registeredRange: request.registeredRange,
      headers: definition.headers,
      ...(definition.physicalHeaders === undefined ? {} : { physicalHeaders: definition.physicalHeaders }),
      checkboxHeaders: definition.checkboxHeaders ?? [],
      anchorColumn: anchorColumnFor(request.registeredRange, request.projection),
    });
    results.push({
      sheetName: request.sheetName,
      registeredRange: request.registeredRange,
      headers: [...definition.headers],
      rows,
    });
  }
  return results;
}

/** Reads one full snapshot without any mutation (lock-free). */
export async function readSnapshot(
  deps: GoogleSheetsApiProviderDeps,
  request: ReadSyncSnapshotRequest,
): Promise<SyncSheetsSnapshot> {
  const target = observationTargetFor(deps, request);
  const tabs = await readObservedTabs(deps, [request]);
  const tab = tabs.get(request.sheetName);
  if (tab === undefined) {
    // A valid GET lacking the tab is a missing tab in generic observation
    // context, not a malformed reply: keep the unclassified default.
    invalidProviderState(`Registered sync sheet does not exist: ${request.sheetName}`);
  }
  return buildSnapshotFromTab(tab, target);
}

/** Combines anchor assignment and one snapshot read under one request. */
export async function observeSnapshot(
  deps: GoogleSheetsApiProviderDeps,
  request: ReadSyncSnapshotRequest,
): Promise<SyncObservedSnapshot> {
  const [observed] = await observeSnapshots(deps, [request]);
  if (observed === undefined) {
    invalidProviderState("observation returned no result");
  }
  return observed;
}

/**
 * Observes several projections with ONE grid read, ONE anchor write (when
 * any anchor is missing), and ONE re-read (when anchors were written), so
 * the committed anchors are reflected in every snapshot. The coordinator
 * already holds every involved mutation lane before this call.
 */
export async function observeSnapshots(
  deps: GoogleSheetsApiProviderDeps,
  requests: readonly ReadSyncSnapshotRequest[],
): Promise<readonly SyncObservedSnapshot[]> {
  if (requests.length === 0) return [];
  const targets = requests.map((request) => observationTargetFor(deps, request));
  const tabs = await readObservedTabs(deps, requests);

  const plans: {
    readonly request: ReadSyncSnapshotRequest;
    readonly target: SnapshotBuildTarget;
    tab: ObservedTab;
    readonly anchors: AnchorPlanResult;
  }[] = [];
  let assignedTotal = 0;
  for (let index = 0; index < requests.length; index += 1) {
    const request = requests[index];
    const target = targets[index];
    if (request === undefined || target === undefined) {
      invalidProviderState("observation request is unavailable");
    }
    const tab = tabs.get(request.sheetName);
    if (tab === undefined) {
      invalidProviderState(`Registered sync sheet does not exist: ${request.sheetName}`);
    }
    const anchors = planRowAnchors(tab, {
      registeredRange: request.registeredRange,
      headers: target.headers,
      ...(target.physicalHeaders === undefined ? {} : { physicalHeaders: target.physicalHeaders }),
      checkboxHeaders: target.checkboxHeaders,
      anchorColumn: target.anchorColumn,
    });
    assignedTotal += anchors.assigned;
    plans.push({ request, target, tab, anchors });
  }

  if (assignedTotal > 0) {
    // One atomic write for every planned anchor across all requested tabs:
    // updateCells on each tab's system row-id column.
    const anchorRequests: GoogleSheetsApiWriteRequest[] = [];
    for (const entry of plans) {
      const anchorColumn = entry.target.anchorColumn;
      if (anchorColumn === undefined) continue;
      for (const planned of entry.anchors.planned) {
        anchorRequests.push({
          kind: "updateCells",
          sheetId: entry.tab.sheetId,
          startRowIndex: planned.rowIndex,
          startColumnIndex: anchorColumn - 1,
          rows: [[{ userEnteredValue: { stringValue: planned.anchor } }]],
          fields: "userEnteredValue",
        });
      }
    }
    const response = await runWrite(deps, () =>
      deps.transport.batchUpdate({
        spreadsheetId: deps.spreadsheetId,
        requests: anchorRequests,
      }));
    requireValidBatchUpdateReply(response, anchorRequests.length);

    // One shared re-read so the committed anchors appear in the snapshots
    // (mirrors the Apps Script flush-while-locked behavior).
    const refreshed = await readObservedTabs(deps, requests);
    for (const entry of plans) {
      const tab = refreshed.get(entry.request.sheetName);
      if (tab === undefined) {
        invalidProviderState(`Registered sync sheet does not exist: ${entry.request.sheetName}`);
      }
      entry.tab = tab;
    }
  }

  return plans.map((entry) => ({
    anchors: {
      assigned: entry.anchors.assigned,
      existing: entry.anchors.existing,
      duplicateAnchors: entry.anchors.duplicateAnchors,
    },
    snapshot: buildSnapshotFromTab(entry.tab, entry.target),
  }));
}

/** Reads the target grids of one or more observation requests (one call). */
export async function readObservedTabs(
  deps: GoogleSheetsApiProviderDeps,
  requests: readonly {
    readonly sheetName: string;
    readonly registeredRange: string;
    readonly readMode?: SyncSnapshotReadMode;
  }[],
): Promise<ReadonlyMap<string, ObservedTab>> {
  // One getSpreadsheet call serves the whole batch with ONE mask: the
  // lighter user_input mask only when every request is lightweight (the
  // lightweight branch never consults merges or dataValidation; the full
  // mask is still correct for a mixed batch).
  const lightweight = requests.length > 0 && requests.every((request) =>
    request.readMode === SYNC_SNAPSHOT_READ_MODES.USER_INPUT);
  const fields = lightweight
    ? GOOGLE_SHEETS_API_LIGHTWEIGHT_OBSERVATION_FIELDS
    : GOOGLE_SHEETS_API_OBSERVATION_FIELDS;
  // The RAW transport document is measured (not the parsed Map result) so the
  // telemetry responseBytes reflect the true payload size for the
  // preflight-vs-polling read-gap question. The measurement is gated on the
  // telemetry sink exactly like runRead's own estimate: a logging-off
  // deployment must never stringify the multi-MB raw document.
  const capture = createRawResponseMeta(deps);
  const tabs = await runRead(deps, () =>
    readTabGrids(
      deps.transport,
      deps.spreadsheetId,
      requests.map((request) => ({
        sheetName: request.sheetName,
        registeredRange: request.registeredRange,
      })),
      fields,
      deps.readTimeoutMs,
      capture.onRawResponse,
    ), "polling", capture.meta);
  return tabs;
}

/** Builds the A1 range end letters for one registered range. */
function rangeEndColumnLetters(registeredRange: string): string {
  const range = parseRegisteredRange(registeredRange);
  return columnLetters(range.startColumn + range.columnCount - 1);
}
