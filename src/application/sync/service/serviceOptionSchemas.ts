import { z } from "zod";

/** Non-empty text accepted by internal sync service options. */
export const internalSyncTextSchema = z.string().refine(
  (value) => value.trim().length > 0,
  { message: "must be a non-empty string" },
);

/** Positive safe integer accepted by internal sync service timing options. */
export const internalPositiveSafeIntegerSchema = z.number().refine(
  (value) => Number.isSafeInteger(value) && value >= 1,
  { message: "must be a positive safe integer" },
);

/** Structural shape of one generated or configured projection route. */
export const internalSyncRouteSchema = z.object({
  tabName: internalSyncTextSchema,
  registeredRange: internalSyncTextSchema,
}).strip();
