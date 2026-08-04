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
import { requireSyncJsonValue } from "../protocol/syncProtocol.js";
import type { SyncJsonValue } from "../protocol/types.js";
import { JAVASCRIPT_TYPE_NAMES } from "../../../../../shared/encoding/constants.js";
import { isJavaScriptType, isRecord } from "../../../../../shared/encoding/typeGuards.js";
import { PRESENCE_KINDS } from "../../../../../shared/state/constants.js";
import { absentValue, presentValue } from "../../../../../shared/state/index.js";
import type { Presence } from "../../../../../shared/state/types.js";
import type { HikouteiRequestId } from "../../../../../shared/identity/types.js";

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
  readonly requestId: HikouteiRequestId;
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
    const decoded = operations.map((operation, index) => {
      const value = result[index];
      return operation.decode === undefined ? value : operation.decode(value);
    });
    // The response-length check plus each operation decoder establish the
    // runtime invariant that the mapped tuple type represents.
    return decoded as AppsScriptOperationResults<Operations>;
  }

  private async post(envelope: AppsScriptOperationEnvelope): Promise<unknown> {
    const startedAt = Date.now();
    const requestBody = JSON.stringify(envelope);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let httpStatus: number | null = null;
    let responseBytes = 0;
    let requestUrl = this.url;
    let requestMethod: "GET" | "POST" = "POST";
    let redirectCount = 0;

    try {
      let response: Response;
      while (true) {
        const requestInit: RequestInit = {
          method: requestMethod,
          signal: controller.signal,
          // Validate the target ourselves. Apps Script commonly returns a
          // 302 after executing the POST and exposes the result through a
          // googleusercontent GET; 307/308 are the redirects that preserve
          // the original method and body.
          redirect: "manual",
          ...(requestMethod === "POST"
            ? {
              headers: { "content-type": "application/json" },
              body: requestBody,
            }
            : {}),
        };
        response = await fetch(requestUrl, requestInit);
        httpStatus = response.status;
        if (!isRedirectStatus(response.status)) break;
        const location = response.headers.get("location");
        // Release the manual redirect response before opening the next request;
        // a redirect body is never part of the signed gateway protocol.
        try {
          await response.body?.cancel();
        } catch {
          // The redirect target is still validated below; a failed body cancel
          // must not turn a malformed Location into an unrelated network error.
        }
        if (redirectCount >= MAX_REDIRECTS) {
          throw invalidRedirectError(
            `Code.gs redirect limit of ${MAX_REDIRECTS} was exceeded`,
            httpStatus,
          );
        }
        requestUrl = resolveRedirectUrl(requestUrl, location, httpStatus);
        if (REDIRECT_REWRITE_TO_GET_STATUS_CODES.has(response.status)) {
          requestMethod = "GET";
        }
        redirectCount += 1;
      }

      const responseText = await response.text();
      responseBytes = Buffer.byteLength(responseText, "utf8");
      const decoded = parseCodeGsResponse(responseText, presentValue(httpStatus));

      if (!response.ok) {
        if (decoded.ok) {
          throw new AppsScriptSyncGatewayError(
            SYNC_GATEWAY_CLIENT_ERROR_CODES.HTTP_ERROR,
            `Code.gs returned HTTP ${response.status}`,
            presentValue(httpStatus),
          );
        }
        throw remoteError(decoded.error, presentValue(httpStatus));
      }
      if (!decoded.ok) throw remoteError(decoded.error, presentValue(httpStatus));

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
  const args = requireSyncJsonValue(operation.args);
  return { fn: operation.fn, args };
}

function requireOperationBatchResult(
  value: unknown,
  expectedCount: number,
): readonly unknown[] {
  if (!isRecord(value) || !Array.isArray(value.results) || value.results.length !== expectedCount) {
    throw new AppsScriptSyncGatewayError(
      SYNC_GATEWAY_CLIENT_ERROR_CODES.INVALID_RESPONSE,
      "Code.gs result must contain one result for every submitted operation",
      absentValue(),
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
    parsed = JSON.parse(responseText);
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
    presentValue(error.code),
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

const MAX_REDIRECTS = 3;
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const REDIRECT_REWRITE_TO_GET_STATUS_CODES = new Set([301, 302, 303]);
const TRUSTED_REDIRECT_HOSTS = new Set([
  "script.google.com",
  "script.googleusercontent.com",
]);

function isRedirectStatus(status: number): boolean {
  return REDIRECT_STATUS_CODES.has(status);
}

function resolveRedirectUrl(
  currentUrl: string,
  location: string | null,
  status: number,
): string {
  if (location === null || location.trim().length === 0) {
    throw invalidRedirectError("Code.gs redirect did not contain a Location header", status);
  }

  let redirected: URL;
  try {
    redirected = new URL(location, currentUrl);
  } catch {
    throw invalidRedirectError("Code.gs redirect Location was not a valid URL", status);
  }
  if (
    redirected.protocol !== "https:" ||
    redirected.username.length > 0 ||
    redirected.password.length > 0 ||
    redirected.hash.length > 0
  ) {
    throw invalidRedirectError(
      "Code.gs redirect must target an HTTPS URL without credentials or a fragment",
      status,
    );
  }

  const current = new URL(currentUrl);
  const sameHost = redirected.hostname === current.hostname;
  const trustedGoogleHost = TRUSTED_REDIRECT_HOSTS.has(redirected.hostname);
  if (!sameHost && !trustedGoogleHost) {
    throw invalidRedirectError(
      "Code.gs redirect target is not the configured gateway or a trusted Apps Script host",
      status,
    );
  }
  return redirected.toString();
}

function invalidRedirectError(statusMessage: string, status: number): AppsScriptSyncGatewayError {
  return new AppsScriptSyncGatewayError(
    SYNC_GATEWAY_CLIENT_ERROR_CODES.INVALID_REDIRECT,
    statusMessage,
    presentValue(status),
  );
}

function presentOrAbsent(value: number | null): Presence<number> {
  return value === null ? absentValue() : presentValue(value);
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected transport failure";
}
