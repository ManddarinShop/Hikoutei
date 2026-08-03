import { describe, expect, it } from "vitest";

import {
  CANONICAL_CODEC_ERROR_CODES,
  CanonicalCodecError,
  canonicalJson,
  isCanonicalJsonValue,
  STABLE_ENCODING_ERROR_CODES,
  StableCodecError,
  stableEncode,
} from "../src/index.js";
import * as codec from "../src/index.js";
import type {
  CanonicalJsonValue,
  StableCodecDateValue,
  StableCodecValue,
} from "../src/index.js";

/**
 * Public package export surface.
 *
 * Pins the named exports and type-only exports a consumer depends on, the
 * machine-readable error-code constants, and the stable-error subclass
 * relationship. The packed-consumer smoke additionally verifies that these
 * exports resolve through the published `exports` map from an installed
 * tarball.
 */

describe("public encoder exports", () => {
  it("exports stableEncode, canonicalJson, and isCanonicalJsonValue as functions", () => {
    expect(typeof stableEncode).toBe("function");
    expect(typeof canonicalJson).toBe("function");
    expect(typeof isCanonicalJsonValue).toBe("function");
  });

  it("round-trips a stable value to bytes and canonical text", () => {
    expect(stableEncode(null)).toBeInstanceOf(Uint8Array);
    expect(canonicalJson({ z: 1, a: 2 })).toBe('{"a":2,"z":1}');
  });

  it("isCanonicalJsonValue accepts canonical inputs and rejects malformed ones", () => {
    expect(isCanonicalJsonValue(null)).toBe(true);
    expect(isCanonicalJsonValue({ a: [1, 2, 3] })).toBe(true);
    expect(isCanonicalJsonValue(Number.NaN)).toBe(false);
    expect(isCanonicalJsonValue(undefined)).toBe(false);
    const sparse: unknown[] = [];
    sparse.length = 1;
    expect(isCanonicalJsonValue(sparse)).toBe(false);
  });
});

describe("public error exports", () => {
  it("exports CanonicalCodecError and StableCodecError classes", () => {
    expect(typeof CanonicalCodecError).toBe("function");
    expect(typeof StableCodecError).toBe("function");
  });

  it("makes StableCodecError a subclass of CanonicalCodecError", () => {
    const error = new StableCodecError(
      STABLE_ENCODING_ERROR_CODES.CYCLIC_VALUE,
      "test",
    );
    expect(error).toBeInstanceOf(StableCodecError);
    expect(error).toBeInstanceOf(CanonicalCodecError);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("cyclic_value");
    expect(error.name).toBe("StableCodecError");
  });

  it("CanonicalCodecError carries the documented name and code", () => {
    const error = new CanonicalCodecError(
      CANONICAL_CODEC_ERROR_CODES.NON_FINITE_NUMBER,
      "test",
    );
    expect(error.name).toBe("CanonicalCodecError");
    expect(error.code).toBe("non_finite_number");
  });
});

describe("public error-code constants", () => {
  it("exposes the canonical codec error vocabulary", () => {
    expect(CANONICAL_CODEC_ERROR_CODES).toEqual({
      UNSUPPORTED_VALUE_TYPE: "unsupported_value_type",
      NON_FINITE_NUMBER: "non_finite_number",
      INVALID_DATE_FORMAT: "invalid_date_format",
      INVALID_DATE_BYTE_LENGTH: "invalid_date_byte_length",
      DUPLICATE_OBJECT_KEY: "duplicate_object_key",
      UNPAIRED_HIGH_SURROGATE: "unpaired_high_surrogate",
      UNPAIRED_LOW_SURROGATE: "unpaired_low_surrogate",
      INVALID_JSON_VALUE: "invalid_json_value",
      CYCLIC_VALUE: "cyclic_value",
    });
  });

  it("exposes the stable-encoding error subset without the JSON-only code", () => {
    expect(STABLE_ENCODING_ERROR_CODES).toEqual({
      UNSUPPORTED_VALUE_TYPE: "unsupported_value_type",
      NON_FINITE_NUMBER: "non_finite_number",
      INVALID_DATE_FORMAT: "invalid_date_format",
      INVALID_DATE_BYTE_LENGTH: "invalid_date_byte_length",
      DUPLICATE_OBJECT_KEY: "duplicate_object_key",
      UNPAIRED_HIGH_SURROGATE: "unpaired_high_surrogate",
      UNPAIRED_LOW_SURROGATE: "unpaired_low_surrogate",
      CYCLIC_VALUE: "cyclic_value",
    });
    expect(STABLE_ENCODING_ERROR_CODES).not.toHaveProperty("INVALID_JSON_VALUE");
  });
});

describe("public type-only exports", () => {
  it("supports StableCodecDateValue and StableCodecValue construction", () => {
    const date: StableCodecDateValue = {
      kind: "date",
      value: "2026-01-02T03:04:05.000Z",
    };
    const value: StableCodecValue = date;
    // Compile-time check that the types are exported; runtime sanity that the
    // tagged date still encodes on the date path.
    expect(stableEncode(value)).toBeInstanceOf(Uint8Array);
  });

  it("supports CanonicalJsonValue construction", () => {
    const value: CanonicalJsonValue = { a: 1, nested: [true, "x"] };
    expect(canonicalJson(value)).toBe('{"a":1,"nested":[true,"x"]}');
  });
});

describe("package namespace surface", () => {
  it("does not export internal modules or private symbols", () => {
    const surface = Object.keys(codec).sort();
    expect(surface).toEqual(
      [
        "CANONICAL_CODEC_ERROR_CODES",
        "CanonicalCodecError",
        "STABLE_ENCODING_ERROR_CODES",
        "StableCodecError",
        "canonicalJson",
        "isCanonicalJsonValue",
        "stableEncode",
      ].sort(),
    );
  });
});
