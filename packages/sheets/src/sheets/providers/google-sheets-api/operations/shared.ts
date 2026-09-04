/**
 * Shared wiring and pacing helpers for the Google Sheets API provider
 * operations.
 *
 * The provider class hands one immutable `GoogleSheetsApiProviderDeps` object
 * to every operation function so the class stays a thin facade. Pacing
 * (independent request-start limiters: reads serialize only against reads,
 * writes only against writes), redacted telemetry, route validation against
 * the registered definition, and batchUpdate reply validation live here
 * because every operation shares them.
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
} from "@hikoutei/sync-engine/shared/observability/internalLog.js";
import {
  HIKOUTEI_LOG_COMPONENTS,
  HIKOUTEI_LOG_EVENTS,
} from "@hikoutei/sync-engine/shared/observability/logEvents.js";
import type { GoogleSheetsApiRequestEvent } from "../GoogleSheetsApiSyncProvider.js";
import type { GoogleSheetsApiTransport } from "../transport/googleSheetsApiTransport.js";
import { ReceiptReadCursor } from "../model/receiptCursor.js";
import type { ReadCalibration } from "../model/readPlan.js";
import {
  RATE_LIMIT_OPTIONS_ERROR_CODES,
  RateLimitOptionsError,
  RequestStartLimiter,
  ReadQoSScheduler,
} from "../transport/rateLimiter.js";
import {
  isQuotaLimitedOutcome,
  QUOTA_GOVERNOR_LANES,
  QuotaPacingGovernor,
  RollingQuotaBudget,
} from "../transport/quotaGovernor.js";
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
   * Per-provider receipt READ cursor (see `model/receiptCursor.ts`). Steady
   * state apply/fast-append preflights AND postcondition probes read only the
   * receipt tail band this cursor opens; the receipt-refresh path and the
   * probe's whole-table evidence fallback keep the historical full receipt
   * read.
   */
  readonly receiptReadCursor: ReceiptReadCursor;
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
   * Per-provider read-size calibration (see `model/readPlan.ts`): observed
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
   * prepared state, or result handling.
   */
  readonly quotaGovernor: QuotaPacingGovernor;
  /**
   * Maximum admitted wait for ONE request start: a call whose predicted slot
   * is further out is refused before transport. The per-minute budget gate
   * and the lane pacing gate SHARE this one bound via a single admission
   * deadline, so total bounded-admission waiting never exceeds it.
   */
  readonly maxRequestStartWaitMs: number;
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

/** Read-class pacing selectors routed through the shared read QoS scheduler. */
export type ReadPacing = "polling" | "preflight";
/** Any request-start pacing lane (the read classes plus the write lane). */
export type RequestStartPacing = ReadPacing | "write";

/**
 * Acquires one bounded request-start slot, refusing (and logging one
 * redacted event) when the predicted wait exceeds the configured bound.
 * A refusal NEVER advances the limiter/scheduler horizon and throws the
 * stable delivery-uncertain transport error before any SDK call, so the
 * durable worker requeues instead of firing an unpaced burst.
 *
 * Composition order: the per-minute budget gates FIRST (it is the outer
 * quota ceiling), then the lane's interval pacing. A class-pacing refusal
 * AFTER a budget admission leaks that one budget reservation until the
 * window slides — accepted because pacing refusals are already rare and
 * the leak over-counts (never under-counts) the budget, which is the safe
 * direction for quota safety.
 *
 * The two gates share ONE admission budget: a single deadline
 * (`now + maxRequestStartWaitMs`) is computed once and each gate is only
 * allowed to wait its remaining time, so the SUMMED bounded-admission wait
 * across both gates never exceeds `maxRequestStartWaitMs` (the effect-lease
 * headroom contract assumes exactly one bounded wait per request start).
 *
 * Returns the summed budget + pacing wait for the granted slot (0 when both
 * were already available), so callers report the wait actually enforced.
 */
async function admitRequestStart(
  deps: GoogleSheetsApiProviderDeps,
  pacing: RequestStartPacing,
): Promise<number> {
  const lane = pacing === "write"
    ? QUOTA_GOVERNOR_LANES.WRITE
    : QUOTA_GOVERNOR_LANES.READ;
  const budget = pacing === "write" ? deps.writeBudget : deps.readBudget;
  // Validate the bound ONCE before any deadline arithmetic: the limiters
  // validate their own `maxWaitMs` argument, but this helper pre-derives the
  // remaining-time bound, so an invalid configured bound (negative,
  // non-integer, NaN) must fail here with the SAME structured error the
  // limiters would have thrown when the raw bound reached them.
  const maxWaitMs = deps.maxRequestStartWaitMs;
  if (!Number.isSafeInteger(maxWaitMs) || maxWaitMs < 0) {
    throw new RateLimitOptionsError(
      RATE_LIMIT_OPTIONS_ERROR_CODES.MAX_WAIT_NON_NEGATIVE_REQUIRED,
    );
  }
  // One shared admission deadline for BOTH gates: each waitForSlot bound is
  // the time still remaining (never above the validated bound), so the two
  // bounded waits cannot stack past maxRequestStartWaitMs.
  const admissionDeadline = deps.now() + maxWaitMs;
  const budgetAdmission = await budget.waitForSlot(
    remainingAdmissionMs(admissionDeadline, deps.now(), maxWaitMs),
  );
  if (budgetAdmission.status === "refused") {
    return refuseRequestStart(deps, pacing);
  }
  const remainingMs = remainingAdmissionMs(admissionDeadline, deps.now(), maxWaitMs);
  const admission = pacing === "write"
    ? await deps.writeLimiter.waitForSlot(remainingMs)
    : await deps.readScheduler.waitForSlot(pacing, remainingMs);
  if (admission.status === "refused") {
    return refuseRequestStart(deps, pacing);
  }
  // One successful request START counts toward this lane's AIMD quiet
  // period (recovery steps advance only while starts keep succeeding).
  deps.quotaGovernor.recordRequestStart(lane);
  return budgetAdmission.waitedMs + admission.waitedMs;
}

/**
 * Whole-millisecond time still left under the shared admission deadline,
 * clamped into [0, maxWaitMs]: a spent budget (clock past the deadline) makes
 * the next gate refuse any nonzero predicted wait, and a backward-moving
 * clock between the two gates can otherwise re-derive a bound ABOVE the
 * configured maximum. `maxWaitMs` is pre-validated by the caller, so the
 * result is always a non-negative safe integer (waitForSlot's own contract).
 */
function remainingAdmissionMs(deadline: number, now: number, maxWaitMs: number): number {
  return Math.min(maxWaitMs, Math.max(0, Math.floor(deadline - now)));
}

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
  task: () => Promise<T>,
  pacing: RequestStartPacing = "polling",
  meta?: GoogleSheetsApiRequestMeta,
): Promise<T> {
  const pacingWaitMs = await admitRequestStart(deps, pacing);
  const startedAt = deps.now();
  try {
    const result = await task();
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
      ...(responseBytes === undefined ? {} : { responseBytes }),
    });
    return result;
  } catch (error: unknown) {
    const outcome = classifyTransportOutcome(error);
    // AIMD feedback hook: a remote 429/RESOURCE_EXHAUSTED grows THIS lane's
    // pacing interval on the next reservation; any other failure leaves the
    // governor untouched (the durable worker's own retry path is unchanged).
    if (isQuotaLimitedOutcome(outcome)) {
      deps.quotaGovernor.recordQuotaLimited(
        pacing === "write" ? QUOTA_GOVERNOR_LANES.WRITE : QUOTA_GOVERNOR_LANES.READ,
      );
    }
    emitRequest(deps, "getSpreadsheet", pacing, 1, startedAt, false, outcome.httpStatus, outcome.code, { pacingWaitMs });
    throw error;
  }
}

/** Paces ONE `batchUpdate` transport call and emits one write event. */
export async function runWrite<T>(
  deps: GoogleSheetsApiProviderDeps,
  task: () => Promise<T>,
  meta?: GoogleSheetsApiRequestMeta,
): Promise<T> {
  const pacingWaitMs = await admitRequestStart(deps, "write");
  const startedAt = deps.now();
  try {
    const result = await task();
    const responseBytes = deps.onRequest === undefined
      ? undefined
      : estimateJsonBytesOrNull(result);
    emitRequest(deps, "batchUpdate", "write", 1, startedAt, true, absentValue(), absentValue(), {
      pacingWaitMs,
      ...meta,
      ...(responseBytes === undefined ? {} : { responseBytes }),
    });
    return result;
  } catch (error: unknown) {
    const outcome = classifyTransportOutcome(error);
    if (isQuotaLimitedOutcome(outcome)) {
      deps.quotaGovernor.recordQuotaLimited(QUOTA_GOVERNOR_LANES.WRITE);
    }
    emitRequest(deps, "batchUpdate", "write", 1, startedAt, false, outcome.httpStatus, outcome.code, {
      pacingWaitMs,
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
