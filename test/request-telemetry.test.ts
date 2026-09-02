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
  StubSpreadsheet,
  StubSheetsTransport,
  stubRowFields,
} from "./support/StubSheetsTransport.js";

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
