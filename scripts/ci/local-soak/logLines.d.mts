/**
 * Type declarations for `scripts/ci/local-soak/logLines.mjs`.
 *
 * The JSONL validation mirror of the internal logger's serialization
 * contract, used by `artifacts.mjs` so collected logs can never contain
 * arbitrary pre-existing file content.
 */

/** Every field the internal logger serializes. */
export const LOGGED_FIELD_NAMES: readonly string[];

/** Emission levels the logger writes. */
export const LOGGED_LEVELS: readonly string[];

/** Stable dotted event names the logger may write. */
export const LOGGED_EVENT_NAMES: readonly string[];

/** Stable component tags the logger may write. */
export const LOGGED_COMPONENT_NAMES: readonly string[];

/** Stable error codes the logger may write. */
export const LOGGED_STABLE_CODES: readonly string[];

/** Stable error class names the logger may write. */
export const LOGGED_STABLE_CLASSES: readonly string[];

/** Result status vocabulary of `sanitizeCollectedLogLine`. */
export const LOG_LINE_VALIDATION: Readonly<{ readonly VALID: "valid"; readonly INVALID: "invalid" }>;

/** Validates one raw log line against the logger's serialization contract. */
export function sanitizeCollectedLogLine(
  rawLine: string,
): { readonly status: "valid"; readonly line: string } | { readonly status: "invalid"; readonly reason: string };
