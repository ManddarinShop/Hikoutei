import { z } from "zod";

import { invalidProviderState } from "../errors.js";

/** Structural shape shared by spreadsheet enumeration and grid responses. */
export const spreadsheetDocumentShapeSchema = z.object({
  sheets: z.array(z.unknown()),
}).passthrough();

/** Structural shape of one REST sheet entry before semantic promotion. */
export const sheetEntryShapeSchema = z.object({
  properties: z.unknown().optional(),
  data: z.unknown().optional(),
  merges: z.unknown().optional(),
}).passthrough();

/** Generic array shape used by nested Google response parsers. */
export const unknownArraySchema = z.array(z.unknown());

/** Structural shape of a batchUpdate response before reply semantics. */
export const batchUpdateResponseShapeSchema = z.object({
  replies: z.array(z.unknown()),
}).passthrough();

/** Parses one raw provider shape while retaining the provider error boundary. */
export function parseProviderResponseShape<T>(
  schema: z.ZodType<T>,
  value: unknown,
  message: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) invalidProviderState(message);
  return parsed.data;
}
