/**
 * Narrow transport for the Google Docs API provider (`documents` only).
 *
 * All Google SDK types stay behind this module: callers work with the small
 * request shapes below and treat every response as untrusted `unknown`.
 * gaxios auto-retry is disabled for every call: retries are the durable
 * worker/recovery path's job, and a retried mutating request could replay
 * an already committed batchUpdate. All errors are mapped to
 * `DocsTransportError` before leaving this module.
 */

import { GoogleAuth } from "google-auth-library";
import { docs, type docs_v1 } from "@googleapis/docs";
import {
  parseRawErrorRecord,
  parseRawErrorText,
  parseRawHttpStatus,
  PRESENCE_KINDS,
  type Presence,
} from "@hikoutei/ikisaki";
import { ServiceAccountAuthPool } from "@hikoutei/google-auth/auth/serviceAccountAuthPool.js";
import { GOOGLE_DOCS_API_SCOPES } from "./constants.js";
import {
  GOOGLE_DOCS_API_TRANSPORT_ERROR_CODES,
  DocsTransportError,
} from "./errors.js";

/** Auth type accepted by the docs factory (may resolve to a nested version). */
export type DocsAuth = NonNullable<Parameters<typeof docs>[0]["auth"]>;

/** Optional pool-identity binding: the admitted identity IS the signer. */
export interface DocsCredentialBinding {
  readonly credentialIndex?: number;
}

/** One `documents.create` call. */
export interface DocsCreateDocumentRequest extends DocsCredentialBinding {
  readonly title: string;
}

/** One `documents.get` call. */
export interface DocsGetDocumentRequest extends DocsCredentialBinding {
  readonly documentId: string;
  readonly timeoutMs?: number;
}

/** One `documents.batchUpdate` call. */
export interface DocsBatchUpdateRequest extends DocsCredentialBinding {
  readonly documentId: string;
  /**
   * Structural update requests (e.g. `{ insertText: ... }`). Kept as
   * `unknown` at the boundary so no SDK type leaks to callers; the
   * transport passes them straight to the API body.
   */
  readonly requests: readonly unknown[];
}

/** Narrow transport boundary; responses are raw (untrusted) bodies. */
export interface DocsApiTransport {
  createDocument(request: DocsCreateDocumentRequest): Promise<unknown>;
  getDocument(request: DocsGetDocumentRequest): Promise<unknown>;
  batchUpdate(request: DocsBatchUpdateRequest): Promise<unknown>;
}

/** Options for the real HTTP transport backed by @googleapis/docs. */
export interface DocsApiHttpTransportOptions {
  readonly auth?: DocsAuth;
  readonly authPool?: readonly DocsAuth[];
  readonly serviceAccountKeyFiles?: readonly string[];
  readonly requestTimeoutMs: number;
}

/**
 * Real transport over the Google Docs REST API.
 *
 * One client per pooled credential; a 1-client pool is the single-auth
 * transport. Credential-pool selection (round-robin + index binding) lives
 * in the shared `@hikoutei/google-auth` pool.
 */
export class DocsApiHttpTransport implements DocsApiTransport {
  private readonly clients: readonly ReturnType<typeof docs>[];
  private readonly credentialPool: ServiceAccountAuthPool<DocsAuth>;
  private readonly requestTimeoutMs: number;

  public constructor(options: DocsApiHttpTransportOptions) {
    const filePool = ServiceAccountAuthPool.loadFromKeyFiles(options.serviceAccountKeyFiles ?? [], {
      scopes: [...GOOGLE_DOCS_API_SCOPES],
      fail: (failure) => {
        throw new DocsTransportError(
          GOOGLE_DOCS_API_TRANSPORT_ERROR_CODES.NETWORK_ERROR,
          `Unable to read the service-account key file: ${failure.path}`,
          absent(),
          absent(),
        );
      },
      onInvalidSelection: (message): never => {
        throw new DocsTransportError(
          GOOGLE_DOCS_API_TRANSPORT_ERROR_CODES.NETWORK_ERROR,
          `Google Docs API transport: ${message}`,
          absent(),
          absent(),
        );
      },
    });
    const pool: DocsAuth[] = [
      ...(options.authPool ?? []),
      ...(filePool.auths as unknown as DocsAuth[]),
    ];
    if (pool.length === 0) {
      pool.push(options.auth ??
        (new GoogleAuth({ scopes: [...GOOGLE_DOCS_API_SCOPES] }) as unknown as DocsAuth));
    }
    this.clients = pool.map((auth) => docs({ version: "v1", auth }));
    this.credentialPool = new ServiceAccountAuthPool(pool, {
      onInvalidSelection: (message): never => {
        throw new DocsTransportError(
          GOOGLE_DOCS_API_TRANSPORT_ERROR_CODES.NETWORK_ERROR,
          `Google Docs API transport: ${message}`,
          absent(),
          absent(),
        );
      },
    });
    this.requestTimeoutMs = options.requestTimeoutMs;
  }

  private clientFor(credentialIndex: number | undefined): ReturnType<typeof docs> {
    return this.clients[this.credentialPool.selectIndex(credentialIndex)] as ReturnType<typeof docs>;
  }

  public async createDocument(request: DocsCreateDocumentRequest): Promise<unknown> {
    try {
      const response = await this.clientFor(request.credentialIndex).documents.create(
        { requestBody: { title: request.title } },
        { timeout: this.requestTimeoutMs, retry: false },
      );
      return response.data;
    } catch (error: unknown) {
      throw classifyDocsApiError(error);
    }
  }

  public async getDocument(request: DocsGetDocumentRequest): Promise<unknown> {
    try {
      const response = await this.clientFor(request.credentialIndex).documents.get(
        { documentId: request.documentId },
        { timeout: request.timeoutMs ?? this.requestTimeoutMs, retry: false },
      );
      return response.data;
    } catch (error: unknown) {
      throw classifyDocsApiError(error);
    }
  }

  public async batchUpdate(request: DocsBatchUpdateRequest): Promise<unknown> {
    try {
      const response = await this.clientFor(request.credentialIndex).documents.batchUpdate(
        {
          documentId: request.documentId,
          // Boundary cast (same pattern as the Sheets transport): callers
          // pass structural payloads as `unknown`; only this module meets
          // the SDK request union.
          requestBody: { requests: [...request.requests] as docs_v1.Schema$Request[] },
        },
        { timeout: this.requestTimeoutMs, retry: false },
      );
      return response.data;
    } catch (error: unknown) {
      throw classifyDocsApiError(error);
    }
  }
}

/**
 * Maps a thrown SDK/gaxios/network error to the provider transport error.
 *
 * Exported separately so tests can exercise the mapping with shaped fixtures
 * instead of real network failures. Any error without a proven HTTP status
 * is classified conservatively as delivery-uncertain material, never as a
 * proven pre-mutation rejection.
 */
export function classifyDocsApiError(error: unknown): DocsTransportError {
  const shape = extractGaxiosErrorShape(error);
  if (shape.status !== undefined) {
    const remoteCode = typeof shape.apiErrorStatus === "string" && shape.apiErrorStatus.length > 0
      ? shape.apiErrorStatus
      : String(shape.status);
    return new DocsTransportError(
      GOOGLE_DOCS_API_TRANSPORT_ERROR_CODES.HTTP_ERROR,
      "Google Docs API request failed",
      present(shape.status),
      present(remoteCode),
    );
  }
  if (isTimeoutError(error, shape.code)) {
    return new DocsTransportError(
      GOOGLE_DOCS_API_TRANSPORT_ERROR_CODES.TIMEOUT,
      "Google Docs API request timed out",
      absent(),
      shape.code === undefined ? absent() : present(shape.code),
    );
  }
  return new DocsTransportError(
    GOOGLE_DOCS_API_TRANSPORT_ERROR_CODES.NETWORK_ERROR,
    "Google Docs API transport failed",
    absent(),
    shape.code === undefined ? absent() : present(shape.code),
  );
}

interface GaxiosErrorShape {
  readonly code: string | undefined;
  readonly status: number | undefined;
  readonly apiErrorStatus: string | undefined;
}

function extractGaxiosErrorShape(error: unknown): GaxiosErrorShape {
  const record = parseRawErrorRecord(error);
  if (record === undefined) {
    return { code: undefined, status: undefined, apiErrorStatus: undefined };
  }
  const code = parseRawErrorText(record.code);
  const responseRecord = parseRawErrorRecord(record.response);
  const status = parseRawHttpStatus(record.status) ??
    parseRawHttpStatus(responseRecord?.status);
  const dataRecord = parseRawErrorRecord(responseRecord?.data);
  const errorRecord = parseRawErrorRecord(dataRecord?.error);
  const apiErrorStatus = parseRawErrorText(errorRecord?.status);
  return { code, status, apiErrorStatus };
}

function isTimeoutError(error: unknown, code: string | undefined): boolean {
  if (code !== undefined && /TIMEOUT|TIMEDOUT|DEADLINE|ABORTED|ETIMEDOUT/i.test(code)) {
    return true;
  }
  return error instanceof Error && /timeout|timed out|deadline exceeded/i.test(error.message);
}

function present<T>(value: T): Presence<T> {
  return { kind: PRESENCE_KINDS.PRESENT, value };
}

function absent<T = never>(): Presence<T> {
  return { kind: PRESENCE_KINDS.ABSENT };
}
