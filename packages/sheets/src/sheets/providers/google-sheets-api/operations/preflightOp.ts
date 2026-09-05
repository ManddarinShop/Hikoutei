/**
 * Preflight and observation-target operations for the Google Sheets API
 * sync provider.
 *
 * `readPreflight` performs the paced transport calls every outbound effect
 * operation needs (range-less sheet enumeration for hidden receipt tab
 * discovery, plus the bounded data read of the target and receipt tabs —
 * one reassembled logical read that the unified read engine expands into
 * sequential paced band requests when a tab's authoritative row bound
 * forces chunking).
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
import { invalidProviderState, GET_REPLY_MALFORMED } from "../errors.js";
import {
  GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES,
  GoogleSheetsApiTransportError,
} from "../errors.js";
import {
  GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME,
  GOOGLE_SHEETS_API_MISSING_RANGE_REMOTE_CODE,
} from "../constants.js";
import {
  GOOGLE_SHEETS_API_PREFLIGHT_BASE_FIELDS,
  GOOGLE_SHEETS_API_PREFLIGHT_FIELDS,
} from "../model/preflightFields.js";
import type { PreflightReadShape } from "../model/preflightContext.js";
import {
  enumerateSheetProperties,
  readPreflightData,
  readPreflightDataForRoutes,
  readReceiptsAggregate,
  type ParsedSheet,
  type ParsedSpreadsheetDocument,
  type PreflightContext,
} from "../model/preflightContext.js";
import { packReadRequests, planRowBands, type PlannedRange } from "../model/readPlan.js";
import {
  patchPreflightContext,
  planPreflightVerification,
} from "../model/preflightVerify.js";
import {
  anchorColumnFor,
  findSheetByTitle,
} from "../model/preflightRows.js";
import { parseSpreadsheetDocument } from "../model/preflightParsing.js";
import { createBandedGet, createEngineRuntime } from "./readEngine.js";
import { quoteA1SheetName } from "../model/valueNormalization.js";
import type { GoogleSheetsApiGetSpreadsheetRequest } from "../transport/googleSheetsApiTransport.js";
import type { SnapshotBuildTarget } from "../model/observation.js";
import {
  createRawResponseMeta,
  credentialBinding,
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
  fields: string = GOOGLE_SHEETS_API_PREFLIGHT_FIELDS,
  /**
   * `scoped`: steady-state fast-append base read — target tabs contribute
   * only the header row and the tab-wide key columns (identity/anchor
   * bands). `receiptCursor`: read the receipt tab through this provider's
   * tail-band cursor (same paced request, never an extra call). Defaults to
   * the historical whole-table full-evidence shape WITH the receipt cursor;
   * the postcondition-recovery probe rides the cursor too, and every
   * whole-table fallback/evidence gap answers with an explicit
   * `receiptCursor: false` full read (see `readEffectPostconditions`).
   */
  options: { readonly scoped?: boolean; readonly receiptCursor?: boolean } = {},
): Promise<PreflightContext> {
  const shape: PreflightReadShape = {
    scoped: options.scoped === true,
    ...(options.receiptCursor === false
      ? {}
      : { cursor: deps.receiptReadCursor }),
  };
  // Each preflight performs a range-less sheet enumeration (hidden receipt
  // tab discovery) plus the ranged data read; the engine paces and measures
  // EACH band request of the data read separately (zero estimate cost
  // without a telemetry sink).
  const enumeration = createRawResponseMeta(deps);
  const sheets = await runRead(deps, (credentialIndex) =>
    enumerateSheetProperties(deps.transport, deps.spreadsheetId, deps.readTimeoutMs,
      enumeration.onRawResponse, credentialIndex), pacing, enumeration.meta);
  return readPreflightData(
    createEngineRuntime(deps, pacing, "preflight data"),
    {
      spreadsheetId: deps.spreadsheetId,
      sheetName: request.sheetName,
      registeredRange: request.registeredRange,
      headers: definition.headers,
      ...(definition.physicalHeaders === undefined ? {} : { physicalHeaders: definition.physicalHeaders }),
      identityField: routeOptions.identityField,
      checkboxHeaders: routeOptions.checkboxHeaders,
      projection: definition.sheet.projection,
    }, sheets, fields, shape);
}

/**
 * One route's read inputs for the shared (multi-route) preflight and for the
 * scoped verification pass's whole-table recovery read.
 */
export interface PreflightRouteInput {
  readonly sheetName: string;
  readonly registeredRange: string;
  readonly definition: RegisteredSyncProjectionDefinition;
  readonly routeOptions: {
    readonly identityField: Presence<string>;
    readonly checkboxHeaders: readonly string[];
  };
}

/**
 * The paced, range-less sheet enumeration ONE preflight dispatch shares.
 *
 * The base data read and any whole-table full-evidence recovery read are
 * built from this same sheet list, so a verification-overflow fallback can
 * never stack a second enumeration onto the leased request budget.
 */
export async function enumeratePreflightSheets(
  deps: GoogleSheetsApiProviderDeps,
  pacing: RequestStartPacing = "preflight",
): Promise<readonly ParsedSheet[]> {
  const enumeration = createRawResponseMeta(deps);
  return runRead(deps, (credentialIndex) =>
    enumerateSheetProperties(deps.transport, deps.spreadsheetId, deps.readTimeoutMs,
      enumeration.onRawResponse, credentialIndex), pacing, enumeration.meta);
}

/** Maps route inputs to the model-level per-route preflight options. */
function toPreflightRoutes(
  deps: GoogleSheetsApiProviderDeps,
  routes: readonly PreflightRouteInput[],
) {
  return routes.map((route) => ({
    spreadsheetId: deps.spreadsheetId,
    sheetName: route.sheetName,
    registeredRange: route.registeredRange,
    headers: route.definition.headers,
    ...(route.definition.physicalHeaders === undefined ? {} : { physicalHeaders: route.definition.physicalHeaders }),
    identityField: route.routeOptions.identityField,
    checkboxHeaders: route.routeOptions.checkboxHeaders,
    projection: route.definition.sheet.projection,
  }));
}

/**
 * Reads the target and receipt tabs for MANY routes from an ALREADY
 * ENUMERATED sheet list with ONE ranged data call (see
 * `enumeratePreflightSheets` for why callers hold onto the enumeration).
 * Same contract and defaults as `readPreflightForRoutes`, minus its
 * enumeration call.
 */
export async function readPreflightDataForEnumeratedRoutes(
  deps: GoogleSheetsApiProviderDeps,
  sheets: readonly ParsedSheet[],
  routes: readonly PreflightRouteInput[],
  operation?: SyncMissingTabOperation,
  pacing: RequestStartPacing = "preflight",
  fields: string = GOOGLE_SHEETS_API_PREFLIGHT_FIELDS,
  options: { readonly scoped?: boolean; readonly receiptCursor?: boolean } = {},
): Promise<ReadonlyMap<string, PreflightContext>> {
  const shape: PreflightReadShape = {
    scoped: options.scoped === true,
    ...(options.receiptCursor === false
      ? {}
      : { cursor: deps.receiptReadCursor }),
  };
  // Same per-band raw-document measurement as the single-route preflight
  // (the engine emits one paced, telemetry-carrying request per band).
  return readPreflightDataForRoutes(
    createEngineRuntime(deps, pacing, "preflight data"),
    toPreflightRoutes(deps, routes),
    sheets,
    operation,
    fields,
    shape,
  );
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
  routes: readonly PreflightRouteInput[],
  operation?: SyncMissingTabOperation,
  pacing: RequestStartPacing = "preflight",
  fields: string = GOOGLE_SHEETS_API_PREFLIGHT_FIELDS,
  /** Scoped/cursor read-shape options (see `readPreflight`). */
  options: { readonly scoped?: boolean; readonly receiptCursor?: boolean } = {},
): Promise<ReadonlyMap<string, PreflightContext>> {
  const sheets = await enumeratePreflightSheets(deps, pacing);
  return readPreflightDataForEnumeratedRoutes(
    deps, sheets, routes, operation, pacing, fields, options,
  );
}

/**
 * One route's scoped verification pass over a base (values-only) preflight
 * context.
 *
 * `targetRowNumbers` are the existing rows whose CAS/replay hashes the
 * planner or the fast-append path will compute, collected against the base
 * indexes as an over-approximation. Bands of every pass are packed and
 * executed together by `verifyPreflightContexts` through the unified read
 * engine (an over-budget plan expands into additional sequential band
 * requests; correctness never depends on the packing).
 */
export interface PreflightVerifyPass {
  readonly context: PreflightContext;
  readonly targetRowNumbers: readonly number[];
}

/**
 * Runs the scoped verification reads for one or more routes through the
 * unified read engine (row bands + conditional identity-column band, values
 * plus BOTH number-format sources), then patches each base context from its
 * sheet's per-range grid list.
 *
 * Every banded row's value and formats come from ONE band request (one
 * server snapshot), so a verification hash is never a mixed base/overlay
 * snapshot. The pre-engine "ANY route overflows the range budget → skip the
 * bands and resolve EVERYTHING through ONE uncapped whole-table
 * full-evidence read" fallback is REMOVED: all routes' bands are packed
 * into as FEW sequential paced requests as the 40-range and byte-estimate
 * budget allows, each request individually bounded, so an oversized plan
 * costs additional slots on the lane instead of a guaranteed-timeout 16 MB
 * single request. Correctness never depends on the packing: every hashed
 * cell still sits in exactly one band, and `patchPreflightContext`'s anchor
 * revalidation blanks rows shifted between snapshots fail-closed exactly
 * like a shift between the base and a single verification read.
 */
export async function verifyPreflightContexts(
  deps: GoogleSheetsApiProviderDeps,
  passes: readonly PreflightVerifyPass[],
  pacing: RequestStartPacing = "preflight",
): Promise<readonly PreflightContext[]> {
  const results: (PreflightContext | undefined)[] = passes.map(() => undefined);
  const shared: { readonly index: number }[] = [];
  const items: PlannedRange[] = [];
  passes.forEach((pass, index) => {
    // A non-scoped base context (receipt-init downgrade, key-row-gap
    // fallback, or a full-evidence recovery result) already carries
    // whole-table full-evidence rows: a verification read would add a paced
    // call with nothing to add. Only a values-only scoped base needs the
    // band read.
    if (!pass.context.scopedBase) {
      results[index] = pass.context;
      return;
    }
    const plan = planPreflightVerification(pass.context, pass.targetRowNumbers, deps.readCalibration);
    if (plan.kind === "none") {
      results[index] = pass.context;
      return;
    }
    items.push(...plan.items);
    shared.push({ index });
  });
  if (shared.length > 0) {
    const get = createBandedGet(
      deps, pacing, GOOGLE_SHEETS_API_PREFLIGHT_FIELDS, "values+formats",
      "preflight verification",
    );
    const dataDocument = await get(
      packReadRequests(items, "values+formats", deps.readCalibration),
    );
    for (const entry of shared) {
      const pass = passes[entry.index]!;
      const grids = dataDocument.grids.get(pass.context.sheetId);
      if (grids === undefined) {
        invalidProviderState(
          `preflight verification grid data is missing for sheet ${pass.context.sheetId}`,
          GET_REPLY_MALFORMED,
        );
      }
      results[entry.index] = patchPreflightContext(
        pass.context,
        grids,
        pass.targetRowNumbers,
        { includeIdentityBand: pass.context.identityNeedsFormatEvidence },
      );
    }
  }
  return results.map((result) => {
    if (result !== undefined) return result;
    invalidProviderState("preflight verification resolved no context for a pass");
  });
}

/** Single-route convenience wrapper around `verifyPreflightContexts`. */
export async function verifyPreflightContext(
  deps: GoogleSheetsApiProviderDeps,
  context: PreflightContext,
  targetRowNumbers: readonly number[],
  pacing: RequestStartPacing = "preflight",
): Promise<PreflightContext> {
  const [patched] = await verifyPreflightContexts(
    deps,
    [{ context, targetRowNumbers }],
    pacing,
  );
  if (patched === undefined) {
    invalidProviderState("preflight verification returned no context");
  }
  return patched;
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
    // Receipts are plain values forever: no format field is ever consulted
    // on the receipt tab, so the refresh stays on the values-only base mask.
    fields: GOOGLE_SHEETS_API_PREFLIGHT_BASE_FIELDS,
    ...(deps.readTimeoutMs === undefined ? {} : { timeoutMs: deps.readTimeoutMs }),
  };
  let dataDocument: ParsedSpreadsheetDocument;
  try {
    const dataRaw = await runRead(deps, (credentialIndex) => deps.transport.getSpreadsheet({
      ...dataRequest,
      ...credentialBinding(credentialIndex),
    }), "write");
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
  const receiptGrids = dataDocument.grids.get(receiptSheet.sheetId) ?? [];
  // Aggregate parse (same cross-band header/duplicate contract the banded
  // steady-state reads use). The refresh reply is one bounded-by-
  // construction request: the tab was ABSENT in this dispatch's own
  // enumeration, so a concurrently created tab holds at most one appended
  // batch and needs no chunking.
  const parsedReceipts = readReceiptsAggregate(receiptGrids);
  const cursor = deps.receiptReadCursor;
  // A full receipt parse covers every receipt row: merge it into the
  // cumulative memo and re-base the cursor at the verified tail so the next
  // steady-state preflight reads only the band.
  if (!cursor.mergeParsed(parsedReceipts.receipts)) {
    invalidProviderState(
      "receipt tab changed underneath this provider: effectId reappeared with different evidence",
    );
  }
  cursor.advanceTo(parsedReceipts.lastRow);
  if (cursor.isOverCapacity()) cursor.reset();
  return {
    ...context,
    receiptSheetId: presentValue(receiptSheet.sheetId),
    receiptLastRow: parsedReceipts.lastRow,
    receiptFirstRow: parsedReceipts.firstParsedRow,
    receipts: cursor.isEmpty() ? parsedReceipts.receipts : cursor.memoView(),
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
