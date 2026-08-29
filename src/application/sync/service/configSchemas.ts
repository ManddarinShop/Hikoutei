import { z } from "zod";

/** Required shape of a Google service-account credential document. */
export const syncCredentialsSchema = z.object({
  type: z.string().min(1),
  client_email: z.string().min(1),
  private_key: z.string().min(1),
}).passthrough();

/** Decimal-only positive millisecond environment value. */
export const positiveDecimalMillisecondsSchema = z.string()
  .regex(/^\d+$/)
  .transform(Number)
  .refine(
    (value) => Number.isSafeInteger(value) && value >= 1,
    { message: "must be a positive safe integer" },
  );
