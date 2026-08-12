/**
 * Service-account access verification for `hikoutei setup`.
 *
 * After the spreadsheet is shared with the service account, the setup flow
 * verifies that the freshly created key can actually read the spreadsheet
 * (`spreadsheets.get`) before writing `.env`. Newly created keys and ACL
 * changes propagate asynchronously, so the check retries up to eight times
 * with the schedule 2, 4, 8, 16, 30, 30, 30 seconds between attempts (the
 * first attempt is immediate). Only propagation-class failures are retried,
 * and only when the corresponding resource was actually created this run:
 * invalid JWT signature is retried only when the key is fresh
 * (`keyFresh`), and 403/404 only when the writer permission was created or
 * upgraded this run (`shareFresh`). 429 quota and 5xx server errors always
 * retry. Any other 4xx, reused-key/reused-share propagation failures,
 * malformed or mismatched success payloads, and network failures fail
 * immediately with `sa_access_verify_failed`.
 *
 * The Sheets client is created through an injectable factory so tests can
 * script failures without network access or credentials. The verifier
 * authenticates with the validated key credential IN MEMORY (promoted by
 * the secure key read; never a `keyFile` path reopen), so a mid-run
 * replacement of the key file cannot redirect verification; the private
 * key exists only in process memory for the run.
 */

import { GoogleAuth } from "google-auth-library";
import { sheets } from "@googleapis/sheets";
import { isValidDriveId } from "./checkpoint.js";
import { SPREADSHEETS_SCOPE } from "./sheetsFactory.js";
import { httpStatusOf, safeError, safeReasonOf } from "./sdkError.js";

/** Context describing which resources were freshly created this run. */
export interface VerifyFreshness {
  /** True when the service-account key file was created during this run. */
  readonly keyFresh: boolean;
  /** True when the writer permission was created or upgraded during this run. */
  readonly shareFresh: boolean;
}

/**
 * In-memory, validated service-account credentials for one verify run.
 *
 * The setup flow promotes the validated key file into these credentials at
 * the secure descriptor boundary and the verifier NEVER reopens the key
 * pathname (no `keyFile` auth): a replacement of the key file after
 * validation cannot redirect verification. The `private_key` exists only
 * in process memory for the run; it is never stored, logged, or included
 * in any result.
 */
export interface SaAccessCredentials {
  readonly client_email: string;
  readonly private_key: string;
}

/** Verifies the service account can access the spreadsheet; throws on failure. */
export interface SaAccessVerifier {
  verify(
    request: { keyPath: string; spreadsheetId: string } & VerifyFreshness & {
      /** In-memory validated credentials; the verifier never reopens the key path. */
      readonly credentials: SaAccessCredentials;
    },
  ): Promise<void>;
}

/**
 * Delays in milliseconds between the eight verify attempts.
 *
 * The first attempt is immediate; seven delays follow (2, 4, 8, 16, 30, 30,
 * 30 seconds) for a total of eight attempts and a worst-case ~2 minutes of
 * waiting for propagation.
 */
export const SA_VERIFY_RETRY_DELAYS_MS = [2000, 4000, 8000, 16000, 30000, 30000, 30000] as const;

/** Injectable timer used between retry attempts. */
export interface Sleeper {
  sleep(ms: number): Promise<void>;
}

/** The minimal Sheets surface the verifier needs (injectable in tests). */
export interface SpreadsheetGetClient {
  get(request: { spreadsheetId: string }): Promise<{ readonly data: unknown }>;
}

/** Options for the production verifier factory. */
export interface SaAccessVerifierOptions {
  readonly sleeper: Sleeper;
  /**
   * Builds the Sheets client for in-memory validated credentials; defaults
   * to the real SDK. The client must NEVER reopen the key pathname.
   */
  readonly getClient?: (credentials: SaAccessCredentials) => SpreadsheetGetClient;
}

/** Production factory: verifies with the real Sheets SDK and an injected sleeper. */
export function createSaAccessVerifier(options: SaAccessVerifierOptions): SaAccessVerifier {
  const getClient = options.getClient ?? createSheetsGetClient;
  return {
    async verify(
      request: { keyPath: string; spreadsheetId: string } & VerifyFreshness & {
        readonly credentials: SaAccessCredentials;
      },
    ): Promise<void> {
      // Reject a malformed spreadsheet id BEFORE the client factory runs or
      // a request can reach the SDK: the id is untrusted input at this
      // boundary and must never reach a URL, a message, or a request.
      if (!isValidDriveId(request.spreadsheetId)) {
        throw safeError("a malformed spreadsheet id was refused before verification");
      }
      // The client is built from the IN-MEMORY validated credentials; the
      // key path is never reopened, so a mid-run path replacement cannot
      // redirect the verifier.
      const client = getClient(request.credentials);
      let attempt = 0;
      for (;;) {
        try {
          const response = await client.get({ spreadsheetId: request.spreadsheetId });
          requireSpreadsheetId(response.data, request.spreadsheetId);
          return;
        } catch (error) {
          const delay = SA_VERIFY_RETRY_DELAYS_MS[attempt];
          if (delay === undefined || !isRetryableVerifyError(error, request)) {
            throw safeError(`could not verify service-account access: ${safeReasonOf(error)}`);
          }
          await options.sleeper.sleep(delay);
          attempt += 1;
        }
      }
    },
  };
}

/**
 * True when the failure is propagation-class for THIS run and deserves
 * another attempt.
 *
 * Retried: 429 quota and 5xx server errors (always); invalid JWT signature
 * but only when the key was created this run; 403/404 but only when the
 * writer permission was created or upgraded this run. A generic
 * `invalid_grant`/expired-credentials error is not treated as propagation.
 * All other failures are permanent.
 */
export function isRetryableVerifyError(error: unknown, freshness: VerifyFreshness): boolean {
  const status = httpStatusOf(error);
  if (status === 429 || (status !== undefined && status >= 500)) {
    return true;
  }
  if (status === 403 || status === 404) {
    return freshness.shareFresh;
  }
  const message = error instanceof Error ? error.message : String(error);
  return freshness.keyFresh && message.includes("Invalid JWT Signature");
}

/**
 * Validates the raw `spreadsheets.get` success payload.
 *
 * A successful response must carry a non-empty URL-safe `spreadsheetId`
 * equal to the requested id; a missing, empty, malformed, or mismatched id
 * is a malformed payload and fails the verification immediately.
 */
export function requireSpreadsheetId(data: unknown, expectedSpreadsheetId: string): void {
  if (!isRecord(data)) {
    throw safeError("spreadsheets.get returned a non-object payload");
  }
  const { spreadsheetId } = data;
  if (!isValidDriveId(spreadsheetId)) {
    throw safeError("spreadsheets.get response is missing or carries a malformed spreadsheet id");
  }
  if (spreadsheetId !== expectedSpreadsheetId) {
    throw safeError("spreadsheets.get returned a spreadsheet id that does not match the requested spreadsheet");
  }
}

/**
 * Builds the real Sheets client for validated in-memory credentials.
 *
 * The client authenticates with `GoogleAuth({ credentials })` — the
 * in-memory `{client_email, private_key}` promoted by the secure key read
 * — NEVER with `keyFile`, so the key pathname is never reopened and a
 * mid-run replacement of the key file cannot redirect verification.
 */
function createSheetsGetClient(credentials: SaAccessCredentials): SpreadsheetGetClient {
  // The boundary cast keeps any google-auth-library version mismatch between
  // the top-level package and googleapis-common contained in this module.
  const auth = new GoogleAuth({
    credentials: { client_email: credentials.client_email, private_key: credentials.private_key },
    scopes: [SPREADSHEETS_SCOPE],
  }) as unknown as NonNullable<Parameters<typeof sheets>[0]["auth"]>;
  const client = sheets({ version: "v4", auth });
  return {
    get(request: { spreadsheetId: string }): Promise<{ readonly data: unknown }> {
      return client.spreadsheets.get(request);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
