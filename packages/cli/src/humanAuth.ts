/**
 * Pre-mutation human authentication for `hikoutei setup`.
 *
 * The setup flow creates the spreadsheet as the logged-in human account
 * (service accounts cannot own Workspace assets), so before any cloud or
 * file mutation it retrieves the active user's OAuth access token with
 * `gcloud auth print-access-token` and validates it through the tokeninfo
 * endpoint. The token must include the Drive scope, otherwise setup fails
 * with `gcloud_drive_access_required` and the exact re-login command.
 *
 * The token exists only in memory for the duration of the run: it is never
 * written to the checkpoint, the .env file, or any log/error message.
 */

import { SETUP_ERROR_CODES } from "./errors.js";
import type { GcloudRunner, GcloudRunResult } from "./gcloudRunner.js";
import { safeError, safeReasonOf } from "./sdkError.js";

/** Scope required to create and manage the spreadsheet as the human owner. */
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

/** Minimal Drive scope that still allows creating and sharing a spreadsheet. */
export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";

/**
 * Strict printable Google account email format.
 *
 * The tokeninfo `email` becomes the spreadsheet owner identity: it is
 * persisted in the checkpoint and shown in the summary, so it must be a
 * strict printable email (no whitespace, control characters, or newlines —
 * a `\n` in the email could otherwise smuggle secret-like text into
 * messages or the checkpoint). The pattern allows the ordinary Google
 * account local/domain characters; it is a dedicated email check, never a
 * broad truthiness test.
 */
export const GOOGLE_ACCOUNT_EMAIL_PATTERN =
  /^[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/;

/**
 * True when the value is a strict printable Google account email.
 *
 * The pattern alone would accept a trailing newline (JS `$` also matches
 * before a final line break), so the value must also round-trip `trim()`
 * and stay within a sane length. Whitespace, control characters, and
 * newlines anywhere in the value are refused.
 */
export function isValidGoogleAccountEmail(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 254 &&
    value === value.trim() &&
    GOOGLE_ACCOUNT_EMAIL_PATTERN.test(value)
  );
}

/** OAuth tokeninfo endpoint used to validate the user access token. */
export const TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo";

/** Exact command the user must run to re-login with Drive access. */
export const DRIVE_ACCESS_COMMAND = ["auth", "login", "--enable-gdrive-access", "--force"] as const;

/** Validated identity information for an OAuth access token. */
export interface TokenInfo {
  /** Email of the account the token belongs to (the future spreadsheet owner). */
  readonly email: string;
  /** Space-delimited list of granted OAuth scopes. */
  readonly scope: string;
}

/**
 * Validates an access token through the tokeninfo endpoint.
 *
 * Throws with a safe reason on HTTP or payload failure; the setup flow maps
 * any throw to `user_token_failed`. The token itself must never be included
 * in messages.
 */
export interface TokenValidator {
  validate(token: string): Promise<TokenInfo>;
}

/** Outcome of the pre-mutation human auth check. */
export type HumanAuthResult =
  | { readonly status: "ok"; readonly accessToken: string; readonly ownerEmail: string }
  | {
    readonly status: "error";
    readonly code:
    | typeof SETUP_ERROR_CODES.GCLOUD_DRIVE_ACCESS_REQUIRED
    | typeof SETUP_ERROR_CODES.USER_TOKEN_FAILED;
    readonly message: string;
  };

/**
 * Retrieves the active user token and verifies it grants Drive access.
 *
 * Runs `gcloud auth print-access-token`, validates the token through the
 * injected validator, and requires the Drive or Drive-file scope. Missing
 * scope fails with the exact `gcloud auth login --enable-gdrive-access
 * --force` command; retrieval or validation failures fail with
 * `user_token_failed`. The returned token is memory-only by contract.
 */
export async function checkHumanDriveAccess(
  runner: GcloudRunner,
  validateToken: TokenValidator,
): Promise<HumanAuthResult> {
  const tokenResult = await runner.run(["auth", "print-access-token"]);
  if (tokenResult.status !== "ok") {
    return {
      status: "error",
      code: SETUP_ERROR_CODES.USER_TOKEN_FAILED,
      message: describeTokenRetrievalFailure(tokenResult),
    };
  }
  const accessToken = tokenResult.stdout.trim();
  if (accessToken === "" || accessToken.includes("\n")) {
    return {
      status: "error",
      code: SETUP_ERROR_CODES.USER_TOKEN_FAILED,
      message: "gcloud auth print-access-token returned an empty or malformed token",
    };
  }

  let info: TokenInfo;
  try {
    info = await validateToken.validate(accessToken);
  } catch (error) {
    return {
      status: "error",
      code: SETUP_ERROR_CODES.USER_TOKEN_FAILED,
      message: `the gcloud access token could not be validated: ${safeReasonOf(error)}`,
    };
  }

  if (hasDriveScope(info.scope)) {
    // The owner identity must be a strict printable email BEFORE it can
    // reach the checkpoint, a summary, or any message: a malformed or
    // control-bearing email is a token validation failure and is never
    // echoed back.
    if (!isValidGoogleAccountEmail(info.email)) {
      return {
        status: "error",
        code: SETUP_ERROR_CODES.USER_TOKEN_FAILED,
        message: "the gcloud access token could not be validated: the account email is malformed",
      };
    }
    return { status: "ok", accessToken, ownerEmail: info.email };
  }
  return {
    status: "error",
    code: SETUP_ERROR_CODES.GCLOUD_DRIVE_ACCESS_REQUIRED,
    message:
      `the active gcloud account does not grant Drive access; run ` +
      `\`gcloud ${DRIVE_ACCESS_COMMAND.join(" ")}\` and try again`,
  };
}

/** True when the space-delimited scope list includes Drive or Drive-file. */
export function hasDriveScope(scope: string): boolean {
  const scopes = scope.split(" ").filter((part) => part !== "");
  return scopes.includes(DRIVE_SCOPE) || scopes.includes(DRIVE_FILE_SCOPE);
}

/**
 * Production token validator backed by the tokeninfo endpoint.
 *
 * POSTs the access token to `https://oauth2.googleapis.com/tokeninfo` and
 * promotes the validated email/scope. `fetchImpl` is injectable for tests;
 * it defaults to the global fetch (Node >= 18).
 */
export function createTokeninfoValidator(fetchImpl: typeof fetch = fetch): TokenValidator {
  return {
    async validate(token: string): Promise<TokenInfo> {
      const response = await fetchImpl(TOKENINFO_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `access_token=${encodeURIComponent(token)}`,
      });
      if (!response.ok) {
        throw safeError(`tokeninfo responded with HTTP ${response.status}`);
      }
      return extractTokenInfo(await response.json());
    },
  };
}

/**
 * Validates the raw tokeninfo payload and promotes it into `TokenInfo`.
 *
 * The response is untrusted remote data: `email` must be a strict
 * printable Google account email and `scope` a non-empty string. Throws on
 * malformed payloads; the token is never part of the error text and the
 * raw email is never echoed.
 */
export function extractTokenInfo(payload: unknown): TokenInfo {
  if (!isRecord(payload)) {
    throw safeError("tokeninfo returned a non-object payload");
  }
  const { email, scope } = payload;
  if (!isValidGoogleAccountEmail(email)) {
    throw safeError("tokeninfo response is missing or carries a malformed account email");
  }
  if (typeof scope !== "string" || scope === "") {
    throw safeError("tokeninfo response is missing the scope list");
  }
  return { email, scope };
}

/**
 * Describes a failed token retrieval with the exit status only.
 *
 * The gcloud token command's stdout/stderr can contain the access token or
 * other secrets, so raw stream content is never forwarded; the message is
 * status-only and generic.
 */
function describeTokenRetrievalFailure(result: GcloudRunResult): string {
  if (result.status === "not_found") {
    return "gcloud CLI not found on PATH";
  }
  if (result.status === "failed") {
    return `gcloud auth print-access-token exited with status ${result.code === null ? "unknown" : String(result.code)}`;
  }
  return "unexpected gcloud outcome";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
