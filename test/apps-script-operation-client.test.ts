import { createHmac } from "node:crypto";

import { describe, expect, it, vi, afterEach } from "vitest";

import {
  APPS_SCRIPT_OPERATION_NAMES,
  SYNC_GATEWAY_ENCODINGS,
  SYNC_GATEWAY_HASH_ALGORITHMS,
} from "../src/adapter/sheets/providers/apps-script-gateway/protocol/constants.js";
import {
  AppsScriptOperationClient,
  type AppsScriptOperationRequestEvent,
} from "../src/adapter/sheets/providers/apps-script-gateway/transport/operationClient.js";
import {
  appsScriptOperationSigningInput,
  createAppsScriptOperationEnvelope,
} from "../src/adapter/sheets/providers/apps-script-gateway/protocol/codeGsProtocol.js";
import { canonicalSyncJson, syncSha256Hex } from "../src/adapter/sheets/providers/apps-script-gateway/protocol/syncProtocol.js";
import { SYNC_GATEWAY_CLIENT_ERROR_CODES } from "../src/adapter/sheets/providers/apps-script-gateway/errors.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("thin Code.gs operation client", () => {
  it("creates the envelope signed exactly as the current Code.gs expects", () => {
    const payload = {
      operations: [{ fn: "(spreadsheet, args) => args", args: { value: 1 } }],
    } as const;
    const envelope = createAppsScriptOperationEnvelope({
      operation: APPS_SCRIPT_OPERATION_NAMES.APPLY_OPERATIONS,
      payload,
      sheetId: "sheet-1",
      secret: "secret",
      actorId: "test-actor",
      keyId: "typed-sheets-shared-secret-v1",
      requestId: "request-1234",
      issuedAt: 1_700_000_000_000,
      expiresInMs: 60_000,
    });

    const expectedBodyHash = syncSha256Hex(canonicalSyncJson(payload));
    const signingInput = appsScriptOperationSigningInput({
      protocolVersion: envelope.protocolVersion,
      requestId: envelope.requestId,
      operation: envelope.operation,
      keyId: envelope.keyId,
      issuedAt: envelope.issuedAt,
      expiresAt: envelope.expiresAt,
      sheetId: envelope.sheetId,
      actorId: envelope.actorId,
      bodyHash: envelope.bodyHash,
    });
    const expectedSignature = createHmac(
      SYNC_GATEWAY_HASH_ALGORITHMS.SHA256,
      "secret",
    ).update(signingInput, SYNC_GATEWAY_ENCODINGS.UTF8)
      .digest(SYNC_GATEWAY_ENCODINGS.BASE64URL);

    expect(envelope).toMatchObject({
      operation: "applyOperations",
      bodyHash: expectedBodyHash,
      signature: expectedSignature,
      payload,
    });
    expect("registeredRange" in envelope).toBe(false);
  });

  it("sends Code.gs operations and decodes results in the same order", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        ok: true,
        result: { results: [{ rowNumber: 42 }, { accepted: true }] },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const events: AppsScriptOperationRequestEvent[] = [];

    const operations = [
      {
        fn: "(spreadsheet, args) => ({ rowNumber: args.rowNumber })",
        args: { rowNumber: 42 },
        decode: (value: unknown): number => {
          if (!isRecord(value) || typeof value.rowNumber !== "number") {
            throw new Error("invalid row result");
          }
          return value.rowNumber;
        },
      },
      {
        fn: "(spreadsheet, args) => ({ accepted: args.accepted })",
        args: { accepted: true },
        decode: (value: unknown): boolean => {
          if (!isRecord(value) || typeof value.accepted !== "boolean") {
            throw new Error("invalid accepted result");
          }
          return value.accepted;
        },
      },
    ] as const;

    const result = await new AppsScriptOperationClient({
      url: "https://example.test/apps-script-gateway",
      secret: "secret",
      sheetId: "sheet-1",
      onRequest: (event) => events.push(event),
    }).applyOperations(operations);

    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      readonly operation: string;
      readonly registeredRange?: string;
      readonly payload: {
        readonly operations: readonly { readonly fn: string; readonly args: unknown }[];
      };
    };

    expect(request.operation).toBe(APPS_SCRIPT_OPERATION_NAMES.APPLY_OPERATIONS);
    expect("registeredRange" in request).toBe(false);
    expect(request.payload.operations).toEqual([
      { fn: operations[0].fn, args: operations[0].args },
      { fn: operations[1].fn, args: operations[1].args },
    ]);
    expect(result).toEqual([42, true]);
    expect(events[0]).toMatchObject({
      operation: "applyOperations",
      operationCount: 2,
      ok: true,
      httpStatus: 200,
      clientErrorCode: null,
      remoteErrorCode: null,
    });
  });

  it("follows Apps Script response redirects by converting a 302 to GET", async () => {
    const response = (status: number, body: string, location?: string) => ({
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(location === undefined ? {} : { location }),
      text: async () => body,
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(
        302,
        "",
        "https://script.googleusercontent.com/macros/echo?user_content_key=test",
      ))
      .mockResolvedValueOnce(response(200, JSON.stringify({
        ok: true,
        result: { results: [{ accepted: true }] },
      })));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new AppsScriptOperationClient({
      url: "https://script.google.com/macros/s/deployment/exec",
      secret: "secret",
      sheetId: "sheet-1",
    }).applyOperations([{
      fn: "(spreadsheet, args) => ({ accepted: args.accepted })",
      args: { accepted: true },
    }]);

    expect(result).toEqual([{ accepted: true }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const second = fetchMock.mock.calls[1]?.[1] as RequestInit | undefined;
    expect(first?.method).toBe("POST");
    expect(second?.method).toBe("GET");
    expect(first?.redirect).toBe("manual");
    expect(second?.redirect).toBe("manual");
    expect(second?.body).toBeUndefined();
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://script.googleusercontent.com/macros/echo?user_content_key=test",
    );
  });

  it("preserves POST for a 307 redirect", async () => {
    const response = (status: number, body: string, location?: string) => ({
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(location === undefined ? {} : { location }),
      text: async () => body,
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(
        307,
        "",
        "https://script.googleusercontent.com/macros/echo?user_content_key=test",
      ))
      .mockResolvedValueOnce(response(200, JSON.stringify({
        ok: true,
        result: { results: [{ accepted: true }] },
      })));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new AppsScriptOperationClient({
      url: "https://script.google.com/macros/s/deployment/exec",
      secret: "secret",
      sheetId: "sheet-1",
    }).applyOperations([{
      fn: "(spreadsheet, args) => ({ accepted: args.accepted })",
      args: { accepted: true },
    }]);

    expect(result).toEqual([{ accepted: true }]);
    const first = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const second = fetchMock.mock.calls[1]?.[1] as RequestInit | undefined;
    expect(first?.method).toBe("POST");
    expect(second?.method).toBe("POST");
    expect(second?.body).toBe(first?.body);
  });

  it("classifies an unsafe redirect without following it", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 302,
      headers: new Headers({ location: "http://attacker.test/collect" }),
      text: async () => "",
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(new AppsScriptOperationClient({
      url: "https://script.google.com/macros/s/deployment/exec",
      secret: "secret",
      sheetId: "sheet-1",
    }).applyOperations([{
      fn: "(spreadsheet, args) => args",
      args: null,
    }])).rejects.toMatchObject({
      name: "AppsScriptSyncGatewayError",
      code: SYNC_GATEWAY_CLIENT_ERROR_CODES.INVALID_REDIRECT,
      status: { value: 302 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a redirect chain that exceeds the bounded policy", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => ({
      ok: false,
      status: 302,
      headers: new Headers({ location: `${url}?redirected=1` }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new AppsScriptOperationClient({
      url: "https://example.test/apps-script-gateway",
      secret: "secret",
      sheetId: "sheet-1",
    }).applyOperations([{
      fn: "(spreadsheet, args) => args",
      args: null,
    }])).rejects.toMatchObject({
      name: "AppsScriptSyncGatewayError",
      code: SYNC_GATEWAY_CLIENT_ERROR_CODES.INVALID_REDIRECT,
      status: { value: 302 },
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("rejects a malformed operation source before making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(new AppsScriptOperationClient({
      url: "https://example.test/apps-script-gateway",
      secret: "secret",
      sheetId: "sheet-1",
    }).applyOperations([{
      fn: "  ",
      args: null,
    }])).rejects.toMatchObject({
      name: "SyncGatewayProtocolError",
      code: "invalid_sync_gateway_operation_source",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects non-JSON operation arguments before signing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(new AppsScriptOperationClient({
      url: "https://example.test/apps-script-gateway",
      secret: "secret",
      sheetId: "sheet-1",
    }).applyOperations([{
      fn: "(spreadsheet, args) => args",
      args: { createdAt: new Date() },
    }])).rejects.toMatchObject({
      name: "SyncGatewayProtocolError",
      code: "invalid_sync_gateway_json_value",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps a Code.gs error as a typed remote transport error", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        ok: false,
        error: { code: "operation_failed", message: "write failed" },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(new AppsScriptOperationClient({
      url: "https://example.test/apps-script-gateway",
      secret: "secret",
      sheetId: "sheet-1",
    }).applyOperations([{
      fn: "(spreadsheet, args) => args",
      args: null,
    }])).rejects.toMatchObject({
      name: "AppsScriptSyncGatewayError",
      code: SYNC_GATEWAY_CLIENT_ERROR_CODES.REMOTE_ERROR,
      remoteCode: { value: "operation_failed" },
    });
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
