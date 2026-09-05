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

/**
 * Resolves which human fields were ingested as recorded conflicts: the
 * subset of `fields` whose `field` has an unresolved conflict row with a
 * decoded `user_value` string-equal to its `expectedValue`. Reads only
 * `field_name`/`user_value`/`status` (via `context.dbName` read-only, or
 * the `context.queryConflictRows()` test seam); raw values are compared,
 * never recorded.
 */
export function conflictRecordedForFields(
  context: object,
  fields: readonly { field: string; expectedValue: unknown }[],
): Promise<Set<string>>;

/**
 * Suffix `systemWinsResolveValue` appends to the current canonical string
 * value to force a genuine same-field canonical advance (a same-value
 * re-affirm cannot trigger the implicit system-wins path).
 */
export const SYSTEM_WINS_RESOLVE_SUFFIX: string;

/**
 * Deterministic system-wins advance for one current canonical value:
 * always differs from `current` while staying type-valid for the field.
 */
export function systemWinsResolveValue(current: unknown): unknown;

/**
 * Resolves OPEN/NEEDS_REBASE conflicts on one dedicated race row via the
 * public EntityManager (system-wins advance + bounded clear wait).
 * True when the caller may delete; false when the wait expired (keep row).
 */
export function resolveRecordedConflicts(
  context: object,
  options: {
    token: unknown;
    targetId: string;
    fields: readonly { field: string; expectedValue: unknown }[];
    critical?: (action: () => Promise<void>) => Promise<void>;
  },
): Promise<boolean>;
