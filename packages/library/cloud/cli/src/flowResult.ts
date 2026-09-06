/**
 * Shared result/error helpers for the `hikoutei setup` flow modules.
 *
 * The setup flow is split across several CLI modules that call each other
 * (`setupFlow` orchestrates, `keyProvision` runs the key write-ahead phase,
 * `humanAuth` and `sheetsFactory` own their phases). The tiny helpers here —
 * the error result shape, the sanitized gcloud failure description, and the
 * executed/planned outcome text — are shared by those modules and live in
 * their own cycle-free module so no runtime import cycle exists between
 * orchestration and provisioning code.
 *
 * Secret discipline: raw gcloud stdout/stderr can carry tokens, key
 * material, or other secrets, so stream content is never forwarded by
 * `describeGcloudFailure`; messages are status-only.
 */

import type { GcloudRunResult } from "./gcloudRunner.js";
import type { SetupErrorCode } from "./errors.js";

/** One planned or executed step of the setup flow. */
export type PlannedCommand =
  | { readonly kind: "gcloud"; readonly command: readonly string[]; readonly outcome: string }
  | { readonly kind: "api"; readonly label: string; readonly outcome: string }
  | { readonly kind: "file"; readonly label: string; readonly outcome: string };

/** The error branch of a setup result, for helpers that only fail. */
export type SetupErrorResult = {
  readonly status: "error";
  readonly code: SetupErrorCode;
  readonly message: string;
};

/**
 * Builds an error result for the setup flow.
 */
export function errorResult(code: SetupErrorCode, message: string): SetupErrorResult {
  return { status: "error", code, message };
}

/**
 * Describes a failed gcloud invocation with phase context and exit status
 * only.
 *
 * Raw stdout/stderr can carry tokens, key material, or other secrets, so
 * stream content is never forwarded; classification (such as the
 * already-exists or not-found markers) stays internal to the flow.
 */
export function describeGcloudFailure(result: GcloudRunResult): string {
  if (result.status === "not_found") {
    return "gcloud CLI not found on PATH";
  }
  if (result.status === "failed") {
    return `gcloud exited with status ${result.code === null ? "unknown" : String(result.code)}`;
  }
  return "unexpected gcloud outcome";
}

/**
 * Outcome text of a gcloud invocation for the executed/planned list.
 */
export function outcomeOf(result: GcloudRunResult, okOutcome: string): string {
  if (result.status === "ok") {
    return okOutcome;
  }
  return `failed: ${describeGcloudFailure(result)}`;
}
