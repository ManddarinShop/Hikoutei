import { isCanonicalUtcIsoDate } from "../validation.js";
import { NORMALIZED_CELL_KINDS } from "./constants.js";
import { isRecord } from "./typeGuards.js";
import type { NormalizedCell } from "./types.js";

/** Promotes an unknown value to the canonical normalized-cell contract. */
export function isNormalizedCell(value: unknown): value is NormalizedCell {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case NORMALIZED_CELL_KINDS.STRING:
      return typeof value.value === "string";
    case NORMALIZED_CELL_KINDS.NUMBER:
      return typeof value.value === "number" && Number.isFinite(value.value);
    case NORMALIZED_CELL_KINDS.BOOLEAN:
      return typeof value.value === "boolean";
    case NORMALIZED_CELL_KINDS.DATE:
      return isCanonicalUtcIsoDate(value.value);
    default:
      return false;
  }
}
