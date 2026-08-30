import { z } from "zod";

const DEFAULT_MAX_ZOD_ISSUES = 3;

/**
 * Formats a bounded, input-free summary for a validated boundary failure.
 *
 * Boundary callers map this summary into their own stable domain error. The
 * raw invalid value is intentionally never included so credentials, payloads,
 * and provider responses cannot leak through diagnostics.
 */
export function formatZodBoundaryIssues(
  error: z.ZodError,
  maxIssues = DEFAULT_MAX_ZOD_ISSUES,
): string {
  const limit = Number.isSafeInteger(maxIssues) && maxIssues > 0
    ? maxIssues
    : DEFAULT_MAX_ZOD_ISSUES;
  const issues = error.issues.slice(0, limit).map((issue) => {
    const path = issue.path.length === 0
      ? "value"
      : issue.path.map((part) => String(part)).join(".");
    return `${path}: ${issue.message}`;
  });
  const suffix = error.issues.length > issues.length
    ? `; ${error.issues.length - issues.length} more issue(s)`
    : "";
  return `${issues.join("; ")}${suffix}`;
}
