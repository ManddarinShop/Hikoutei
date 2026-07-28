/**
 * Pure row-independent observation evaluator.
 *
 * It composes the precondition, ownership, quarantine, and field-CAS modules
 * without performing I/O or mutating canonical state.
 */

import type {
  CanonicalEntityState,
  CanonicalResolution,
  ObservedEditBatch,
  ObservedRowChange,
  RowBindingContext,
} from "../model/types.js";
import {
  EVALUATION_ERROR_CODES,
  EvaluationContractError,
} from "../errors/index.js";
import {
  CANONICAL_RESOLUTION_STATUSES,
  PRECONDITION_RESULTS,
  QUARANTINE_REASONS,
  ROW_OPERATIONS,
} from "../model/constants.js";
import type {
  BatchEvaluationResult,
  BatchOutcome,
  EvaluationContext,
  RowEvaluationResult,
} from "./contracts.js";
import { ROW_OUTCOMES } from "./constants.js";
import { acceptedDelete, evaluateUserFields } from "./fieldEvaluation.js";
import {
  inspectOwnership,
  validateBindingState,
  validateManifestFields,
  validateOperationPreconditions,
  validateStructuralPreconditions,
} from "./preconditions.js";
import { quarantineRow, quarantineSystemRow } from "./quarantine.js";

/** Evaluates each normalized row independently against the supplied canonical context. */
export function evaluateBatch(
  batch: ObservedEditBatch,
  context: EvaluationContext,
): BatchEvaluationResult {
  if (batch.schemaVersion !== context.schemaVersion) {
    return {
      batchId: batch.batchId,
      rowResults: batch.rows.map((row) => quarantineRow(row, QUARANTINE_REASONS.SCHEMA_DRIFT)),
      overallOutcome: ROW_OUTCOMES.QUARANTINE,
    };
  }

  const rowResults = batch.rows.map((row) => evaluateRow(row, context));
  return {
    batchId: batch.batchId,
    rowResults,
    overallOutcome: summarizeBatch(rowResults),
  };
}

function evaluateRow(
  row: ObservedRowChange,
  context: EvaluationContext,
): RowEvaluationResult {
  const structuralResult = validateStructuralPreconditions(row);
  if (structuralResult.status === PRECONDITION_RESULTS.INVALID) {
    return quarantineRow(row, structuralResult.reason);
  }
  const normalizedRow = structuralResult.row;

  const binding = context.bindingByBindingId.get(normalizedRow.rowBindingId);
  if (binding === undefined) {
    return quarantineRow(normalizedRow, QUARANTINE_REASONS.AMBIGUOUS_IDENTITY);
  }

  const bindingResult = validateBindingState(normalizedRow.operation, binding);
  if (bindingResult.status === PRECONDITION_RESULTS.INVALID) {
    return quarantineRow(normalizedRow, bindingResult.reason);
  }

  const canonical = resolveCanonical(normalizedRow.rowBindingId, binding, context);
  if (hasEntityBinding(binding) && canonical.status === CANONICAL_RESOLUTION_STATUSES.MISSING) {
    return quarantineRow(normalizedRow, QUARANTINE_REASONS.AMBIGUOUS_IDENTITY);
  }

  const manifestResult = validateManifestFields(normalizedRow.fields, context.manifest);
  if (manifestResult.status === PRECONDITION_RESULTS.INVALID) {
    return quarantineRow(normalizedRow, manifestResult.reason);
  }

  const operationResult = validateOperationPreconditions(
    normalizedRow,
    binding,
    canonical,
    context,
  );
  if (operationResult.status === PRECONDITION_RESULTS.INVALID) {
    return quarantineRow(normalizedRow, operationResult.reason);
  }

  const ownership = inspectOwnership(normalizedRow.fields, context.manifest);
  if (ownership.hasSystemField) {
    return quarantineSystemRow(normalizedRow, canonical, ownership);
  }

  return normalizedRow.operation === ROW_OPERATIONS.DELETE
    ? acceptedDelete(normalizedRow, requireCanonical(canonical))
    : evaluateUserFields(normalizedRow, canonical, context);
}

function summarizeBatch(results: readonly RowEvaluationResult[]): BatchOutcome {
  if (results.some((result) => result.outcome === ROW_OUTCOMES.QUARANTINE)) {
    return ROW_OUTCOMES.QUARANTINE;
  }
  if (results.some((result) => result.outcome === ROW_OUTCOMES.CONFLICT)) {
    return ROW_OUTCOMES.CONFLICT;
  }
  return results.some((result) => result.outcome === ROW_OUTCOMES.PARTIALLY_ACCEPTED)
    ? ROW_OUTCOMES.PARTIALLY_ACCEPTED
    : ROW_OUTCOMES.ACCEPTED;
}

function resolveCanonical(
  rowBindingId: string,
  binding: RowBindingContext,
  context: EvaluationContext,
): CanonicalResolution {
  if (!hasEntityBinding(binding)) {
    return { status: CANONICAL_RESOLUTION_STATUSES.MISSING };
  }
  return context.canonicalByBindingId.get(rowBindingId) ?? {
    status: CANONICAL_RESOLUTION_STATUSES.MISSING,
  };
}

function hasEntityBinding(
  binding: RowBindingContext,
): binding is Extract<RowBindingContext, { readonly entityId: string }> {
  return "entityId" in binding;
}

function requireCanonical(canonical: CanonicalResolution): CanonicalEntityState {
  if (canonical.status === CANONICAL_RESOLUTION_STATUSES.MISSING) {
    throw new EvaluationContractError(
      EVALUATION_ERROR_CODES.CANONICAL_STATE_REQUIRED,
      "delete evaluation requires canonical state",
    );
  }
  return canonical.entity;
}
