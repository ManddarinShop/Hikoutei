/**
 * stable encode tests. Covers stable encoding errors; raises a structured error for an invalid date; raises a structured error for a non-finite number.
 *
 * Exercises the behavior through fake providers and SQLite fixtures with no live credentials.
 */
import { describe, expect, it } from "vitest";
import {
  NORMALIZED_CELL_KINDS,
  STABLE_ENCODING_ERROR_CODES,
} from "@hikoutei/contracts/encoding/constants.js";
import { stableEncode } from "@hikoutei/contracts/encoding/stableEncode.js";
import { StableEncodingError } from "@hikoutei/contracts/domain/errors/index.js";

// Covers: stable encoding errors.
describe("stable encoding errors", () => {
  // Verifies: raises a structured error for an invalid date.
  it("raises a structured error for an invalid date", () => {
    let thrown: unknown;
    try {
      stableEncode({ kind: NORMALIZED_CELL_KINDS.DATE, value: "not-a-date" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(StableEncodingError);
    expect(thrown).toMatchObject({
      domain: "stable_encode",
      code: STABLE_ENCODING_ERROR_CODES.INVALID_DATE_FORMAT,
    });
  });

  // Verifies: raises a structured error for a non-finite number.
  it("raises a structured error for a non-finite number", () => {
    let thrown: unknown;
    try {
      stableEncode(Number.NaN);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(StableEncodingError);
    expect(thrown).toMatchObject({
      domain: "stable_encode",
      code: STABLE_ENCODING_ERROR_CODES.NON_FINITE_NUMBER,
    });
  });
});
