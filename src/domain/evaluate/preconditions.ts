/**
 * Fail-closed validation before field-level conflict evaluation.
 *
 * These checks reject ambiguous identity, invalid normalized values, schema
 * drift, and unsupported operation shapes before any canonical field CAS is
 * considered.
 */

import type { NormalizedCell } from "../../shared/encoding/types.js";
import {
  JAVASCRIPT_TYPE_NAMES,
  NORMALIZED_CELL_KINDS,
} from "../../shared/encoding/constants.js";
import { isJavaScriptType, isRecord } from "../../shared/encoding/typeGuards.js";
import { stableHash } from "../../shared/encoding/stableEncode.js";
import {
  CANONICAL_RESOLUTION_STATUSES,
  DELETE_EVIDENCE,
  FIELD_OWNERSHIPS,
  PRECONDITION_RESULTS,
  QUARANTINE_REASONS,
  ROW_BINDING_STATES,
  ROW_OPERATIONS,
} from "../model/constants.js";
import type {
  CanonicalResolution,
  DeleteEvidence,
  ObservedFieldChange,
  ObservedDeleteRowChange,
  ObservedExistingRowChange,
  ObservedInsertRowChange,
  ObservedVersionedFieldChange,
  NormalizedRow,
  RawObservedRowChange,
  RawObservedInsertFieldChange,
  RawObservedVersionedFieldChange,
  ObservedRowChange,
  OwnershipManifest,
  RowOperation,
  RowBindingContext,
} from "../model/types.js";
import type {
  EvaluationContext,
  PreconditionResult,
  StructuralPreconditionResult,
} from "./contracts.js";

/** Summary of editable and system-owned fields in one observed row. */
export interface OwnershipCheckResult {
  readonly hasSystemField: boolean;
  readonly hasUserField: boolean;
  readonly systemFields: readonly { fieldName: string; value: NormalizedCell }[];
}

/** Validates raw input and promotes it to an operation-specific row type. */
export function validateStructuralPreconditions(
  input: unknown,
): StructuralPreconditionResult {
  const parsed = parseRawObservedRow(input);
  if (parsed.status === PRECONDITION_RESULTS.INVALID) return parsed;
  const row = parsed.row;

  if (row.fields.length === 0) return invalidStructuralResult(QUARANTINE_REASONS.INVALID_EVENT);

  const seenFields = new Set<string>();
  const normalizedFields: ObservedFieldChange[] = [];
  for (const field of row.fields) {
    if (field.fieldName.length === 0 || seenFields.has(field.fieldName)) {
      return invalidStructuralResult(QUARANTINE_REASONS.INVALID_EVENT);
    }
    seenFields.add(field.fieldName);

    if (!isNormalizedCell(field.previousValue) || !isNormalizedCell(field.nextValue)) {
      return invalidStructuralResult(QUARANTINE_REASONS.INVALID_CELL);
    }
    if ("baseFieldRevision" in field) {
      if (!isValidRevision(field.baseFieldRevision)) {
        return invalidStructuralResult(QUARANTINE_REASONS.INVALID_EVENT);
      }
      normalizedFields.push({
        fieldName: field.fieldName,
        previousValue: field.previousValue,
        nextValue: field.nextValue,
        baseFieldRevision: field.baseFieldRevision,
      });
    } else {
      normalizedFields.push({
        fieldName: field.fieldName,
        previousValue: field.previousValue,
        nextValue: field.nextValue,
      });
    }
  }

  return promoteObservedRow(row, normalizedFields);
}

/** Checks whether the operation is legal for the row binding's current state. */
export function validateBindingState(
  operation: RowOperation,
  binding: RowBindingContext,
): PreconditionResult {
  switch (operation) {
    case ROW_OPERATIONS.INSERT:
      return binding.bindingState === ROW_BINDING_STATES.CANDIDATE
        ? validPreconditionResult()
        : invalidPreconditionResult(QUARANTINE_REASONS.AMBIGUOUS_IDENTITY);
    case ROW_OPERATIONS.UPDATE:
    case ROW_OPERATIONS.RENAME:
    case ROW_OPERATIONS.DELETE:
      return binding.bindingState === ROW_BINDING_STATES.ACTIVE
        ? validPreconditionResult()
        : invalidPreconditionResult(QUARANTINE_REASONS.AMBIGUOUS_IDENTITY);
    default:
      return invalidPreconditionResult(QUARANTINE_REASONS.INVALID_EVENT);
  }
}

/** Rejects a row that references a field absent from the ownership manifest. */
export function validateManifestFields(
  fields: readonly ObservedFieldChange[],
  manifest: OwnershipManifest,
): PreconditionResult {
  return fields.some((field) => !manifest.has(field.fieldName))
    ? invalidPreconditionResult(QUARANTINE_REASONS.UNKNOWN_FIELD)
    : validPreconditionResult();
}

/** Applies operation-specific evidence, required-field, and unique-key checks. */
export function validateOperationPreconditions(
  row: ObservedRowChange,
  binding: RowBindingContext,
  canonical: CanonicalResolution,
  context: EvaluationContext,
): PreconditionResult {
  if (row.operation === ROW_OPERATIONS.INSERT) {
    const requiredFieldsResult = validateRequiredInsertFields(row, context.manifest);
    return requiredFieldsResult.status === PRECONDITION_RESULTS.VALID
      ? validateUniqueBusinessKeys(row, binding, context)
      : requiredFieldsResult;
  }

  if (canonical.status === CANONICAL_RESOLUTION_STATUSES.MISSING) {
    return invalidPreconditionResult(QUARANTINE_REASONS.AMBIGUOUS_IDENTITY);
  }

  if (row.operation === ROW_OPERATIONS.DELETE) {
    if (row.deleteEvidence !== DELETE_EVIDENCE.DELETED_CONFIRMED) {
      return invalidPreconditionResult(QUARANTINE_REASONS.ANCHOR_LOST);
    }
    return row.baseEntityRevision === canonical.entity.entityRevision
      ? validPreconditionResult()
      : invalidPreconditionResult(QUARANTINE_REASONS.INVALID_EVENT);
  }

  if (row.fields.some((field) => canonical.entity.fields.get(field.fieldName) === undefined)) {
    return invalidPreconditionResult(QUARANTINE_REASONS.SCHEMA_DRIFT);
  }

  return row.operation === ROW_OPERATIONS.RENAME
    ? validateUniqueBusinessKeys(row, binding, context)
    : validPreconditionResult();
}

/** Separates illegal system fields from user-owned fields without resolving them. */
export function inspectOwnership(
  fields: readonly ObservedFieldChange[],
  manifest: OwnershipManifest,
): OwnershipCheckResult {
  const systemFields: Array<{ fieldName: string; value: NormalizedCell }> = [];
  let hasUserField = false;

  for (const field of fields) {
    const entry = manifest.get(field.fieldName);
    if (entry !== undefined && entry.ownership === FIELD_OWNERSHIPS.SYSTEM) {
      systemFields.push({ fieldName: field.fieldName, value: field.nextValue });
    } else {
      hasUserField = true;
    }
  }

  return {
    hasSystemField: systemFields.length > 0,
    hasUserField,
    systemFields,
  };
}

type RawObservedRowParseResult =
  | {
      readonly status: typeof PRECONDITION_RESULTS.VALID;
      readonly row: RawObservedRowChange;
    }
  | {
      readonly status: typeof PRECONDITION_RESULTS.INVALID;
      readonly reason: typeof QUARANTINE_REASONS[keyof typeof QUARANTINE_REASONS];
    };

/** Converts an untrusted payload into a state-specific raw row shape. */
function parseRawObservedRow(input: unknown): RawObservedRowParseResult {
  if (!isRecord(input) || !isValidOperation(input.operation)) {
    return invalidRawObservedRowResult();
  }
  if (
    !isJavaScriptType(input.rowBindingId, JAVASCRIPT_TYPE_NAMES.STRING) ||
    !isJavaScriptType(input.baseVisibleRevision, JAVASCRIPT_TYPE_NAMES.NUMBER) ||
    !Array.isArray(input.fields)
  ) {
    return invalidRawObservedRowResult();
  }

  const common = {
    rowBindingId: input.rowBindingId,
    baseVisibleRevision: input.baseVisibleRevision,
  };

  switch (input.operation) {
    case ROW_OPERATIONS.INSERT:
      if (
        !isPresentNormalizedRow(input.afterRow) ||
        hasOwn(input, "beforeRow") ||
        hasOwn(input, "baseEntityRevision") ||
        hasOwn(input, "deleteEvidence") ||
        !input.fields.every(isRawInsertFieldChange)
      ) {
        return invalidRawObservedRowResult();
      }
      return {
        status: PRECONDITION_RESULTS.VALID,
        row: {
          ...common,
          operation: ROW_OPERATIONS.INSERT,
          afterRow: input.afterRow,
          fields: input.fields,
        },
      };
    case ROW_OPERATIONS.UPDATE:
    case ROW_OPERATIONS.RENAME:
      if (
        !isPresentNormalizedRow(input.beforeRow) ||
        !isPresentNormalizedRow(input.afterRow) ||
        !isValidRevision(input.baseEntityRevision) ||
        hasOwn(input, "deleteEvidence") ||
        !input.fields.every(isRawVersionedFieldChange)
      ) {
        return invalidRawObservedRowResult();
      }
      return {
        status: PRECONDITION_RESULTS.VALID,
        row: {
          ...common,
          operation: input.operation,
          beforeRow: input.beforeRow,
          afterRow: input.afterRow,
          baseEntityRevision: input.baseEntityRevision,
          fields: input.fields,
        },
      };
    case ROW_OPERATIONS.DELETE:
      if (
        !isPresentNormalizedRow(input.beforeRow) ||
        hasOwn(input, "afterRow") ||
        !isValidRevision(input.baseEntityRevision) ||
        !isDeleteEvidence(input.deleteEvidence) ||
        !input.fields.every(isRawVersionedFieldChange)
      ) {
        return invalidRawObservedRowResult();
      }
      return {
        status: PRECONDITION_RESULTS.VALID,
        row: {
          ...common,
          operation: ROW_OPERATIONS.DELETE,
          beforeRow: input.beforeRow,
          baseEntityRevision: input.baseEntityRevision,
          deleteEvidence: input.deleteEvidence,
          fields: input.fields,
        },
      };
  }
}

/** Promotes validated raw evidence into a state-specific row contract. */
function promoteObservedRow(
  row: RawObservedRowChange,
  fields: readonly ObservedFieldChange[],
): StructuralPreconditionResult {
  switch (row.operation) {
    case ROW_OPERATIONS.INSERT: {
      if (fields.some((field) => "baseFieldRevision" in field)) {
        return invalidStructuralResult(QUARANTINE_REASONS.INVALID_EVENT);
      }

      return {
        status: PRECONDITION_RESULTS.VALID,
        row: {
          rowBindingId: row.rowBindingId,
          operation: ROW_OPERATIONS.INSERT,
          afterRow: row.afterRow,
          baseVisibleRevision: row.baseVisibleRevision,
          fields: fields.map(({ fieldName, previousValue, nextValue }) => ({
            fieldName,
            previousValue,
            nextValue,
          })),
        },
      };
    }
    case ROW_OPERATIONS.UPDATE:
    case ROW_OPERATIONS.RENAME: {
      const versionedFields = promoteVersionedFields(fields);
      if (versionedFields.status === PRECONDITION_RESULTS.INVALID) {
        return invalidStructuralResult(versionedFields.reason);
      }
      if (!isValidRevision(row.baseEntityRevision)) {
        return invalidStructuralResult(QUARANTINE_REASONS.INVALID_EVENT);
      }

      const existingRow: ObservedExistingRowChange = {
        rowBindingId: row.rowBindingId,
        operation: row.operation,
        beforeRow: row.beforeRow,
        afterRow: row.afterRow,
        baseVisibleRevision: row.baseVisibleRevision,
        baseEntityRevision: row.baseEntityRevision,
        fields: versionedFields.fields,
      };
      return { status: PRECONDITION_RESULTS.VALID, row: existingRow };
    }
    case ROW_OPERATIONS.DELETE: {
      const versionedFields = promoteVersionedFields(fields);
      if (versionedFields.status === PRECONDITION_RESULTS.INVALID) {
        return invalidStructuralResult(versionedFields.reason);
      }
      if (!isValidRevision(row.baseEntityRevision)) {
        return invalidStructuralResult(QUARANTINE_REASONS.INVALID_EVENT);
      }

      const deleteRow: ObservedDeleteRowChange = {
        rowBindingId: row.rowBindingId,
        operation: ROW_OPERATIONS.DELETE,
        beforeRow: row.beforeRow,
        baseVisibleRevision: row.baseVisibleRevision,
        baseEntityRevision: row.baseEntityRevision,
        deleteEvidence: row.deleteEvidence,
        fields: versionedFields.fields,
      };
      return { status: PRECONDITION_RESULTS.VALID, row: deleteRow };
    }
  }
}

type VersionedFieldsPromotionResult =
  | {
      readonly status: typeof PRECONDITION_RESULTS.VALID;
      readonly fields: ObservedVersionedFieldChange[];
    }
  | {
      readonly status: typeof PRECONDITION_RESULTS.INVALID;
      readonly reason: typeof QUARANTINE_REASONS.UNKNOWN_BASE_REVISION;
    };

/** Promotes fields only when every field carries the revision needed for CAS. */
function promoteVersionedFields(
  fields: readonly ObservedFieldChange[],
): VersionedFieldsPromotionResult {
  const versionedFields: ObservedVersionedFieldChange[] = [];
  for (const field of fields) {
    if (field.baseFieldRevision === undefined) {
      return {
        status: PRECONDITION_RESULTS.INVALID,
        reason: QUARANTINE_REASONS.UNKNOWN_BASE_REVISION,
      };
    }
    versionedFields.push({
      fieldName: field.fieldName,
      previousValue: field.previousValue,
      nextValue: field.nextValue,
      baseFieldRevision: field.baseFieldRevision,
    });
  }
  return { status: PRECONDITION_RESULTS.VALID, fields: versionedFields };
}

/** Narrows an external revision to a safe non-negative revision. */
function isValidRevision(value: unknown): value is number {
  return isJavaScriptType(value, JAVASCRIPT_TYPE_NAMES.NUMBER) &&
    Number.isSafeInteger(value) &&
    value >= 0;
}

function isValidOperation(operation: unknown): operation is RowOperation {
  return operation === ROW_OPERATIONS.INSERT ||
    operation === ROW_OPERATIONS.UPDATE ||
    operation === ROW_OPERATIONS.DELETE ||
    operation === ROW_OPERATIONS.RENAME;
}

function invalidRawObservedRowResult(): RawObservedRowParseResult {
  return {
    status: PRECONDITION_RESULTS.INVALID,
    reason: QUARANTINE_REASONS.INVALID_EVENT,
  };
}

function isRawInsertFieldChange(value: unknown): value is RawObservedInsertFieldChange {
  return isRecord(value) &&
    isJavaScriptType(value.fieldName, JAVASCRIPT_TYPE_NAMES.STRING) &&
    !hasOwn(value, "baseFieldRevision");
}

function isRawVersionedFieldChange(value: unknown): value is RawObservedVersionedFieldChange {
  return isRecord(value) &&
    isJavaScriptType(value.fieldName, JAVASCRIPT_TYPE_NAMES.STRING) &&
    hasOwn(value, "baseFieldRevision") &&
    isJavaScriptType(value.baseFieldRevision, JAVASCRIPT_TYPE_NAMES.NUMBER);
}

function isPresentNormalizedRow(value: unknown): value is NormalizedRow {
  return isRecord(value) && isJavaScriptType(value.rowBindingId, JAVASCRIPT_TYPE_NAMES.STRING);
}

function isDeleteEvidence(value: unknown): value is DeleteEvidence {
  return value === DELETE_EVIDENCE.DELETED_CONFIRMED ||
    value === DELETE_EVIDENCE.ANCHOR_LOST ||
    value === DELETE_EVIDENCE.UNAVAILABLE;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function validateRequiredInsertFields(
  row: ObservedInsertRowChange,
  manifest: OwnershipManifest,
): PreconditionResult {
  const fieldsByName = new Map(row.fields.map((field) => [field.fieldName, field]));
  for (const entry of manifest.values()) {
    if (!entry.required) continue;
    const field = fieldsByName.get(entry.fieldName);
    if (field === undefined || !hasRequiredValue(field.nextValue)) {
      return invalidPreconditionResult(QUARANTINE_REASONS.INVALID_EVENT);
    }
  }
  return validPreconditionResult();
}

function validateUniqueBusinessKeys(
  row: ObservedRowChange,
  binding: RowBindingContext,
  context: EvaluationContext,
): PreconditionResult {
  for (const field of row.fields) {
    const manifestEntry = context.manifest.get(field.fieldName);
    if (manifestEntry === undefined || !manifestEntry.unique) continue;
    if (!hasRequiredValue(field.nextValue)) {
      return invalidPreconditionResult(QUARANTINE_REASONS.INVALID_EVENT);
    }

    const owner = context.businessKeyEntityIdsByField
      .get(field.fieldName)
      ?.get(stableHash(field.nextValue));
    const bindingEntityId = "entityId" in binding ? binding.entityId : undefined;
    if (owner !== undefined && owner !== bindingEntityId) {
      return invalidPreconditionResult(QUARANTINE_REASONS.AMBIGUOUS_IDENTITY);
    }
  }
  return validPreconditionResult();
}

function validPreconditionResult(): PreconditionResult {
  return { status: PRECONDITION_RESULTS.VALID };
}

function invalidPreconditionResult(
  reason: typeof QUARANTINE_REASONS[keyof typeof QUARANTINE_REASONS],
): PreconditionResult {
  return {
    status: PRECONDITION_RESULTS.INVALID,
    reason,
  };
}

function invalidStructuralResult(
  reason: typeof QUARANTINE_REASONS[keyof typeof QUARANTINE_REASONS],
): StructuralPreconditionResult {
  return {
    status: PRECONDITION_RESULTS.INVALID,
    reason,
  };
}

function hasRequiredValue(value: NormalizedCell): boolean {
  return value !== null &&
    !(value.kind === NORMALIZED_CELL_KINDS.STRING && value.value.length === 0);
}

/** Narrows untrusted adapter input to the versioned normalized-cell contract. */
function isNormalizedCell(value: unknown): value is NormalizedCell {
  if (value === null) return true;
  if (!isJavaScriptType(value, JAVASCRIPT_TYPE_NAMES.OBJECT) || Array.isArray(value)) return false;

  const candidate = value as { readonly kind?: unknown; readonly value?: unknown };
  switch (candidate.kind) {
    case NORMALIZED_CELL_KINDS.STRING:
      return isJavaScriptType(candidate.value, JAVASCRIPT_TYPE_NAMES.STRING);
    case NORMALIZED_CELL_KINDS.NUMBER:
      return isJavaScriptType(candidate.value, JAVASCRIPT_TYPE_NAMES.NUMBER) && Number.isFinite(candidate.value);
    case NORMALIZED_CELL_KINDS.BOOLEAN:
      return isJavaScriptType(candidate.value, JAVASCRIPT_TYPE_NAMES.BOOLEAN);
    case NORMALIZED_CELL_KINDS.DATE:
      return isJavaScriptType(candidate.value, JAVASCRIPT_TYPE_NAMES.STRING) && isCanonicalDate(candidate.value);
    default:
      return false;
  }
}

function isCanonicalDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}
