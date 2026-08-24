/**
 * Resume JSONL HISTORY record/section schema validation for the soak
 * runner: strict JSONL reading plus the exact per-record shape checks
 * (cycle/operation/resource records; probe/convergence/reopen/abort
 * sections) against the redaction vocabularies. Split from the resume
 * facade so each module stays review-sized; `resumeHistory.mjs`
 * re-exports the shared surface and the cross-file integrity proof
 * lives in `resumeHistoryProof.mjs`. No cycle with execute or probe.
 */
import { readFile } from "node:fs/promises";
import { OPERATION_KINDS } from "./operations.mjs";
import {
  KNOWN_ENTITY_NAMES,
  KNOWN_REASON_CODES,
  KNOWN_STABLE_CLASSES,
  KNOWN_STABLE_CODES,
  KNOWN_TABLE_NAMES,
  isKnownStatusClass,
} from "./redact.mjs";
import {
  KNOWN_SCENARIO_IDS,
  KNOWN_SCENARIO_PHASES,
  KNOWN_SCENARIO_TAGS,
  SCENARIO_ID_PHASES,
  SCENARIO_ID_TAGS,
} from "./scenarios/scenarioVocabulary.mjs";

/**
 * Default scenario vocabulary derived from the CURRENTLY registered scenario
 * modules (`scenarioVocabulary.mjs`). Used by the resume schema when no
 * vocabulary is supplied. The scenario PRs register modules; the schema
 * validation helpers also accept an explicit vocabulary so tests can
 * exercise acceptance/rejection against a stub-derived vocabulary without
 * changing the registered registry.
 */
const DEFAULT_SCENARIO_VOCAB = {
  KNOWN_SCENARIO_IDS,
  KNOWN_SCENARIO_PHASES,
  KNOWN_SCENARIO_TAGS,
  SCENARIO_ID_TAGS,
  SCENARIO_ID_PHASES,
};

/** ISO-8601 millisecond timestamp shape written by every artifact builder. */
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** True for a non-negative integer (record counter contract). */
function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

/** True when the value is a known soak table or entity name. */
function isKnownTableOrEntityName(value) {
  return typeof value === "string" &&
    (KNOWN_TABLE_NAMES.includes(value) || KNOWN_ENTITY_NAMES.includes(value));
}

/** True for a non-empty finite number (resource sample contract). */
function isFiniteNonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Reads one JSONL artifact STRICTLY: every non-empty line must parse as a
 * JSON object, otherwise resume fails with a stable reason. A corrupt or
 * partial line means the completion proof cannot be trusted, so it is
 * never skipped — it is a safe pre-mutation failure.
 *
 * @returns {Promise<object[]>} parsed records in file order.
 */
async function readStrictJsonlRecords(filePath, fileName, fail) {
  const raw = await readFile(filePath, "utf8").catch(() => "");
  const records = [];
  const lines = raw.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "") continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      fail(`${fileName} contains a corrupt or partial line ${index + 1}; the recovery history cannot be trusted`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      fail(`${fileName} contains a non-object record on line ${index + 1}`);
    }
    records.push(parsed);
  }
  return records;
}

/** Validates one probe section of a cycle record (exact schema). */
function validateProbeShape(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "probe must be an object" };
  }
  const known = new Set(["status", "reason", "table", "statusClass"]);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) return { ok: false, reason: `unknown probe field "${key}"` };
  }
  if (value.status !== "ok" && value.status !== "skipped" && value.status !== "failed") {
    return { ok: false, reason: "probe.status must be ok, skipped, or failed" };
  }
  if (value.reason !== undefined && !PROBE_REASON_CODES.has(value.reason)) {
    return { ok: false, reason: "probe.reason is not a reason the runner can record" };
  }
  if (value.table !== undefined && !isKnownTableOrEntityName(value.table)) {
    return { ok: false, reason: "probe.table is not a known table/entity name" };
  }
  if (value.statusClass !== undefined && !isKnownStatusClass(value.statusClass)) {
    return { ok: false, reason: "probe.statusClass is not a known status class" };
  }
  return { ok: true };
}

/**
 * Validates one convergence section of a cycle record (exact schema).
 *
 * The section is bound to the record's OWN cycle: an ok check carries
 * exactly `{ status: "ok", cycle }` with `cycle` equal to the record's
 * cycle, and a failed check carries only the count fields (never a cycle
 * field). Anything else is a forged or tampered section.
 */
function validateConvergenceShape(value, recordCycle) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "convergence must be an object" };
  }
  const known = new Set([
    "status", "cycle", "missingRows", "duplicateRows", "extraRows",
    "projectionMismatch",
  ]);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) {
      return { ok: false, reason: `unknown convergence field "${key}"` };
    }
  }
  if (value.status !== "ok" && value.status !== "failed") {
    return { ok: false, reason: "convergence.status must be ok or failed" };
  }
  if (value.status === "ok") {
    if (!Number.isInteger(value.cycle) || value.cycle < 1) {
      return { ok: false, reason: "convergence.cycle must be a positive integer for an ok check" };
    }
    if (value.cycle !== recordCycle) {
      return { ok: false, reason: `convergence.cycle ${value.cycle} does not match the record's cycle ${recordCycle}` };
    }
    // An ok check records ONLY status and cycle; a count field on an ok
    // check is a forged section.
    for (const key of Object.keys(value)) {
      if (key !== "status" && key !== "cycle") {
        return { ok: false, reason: `convergence.${key} is not a field of an ok convergence section` };
      }
    }
    return { ok: true };
  }
  // A failed check records ONLY the redacted counts — the runner never
  // writes a cycle field on failure, so carrying one is tampering.
  if (value.cycle !== undefined) {
    return { ok: false, reason: "convergence.cycle is not a field of a failed convergence section" };
  }
  for (const key of ["missingRows", "duplicateRows"]) {
    if (!isNonNegativeInteger(value[key])) {
      return { ok: false, reason: `convergence.${key} must be a non-negative integer` };
    }
  }
  if (value.extraRows !== undefined && !isNonNegativeInteger(value.extraRows)) {
    return { ok: false, reason: "convergence.extraRows must be a non-negative integer" };
  }
  if (value.projectionMismatch !== undefined && typeof value.projectionMismatch !== "boolean") {
    return { ok: false, reason: "convergence.projectionMismatch must be a boolean" };
  }
  return { ok: true };
}

/** Validates one reopen section of a cycle record (exact schema). */
function validateReopenShape(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "reopen must be an object" };
  }
  if (value.status !== "ok" && value.status !== "failed") {
    return { ok: false, reason: "reopen.status must be ok or failed" };
  }
  // Luna: the full-scan evidence field is REQUIRED — the runner always
  // records it, so a reopen section without it is not a record the runner
  // can produce (a missing scan field would let a forged ok status pass
  // with no identity/content evidence to bind against).
  if (value.scan !== "ok" && value.scan !== "failed") {
    return { ok: false, reason: "reopen.scan must be ok or failed" };
  }
  for (const [key, entryValue] of Object.entries(value)) {
    if (key === "status" || key === "scan") continue;
    if (!isKnownTableOrEntityName(key) || !isNonNegativeInteger(entryValue)) {
      return { ok: false, reason: "reopen counts must use known table names with non-negative integer counts" };
    }
  }
  return { ok: true };
}

/**
 * Validates one scenario section entry of a cycle record (exact schema).
 *
 * A scenario record carries only the fixed id/phase/order/tag/status plus
 * non-negative expected/failure counters, an optional known reason, and an
 * optional redacted `targetTable` (the allowlisted soak table the plan
 * targets, so a resume proof can bind the record to its active subset
 * without recording a raw entity id/value). The runner never writes plan
 * targets, entity values, or ids, so a scenario entry carrying any other
 * field is a forged/tampered section. The id/tag pair and the id/phase
 * combination must be ones the registered scenarios can actually produce,
 * and the status must be consistent with the counters (skipped carries no
 * counters, failed carries at least one failure, ok carries no failures).
 */
function validateScenarioShape(value, vocab = DEFAULT_SCENARIO_VOCAB) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "scenario must be an object" };
  }
  const known = new Set([
    "id", "phase", "order", "tag", "status", "expectedErrors", "failures",
    "cleanupFailures", "reason", "targetTable",
  ]);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) return { ok: false, reason: `unknown scenario field "${key}"` };
  }
  if (typeof value.id !== "string" || !vocab.KNOWN_SCENARIO_IDS.includes(value.id)) {
    return { ok: false, reason: "scenario.id is not a known scenario id" };
  }
  if (typeof value.phase !== "string" || !vocab.KNOWN_SCENARIO_PHASES.includes(value.phase)) {
    return { ok: false, reason: "scenario.phase is not a known scenario phase" };
  }
  if (typeof value.tag !== "string" || !vocab.KNOWN_SCENARIO_TAGS.includes(value.tag)) {
    return { ok: false, reason: "scenario.tag is not a known scenario tag" };
  }
  // The id/tag pair must be one the registered scenario can produce: a
  // known id paired with a foreign tag is a forged record.
  if (vocab.SCENARIO_ID_TAGS[value.id] !== value.tag) {
    return { ok: false, reason: "scenario.tag does not match the tag its id records" };
  }
  // The id/phase combination must be one the registered scenario allows:
  // a scenario placed in a phase it can never run in is a forged record.
  if (!vocab.SCENARIO_ID_PHASES[value.id].includes(value.phase)) {
    return { ok: false, reason: "scenario.phase is not an allowed phase for its id" };
  }
  if (value.status !== "ok" && value.status !== "skipped" && value.status !== "failed") {
    return { ok: false, reason: "scenario.status must be ok, skipped, or failed" };
  }
  for (const key of ["order", "expectedErrors", "failures", "cleanupFailures"]) {
    if (!isNonNegativeInteger(value[key])) {
      return { ok: false, reason: `scenario.${key} must be a non-negative integer` };
    }
  }
  // Cleanup failures are a subset of the failure counter (the scheduler sums
  // them into `failures`), so a record whose cleanup counter exceeds its
  // failures is forged.
  if (value.cleanupFailures > value.failures) {
    return { ok: false, reason: "scenario.cleanupFailures cannot exceed scenario.failures" };
  }
  // Status/counter consistency: a skipped scenario ran nothing (zero
  // counters), a failed scenario must carry at least one failure, and an ok
  // scenario must carry no failures (expected errors are allowed on ok).
  if (value.status === "skipped" && (value.expectedErrors !== 0 || value.failures !== 0)) {
    return { ok: false, reason: "a skipped scenario must carry zero expected/failure counters" };
  }
  if (value.status === "failed" && value.failures === 0) {
    return { ok: false, reason: "a failed scenario must carry at least one failure" };
  }
  if (value.status === "ok" && value.failures !== 0) {
    return { ok: false, reason: "an ok scenario must carry zero failures" };
  }
  if (value.reason !== undefined && !KNOWN_REASON_CODES.includes(value.reason)) {
    return { ok: false, reason: "scenario.reason is not a known reason category" };
  }
  // HIGH target-table proof: every NEW scenario entry MUST carry a known
  // allowlisted soak table (the plan's active-subset target). A missing or
  // unknown targetTable is a forged/tampered entry — backward compatibility
  // applies ONLY when the ENTIRE scenarios section is absent (legacy cycle),
  // never when entries exist without a target-table proof.
  if (!isKnownTableOrEntityName(value.targetTable)) {
    return { ok: false, reason: "scenario.targetTable is missing or not a known table/entity name" };
  }
  return { ok: true };
}

/**
 * Validates the dedicated scenario totals section of a cycle record.
 *
 * The totals are non-negative integers that must equal the sum of the
 * per-scenario records' counters, so a forged totals section that disagrees
 * with the recorded scenario section is rejected.
 *
 * @param {object} value the `scenarioTotals` section.
 * @param {object[]} scenarios the validated scenario records.
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function validateScenarioTotalsShape(value, scenarios) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "scenarioTotals must be an object" };
  }
  const known = new Set(["expectedErrors", "failures"]);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) return { ok: false, reason: `unknown scenarioTotals field "${key}"` };
  }
  for (const key of ["expectedErrors", "failures"]) {
    if (!isNonNegativeInteger(value[key])) {
      return { ok: false, reason: `scenarioTotals.${key} must be a non-negative integer` };
    }
  }
  const expectedErrors = scenarios.reduce((sum, entry) => sum + entry.expectedErrors, 0);
  const failures = scenarios.reduce((sum, entry) => sum + entry.failures, 0);
  if (value.expectedErrors !== expectedErrors) {
    return { ok: false, reason: "scenarioTotals.expectedErrors does not match the scenario records" };
  }
  if (value.failures !== failures) {
    return { ok: false, reason: "scenarioTotals.failures does not match the scenario records" };
  }
  return { ok: true };
}

/** Validates one abort section of a cycle record (exact schema). */
function validateAbortShape(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "abort must be an object" };
  }
  const known = new Set(["reason", "errorClass", "code", "statusClass"]);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) return { ok: false, reason: `unknown abort field "${key}"` };
  }
  if (!KNOWN_REASON_CODES.includes(value.reason)) {
    return { ok: false, reason: "abort.reason is not a known reason category" };
  }
  if (!KNOWN_STABLE_CLASSES_HAS(value.errorClass)) {
    return { ok: false, reason: "abort.errorClass is not a known error class" };
  }
  if (value.code !== undefined && !KNOWN_STABLE_CODES_HAS(value.code)) {
    return { ok: false, reason: "abort.code is not a known stable code" };
  }
  if (value.statusClass !== undefined && !isKnownStatusClass(value.statusClass)) {
    return { ok: false, reason: "abort.statusClass is not a known status class" };
  }
  return { ok: true };
}

/** True when the class name is on the stable allowlist (or the fixed redaction category). */
function KNOWN_STABLE_CLASSES_HAS(candidate) {
  // `unknown` is the redaction vocabulary's fixed category for unparseable
  // errors (a primitive or undefined rejection), so an abort whose reason
  // cannot be classified is still a record the runner can produce.
  return (typeof candidate === "string" && KNOWN_STABLE_CLASSES.includes(candidate)) ||
    candidate === "unknown";
}

/** True when the code is on the stable allowlist (or the fixed redaction category). */
function KNOWN_STABLE_CODES_HAS(candidate) {
  // `sanitizeStableCode` collapses any non-allowlisted code to the fixed
  // `unknown` category, so an abort/operation that records that redacted
  // value is a record the runner can produce; arbitrary raw codes are still
  // rejected because they never reach an artifact unredacted.
  return (typeof candidate === "string" && KNOWN_STABLE_CODES.includes(candidate)) ||
    candidate === "unknown";
}

/** Probe failure reasons a live run can record after artifact redaction. */
const LIVE_PROBE_FAILURE_REASONS = Object.freeze([
  "human-edit-not-accepted",
  "probe-error",
  // Any DirectSheetsError status class collapses to the fixed redaction
  // category at the artifact boundary, so `unknown` is a recorded value.
  "unknown",
]);

/** Every reason the runner can write into a probe section (both modes). */
const PROBE_REASON_CODES = new Set([
  "local-mode",
  "no-string-field",
  ...LIVE_PROBE_FAILURE_REASONS,
]);

/**
 * Validates ONE cycle record against the exact schema the runner writes.
 *
 * Known fields only, ISO timestamp, integer counters with the invariant
 * `expectedErrors + failures <= operations`, allowlisted vocabularies for
 * every string field, and exact nested section schemas. Anything else is
 * a malformed record — never trust it as completion proof.
 *
 * @param {object} record parsed cycle record.
 * @param {object} [vocab] scenario vocabulary derived from a registered
 *   scenario set (defaults to the currently registered registry's derived
 *   vocabulary).
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function validateCycleRecordShape(record, vocab = DEFAULT_SCENARIO_VOCAB) {
  const known = new Set([
    "ts", "cycle", "durationMs", "tablesTouched", "operations",
    "expectedErrors", "failures", "retries", "probe", "convergence",
    "reopen", "abort", "scenarios", "scenarioTotals",
  ]);
  for (const key of Object.keys(record)) {
    if (!known.has(key)) {
      return { ok: false, reason: `unknown cycle-record field "${key}"` };
    }
  }
  if (typeof record.ts !== "string" || !ISO_TIMESTAMP_PATTERN.test(record.ts)) {
    return { ok: false, reason: "ts must be an ISO-8601 millisecond timestamp" };
  }
  if (!Number.isInteger(record.cycle) || record.cycle < 1) {
    return { ok: false, reason: "cycle must be a positive integer" };
  }
  if (!isNonNegativeInteger(record.durationMs)) {
    return { ok: false, reason: "durationMs must be a non-negative integer" };
  }
  if (!Array.isArray(record.tablesTouched) ||
      !record.tablesTouched.every(isKnownTableOrEntityName)) {
    return { ok: false, reason: "tablesTouched must list known table/entity names" };
  }
  for (const key of ["operations", "expectedErrors", "failures", "retries"]) {
    if (!isNonNegativeInteger(record[key])) {
      return { ok: false, reason: `${key} must be a non-negative integer` };
    }
  }
  if (record.expectedErrors + record.failures > record.operations) {
    return { ok: false, reason: "expectedErrors + failures cannot exceed operations" };
  }
  if (record.probe !== undefined) {
    const shape = validateProbeShape(record.probe);
    if (!shape.ok) return shape;
  }
  if (record.convergence !== undefined) {
    const shape = validateConvergenceShape(record.convergence, record.cycle);
    if (!shape.ok) return shape;
  }
  if (record.reopen !== undefined) {
    const shape = validateReopenShape(record.reopen);
    if (!shape.ok) return shape;
  }
  if (record.abort !== undefined) {
    const shape = validateAbortShape(record.abort);
    if (!shape.ok) return shape;
  }
  if (record.scenarios !== undefined) {
    if (!Array.isArray(record.scenarios) || record.scenarios.length === 0) {
      return { ok: false, reason: "scenarios must be a non-empty array" };
    }
    // The scheduler composes 1-3 scenarios per cycle; anything else is a
    // forged or tampered section.
    if (record.scenarios.length < 1 || record.scenarios.length > 3) {
      return { ok: false, reason: "scenarios must contain between 1 and 3 entries" };
    }
    const ids = new Set();
    // An abort cycle may carry only the scenarios that completed before the
    // abort, so their deterministic orders can be SPARSE (a later-phase
    // scenario the abort never reached leaves a gap). Completed cycles must
    // still be fully contiguous. For abort cycles only strictly increasing
    // (and unique) orders are required — the array is written sorted by
    // order — so a forged reordering is still rejected.
    const isAbort = record.abort !== undefined;
    for (let index = 0; index < record.scenarios.length; index += 1) {
      const entry = record.scenarios[index];
      const shape = validateScenarioShape(entry, vocab);
      if (!shape.ok) return shape;
      if (isAbort) {
        // Abort orders must be strictly increasing AND scheduler-valid. The
        // scheduler composes 1-3 scenarios per cycle with orders 0..count-1,
        // so an abort order outside 0..2 (e.g. 999) is forged or tampered
        // even though an abort cycle may carry a sparse (non-contiguous)
        // subset of a 1-3 scenario batch.
        if (entry.order > 2) {
          return { ok: false, reason: `abort scenario order ${entry.order} is outside the scheduler's 0..2 range` };
        }
        // The array position itself must be sorted by deterministic order: a
        // reordered abort array is forged even when the orders are unique.
        if (index > 0 && entry.order <= record.scenarios[index - 1].order) {
          return { ok: false, reason: "abort scenario orders must be strictly increasing" };
        }
      } else if (entry.order !== index) {
        // A reordered array (entry.order !== its index) is forged even
        // when the orders happen to be contiguous.
        return { ok: false, reason: `scenario order must equal its array index (entry ${index} has order ${entry.order})` };
      }
      if (ids.has(entry.id)) {
        return { ok: false, reason: "scenarios must not repeat a scenario id within a cycle" };
      }
      ids.add(entry.id);
    }
    // A cycle that records scenarios must also record their dedicated
    // totals, and the totals must equal the sum of the records.
    if (record.scenarioTotals === undefined) {
      return { ok: false, reason: "a cycle with scenarios must record scenarioTotals" };
    }
    const totals = validateScenarioTotalsShape(record.scenarioTotals, record.scenarios);
    if (!totals.ok) return totals;
  } else if (record.scenarioTotals !== undefined) {
    // A cycle that records scenarioTotals WITHOUT any scenario records is
    // validated through the SAME exact object validator (with an empty
    // scenario list), so null/unknown keys and malformed counters are
    // rejected cleanly without throwing. With no scenario records the only
    // valid totals are exactly zero (the runner's abort/legacy cycle shape);
    // a nonzero total without a scenario section is tampered history.
    const totals = validateScenarioTotalsShape(record.scenarioTotals, []);
    if (!totals.ok) return totals;
  }
  return { ok: true };
}

/** Validates ONE operation record against the exact schema the runner writes. */
function validateOperationRecordShape(record) {
  const known = new Set([
    "ts", "cycle", "actor", "index", "kind", "table", "status", "code",
    "reason", "counts", "durationMs",
  ]);
  for (const key of Object.keys(record)) {
    if (!known.has(key)) {
      return { ok: false, reason: `unknown operation-record field "${key}"` };
    }
  }
  if (typeof record.ts !== "string" || !ISO_TIMESTAMP_PATTERN.test(record.ts)) {
    return { ok: false, reason: "ts must be an ISO-8601 millisecond timestamp" };
  }
  if (!Number.isInteger(record.cycle) || record.cycle < 1) {
    return { ok: false, reason: "cycle must be a positive integer" };
  }
  if (!isNonNegativeInteger(record.actor) || !isNonNegativeInteger(record.index) ||
      !isNonNegativeInteger(record.durationMs)) {
    return { ok: false, reason: "actor, index, and durationMs must be non-negative integers" };
  }
  if (!OPERATION_KINDS.includes(record.kind)) {
    return { ok: false, reason: "kind is not a known operation kind" };
  }
  if (!isKnownTableOrEntityName(record.table)) {
    return { ok: false, reason: "table is not a known table/entity name" };
  }
  if (record.status !== "ok" && record.status !== "expected_error" &&
      record.status !== "failed") {
    return { ok: false, reason: "status must be ok, expected_error, or failed" };
  }
  if (record.code !== undefined && !KNOWN_STABLE_CODES_HAS(record.code)) {
    return { ok: false, reason: "code is not a known stable code" };
  }
  if (record.reason !== undefined && !KNOWN_REASON_CODES.includes(record.reason)) {
    return { ok: false, reason: "reason is not a known reason category" };
  }
  if (record.counts !== undefined) {
    if (record.counts === null || typeof record.counts !== "object" ||
        Array.isArray(record.counts)) {
      return { ok: false, reason: "counts must be an object" };
    }
    for (const [key, entryValue] of Object.entries(record.counts)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key) ||
          typeof entryValue !== "number" || !Number.isFinite(entryValue)) {
        return { ok: false, reason: "counts must map identifier keys to finite numbers" };
      }
    }
  }
  return { ok: true };
}

/** Validates ONE resource record against the exact schema the runner writes. */
function validateResourceRecordShape(record) {
  const known = new Set([
    "ts", "cycle", "rssKb", "heapUsedKb", "externalKb", "dbBytes", "uptimeMs",
  ]);
  for (const key of Object.keys(record)) {
    if (!known.has(key)) {
      return { ok: false, reason: `unknown resource-record field "${key}"` };
    }
  }
  if (typeof record.ts !== "string" || !ISO_TIMESTAMP_PATTERN.test(record.ts)) {
    return { ok: false, reason: "ts must be an ISO-8601 millisecond timestamp" };
  }
  if (!Number.isInteger(record.cycle) || record.cycle < 1) {
    return { ok: false, reason: "cycle must be a positive integer" };
  }
  for (const key of ["rssKb", "heapUsedKb", "externalKb", "dbBytes", "uptimeMs"]) {
    if (!isFiniteNonNegativeNumber(record[key])) {
      return { ok: false, reason: `${key} must be a finite non-negative number` };
    }
  }
  return { ok: true };
}

// Exports consumed by the cross-file integrity proof
// (resumeHistoryProof.mjs); `resumeHistory.mjs` re-exports the shared
// surface so `resume.mjs` and `resumeRecording.mjs` imports stay
// unchanged.
export {
  isKnownStatusClass,
  LIVE_PROBE_FAILURE_REASONS,
  readStrictJsonlRecords,
  validateCycleRecordShape,
  validateOperationRecordShape,
  validateResourceRecordShape,
};
