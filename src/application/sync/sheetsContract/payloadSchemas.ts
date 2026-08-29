import { z } from "zod";

import {
  isNormalizedCell,
  type NormalizedCell,
} from "../../../shared/encoding/index.js";

const positiveSafeIntegerSchema = z.number().refine(
  (value) => Number.isSafeInteger(value) && value >= 1,
  { message: "must be a positive safe integer" },
);

const normalizedCellSchema = z.custom<NormalizedCell>(isNormalizedCell, {
  message: "must be a normalized cell",
});

/** Wire shape for one persisted projection effect before semantic promotion. */
export const syncProjectionEffectPayloadSchema = z.object({
  sheetName: z.string().min(1),
  registeredRange: z.string().min(1),
  schemaVersion: positiveSafeIntegerSchema,
  targetAnchor: z.string().min(1),
  fields: z.record(z.string().min(1), normalizedCellSchema),
  targetVisibleHash: z.string().min(1),
  createIfMissing: z.boolean(),
  expectedCandidateHash: z.string().min(1).nullable(),
}).strip();
