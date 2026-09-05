/**
 * Row-anchor assignment for the Google Sheets API sync provider.
 *
 * Ensures every nonblank row of one registered tab carries an anchor in the
 * tab's LAST system column (a `sync-anchor:<uuid>` cell value), writing all
 * planned anchors in ONE atomic batchUpdate. Rows with more than one anchor
 * fail closed; duplicate anchors across rows are reported as evidence. A
 * user_input tab without the system column fails closed (legacy format); a
 * user-edited system cell is simply reassigned a fresh anchor. No re-read is
 * performed.
 */

import type {
  EnsureSyncRowAnchorsRequest,
  EnsureSyncRowAnchorsResult,
} from "@hikoutei/contracts/sheets/syncSheets.js";
import { invalidProviderState } from "../errors.js";
import type { GoogleSheetsApiWriteRequest } from "../transport/googleSheetsApiTransport.js";
import {
  planRowAnchors,
  type AnchorPlanResult,
  type ObservedTab,
} from "../model/observation.js";
import { anchorColumnFor } from "../model/preflightRows.js";
import {
  credentialBinding,
  definitionForPhysicalSheet,
  requireValidBatchUpdateReply,
  runWrite,
  validateRoute,
  type GoogleSheetsApiProviderDeps,
} from "./shared.js";
import { readObservedTabs } from "./readRows.js";

/**
 * Ensures every nonblank row of one registered tab carries a system-column
 * anchor, writing all planned anchors in ONE atomic batchUpdate. Rows with
 * more than one anchor fail closed; duplicate anchors across rows are
 * reported as evidence. No re-read is performed.
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
    // A valid GET lacking the tab is a missing tab in anchor context, not a
    // malformed reply: keep the safe unclassified default.
    invalidProviderState(`Registered sync sheet does not exist: ${request.sheetName}`);
  }
  const anchorColumn = anchorColumnFor(request.registeredRange, request.projection);
  const plan = planRowAnchors(tab, {
    registeredRange: request.registeredRange,
    headers: definition.headers,
    ...(definition.physicalHeaders === undefined ? {} : { physicalHeaders: definition.physicalHeaders }),
    checkboxHeaders: definition.checkboxHeaders ?? [],
    anchorColumn,
  });
  if (plan.planned.length > 0) {
    await writeAnchors(deps, tab, plan, anchorColumn);
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
  anchorColumn: number | undefined,
): Promise<void> {
  if (anchorColumn === undefined) return;
  const requests: GoogleSheetsApiWriteRequest[] = plan.planned.map((planned) => ({
    kind: "updateCells",
    sheetId: tab.sheetId,
    startRowIndex: planned.rowIndex,
    startColumnIndex: anchorColumn - 1,
    rows: [[{ userEnteredValue: { stringValue: planned.anchor } }]],
    fields: "userEnteredValue",
  }));
  const response = await runWrite(deps, (credentialIndex) =>
    deps.transport.batchUpdate({
      spreadsheetId: deps.spreadsheetId,
      requests,
      ...credentialBinding(credentialIndex),
    }));
  requireValidBatchUpdateReply(response, requests.length);
}
