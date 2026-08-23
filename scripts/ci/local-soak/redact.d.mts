/**
 * Type declarations for `scripts/ci/local-soak/redact.mjs`.
 *
 * Hand-written ESM helper consumed by the soak runner, artifact writer, and
 * Vitest; these declarations give the TypeScript test suite full type
 * checking without adding `scripts/**` to a `tsconfig` `include` set.
 */

/** Stable error codes the workload treats as expected validation results. */
export const EXPECTED_ERROR_CODES: Readonly<Record<string, string>>;

/** Explicit allowlist of every stable error code the soak records. */
export const KNOWN_STABLE_CODES: readonly string[];

/** Explicit allowlist of every stable error class the soak records. */
export const KNOWN_STABLE_CLASSES: readonly string[];

/** Exact stale-write/CAS/conflict evidence codes (see KNOWN_STABLE_CODES). */
export const CAS_STALE_CONFLICT_CODES: readonly string[];

/** True when a rejected error carries exact stale-write/CAS/conflict evidence. */
export function isStaleConflictEvidence(error: unknown): boolean;

/** Stable redacted failure categories recorded in artifacts. */
export const FAILURE_REASON_CODES: Readonly<Record<string, string>>;

/** Every stable reason value recordable in operation/probe/abort records. */
export const KNOWN_REASON_CODES: readonly string[];

/** Accepted `--tables` vocabulary. */
export const KNOWN_TABLE_NAMES: readonly string[];

/** Accepted entity-name vocabulary (operation-record `table` field). */
export const KNOWN_ENTITY_NAMES: readonly string[];

/** Maps a candidate error code to the artifact-safe value (`unknown`). */
export function sanitizeStableCode(candidate: unknown): string;

/** Maps a candidate error class to the artifact-safe value (`unknown`). */
export function sanitizeErrorClass(candidate: unknown): string;

/** Maps a candidate remote status class to the artifact-safe value. */
export function sanitizeStatusClass(candidate: unknown): string;

/** Maps a candidate reason category to the artifact-safe value. */
export function sanitizeReason(candidate: unknown): string;

/** Maps a candidate table/entity name to the artifact-safe value. */
export function sanitizeTableName(candidate: unknown): string;

/** Keeps only identifier-shaped keys with finite numeric values. */
export function sanitizeCounts(value: unknown): Record<string, number> | undefined;

/** Recursively sanitizes every redaction-sensitive field of one record. */
export function sanitizeRecordFields(value: unknown): unknown;
