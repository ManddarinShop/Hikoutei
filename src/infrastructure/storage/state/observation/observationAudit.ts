/**
 * Stable audit serialization for observation evidence.
 *
 * Gateway payloads are external input, so rejected values must still be
 * preserved without JSON coercion silently hiding malformed data.
 */

import { computeRowHash, stableHash, type NormalizedRow } from "../../../../domain/index.js";
import {
  isJavaScriptType,
  isRecord,
  JAVASCRIPT_TYPE_NAMES,
} from "../../../../shared/encoding/index.js";
import { QUARANTINE_FINGERPRINT_MARKERS } from "../../../../domain/evaluate/constants.js";
import { STORAGE_ERROR_CODES, StorageError } from "../../errors.js";

/** Builds the persisted hash for an observed row snapshot or absent row. */
export function rowHash(
  row: NormalizedRow | null,
  rowBindingId: string,
): string {
  return row === null
    ? stableHash({ rowBindingId, row: null })
    : computeRowHash(row.rowBindingId, row.fields);
}

/**
 * Produces non-throwing audit JSON for rejected adapter values as well as
 * valid normalized values. It never lets JSON.stringify silently turn
 * Infinity into null or discard undefined evidence.
 */
export function auditJson(value: unknown): string {
  const serialized = JSON.stringify(toAuditValue(value, new Set<object>()));
  if (serialized === undefined) {
    throw new StorageError(
      STORAGE_ERROR_CODES.OBSERVATION_AUDIT_SERIALIZATION_FAILED,
      "could not serialize audit evidence",
    );
  }
  return serialized;
}

type AuditValue = null | boolean | number | string | readonly AuditValue[] | {
  readonly [key: string]: AuditValue;
};

function toAuditValue(value: unknown, seen: Set<object>): AuditValue {
  if (value === null ||
      isJavaScriptType(value, JAVASCRIPT_TYPE_NAMES.STRING) ||
      isJavaScriptType(value, JAVASCRIPT_TYPE_NAMES.BOOLEAN)) return value;
  if (isJavaScriptType(value, JAVASCRIPT_TYPE_NAMES.NUMBER)) {
    return Number.isFinite(value) ? value : { $invalidNumber: String(value) };
  }
  if (isJavaScriptType(value, JAVASCRIPT_TYPE_NAMES.UNDEFINED)) {
    return { $invalidType: QUARANTINE_FINGERPRINT_MARKERS.UNDEFINED };
  }
  if (isJavaScriptType(value, JAVASCRIPT_TYPE_NAMES.BIGINT)) {
    return { $invalidBigInt: value.toString() };
  }
  if (isJavaScriptType(value, JAVASCRIPT_TYPE_NAMES.SYMBOL)) {
    return { $invalidSymbol: String(value) };
  }
  if (isJavaScriptType(value, JAVASCRIPT_TYPE_NAMES.FUNCTION)) {
    return {
      $invalidFunction: value.name || QUARANTINE_FINGERPRINT_MARKERS.ANONYMOUS_FUNCTION,
    };
  }
  if (!isJavaScriptType(value, JAVASCRIPT_TYPE_NAMES.OBJECT)) {
    return { $invalidObject: Object.prototype.toString.call(value) };
  }

  if (seen.has(value)) {
    return { $invalidObject: QUARANTINE_FINGERPRINT_MARKERS.CYCLE };
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => toAuditValue(entry, seen));
    }
    if (value instanceof Map) {
      const entries = [...value.entries()]
        .map(([key, entry]) => [toAuditValue(key, seen), toAuditValue(entry, seen)] as const)
        .sort((left, right) => {
          const leftKey = auditSortKey(left[0]);
          const rightKey = auditSortKey(right[0]);
          return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
        });
      return { $map: entries };
    }
    if (Object.prototype.toString.call(value) !== QUARANTINE_FINGERPRINT_MARKERS.PLAIN_OBJECT_TAG) {
      return { $invalidObject: Object.prototype.toString.call(value) };
    }

    if (!isRecord(value)) {
      return { $invalidObject: Object.prototype.toString.call(value) };
    }
    const objectValue = value;
    const result: Record<string, AuditValue> = {};
    for (const key of Object.keys(objectValue).sort()) {
      result[key] = toAuditValue(objectValue[key], seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function auditSortKey(value: AuditValue): string {
  return JSON.stringify(value);
}
