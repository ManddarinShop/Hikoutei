/** Client boundary for invoking the current thin Apps Script `Code.gs`. */

import {
  APPS_SCRIPT_OPERATION_NAMES,
  SYNC_GATEWAY_CLIENT_DEFAULTS,
  type AppsScriptOperationName,
} from "../protocol/constants.js";
import {
  createAppsScriptOperationEnvelope,
  type AppsScriptOperationEnvelope,
  type AppsScriptOperationPayload,
  type AppsScriptOperationWire,
} from "../protocol/codeGsProtocol.js";
import {
  SYNC_GATEWAY_PROTOCOL_ERROR_CODES,
  SyncGatewayProtocolError,
  AppsScriptSyncGatewayError,
  SYNC_GATEWAY_CLIENT_ERROR_CODES,
} from "../errors.js";
import { canonicalSyncJson } from "../protocol/syncProtocol.js";
import type { SyncJsonValue } from "../protocol/types.js";
import { JAVASCRIPT_TYPE_NAMES } from "../../../../../core/encoding/constants.js";
import { isJavaScriptType, isRecord } from "../../../../../core/encoding/typeGuards.js";
import { PRESENCE_KINDS } from "../../../../../core/state/constants.js";
import type { Presence } from "../../../../../core/state/types.js";

/** One self-contained function call serialized for `Code.gs`. */
export interface AppsScriptOperationDefinition<
  Args = SyncJsonValue,
  Result = unknown,
> {
  /** Function source with `(spreadsheet, args)` parameters and no external closure. */
  readonly fn: string;
  readonly args: Args;
  /** Promotes the untrusted JSON result into a checked application value. */
  readonly decode?: (value: unknown) => Result;
}

/** Erased operation shape used only to accept heterogeneous typed operations. */
export type AnyAppsScriptOperationDefinition = AppsScriptOperationDefinition<
  unknown,
  unknown
>;

/** Result type selected by one operation's optional decoder. */
export type AppsScriptOperationResult<Operation> =
  Operation extends { readonly decode?: (value: unknown) => infer Result }
    ? Result
    : unknown;

/** Tuple of decoded results that preserves the input operation order. */
export type AppsScriptOperationResults<
  Operations extends readonly AnyAppsScriptOperationDefinition[],
> = {
  readonly [Index in keyof Operations]: AppsScriptOperationResult<Operations[Index]>;
};

/** Adapter-neutral boundary for a batch of thin Apps Script operations. */
export interface AppsScriptOperationGateway {
  applyOperations<Operations extends readonly AnyAppsScriptOperationDefinition[]>(
    operations: Operations,
  ): Promise<AppsScriptOperationResults<Operations>>;
}

/** Settings for the signed client that calls the deployed `Code.gs` web app. */
export interface AppsScriptOperationClientOptions {
  readonly url: string;
  readonly secret: string;
  readonly sheetId: string;
  readonly keyId?: string;
  readonly actorId?: string;
  readonly requestTimeoutMs?: number;
  /** Receives request timing without operation arguments or returned values. */
  readonly onRequest?: (event: AppsScriptOperationRequestEvent) => void;
}

/** Redacted transport event for diagnosing a Code.gs invocation. */
export interface AppsScriptOperationRequestEvent {
  readonly requestId: string;
  readonly operation: AppsScriptOperationName;
  readonly operationCount: number;
  readonly startedAt: number;
  readonly durationMs: number;
  readonly ok: boolean;
  readonly httpStatus: number | null;
  readonly requestBytes: number;
  readonly responseBytes: number;
  readonly clientErrorCode: string | null;
  readonly remoteErrorCode: string | null;
}

/** Calls `Code.gs` without exposing its dynamic function executor to the rest of the runtime. */
export class AppsScriptOperationClient implements AppsScriptOperationGateway {
  private readonly url: string;
  private readonly secret: string;
  private readonly sheetId: string;
  private readonly keyId: string;
  private readonly actorId: string;
  private readonly requestTimeoutMs: number;
  private readonly onRequest: ((event: AppsScriptOperationRequestEvent) => void) | undefined;

  public constructor(options: AppsScriptOperationClientOptions) {
    let url: URL;
    try {
      url = new URL(options.url);
    } catch {
      throw new SyncGatewayProtocolError(
        SYNC_GATEWAY_PROTOCOL_ERROR_CODES.INVALID_CLIENT_OPTIONS,
        "Apps Script operation URL must be valid",
      );
    }
    if (url.protocol !== "https:") {
      throw new SyncGatewayProtocolError(
        SYNC_GATEWAY_PROTOCOL_ERROR_CODES.INVALID_CLIENT_OPTIONS,
        "Apps Script operation URL must use HTTPS",
      );
    }

    this.url = url.toString();
    this.secret = requireTextOption(options.secret, "Apps Script operation secret");
    this.sheetId = requireTextOption(options.sheetId, "Apps Script operation sheet ID");
    this.keyId = requireTextOption(
      options.keyId ?? "typed-sheets-shared-secret-v1",
      "Apps Script operation key ID",
    );
    this.actorId = requireTextOption(
      options.actorId ?? "typed-sheets-sync-worker",
      "Apps Script operation actor ID",
    );
    this.requestTimeoutMs = requireRequestTimeout(
      options.requestTimeoutMs ?? SYNC_GATEWAY_CLIENT_DEFAULTS.REQUEST_TIMEOUT_MS,
    );
    this.onRequest = options.onRequest;
  }

  /** Sends one signed batch and decodes each result at the caller's boundary. */
  public async applyOperations<
    Operations extends readonly AnyAppsScriptOperationDefinition[],
  >(
    operations: Operations,
  ): Promise<AppsScriptOperationResults<Operations>> {
    const payload: AppsScriptOperationPayload = {
      operations: operations.map(toWireOperation),
    };
    const envelope = createAppsScriptOperationEnvelope({
      operation: APPS_SCRIPT_OPERATION_NAMES.APPLY_OPERATIONS,
      payload,
      sheetId: this.sheetId,
      secret: this.secret,
      keyId: this.keyId,
      actorId: this.actorId,
    });
    const result = requireOperationBatchResult(await this.post(envelope), operations.length);
    return operations.map((operation, index) => {
      const value = result[index];
      return operation.decode === undefined ? value : operation.decode(value);
    }) as AppsScriptOperationResults<Operations>;
  }

  private async post(envelope: AppsScriptOperationEnvelope): Promise<unknown> {
    const startedAt = Date.now();
    const requestBody = JSON.stringify(envelope);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let httpStatus: number | null = null;
    let responseBytes = 0;

    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: requestBody,
        signal: controller.signal,
        redirect: "follow",
      });
      httpStatus = response.status;
      const responseText = await response.text();
      responseBytes = Buffer.byteLength(responseText, "utf8");
      const decoded = parseCodeGsResponse(responseText, present(httpStatus));

      if (!response.ok) {
        if (decoded.ok) {
          throw new AppsScriptSyncGatewayError(
            SYNC_GATEWAY_CLIENT_ERROR_CODES.HTTP_ERROR,
            `Code.gs returned HTTP ${response.status}`,
            present(httpStatus),
          );
        }
        throw remoteError(decoded.error, present(httpStatus));
      }
      if (!decoded.ok) throw remoteError(decoded.error, present(httpStatus));

      this.notifyRequest({
        requestId: envelope.requestId,
        operation: envelope.operation,
        operationCount: envelope.payload.operations.length,
        startedAt,
        durationMs: Date.now() - startedAt,
        ok: true,
        httpStatus,
        requestBytes: Buffer.byteLength(requestBody, "utf8"),
        responseBytes,
        clientErrorCode: null,
        remoteErrorCode: null,
      });
      return decoded.result;
    } catch (error: unknown) {
      const normalizedError = error instanceof AppsScriptSyncGatewayError
        ? error
        : error instanceof Error && error.name === "AbortError"
          ? new AppsScriptSyncGatewayError(
            SYNC_GATEWAY_CLIENT_ERROR_CODES.TIMEOUT,
            "Code.gs operation request timed out",
            presentOrAbsent(httpStatus),
          )
          : new AppsScriptSyncGatewayError(
            SYNC_GATEWAY_CLIENT_ERROR_CODES.NETWORK_ERROR,
            `Code.gs operation request failed: ${safeMessage(error)}`,
            presentOrAbsent(httpStatus),
          );
      this.notifyRequest({
        requestId: envelope.requestId,
        operation: envelope.operation,
        operationCount: envelope.payload.operations.length,
        startedAt,
        durationMs: Date.now() - startedAt,
        ok: false,
        httpStatus,
        requestBytes: Buffer.byteLength(requestBody, "utf8"),
        responseBytes,
        clientErrorCode: normalizedError.code,
        remoteErrorCode: normalizedError.remoteCode.kind === PRESENCE_KINDS.PRESENT
          ? normalizedError.remoteCode.value
          : null,
      });
      throw normalizedError;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Keeps optional request telemetry from changing the operation result. */
  private notifyRequest(event: AppsScriptOperationRequestEvent): void {
    try {
      this.onRequest?.(event);
    } catch {
      // Diagnostics must never make a successful remote operation fail.
    }
  }
}

function toWireOperation(
  operation: AnyAppsScriptOperationDefinition,
): AppsScriptOperationWire {
  if (typeof operation.fn !== "string" || operation.fn.trim().length === 0) {
    throw new SyncGatewayProtocolError(
      SYNC_GATEWAY_PROTOCOL_ERROR_CODES.INVALID_OPERATION_SOURCE,
      "Apps Script operation fn must be a non-empty function source",
    );
  }
  // The canonical encoder performs the runtime JSON-value check for args.
  canonicalSyncJson(operation.args);
  // canonicalSyncJson has already promoted the value through the runtime
  // JSON boundary; the cast keeps typed operation argument shapes ergonomic.
  return { fn: operation.fn, args: operation.args as SyncJsonValue };
}

function requireOperationBatchResult(
  value: unknown,
  expectedCount: number,
): readonly unknown[] {
  if (!isRecord(value) || !Array.isArray(value.results) || value.results.length !== expectedCount) {
    throw new AppsScriptSyncGatewayError(
      SYNC_GATEWAY_CLIENT_ERROR_CODES.INVALID_RESPONSE,
      "Code.gs result must contain one result for every submitted operation",
      { kind: PRESENCE_KINDS.ABSENT },
    );
  }
  return value.results;
}

type CodeGsResponse =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

function parseCodeGsResponse(
  responseText: string,
  status: Presence<number>,
): CodeGsResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText) as unknown;
  } catch {
    throw new AppsScriptSyncGatewayError(
      SYNC_GATEWAY_CLIENT_ERROR_CODES.INVALID_RESPONSE,
      "Code.gs response was not valid JSON",
      status,
    );
  }
  if (!isRecord(parsed) || !isJavaScriptType(parsed.ok, JAVASCRIPT_TYPE_NAMES.BOOLEAN)) {
    throw new AppsScriptSyncGatewayError(
      SYNC_GATEWAY_CLIENT_ERROR_CODES.INVALID_RESPONSE,
      "Code.gs response must contain a boolean ok field",
      status,
    );
  }
  if (parsed.ok) return { ok: true, result: parsed.result };
  if (
    !isRecord(parsed.error) ||
    !isJavaScriptType(parsed.error.code, JAVASCRIPT_TYPE_NAMES.STRING) ||
    !isJavaScriptType(parsed.error.message, JAVASCRIPT_TYPE_NAMES.STRING)
  ) {
    throw new AppsScriptSyncGatewayError(
      SYNC_GATEWAY_CLIENT_ERROR_CODES.INVALID_RESPONSE,
      "Code.gs error response is malformed",
      status,
    );
  }
  return {
    ok: false,
    error: { code: parsed.error.code, message: parsed.error.message },
  };
}

function remoteError(
  error: { readonly code: string; readonly message: string },
  status: Presence<number>,
): AppsScriptSyncGatewayError {
  return new AppsScriptSyncGatewayError(
    SYNC_GATEWAY_CLIENT_ERROR_CODES.REMOTE_ERROR,
    error.message,
    status,
    present(error.code),
  );
}

function requireTextOption(value: unknown, label: string): string {
  if (
    !isJavaScriptType(value, JAVASCRIPT_TYPE_NAMES.STRING) ||
    value.trim().length === 0
  ) {
    throw new SyncGatewayProtocolError(
      SYNC_GATEWAY_PROTOCOL_ERROR_CODES.INVALID_CLIENT_OPTIONS,
      `${label} is required`,
    );
  }
  return value;
}

function requireRequestTimeout(value: unknown): number {
  if (
    !isJavaScriptType(value, JAVASCRIPT_TYPE_NAMES.NUMBER) ||
    !Number.isSafeInteger(value) ||
    value < SYNC_GATEWAY_CLIENT_DEFAULTS.MIN_REQUEST_TIMEOUT_MS ||
    value > SYNC_GATEWAY_CLIENT_DEFAULTS.MAX_REQUEST_TIMEOUT_MS
  ) {
    throw new SyncGatewayProtocolError(
      SYNC_GATEWAY_PROTOCOL_ERROR_CODES.INVALID_CLIENT_OPTIONS,
      "Apps Script operation timeout must be between 1 second and 120 seconds",
    );
  }
  return value;
}

function present<T>(value: T): Presence<T> {
  return { kind: PRESENCE_KINDS.PRESENT, value };
}

function presentOrAbsent(value: number | null): Presence<number> {
  return value === null
    ? { kind: PRESENCE_KINDS.ABSENT }
    : present(value);
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected transport failure";
}
