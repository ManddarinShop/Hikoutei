/**
 * Type declarations for `scripts/ci/local-soak/errors.mjs`.
 */

/** Extracts the error name and optional raw code/status class for sanitization. */
export function describeError(error: unknown): {
  errorClass: string;
  code: string | undefined;
  statusClass: string | undefined;
};

/** Stable redacted tag for progress lines (never the raw message). */
export function stableErrorTag(error: unknown): string;

/**
 * True when a rejected direct human write carries EXACTLY the stable
 * `identity_shifted` evidence of the direct client's fail-closed identity
 * guard (real seam: `statusClass`; fake seam: `code`).
 */
export function isIdentityShiftedEvidence(reason: unknown): boolean;

/**
 * The truthful redacted scenario skip record for an identity-shifted
 * transient direct-write rejection (status skipped, failures 0, reason
 * `identity-shifted-transient`, stable reasonTag).
 */
export function identityShiftedTransientResult(error: unknown): {
  status: "skipped";
  expectedErrors: number;
  failures: number;
  reason: "identity-shifted-transient";
  reasonTag: string;
};
