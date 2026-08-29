/**
 * Deterministic quarantine and repair-plan builders.
 *
 * Invalid external values are converted to encodable audit fingerprints so a
 * rejected retry remains idempotent instead of failing while constructing its
 * quarantine identity.
 */

import type { NormalizedCell, StableValue } from "../../shared/encoding/types.js";
import { stableHash } from "../../shared/encoding/stableEncode.js";
import { isRecord } from "../../shared/encoding/typeGuards.js";
import {
  CANONICAL_RESOLUTION_STATUSES,
  FIELD_OWNERSHIPS,
  QUARANTINE_REASONS,
  ROW_OPERATIONS,
} from "../model/constants.js";
import type {
  CanonicalEntityState,
  CanonicalResolution,
  ObservedRowChange,
  QuarantinePlan,
  QuarantineReason,
  RepairPlan,
} from "../model/types.js";
import type {
  QuarantineRepairDecision,
  RowEvaluationResult,
} from "./contracts.js";
import {
  QUARANTINE_FINGERPRINT_KEYS,
  QUARANTINE_FINGERPRINT_MARKERS,
  QUARANTINE_ID_PREFIX,
  QUARANTINE_REPAIR_NOT_PLANNED_REASONS,
  QUARANTINE_REPAIR_STATUSES,
  REPAIR_PLAN_BUILD_STATUSES,
  ROW_OUTCOMES,
} from "./constants.js";
import type {
  QuarantineFingerprintKey,
  QuarantineId,
} from "./constants.js";
import { computeRepairGuardHash } from "./identity.js";
import type { OwnershipCheckResult } from "./preconditions.js";

/** Builds a terminal row result for evidence that cannot safely be applied. */
export function quarantineRow(
  row: ObservedRowChange,
  reason: QuarantineReason,
): RowEvaluationResult {
  return {
    rowBindingId: row.rowBindingId,
    outcome: ROW_OUTCOMES.QUARANTINE,
    acceptedFields: [],
    conflicts: [],
    quarantine: makeQuarantinePlan(row, reason, []),
    repair: {
      status: QUARANTINE_REPAIR_STATUSES.NOT_PLANNED,
      reason: QUARANTINE_REPAIR_NOT_PLANNED_REASONS.QUARANTINE_ONLY,
    },
  };
}

/** Produces a quarantine plus a guarded repair plan for illegal system edits. */
export function quarantineSystemRow(
  row: ObservedRowChange,
  canonical: CanonicalResolution,
  ownership: OwnershipCheckResult,
): RowEvaluationResult {
  const reason: QuarantineReason = ownership.hasUserField
    ? QUARANTINE_REASONS.MIXED_OWNERSHIP_EDIT
    : QUARANTINE_REASONS.SYSTEM_FIELD_EDIT;
  const quarantine = makeQuarantinePlan(
    row,
    reason,
    ownership.systemFields.map((field) => field.fieldName),
  );
  const repairDecision = canonical.status === CANONICAL_RESOLUTION_STATUSES.MISSING
    ? {
        status: QUARANTINE_REPAIR_STATUSES.NOT_PLANNED,
        reason: QUARANTINE_REPAIR_NOT_PLANNED_REASONS.CANONICAL_UNAVAILABLE,
      }
    : makeRepairPlan(quarantine, row, ownership.systemFields, canonical.entity);

  if (repairDecision.status === REPAIR_PLAN_BUILD_STATUSES.UNAVAILABLE) {
    return quarantineRow(row, QUARANTINE_REASONS.SCHEMA_DRIFT);
  }

  const repair: QuarantineRepairDecision = repairDecision.status === REPAIR_PLAN_BUILD_STATUSES.PLANNED
    ? {
        status: QUARANTINE_REPAIR_STATUSES.PLANNED,
        plan: repairDecision.plan,
      }
    : repairDecision;

  return {
    rowBindingId: row.rowBindingId,
    outcome: ROW_OUTCOMES.QUARANTINE,
    acceptedFields: [],
    conflicts: [],
    quarantine,
    repair,
  };
}

/** Preserves row evidence and attaches any fields eligible for repair. */
function makeQuarantinePlan(
  row: ObservedRowChange,
  reason: QuarantineReason,
  repairFields: readonly string[],
): QuarantinePlan {
  const common = {
    quarantineId: makeQuarantineId(row, reason),
    reason,
    rowBindingId: row.rowBindingId,
    fields: row.fields,
    repairFields,
  };

  switch (row.operation) {
    case ROW_OPERATIONS.INSERT:
      return {
        ...common,
        operation: row.operation,
        afterRow: row.afterRow,
      };
    case ROW_OPERATIONS.UPDATE:
    case ROW_OPERATIONS.RENAME:
      return {
        ...common,
        operation: row.operation,
        beforeRow: row.beforeRow,
        afterRow: row.afterRow,
      };
    case ROW_OPERATIONS.DELETE:
      return {
        ...common,
        operation: row.operation,
        beforeRow: row.beforeRow,
      };
  }
}

interface QuarantineIdentityFieldBase {
  readonly [key: string]: StableValue;
  readonly fieldName: string;
  readonly previousValue: StableValue;
  readonly nextValue: StableValue;
}

type QuarantineIdentityField =
  | QuarantineIdentityFieldBase
  | (QuarantineIdentityFieldBase & { readonly baseFieldRevision: number });

interface QuarantineIdentityInput {
  readonly [key: string]: StableValue;
  readonly rowBindingId: string;
  readonly operation: ObservedRowChange["operation"];
  readonly reason: QuarantineReason;
  readonly baseVisibleRevision: number;
  readonly fields: readonly QuarantineIdentityField[];
}

/** Creates a deterministic quarantine ID so identical retries share one identity. */
function makeQuarantineId(
  row: ObservedRowChange,
  reason: QuarantineReason,
): QuarantineId {
  const identityInput: QuarantineIdentityInput = {
    rowBindingId: row.rowBindingId,
    operation: row.operation,
    reason,
    baseVisibleRevision: row.baseVisibleRevision,
    fields: row.fields.map(makeQuarantineIdentityField),
  };

  return `${QUARANTINE_ID_PREFIX}${stableHash(identityInput)}`;
}

function makeQuarantineIdentityField(
  field: ObservedRowChange["fields"][number],
): QuarantineIdentityField {
  const base = {
    fieldName: field.fieldName,
    previousValue: quarantineFingerprintValue(field.previousValue),
    nextValue: quarantineFingerprintValue(field.nextValue),
  };
  return field.baseFieldRevision === undefined
    ? base
    : { ...base, baseFieldRevision: field.baseFieldRevision };
}

/** Converts arbitrary external values into stable, encodable audit evidence. */
function quarantineFingerprintValue(value: unknown, seen: Set<object> = new Set()): StableValue {
  if (value === null) return value;
  if (typeof value === "string" ||
      typeof value === "boolean") return value;
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? value
      : makeInvalidFingerprint(QUARANTINE_FINGERPRINT_KEYS.INVALID_NUMBER, String(value));
  }
  if (typeof value === "undefined") {
    return makeInvalidFingerprint(
      QUARANTINE_FINGERPRINT_KEYS.INVALID_TYPE,
      QUARANTINE_FINGERPRINT_MARKERS.UNDEFINED,
    );
  }
  if (typeof value === "bigint") {
    return makeInvalidFingerprint(
      QUARANTINE_FINGERPRINT_KEYS.INVALID_BIGINT,
      value.toString(),
    );
  }
  if (typeof value === "symbol") {
    return makeInvalidFingerprint(
      QUARANTINE_FINGERPRINT_KEYS.INVALID_SYMBOL,
      String(value),
    );
  }
  if (typeof value === "function") {
    return makeInvalidFingerprint(
      QUARANTINE_FINGERPRINT_KEYS.INVALID_FUNCTION,
      value.name || QUARANTINE_FINGERPRINT_MARKERS.ANONYMOUS_FUNCTION,
    );
  }

  if (typeof value !== "object") {
    return makeInvalidFingerprint(
      QUARANTINE_FINGERPRINT_KEYS.INVALID_OBJECT,
      Object.prototype.toString.call(value),
    );
  }
  if (seen.has(value)) {
    return makeInvalidFingerprint(
      QUARANTINE_FINGERPRINT_KEYS.INVALID_OBJECT,
      QUARANTINE_FINGERPRINT_MARKERS.CYCLE,
    );
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => quarantineFingerprintValue(entry, seen));
    if (Object.prototype.toString.call(value) !== QUARANTINE_FINGERPRINT_MARKERS.PLAIN_OBJECT_TAG) {
      return makeInvalidFingerprint(
        QUARANTINE_FINGERPRINT_KEYS.INVALID_OBJECT,
        Object.prototype.toString.call(value),
      );
    }

    if (!isRecord(value)) {
      return makeInvalidFingerprint(
        QUARANTINE_FINGERPRINT_KEYS.INVALID_OBJECT,
        Object.prototype.toString.call(value),
      );
    }
    const record = value;
    const normalized: Record<string, StableValue> = {};
    for (const key of Object.keys(record)) {
      normalized[key] = quarantineFingerprintValue(record[key], seen);
    }
    return normalized;
  } finally {
    seen.delete(value);
  }
}

/** Wraps an unsupported value in a stable, typed fingerprint object. */
function makeInvalidFingerprint(
  key: QuarantineFingerprintKey,
  value: string,
): StableValue {
  return { [key]: value };
}

type RepairPlanBuildResult =
  | { readonly status: typeof REPAIR_PLAN_BUILD_STATUSES.UNAVAILABLE }
  | {
      readonly status: typeof REPAIR_PLAN_BUILD_STATUSES.PLANNED;
      readonly plan: RepairPlan;
    };

/** Builds a repair plan only when every edited system field has canonical state. */
function makeRepairPlan(
  quarantine: QuarantinePlan,
  row: ObservedRowChange,
  systemFields: readonly { fieldName: string; value: NormalizedCell }[],
  canonical: CanonicalEntityState,
): RepairPlanBuildResult {
  const targetValues = new Map<string, NormalizedCell>();
  for (const systemField of systemFields) {
    const canonicalField = canonical.fields.get(systemField.fieldName);
    if (canonicalField === undefined || canonicalField.ownership !== FIELD_OWNERSHIPS.SYSTEM) {
      return { status: REPAIR_PLAN_BUILD_STATUSES.UNAVAILABLE };
    }
    targetValues.set(systemField.fieldName, canonicalField.value);
  }
  return {
    status: REPAIR_PLAN_BUILD_STATUSES.PLANNED,
    plan: {
      quarantineId: quarantine.quarantineId,
      rowBindingId: row.rowBindingId,
      affectedSystemFields: systemFields.map((field) => field.fieldName),
      canonicalTargetValues: targetValues,
      repairGuardHash: computeRepairGuardHash(
        row.rowBindingId,
        systemFields.map((field) => [field.fieldName, field.value]),
      ),
      reason: QUARANTINE_REASONS.SYSTEM_FIELD_EDIT,
    },
  };
}
