/**
 * Credential-free coverage for the minimal Docs adapter:
 *
 * - `classifyDocsApiError`: shaped gaxios fixtures map to the stable Docs
 *   fault codes with presence-shaped status/remote-code (no network).
 * - `isRetryableDocsStatus`: 408/429/5xx (and absent status) retryable;
 *   proven pre-mutation 400/401/403/404 are not.
 * - `runDocsWrite`/`runDocsRead`: batch body passes through untouched, one
 *   redacted telemetry event fires, and a 429 feeds the SAME lane's AIMD
 *   governor (multiplier 2x) through the shared `runPacedRequest` shell.
 */

import { describe, expect, it } from "vitest";
import {
  PRESENCE_KINDS,
  QuotaPacingGovernor,
  ReadQoSScheduler,
  RequestStartLimiter,
  RollingQuotaBudget,
} from "@hikoutei/ikisaki";
import { GOOGLE_DOCS_API_TIMING } from "@hikoutei/docs/constants.js";
import {
  GOOGLE_DOCS_API_TRANSPORT_ERROR_CODES,
  DocsTransportError,
  isRetryableDocsStatus,
} from "@hikoutei/docs/errors.js";
import { classifyDocsApiError } from "@hikoutei/docs/docsApiTransport.js";
import {
  runDocsRead,
  runDocsWrite,
  type DocsApiRequestEvent,
  type DocsPacingDeps,
} from "@hikoutei/docs/runDocs.js";

function testDeps(onRequest?: (event: DocsApiRequestEvent) => void): DocsPacingDeps {
  const quotaGovernor = new QuotaPacingGovernor({ baseIntervalMs: 0 });
  return {
    maxRequestStartWaitMs: 5_000,
    now: Date.now,
    readScheduler: new ReadQoSScheduler({ intervalMs: 0 }),
    writeLimiter: new RequestStartLimiter({ intervalMs: 0 }),
    readBudget: new RollingQuotaBudget({
      maxStartsPerWindow: Number.POSITIVE_INFINITY,
      windowMs: 60_000,
    }),
    writeBudget: new RollingQuotaBudget({
      maxStartsPerWindow: Number.POSITIVE_INFINITY,
      windowMs: 60_000,
    }),
    quotaGovernor,
    timingDefaults: GOOGLE_DOCS_API_TIMING,
    onRequest,
  };
}

describe("classifyDocsApiError", () => {
  it("maps a 429 gaxios failure to HTTP_ERROR with status and remote code", () => {
    const error = classifyDocsApiError({
      response: { status: 429, data: { error: { status: "RESOURCE_EXHAUSTED" } } },
    });
    expect(error).toBeInstanceOf(DocsTransportError);
    expect(error.code).toBe(GOOGLE_DOCS_API_TRANSPORT_ERROR_CODES.HTTP_ERROR);
    expect(error.status).toEqual({ kind: PRESENCE_KINDS.PRESENT, value: 429 });
    expect(error.remoteCode).toEqual({
      kind: PRESENCE_KINDS.PRESENT,
      value: "RESOURCE_EXHAUSTED",
    });
  });

  it("maps a timeout code to TIMEOUT", () => {
    const error = classifyDocsApiError({ code: "ETIMEDOUT" });
    expect(error.code).toBe(GOOGLE_DOCS_API_TRANSPORT_ERROR_CODES.TIMEOUT);
    expect(error.status.kind).toBe(PRESENCE_KINDS.ABSENT);
  });

  it("maps an unknown error to NETWORK_ERROR", () => {
    const error = classifyDocsApiError(new Error("boom"));
    expect(error.code).toBe(GOOGLE_DOCS_API_TRANSPORT_ERROR_CODES.NETWORK_ERROR);
    expect(error.status.kind).toBe(PRESENCE_KINDS.ABSENT);
  });
});

describe("isRetryableDocsStatus", () => {
  it.each([undefined, 408, 429, 500, 503])("retryable: %s", (status) => {
    expect(isRetryableDocsStatus(status)).toBe(true);
  });
  it.each([400, 401, 403, 404])("not retryable: %s", (status) => {
    expect(isRetryableDocsStatus(status)).toBe(false);
  });
});

describe("runDocsWrite", () => {
  it("passes the batch body through and emits one redacted event", async () => {
    const events: DocsApiRequestEvent[] = [];
    const deps = testDeps((event) => {
      events.push(event);
    });
    const requests = [{ insertText: { text: "hi" } }];
    const result = await runDocsWrite(deps, "batchUpdate", () => Promise.resolve({ replies: [{}] }), {
      requestCount: requests.length,
    });
    expect(result).toEqual({ replies: [{}] });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      operation: "batchUpdate",
      pacing: "write",
      operationCount: 1,
      ok: true,
      requestCount: 1,
    });
    expect(events[0]?.credentialIndex).toBeUndefined();
  });

  it("feeds a 429 back to the write lane governor (2x backoff)", async () => {
    const deps = testDeps();
    const quotaError = new DocsTransportError(
      GOOGLE_DOCS_API_TRANSPORT_ERROR_CODES.HTTP_ERROR,
      "Google Docs API request failed",
      { kind: PRESENCE_KINDS.PRESENT, value: 429 },
      { kind: PRESENCE_KINDS.PRESENT, value: "RESOURCE_EXHAUSTED" },
    );
    await expect(
      runDocsWrite(deps, "batchUpdate", () => Promise.reject(quotaError)),
    ).rejects.toBe(quotaError);
    expect(deps.quotaGovernor.stateFor("write")).toMatchObject({
      status: "backoff",
      multiplier: 2,
    });
    expect(deps.quotaGovernor.stateFor("read")).toMatchObject({ status: "nominal" });
  });
});

describe("runDocsRead", () => {
  it("admits on the polling lane and reports success", async () => {
    const events: DocsApiRequestEvent[] = [];
    const deps = testDeps((event) => {
      events.push(event);
    });
    const result = await runDocsRead(deps, () => Promise.resolve({ title: "t" }));
    expect(result).toEqual({ title: "t" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ operation: "getDocument", pacing: "polling", ok: true });
  });
});
