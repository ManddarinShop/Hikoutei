/**
 * Full sync provider over the Google Sheets REST API.
 *
 * Implements every provider capability the sync runtime needs with ONE
 * provider instance (one transport, separate read and write request-start
 * limiters, one telemetry sink): the outbound effect worker (fast append, applyEffects,
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
 * provisioning reads) and every `batchUpdate` acquires a request-start limiter
 * and emits one redacted telemetry event. Reads serialize only against reads;
 * writes only against writes, so a read and a write can start concurrently
 * (an idempotent get + a committed batchUpdate are safe to overlap) while
 * same-class bursts can never outpace the interval. Admission is bounded
 * SEPARATELY by an independent maximum admission wait
 * (`requestStartMaxWaitMs`, default 5,000 ms — not derived from the
 * interval): a request whose PREDICTED WAIT for a slot exceeds that bound
 * is refused before any SDK call with the stable delivery-uncertain
 * `google_sheets_api_request_start_refused` error, so an arbitrarily long
 * limiter queue can never make a request wait past its effect lease — the
 * durable worker requeues instead.
 */

import { randomUUID } from "node:crypto";
import type {
  ApplySyncEffectsRequest,
  ApplySyncEffectsResult,
  EnsureSyncRowAnchorsRequest,
  EnsureSyncRowAnchorsResult,
  FastAppendRowsRequest,
  FastAppendRowsResult,
  ReadSyncEffectPostconditionsRequest,
  ReadSyncSnapshotRequest,
  ReadSyncTableRowsRequest,
  PreparedApplyEffects,
  SyncEffectPostcondition,
  SyncEffectPostconditionResult,
  SyncEffectResult,
  SyncEffectWorkerProvider,
  SyncObservedSnapshot,
  SyncSheetsObservationBatchProvider,
  SyncSheetsObservationProvider,
  SyncSheetsSnapshot,
  SyncSheetsTableReader,
  SyncProjectionEffect,
  SyncTableRowsResult,
} from "@hikoutei/contracts/sheets/syncSheets.js";
import {
  SYNC_SHEETS_ERROR_CODES,
  SyncSheetsContractError,
} from "@hikoutei/contracts/sheets/errors.js";
import type {
  RegisteredSyncProjectionDefinition,
  SyncSheetsProvisioner,
  SyncSheetsProvisionRoute,
} from "@hikoutei/contracts/sheets/sheetsProvisioning.js";
import {
  GOOGLE_SHEETS_API_DEFAULTS,
} from "./constants.js";
import { invalidProviderRequest } from "./errors.js";
import {
  GoogleSheetsApiHttpTransport,
  type GoogleSheetsApiTransport,
} from "./transport/googleSheetsApiTransport.js";
import { ReceiptReadCursor } from "./model/receiptCursor.js";
import { RequestStartLimiter, ReadQoSScheduler } from "./transport/rateLimiter.js";
import type { GoogleSheetsApiProviderDeps } from "./operations/shared.js";
import { PromiseTailLock } from "./operations/shared.js";
import {
  fastAppendRows,
} from "./operations/fastAppend.js";
import {
  applyEffects,
  applyPreparedEffects as applyPreparedEffectsOp,
  preflightApplyEffects as preflightApplyEffectsOp,
  readEffectPostcondition,
  readEffectPostconditions,
} from "./operations/applyEffects.js";
import {
  observeSnapshot,
  observeSnapshots,
  readRows,
  readRowsBatch,
  readSnapshot,
} from "./operations/readRows.js";
import {
  ensureRowAnchors,
} from "./operations/anchors.js";
import {
  provisionRegistry,
} from "./operations/provisioning.js";

// P8-C sole-source: the redacted telemetry event and provider options
// surface live in the contracts leaf; re-exported here so existing
// adapter-internal and test import paths stay valid.
export type {
  GoogleSheetsApiRequestEvent,
  GoogleSheetsApiProviderOptions,
} from "@hikoutei/contracts/sheets/googleSheetsApi.js";
import type {
  GoogleSheetsApiProviderOptions,
  GoogleSheetsApiRequestEvent,
} from "@hikoutei/contracts/sheets/googleSheetsApi.js";

/** Full construction options (bootstrap supplies spreadsheet and routes). */
export interface GoogleSheetsApiSyncProviderOptions extends GoogleSheetsApiProviderOptions {
  readonly spreadsheetId: string;
  readonly definitions: readonly RegisteredSyncProjectionDefinition[];
}

/**
 * Full sync provider over the Sheets REST API: outbound effects, provisioning,
 * table reads, anchors, and snapshots behind the shared provider contracts.
 *
 * All reads share ONE request-start timeline (a read QoS scheduler with
 * weighted polling/preflight fairness) and all writes share ONE write
 * request-start limiter, so reads serialize only against reads and writes
 * only against writes (an idempotent read and a committed write may start
 * concurrently); the worker-level append throttle stays enabled on
 * top in service mode via the bootstrap's bulk worker options. Provisioning
 * runs at startup before the worker, and observation anchors are the only
 * metadata mutations outside effect batches.
 *
 * The class is a thin facade: every method body lives in an operation module
 * under `operations/` and receives the immutable wiring from `this.deps`.
 */
export class GoogleSheetsApiSyncProvider
  implements
    SyncEffectWorkerProvider,
    SyncSheetsObservationProvider,
    SyncSheetsObservationBatchProvider,
    SyncSheetsTableReader,
    SyncSheetsProvisioner {
  private readonly spreadsheetId: string;
  private readonly definitions: readonly RegisteredSyncProjectionDefinition[];
  private readonly transport: GoogleSheetsApiTransport;
  private readonly transportTimeoutMs: number;
  private readonly readTimeoutMs: number;
  private readonly maxBatchBytes: number;
  private readonly readScheduler: ReadQoSScheduler;
  private readonly writeLimiter: RequestStartLimiter;
  /** Bounded admission: independent max request-start wait (default 5,000
   * ms), separate from the pacing interval. */
  private readonly maxRequestStartWaitMs: number;
  private readonly now: () => number;
  private readonly onRequest: ((event: GoogleSheetsApiRequestEvent) => void) | undefined;
  private readonly deps: GoogleSheetsApiProviderDeps;

  public constructor(options: GoogleSheetsApiSyncProviderOptions) {
    if (options.definitions.length === 0) {
      throw new SyncSheetsContractError(
        SYNC_SHEETS_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
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
        throw new SyncSheetsContractError(
          SYNC_SHEETS_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
          "Google Sheets API sync provider definitions must target one spreadsheet",
        );
      }
    }
    const maxBatchBytes = options.maxBatchBytes ?? GOOGLE_SHEETS_API_DEFAULTS.MAX_BATCH_REQUEST_BYTES;
    if (!Number.isSafeInteger(maxBatchBytes) || maxBatchBytes < 1) {
      invalidProviderRequest("Google Sheets API sync provider", "maxBatchBytes is invalid");
    }
    const intervalMs = options.rateLimitIntervalMs ?? GOOGLE_SHEETS_API_DEFAULTS.REQUEST_START_INTERVAL_MS;
    const maxAdmissionWaitMs = options.requestStartMaxWaitMs
      ?? GOOGLE_SHEETS_API_DEFAULTS.REQUEST_START_MAX_ADMISSION_WAIT_MS;
    this.spreadsheetId = options.spreadsheetId;
    this.definitions = options.definitions;
    this.transport = options.transport ?? new GoogleSheetsApiHttpTransport({ requestTimeoutMs });
    this.transportTimeoutMs = requestTimeoutMs;
    this.readTimeoutMs = readTimeoutMs;
    this.maxBatchBytes = maxBatchBytes;
    this.now = options.now ?? Date.now;
    this.readScheduler = new ReadQoSScheduler({
      intervalMs,
      now: this.now,
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    });
    this.writeLimiter = new RequestStartLimiter({
      intervalMs,
      now: this.now,
      ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    });
    // Admission bound is independent of the pacing interval: a postcondition
    // read (paced on the WRITE limiter) is allowed to wait a few intervals for
    // the write slot, while the interval still spaces request STARTS for quota
    // safety. Deeper reservations than the bound are refused before any SDK
    // call (delivery-uncertain, requeued by the durable worker) instead of
    // waiting out an unbounded queue.
    this.maxRequestStartWaitMs = maxAdmissionWaitMs;
    this.onRequest = options.onRequest;
    this.deps = {
      spreadsheetId: this.spreadsheetId,
      providerNonce: "provider:" + randomUUID(),
      preparedStateRegistry: new WeakSet<object>(),
      receiptInitLock: new PromiseTailLock(),
      receiptReadCursor: new ReceiptReadCursor(),
      definitions: this.definitions,
      transport: this.transport,
      readTimeoutMs: this.readTimeoutMs,
      maxBatchBytes: this.maxBatchBytes,
      readScheduler: this.readScheduler,
      writeLimiter: this.writeLimiter,
      maxRequestStartWaitMs: this.maxRequestStartWaitMs,
      now: this.now,
      onRequest: this.onRequest,
    };
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
    return fastAppendRows(this.deps, request);
  }

  /** Applies regular update/delete/create effects through one atomic batch. */
  public async applyEffects(request: ApplySyncEffectsRequest): Promise<ApplySyncEffectsResult> {
    return applyEffects(this.deps, request);
  }

  /** Read+plan stage of one apply request; never mutates the sheet. */
  public async preflightApplyEffects(
    request: ApplySyncEffectsRequest,
  ): Promise<PreparedApplyEffects> {
    return preflightApplyEffectsOp(this.deps, request);
  }

  /** Write+verify stage that consumes preflight prepared state. */
  public async applyPreparedEffects(
    prepared: PreparedApplyEffects,
  ): Promise<ApplySyncEffectsResult> {
    return applyPreparedEffectsOp(this.deps, prepared);
  }

  /** Classifies one response-loss effect through a fresh target+receipt read. */
  public async readEffectPostcondition(effect: SyncProjectionEffect): Promise<SyncEffectPostcondition> {
    return readEffectPostcondition(this.deps, effect);
  }

  /** Classifies a recovery batch with one shared target+receipt read. */
  public async readEffectPostconditions(
    request: ReadSyncEffectPostconditionsRequest,
  ): Promise<readonly SyncEffectPostconditionResult[]> {
    return readEffectPostconditions(this.deps, request);
  }

  // -------------------------------------------------------------------------
  // Projection provisioning (SyncSheetsProvisioner)
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
    registrations: readonly SyncSheetsProvisionRoute[],
  ): Promise<{
    readonly registrations: readonly Omit<SyncSheetsProvisionRoute, "headers">[];
    readonly createdSheets: readonly string[];
    readonly initializedHeaders: readonly string[];
  }> {
    return provisionRegistry(this.deps, registrations);
  }

  // -------------------------------------------------------------------------
  // Values-only table reads (readRows / readRowsBatch)
  // -------------------------------------------------------------------------

  /** Reads one registered table's literal values with one REST read. */
  public async readRows(request: ReadSyncTableRowsRequest): Promise<SyncTableRowsResult> {
    return readRows(this.deps, request);
  }

  /**
   * Reads several registered tables through ONE `spreadsheets.get` call.
   * Results are returned in request order; a missing tab, header drift, or
   * malformed payload fails closed before any result is produced.
   */
  public async readRowsBatch(
    requests: readonly ReadSyncTableRowsRequest[],
  ): Promise<readonly SyncTableRowsResult[]> {
    return readRowsBatch(this.deps, requests);
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
    return ensureRowAnchors(this.deps, request);
  }

  /** Reads one full snapshot without any mutation (lock-free). */
  public async readSnapshot(request: ReadSyncSnapshotRequest): Promise<SyncSheetsSnapshot> {
    return readSnapshot(this.deps, request);
  }

  /** Combines anchor assignment and one snapshot read under one request. */
  public async observeSnapshot(request: ReadSyncSnapshotRequest): Promise<SyncObservedSnapshot> {
    return observeSnapshot(this.deps, request);
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
    return observeSnapshots(this.deps, requests);
  }
}
