/**
 * Zod boundary diagnostic formatting coverage.
 *
 * Verifies validation diagnostics expose issue paths without leaking invalid
 * input values (e.g. secrets) and honor the requested per-message issue cap.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { formatZodBoundaryIssues } from "@hikoutei/contracts/validation/zodBoundary.js";

// Verifies Zod boundary diagnostics format paths safely with bounded issue counts.
describe("Zod boundary diagnostics", () => {
  // Verifies formatted paths omit invalid input values such as secrets.
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

  // Verifies diagnostics are capped at the requested number of issues.
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
