/**
 * Sanitized failure reasons for `hikoutei setup` SDK/HTTP errors.
 *
 * Errors thrown by the Google SDKs (GaxiosError) can embed request URLs and
 * config objects, and arbitrary thrown messages can carry tokens or key
 * material, so setup diagnostics never forward raw error objects or full
 * messages. These helpers reduce an unknown error to a safe, short reason:
 * the HTTP status when one exists, otherwise the message of an error that
 * was explicitly constructed with `safeError` (the only whitelisted source
 * of human-readable reasons), or a generic fallback for everything else.
 * Tokens, key material, and request URLs never appear.
 */

/** Marker property that whitelists an explicitly constructed safe message. */
const SAFE_REASON_MARKER: unique symbol = Symbol("hikoutei.setup-safe-reason");

/** HTTP status carried by an SDK error, when one exists. */
export function httpStatusOf(error: unknown): number | undefined {
  if (!isRecord(error)) {
    return undefined;
  }
  const response = error.response;
  if (isRecord(response) && typeof response.status === "number") {
    return response.status;
  }
  if (typeof error.code === "number") {
    return error.code;
  }
  return undefined;
}

/**
 * Constructs an error whose message is safe to surface to the user.
 *
 * Use this for every validation/guard failure the setup flow builds itself
 * (malformed payloads, identity mismatches, protocol violations). The
 * message must never include tokens, key material, or raw remote output.
 */
export function safeError(message: string): Error {
  const error = new Error(message);
  (error as { [SAFE_REASON_MARKER]?: true })[SAFE_REASON_MARKER] = true;
  return error;
}

/**
 * Reduces an unknown error to a safe diagnostic reason.
 *
 * Prefers a bare `HTTP <status>` (the most machine-friendly and leak-free
 * form). Only errors constructed with `safeError` may contribute their
 * message (first non-empty line, truncated); any other error — including
 * arbitrary SDK, runner, or network messages — becomes the generic
 * `unknown failure`. Never includes tokens, key material, or raw streams.
 */
export function safeReasonOf(error: unknown): string {
  const status = httpStatusOf(error);
  if (status !== undefined) {
    return `HTTP ${status}`;
  }
  if (error instanceof Error && isSafeReasonError(error)) {
    const firstLine = firstNonEmptyLine(error.message);
    if (firstLine !== undefined) {
      return firstLine.slice(0, 160);
    }
  }
  return "unknown failure";
}

function isSafeReasonError(error: Error): boolean {
  return (error as { [SAFE_REASON_MARKER]?: unknown })[SAFE_REASON_MARKER] === true;
}

function firstNonEmptyLine(text: string): string | undefined {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed !== "") {
      return trimmed;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
