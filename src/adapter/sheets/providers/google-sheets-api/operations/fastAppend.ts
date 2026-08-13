/**
 * Fast-append operation for the Google Sheets API sync provider.
 *
 * Appends rows through one idempotent, atomic target+receipt batch: replay
 * rows are recognized through the receipt tab and verified against the
 * visible identity, pending rows pass the identity preflight, and a
 * byte-budget deferral commits only a prefix of the pending rows.
 */

import {
  computeSyncVisibleHash,
  type FastAppendRowsRequest,
  type FastAppendRowsResult,
  type FastAppendRow,
  type FastAppendRowResult,
} from "../../../../../application/sync/sheetsContract/syncSheets.js";
import {
  SYNC_SHEETS_ERROR_CODES,
  SyncSheetsContractError,
} from "../../../../../application/sync/sheetsContract/errors.js";
import { SYNC_FAST_APPEND_STATUSES } from "../../../../../application/sync/sheetsContract/constants.js";
import { absentValue } from "../../../../../shared/state/index.js";
import { isNormalizedCell } from "../../../../../shared/encoding/index.js";
import { GOOGLE_SHEETS_API_DEFAULTS } from "../constants.js";
import { invalidProviderRequest, invalidProviderState } from "../errors.js";
import { identityFromNormalizedCell } from "../model/valueNormalization.js";
import type { PreflightContext, PreflightRow } from "../model/preflightContext.js";
import type { PlannedReceipt, WorkingRow } from "../model/plannerContracts.js";
import {
  buildAppendBatchRequests,
  resolveAppendBudget,
} from "../model/batchBuilder.js";
import {
  definitionForPhysicalSheet,
  effectRouteOptions,
  requireValidBatchUpdateReply,
  runWrite,
  validateRoute,
  type GoogleSheetsApiProviderDeps,
} from "./shared.js";
import { readPreflight } from "./preflightOp.js";

/** Appends rows through one idempotent, atomic target+receipt batch. */
export async function fastAppendRows(
  deps: GoogleSheetsApiProviderDeps,
  request: FastAppendRowsRequest,
): Promise<FastAppendRowsResult> {
  const definition = definitionForPhysicalSheet(deps, request.physicalSheetId);
  validateRoute(request, definition);
  const routeOptions = effectRouteOptions(definition);
  if (routeOptions.identityField.kind !== "present") {
    // The fast path never materializes anchor metadata, so a route without
    // a registered identity cannot locate or guard its rows on replay.
    throw new SyncSheetsContractError(
      SYNC_SHEETS_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
      "fast append requires a registered identityField for route " + request.physicalSheetId,
    );
  }
  if (request.rows.length === 0) {
    invalidProviderRequest("fast append", "rows must not be empty");
  }
  const bounded = request.rows.slice(0, GOOGLE_SHEETS_API_DEFAULTS.MAX_APPEND_ROWS_PER_REQUEST);
  validateAppendRows(bounded);
  const context = await readPreflight(deps, request, definition, routeOptions);
  validateAppendRowsAgainstHeaders(bounded, context.headers);
  const identityField = routeOptions.identityField.value;

  // Replay rows are recognized through the receipt tab and verified against
  // the visible identity; pending rows go through the identity preflight.
  const pending: FastAppendRow[] = [];
  const resultsById = new Map<string, FastAppendRowResult>();
  const pendingReceipts: PlannedReceipt[] = [];
  for (const row of bounded) {
    // The worker always supplies the outbox payload hash; fail closed when
    // it is absent instead of silently falling back to the effect ID.
    const payloadHash = row.payloadHash;
    if (payloadHash === undefined || payloadHash.length === 0) {
      invalidProviderRequest(
        "fast append",
        `payloadHash is required for effectId: ${row.effectId}`,
      );
    }
    const existing = context.receipts.get(row.effectId);
    if (existing !== undefined) {
      if (existing.payloadHash !== payloadHash) {
        invalidProviderRequest(
          "fast append",
          `effect ID cannot be reused with another payload: ${row.effectId}`,
        );
      }
      const identity = appendIdentity(row, identityField);
      const existingRow = findRowByIdentity(context, identity);
      if (existingRow === undefined) {
        invalidProviderRequest(
          "fast append",
          `receipt postcondition row is unavailable for effectId: ${row.effectId}`,
        );
      }
      if (computeSyncVisibleHash(existingRow.cells) !== existing.visibleHash) {
        invalidProviderRequest(
          "fast append",
          `receipt postcondition changed for effectId: ${row.effectId}`,
        );
      }
      resultsById.set(row.effectId, {
        effectId: row.effectId,
        status: SYNC_FAST_APPEND_STATUSES.APPLIED,
        visibleHash: existing.visibleHash,
        visibleRevision: existing.visibleRevision,
      });
      continue;
    }
    pending.push(row);
    pendingReceipts.push(makeAppendReceipt(row.effectId, payloadHash, computeSyncVisibleHash(row.fields)));
  }

  // Mirror the built-in append identity preflight: the registered identity
  // must exist and be unique across the sheet and the pending batch; replay
  // entries are exempt exactly like the real provider.
  let deferredSuffix = false;
  if (pending.length > 0) {
    assertAppendIdentityAvailability(context, identityField, pending);
    const pendingRows: WorkingRow[] = pending.map((row, index) =>
      toAppendWorkingRow(row, context.nextAppendRow + index));
    const updatedAt = new Date(deps.now()).toISOString();
    const resolution = resolveAppendBudget(
      pendingRows,
      (count) => buildAppendBatchRequests(
        context,
        pendingRows.slice(0, count),
        pendingReceipts.slice(0, count),
        { updatedAt },
      ),
      deps.maxBatchBytes,
    );
    deferredSuffix = resolution.includeCount < pending.length;
    if (resolution.includeCount > 0) {
      const batch = buildAppendBatchRequests(
        context,
        pendingRows.slice(0, resolution.includeCount),
        pendingReceipts.slice(0, resolution.includeCount),
        { updatedAt },
      );
      const response = await runWrite(deps, () =>
        deps.transport.batchUpdate({
          spreadsheetId: deps.spreadsheetId,
          requests: batch.requests,
        }));
      requireValidBatchUpdateReply(response, batch.requests.length);
      pendingReceipts.slice(0, resolution.includeCount).forEach((receipt) => {
        resultsById.set(receipt.effectId, {
          effectId: receipt.effectId,
          status: SYNC_FAST_APPEND_STATUSES.APPLIED,
          visibleHash: receipt.visibleHash,
          visibleRevision: receipt.visibleRevision,
        });
      });
    }
  }

  // A byte-budget deferral commits only a prefix of the pending rows, so
  // results cover exactly the processed rows: receipt-matched replays plus
  // the included prefix. Rows beyond the included prefix are intentionally
  // absent from results; the worker releases them (releaseUnprocessedEffect)
  // for the next pass when hasMore is true.
  const results: FastAppendRowResult[] = [];
  for (const row of bounded) {
    const result = resultsById.get(row.effectId);
    if (result === undefined) continue;
    results.push(result);
  }
  return {
    results,
    hasMore: bounded.length < request.rows.length || deferredSuffix,
  };
}

/** Builds the fixed-shape receipt record used by the fast-append path. */
function makeAppendReceipt(effectId: string, payloadHash: string, visibleHash: string): PlannedReceipt {
  return {
    effectId,
    payloadHash,
    status: "applied",
    visibleHash,
    visibleRevision: 1,
  };
}

/** Validates the append rows before any remote read or write. */
function validateAppendRows(rows: readonly FastAppendRow[]): void {
  const seenEffectIds = new Set<string>();
  for (const row of rows) {
    if (row.effectId.length === 0 || seenEffectIds.has(row.effectId)) {
      invalidProviderRequest("fast append", "effectIds must be non-empty and unique");
    }
    seenEffectIds.add(row.effectId);
    const payloadHash = row.payloadHash;
    if (payloadHash === undefined || payloadHash.length === 0) {
      invalidProviderRequest("fast append", "payloadHash is required");
    }
    if (row.anchor !== undefined && row.anchor.length === 0) {
      invalidProviderRequest("fast append", "row anchor must be non-empty");
    }
    const fields = row.fields;
    if (fields === null || typeof fields !== "object" || Array.isArray(fields)) {
      invalidProviderRequest("fast append", "row fields must be an object");
    }
    if (Object.keys(fields).length === 0) {
      invalidProviderRequest("fast append", "row fields are required");
    }
    for (const value of Object.values(fields)) {
      if (!isNormalizedCell(value)) {
        invalidProviderRequest("fast append", "row fields contain an invalid normalized cell");
      }
    }
  }
}

/** Append rows must cover exactly the registered headers (batch append rule). */
function validateAppendRowsAgainstHeaders(
  rows: readonly FastAppendRow[],
  headers: readonly string[],
): void {
  const expected = [...headers].sort();
  for (const row of rows) {
    const actual = Object.keys(row.fields).sort();
    if (
      actual.length !== expected.length ||
      actual.some((field, index) => field !== expected[index])
    ) {
      invalidProviderRequest("fast append", "rows must contain exactly the registered headers");
    }
  }
}

/**
 * Derives the append identity from the row's identity field cell, using the
 * canonical identity rule (non-empty string or finite number) shared with
 * the append/replay paths.
 */
function appendIdentity(row: FastAppendRow, identityField: string): string {
  const cell = row.fields[identityField] ?? null;
  const identity = identityFromNormalizedCell(cell);
  if (identity === null) {
    invalidProviderRequest("fast append", `sync identity is required for append: ${identityField}`);
  }
  return identity;
}

/** Finds a preflight row by its visible identity (single match or fail closed). */
function findRowByIdentity(context: PreflightContext, identity: string): PreflightRow | undefined {
  const matches = context.rows.filter((row) =>
    row.identity.kind === "present" && row.identity.value === identity);
  if (matches.length > 1) {
    invalidProviderState(`sync identity is duplicated: ${identity}`);
  }
  return matches[0];
}

/**
 * Mirrors the built-in append identity preflight: every existing data row
 * needs a unique identity, and every pending non-replay row needs a fresh,
 * non-empty identity.
 */
function assertAppendIdentityAvailability(
  context: PreflightContext,
  identityField: string,
  pending: readonly FastAppendRow[],
): void {
  const existing = new Map<string, string>();
  context.rows.forEach((row) => {
    if (row.identity.kind !== "present") {
      invalidProviderState(`sync identity is missing at row ${row.rowNumber}`);
    }
    const location = existing.get(row.identity.value);
    if (location !== undefined) {
      invalidProviderState(
        `sync identity is duplicated: ${row.identity.value} at rows ${location} and ${row.rowNumber}`,
      );
    }
    existing.set(row.identity.value, String(row.rowNumber));
  });
  for (const row of pending) {
    const identity = appendIdentity(row, identityField);
    const location = existing.get(identity);
    if (location !== undefined) {
      invalidProviderState(`sync identity already exists: ${identity} at ${location}`);
    }
    existing.set(identity, "pending");
  }
}

/** Builds a working row for one pending append at its reserved position. */
function toAppendWorkingRow(row: FastAppendRow, rowNumber: number): WorkingRow {
  // The fast path never materializes anchor metadata (the Apps Script batch
  // append path ignores the advisory row anchor); the row replays by identity.
  return {
    rowNumber,
    anchor: absentValue(),
    cells: { ...row.fields },
    identity: absentValue(),
    appended: true,
    deleted: false,
    writeFields: {},
  };
}
