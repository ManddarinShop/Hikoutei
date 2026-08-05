/**
 * Full sync provider over the Google Sheets REST API.
 *
 * Implements every gateway capability the sync runtime needs with ONE
 * provider instance (one transport, one read limiter, one write limiter, one
 * telemetry sink): the outbound effect worker (fast append, applyEffects,
 * postcondition recovery), projection provisioning, values-only table reads,
 * row-anchor assignment, and full metadata snapshots. The service-account
 * bootstrap mode uses this provider exclusively and needs no Apps Script.
 *
 * Delivery semantics are ported from the Apps Script operations: bulk
 * preflight with fail-closed validation, receipt replay/idempotency,
 * visible/candidate/repair compare-and-set guards, full-row deletion guards,
 * one atomic `spreadsheets.batchUpdate` per target+receipt batch,
 * response-loss recovery through receipt-backed postcondition reads,
 * exact-match provisioning, and snapshot wire shapes that are byte-compatible
 * with the Apps Script observation source. The provider never exposes
 * credential material or raw Google SDK responses; telemetry carries only
 * operation names, counts, durations, and stable codes.
 *
 * Request pacing is per transport call: every `getSpreadsheet` (preflight
 * enumeration, preflight data, observation reads, post-reads, table reads,
 * provisioning reads) and every `batchUpdate` acquires its class limiter and
 * emits one redacted telemetry event.
 */

import {
  computeSyncVisibleHash,
  type ApplySyncEffectsRequest,
  type ApplySyncEffectsResult,
  type EnsureSyncRowAnchorsRequest,
  type EnsureSyncRowAnchorsResult,
  type FastAppendRowsRequest,
  type FastAppendRowsResult,
  type FastAppendRow,
  type FastAppendRowResult,
  type ReadSyncEffectPostconditionsRequest,
  type ReadSyncSnapshotRequest,
  type ReadSyncTableRowsRequest,
  type SyncEffectPostcondition,
  type SyncEffectWorkerFullGateway,
  type SyncGatewayAuthority,
  type SyncGatewayEffect,
  type SyncGatewayEffectPostconditionResult,
  type SyncGatewayEffectResult,
  type SyncGatewaySnapshot,
  type SyncObservedSnapshot,
  type SyncSheetObservationBatchGateway,
  type SyncSheetObservationGateway,
  type SyncSheetTableReaderGateway,
  type SyncTableRowsResult,
} from "../../../../application/sync/gateway/syncGateway.js";
import {
  SYNC_GATEWAY_ERROR_CODES,
  SyncGatewayContractError,
} from "../../../../application/sync/gateway/errors.js";
import {
  requireSyncGatewaySnapshotReadMode,
} from "../../../../application/sync/gateway/validation.js";
import {
  SYNC_GATEWAY_FAST_APPEND_STATUSES,
  SYNC_GATEWAY_POSTCONDITION_MODES,
  SYNC_GATEWAY_PROJECTIONS,
  SYNC_GATEWAY_SNAPSHOT_READ_MODES,
  type SyncGatewaySnapshotReadMode,
} from "../../../../application/sync/gateway/constants.js";
import {
  classifyTransportOutcome,
} from "../../../../application/sync/gateway/transportClassification.js";
import type {
  RegisteredSyncProjectionDefinition,
  SyncGatewayProvisioner,
  SyncGatewayProvisionRoute,
} from "../../../../application/sync/gateway/SyncGatewayBootstrap.js";
import type { Presence } from "../../../../shared/state/index.js";
import { presentValue, absentValue } from "../../../../shared/state/index.js";
import { isNormalizedCell } from "../../../../shared/encoding/index.js";
import {
  GOOGLE_SHEETS_API_DEFAULTS,
  GOOGLE_SHEETS_API_EFFECT_REASONS,
  GOOGLE_SHEETS_API_ANCHOR_KEY,
} from "./constants.js";
import { invalidProviderRequest, invalidProviderState } from "./errors.js";
import { identityFromNormalizedCell } from "./model/valueNormalization.js";
import {
  GoogleSheetsApiHttpTransport,
  type GoogleSheetsApiTransport,
  type GoogleSheetsApiWriteRequest,
} from "./transport/googleSheetsApiTransport.js";
import { RequestStartLimiter } from "./transport/rateLimiter.js";
import {
  enumerateSheetProperties,
  readPreflightData,
  type PreflightContext,
  type PreflightRow,
  GOOGLE_SHEETS_API_PROVISION_ENUMERATION_FIELDS,
  GOOGLE_SHEETS_API_PROVISION_FIELDS,
  GOOGLE_SHEETS_API_VALUES_FIELDS,
  GOOGLE_SHEETS_API_OBSERVATION_FIELDS,
  GOOGLE_SHEETS_API_LIGHTWEIGHT_OBSERVATION_FIELDS,
  parseSpreadsheetDocument,
  gridHeaderCells,
  type ParsedGridData,
} from "./model/preflight.js";
import {
  planEffectBatch,
  encodeOutcomeResult,
  encodeSchemaErrorResult,
  withDeferredPostcondition,
  currentHash,
  type EffectPlan,
  type PlannedReceipt,
  type WorkingRow,
} from "./model/planner.js";
import {
  buildApplyBatchRequests,
  buildAppendBatchRequests,
  resolveApplyBatchBudget,
  resolveAppendBudget,
} from "./model/batchBuilder.js";
import { classifyPostcondition } from "./model/postcondition.js";
import {
  buildSnapshotFromTab,
  planRowAnchors,
  readTabGrids,
  type AnchorPlanResult,
  type ObservedTab,
  type SnapshotBuildTarget,
} from "./model/observation.js";
import { buildTableRowsFromGrid } from "./model/tableRead.js";
import { allocateSheetId } from "./model/sheetIdAllocator.js";
import {
  columnLetters,
  parseRegisteredRange,
  quoteA1SheetName,
} from "./model/valueNormalization.js";

/** Redacted telemetry event emitted for every transport request. */
export interface GoogleSheetsApiRequestEvent {
  readonly operation: "getSpreadsheet" | "batchUpdate";
  readonly operationCount: number;
  readonly startedAt: number;
  readonly durationMs: number;
  readonly ok: boolean;
  readonly httpStatus: Presence<number>;
  readonly code: Presence<string>;
}

/** Provider options without the bootstrap-supplied spreadsheet and routes. */
export interface GoogleSheetsApiProviderOptions {
  /** Stub transport for tests; omitted builds the real ADC-backed client. */
  readonly transport?: GoogleSheetsApiTransport;
  /** Per-request timeout; defaults to 60 seconds, bounded 1s..120s. */
  readonly requestTimeoutMs?: number;
  /**
   * Per-READ-request timeout (every getSpreadsheet call); defaults to
   * 10 seconds, bounded 1s..60s. Writes keep `requestTimeoutMs`, so a slow
   * dispatch (two preflight reads plus one write) cannot outlive its effect
   * lease.
   */
  readonly readTimeoutMs?: number;
  /** Minimum interval between request starts per class; defaults to 1,100 ms. */
  readonly rateLimitIntervalMs?: number;
  /** Serialized batchUpdate byte budget; defaults to ~2 MB. */
  readonly maxBatchBytes?: number;
  /** Injectable clock for limiters and telemetry. */
  readonly now?: () => number;
  /** Injectable sleep used by the request-start limiters. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Redacted request telemetry sink. */
  readonly onRequest?: (event: GoogleSheetsApiRequestEvent) => void;
}

/** Full construction options (bootstrap supplies spreadsheet and routes). */
export interface GoogleSheetsApiSyncProviderOptions extends GoogleSheetsApiProviderOptions {
  readonly spreadsheetId: string;
  readonly definitions: readonly RegisteredSyncProjectionDefinition[];
}

/**
 * Full sync provider over the Sheets REST API: outbound effects, provisioning,
 * table reads, anchors, and snapshots behind the shared gateway contracts.
 *
 * All reads share one read limiter; all writes share one write limiter; the
 * worker-level append throttle stays enabled on top in service mode via the
 * bootstrap's bulk worker options. Provisioning runs at startup before the
 * worker, and observation anchors are the only metadata mutations outside
 * effect batches.
 */
export class GoogleSheetsApiSyncProvider
  implements
    SyncEffectWorkerFullGateway,
    SyncSheetObservationGateway,
    SyncSheetObservationBatchGateway,
    SyncSheetTableReaderGateway,
    SyncGatewayProvisioner {
  private readonly spreadsheetId: string;
  private readonly definitions: readonly RegisteredSyncProjectionDefinition[];
  private readonly transport: GoogleSheetsApiTransport;
  private readonly transportTimeoutMs: number;
  private readonly readTimeoutMs: number;
  private readonly maxBatchBytes: number;
  private readonly readLimiter: RequestStartLimiter;
  private readonly writeLimiter: RequestStartLimiter;
  private readonly now: () => number;
  private readonly onRequest: ((event: GoogleSheetsApiRequestEvent) => void) | undefined;

  public constructor(options: GoogleSheetsApiSyncProviderOptions) {
    if (options.definitions.length === 0) {
      throw new SyncGatewayContractError(
        SYNC_GATEWAY_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
        "Google Sheets API sync provider requires a projection definition",
      );
    }
    const requestTimeoutMs = options.requestTimeoutMs ?? GOOGLE_SHEETS_API_DEFAULTS.REQUEST_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(requestTimeoutMs) ||
      requestTimeoutMs < GOOGLE_SHEETS_API_DEFAULTS.MIN_REQUEST_TIMEOUT_MS ||
      requestTimeoutMs > GOOGLE_SHEETS_API_DEFAULTS.MAX_REQUEST_TIMEOUT_MS
    ) {
      invalidProviderRequest(
        "Google Sheets API sync provider",
        "requestTimeoutMs must be between 1 second and 120 seconds",
      );
    }
    const readTimeoutMs = options.readTimeoutMs ?? GOOGLE_SHEETS_API_DEFAULTS.READ_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(readTimeoutMs) ||
      readTimeoutMs < GOOGLE_SHEETS_API_DEFAULTS.MIN_REQUEST_TIMEOUT_MS ||
      readTimeoutMs > GOOGLE_SHEETS_API_DEFAULTS.MAX_READ_TIMEOUT_MS
    ) {
      invalidProviderRequest(
        "Google Sheets API sync provider",
        "readTimeoutMs must be between 1 second and 60 seconds",
      );
    }
    for (const definition of options.definitions) {
      if (definition.sheet.spreadsheetId !== options.spreadsheetId) {
        throw new SyncGatewayContractError(
          SYNC_GATEWAY_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
          "Google Sheets API sync provider definitions must target one spreadsheet",
        );
      }
    }
    const maxBatchBytes = options.maxBatchBytes ?? GOOGLE_SHEETS_API_DEFAULTS.MAX_BATCH_REQUEST_BYTES;
    if (!Number.isSafeInteger(maxBatchBytes) || maxBatchBytes < 1) {
      invalidProviderRequest("Google Sheets API sync provider", "maxBatchBytes is invalid");
    }
    const intervalMs = options.rateLimitIntervalMs ?? GOOGLE_SHEETS_API_DEFAULTS.REQUEST_START_INTERVAL_MS;
    this.spreadsheetId = options.spreadsheetId;
    this.definitions = options.definitions;
    this.transport = options.transport ?? new GoogleSheetsApiHttpTransport({ requestTimeoutMs });
    this.transportTimeoutMs = requestTimeoutMs;
    this.readTimeoutMs = readTimeoutMs;
    this.maxBatchBytes = maxBatchBytes;
    this.now = options.now ?? Date.now;
    this.readLimiter = new RequestStartLimiter({
      intervalMs,
      now: this.now,
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    });
    this.writeLimiter = new RequestStartLimiter({
      intervalMs,
      now: this.now,
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    });
    this.onRequest = options.onRequest;
  }

  /** Exposes the configured outbound timeout (used by lease-headroom checks). */
  public get timeoutMs(): number {
    return this.transportTimeoutMs;
  }

  // -------------------------------------------------------------------------
  // Outbound effect worker (fast append, applyEffects, recovery)
  // -------------------------------------------------------------------------

  /** Appends rows through one idempotent, atomic target+receipt batch. */
  public async fastAppendRows(request: FastAppendRowsRequest): Promise<FastAppendRowsResult> {
    validateAuthority(request.authority);
    const definition = this.definitionForPhysicalSheet(request.physicalSheetId);
    validateRoute(request, definition);
    const routeOptions = effectRouteOptions(definition);
    if (routeOptions.identityField.kind !== "present") {
      // The fast path never materializes anchor metadata, so a route without
      // a registered identity cannot locate or guard its rows on replay.
      throw new SyncGatewayContractError(
        SYNC_GATEWAY_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
        "fast append requires a registered identityField for route " + request.physicalSheetId,
      );
    }
    if (request.rows.length === 0) {
      invalidProviderRequest("fast append", "rows must not be empty");
    }
    const bounded = request.rows.slice(0, GOOGLE_SHEETS_API_DEFAULTS.MAX_APPEND_ROWS_PER_REQUEST);
    validateAppendRows(bounded);
    const context = await this.readPreflight(request, definition, routeOptions);
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
          status: SYNC_GATEWAY_FAST_APPEND_STATUSES.APPLIED,
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
    // entries are exempt exactly like the real gateway.
    let deferredSuffix = false;
    if (pending.length > 0) {
      assertAppendIdentityAvailability(context, identityField, pending);
      const pendingRows: WorkingRow[] = pending.map((row, index) =>
        toAppendWorkingRow(row, context.nextAppendRow + index));
      const updatedAt = new Date(this.now()).toISOString();
      const resolution = resolveAppendBudget(
        pendingRows,
        (count) => buildAppendBatchRequests(
          context,
          pendingRows.slice(0, count),
          pendingReceipts.slice(0, count),
          { updatedAt },
        ),
        this.maxBatchBytes,
      );
      deferredSuffix = resolution.includeCount < pending.length;
      if (resolution.includeCount > 0) {
        const batch = buildAppendBatchRequests(
          context,
          pendingRows.slice(0, resolution.includeCount),
          pendingReceipts.slice(0, resolution.includeCount),
          { updatedAt },
        );
        const response = await this.runWrite(() =>
          this.transport.batchUpdate({
            spreadsheetId: this.spreadsheetId,
            requests: batch.requests,
          }));
        requireValidBatchUpdateReply(response, batch.requests.length);
        pendingReceipts.slice(0, resolution.includeCount).forEach((receipt) => {
          resultsById.set(receipt.effectId, {
            effectId: receipt.effectId,
            status: SYNC_GATEWAY_FAST_APPEND_STATUSES.APPLIED,
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

  /** Applies regular update/delete/create effects through one atomic batch. */
  public async applyEffects(request: ApplySyncEffectsRequest): Promise<ApplySyncEffectsResult> {
    validateAuthority(request.authority);
    const definition = this.definitionForPhysicalSheet(request.physicalSheetId);
    validateRoute(request, definition);
    if (request.effects.length === 0) {
      invalidProviderRequest("apply effects", "effects must not be empty");
    }
    const bounded = request.effects.slice(0, GOOGLE_SHEETS_API_DEFAULTS.MAX_EFFECTS_PER_REQUEST);
    const postconditionMode = request.postconditionMode ?? SYNC_GATEWAY_POSTCONDITION_MODES.INLINE;
    if (
      postconditionMode !== SYNC_GATEWAY_POSTCONDITION_MODES.INLINE &&
      postconditionMode !== SYNC_GATEWAY_POSTCONDITION_MODES.DEFERRED
    ) {
      invalidProviderRequest("apply effects", "postconditionMode must be inline or deferred");
    }
    const routeOptions = effectRouteOptions(definition);
    const context = await this.readPreflight(request, definition, routeOptions);
    const plans = planEffectBatch({ ...request, effects: bounded }, context);
    const includeReceipts = postconditionMode === SYNC_GATEWAY_POSTCONDITION_MODES.DEFERRED;
    const updatedAt = new Date(this.now()).toISOString();
    const resolution = resolveApplyBatchBudget(context, plans, {
      maxBatchBytes: this.maxBatchBytes,
      includeReceipts,
      updatedAt,
    });
    const schemaErrorIndices = new Set(resolution.schemaErrorIndices);
    // Schema-error effects sit BEFORE the included run; the batch only carries
    // the plans after them, up to the resolved include count. The included
    // effects are re-planned so appended rows start at the sheet's first free
    // row (the full-plan row numbers would leave blank gaps for excluded
    // effects). The planner is deterministic over the unchanged context, so
    // outcomes and receipts are identical to the budget-resolution plans.
    const includedStart = resolution.schemaErrorIndices.length;
    const includedEffects = bounded.slice(includedStart, resolution.includeCount);
    const included = planEffectBatch({ ...request, effects: includedEffects }, context);
    if (included.length > 0) {
      const batch = buildApplyBatchRequests(context, included, { updatedAt, includeReceipts });
      // Rejected plans (guard/schema/repair outcomes) contribute no requests;
      // never send an empty batchUpdate for an all-rejected prefix.
      if (batch.requests.length > 0) {
        const response = await this.runWrite(() =>
          this.transport.batchUpdate({
            spreadsheetId: this.spreadsheetId,
            requests: batch.requests,
          }));
        requireValidBatchUpdateReply(response, batch.requests.length);
      }
    }

    // Inline verification reads the written rows back and demotes any hash
    // mismatch to retryable_error, mirroring the Apps Script inline path. The
    // worker always uses deferred mode, where the atomic batch already carries
    // target mutations and receipts together.
    const verified = new Set<number>();
    if (postconditionMode === SYNC_GATEWAY_POSTCONDITION_MODES.INLINE && included.length > 0) {
      const verifyContext = await this.readPreflight(request, definition, routeOptions);
      included.forEach((plan, index) => {
        if (!plan.verify || plan.mutation === undefined || plan.mutation.kind === "delete") return;
        const row = findProbeRowInContext(verifyContext, plan);
        const current = row === undefined ? undefined : currentHash(row, plan.outcome.effect.payload.fields);
        if (current === plan.outcome.effect.payload.targetVisibleHash) {
          verified.add(index);
        }
      });
      const verifyReceipts: PlannedReceipt[] = [];
      included.forEach((plan, index) => {
        if (plan.receipt === undefined) return;
        // Replay receipts are already stored in the sheet; never rewrite them.
        if (context.receipts.has(plan.receipt.effectId)) return;
        if (plan.outcome.kind === "applied" && !plan.outcome.deletion && !verified.has(index)) return;
        verifyReceipts.push(plan.receipt);
      });
      if (verifyReceipts.length > 0) {
        const receiptBatch = buildAppendBatchRequests(context, [], verifyReceipts, { updatedAt });
        const response = await this.runWrite(() =>
          this.transport.batchUpdate({
            spreadsheetId: this.spreadsheetId,
            requests: receiptBatch.requests,
          }));
        requireValidBatchUpdateReply(response, receiptBatch.requests.length);
      }
    }

    const results: SyncGatewayEffectResult[] = [];
    let includedCursor = 0;
    bounded.forEach((effect, index) => {
      if (schemaErrorIndices.has(index)) {
        results.push(
          encodeSchemaErrorResult(effect, GOOGLE_SHEETS_API_EFFECT_REASONS.EFFECT_PAYLOAD_TOO_LARGE),
        );
        return;
      }
      if (index >= resolution.includeCount) return;
      const planIndex = includedCursor;
      includedCursor += 1;
      const plan = included[planIndex];
      if (plan === undefined) return;
      let result = encodeOutcomeResult(plan.outcome);
      if (
        postconditionMode === SYNC_GATEWAY_POSTCONDITION_MODES.INLINE &&
        plan.outcome.kind === "applied" &&
        !plan.outcome.deletion &&
        !verified.has(planIndex)
      ) {
        result = {
          ...result,
          status: "retryable_error",
          visibleRevision: absentValue(),
          visibleHash: absentValue(),
          reason: presentValue(GOOGLE_SHEETS_API_EFFECT_REASONS.POSTCONDITION_HASH_MISMATCH),
          postcondition: "unavailable",
        };
      } else if (postconditionMode === SYNC_GATEWAY_POSTCONDITION_MODES.DEFERRED) {
        result = withDeferredPostcondition(result);
      }
      results.push(result);
    });
    return {
      results,
      snapshotHash: absentValue(),
      hasMore: bounded.length < request.effects.length || results.length < bounded.length,
    };
  }

  /** Classifies one response-loss effect through a fresh target+receipt read. */
  public async readEffectPostcondition(effect: SyncGatewayEffect): Promise<SyncEffectPostcondition> {
    const [result] = await this.readEffectPostconditions({
      physicalSheetId: effect.physicalSheetId,
      sheetName: effect.payload.sheetName,
      registeredRange: effect.payload.registeredRange,
      projection: effect.projection,
      schemaVersion: effect.payload.schemaVersion,
      effects: [effect],
    });
    if (result === undefined) {
      invalidProviderState("postcondition read returned no result");
    }
    return result.postcondition;
  }

  /** Classifies a recovery batch with one shared target+receipt read. */
  public async readEffectPostconditions(
    request: ReadSyncEffectPostconditionsRequest,
  ): Promise<readonly SyncGatewayEffectPostconditionResult[]> {
    const definition = this.definitionForPhysicalSheet(request.physicalSheetId);
    validateRoute(request, definition);
    if (request.effects.length === 0) {
      invalidProviderRequest("postcondition reads", "effects must not be empty");
    }
    const routeOptions = effectRouteOptions(definition);
    const context = await this.readPreflight(request, definition, routeOptions);
    return request.effects.map((effect) => ({
      effectId: effect.effectId,
      payloadHash: effect.payloadHash,
      postcondition: classifyPostcondition(context, effect, context.receipts),
    }));
  }

  // -------------------------------------------------------------------------
  // Projection provisioning (SyncGatewayProvisioner)
  // -------------------------------------------------------------------------

  /**
   * Creates missing tabs and their header rows, or verifies existing tabs,
   * in ONE atomic batchUpdate. An existing tab with no content anywhere in
   * its used grid gets its headers initialized; an existing tab with content
   * must match the registered headers exactly (order, duplicates, width),
   * otherwise provisioning fails closed BEFORE any mutation. The operation
   * is idempotent: a retry after a lost response re-enumerates, sees the
   * exact headers, and succeeds without rewriting anything.
   */
  public async provisionRegistry(
    registrations: readonly SyncGatewayProvisionRoute[],
  ): Promise<{
    readonly registrations: readonly Omit<SyncGatewayProvisionRoute, "headers">[];
    readonly createdSheets: readonly string[];
    readonly initializedHeaders: readonly string[];
  }> {
    validateProvisionRegistrations(registrations);

    // Enumerate every tab (no ranges, hidden included) with grid dimensions.
    const enumerationRaw = await this.runRead(() =>
      this.transport.getSpreadsheet({
        spreadsheetId: this.spreadsheetId,
        ranges: [],
        fields: GOOGLE_SHEETS_API_PROVISION_ENUMERATION_FIELDS,
        timeoutMs: this.readTimeoutMs,
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
      const dataRaw = await this.runRead(() =>
        this.transport.getSpreadsheet({
          spreadsheetId: this.spreadsheetId,
          ranges,
          fields: GOOGLE_SHEETS_API_PROVISION_FIELDS,
          timeoutMs: this.readTimeoutMs,
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
      const response = await this.runWrite(() =>
        this.transport.batchUpdate({
          spreadsheetId: this.spreadsheetId,
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

  // -------------------------------------------------------------------------
  // Values-only table reads (readRows / readRowsBatch)
  // -------------------------------------------------------------------------

  /** Reads one registered table's literal values with one REST read. */
  public async readRows(request: ReadSyncTableRowsRequest): Promise<SyncTableRowsResult> {
    const [result] = await this.readRowsBatch([request]);
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
  public async readRowsBatch(
    requests: readonly ReadSyncTableRowsRequest[],
  ): Promise<readonly SyncTableRowsResult[]> {
    if (requests.length === 0) return [];
    const routes = requests.map((request) => {
      const definition = this.definitionForPhysicalSheet(request.physicalSheetId);
      validateRoute(request, definition);
      if (
        request.headers.length !== definition.headers.length ||
        request.headers.some((header, index) => header !== definition.headers[index])
      ) {
        throw new SyncGatewayContractError(
          SYNC_GATEWAY_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
          "sync gateway table read headers do not match the registered projection " +
          definition.sheet.physicalSheetId,
        );
      }
      return { request, definition };
    });
    const raw = await this.runRead(() =>
      this.transport.getSpreadsheet({
        spreadsheetId: this.spreadsheetId,
        ranges: routes.map(({ request }) =>
          `${quoteA1SheetName(request.sheetName)}!A1:${rangeEndColumnLetters(request.registeredRange)}1048576`),
        fields: GOOGLE_SHEETS_API_VALUES_FIELDS,
        timeoutMs: this.readTimeoutMs,
      }));
    const document = parseSpreadsheetDocument(raw, "table read");
    const results: SyncTableRowsResult[] = [];
    for (const { request, definition } of routes) {
      const sheet = document.sheets.find((candidate) => candidate.title === request.sheetName);
      if (sheet === undefined) {
        invalidProviderState(`Registered sync sheet does not exist: ${request.sheetName}`);
      }
      const grid = document.grids.get(sheet.sheetId);
      if (grid === undefined) {
        invalidProviderState(`grid data is missing for sheet ${sheet.sheetId}`);
      }
      const rows = buildTableRowsFromGrid(grid, {
        registeredRange: request.registeredRange,
        headers: definition.headers,
        checkboxHeaders: definition.checkboxHeaders ?? [],
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

  // -------------------------------------------------------------------------
  // Observation (anchors + snapshots)
  // -------------------------------------------------------------------------

  /**
   * Ensures every nonblank row of one registered tab carries a
   * developer-metadata anchor, writing all planned anchors in ONE atomic
   * batchUpdate. Rows with more than one anchor fail closed; duplicate
   * anchors across rows are reported as evidence. No re-read is performed.
   */
  public async ensureRowAnchors(
    request: EnsureSyncRowAnchorsRequest,
  ): Promise<EnsureSyncRowAnchorsResult> {
    validateAuthority(request.authority);
    const definition = this.definitionForPhysicalSheet(request.physicalSheetId);
    validateRoute(request, definition);
    const tabs = await this.readObservedTabs([request]);
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
      await this.writeAnchors(tab, plan);
    }
    return {
      assigned: plan.assigned,
      existing: plan.existing,
      duplicateAnchors: plan.duplicateAnchors,
    };
  }

  /** Reads one full snapshot without any mutation (lock-free). */
  public async readSnapshot(request: ReadSyncSnapshotRequest): Promise<SyncGatewaySnapshot> {
    const target = this.observationTargetFor(request);
    const tabs = await this.readObservedTabs([request]);
    const tab = tabs.get(request.sheetName);
    if (tab === undefined) {
      invalidProviderState(`Registered sync sheet does not exist: ${request.sheetName}`);
    }
    return buildSnapshotFromTab(tab, target);
  }

  /** Combines anchor assignment and one snapshot read under one request. */
  public async observeSnapshot(request: ReadSyncSnapshotRequest): Promise<SyncObservedSnapshot> {
    const [observed] = await this.observeSnapshots([request]);
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
  public async observeSnapshots(
    requests: readonly ReadSyncSnapshotRequest[],
  ): Promise<readonly SyncObservedSnapshot[]> {
    if (requests.length === 0) return [];
    const targets = requests.map((request) => this.observationTargetFor(request));
    const tabs = await this.readObservedTabs(requests);

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
        checkboxHeaders: target.checkboxHeaders,
      });
      assignedTotal += anchors.assigned;
      plans.push({ request, target, tab, anchors });
    }

    if (assignedTotal > 0) {
      // One atomic write for every planned anchor across all requested tabs.
      const anchorRequests: GoogleSheetsApiWriteRequest[] = [];
      for (const entry of plans) {
        for (const planned of entry.anchors.planned) {
          anchorRequests.push({
            kind: "createDeveloperMetadata" as const,
            sheetId: entry.tab.sheetId,
            rowIndex: planned.rowIndex,
            key: GOOGLE_SHEETS_API_ANCHOR_KEY,
            value: planned.anchor,
          });
        }
      }
      const response = await this.runWrite(() =>
        this.transport.batchUpdate({
          spreadsheetId: this.spreadsheetId,
          requests: anchorRequests,
        }));
      requireValidBatchUpdateReply(response, anchorRequests.length);

      // One shared re-read so the committed anchors appear in the snapshots
      // (mirrors the Apps Script flush-while-locked behavior).
      const refreshed = await this.readObservedTabs(requests);
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

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /** Reads the target grids of one or more observation requests (one call). */
  private async readObservedTabs(
    requests: readonly {
      readonly sheetName: string;
      readonly registeredRange: string;
      readonly readMode?: SyncGatewaySnapshotReadMode;
    }[],
  ): Promise<ReadonlyMap<string, ObservedTab>> {
    // One getSpreadsheet call serves the whole batch with ONE mask: the
    // lighter user_input mask only when every request is lightweight (the
    // lightweight branch never consults merges or dataValidation; the full
    // mask is still correct for a mixed batch).
    const lightweight = requests.length > 0 && requests.every((request) =>
      request.readMode === SYNC_GATEWAY_SNAPSHOT_READ_MODES.USER_INPUT);
    const fields = lightweight
      ? GOOGLE_SHEETS_API_LIGHTWEIGHT_OBSERVATION_FIELDS
      : GOOGLE_SHEETS_API_OBSERVATION_FIELDS;
    return this.runRead(() =>
      readTabGrids(
        this.transport,
        this.spreadsheetId,
        requests.map((request) => ({
          sheetName: request.sheetName,
          registeredRange: request.registeredRange,
        })),
        fields,
        this.readTimeoutMs,
      ));
  }

  /** Writes every planned anchor of one tab in one atomic batch. */
  private async writeAnchors(tab: ObservedTab, plan: AnchorPlanResult): Promise<void> {
    const requests: GoogleSheetsApiWriteRequest[] = plan.planned.map((planned) => ({
      kind: "createDeveloperMetadata",
      sheetId: tab.sheetId,
      rowIndex: planned.rowIndex,
      key: GOOGLE_SHEETS_API_ANCHOR_KEY,
      value: planned.anchor,
    }));
    const response = await this.runWrite(() =>
      this.transport.batchUpdate({
        spreadsheetId: this.spreadsheetId,
        requests,
      }));
    requireValidBatchUpdateReply(response, requests.length);
  }

  /** Validates one observation request and derives its snapshot target. */
  private observationTargetFor(request: ReadSyncSnapshotRequest): SnapshotBuildTarget {
    const definition = this.definitionForPhysicalSheet(request.physicalSheetId);
    validateRoute(request, definition);
    // Fail closed on unknown readMode strings (same shared guard as the Apps
    // Script observation operation) instead of silently reading in full mode.
    const readMode = request.readMode === undefined
      ? SYNC_GATEWAY_SNAPSHOT_READ_MODES.FULL
      : requireSyncGatewaySnapshotReadMode(
        request.readMode,
        "Google Sheets API observation readMode",
        SYNC_GATEWAY_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
      );
    if (
      readMode === SYNC_GATEWAY_SNAPSHOT_READ_MODES.USER_INPUT &&
      request.projection !== SYNC_GATEWAY_PROJECTIONS.USER_INPUT
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
      checkboxHeaders: definition.checkboxHeaders ?? [],
      readMode,
    };
  }

  /** Reads the target and receipt tabs for one route through the read lane. */
  private async readPreflight(
    request: {
      readonly sheetName: string;
      readonly registeredRange: string;
    },
    definition: RegisteredSyncProjectionDefinition,
    routeOptions: {
      readonly identityField: Presence<string>;
      readonly checkboxHeaders: readonly string[];
    },
  ): Promise<PreflightContext> {
    // Each preflight performs two paced transport calls: a range-less sheet
    // enumeration (hidden receipt tab discovery) plus one ranged data read.
    const sheets = await this.runRead(() =>
      enumerateSheetProperties(this.transport, this.spreadsheetId, this.readTimeoutMs));
    return this.runRead(() =>
      readPreflightData(this.transport, {
        spreadsheetId: this.spreadsheetId,
        sheetName: request.sheetName,
        registeredRange: request.registeredRange,
        headers: definition.headers,
        identityField: routeOptions.identityField,
        checkboxHeaders: routeOptions.checkboxHeaders,
      }, sheets, this.readTimeoutMs));
  }

  /** Paces ONE `getSpreadsheet` transport call and emits one read event. */
  private async runRead<T>(task: () => Promise<T>): Promise<T> {
    await this.readLimiter.waitForSlot();
    const startedAt = this.now();
    try {
      const result = await task();
      this.emitRequest("getSpreadsheet", 1, startedAt, true, absentValue(), absentValue());
      return result;
    } catch (error: unknown) {
      const outcome = classifyTransportOutcome(error);
      this.emitRequest("getSpreadsheet", 1, startedAt, false, outcome.httpStatus, outcome.code);
      throw error;
    }
  }

  /** Paces ONE `batchUpdate` transport call and emits one write event. */
  private async runWrite<T>(task: () => Promise<T>): Promise<T> {
    await this.writeLimiter.waitForSlot();
    const startedAt = this.now();
    try {
      const result = await task();
      this.emitRequest("batchUpdate", 1, startedAt, true, absentValue(), absentValue());
      return result;
    } catch (error: unknown) {
      const outcome = classifyTransportOutcome(error);
      this.emitRequest("batchUpdate", 1, startedAt, false, outcome.httpStatus, outcome.code);
      throw error;
    }
  }

  private emitRequest(
    operation: "getSpreadsheet" | "batchUpdate",
    operationCount: number,
    startedAt: number,
    ok: boolean,
    httpStatus: Presence<number>,
    code: Presence<string>,
  ): void {
    try {
      this.onRequest?.({
        operation,
        operationCount,
        startedAt,
        durationMs: Math.max(0, this.now() - startedAt),
        ok,
        httpStatus,
        code,
      });
    } catch {
      // Diagnostics must never change a remote result.
    }
  }

  private definitionForPhysicalSheet(
    physicalSheetId: string,
  ): RegisteredSyncProjectionDefinition {
    const definition = this.definitions.find(
      (candidate) => candidate.sheet.physicalSheetId === physicalSheetId,
    );
    if (definition === undefined) {
      throw new SyncGatewayContractError(
        SYNC_GATEWAY_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
        "no projection definition exists for " + physicalSheetId,
      );
    }
    return definition;
  }
}

// ---------------------------------------------------------------------------
// Outbound helpers (ported from the Apps Script effect operations)
// ---------------------------------------------------------------------------

/**
 * Validates the optional authority fence evidence on mutating requests,
 * mirroring the Apps Script `assertAuthority_` shape checks: when present,
 * the epoch must be a safe integer >= 1 and the token a non-empty string.
 *
 * The remote Script Properties fence is intentionally NOT written in direct
 * mode: the SQLite spreadsheet_authority row plus the writer/effect leases
 * are the fence under the single-authoritative-SQLite premise, while Apps
 * Script keeps its own Script Properties fence in gateway mode.
 */
function validateAuthority(authority: SyncGatewayAuthority | undefined): void {
  if (authority === undefined) return;
  if (
    authority === null ||
    typeof authority !== "object" ||
    Array.isArray(authority) ||
    !Number.isSafeInteger(authority.epoch) ||
    authority.epoch < 1 ||
    typeof authority.token !== "string" ||
    authority.token.length === 0
  ) {
    invalidProviderRequest("sync gateway", "authority is invalid");
  }
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

/** Locates one planned write's row in a fresh verification context. */
function findProbeRowInContext(context: PreflightContext, plan: EffectPlan): PreflightRow | undefined {
  const mutation = plan.mutation;
  if (mutation === undefined) return undefined;
  if (mutation.kind === "append") {
    return context.rows.find((row) => row.rowNumber === mutation.row.rowNumber);
  }
  const anchor = mutation.row.anchor;
  if (anchor.kind === "present") {
    return context.rows.find((row) =>
      row.physicalAnchor.kind === "present" && row.physicalAnchor.value === anchor.value);
  }
  const identity = mutation.row.identity;
  if (identity.kind === "present") {
    return context.rows.find((row) =>
      row.identity.kind === "present" && row.identity.value === identity.value);
  }
  return undefined;
}

/**
 * Route validation against the registered definition (mirrors
 * `validateRoute` in the Apps Script operation gateway).
 */
function validateRoute(
  request: {
    readonly sheetName: string;
    readonly registeredRange: string;
    readonly projection: string;
    readonly schemaVersion: number;
  },
  definition: RegisteredSyncProjectionDefinition,
): void {
  if (
    request.sheetName !== definition.sheet.tabName ||
    request.registeredRange !== definition.sheet.registeredRange ||
    request.projection !== definition.sheet.projection ||
    request.schemaVersion !== definition.sheet.schemaVersion
  ) {
    throw new SyncGatewayContractError(
      SYNC_GATEWAY_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
      "sync gateway request does not match the registered projection " +
      definition.sheet.physicalSheetId,
    );
  }
}

/** Derives the per-route effect options exactly like the Apps Script gateway. */
function effectRouteOptions(
  definition: RegisteredSyncProjectionDefinition,
): {
  readonly identityField: Presence<string>;
  readonly checkboxHeaders: readonly string[];
} {
  const identityField = definition.sheet.projection === "system_state"
    ? definition.sheet.businessKeyField
    : definition.sheet.projection === "sync_conflicts"
      ? "Conflict_ID"
      : undefined;
  return {
    identityField: identityField === undefined
      ? absentValue()
      : presentValue(identityField),
    checkboxHeaders: definition.checkboxHeaders ?? [],
  };
}

/**
 * Validates a batchUpdate reply shape: one reply per request, with the
 * addSheet reply carrying the created sheet id. A malformed 2xx response must
 * not close effects, so this throws a delivery-uncertain state error.
 */
function requireValidBatchUpdateReply(value: unknown, requestCount: number): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalidProviderState("batchUpdate response must be an object");
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.replies) || record.replies.length !== requestCount) {
    invalidProviderState(
      `batchUpdate reply count does not match ${requestCount} requests`,
    );
  }
  record.replies.forEach((reply, index) => {
    if (reply === null || typeof reply !== "object" || Array.isArray(reply)) {
      invalidProviderState(`batchUpdate reply[${index}] must be an object`);
    }
    const replyRecord = reply as Record<string, unknown>;
    const addSheet = replyRecord.addSheet;
    if (addSheet === undefined) return;
    if (addSheet === null || typeof addSheet !== "object" || Array.isArray(addSheet)) {
      invalidProviderState(`batchUpdate reply[${index}].addSheet is invalid`);
    }
    const properties = (addSheet as Record<string, unknown>).properties;
    if (properties === null || typeof properties !== "object" || Array.isArray(properties)) {
      invalidProviderState(`batchUpdate reply[${index}].addSheet.properties is invalid`);
    }
    if (typeof (properties as Record<string, unknown>).sheetId !== "number") {
      invalidProviderState(`batchUpdate reply[${index}].addSheet.properties.sheetId is invalid`);
    }
  });
}

// ---------------------------------------------------------------------------
// Provisioning helpers
// ---------------------------------------------------------------------------

/** Validates provisioning registrations before any transport call. */
function validateProvisionRegistrations(
  registrations: readonly SyncGatewayProvisionRoute[],
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
  registration: SyncGatewayProvisionRoute,
  existing: { readonly gridProperties?: { readonly rowCount: number; readonly columnCount: number } },
): number {
  const parsed = parseRegisteredRange(registration.registeredRange);
  const registeredEnd = parsed.startColumn + parsed.columnCount - 1;
  const gridColumns = existing.gridProperties?.columnCount;
  if (gridColumns === undefined) return registeredEnd;
  return Math.max(gridColumns, registeredEnd);
}

/** Builds the A1 range end letters for one registered range. */
function rangeEndColumnLetters(registeredRange: string): string {
  const range = parseRegisteredRange(registeredRange);
  return columnLetters(range.startColumn + range.columnCount - 1);
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
  registration: SyncGatewayProvisionRoute,
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
