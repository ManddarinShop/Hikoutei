/**
 * Deterministic identity helpers for observed rows, events, and repairs.
 *
 * Storage records the resulting values but does not choose their contents;
 * identical normalized input must always produce the same identity.
 */

import type { NormalizedCell, StableValue } from "../../encoding/types.js";
import { stableHash } from "../../encoding/stableEncode.js";
import { DuplicateChangedFieldError } from "../errors/identity.js";
import type { EventKeyField, EventKeyInput } from "./contracts.js";

/**
 * Computes the source-independent event key for a normalized row change.
 *
 * @throws {DuplicateChangedFieldError} when the event lists one field twice.
 */
export function computeEventKey(input: EventKeyInput): string {
  const changedFields = sortByFieldName(input.changedFields, (field) => field.fieldName);
  for (let index = 1; index < changedFields.length; index += 1) {
    if (changedFields[index - 1]!.fieldName === changedFields[index]!.fieldName) {
      throw new DuplicateChangedFieldError(changedFields[index]!.fieldName);
    }
  }

  return stableHash({
    schemaVersion: input.schemaVersion,
    sheetId: input.sheetId,
    projection: input.projection,
    rowBindingId: input.rowBindingId,
    baseVisibleRevision: input.baseVisibleRevision,
    baseSnapshotHash: input.baseSnapshotHash,
    operation: input.operation,
    beforeRowHash: input.beforeRowHash,
    afterRowHash: input.afterRowHash,
    changedFields: changedFields.map(makeEventKeyFieldIdentity),
  });
}

/** Omits the absent revision marker so event identity has no undefined state. */
function makeEventKeyFieldIdentity(field: EventKeyField): StableValue {
  const base = {
    fieldName: field.fieldName,
    candidateEpoch: field.candidateEpoch,
    beforeHash: field.beforeHash,
    afterHash: field.afterHash,
    nextValue: field.nextValue,
  };
  return field.baseFieldRevision === undefined
    ? base
    : { ...base, baseFieldRevision: field.baseFieldRevision };
}

/** Computes a stable hash for a normalized row's field values. */
export function computeRowHash(
  rowBindingId: string,
  fields: ReadonlyMap<string, { readonly cell: NormalizedCell }>,
): string {
  const entries = sortByFieldName([...fields.entries()], ([fieldName]) => fieldName);
  return stableHash({
    rowBindingId,
    fields: entries.map(([name, field]) => [name, field.cell]),
  });
}

/** Computes the visible-state guard used by a system-field repair effect. */
export function computeRepairGuardHash(
  rowBindingId: string,
  illegalFields: ReadonlyArray<readonly [string, NormalizedCell]>,
): string {
  return stableHash({
    rowBindingId,
    illegalFields: sortByFieldName(illegalFields, ([fieldName]) => fieldName),
  });
}

/**
 * Returns a field-name-ordered copy so identity hashes ignore input order.
 * The caller's array is never mutated because observations may be reused.
 */
function sortByFieldName<T>(
  values: readonly T[],
  getFieldName: (value: T) => string,
): T[] {
  return [...values].sort((left, right) =>
    compareText(getFieldName(left), getFieldName(right)),
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
