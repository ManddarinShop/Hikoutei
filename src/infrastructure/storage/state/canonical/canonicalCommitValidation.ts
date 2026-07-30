/** Validates the state-specific input accepted by the canonical commit writer. */

import { ROW_OPERATIONS } from "../../../../domain/model/constants.js";
import type { Applicability } from "../../../../domain/index.js";
import {
  APPLICABILITY_KINDS,
  PRESENCE_KINDS,
} from "../../../../shared/state/constants.js";
import type { Presence } from "../../../../shared/state/types.js";
import { STORAGE_ERROR_CODES, StorageError } from "../../errors.js";
import type { CanonicalCommitInput } from "./canonicalCommit.js";

/** Returns a reason when a canonical commit shape is invalid. */
export function validateCanonicalCommitInput(
  input: CanonicalCommitInput,
): Presence<string> {
  if (input.entityId.length === 0) return presentError("entity ID is required");
  if (input.kind === ROW_OPERATIONS.DELETE) {
    return Number.isSafeInteger(input.expectedEntityRevision) && input.expectedEntityRevision >= 1
      ? absentError()
      : presentError("delete must have a positive expected entity revision");
  }
  if (input.fields.length === 0) return presentError("at least one accepted field is required");

  const fieldNames = new Set<string>();
  for (const field of input.fields) {
    if (field.fieldName.length === 0 || fieldNames.has(field.fieldName)) {
      return presentError("field names must be non-empty and unique");
    }
    fieldNames.add(field.fieldName);

    if (
      input.kind === ROW_OPERATIONS.INSERT &&
      field.expectedFieldRevision.kind !== APPLICABILITY_KINDS.NOT_APPLICABLE
    ) {
      return presentError("insert fields must not have an expected revision");
    }
    if (
      input.kind === ROW_OPERATIONS.UPDATE &&
      (field.expectedFieldRevision.kind !== APPLICABILITY_KINDS.APPLICABLE ||
        !Number.isSafeInteger(field.expectedFieldRevision.value) ||
        field.expectedFieldRevision.value < 1)
    ) {
      return presentError("update fields must have a positive expected revision");
    }
  }
  return absentError();
}

/** Converts an applicable revision into the value required by an update SQL statement. */
export function requireApplicableRevision(revision: Applicability<number>): number {
  if (revision.kind !== APPLICABILITY_KINDS.APPLICABLE) {
    throw new StorageError(
      STORAGE_ERROR_CODES.INVALID_OBSERVATION_INPUT,
      "an update field must carry an applicable expected revision",
    );
  }
  return revision.value;
}

function presentError(value: string): Presence<string> {
  return { kind: PRESENCE_KINDS.PRESENT, value };
}

function absentError(): Presence<string> {
  return { kind: PRESENCE_KINDS.ABSENT };
}
