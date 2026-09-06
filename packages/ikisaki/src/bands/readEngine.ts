/**
 * Unified read engine executor (design/unified-read-engine.md §3).
 *
 * Runs an already-packed band plan as SEQUENTIAL paced `spreadsheets.get`
 * requests on the lane's request-start class and reassembles the replies
 * into one logical document: every requested range's GridData in request
 * order, concatenated per sheet id, so lanes consume band replies through
 * the SAME accessors (`resolveGridCell`, `synthesizeScopedTargetGrid`,
 * `pickRegisteredGrid`) that serve today's multi-range replies. Each band
 * is one server snapshot and consumes exactly one `runRead` slot, so:
 * - telemetry emits ONE event per band with the RAW-document `responseBytes`
 *   (sink-gated exactly like the historical reads) — per-lane, per-band
 *   bytes are observable without any extra plumbing;
 * - a timeout or rejection fails ONE band with the existing
 *   delivery-uncertain classification instead of an all-or-nothing
 *   multi-megabyte single request;
 * - every response's `sheets.properties.gridProperties.rowCount` refreshes
 *   the provider-instance authoritative bounds cache (a ranged GET returns
 *   properties for the intersecting sheets), and `responseBytes ÷
 *   cellsRequested` feeds the per-evidence calibration multiplier, so a
 *   mispredicted band size shrinks the NEXT pass's bands.
 */

import type {
  ParsedGridData,
  ParsedSheet,
  ParsedSpreadsheetDocument,
} from "../model/preflightContext.js";
import type {
  BandedGet,
  EngineRuntime,
  PlannedRange,
  ReadEvidence,
} from "../model/readPlan.js";
import { enumerateSheetProperties } from "../model/preflightContext.js";
import { parseSpreadsheetDocument } from "../model/preflightParsing.js";
import {
  createRawResponseMeta,
  credentialBinding,
  runRead,
  type GoogleSheetsApiProviderDeps,
  type RequestStartPacing,
} from "./shared.js";

/**
 * Builds the executor for ONE logical read: fixed field mask, evidence
 * class, pacing lane, and telemetry label. The returned closure owns no
 * state — bounds/calibration updates land on the shared `deps` carriers.
 */
export function createBandedGet(
  deps: GoogleSheetsApiProviderDeps,
  pacing: RequestStartPacing,
  fields: string,
  evidence: ReadEvidence,
  label: string,
): BandedGet {
  return async (requests) => {
    const sheetsByTitle = new Map<string, ParsedSheet>();
    const grids = new Map<number, ParsedGridData[]>();
    let executed = 0;
    let bytes = 0;
    for (const request of requests) {
      if (request.length === 0) continue;
      const ranges = request.map((item) => item.range);
      const cells = request.reduce((total, item) => total + item.cells, 0);
      // The RAW document is measured INSIDE the paced task (the awaited-call
      // ordering the historical reads proved): runRead emits its telemetry
      // event when the task resolves, so a later measurement would land one
      // event too late.
      const rawMeta = createRawResponseMeta(deps);
      const raw = await runRead(deps, async (credentialIndex) => {
        const response = await deps.transport.getSpreadsheet({
          spreadsheetId: deps.spreadsheetId,
          ranges,
          fields,
          ...(deps.readTimeoutMs === undefined ? {} : { timeoutMs: deps.readTimeoutMs }),
          ...credentialBinding(credentialIndex),
        });
        rawMeta.onRawResponse?.(response);
        return response;
      }, pacing, rawMeta.meta);
      executed += 1;
      const document = parseSpreadsheetDocument(raw, label);
      for (const sheet of document.sheets) {
        // Last-seen properties win (fresher grid metadata); consumers only
        // read identity/merges from this list, grid data lives in `grids`.
        sheetsByTitle.set(sheet.title, sheet);
        const rowCount = sheet.gridProperties?.rowCount;
        if (rowCount !== undefined) deps.sheetRowBounds.set(sheet.title, rowCount);
      }
      for (const [sheetId, list] of document.grids) {
        const existing = grids.get(sheetId);
        if (existing === undefined) grids.set(sheetId, [...list]);
        else existing.push(...list);
      }
      if (rawMeta.meta.responseBytes !== undefined) {
        bytes += rawMeta.meta.responseBytes;
        deps.readCalibration.observe(evidence, cells, rawMeta.meta.responseBytes);
      }
    }
    const document: ParsedSpreadsheetDocument & {
      readonly requests: number;
      readonly bytes: number;
    } = {
      sheets: [...sheetsByTitle.values()],
      grids,
      requests: executed,
      bytes,
    };
    return document;
  };
}

/**
 * Builds the model-facing engine runtime for one logical read on one lane:
 * the fields/evidence → executor factory plus the shared bounds cache and
 * calibration tracker. Model functions receive this instead of a raw
 * transport, which is what lets a single logical read expand into
 * sequential paced band requests WITHOUT the model layer importing the
 * operations layer.
 */
export function createEngineRuntime(
  deps: GoogleSheetsApiProviderDeps,
  pacing: RequestStartPacing,
  label: string,
): EngineRuntime {
  return {
    makeGet: (fields, evidence) => createBandedGet(deps, pacing, fields, evidence, label),
    rowBounds: deps.sheetRowBounds,
    calibration: deps.readCalibration,
  };
}

/**
 * Ensures every listed tab has an authoritative row bound in the
 * provider-instance cache, settling cold titles with ONE range-less
 * metadata enumeration (`gridProperties.rowCount` is metadata-only). The
 * cache is refreshed by every subsequent engine response's sheet
 * properties, so the enumeration is a once-per-title-per-instance cost —
 * the polling lane has no per-dispatch enumeration of its own and this is
 * where its committed upper bound comes from.
 */
export async function ensureSheetRowBounds(
  deps: GoogleSheetsApiProviderDeps,
  pacing: RequestStartPacing,
  titles: readonly string[],
): Promise<void> {
  if (titles.every((title) => deps.sheetRowBounds.has(title))) return;
  const enumeration = createRawResponseMeta(deps);
  const sheets = await runRead(deps, (credentialIndex) =>
    enumerateSheetProperties(
      deps.transport, deps.spreadsheetId, deps.readTimeoutMs, enumeration.onRawResponse,
      credentialIndex,
    ), pacing, enumeration.meta);
  for (const sheet of sheets) {
    const rowCount = sheet.gridProperties?.rowCount;
    if (rowCount !== undefined) deps.sheetRowBounds.set(sheet.title, rowCount);
  }
}
