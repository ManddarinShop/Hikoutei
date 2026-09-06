/**
 * Shared wiring and pacing helpers for the Google Sheets API provider
 * operations.
 *
 * The provider class hands one immutable `GoogleSheetsApiProviderDeps` object
 * to every operation function so the class stays a thin facade. Bounded
 * request-start admission (independent read/write lanes, per-credential
 * slots) lives in the kernel (`@hikoutei/ikisaki`); the `runRead`/`runWrite`
 * wrappers here bind that admission to Sheets telemetry, quota-outcome
 * feedback, and refusal errors. Route validation against the registered
 * definition and batchUpdate reply validation live here because every
 * operation shares them.
 */

import type { RegisteredSyncProjectionDefinition } from "@hikoutei/contracts/sheets/sheetsProvisioning.js";
import {
  SYNC_INVALID_PROVIDER_OPERATIONS,
  SYNC_INVALID_PROVIDER_REASONS,
  SYNC_SHEETS_ERROR_CODES,
  SyncSheetsContractError,
} from "@hikoutei/contracts/sheets/errors.js";
import { classifyTransportOutcome, sanitizeTransportRemoteCode } from "@hikoutei/contracts/sheets/transportOutcome.js";
import { presentValue, absentValue, PRESENCE_KINDS, type Presence } from "@hikoutei/contracts/state/index.js";
import {
  HIKOUTEI_LOG_LEVELS,
  logHikouteiInternalEvent,
} from "@hikoutei/contracts/shared/observability/internalLog.js";
import {
  HIKOUTEI_LOG_COMPONENTS,
  HIKOUTEI_LOG_EVENTS,
} from "@hikoutei/contracts/shared/observability/logEvents.js";
import type { GoogleSheetsApiRequestEvent } from "../GoogleSheetsApiSyncProvider.js";
import type { GoogleSheetsApiTransport } from "../transport/googleSheetsApiTransport.js";
import {
  createEngineRuntime as createNeutralEngineRuntime,
  ensureBandRowBounds,
  type BandedGet,
  type BandEvidence,
  type EngineRuntime,
} from "@hikoutei/ikisaki";
import {
  executeBatchUpdate as executeNeutralBatchUpdate,
  executePreparedWrite as executeNeutralPreparedWrite,
  groupByRouteKey as groupNeutralByRouteKey,
  receiptInitNeeded as receiptInitNeededNeutral,
  refreshFirstRouteContext as refreshNeutralFirstRouteContext,
  type WriteBatchTelemetry,
} from "@hikoutei/ikisaki";
import {
  ReceiptReadCursor,
  type ReadCalibration,
} from "@hikoutei/ikisaki";
import type {
  ParsedGridData,
  ParsedSheet,
  PreflightContext,
  PreflightReceipt,
} from "../model/preflightContext.js";
import {
  enumerateSheetProperties,
} from "../model/preflightContext.js";
import {
  parseSpreadsheetDocument,
} from "../model/preflightParsing.js";
import type { BuiltApplyBatch } from "../model/batchBuilder.js";
import type {
  ReadQoSScheduler,
  RequestStartLimiter,
} from "@hikoutei/ikisaki";
import {
  admitRequestStart,
  credentialBinding,
  type CredentialPacingPool,
  type RequestStartPacing,
} from "@hikoutei/ikisaki";
import {
  isQuotaLimitedOutcome,
  QUOTA_GOVERNOR_LANES,
  type QuotaGovernorTimingDefaults,
  type QuotaPacingGovernor,
  type RollingQuotaBudget,
} from "@hikoutei/ikisaki";

/**
 * Re-exports of the neutral request-start admission surface (owned by
 * `@hikoutei/ikisaki` `worker/pacing/requestAdmission.ts`) so operation
 * modules keep importing the pacing vocabulary from this shared wiring
 * module. Route validation, batchUpdate reply validation, and
 * transport-outcome mapping stay Sheets-owned below.
 */
export {
  credentialBinding,
  type CredentialPacingPool,
  type CredentialPacingSlot,
  type ReadPacing,
  type RequestStartAdmissionOutcome,
  type RequestStartPacing,
} from "@hikoutei/ikisaki";
import {
  GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES,
  GoogleSheetsApiTransportError,
  invalidProviderState,
} from "../errors.js";
import { batchUpdateResponseShapeSchema } from "../model/rawResponseSchemas.js";

/**
 * Minimal FIFO promise-tail lock used to serialize shared receipt-tab
 * initialization.
 *
 * The Google Sheets API provider holds one instance per spreadsheet. Two
 * prepared write batches (possibly on different routes/sheets) that both
 * preflighted the shared receipt tab absent can race: without a guard, both
 * re-read and, if the tab still does not exist, both emit a duplicate
 * `addSheet`, failing the second write with a 400. This serializes the
 * refresh+write so the first writer creates the tab and later writers append
 * to it instead. It is a promise gate, not a worker/lease authority; the
 * durable outbox, leases, and receipts remain the source of truth.
 */
export class PromiseTailLock {
  private tail: Promise<void> = Promise.resolve();

  /** Runs `task` after any prior holder completes; never deadlocks on throw. */
  public run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    // The tail always settles (even when `task` rejects) so the next holder
    // proceeds instead of waiting forever on a failed mutation.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/** Immutable wiring every operation function receives from the provider. */
export interface GoogleSheetsApiProviderDeps {
  readonly spreadsheetId: string;
  /**
   * Per-instance nonce bound into every prepared-apply state this provider
   * produces, so a prepared token from another provider instance (e.g. after
   * the provider was re-pointed to a new spreadsheet) fails closed before any
   * write even when the spreadsheetId happens to match.
   */
  readonly providerNonce: string;
  /**
   * Identity registry of the exact prepared-apply state objects this provider
   * produced. `preflightApplyEffects` registers each returned state; the
   * write+verify stage rejects any state not in this registry, so a forged or
   * replaced nested plan fails before any remote call.
   */
  readonly preparedStateRegistry: WeakSet<object>;
  /**
   * Per-spreadsheet guard for shared receipt-tab initialization. Acquired
   * only when a prepared write observed the receipt absent; once the tab
   * exists later writes never touch it, so steady state pays no lock.
   */
  readonly receiptInitLock: PromiseTailLock;
  readonly definitions: readonly RegisteredSyncProjectionDefinition[];
  readonly transport: GoogleSheetsApiTransport;
  /**
   * Per-provider receipt READ cursor (neutral `ReceiptReadCursor` over the
   * Sheets `PreflightReceipt` evidence). Steady state apply/fast-append
   * preflights AND postcondition probes read only the receipt tail band
   * this cursor opens; the receipt-refresh path and the probe's
   * whole-table evidence fallback keep the historical full receipt read.
   */
  readonly receiptReadCursor: ReceiptReadCursor<PreflightReceipt>;
  /**
   * Per-provider authoritative ROW BOUND cache (sheet title → committed
   * `gridProperties.rowCount`) for the unified read engine's band planning.
   * Settled by a range-less metadata enumeration when cold (see
   * `ensureSheetRowBounds`) and refreshed from EVERY engine response's
   * sheet properties, so it tracks grid growth without extra calls. A
   * too-low entry can never truncate coverage: the engine's last band per
   * column always stays open-ended.
   */
  readonly sheetRowBounds: Map<string, number>;
  /**
   * Per-provider read-size calibration (neutral kernel planner): observed
   * `responseBytes ÷ cellsRequested` above a class constant inflates future
   * estimates, shrinking band sizes on the NEXT plan (telemetry-based budget
   * reduction; never grows one request).
   */
  readonly readCalibration: ReadCalibration;
  readonly readTimeoutMs: number;
  readonly maxBatchBytes: number;
  /**
   * Internal read QoS scheduler: pacing and weighted fairness for read-class
   * starts. POLLING (values/observation/safety reads) and PREFLIGHT (outbound
   * read-ahead reads) share ONE timeline and interval under the 2:1 weighted
   * policy; the separate WRITE limiter paces writes independently.
   */
  readonly readScheduler: ReadQoSScheduler;
  /** Write limiter: batchUpdate starts serialize only against writes. */
  readonly writeLimiter: RequestStartLimiter;
  /**
   * The single quota/backoff marker object for this provider: the SAME
   * object builds every pooled governor AND feeds both
   * `isQuotaLimitedOutcome` call sites below, so pacing backoff and
   * quota-outcome classification can never diverge on the markers.
   */
  readonly timingDefaults: QuotaGovernorTimingDefaults;
  /**
   * Sliding-window per-minute request-start budget for the READ lane
   * (getSpreadsheet starts, paced on either read class). Enforced IN
   * ADDITION to the interval pacing: a start needs both a budget slot and
   * an interval slot. Postcondition reads paced on the write lane count
   * against the write budget instead (they are rare recovery traffic).
   */
  readonly readBudget: RollingQuotaBudget;
  /** Sliding-window per-minute request-start budget for the WRITE lane. */
  readonly writeBudget: RollingQuotaBudget;
  /**
   * AIMD pacing feedback: quota-limited (429) responses grow the offending
   * lane's pacing interval via the limiters' `getIntervalMs`, quiet success
   * recovers it gradually. Gates request STARTS only; never touches CAS,
   * prepared state, or result handling. Constructed with the single
   * `timingDefaults` object above (one per pooled identity).
   */
  readonly quotaGovernor: QuotaPacingGovernor;
  /**
   * Maximum admitted wait for ONE request start: a call whose predicted slot
   * is further out is refused before transport. The per-minute budget gate
   * and the lane pacing gate SHARE this one bound via a single admission
   * deadline, so total bounded-admission waiting never exceeds it. On a
   * pooled run the SAME deadline spans the whole search: each refusal moves
   * on to the next slot with only the time still remaining, so a busy
   * identity never blocks a healthy one and one request start still pays at
   * most one bounded wait.
   */
  readonly maxRequestStartWaitMs: number;
  /**
   * Per-credential pacing pool (credential pools with 2+ identities only).
   * `undefined` — the historical single-credential path — keeps admission
   * byte-identical: the flat `readScheduler`/`writeLimiter`/budgets/
   * `quotaGovernor` fields above ARE the one slot, and transport requests
   * carry no `credentialIndex`.
   */
  readonly credentialPacing?: CredentialPacingPool;
  readonly now: () => number;
  readonly onRequest: ((event: GoogleSheetsApiRequestEvent) => void) | undefined;
}

/**
 * Static, redacted refusal message. Never embeds effect ids, sheet names,
 * spreadsheet ids, or limiter state: the durable worker only needs the
 * stable code to requeue through the CAS/recovery path.
 */
const REQUEST_START_REFUSED_MESSAGE =
  "Google Sheets API request start refused before transport: the pacing queue exceeds the bounded admission wait.";

/**
 * Shared refusal exit for both admission stages: one redacted boundary log
 * (stable code + lane tag only) and the delivery-uncertain
 * REQUEST_START_REFUSED error the durable worker requeues through.
 */
function refuseRequestStart(
  deps: GoogleSheetsApiProviderDeps,
  pacing: RequestStartPacing,
): never {
  // Boundary record for a locally refused start: only the stable code and the
  // read-class tag are logged (retryable, like the other delivery-uncertain
  // buckets), never a message, payload, id, or URL.
  logHikouteiInternalEvent({
    event: HIKOUTEI_LOG_EVENTS.TRANSPORT_REQUEST_FAILED,
    level: HIKOUTEI_LOG_LEVELS.WARN,
    component: HIKOUTEI_LOG_COMPONENTS.TRANSPORT,
    code: GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.REQUEST_START_REFUSED,
    pacing,
    errorClass: "GoogleSheetsApiTransportError",
    retryable: true,
  });
  throw new GoogleSheetsApiTransportError(
    GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.REQUEST_START_REFUSED,
    REQUEST_START_REFUSED_MESSAGE,
    absentValue(),
    absentValue(),
  );
}

/**
 * Redacted batch metadata attached to one write request event.
 *
 * Only counts and byte estimates are exposed; never ids, spreadsheet ids,
 * URLs, credentials, values, or payloads. All fields are optional so a
 * caller that lacks a value simply omits it.
 */
export interface GoogleSheetsApiRequestMeta {
  /** Pacing wait before the request-start slot was granted (0 when none). */
  readonly pacingWaitMs?: number;
  /**
   * Pool identity this request was admitted AND signed with (index only,
   * never any credential material); absent on the single-credential path.
   */
  readonly credentialIndex?: number;
  /** Number of batchUpdate requests in the written batch. */
  readonly requestCount?: number;
  /** Serialized batchUpdate body-size estimate in bytes. */
  readonly bodyBytes?: number;
  /** Effects requested for this write batch. */
  readonly requestedEffects?: number;
  /** Effects included in the written batch (the budget-fitting prefix). */
  readonly includedEffects?: number;
  /**
   * Parsed-response size estimate in bytes (see the event field docs).
   * Computed by the run helpers ONLY while a telemetry sink is attached.
   */
  readonly responseBytes?: number;
}

/**
 * Estimates the serialized size of one parsed transport response.
 *
 * The transport hands back PARSED JSON (no raw bytes), so the payload size
 * is a `JSON.stringify().length` estimate. Returns `undefined` when the
 * value cannot be serialized (e.g. BigInt) instead of throwing: a size
 * estimate must never change a successful remote result.
 */
export function estimateJsonBytesOrNull(value: unknown): number | undefined {
  try {
    return JSON.stringify(value).length;
  } catch {
    return undefined;
  }
}

/**
 * Builds one raw-response measurement carrier: `meta` for `runRead`/`runWrite`
 * plus the matching `onRawResponse` callback for read helpers that can capture
 * the RAW transport document before parsing. Both are `undefined`-safe: with
 * no telemetry sink attached, `onRawResponse` is `undefined` and the meta
 * carrier stays empty (zero estimate cost without telemetry).
 */
export function createRawResponseMeta(deps: GoogleSheetsApiProviderDeps): {
  readonly meta: { responseBytes?: number };
  readonly onRawResponse: ((raw: unknown) => void) | undefined;
} {
  const meta: { responseBytes?: number } = {};
  return {
    meta,
    onRawResponse: deps.onRequest === undefined
      ? undefined
      : (raw) => {
        const bytes = estimateJsonBytesOrNull(raw);
        if (bytes !== undefined) meta.responseBytes = bytes;
      },
  };
}

/**
 * Paces ONE `getSpreadsheet` transport call and emits one read event.
 *
 * `pacing` selects the request-start lane: the two read classes route through
 * the shared read QoS scheduler (`polling` for values/observation/safety
 * reads, `preflight` for outbound read-ahead), while a postcondition read
 * that verifies a just-written row passes `"write"` so it serializes against
 * writes instead of competing with the read burst. The telemetry operation
 * stays `getSpreadsheet` in both cases — it is still a read transport call;
 * only the pacing lane changes.
 */
export async function runRead<T>(
  deps: GoogleSheetsApiProviderDeps,
  /** Receives the admitted pool identity; the task MUST bind it into the
   * transport request via `credentialBinding` when the pool is active
   * (`undefined` on the single-credential path). */
  task: (credentialIndex: number | undefined) => Promise<T>,
  pacing: RequestStartPacing = "polling",
  meta?: GoogleSheetsApiRequestMeta,
): Promise<T> {
  // Pacing admission lives in the kernel; a refused start throws the stable
  // delivery-uncertain error here (Sheets vocabulary) before any SDK call.
  const admission = await admitRequestStart(deps, pacing)
    ?? refuseRequestStart(deps, pacing);
  const { pacingWaitMs, credentialIndex } = admission;
  const startedAt = deps.now();
  try {
    const result = await task(credentialIndex);
    // Payload-size evidence for the preflight-vs-polling read-gap question:
    // gated on the sink so a telemetry-less deployment pays zero estimate cost.
    // A caller that measured the RAW response document supplies a meta carrier
    // (e.g., observation reads whose task returns a parsed Map, which cannot be
    // re-serialized meaningfully): its `responseBytes` is then used as-is, with
    // NO fallback to stringifying the task result — an unserializable raw
    // document records no bytes rather than a meaningless 2-byte `"{}"`.
    const responseBytes = deps.onRequest === undefined
      ? undefined
      : (meta === undefined
        ? estimateJsonBytesOrNull(result)
        : meta.responseBytes);
    emitRequest(deps, "getSpreadsheet", pacing, 1, startedAt, true, absentValue(), absentValue(), {
      pacingWaitMs,
      ...credentialBinding(credentialIndex),
      ...(responseBytes === undefined ? {} : { responseBytes }),
    });
    return result;
  } catch (error: unknown) {
    const outcome = classifyTransportOutcome(error);
    // AIMD feedback hook: a remote 429/RESOURCE_EXHAUSTED grows THIS lane's
    // pacing interval on the NEXT reservation of the SAME pooled identity
    // only; any other failure leaves the governor untouched (the durable
    // worker's own retry path is unchanged).
    if (isQuotaLimitedOutcome(outcome, deps.timingDefaults)) {
      admission.slot.quotaGovernor.recordQuotaLimited(
        pacing === "write" ? QUOTA_GOVERNOR_LANES.WRITE : QUOTA_GOVERNOR_LANES.READ,
      );
    }
    emitRequest(deps, "getSpreadsheet", pacing, 1, startedAt, false, outcome.httpStatus, outcome.code, {
      pacingWaitMs,
      ...credentialBinding(credentialIndex),
    });
    throw error;
  }
}

/** Paces ONE `batchUpdate` transport call and emits one write event. */
export async function runWrite<T>(
  deps: GoogleSheetsApiProviderDeps,
  /** See `runRead`: bind the admitted pool identity into the request. */
  task: (credentialIndex: number | undefined) => Promise<T>,
  meta?: GoogleSheetsApiRequestMeta,
): Promise<T> {
  const admission = await admitRequestStart(deps, "write")
    ?? refuseRequestStart(deps, "write");
  const { pacingWaitMs, credentialIndex } = admission;
  const startedAt = deps.now();
  try {
    const result = await task(credentialIndex);
    const responseBytes = deps.onRequest === undefined
      ? undefined
      : estimateJsonBytesOrNull(result);
    emitRequest(deps, "batchUpdate", "write", 1, startedAt, true, absentValue(), absentValue(), {
      pacingWaitMs,
      ...credentialBinding(credentialIndex),
      ...meta,
      ...(responseBytes === undefined ? {} : { responseBytes }),
    });
    return result;
  } catch (error: unknown) {
    const outcome = classifyTransportOutcome(error);
    if (isQuotaLimitedOutcome(outcome, deps.timingDefaults)) {
      admission.slot.quotaGovernor.recordQuotaLimited(QUOTA_GOVERNOR_LANES.WRITE);
    }
    emitRequest(deps, "batchUpdate", "write", 1, startedAt, false, outcome.httpStatus, outcome.code, {
      pacingWaitMs,
      ...credentialBinding(credentialIndex),
      ...meta,
    });
    throw error;
  }
}

/**
 * Emits one redacted telemetry event; diagnostics must never throw.
 *
 * The code is re-sanitized at the sink as defense in depth: every value
 * reaching `onRequest` is either an allowlisted stable code or the fixed
 * `unknown` category, so a future caller can never forward an arbitrary
 * remote string.
 */
export function emitRequest(
  deps: GoogleSheetsApiProviderDeps,
  operation: "getSpreadsheet" | "batchUpdate",
  pacing: RequestStartPacing,
  operationCount: number,
  startedAt: number,
  ok: boolean,
  httpStatus: Presence<number>,
  code: Presence<string>,
  meta?: GoogleSheetsApiRequestMeta,
): void {
  try {
    deps.onRequest?.({
      operation,
      pacing,
      operationCount,
      startedAt,
      durationMs: Math.max(0, deps.now() - startedAt),
      ok,
      httpStatus,
      code: code.kind === PRESENCE_KINDS.PRESENT
        ? presentValue(sanitizeTransportRemoteCode(code.value))
        : code,
      ...meta,
    });
  } catch {
    // Diagnostics must never change a remote result.
  }
}

/** Resolves the registered projection definition for one physical sheet. */
export function definitionForPhysicalSheet(
  deps: GoogleSheetsApiProviderDeps,
  physicalSheetId: string,
): RegisteredSyncProjectionDefinition {
  const definition = deps.definitions.find(
    (candidate) => candidate.sheet.physicalSheetId === physicalSheetId,
  );
  if (definition === undefined) {
    throw new SyncSheetsContractError(
      SYNC_SHEETS_ERROR_CODES.INVALID_PROVISIONING_DEFINITIONS,
      "no projection definition exists for " + physicalSheetId,
    );
  }
  return definition;
}

/**
 * Route validation against the registered definition (mirrors
 * `validateRoute` in the Apps Script operation provider).
 */
export function validateRoute(
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
    throw new SyncSheetsContractError(
      SYNC_SHEETS_ERROR_CODES.INVALID_EFFECT_PAYLOAD,
      "sync provider request does not match the registered projection " +
      definition.sheet.physicalSheetId,
    );
  }
}

/** Derives the per-route effect options exactly like the Apps Script provider. */
export function effectRouteOptions(
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
 * not close effects, so this throws a delivery-uncertain state error
 * classified as a `batch_update_reply` / `malformed_reply` invalid state.
 */
export function requireValidBatchUpdateReply(value: unknown, requestCount: number): void {
  const batchUpdateClassification = {
    operation: SYNC_INVALID_PROVIDER_OPERATIONS.BATCH_UPDATE_REPLY,
    reason: SYNC_INVALID_PROVIDER_REASONS.MALFORMED_REPLY,
  } as const;
  const parsed = batchUpdateResponseShapeSchema.safeParse(value);
  if (!parsed.success) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      invalidProviderState("batchUpdate response must be an object", batchUpdateClassification);
    }
    invalidProviderState(
      `batchUpdate reply count does not match ${requestCount} requests`,
      batchUpdateClassification,
    );
  }
  const record = parsed.data;
  if (record.replies.length !== requestCount) {
    invalidProviderState(
      `batchUpdate reply count does not match ${requestCount} requests`,
      batchUpdateClassification,
    );
  }
  record.replies.forEach((reply, index) => {
    if (reply === null || typeof reply !== "object" || Array.isArray(reply)) {
      invalidProviderState(`batchUpdate reply[${index}] must be an object`, batchUpdateClassification);
    }
    const replyRecord = reply as Record<string, unknown>;
    const addSheet = replyRecord.addSheet;
    if (addSheet === undefined) return;
    if (addSheet === null || typeof addSheet !== "object" || Array.isArray(addSheet)) {
      invalidProviderState(`batchUpdate reply[${index}].addSheet is invalid`, batchUpdateClassification);
    }
    const properties = (addSheet as Record<string, unknown>).properties;
    if (properties === null || typeof properties !== "object" || Array.isArray(properties)) {
      invalidProviderState(`batchUpdate reply[${index}].addSheet.properties is invalid`, batchUpdateClassification);
    }
    if (typeof (properties as Record<string, unknown>).sheetId !== "number") {
      invalidProviderState(`batchUpdate reply[${index}].addSheet.properties.sheetId is invalid`, batchUpdateClassification);
    }
  });
}

/**
 * Thin Sheets adapters over the neutral kernel engines.
 *
 * These keep the historical operation signatures: they convert the Sheets
 * grid model to the kernel's neutral descriptors at the call site (sheet
 * bounds, calibration, receipt evidence), run the neutral iteration, and
 * map telemetry/validation back into Sheets vocabulary. The band/batch
 * planning and execution semantics live in `@hikoutei/ikisaki` and are
 * unchanged here.
 */

/** Sheets grid documents keyed the way the transport returns them. */
export type SheetsBandedGet = BandedGet<ParsedSheet, number, ParsedGridData>;
export type SheetsEngineRuntime = EngineRuntime<ParsedSheet, number, ParsedGridData>;

/**
 * Builds the executor for ONE logical read: fixed field mask, evidence
 * class, pacing lane, and telemetry label. The returned closure owns no
 * state — bounds/calibration updates land on the shared `deps` carriers.
 */
export function createBandedGet(
  deps: GoogleSheetsApiProviderDeps,
  pacing: RequestStartPacing,
  fields: string,
  evidence: BandEvidence,
  label: string,
): SheetsBandedGet {
  return createEngineRuntime(deps, pacing, label).makeGet(fields, evidence);
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
): SheetsEngineRuntime {
  return createNeutralEngineRuntime<ParsedSheet, number, ParsedGridData>({
    makeFetch: (fields, evidence) => async (addresses) => {
      // The RAW document is measured INSIDE the paced task (the awaited-call
      // ordering the historical reads proved): runRead emits its telemetry
      // event when the task resolves, so a later measurement would land one
      // event too late.
      const rawMeta = createRawResponseMeta(deps);
      const raw = await runRead(deps, async (credentialIndex) => {
        const response = await deps.transport.getSpreadsheet({
          spreadsheetId: deps.spreadsheetId,
          ranges: [...addresses],
          fields,
          ...(deps.readTimeoutMs === undefined ? {} : { timeoutMs: deps.readTimeoutMs }),
          ...credentialBinding(credentialIndex),
        });
        rawMeta.onRawResponse?.(response);
        return response;
      }, pacing, rawMeta.meta);
      const document = parseSpreadsheetDocument(raw, label);
      return {
        sheets: document.sheets,
        grids: document.grids,
        responseBytes: rawMeta.meta.responseBytes,
      };
    },
    sheetKey: (sheet) => sheet.title,
    rowBounds: deps.sheetRowBounds,
    calibration: deps.readCalibration,
    noteSheet: (sheet) => {
      const rowCount = sheet.gridProperties?.rowCount;
      if (rowCount !== undefined) deps.sheetRowBounds.set(sheet.title, rowCount);
    },
    noteResponse: (evidence, cells, responseBytes) => {
      if (responseBytes !== undefined) deps.readCalibration.observe(evidence, cells, responseBytes);
    },
  });
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
  return ensureBandRowBounds({
    hasBound: (title) => deps.sheetRowBounds.has(title),
    enumerate: async () => {
      const enumeration = createRawResponseMeta(deps);
      const sheets = await runRead(deps, (credentialIndex) =>
        enumerateSheetProperties(
          deps.transport, deps.spreadsheetId, deps.readTimeoutMs, enumeration.onRawResponse,
          credentialIndex,
        ), pacing, enumeration.meta);
      return sheets.map((sheet) => ({
        title: sheet.title,
        rowCount: sheet.gridProperties?.rowCount,
      }));
    },
    noteBound: (title, rowCount) => {
      if (rowCount !== undefined) deps.sheetRowBounds.set(title, rowCount);
    },
  }, titles);
}

/**
 * Sends one built batch as ONE paced `batchUpdate` and validates the reply.
 *
 * `BuiltApplyBatch` is the shared return shape of every batch builder
 * (apply, append, and their combined variants), and the batch contents here
 * are exactly what the caller's builder produced: the engine never rebuilds
 * or reorders requests. A malformed or short reply throws the existing
 * delivery-uncertain invalid-state classification, so a 2xx that cannot be
 * matched request-for-request never closes effects. Zero-request batches
 * must be skipped by the caller (no transport call and no telemetry event
 * for an empty batch, exactly like before).
 */
export async function executeBatchUpdate(
  deps: GoogleSheetsApiProviderDeps,
  batch: BuiltApplyBatch,
  telemetry: WriteBatchTelemetry,
): Promise<void> {
  return executeNeutralBatchUpdate(batch, telemetry, {
    send: (requests) => runWrite(deps, (credentialIndex) =>
      deps.transport.batchUpdate({
        spreadsheetId: deps.spreadsheetId,
        requests: [...requests],
        ...credentialBinding(credentialIndex),
      }), {
      requestCount: requests.length,
      bodyBytes: batch.bytes,
      ...telemetry,
    }),
    validateReply: (reply, requestCount) => requireValidBatchUpdateReply(reply, requestCount),
  });
}

/**
 * Runs one prepared write unit behind the receipt-init guard.
 *
 * When the unit needs initialization, refresh + write run as ONE atomic
 * section on the per-spreadsheet `receiptInitLock`; steady state (receipt
 * present at preflight) never takes the lock. Callers keep their own
 * eligibility guard: a deterministic no-op batch must not take the refresh,
 * whose write-lane admission can be refused under saturation and would turn
 * the no-op into a delivery-uncertain requeue.
 */
export async function executePreparedWrite<C, R>(
  deps: GoogleSheetsApiProviderDeps,
  unit: {
    readonly context: C;
    readonly needsReceiptInit: boolean;
    readonly refresh: (context: C) => Promise<C>;
    readonly write: (context: C) => Promise<R>;
  },
): Promise<R> {
  return executeNeutralPreparedWrite(deps.receiptInitLock, unit);
}

/** True when a preflight context observed the shared receipt tab absent. */
export function receiptInitNeeded(context: PreflightContext): boolean {
  return receiptInitNeededNeutral(context.receiptSheetId.kind === PRESENCE_KINDS.PRESENT);
}

/**
 * Buckets items by their canonical route key (neutral kernel grouping:
 * first-seen group order and per-group order are preserved).
 */
export const groupByRouteKey = groupNeutralByRouteKey;

/**
 * Refreshes the shared receipt tab through the FIRST route's context and
 * returns the route list with that context replaced (neutral kernel
 * first-route replacement; the caller supplies the Sheets refresh).
 */
export const refreshFirstRouteContext = refreshNeutralFirstRouteContext;
