import { z } from "zod";

const recordSchema = z.record(z.string(), z.unknown());
const nonEmptyTextSchema = z.string().min(1);
const integerStatusSchema = z.number().int();
const textStatusSchema = z.string().regex(/^\d{3}$/);

/** Promotes an unknown SDK error node to a string-keyed record when possible. */
export function parseRawErrorRecord(value: unknown): Record<string, unknown> | undefined {
  const parsed = recordSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Reads an optional non-empty text field from an untrusted SDK node. */
export function parseRawErrorText(value: unknown): string | undefined {
  const parsed = nonEmptyTextSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Accepts the numeric or three-digit string status forms returned by gaxios. */
export function parseRawHttpStatus(value: unknown): number | undefined {
  const numeric = integerStatusSchema.safeParse(value);
  if (numeric.success) return numeric.data;
  const textual = textStatusSchema.safeParse(value);
  return textual.success ? Number(textual.data) : undefined;
}
