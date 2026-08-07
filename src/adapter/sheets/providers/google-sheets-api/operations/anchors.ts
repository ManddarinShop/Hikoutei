/**
 * Row-anchor assignment for the Google Sheets API sync provider.
 *
 * Ensures every nonblank row of one registered tab carries a
 * developer-metadata anchor, writing all planned anchors in ONE atomic
 * batchUpdate. Rows with more than one anchor fail closed; duplicate anchors
 * across rows are reported as evidence. No re-read is performed.
 */

import type {
  EnsureSyncRowAnchorsRequest,
  EnsureSyncRowAnchorsResult,
} from "../../../../../application/sync/sheets/syncSheets.js";
import { GOOGLE_SHEETS_API_ANCHOR_KEY } from "../constants.js";
import { invalidProviderState } from "../errors.js";
import type { GoogleSheetsApiWriteRequest } from "../transport/googleSheetsApiTransport.js";
import {
  planRowAnchors,
  type AnchorPlanResult,
  type ObservedTab,
} from "../model/observation.js";
import {
  definitionForPhysicalSheet,
  requireValidBatchUpdateReply,
  runWrite,
  validateRoute,
  type GoogleSheetsApiProviderDeps,
} from "./shared.js";
import { readObservedTabs } from "./readRows.js";

/**
 * Ensures every nonblank row of one registered tab carries a
 * developer-metadata anchor, writing all planned anchors in ONE atomic
 * batchUpdate. Rows with more than one anchor fail closed; duplicate
 * anchors across rows are reported as evidence. No re-read is performed.
 */
export async function ensureRowAnchors(
  deps: GoogleSheetsApiProviderDeps,
  request: EnsureSyncRowAnchorsRequest,
): Promise<EnsureSyncRowAnchorsResult> {
  const definition = definitionForPhysicalSheet(deps, request.physicalSheetId);
  validateRoute(request, definition);
  const tabs = await readObservedTabs(deps, [request]);
  const tab = tabs.get(request.sheetName);
  if (tab === undefined) {
    invalidProviderState(`Registered sync sheet does not exist: ${request.sheetName}`);
  }
  const plan = planRowAnchors(tab, {
    registeredRange: request.registeredRange,
    headers: definition.headers,
    checkboxHeaders: definition.checkboxHeaders ?? [],
  });
  if (plan.planned.length > 0) {
    await writeAnchors(deps, tab, plan);
  }
  return {
    assigned: plan.assigned,
    existing: plan.existing,
    duplicateAnchors: plan.duplicateAnchors,
  };
}

/** Writes every planned anchor of one tab in one atomic batch. */
export async function writeAnchors(
  deps: GoogleSheetsApiProviderDeps,
  tab: ObservedTab,
  plan: AnchorPlanResult,
): Promise<void> {
  const requests: GoogleSheetsApiWriteRequest[] = plan.planned.map((planned) => ({
    kind: "createDeveloperMetadata",
    sheetId: tab.sheetId,
    rowIndex: planned.rowIndex,
    key: GOOGLE_SHEETS_API_ANCHOR_KEY,
    value: planned.anchor,
  }));
  const response = await runWrite(deps, () =>
    deps.transport.batchUpdate({
      spreadsheetId: deps.spreadsheetId,
      requests,
    }));
  requireValidBatchUpdateReply(response, requests.length);
}
