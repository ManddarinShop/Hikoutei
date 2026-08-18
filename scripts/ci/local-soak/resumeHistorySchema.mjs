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
} from "./redact.mjs";

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
  const known = new Set(["status", "reason", "table"]);
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

/** Validates one abort section of a cycle record (exact schema). */
function validateAbortShape(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "abort must be an object" };
  }
  const known = new Set(["reason", "errorClass", "code"]);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) return { ok: false, reason: `unknown abort field "${key}"` };
  }
  if (!KNOWN_REASON_CODES.includes(value.reason)) {
    return { ok: false, reason: "abort.reason is not a known reason category" };
  }
  if (!KNOWN_STABLE_CLASSES_HAS(value.errorClass)) {
    return { ok: false, reason: "abort.errorClass is not a known error class" };
  }
  if (value.code !== undefined && !KNOWN_STABLE_CODES.includes(value.code)) {
    return { ok: false, reason: "abort.code is not a known stable code" };
  }
  return { ok: true };
}

/** True when the class name is on the stable allowlist. */
function KNOWN_STABLE_CLASSES_HAS(candidate) {
  return typeof candidate === "string" && KNOWN_STABLE_CLASSES.includes(candidate);
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
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function validateCycleRecordShape(record) {
  const known = new Set([
    "ts", "cycle", "durationMs", "tablesTouched", "operations",
    "expectedErrors", "failures", "retries", "probe", "convergence",
    "reopen", "abort",
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
  if (record.code !== undefined && !KNOWN_STABLE_CODES.includes(record.code)) {
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
  LIVE_PROBE_FAILURE_REASONS,
  readStrictJsonlRecords,
  validateCycleRecordShape,
  validateOperationRecordShape,
  validateResourceRecordShape,
};
