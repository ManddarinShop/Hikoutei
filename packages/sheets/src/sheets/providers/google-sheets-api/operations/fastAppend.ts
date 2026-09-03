/**
 * Fast-append operation for the Google Sheets API sync provider.
 *
 * Appends rows through one idempotent, atomic target+receipt batch: replay
 * rows are recognized through the receipt tab and verified against the
 * visible identity, pending rows pass the identity preflight, and a
 * byte-budget deferral commits only a prefix of the pending rows.
 *
 * Phase 1 of the batch-merge work: a single fast-append request may now
 * span MULTIPLE tabs. Rows carry an optional route (the dispatcher fills it
 * from each pending effect), and when they do the provider groups them by
 * route, reads all needed tabs with ONE enumeration + ONE ranged read, and
 * emits ONE batchUpdate whose requests target the different tabs' sheetIds.
 * Single-tab requests (rows without route fields) keep the legacy
 * byte-identical path.
 */

import {
  computeSyncVisibleHash,
  type FastAppendRowsRequest,
  type FastAppendRowsResult,
  type FastAppendRow,
  type FastAppendRowResult,
  type SyncProjection,
} from "@hikoutei/contracts/sheets/syncSheets.js";
import {
  SYNC_INVALID_PROVIDER_OPERATIONS,
  SYNC_INVALID_PROVIDER_REASONS,
  SYNC_SHEETS_ERROR_CODES,
  SyncSheetsContractError,
} from "@hikoutei/contracts/sheets/errors.js";
import { SYNC_FAST_APPEND_STATUSES } from "@hikoutei/contracts/sheets/constants.js";
import { absentValue, PRESENCE_KINDS, type Presence } from "@hikoutei/contracts/state/index.js";
import { isNormalizedCell } from "@hikoutei/contracts/encoding/index.js";
import { GOOGLE_SHEETS_API_DEFAULTS } from "../constants.js";
import { invalidProviderRequest, invalidProviderState } from "../errors.js";
import { identityFromNormalizedCell } from "../model/valueNormalization.js";
import type { PreflightContext, PreflightRow } from "../model/preflightContext.js";
import type { PlannedReceipt, WorkingRow } from "../model/plannerContracts.js";
import {
  buildAppendBatchRequests,
  buildCombinedAppendRequests,
  resolveAppendBudget,
  type CombinedAppendRoute,
} from "../model/batchBuilder.js";
import {
  definitionForPhysicalSheet,
  effectRouteOptions,
  requireValidBatchUpdateReply,
  runWrite,
  validateRoute,
  type GoogleSheetsApiProviderDeps,
} from "./shared.js";
import {
  enumeratePreflightSheets,
  readPreflightDataForEnumeratedRoutes,
  refreshReceiptForWrite,
  verifyPreflightContext,
  verifyPreflightContexts,
  type PreflightRouteInput,
} from "./preflightOp.js";
import { GOOGLE_SHEETS_API_PREFLIGHT_BASE_FIELDS } from "../model/preflightFields.js";
import { identitySerialAliases } from "../model/preflightVerify.js";
import type { RegisteredSyncProjectionDefinition } from "@hikoutei/contracts/sheets/sheetsProvisioning.js";

/** Appends rows through one idempotent, atomic target+receipt batch. */
export async function fastAppendRows(
  deps: GoogleSheetsApiProviderDeps,
  request: FastAppendRowsRequest,
): Promise<FastAppendRowsResult> {
  if (request.rows.length === 0) {
    invalidProviderRequest("fast append", "rows must not be empty");
  }
  const bounded = request.rows.slice(0, GOOGLE_SHEETS_API_DEFAULTS.MAX_APPEND_ROWS_PER_REQUEST);
  validateAppendRows(bounded);
  const groups = groupRowsByRoute(request, bounded);
  if (groups.length === 1) {
    const single = groups[0]!;
    const first = single[0];
    // The legacy single-tab path is only valid when the single group's
    // effective route matches the request-level route. When rows carry
    // per-row route overrides that point elsewhere, route through the
    // combined path so the overridden tab is targeted, not the top-level one.
    if (first !== undefined && rowRouteKey(request, first) === requestRouteKey(request)) {
      return fastAppendSingleRoute(deps, request, bounded);
    }
  }
  return fastAppendMultiRoute(deps, request, bounded, groups);
}

/**
 * Groups rows by their own route (falling back to the request route when a
 * row carries no route fields, the legacy single-tab shape).
 */
function groupRowsByRoute(
  request: FastAppendRowsRequest,
  rows: readonly FastAppendRow[],
): readonly (readonly FastAppendRow[])[] {
  const groups = new Map<string, FastAppendRow[]>();
  for (const row of rows) {
    const key = rowRouteKey(request, row);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [row]);
    } else {
      group.push(row);
    }
  }
  return [...groups.values()];
}

function rowRouteKey(request: FastAppendRowsRequest, row: FastAppendRow): string {
  return [
    row.physicalSheetId ?? request.physicalSheetId,
    row.projection ?? request.projection,
    row.sheetName ?? request.sheetName,
    row.registeredRange ?? request.registeredRange,
    row.schemaVersion ?? request.schemaVersion,
  ].join("\u0000");
}

/** The request-level route key (no per-row overrides). */
function requestRouteKey(request: FastAppendRowsRequest): string {
  return [
    request.physicalSheetId,
    request.projection,
    request.sheetName,
    request.registeredRange,
    request.schemaVersion,
  ].join("\u0000");
}

/** The route fields one row belongs to (row overrides, then request). */
function rowRoute(request: FastAppendRowsRequest, row: FastAppendRow): {
  readonly physicalSheetId: string;
  readonly projection: SyncProjection;
  readonly sheetName: string;
  readonly registeredRange: string;
  readonly schemaVersion: number;
} {
  return {
    physicalSheetId: row.physicalSheetId ?? request.physicalSheetId,
    projection: row.projection ?? request.projection,
    sheetName: row.sheetName ?? request.sheetName,
    registeredRange: row.registeredRange ?? request.registeredRange,
    schemaVersion: row.schemaVersion ?? request.schemaVersion,
  };
}

/** Appends rows that all target ONE tab (byte-identical legacy path). */
async function fastAppendSingleRoute(
  deps: GoogleSheetsApiProviderDeps,
  request: FastAppendRowsRequest,
  bounded: readonly FastAppendRow[],
): Promise<FastAppendRowsResult> {
  const definition = definitionForPhysicalSheet(deps, request.physicalSheetId);
  validateRoute(request, definition);
  const routeOptions = effectRouteOptions(definition);
  if (routeOptions.identityField.kind !== "present") {
    // Fail fast before any preflight read: the fast path never materializes
    // anchor metadata, so a route without a registered identity cannot
    // locate or guard its rows on replay. Kept ahead of the preflight reads so the
    // legacy single-tab path rejects an identity-less route without burning
    // enumeration/ranged API reads.
    throw new SyncSheetsContractError(
      SYNC_SHEETS_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
      "fast append requires a registered identityField for route " + request.physicalSheetId,
    );
  }
  const route: PreflightRouteInput = {
    sheetName: request.sheetName,
    registeredRange: request.registeredRange,
    definition,
    routeOptions,
  };
  // ONE enumeration shared by the base read and any whole-table recovery
  // read: a verification-overflow fallback must never stack a second
  // enumeration onto the leased request budget.
  const sheets = await enumeratePreflightSheets(deps);
  const baseContexts = await readPreflightDataForEnumeratedRoutes(
    deps, sheets, [route], undefined, "preflight",
    GOOGLE_SHEETS_API_PREFLIGHT_BASE_FIELDS, { scoped: true },
  );
  const baseContext = baseContexts.get(request.sheetName);
  if (baseContext === undefined) {
    invalidProviderState(`preflight context is missing for ${request.sheetName}`);
  }
  // Scoped verification read before replay/pending classification: every
  // receipt-replay row and (when identity cells need format evidence) the
  // whole identity column come from ONE atomic format-evidenced request, so
  // the replay full-row hash and identity dedupe see exactly what the
  // historical full-mask read saw. Non-scoped base contexts (receipt-init
  // downgrade, key-row-gap fallback) already carry whole-table full evidence
  // and skip the read — and a band plan that overflows the range budget
  // re-reads this route whole-table full-evidence from the SAME enumeration,
  // keeping the leased dispatch inside the historical paced-request budget
  // (enumeration + base read + at most one conditional third read + write).
  const context = await verifyPreflightContext(
    deps,
    baseContext,
    collectAppendReplayRows(baseContext, bounded, routeOptions.identityField),
  );
  const prepared = prepareFastAppend(deps, request, definition, routeOptions, context, bounded);
  let deferredSuffix = false;
  const updatedAt = new Date(deps.now()).toISOString();
  if (prepared.pendingRows.length > 0) {
    const resolution = resolveAppendBudget(
      prepared.pendingRows,
      (count) => buildAppendBatchRequests(
        context,
        prepared.pendingRows.slice(0, count),
        prepared.pendingReceipts.slice(0, count),
        { updatedAt },
      ),
      deps.maxBatchBytes,
    );
    deferredSuffix = resolution.includeCount < prepared.pendingRows.length;
    // Writes the target+receipt batch against `ctx`. Extracted so the shared
    // receipt-tab initialization guard (below) can wrap refresh + write as one
    // atomic unit.
    const writeBatch = async (ctx: PreflightContext): Promise<void> => {
      if (resolution.includeCount <= 0) return;
      const batch = buildAppendBatchRequests(
        ctx,
        prepared.pendingRows.slice(0, resolution.includeCount),
        prepared.pendingReceipts.slice(0, resolution.includeCount),
        { updatedAt },
      );
      if (batch.requests.length > 0) {
        const response = await runWrite(deps, () =>
          deps.transport.batchUpdate({
            spreadsheetId: deps.spreadsheetId,
            requests: batch.requests,
          }), {
          requestCount: batch.requests.length,
          bodyBytes: batch.bytes,
          requestedEffects: request.rows.length,
          includedEffects: resolution.includeCount,
        });
        requireValidBatchUpdateReply(response, batch.requests.length);
        for (let i = 0; i < resolution.includeCount; i += 1) {
          const receipt = prepared.pendingReceipts[i];
          if (receipt !== undefined) {
            prepared.resultsById.set(receipt.effectId, {
              effectId: receipt.effectId,
              status: SYNC_FAST_APPEND_STATUSES.APPLIED,
              visibleHash: receipt.visibleHash,
              visibleRevision: receipt.visibleRevision,
            });
          }
        }
      }
    };
    // A read-ahead preflight may have observed the shared receipt tab before a
    // concurrent write created it. Two stale preflights on the same spreadsheet
    // would otherwise both emit a duplicate addSheet and the second would fail
    // with a 400. Serialize refresh + the batch that creates the tab on the
    // per-spreadsheet receipt-init lock so the first writer creates it and
    // later writers refresh to see it present and append instead. Steady state
    // (receipt present at preflight) never takes this lock.
    //
    // Stale `pendingRows` are safe here by the same-route serialization
    // invariant: the WHOLE fast-append operation (this preflight read, the
    // replay/identity planning in prepareFastAppend, and the write) runs inside
    // one coordinator mutation lane (`CoordinatedSheetsProvider.fastAppendRows`
    // -> runMutation; the dispatcher's fast-append path serializes through
    // `runSerializedInner`/`runSerializedInnerForRoutes` the same way), and the
    // worker never overlaps a same-route unit. A second same-route call's
    // preflight therefore cannot run before this write completes, so it sees
    // the first call's receipts and identities and classifies them as replays
    // in prepareFastAppend instead of re-pending them; the refresh below can
    // only observe receipts from OTHER routes (different tabs), whose identities
    // can never collide with this route's pending rows. The lock exists for the
    // cross-route shared-receipt-tab addSheet hazard, not for target-row
    // duplication. Even for unserialized direct callers, an out-of-order
    // same-route append batch cannot lose or overwrite the earlier writer's
    // rows: appends reserve rows with insertDimension (shift, not overwrite).
    if (context.receiptSheetId.kind === PRESENCE_KINDS.ABSENT) {
      await deps.receiptInitLock.run(async () => {
        const refreshed = await refreshReceiptForWrite(deps, context);
        await writeBatch(refreshed);
      });
    } else {
      await writeBatch(context);
    }
  }
  return collectAppendResults(prepared.resultsById, bounded, bounded.length < request.rows.length || deferredSuffix);
}

/** Appends rows spanning MULTIPLE tabs in ONE enumerate + read + batch. */
async function fastAppendMultiRoute(
  deps: GoogleSheetsApiProviderDeps,
  request: FastAppendRowsRequest,
  bounded: readonly FastAppendRow[],
  groups: readonly (readonly FastAppendRow[])[],
): Promise<FastAppendRowsResult> {
  const specs = groups.map((group) => {
    const route = rowRoute(request, group[0]!);
    const definition = definitionForPhysicalSheet(deps, route.physicalSheetId);
    const subRequest: FastAppendRowsRequest = {
      ...route,
      rows: group,
    };
    validateRoute(subRequest, definition);
    return { subRequest, definition, routeOptions: effectRouteOptions(definition), group };
  });
  // Fail fast on EVERY route's identity field before the shared preflight
  // read: the fast path never materializes anchor metadata, so any route
  // without a registered identity cannot locate or guard its rows on replay.
  // Kept ahead of the shared preflight reads so an identity-less route is rejected
  // without burning the shared enumeration/ranged API reads.
  for (const spec of specs) {
    if (spec.routeOptions.identityField.kind !== "present") {
      throw new SyncSheetsContractError(
        SYNC_SHEETS_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
        "fast append requires a registered identityField for route " + spec.subRequest.physicalSheetId,
      );
    }
  }
  const baseRouteArgs: readonly PreflightRouteInput[] = specs.map((spec) => ({
    sheetName: spec.subRequest.sheetName,
    registeredRange: spec.subRequest.registeredRange,
    definition: spec.definition,
    routeOptions: spec.routeOptions,
  }));
  // ONE enumeration shared by the base read and the consolidated
  // full-evidence recovery read (see `verifyPreflightContexts`): overflow
  // routes re-read from this enumeration instead of re-entering the
  // per-route preflight (which stacked one enumeration + one full read per
  // overflow route and blew the leased call budget).
  const sheets = await enumeratePreflightSheets(deps);
  const baseContexts = await readPreflightDataForEnumeratedRoutes(
    deps, sheets, baseRouteArgs,
    undefined, "preflight", GOOGLE_SHEETS_API_PREFLIGHT_BASE_FIELDS, { scoped: true });
  const verifiedContexts = await verifyPreflightContexts(deps, specs.map((spec) => {
    const baseContext = baseContexts.get(spec.subRequest.sheetName);
    if (baseContext === undefined) {
      invalidProviderState(`preflight context is missing for ${spec.subRequest.sheetName}`);
    }
    return {
      context: baseContext,
      targetRowNumbers: collectAppendReplayRows(baseContext, spec.group, spec.routeOptions.identityField),
    };
  }));
  const prepared = specs.map((spec, index) => ({
    context: verifiedContexts[index]!,
    prepared: prepareFastAppend(deps, spec.subRequest, spec.definition, spec.routeOptions, verifiedContexts[index]!, spec.group),
  }));
  const appendingRoutes: CombinedAppendRoute[] = prepared.map((entry) => ({
    context: entry.context,
    rows: entry.prepared.pendingRows,
    receipts: entry.prepared.pendingReceipts,
  }));
  const totalPending = appendingRoutes.reduce((sum, route) => sum + route.rows.length, 0);
  const updatedAt = new Date(deps.now()).toISOString();
  let deferredSuffix = false;
  if (totalPending > 0) {
    const resolution = resolveCombinedAppendBudget(
      appendingRoutes,
      (count) => buildCombinedAppendRequests(prefixAppendRoutes(appendingRoutes, count), { updatedAt }),
      deps.maxBatchBytes,
    );
    deferredSuffix = resolution.includeCount < totalPending;
    // Writes the combined multi-tab batch against `routes`. Extracted so the
    // shared receipt-tab initialization guard (below) can wrap refresh + write
    // as one atomic unit.
    const writeCombined = async (routes: readonly CombinedAppendRoute[]): Promise<void> => {
      if (resolution.includeCount <= 0) return;
      const batch = buildCombinedAppendRequests(
        prefixAppendRoutes(routes, resolution.includeCount),
        { updatedAt },
      );
      if (batch.requests.length > 0) {
        const response = await runWrite(deps, () =>
          deps.transport.batchUpdate({
            spreadsheetId: deps.spreadsheetId,
            requests: batch.requests,
          }), {
          requestCount: batch.requests.length,
          bodyBytes: batch.bytes,
          requestedEffects: request.rows.length,
          includedEffects: resolution.includeCount,
        });
        requireValidBatchUpdateReply(response, batch.requests.length);
        let remaining = resolution.includeCount;
        for (const entry of prepared) {
          const take = Math.min(entry.prepared.pendingRows.length, remaining);
          for (let i = 0; i < take; i += 1) {
            const receipt = entry.prepared.pendingReceipts[i];
            if (receipt !== undefined) {
              entry.prepared.resultsById.set(receipt.effectId, {
                effectId: receipt.effectId,
                status: SYNC_FAST_APPEND_STATUSES.APPLIED,
                visibleHash: receipt.visibleHash,
                visibleRevision: receipt.visibleRevision,
              });
            }
          }
          remaining -= take;
        }
      }
    };
    // A read-ahead preflight may have observed the shared receipt tab before a
    // concurrent write created it. Two stale multi-route preflights on the same
    // spreadsheet would otherwise both emit a duplicate addSheet. Serialize
    // refresh + the combined batch on the per-spreadsheet receipt-init lock so
    // the first writer creates the tab and later writers refresh to append
    // instead. Steady state (receipt present at preflight) never takes this
    // lock.
    const needsReceiptInit = appendingRoutes[0]?.context.receiptSheetId.kind === PRESENCE_KINDS.ABSENT;
    if (needsReceiptInit) {
      await deps.receiptInitLock.run(async () => {
        const first = appendingRoutes[0]!;
        const refreshed = await refreshReceiptForWrite(deps, first.context);
        const refreshedRoutes = appendingRoutes.map((route, index) =>
          index === 0 ? { ...route, context: refreshed } : route);
        await writeCombined(refreshedRoutes);
      });
    } else {
      await writeCombined(appendingRoutes);
    }
  }
  const byId = new Map<string, FastAppendRowResult>();
  for (const entry of prepared) {
    for (const [effectId, result] of entry.prepared.resultsById) byId.set(effectId, result);
  }
  return collectAppendResults(byId, bounded, bounded.length < request.rows.length || deferredSuffix);
}

/** Slices the flat combined append route list to a shared prefix count. */
function prefixAppendRoutes(
  routes: readonly CombinedAppendRoute[],
  count: number,
): readonly CombinedAppendRoute[] {
  const result: CombinedAppendRoute[] = [];
  let remaining = count;
  for (const route of routes) {
    if (remaining <= 0) break;
    const take = Math.min(route.rows.length, remaining);
    result.push({ context: route.context, rows: route.rows.slice(0, take), receipts: route.receipts.slice(0, take) });
    remaining -= take;
  }
  return result;
}

/** Combined append byte budget resolver (mirrors resolveAppendBudget). */
function resolveCombinedAppendBudget(
  routes: readonly CombinedAppendRoute[],
  build: (count: number) => { readonly bytes: number },
  maxBatchBytes: number,
): { readonly includeCount: number; readonly hasMore: boolean } {
  const total = routes.reduce((sum, route) => sum + route.rows.length, 0);
  if (total === 0) return { includeCount: 0, hasMore: false };
  let low = 1;
  let high = total;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (build(mid).bytes <= maxBatchBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return { includeCount: low, hasMore: low < total };
}

/**
 * Runs the per-route append preflight: identity-route guard, header check,
 * replay recognition through the receipt tab, and pending-row identity
 * availability. Returns the mutable per-route result map plus the pending
 * rows and receipts the batch builder needs.
 */
function prepareFastAppend(
  deps: GoogleSheetsApiProviderDeps,
  request: FastAppendRowsRequest,
  definition: RegisteredSyncProjectionDefinition,
  routeOptions: { readonly identityField: Presence<string>; readonly checkboxHeaders: readonly string[] },
  context: PreflightContext,
  bounded: readonly FastAppendRow[],
): {
  readonly resultsById: Map<string, FastAppendRowResult>;
  readonly pendingRows: readonly WorkingRow[];
  readonly pendingReceipts: readonly PlannedReceipt[];
} {
  if (routeOptions.identityField.kind !== "present") {
    // The fast path never materializes anchor metadata, so a route without
    // a registered identity cannot locate or guard its rows on replay.
    throw new SyncSheetsContractError(
      SYNC_SHEETS_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
      "fast append requires a registered identityField for route " + request.physicalSheetId,
    );
  }
  validateAppendRowsAgainstHeaders(bounded, context.headers);
  const identityField = routeOptions.identityField.value;
  const pending: FastAppendRow[] = [];
  const resultsById = new Map<string, FastAppendRowResult>();
  const pendingReceipts: PlannedReceipt[] = [];
  for (const row of bounded) {
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
  if (pending.length > 0) {
    assertAppendIdentityAvailability(context, identityField, pending);
  }
  const pendingRows: WorkingRow[] = pending.map((row, index) =>
    toAppendWorkingRow(row, context.nextAppendRow + index));
  return { resultsById, pendingRows, pendingReceipts };
}

/**
 * Over-approximates the fast-append replay rows: every bounded row that
 * already carries a receipt resolves (by its visible identity, mirroring
 * `findRowByIdentity` on the base indexes) to the sheet row whose FULL
 * visible cells the replay hash will be computed from. ISO date identities
 * additionally band their raw-serial alias: under the values-only base read
 * a canonical-date identity cell is keyed by its serial number string, and
 * the format-aware verification index resolves it back to the ISO string.
 */
function collectAppendReplayRows(
  context: PreflightContext,
  rows: readonly FastAppendRow[],
  identityField: Presence<string>,
): number[] {
  if (identityField.kind !== "present") return [];
  const rowNumbers: number[] = [];
  for (const row of rows) {
    if (!context.receipts.has(row.effectId)) continue;
    const identity = identityFromNormalizedCell(row.fields[identityField.value] ?? null);
    if (identity === null) continue;
    for (const candidate of [identity, ...identitySerialAliases(identity)]) {
      for (const existing of context.rows) {
        if (existing.identity.kind === "present" && existing.identity.value === candidate) {
          rowNumbers.push(existing.rowNumber);
        }
      }
    }
  }
  return rowNumbers;
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

/** Orders the results in the request's row order and applies hasMore. */
function collectAppendResults(
  byId: Map<string, FastAppendRowResult>,
  bounded: readonly FastAppendRow[],
  hasMore: boolean,
): FastAppendRowsResult {
  const results: FastAppendRowResult[] = [];
  for (const row of bounded) {
    const result = byId.get(row.effectId);
    if (result === undefined) continue;
    results.push(result);
  }
  return { results, hasMore };
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
  // Pending identities seen so far in this request, used to reject a local
  // duplicate (two rows with the same identity in one batch) separately from a
  // real remote collision in the sheet.
  const pendingIdentities = new Set<string>();
  for (const row of pending) {
    const identity = appendIdentity(row, identityField);
    const location = existing.get(identity);
    if (location !== undefined) {
      // A pending append row whose identity already exists remotely without a
      // matching receipt is stale-state protection: the effect was most likely
      // applied by a pass whose response was lost, so it is classified as an
      // `identity_already_exists` preflight state (delivery-uncertain) rather
      // than a malformed reply.
      invalidProviderState(
        `sync identity already exists: ${identity} at ${location}`,
        {
          operation: SYNC_INVALID_PROVIDER_OPERATIONS.PREFLIGHT,
          reason: SYNC_INVALID_PROVIDER_REASONS.IDENTITY_ALREADY_EXISTS,
        },
      );
    }
    if (pendingIdentities.has(identity)) {
      // A duplicate identity within the current request is a local call error,
      // not a remote collision; it keeps the safe unclassified default.
      invalidProviderState(`sync identity is duplicated in the pending batch: ${identity}`);
    }
    pendingIdentities.add(identity);
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
