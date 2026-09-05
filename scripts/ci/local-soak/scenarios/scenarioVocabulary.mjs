/**
 * Scenario vocabulary derived dynamically from the scenario registry.
 *
 * The redaction and resume-schema layers need the stable allowlist of
 * scenario ids, tags, and allowed phases to sanitize and validate scenario
 * records. Instead of hardcoding those lists (which would force every new
 * scenario PR to touch generic redaction/schema code), every value is
 * derived here from the registered scenario modules' `id`/`TAG`/
 * `allowedPhases` exports, plus the scheduler's fixed phase values.
 *
 * This module imports ONLY the registry and the scheduler's phase
 * vocabulary — never a scenario module and never from `redact.mjs`'s
 * scenario-typed code — so the generic redaction/schema layers stay
 * scenario-agnostic and there is no import cycle (scenario modules import
 * generic redaction helpers, not this module).
 */
import { SCENARIO_REGISTRY } from "./registry.mjs";
import { SCENARIO_PHASE_VALUES } from "./scheduler.mjs";
import { sanitizeErrorTag, sanitizeFailureKind, sanitizeReason, sanitizeTableName } from "../redact.mjs";

/** Stable scenario execution phases (the scheduler's fixed phase values). */
export const KNOWN_SCENARIO_PHASES = Object.freeze([...SCENARIO_PHASE_VALUES]);

/** Stable attack-scenario ids the soak may record (derived from registry). */
export const KNOWN_SCENARIO_IDS = Object.freeze(
  SCENARIO_REGISTRY.map((scenario) => scenario.id),
);

/** Stable redacted scenario parameter tags (derived from registry). */
export const KNOWN_SCENARIO_TAGS = Object.freeze(
  SCENARIO_REGISTRY.map((scenario) => scenario.TAG),
);

/**
 * The exact redacted tag each registered scenario id records (id -> TAG).
 *
 * A scenario record's `tag` must equal the tag its id's `TAG` produces, so
 * a forged record that pairs a known id with a foreign tag is rejected by
 * the resume schema.
 */
export const SCENARIO_ID_TAGS = Object.freeze(
  Object.fromEntries(SCENARIO_REGISTRY.map((scenario) => [scenario.id, scenario.TAG])),
);

/**
 * The allowed execution phases of each registered scenario id
 * (id -> allowedPhases).
 *
 * A scenario record's `phase` must be one its id's `allowedPhases` permits,
 * so a forged record that places a scenario in a phase it can never run in
 * is rejected by the resume schema.
 */
export const SCENARIO_ID_PHASES = Object.freeze(
  Object.fromEntries(
    SCENARIO_REGISTRY.map((scenario) => [scenario.id, [...scenario.allowedPhases]]),
  ),
);

/**
 * Status vocabulary allowed in a scenario record's `status` field. A
 * scenario status collapses to `unknown` when not on this fixed allowlist.
 */
const KNOWN_SCENARIO_STATUSES = Object.freeze([
  "ok",
  "skipped",
  "failed",
  "expected_error",
  "passed",
  "recovered",
  "in-flight",
  "completed",
]);

/**
 * Sanitizes ONE scenario record for a durable artifact.
 *
 * A scenario record carries only fixed-vocabulary strings (id, phase, tag,
 * status) plus non-negative counters (order, expectedErrors, failures) and
 * an optional redacted `targetTable` — the allowlisted soak table the
 * scenario plan targets, so a resume proof can bind the record to its
 * active subset without ever recording a raw entity id/value. The
 * id/phase/tag/status values pass their allowlists (id/tag/phase derived
 * from the registered scenario modules); anything unknown collapses to the
 * fixed safe `unknown` category. The optional `reason` passes the stable
 * reason vocabulary. No scenario plan detail (entity, field, id, jitter,
 * value, URL, credential) is ever part of the durable record.
 *
 * @param {unknown} value one scenario record.
 * @returns {object | undefined} a sanitized deep copy, or `undefined` when
 *   the input is not a scenario-shaped object.
 */
export function sanitizeScenarioRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value;
  const id = typeof record.id === "string" && KNOWN_SCENARIO_IDS.includes(record.id)
    ? record.id
    : "unknown";
  const phase = typeof record.phase === "string" && KNOWN_SCENARIO_PHASES.includes(record.phase)
    ? record.phase
    : "unknown";
  const tag = typeof record.tag === "string" && KNOWN_SCENARIO_TAGS.includes(record.tag)
    ? record.tag
    : "unknown";
  const status = typeof record.status === "string" && KNOWN_SCENARIO_STATUSES.includes(record.status)
    ? record.status
    : "unknown";
  const result = {
    id,
    phase,
    order: Number.isInteger(record.order) && record.order >= 0 ? record.order : 0,
    tag,
    status,
    expectedErrors: Number.isInteger(record.expectedErrors) && record.expectedErrors >= 0
      ? record.expectedErrors
      : 0,
    failures: Number.isInteger(record.failures) && record.failures >= 0
      ? record.failures
      : 0,
    // Dedicated cleanup-failure counter (guaranteed-cleanup accounting),
    // separate from the general failure counter so a cleanup failure is
    // never masked by the original failure it accompanies.
    cleanupFailures: Number.isInteger(record.cleanupFailures) && record.cleanupFailures >= 0
      ? record.cleanupFailures
      : 0,
  };
  // HIGH target-table proof: the redacted allowlisted soak table the plan
  // targets (never a raw entity id/value). An unknown/absent target drops
  // the field, so legacy/test records without it stay compatible while new
  // scenario records bind to their active subset.
  const targetTable = sanitizeTableName(record.targetTable);
  if (targetTable !== "unknown") {
    result.targetTable = targetTable;
  }
  if (record.reason !== undefined) {
    result.reason = sanitizeReason(record.reason);
  }
  // Diagnostic-only stable error tag of a swallowed scenario throw
  // (`Class` or `Class (code)`); unknown-shaped tags collapse to the fixed
  // `unknown` category. Never the raw message, stack, or any value.
  if (record.reasonTag !== undefined) {
    result.reasonTag = sanitizeErrorTag(record.reasonTag);
  }
  // Canonical failureKinds contract (shared with the resume schema): a
  // non-empty, sorted, deduplicated array of allowlisted kinds where every
  // unknown kind has collapsed to the single fixed `unknown` category. The
  // resume schema accepts exactly this shape — `unknown` included, bare
  // unknown raw kinds rejected, duplicates/unsorted rejected — so sanitizer
  // output always validates. An absent/empty list, or one that normalizes
  // to empty (only null/non-string/empty entries), drops the field so
  // legacy records stay compatible and `[]` (which the schema rejects) is
  // never emitted — the same omit-when-empty policy as the redactor.
  if (Array.isArray(record.failureKinds) && record.failureKinds.length > 0) {
    const kinds = [...new Set(
      record.failureKinds
        .filter((kind) => typeof kind === "string" && kind.length > 0)
        .map(sanitizeFailureKind),
    )].sort();
    if (kinds.length > 0) {
      result.failureKinds = kinds;
    }
  }
  return result;
}
