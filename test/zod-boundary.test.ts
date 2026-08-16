import { describe, expect, it } from "vitest";
import { z } from "zod";

import { formatZodBoundaryIssues } from "../src/shared/validation/zodBoundary.js";

describe("Zod boundary diagnostics", () => {
  it("formats paths without including invalid input values", () => {
    const result = z.object({
      credentials: z.object({
        privateKey: z.string().min(1),
      }),
      protocolVersion: z.number().int(),
    }).safeParse({
      credentials: { privateKey: "super-secret-key" },
      protocolVersion: "not-a-number",
    });

    expect(result.success).toBe(false);
    if (result.success) return;

    const message = formatZodBoundaryIssues(result.error);
    expect(message).toContain("protocolVersion");
    expect(message).not.toContain("super-secret-key");
  });

  it("bounds diagnostics to the requested number of issues", () => {
    const result = z.object({
      first: z.string(),
      second: z.string(),
      third: z.string(),
    }).safeParse({});

    expect(result.success).toBe(false);
    if (result.success) return;

    const message = formatZodBoundaryIssues(result.error, 1);
    expect(message).toContain("2 more issue(s)");
  });
});
