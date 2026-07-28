import { describe, expect, it } from "vitest";
import {
  NORMALIZED_CELL_KINDS,
  STABLE_ENCODING_ERROR_CODES,
} from "../src/shared/encoding/constants.js";
import { stableEncode } from "../src/shared/encoding/stableEncode.js";
import { StableEncodingError } from "../src/domain/errors/index.js";

describe("stable encoding errors", () => {
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
