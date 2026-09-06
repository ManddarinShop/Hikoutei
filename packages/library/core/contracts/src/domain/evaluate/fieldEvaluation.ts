/**
 * Field-level canonical compare-and-set evaluation.
 *
 * This module never mutates canonical state. It classifies each user-owned
 * field as accepted or conflicting so the storage writer can commit one
 * row-independent decision atomically later.
 */

import {
  CANONICAL_RESOLUTION_STATUSES,
  CONFLICT_STATUSES,
  ROW_OPERATIONS,
} from "../model/constants.js";
import {
  EVALUATION_ERROR_CODES,
  EvaluationContractError,
} from "../errors/index.js";
import type {
  CanonicalEntityState,
  CanonicalResolution,
  ObservedDeleteRowChange,
  ObservedFieldChange,
  ObservedRowChange,
  ObservedVersionedFieldChange,
} from "../model/types.js";
import type {
  AcceptedField,
  AppliedRowEvaluationResult,
  ConflictRowEvaluationResult,
  EvaluationContext,
  FieldConflict,
  RowEvaluationResult,
} from "./contracts.js";
import { ROW_OUTCOMES } from "./constants.js";

/** Evaluates all user-owned fields after structural/ownership checks passed. */
export function evaluateUserFields(
  row: ObservedRowChange,
  canonical: CanonicalResolution,
  context: EvaluationContext,
): RowEvaluationResult {
  const accepted: AcceptedField[] = [];
  const conflicts: FieldConflict[] = [];
  const canonicalEntity = canonical.status === CANONICAL_RESOLUTION_STATUSES.AVAILABLE
    ? canonical.entity
    : undefined;

  for (const fieldChange of row.fields) {
    const result = evaluateSingleUserField(fieldChange, canonicalEntity, row, context);
    if (result.kind === ROW_OUTCOMES.ACCEPTED) {
      accepted.push(result.field);
    }
    else conflicts.push(result.conflict);
  }

  const outcome = classifyFieldOutcome(accepted, conflicts);
  if (outcome === ROW_OUTCOMES.CONFLICT) {
    const conflictResult: ConflictRowEvaluationResult = {
      rowBindingId: row.rowBindingId,
      outcome,
      acceptedFields: [],
      conflicts,
    };
    return conflictResult;
  }

  const appliedResult: AppliedRowEvaluationResult = {
    rowBindingId: row.rowBindingId,
    outcome,
    acceptedFields: accepted,
    conflicts,
    nextEntityRevision: nextEntityRevisionFor(row, canonicalEntity),
  };
  return appliedResult;
}

/** Produces an accepted tombstone without treating delete fields as updates. */
export function acceptedDelete(
  row: ObservedDeleteRowChange,
  canonical: CanonicalEntityState,
): AppliedRowEvaluationResult {
  return {
    rowBindingId: row.rowBindingId,
    outcome: ROW_OUTCOMES.ACCEPTED,
    acceptedFields: [],
    conflicts: [],
    nextEntityRevision: canonical.entityRevision + 1,
  };
}

type FieldEvaluationResult =
  | { readonly kind: typeof ROW_OUTCOMES.ACCEPTED; readonly field: AcceptedField }
  | { readonly kind: typeof ROW_OUTCOMES.CONFLICT; readonly conflict: FieldConflict };

function evaluateSingleUserField(
  fieldChange: ObservedFieldChange,
  canonical: CanonicalEntityState | undefined,
  row: ObservedRowChange,
  context: EvaluationContext,
): FieldEvaluationResult {
  if (row.operation === ROW_OPERATIONS.INSERT) {
    return {
      kind: ROW_OUTCOMES.ACCEPTED,
      field: {
        fieldName: fieldChange.fieldName,
        nextValue: fieldChange.nextValue,
        nextFieldRevision: 1,
      },
    };
  }

  const existingFieldChange = requireVersionedFieldChange(fieldChange);
  const existingCanonical = requireCanonicalEntity(canonical);
  if (hasActiveConflict(context, row.rowBindingId, fieldChange.fieldName)) {
    return conflictResult(existingFieldChange, existingCanonical);
  }

  const currentField = existingCanonical.fields.get(fieldChange.fieldName);
  if (
    currentField === undefined ||
    existingFieldChange.baseFieldRevision !== currentField.fieldRevision
  ) {
    return conflictResult(existingFieldChange, existingCanonical);
  }

  return {
    kind: ROW_OUTCOMES.ACCEPTED,
    field: {
      fieldName: fieldChange.fieldName,
      nextValue: fieldChange.nextValue,
      nextFieldRevision: currentField.fieldRevision + 1,
    },
  };
}

function classifyFieldOutcome(
  accepted: readonly AcceptedField[],
  conflicts: readonly FieldConflict[],
): AppliedRowEvaluationResult["outcome"] | typeof ROW_OUTCOMES.CONFLICT {
  if (conflicts.length === 0) return ROW_OUTCOMES.ACCEPTED;
  return accepted.length > 0
    ? ROW_OUTCOMES.PARTIALLY_ACCEPTED
    : ROW_OUTCOMES.CONFLICT;
}

function conflictResult(
  fieldChange: ObservedVersionedFieldChange,
  canonical: CanonicalEntityState,
): FieldEvaluationResult {
  const currentField = canonical.fields.get(fieldChange.fieldName);
  if (currentField === undefined) {
    throw new EvaluationContractError(
      EVALUATION_ERROR_CODES.CANONICAL_FIELD_REQUIRED,
      `existing row evaluation requires canonical field ${fieldChange.fieldName}`,
    );
  }
  return {
    kind: ROW_OUTCOMES.CONFLICT,
    conflict: {
      fieldName: fieldChange.fieldName,
      userValue: fieldChange.nextValue,
      userBaseRevision: fieldChange.baseFieldRevision,
      canonicalValue: currentField.value,
      canonicalRevision: currentField.fieldRevision,
    },
  };
}

function hasActiveConflict(
  context: EvaluationContext,
  rowBindingId: string,
  fieldName: string,
): boolean {
  const conflict = context.activeConflictsByBindingAndField.get(rowBindingId)?.get(fieldName);
  return conflict?.status === CONFLICT_STATUSES.OPEN ||
    conflict?.status === CONFLICT_STATUSES.NEEDS_REBASE;
}

function nextEntityRevisionFor(
  row: ObservedRowChange,
  canonical: CanonicalEntityState | undefined,
): number {
  if (row.operation === ROW_OPERATIONS.INSERT) return 1;
  return requireCanonicalEntity(canonical).entityRevision + 1;
}

function requireCanonicalEntity(
  canonical: CanonicalEntityState | undefined,
): CanonicalEntityState {
  if (canonical === undefined) {
    throw new EvaluationContractError(
      EVALUATION_ERROR_CODES.CANONICAL_STATE_REQUIRED,
      "existing row evaluation requires canonical state",
    );
  }
  return canonical;
}

function requireVersionedFieldChange(
  fieldChange: ObservedFieldChange,
): ObservedVersionedFieldChange {
  if (!isVersionedFieldChange(fieldChange)) {
    throw new EvaluationContractError(
      EVALUATION_ERROR_CODES.BASE_FIELD_REVISION_REQUIRED,
      "existing row evaluation requires a base field revision",
    );
  }
  return fieldChange;
}

function isVersionedFieldChange(
  fieldChange: ObservedFieldChange,
): fieldChange is ObservedVersionedFieldChange {
  return fieldChange.baseFieldRevision !== undefined;
}
