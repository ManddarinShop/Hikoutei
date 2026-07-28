import { describe, expect, it } from "vitest";
import {
  isNonEmptyList,
  isNonEmptyString,
  isNonNegativeSafeInteger,
  isPositiveSafeInteger,
} from "../src/shared/validation.js";

describe("shared validation predicates", () => {
  it("recognizes non-empty strings", () => {
    expect(isNonEmptyString("value")).toBe(true);
    expect(isNonEmptyString("")).toBe(false);
    expect(isNonEmptyString(null)).toBe(false);
  });

  it("recognizes safe integer ranges", () => {
    expect(isPositiveSafeInteger(1)).toBe(true);
    expect(isPositiveSafeInteger(0)).toBe(false);
    expect(isPositiveSafeInteger(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(isPositiveSafeInteger(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
    expect(isNonNegativeSafeInteger(0)).toBe(true);
    expect(isNonNegativeSafeInteger(-1)).toBe(false);
  });

  it("recognizes non-empty lists", () => {
    expect(isNonEmptyList(["item"])).toBe(true);
    expect(isNonEmptyList([])).toBe(false);
  });
});
