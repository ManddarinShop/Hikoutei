/**
 * Request-level Google Sheets API telemetry aggregator.
 *
 * Consumes the provider's redacted `GoogleSheetsApiRequestEvent` stream
 * (attached as the `onRequest` provider option at bootstrap scope) and emits
 * two internal log events through the fail-open structured logger:
 *
 * - `hikoutei.sheets.request` (DEBUG, component "sheets"): one line per
 *   transport request — operation, duration, operation count, HTTP status.
 *   DEBUG-only so an INFO deployment logs nothing per request.
 * - `hikoutei.sheets.request_summary` (INFO, component "sheets"): the
 *   accumulated window (requests, rate-limited 429s, other 4xx/5xx, max/avg
 *   duration, write-fill counters, optional per-route adaptive batch limits),
 *   flushed by the effect supervisor at every non-idle pass and cleared
 *   afterwards.
 *
 * Purpose (measurement only): the aggregated 429 count answers whether
 * Google rate limiting ever occurs under real workloads, which decides
 * whether interval-AIMD is needed or deferred. This module changes NO
 * pacing, batching, retry, or controller behavior — a logging problem can
 * never propagate into a request path (fail-open, like the internal log).
 */

import type { GoogleSheetsApiRequestEvent } from "@hikoutei/contracts/sheets/googleSheetsApi.js";
import {
  GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES,
} from "@hikoutei/contracts/sheets/transportError.js";
import { PRESENCE_KINDS } from "@hikoutei/contracts/state/index.js";
import {
  HIKOUTEI_LOG_LEVELS,
  logHikouteiInternalEvent,
} from "../../shared/observability/internalLog.js";
import {
  HIKOUTEI_LOG_COMPONENTS,
  HIKOUTEI_LOG_EVENTS,
} from "../../shared/observability/logEvents.js";

/** One request-telemetry window: sink side plus the summary flush handle. */
export interface RequestTelemetry {
  /**
   * Provider `onRequest` sink. FAIL-OPEN: never throws into the request
   * path, whatever the event shape or the logging sink does.
   */
  readonly sink: (event: GoogleSheetsApiRequestEvent) => void;
  /**
   * Emits one INFO summary of the accumulated window and clears it.
   * An empty window emits nothing (idle passes stay silent).
   *
   * When `batchLimits` (a read-only snapshot of the worker's per-route
   * adaptive batch limits) is supplied, each route's limit is encoded as an
   * indexed numeric count (`routeLimit_0`, `routeLimit_1`, ...) in
   * lexicographic route-key order — route keys themselves are not
   * identifier-safe and `counts` values must stay numeric.
   */
  readonly flushSummary: (batchLimits?: Readonly<Record<string, number>>) => void;
}

/** Mutable accumulation window shared by the sink and the flush. */
interface RequestWindow {
  requests: number;
  failed: number;
  rateLimited: number;
  status4xx: number;
  status5xx: number;
  /** Request-start refusals (limiter admission pressure; no remote call). */
  refused: number;
  /** Failures without an HTTP status and without the refusal code: timeouts, network errors. */
  noStatus: number;
  /** Reads by lane: dispatch read-ahead, inbound polling, deferred-verification (write lane). */
  readsPolling: number;
  readsPreflight: number;
  readsWriteLane: number;
  /** batchUpdate requests that carried fill data (includedEffects present). */
  writes: number;
  sumIncludedEffects: number;
  maxIncludedEffects: number;
  /**
   * getSpreadsheet RESPONSE payload-size evidence (bytes, estimated by the
   * provider from the parsed JSON). The preflight-vs-polling split is the
   * discriminating measurement for the 8x read-latency gap: preflight bytes
   * >> polling bytes means payload-bound reads; similar bytes means a
   * server-side factor (QoS/read-after-write), a different fix.
   */
  readResponseBytesTotal: number;
  readResponseBytesMax: number;
  preflightResponseBytesTotal: number;
  pollingResponseBytesTotal: number;
  maxMs: number;
  sumMs: number;
}

function emptyWindow(): RequestWindow {
  return {
    requests: 0,
    failed: 0,
    rateLimited: 0,
    status4xx: 0,
    status5xx: 0,
    refused: 0,
    noStatus: 0,
    readsPolling: 0,
    readsPreflight: 0,
    readsWriteLane: 0,
    writes: 0,
    sumIncludedEffects: 0,
    maxIncludedEffects: 0,
    readResponseBytesTotal: 0,
    readResponseBytesMax: 0,
    preflightResponseBytesTotal: 0,
    pollingResponseBytesTotal: 0,
    maxMs: 0,
    sumMs: 0,
  };
}

/**
 * Classifies one request event into the window counters.
 *
 * Successful requests consume no failure bucket (the summary reports
 * `failed` = failures; successes are the remainder). Failure sub-buckets:
 * 429 is the decision-relevant rate-limiting signal and is counted ONLY
 * there; request-start REFUSALS (limiter admission, no remote call, no
 * HTTP status) get their own bucket — a rising refused count is a
 * pacing-pressure signal even when Google never sends a 429; other 4xx/5xx
 * get their own buckets; failures with no HTTP status and no refused code
 * (timeouts, network errors) count as `noStatus`.
 */
function absorb(window: RequestWindow, event: GoogleSheetsApiRequestEvent): void {
  window.requests += 1;
  if (event.durationMs > window.maxMs) window.maxMs = event.durationMs;
  window.sumMs += event.durationMs;
  // Lane decomposition: reads split into preflight (dispatch read-ahead),
  // polling (inbound observation), and write-lane reads (deferred
  // postcondition verification). The 판정 run showed reads dominate request
  // time (2.49 reads per write, 78% of request time) without identifying
  // WHAT they are — this is the targeting signal for read reduction.
  if (event.operation === "getSpreadsheet") {
    if (event.pacing === "polling") window.readsPolling += 1;
    else if (event.pacing === "preflight") window.readsPreflight += 1;
    else window.readsWriteLane += 1;
  }
  // Response-size evidence (estimated at the provider). Only getSpreadsheet
  // events feed the read-lane byte totals; a missing/NaN field is skipped so
  // the summary never carries a poisoned total.
  if (event.operation === "getSpreadsheet" &&
      typeof event.responseBytes === "number" &&
      Number.isFinite(event.responseBytes)) {
    window.readResponseBytesTotal += event.responseBytes;
    if (event.responseBytes > window.readResponseBytesMax) {
      window.readResponseBytesMax = event.responseBytes;
    }
    if (event.pacing === "preflight") window.preflightResponseBytesTotal += event.responseBytes;
    else if (event.pacing === "polling") window.pollingResponseBytesTotal += event.responseBytes;
  }
  // Write-fill measurement: the batch's included-effect count is the
  // decision-relevant number (the regular path's adaptive limit starts at
  // 100 while the provider caps a batch at 1,000, so pass-level fill data
  // decides whether raising/accelerating the limit is worthwhile). Only
  // batchUpdate requests carrying a finite includedEffects count feed the
  // fill stats — reads and fill-less events never pollute them.
  if (event.operation === "batchUpdate" &&
      typeof event.includedEffects === "number" &&
      Number.isFinite(event.includedEffects)) {
    window.writes += 1;
    window.sumIncludedEffects += event.includedEffects;
    if (event.includedEffects > window.maxIncludedEffects) {
      window.maxIncludedEffects = event.includedEffects;
    }
  }
  if (event.ok) return;
  window.failed += 1;
  const status = event.httpStatus.kind === PRESENCE_KINDS.PRESENT
    ? event.httpStatus.value
    : undefined;
  const code = event.code.kind === PRESENCE_KINDS.PRESENT ? event.code.value : undefined;
  if (code === GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.REQUEST_START_REFUSED) {
    window.refused += 1;
  } else if (status === 429) {
    window.rateLimited += 1;
  } else if (status !== undefined && status >= 400 && status < 500) {
    window.status4xx += 1;
  } else if (status !== undefined && status >= 500) {
    window.status5xx += 1;
  } else {
    // Failed without a status and without the refusal code: timeout or
    // network-level failure. Never conflated with the rate-limit signal.
    window.noStatus += 1;
  }
}

/**
 * Creates the bootstrap-scoped request telemetry.
 *
 * The aggregator instance is shared by the remote provider (which feeds the
 * sink) and the effect supervisor (which flushes the window at each
 * non-idle pass), so the summary covers exactly the requests of one worker
 * pass window.
 */
export function createRequestTelemetry(): RequestTelemetry {
  let window = emptyWindow();
  return {
    sink(event: GoogleSheetsApiRequestEvent): void {
      try {
        const status = event.httpStatus.kind === PRESENCE_KINDS.PRESENT
          ? event.httpStatus.value
          : undefined;
        // Per-request visibility is DEBUG-only; the accumulation below runs
        // at every level so the INFO summary stays complete.
        logHikouteiInternalEvent({
          event: HIKOUTEI_LOG_EVENTS.SHEETS_REQUEST,
          level: HIKOUTEI_LOG_LEVELS.DEBUG,
          component: HIKOUTEI_LOG_COMPONENTS.SHEETS,
          providerOperation: event.operation,
          // Pacing lane on the line itself so per-lane duration sums can be
          // joined from the DEBUG stream (the INFO summary only counts).
          pacing: event.pacing,
          durationMs: event.durationMs,
          counts: {
            operationCount: event.operationCount,
            // 0 = no HTTP status (timeout/network/refused start).
            httpStatus: status ?? 0,
            // Write-fill context is present only on fill-carrying provider
            // events; omitted (never NaN) when the optional fields are absent.
            ...(event.requestedEffects === undefined
              ? {} : { requestedEffects: event.requestedEffects }),
            ...(event.includedEffects === undefined
              ? {} : { includedEffects: event.includedEffects }),
            ...(event.bodyBytes === undefined
              ? {} : { bodyBytes: event.bodyBytes }),
            ...(event.responseBytes === undefined
              ? {} : { responseBytes: event.responseBytes }),
          },
        });
        absorb(window, event);
      } catch {
        // Fail-open: telemetry can never change a request outcome.
      }
    },
    flushSummary(batchLimits?: Readonly<Record<string, number>>): void {
      try {
        if (window.requests === 0) return;
        const counts: Record<string, number> = {
          requests: window.requests,
          failed: window.failed,
          rateLimited: window.rateLimited,
          status4xx: window.status4xx,
          status5xx: window.status5xx,
          refused: window.refused,
          noStatus: window.noStatus,
          readsPolling: window.readsPolling,
          readsPreflight: window.readsPreflight,
          readsWriteLane: window.readsWriteLane,
          writes: window.writes,
          avgIncludedEffects: window.writes === 0
            ? 0
            : Math.round(window.sumIncludedEffects / window.writes),
          maxIncludedEffects: window.maxIncludedEffects,
          readResponseBytesTotal: window.readResponseBytesTotal,
          readResponseBytesMax: window.readResponseBytesMax,
          preflightResponseBytesTotal: window.preflightResponseBytesTotal,
          pollingResponseBytesTotal: window.pollingResponseBytesTotal,
          maxRequestMs: window.maxMs,
          avgRequestMs: Math.round(window.sumMs / window.requests),
        };
        // Adaptive route limits ride the same per-pass summary as indexed
        // counts (see the interface doc for the sorted-key encoding): the
        // growth curve of the regular-path limit (initial 100, +5 per 3
        // stable successes, cap 300) is otherwise invisible, and pass-level
        // includedEffects alone cannot distinguish "limit never grew" from
        // "limit grew but the backlog stayed small".
        if (batchLimits !== undefined) {
          for (const [index, routeKey] of Object.keys(batchLimits).sort().entries()) {
            const limit = batchLimits[routeKey];
            if (limit !== undefined) counts[`routeLimit_${index}`] = limit;
          }
        }
        logHikouteiInternalEvent({
          event: HIKOUTEI_LOG_EVENTS.SHEETS_REQUEST_SUMMARY,
          level: HIKOUTEI_LOG_LEVELS.INFO,
          component: HIKOUTEI_LOG_COMPONENTS.SHEETS,
          counts,
        });
        window = emptyWindow();
      } catch {
        // Fail-open: a summary failure must never reach the worker pass.
        window = emptyWindow();
      }
    },
  };
}