import { isRecord } from "../../../../shared/encoding/typeGuards.js";
import { invalidOperationResponse } from "./errors.js";

/** Promotes an operation payload object while retaining the operation error context. */
export function requireOperationRecord(
  value: unknown,
  label: string,
  operationLabel: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    return invalidOperationResponse(
      operationLabel,
      label + " must be an object",
    );
  }
  return value;
}
