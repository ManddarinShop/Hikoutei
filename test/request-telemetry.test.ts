/**
 * Request-level Google Sheets telemetry tests.
 *
 * Covers the bootstrap-scoped aggregator (`createRequestTelemetry`): the
 * status-bucket counters (429 / other 4xx / 5xx / success), the avg/max
 * math, the per-pass window flush semantics, fail-open behavior, the DEBUG
 * gating of the per-request event, and an end-to-end stub-transport run
 * where ONE HTTP 429 occurs and the summary must record rateLimited=1 with
 * the durable retry behavior UNCHANGED (the requeued effect is still
 * applied by a later pass).
 *
 * Pure measurement: nothing here asserts or changes pacing, batching, or
 * retry policy.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createInternalSyncService,
  type InternalSyncService,
} from "@hikoutei/sync-engine/sync/service/SyncServiceBootstrap.js";
import {
  createRequestTelemetry,
} from "@hikoutei/sync-engine/sync/service/requestTelemetry.js";
import {
  getHikouteiInternalLogger,
  HIKOUTEI_LOG_ENV_KEYS,
  HIKOUTEI_LOG_LEVELS,
  resetHikouteiInternalLoggerForTests,
} from "@hikoutei/sync-engine/shared/observability/internalLog.js";
import {
  HIKOUTEI_LOG_COMPONENTS,
  HIKOUTEI_LOG_EVENTS,
  HIKOUTEI_LOG_TRANSPORT_OPERATIONS,
} from "@hikoutei/sync-engine/shared/observability/logEvents.js";
import {
  presentValue,
  absentValue,
} from "@hikoutei/contracts/state/index.js";
import {
  GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES,
} from "@hikoutei/contracts/sheets/transportError.js";
import { defineTypedSheetsEntity } from "../src/index.js";
import {
  StubSheet,
  StubSpreadsheet,
  StubSheetsTransport,
  stubRowFields,
} from "./support/StubSheetsTransport.js";
import {
  GOOGLE_SHEETS_API_LIGHTWEIGHT_OBSERVATION_FIELDS,
  GOOGLE_SHEETS_API_OBSERVATION_FIELDS,
} from "@hikoutei/sheets/sheets/providers/google-sheets-api/model/preflightFields.js";

import type { GoogleSheetsApiRequestEvent } from "@hikoutei/contracts/sheets/googleSheetsApi.js";

/** One redacted request event with defaults for the aggregator tests. */
function requestEvent(
  overrides: Partial<GoogleSheetsApiRequestEvent> = {},
): GoogleSheetsApiRequestEvent {
  return {
    operation: "batchUpdate",
    pacing: "write",
    operationCount: 1,
    startedAt: 1_000,
    durationMs: 10,
    ok: true,
    httpStatus: absentValue(),
    code: absentValue(),
    ...overrides,
  };
}

/** Reads every JSONL line of the injected test log file. */
async function readLogLines(filePath: string): Promise<Record<string, unknown>[]> {
  const raw = await readFile(filePath, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function logEvents(lines: Record<string, unknown>[], event: string): Record<string, unknown>[] {
  return lines.filter((line) => line.event === event);
}

describe("sheets request telemetry aggregator", () => {
  const savedEnv = { ...process.env };
  let tempRoot: string;
  let logFile: string;

  const injectLogger = async (level?: string): Promise<void> => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "hikoutei-req-telemetry-"));
    logFile = path.join(tempRoot, "telemetry-log.txt");
    process.env[HIKOUTEI_LOG_ENV_KEYS.LOG_FILE] = logFile;
    if (level === undefined) delete process.env[HIKOUTEI_LOG_ENV_KEYS.LOG_LEVEL];
    else process.env[HIKOUTEI_LOG_ENV_KEYS.LOG_LEVEL] = level;
    resetHikouteiInternalLoggerForTests();
  };

  beforeEach(() => {
    resetHikouteiInternalLoggerForTests();
  });

  afterEach(async () => {
    resetHikouteiInternalLoggerForTests();
    for (const name of Object.values(HIKOUTEI_LOG_ENV_KEYS)) {
      const original = savedEnv[name];
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    }
    if (tempRoot !== undefined) await rm(tempRoot, { recursive: true, force: true });
  });

  it("classifies 429, other 4xx, 5xx, refusals, no-status failures, and successes", async () => {
    await injectLogger();
    const telemetry = createRequestTelemetry();
    telemetry.sink(requestEvent({ httpStatus: presentValue(429), ok: false }));
    telemetry.sink(requestEvent({ httpStatus: presentValue(400), ok: false }));
    telemetry.sink(requestEvent({ httpStatus: presentValue(499), ok: false }));
    telemetry.sink(requestEvent({ httpStatus: presentValue(500), ok: false }));
    telemetry.sink(requestEvent({ httpStatus: presentValue(503), ok: false }));
    telemetry.sink(requestEvent({
      ok: false,
      httpStatus: absentValue(),
      code: presentValue(GOOGLE_SHEETS_API_TRANSPORT_ERROR_CODES.REQUEST_START_REFUSED),
    }));
    telemetry.sink(requestEvent({ ok: false, httpStatus: absentValue() }));
    telemetry.sink(requestEvent({ ok: true, httpStatus: absentValue() }));
    telemetry.sink(requestEvent({ httpStatus: presentValue(200), ok: true }));
    // Lane decomposition exercises the read lanes (getSpreadsheet only).
    telemetry.sink(requestEvent({ operation: "getSpreadsheet", pacing: "polling", ok: true }));
    telemetry.sink(requestEvent({ operation: "getSpreadsheet", pacing: "preflight", ok: true }));
    telemetry.flushSummary();

    await getHikouteiInternalLogger().drain();
    const lines = await readLogLines(logFile);
    const summaries = logEvents(lines, HIKOUTEI_LOG_EVENTS.SHEETS_REQUEST_SUMMARY);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.counts).toEqual({
      requests: 11,
      failed: 7,
      rateLimited: 1,
      status4xx: 2,
      status5xx: 2,
      refused: 1,
      noStatus: 1,
      readsPolling: 1,
      readsPreflight: 1,
      readsWriteLane: 0,
      writes: 0,
      avgIncludedEffects: 0,
      maxIncludedEffects: 0,
      readResponseBytesTotal: 0,
      readResponseBytesMax: 0,
      preflightResponseBytesTotal: 0,
      pollingResponseBytesTotal: 0,
      maxRequestMs: 10,
      avgRequestMs: 10,
    });
    expect(summaries[0]?.level).toBe(HIKOUTEI_LOG_LEVELS.INFO);
    expect(summaries[0]?.component).toBe(HIKOUTEI_LOG_COMPONENTS.SHEETS);
  });

  it("computes max and rounded-average request durations", async () => {
    await injectLogger();
    const telemetry = createRequestTelemetry();
    telemetry.sink(requestEvent({ durationMs: 100 }));
    telemetry.sink(requestEvent({ durationMs: 201 }));
    telemetry.sink(requestEvent({ durationMs: 303 }));
    telemetry.flushSummary();

    await getHikouteiInternalLogger().drain();
    const lines = await readLogLines(logFile);
    const summaries = logEvents(lines, HIKOUTEI_LOG_EVENTS.SHEETS_REQUEST_SUMMARY);
    expect(summaries[0]?.counts).toMatchObject({ maxRequestMs: 303, avgRequestMs: 201 });
  });

  it("aggregates write-fill metrics from fill-carrying batchUpdate events", async () => {
    await injectLogger(HIKOUTEI_LOG_LEVELS.DEBUG);
    const telemetry = createRequestTelemetry();
    telemetry.sink(requestEvent({
      includedEffects: 100, requestedEffects: 120, bodyBytes: 50_000,
    }));
    telemetry.sink(requestEvent({
      includedEffects: 1000, requestedEffects: 1000, bodyBytes: 500_000,
    }));
    // A read event carrying fill fields (hostile/defensive shape) must NOT
    // pollute the write-fill metrics.
    telemetry.sink(requestEvent({ operation: "getSpreadsheet", includedEffects: 999 }));
    telemetry.flushSummary();

    await getHikouteiInternalLogger().drain();
    const lines = await readLogLines(logFile);
    const summaries = logEvents(lines, HIKOUTEI_LOG_EVENTS.SHEETS_REQUEST_SUMMARY);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.counts).toMatchObject({
      requests: 3,
      writes: 2,
      avgIncludedEffects: 550,
      maxIncludedEffects: 1000,
    });
    // The DEBUG per-request line carries the fill fields when present.
    const writeLines = logEvents(lines, HIKOUTEI_LOG_EVENTS.SHEETS_REQUEST)
      .filter((line) => line.providerOperation === "batchUpdate");
    expect(writeLines).toHaveLength(2);
    expect(writeLines[0]?.counts).toEqual({
      operationCount: 1, httpStatus: 0, includedEffects: 100, requestedEffects: 120, bodyBytes: 50_000,
    });
    expect(writeLines[1]?.counts).toEqual({
      operationCount: 1, httpStatus: 0, includedEffects: 1000, requestedEffects: 1000, bodyBytes: 500_000,
    });
    // The DEBUG line echoes whatever fields the event carried (presence-
    // checked); the pollution guard lives in the aggregation above.
    const readLine = logEvents(lines, HIKOUTEI_LOG_EVENTS.SHEETS_REQUEST)
      .find((line) => line.providerOperation === "getSpreadsheet");
    expect(readLine?.counts).toEqual({ operationCount: 1, httpStatus: 0, includedEffects: 999 });
  });

  it("omits absent fill fields from DEBUG counts and reports zero write fill", async () => {
    await injectLogger(HIKOUTEI_LOG_LEVELS.DEBUG);
    const telemetry = createRequestTelemetry();
    // batchUpdate WITHOUT any optional fill fields: counted as a request,
    // never as a write-fill sample (no NaN in avg/max).
    telemetry.sink(requestEvent());
    telemetry.flushSummary();

    await getHikouteiInternalLogger().drain();
    const lines = await readLogLines(logFile);
    const summaries = logEvents(lines, HIKOUTEI_LOG_EVENTS.SHEETS_REQUEST_SUMMARY);
    expect(summaries[0]?.counts).toMatchObject({
      requests: 1, writes: 0, avgIncludedEffects: 0, maxIncludedEffects: 0,
    });
    const perRequest = logEvents(lines, HIKOUTEI_LOG_EVENTS.SHEETS_REQUEST);
    expect(perRequest[0]?.counts).toEqual({ operationCount: 1, httpStatus: 0 });
  });

  it("aggregates per-lane read response bytes and ignores non-read bytes", async () => {
    await injectLogger(HIKOUTEI_LOG_LEVELS.DEBUG);
    const telemetry = createRequestTelemetry();
    telemetry.sink(requestEvent({
      operation: "getSpreadsheet", pacing: "preflight", responseBytes: 400_000,
    }));
    telemetry.sink(requestEvent({
      operation: "getSpreadsheet", pacing: "preflight", responseBytes: 100_000,
    }));
    telemetry.sink(requestEvent({
      operation: "getSpreadsheet", pacing: "polling", responseBytes: 20_000,
    }));
    // Write-lane read bytes count toward the read total but never toward
    // the two discriminating lane totals.
    telemetry.sink(requestEvent({
      operation: "getSpreadsheet", pacing: "write", responseBytes: 5_000,
    }));
    // A batchUpdate carrying responseBytes must NOT pollute read-byte stats.
    telemetry.sink(requestEvent({ operation: "batchUpdate", responseBytes: 999 }));
    // Missing responseBytes: contributes 0, never NaN.
    telemetry.sink(requestEvent({ operation: "getSpreadsheet", pacing: "polling" }));
    telemetry.flushSummary();

    await getHikouteiInternalLogger().drain();
    const lines = await readLogLines(logFile);
    const summaries = logEvents(lines, HIKOUTEI_LOG_EVENTS.SHEETS_REQUEST_SUMMARY);
    expect(summaries[0]?.counts).toMatchObject({
      readsPreflight: 2,
      readsPolling: 2,
      readsWriteLane: 1,
      readResponseBytesTotal: 525_000,
      readResponseBytesMax: 400_000,
      preflightResponseBytesTotal: 500_000,
      pollingResponseBytesTotal: 20_000,
    });
    // The DEBUG per-request line carries responseBytes only when present.
    const readLines = logEvents(lines, HIKOUTEI_LOG_EVENTS.SHEETS_REQUEST);
    const preflightLine = readLines.find(
      (line) => (line.counts as Record<string, number>)?.responseBytes === 400_000,
    );
    expect(preflightLine).toBeDefined();
    const noBytesLine = readLines.find((line) =>
      line.providerOperation === "getSpreadsheet" &&
      (line.counts as Record<string, unknown>).responseBytes === undefined);
    expect(noBytesLine).toBeDefined();
  });

  it("encodes supplied adaptive route limits as sorted indexed counts", async () => {
    await injectLogger();
    const telemetry = createRequestTelemetry();
    telemetry.sink(requestEvent());
    // Route keys are arbitrary strings; the summary must expose them as
    // numeric-only indexed counts in lexicographic key order.
    telemetry.flushSummary({ "users:system": 300, "invoices:system": 105 });

    await getHikouteiInternalLogger().drain();
    const lines = await readLogLines(logFile);
    const summaries = logEvents(lines, HIKOUTEI_LOG_EVENTS.SHEETS_REQUEST_SUMMARY);
    expect(summaries[0]?.counts).toMatchObject({
      routeLimit_0: 105, // invoices:system sorts first
      routeLimit_1: 300,
    });
  });

  it("clears the window on flush and emits nothing for an empty window", async () => {
    await injectLogger();
    const telemetry = createRequestTelemetry();
    // Empty window: no summary line at all.
    telemetry.flushSummary();
    telemetry.sink(requestEvent({ durationMs: 5, operation: "getSpreadsheet" }));
    telemetry.flushSummary();
    // Window cleared: the second flush is silent again.
    telemetry.flushSummary();

    await getHikouteiInternalLogger().drain();
    const lines = await readLogLines(logFile);
    const summaries = logEvents(lines, HIKOUTEI_LOG_EVENTS.SHEETS_REQUEST_SUMMARY);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.counts).toMatchObject({ requests: 1 });
  });

  it("is fail-open: a malformed event and a broken sink never throw", async () => {
    await injectLogger();
    const telemetry = createRequestTelemetry();
    // An event whose field access throws (hostile shape) must not propagate.
    const hostile = { get httpStatus(): never { throw new Error("boom"); } };
    expect(() =>
      telemetry.sink(hostile as unknown as GoogleSheetsApiRequestEvent),
    ).not.toThrow();
    expect(() => telemetry.flushSummary()).not.toThrow();
    // A throwing logger injection (env pointing at a directory) also never
    // reaches the caller: logHikouteiInternalEvent is fail-open and the
    // aggregator wraps everything anyway.
    process.env[HIKOUTEI_LOG_ENV_KEYS.LOG_FILE] = tempRoot;
    resetHikouteiInternalLoggerForTests();
    expect(() => telemetry.sink(requestEvent())).not.toThrow();
    expect(() => telemetry.flushSummary()).not.toThrow();
  });

  it("emits per-request events only at DEBUG level, with correct fields", async () => {
    // Default (INFO) level: per-request lines are filtered, summary remains.
    await injectLogger(undefined);
    const telemetry = createRequestTelemetry();
    telemetry.sink(requestEvent({
      operation: "getSpreadsheet",
      httpStatus: presentValue(429),
      durationMs: 42,
    }));
    telemetry.flushSummary();
    await getHikouteiInternalLogger().drain();
    const infoLines = await readLogLines(logFile);
    expect(logEvents(infoLines, HIKOUTEI_LOG_EVENTS.SHEETS_REQUEST)).toHaveLength(0);
    expect(logEvents(infoLines, HIKOUTEI_LOG_EVENTS.SHEETS_REQUEST_SUMMARY)).toHaveLength(1);

    // DEBUG level: the per-request line appears with the redacted fields.
    await injectLogger(HIKOUTEI_LOG_LEVELS.DEBUG);
    const debugTelemetry = createRequestTelemetry();
    debugTelemetry.sink(requestEvent({
      operation: "getSpreadsheet",
      pacing: "preflight",
      httpStatus: presentValue(429),
      durationMs: 42,
      operationCount: 3,
    }));
    debugTelemetry.flushSummary();
    await getHikouteiInternalLogger().drain();
    const debugLines = await readLogLines(logFile);
    const perRequest = logEvents(debugLines, HIKOUTEI_LOG_EVENTS.SHEETS_REQUEST);
    expect(perRequest).toHaveLength(1);
    expect(perRequest[0]).toMatchObject({
      level: HIKOUTEI_LOG_LEVELS.DEBUG,
      component: HIKOUTEI_LOG_COMPONENTS.SHEETS,
      providerOperation: "getSpreadsheet",
      // The lane rides the line itself so per-lane duration sums join.
      pacing: "preflight",
      durationMs: 42,
    });
    expect(perRequest[0]?.counts).toEqual({ operationCount: 3, httpStatus: 429 });
  });

  it("keeps the transport-operation allowlist at the exact provider operations", () => {
    // The providerOperation field of the request events must pass the log's
    // redaction allowlist unchanged.
    expect([...HIKOUTEI_LOG_TRANSPORT_OPERATIONS]).toEqual(["getSpreadsheet", "batchUpdate"]);
  });
});

describe("sheets request telemetry wiring (stub transport, one HTTP 429)", () => {
  const TelemetryUser = defineTypedSheetsEntity({
    name: "TelemetryUser",
    tableName: "telemetry_users",
    properties: {
      id: { type: "string", primary: true },
      status: { type: "string" },
    },
  });

  const projections = {
    spreadsheetId: "telemetry-spreadsheet",
    entities: {
      TelemetryUser: {
        systemState: { tabName: "TelemetryUsers_System", registeredRange: "A:C" },
        syncConflicts: { tabName: "TelemetryUsers_Conflicts", registeredRange: "A:O" },
        userInput: { tabName: "TelemetryUsers_Input", registeredRange: "A:C" },
        userOwnedFields: ["id", "status"],
      },
    },
  };

  const savedEnv = { ...process.env };
  const services: InternalSyncService[] = [];
  let tempRoot: string;
  let logFile: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "hikoutei-req-telemetry-e2e-"));
    logFile = path.join(tempRoot, "telemetry-e2e-log.txt");
    process.env[HIKOUTEI_LOG_ENV_KEYS.LOG_FILE] = logFile;
    process.env[HIKOUTEI_LOG_ENV_KEYS.LOG_LEVEL] = HIKOUTEI_LOG_LEVELS.DEBUG;
    resetHikouteiInternalLoggerForTests();
  });

  afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.close()));
    resetHikouteiInternalLoggerForTests();
    for (const name of Object.values(HIKOUTEI_LOG_ENV_KEYS)) {
      const original = savedEnv[name];
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("records the 429 in the summary while the requeued effect still applies", async () => {
    const spreadsheet = new StubSpreadsheet();
    const transport = new StubSheetsTransport(spreadsheet);
    const service = await createInternalSyncService({
      dbName: ":memory:",
      entities: [TelemetryUser],
      projections,
      googleSheetsApi: {
        transport,
        // Zero pacing: this wall-clock test must never wait on or be
        // refused by the request-start limiter.
        rateLimitIntervalMs: 0,
      },
      pollingIntervalMs: 3_600_000,
      effectIdleIntervalMs: 3_600_000,
    });
    services.push(service);

    const em = service.hikoutei.em.fork();
    em.persist(em.create(TelemetryUser, { id: "tel-1", status: "pending" }));
    await em.flush();

    // ONE HTTP 429 on the next transport call (the first preflight read of
    // the effect dispatch). The stub fault is one-shot, so the retry that
    // follows runs against the unchanged, healthy stub.
    transport.fault = { kind: "http", status: 429, apiErrorStatus: "RESOURCE_EXHAUSTED" };

    // Retry behavior UNCHANGED vs baseline: the first pass hits the 429 and
    // requeues the effect durably (delivery-uncertain); a later pass applies
    // it exactly as it would without the telemetry wiring.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await service.effectSupervisor.runOnce();
      const applied = stubRowFields(
        spreadsheet.findTab("TelemetryUsers_Input") as never,
        2,
        ["id", "status"],
      ).id;
      if (applied !== null) break;
    }
    expect(stubRowFields(spreadsheet.findTab("TelemetryUsers_Input") as never, 2, ["id", "status"]).id)
      .toEqual({ kind: "string", value: "tel-1" });
    // The 429'd effect was requeued, NOT terminally failed: the row landed.
    const systemTab = spreadsheet.findTab("TelemetryUsers_System");
    expect(stubRowFields(systemTab as never, 2, ["id", "status", "__typed_sheets_deleted"]).id)
      .toEqual({ kind: "string", value: "tel-1" });

    await getHikouteiInternalLogger().drain();
    const lines = await readLogLines(logFile);

    // The per-request DEBUG line carries the 429 with the transport
    // operation name intact (allowlisted, not redacted).
    const requestLines = logEvents(lines, HIKOUTEI_LOG_EVENTS.SHEETS_REQUEST);
    const rateLimitedRequest = requestLines.find(
      (line) => (line.counts as Record<string, number>)?.httpStatus === 429,
    );
    expect(rateLimitedRequest).toBeDefined();
    expect(rateLimitedRequest?.providerOperation).toBe("getSpreadsheet");
    expect(rateLimitedRequest?.component).toBe(HIKOUTEI_LOG_COMPONENTS.SHEETS);

    // The window summaries record EXACTLY ONE 429 in total (the retry runs
    // inside the same worker pass window, so the failing pass's summary
    // carries it; any further pass summaries carry rateLimited=0).
    const summaries = logEvents(lines, HIKOUTEI_LOG_EVENTS.SHEETS_REQUEST_SUMMARY);
    expect(summaries.length).toBeGreaterThanOrEqual(1);
    const totalRateLimited = summaries.reduce(
      (sum, line) => sum + ((line.counts as Record<string, number>)?.rateLimited ?? 0),
      0,
    );
    expect(totalRateLimited).toBe(1);
    const withRateLimit = summaries.filter(
      (line) => (line.counts as Record<string, number>)?.rateLimited === 1,
    );
    expect(withRateLimit).toHaveLength(1);
    // The window that saw the 429 also saw the successful retry request.
    expect((withRateLimit[0]?.counts as Record<string, number>)?.requests).toBeGreaterThanOrEqual(2);
    // Adaptive route limits thread through to the per-pass summary as
    // indexed counts (measurement-only observability of the controller).
    const withRouteLimit = summaries.find(
      (line) => Number.isFinite((line.counts as Record<string, number>)?.routeLimit_0),
    );
    expect(withRouteLimit).toBeDefined();
    expect((withRouteLimit?.counts as Record<string, number>).routeLimit_0)
      .toBeGreaterThanOrEqual(5);
  });

  /**
   * Burst-scale structural guard (telemetry e2e): N entities flushed in ONE
   * transaction, drained through the durable worker, with the receipt-cursor /
   * column-scoping read shape proven bounded at scale. Asserts, from the
   * per-pass `request_summary` events plus a transport-boundary byte census:
   * (a) every effect applied exactly once (system/input/receipt row counts
   * exact), (b) every BASE-mask dispatch read stays under the 2 MB guardrail
   * and every pass summary records `readResponseBytesMax` under it too (the
   * receipt band + identity band held at burst scale), (c) the read lanes are
   * actually populated, (d) zero 429s / refusals without injected faults.
   * effects/s and the byte census are RECORDED (console) — no wall-clock
   * assert, no pacing/batch/retry policy is observed or changed.
   */
  it("drains a 500-effect burst with bounded base reads, recorded lanes, and zero quota pressure", async () => {
    const BURST_SIZE = 500;
    // Guardrail, not a measurement target: the pre-banding whole-tab receipt
    // read (`A1:F1048576` with format-evidence masks) sat in the multi-MB
    // range at demo scale; every dispatch data read must stay far below this.
    const MAX_BASE_READ_BYTES = 2 * 1024 * 1024;
    const spreadsheet = new StubSpreadsheet();
    const transport = new StubSheetsTransport(spreadsheet);
    // Raw-size census of EVERY ranged dispatch read at the transport
    // boundary — ground truth independent of the parsed-object estimate the
    // event sink carries for the non-polling lanes.
    const dispatchReadBytes: number[] = [];
    let fullReceiptReads = 0;
    let bandedReceiptReads = 0;
    const origGet = transport.getSpreadsheet.bind(transport);
    transport.getSpreadsheet = async (request: Parameters<typeof origGet>[0]) => {
      const raw = await origGet(request);
      if (request.ranges.length > 0) {
        dispatchReadBytes.push(JSON.stringify(raw).length);
        for (const range of request.ranges) {
          if (!range.includes("__typed_sheets_internal_effect_receipts")) continue;
          if (range.includes("!A1:F")) fullReceiptReads += 1;
          else bandedReceiptReads += 1;
        }
      }
      return raw;
    };
    const service = await createInternalSyncService({
      dbName: ":memory:",
      entities: [TelemetryUser],
      projections,
      googleSheetsApi: { transport, rateLimitIntervalMs: 0 },
      pollingIntervalMs: 3_600_000,
      effectIdleIntervalMs: 3_600_000,
    });
    services.push(service);

    const em = service.hikoutei.em.fork();
    for (let index = 0; index < BURST_SIZE; index += 1) {
      em.persist(em.create(TelemetryUser, {
        id: `burst-${String(index).padStart(4, "0")}`,
        status: "pending",
      }));
    }
    const startedAt = Date.now();
    await em.flush();
    // DRAIN: the adaptive batch route starts at 100 effects/dispatch, so a
    // 500-effect burst needs a handful of passes; poll the durable outbox.
    let passes = 0;
    for (; passes < 30; passes += 1) {
      await service.effectSupervisor.runOnce();
      const pending = await service.storage.read(({ sql }) =>
        sql.get<{ readonly count: number }>(
          "SELECT COUNT(*) AS count FROM sheet_effect_outbox WHERE status = 'pending'",
        ));
      if ((pending?.count ?? 0) === 0) break;
    }
    const elapsedMs = Math.max(1, Date.now() - startedAt);

    // (a) ALL applied exactly once: header row 1 + BURST_SIZE data rows
    // (0-based last index BURST_SIZE) in each projection, one receipt per
    // effect, and the row after the last stays blank.
    expect(passes, "burst outbox did not drain").toBeLessThan(30);
    const systemTab = spreadsheet.findTab("TelemetryUsers_System");
    const inputTab = spreadsheet.findTab("TelemetryUsers_Input");
    const receiptTab = spreadsheet.findTab("__typed_sheets_internal_effect_receipts");
    expect(systemTab?.lastContentRow()).toBe(BURST_SIZE);
    expect(inputTab?.lastContentRow()).toBe(BURST_SIZE);
    // One receipt per OUTBOX effect: each entity flush writes a system-state
    // and a user-input route effect → 2 receipts per entity. Receipt ids are
    // unique (applied exactly once, no duplicate receipt rows).
    if (receiptTab === undefined) throw new Error("burst receipt tab missing");
    const receiptIds = new Set<string>();
    for (const [key, cell] of receiptTab.cells) {
      const [row, col] = key.split(",").map(Number) as [number, number];
      if (col !== 0 || row === 0) continue;
      const value = cell.userEnteredValue?.stringValue;
      if (value !== undefined) receiptIds.add(value);
    }
    expect(receiptIds.size).toBe(BURST_SIZE * 2);
    // Exactly-once by CONTENT: the id column carries each burst identity
    // exactly once (dispatch order across routes is not creation order).
    const idColumn = (tab: StubSheet): Set<string> => {
      const ids = new Set<string>();
      for (const [key, cell] of tab.cells) {
        const [row, col] = key.split(",").map(Number) as [number, number];
        if (col !== 0 || row === 0) continue;
        const value = cell.userEnteredValue?.stringValue;
        if (value !== undefined) ids.add(value);
      }
      return ids;
    };
    const expectedIds = new Set(
      Array.from({ length: BURST_SIZE }, (_, index) => `burst-${String(index).padStart(4, "0")}`),
    );
    if (systemTab === undefined || inputTab === undefined) throw new Error("burst tabs missing");
    expect(idColumn(systemTab)).toEqual(expectedIds);
    expect(idColumn(inputTab)).toEqual(expectedIds);

    // (b) the read shape held at burst scale: every dispatch read under the
    // guardrail, and the historical whole-tab receipt range appears at most
    // once (the cold read) while the steady-state dispatches band.
    expect(dispatchReadBytes.length).toBeGreaterThan(0);
    for (const bytes of dispatchReadBytes) {
      expect(bytes).toBeLessThanOrEqual(MAX_BASE_READ_BYTES);
    }
    // At most ONE cold full read per cold read-lane (the scoped fastAppend
    // base read and the applyEffects full-evidence read each settle their
    // cursor once); every later dispatch receipt read rides the tail band.
    expect(fullReceiptReads).toBeLessThanOrEqual(2);
    expect(bandedReceiptReads).toBeGreaterThanOrEqual(1);

    await getHikouteiInternalLogger().drain();
    const lines = await readLogLines(logFile);
    const summaries = logEvents(lines, HIKOUTEI_LOG_EVENTS.SHEETS_REQUEST_SUMMARY);
    expect(summaries.length).toBeGreaterThanOrEqual(1);
    for (const summary of summaries) {
      expect((summary.counts as Record<string, number>).readResponseBytesMax ?? 0)
        .toBeLessThanOrEqual(MAX_BASE_READ_BYTES);
    }

    // (c) read lanes recorded across the burst passes. EACH lane is
    // asserted positively on its own — an aggregate `sum > 0` would still
    // pass if two of the three lanes silently stopped being recorded.
    // Measured here: every dispatch run-read-ahead feeds the preflight
    // lane, the supervisor's polling-paced table reads feed the polling
    // lane, and the inline post-condition verify read of a non-deletion
    // write feeds the write lane, so all three are populated by
    // construction in this scenario.
    const laneTotal = (field: string) => summaries.reduce(
      (sum, line) => sum + ((line.counts as Record<string, number>)?.[field] ?? 0),
      0,
    );
    const readsPreflight = laneTotal("readsPreflight");
    const readsPolling = laneTotal("readsPolling");
    const readsWriteLane = laneTotal("readsWriteLane");
    expect(readsPreflight, "preflight read lane silently unrecorded").toBeGreaterThanOrEqual(1);
    expect(readsPolling, "polling read lane silently unrecorded").toBeGreaterThanOrEqual(1);
    expect(readsWriteLane, "write-lane read silently unrecorded").toBeGreaterThanOrEqual(1);

    // (d) no quota pressure without injected faults.
    expect(laneTotal("rateLimited")).toBe(0);
    expect(laneTotal("refused")).toBe(0);

    // RECORD ONLY: steady-state effects/s over the flush+drain span (this
    // includes the one-time provisioning window, so it is a conservative
    // lower bound), the max single BASE read, and the lane breakdown.
    const effectsPerSecond = Math.round((BURST_SIZE / elapsedMs) * 1000);
    console.info(
      `[burst-e2e] effects=${BURST_SIZE} passes=${passes + 1} elapsedMs=${elapsedMs} ` +
      `effects/s~${effectsPerSecond} dispatchReadBytesMax=${Math.max(...dispatchReadBytes)} ` +
      `dispatchReads=${dispatchReadBytes.length} receiptReads(full=${fullReceiptReads},banded=${bandedReceiptReads}) ` +
      `lanes(preflight=${readsPreflight},` +
      `polling=${readsPolling},write=${readsWriteLane}) 429/refused=0`,
    );
  }, 60_000);
});
/**
 * Bootstrap gating regression (review finding, High/performance): logging is
 * opt-in, so a DEFAULT (logging-off) runtime must attach no telemetry sink,
 * and the provider must therefore never JSON-serialize a successful
 * transport result (multi-MB getSpreadsheet payloads). The provider's
 * payload-size estimate is gated solely on `deps.onRequest` being present,
 * so this test counts stringify calls whose argument is a parsed transport
 * result (an object with an array `sheets` field) across one full effect
 * dispatch, with the logger disabled vs enabled.
 */
describe("bootstrap telemetry gating (zero serialization when logging is off)", () => {
  const GateUser = defineTypedSheetsEntity({
    name: "GateUser",
    tableName: "gate_users",
    properties: {
      id: { type: "string", primary: true },
      status: { type: "string" },
    },
  });

  const gateProjections = {
    spreadsheetId: "gate-spreadsheet",
    entities: {
      GateUser: {
        systemState: { tabName: "GateUsers_System", registeredRange: "A:C" },
        syncConflicts: { tabName: "GateUsers_Conflicts", registeredRange: "A:O" },
        userInput: { tabName: "GateUsers_Input", registeredRange: "A:C" },
        userOwnedFields: ["id", "status"],
      },
    },
  };

  const savedEnv = { ...process.env };
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "hikoutei-telemetry-gating-"));
    resetHikouteiInternalLoggerForTests();
  });

  afterEach(async () => {
    resetHikouteiInternalLoggerForTests();
    for (const name of Object.values(HIKOUTEI_LOG_ENV_KEYS)) {
      const original = savedEnv[name];
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  /** Runs one full effect dispatch (provision + flush + one worker pass). */
  async function runOneDispatch(): Promise<void> {
    const spreadsheet = new StubSpreadsheet();
    const transport = new StubSheetsTransport(spreadsheet);
    const service = await createInternalSyncService({
      dbName: ":memory:",
      entities: [GateUser],
      projections: gateProjections,
      googleSheetsApi: { transport, rateLimitIntervalMs: 0 },
      pollingIntervalMs: 3_600_000,
      effectIdleIntervalMs: 3_600_000,
    });
    try {
      const em = service.hikoutei.em.fork();
      em.persist(em.create(GateUser, { id: "gate-1", status: "pending" }));
      await em.flush();
      await service.effectSupervisor.runOnce();
      // The row really landed: the dispatch exercised the read/write path.
      expect(stubRowFields(spreadsheet.findTab("GateUsers_Input") as never, 2, ["id"]).id)
        .toEqual({ kind: "string", value: "gate-1" });
    } finally {
      await service.close();
    }
  }

  /**
   * Wraps JSON.stringify, counting calls whose payload is a parsed Google
   * transport result (an object with an array `sheets` field). Pass-through
   * behavior is unchanged.
   */
  function spyTransportResultStringifications(): { stop: () => number } {
    const original = JSON.stringify.bind(JSON) as unknown as (value: unknown, ...rest: unknown[]) => string;
    let count = 0;
    vi.spyOn(JSON, "stringify").mockImplementation(
      ((value: unknown, ...rest: unknown[]): string => {
        if (value !== null && typeof value === "object" &&
            Array.isArray((value as { sheets?: unknown }).sheets)) {
          count += 1;
        }
        return original(value, ...rest);
      }) as typeof JSON.stringify,
    );
    return { stop: () => { vi.restoreAllMocks(); return count; } };
  }

  it("serializes NO transport result when the internal logger is disabled", async () => {
    delete process.env[HIKOUTEI_LOG_ENV_KEYS.LOG_FILE];
    delete process.env[HIKOUTEI_LOG_ENV_KEYS.LOG_LEVEL];
    const spy = spyTransportResultStringifications();
    await runOneDispatch();
    expect(spy.stop()).toBe(0);
    expect(getHikouteiInternalLogger().enabled).toBe(false);
  });

  it("positive control: an enabled logger wires the sink and estimates payloads", async () => {
    process.env[HIKOUTEI_LOG_ENV_KEYS.LOG_FILE] = path.join(tempRoot, "gating-log.txt");
    process.env[HIKOUTEI_LOG_ENV_KEYS.LOG_LEVEL] = HIKOUTEI_LOG_LEVELS.DEBUG;
    const spy = spyTransportResultStringifications();
    await runOneDispatch();
    expect(spy.stop()).toBeGreaterThan(0);
  });
});

/**
 * Pins the polling lane's `responseBytes` to the RAW transport document size
 * (the fix this branch exists for). Observation reads return a parsed Map,
 * which stringifies to a meaningless 2-byte `"{}"`; the raw document is now
 * captured through `readTabGrids`' `onRawResponse` callback (sink-gated), and
 * `runRead` uses the supplied meta carrier WITHOUT falling back to
 * stringifying the Map. This e2e test asserts, per request line and per pass
 * summary, that polling-lane bytes equal `JSON.stringify(raw).length` of the
 * actual stub transport reply — never the Map artifact.
 */
describe("polling-lane responseBytes measures the RAW transport document", () => {
  const RawBytesUser = defineTypedSheetsEntity({
    name: "RawBytesUser",
    tableName: "raw_bytes_users",
    properties: {
      id: { type: "string", primary: true },
      status: { type: "string" },
    },
  });

  const rawBytesProjections = {
    spreadsheetId: "raw-bytes-spreadsheet",
    entities: {
      RawBytesUser: {
        systemState: { tabName: "RawBytesUsers_System", registeredRange: "A:C" },
        syncConflicts: { tabName: "RawBytesUsers_Conflicts", registeredRange: "A:O" },
        userInput: { tabName: "RawBytesUsers_Input", registeredRange: "A:C" },
        userOwnedFields: ["id", "status"],
      },
    },
  };

  const savedEnv = { ...process.env };
  let tempRoot: string;
  let logFile: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(tmpdir(), "hikoutei-raw-bytes-"));
    logFile = path.join(tempRoot, "raw-bytes-log.txt");
    process.env[HIKOUTEI_LOG_ENV_KEYS.LOG_FILE] = logFile;
    process.env[HIKOUTEI_LOG_ENV_KEYS.LOG_LEVEL] = HIKOUTEI_LOG_LEVELS.DEBUG;
    resetHikouteiInternalLoggerForTests();
  });

  afterEach(async () => {
    resetHikouteiInternalLoggerForTests();
    for (const name of Object.values(HIKOUTEI_LOG_ENV_KEYS)) {
      const original = savedEnv[name];
      if (original === undefined) delete process.env[name];
      else process.env[name] = original;
    }
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("records polling-lane bytes equal to the raw getSpreadsheet document, at line and summary level", async () => {
    const spreadsheet = new StubSpreadsheet();
    const transport = new StubSheetsTransport(spreadsheet);
    // Raw-document sizes for every successful getSpreadsheet, with the
    // OBSERVATION/LIGHTWEIGHT subset recorded separately: those masks are
    // unique to `readTabGrids` (the fixed path — its task returns a parsed
    // Map, so without the raw capture its polling line would record the 2-byte
    // "{}" artifact). Preflight/write-lane reads reuse other masks and their
    // task returns a parsed context, so their line bytes are parsed-object
    // estimates (a known pre-existing limitation, outside this fix's scope).
    const allRawSizes = new Map<number, number>();
    const observationRawSizes = new Map<number, number>();
    let sawObservationRead = false;
    const origGet = transport.getSpreadsheet.bind(transport);
    transport.getSpreadsheet = async (request: Parameters<typeof origGet>[0]) => {
      const raw = await origGet(request);
      const size = JSON.stringify(raw).length;
      allRawSizes.set(size, (allRawSizes.get(size) ?? 0) + 1);
      const fieldsText = String(request.fields ?? "");
      if (fieldsText === GOOGLE_SHEETS_API_OBSERVATION_FIELDS ||
          fieldsText === GOOGLE_SHEETS_API_LIGHTWEIGHT_OBSERVATION_FIELDS) {
        sawObservationRead = true;
        observationRawSizes.set(size, (observationRawSizes.get(size) ?? 0) + 1);
      }
      return raw;
    };
    const service = await createInternalSyncService({
      dbName: ":memory:",
      entities: [RawBytesUser],
      projections: rawBytesProjections,
      googleSheetsApi: { transport, rateLimitIntervalMs: 0 },
      pollingIntervalMs: 3_600_000,
      effectIdleIntervalMs: 3_600_000,
    });
    try {
      const em = service.hikoutei.em.fork();
      em.persist(em.create(RawBytesUser, { id: "raw-1", status: "pending" }));
      await em.flush();
      await service.effectSupervisor.runOnce();
      // The row really landed: the dispatch exercised read/write paths.
      expect(stubRowFields(spreadsheet.findTab("RawBytesUsers_Input") as never, 2, ["id"]).id)
        .toEqual({ kind: "string", value: "raw-1" });
    } finally {
      await service.close();
    }

    // The fixture actually exercised the fixed path (observation reads return
    // a parsed Map; without the raw capture they would record 2 bytes).
    expect(sawObservationRead).toBe(true);
    expect(observationRawSizes.size).toBeGreaterThan(0);

    await getHikouteiInternalLogger().drain();
    const lines = await readLogLines(logFile);

    // Per-request level: EVERY successful polling-lane getSpreadsheet DEBUG
    // line carries responseBytes that is a TRUE raw document size (a member of
    // the all-calls raw-size multiset), never the Map artifact ("{}" = 2).
    const pollingLineBytes = logEvents(lines, HIKOUTEI_LOG_EVENTS.SHEETS_REQUEST)
      .filter((line) => line.providerOperation === "getSpreadsheet")
      .filter((line) => (line.counts as Record<string, number>)?.httpStatus === 0)
      .filter((line) => line.pacing === "polling")
      .map((line) => (line.counts as Record<string, number>)?.responseBytes as number);
    expect(pollingLineBytes.length).toBeGreaterThan(0);
    const rawSizeMultiset = new Map(allRawSizes);
    for (const bytes of pollingLineBytes) {
      expect(bytes).toBeDefined();
      expect(bytes).not.toBe(2);
      const remaining = rawSizeMultiset.get(bytes) ?? 0;
      expect(remaining).toBeGreaterThan(0);
      rawSizeMultiset.set(bytes, remaining - 1);
    }
    // Every OBSERVATION-call raw size was carried by some polling line: the
    // fixed path reports the raw document, not the parsed Map.
    for (const size of observationRawSizes.keys()) {
      expect(pollingLineBytes).toContain(size);
    }

    // Summary (aggregator) level: pollingResponseBytesTotal equals the sum of
    // the polling lines' responseBytes, which per the per-line assertion above
    // equals the sum of the TRUE raw document sizes.
    const summaries = logEvents(lines, HIKOUTEI_LOG_EVENTS.SHEETS_REQUEST_SUMMARY);
    expect(summaries.length).toBeGreaterThanOrEqual(1);
    const pollingBytesFromSummaries = summaries.reduce(
      (sum, line) => sum + ((line.counts as Record<string, number>)?.pollingResponseBytesTotal ?? 0),
      0,
    );
    expect(pollingBytesFromSummaries).toBe(pollingLineBytes.reduce((sum, bytes) => sum + bytes, 0));
    expect(pollingBytesFromSummaries).toBeGreaterThan(2);
  });
});
