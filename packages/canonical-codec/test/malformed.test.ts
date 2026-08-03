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

/**
 * Boundary characterization for malformed inputs.
 *
 * The package must reject values that cannot be encoded deterministically and
 * must raise a typed error with a machine-readable code at every boundary.
 * Stable encoding and canonical JSON share most rejection rules but diverge in
 * a few places (for example, only stable encoding normalizes NFC keys and
 * rejects unpaired surrogates); this file pins both contracts explicitly.
 */

type AnyErrorConstructor = abstract new (...args: readonly any[]) => Error;

function expectCode(fn: () => unknown, code: string, ErrorClass?: AnyErrorConstructor): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error: unknown) {
    thrown = error;
  }
  expect(thrown, "expected the call to throw").toBeDefined();
  if (ErrorClass !== undefined) {
    expect(thrown).toBeInstanceOf(ErrorClass);
  }
  expect(thrown).toMatchObject({ code });
}

describe("sparse arrays", () => {
  it("canonical JSON rejects sparse arrays with an invalid-json-value code", () => {
    const sparse: unknown[] = [];
    sparse.length = 2;

    expect(isCanonicalJsonValue(sparse)).toBe(false);
    expectCode(
      () => canonicalJson(sparse),
      CANONICAL_CODEC_ERROR_CODES.INVALID_JSON_VALUE,
      CanonicalCodecError,
    );
  });

  it("stable encoding rejects sparse-array holes as unsupported values", () => {
    const sparse: unknown[] = [];
    sparse.length = 2;

    expectCode(
      () => stableEncode(sparse),
      STABLE_ENCODING_ERROR_CODES.UNSUPPORTED_VALUE_TYPE,
      StableCodecError,
    );
  });
});

describe("cyclic values", () => {
  it("stable encoding rejects cycles with a cyclic-value code", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;

    expectCode(
      () => stableEncode(cycle),
      STABLE_ENCODING_ERROR_CODES.CYCLIC_VALUE,
      StableCodecError,
    );
  });

  it("canonical JSON rejects cycles with a cyclic-value code", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;

    expect(isCanonicalJsonValue(cycle)).toBe(false);
    expectCode(
      () => canonicalJson(cycle),
      CANONICAL_CODEC_ERROR_CODES.CYCLIC_VALUE,
      CanonicalCodecError,
    );
  });

  it("detects cycles through arrays", () => {
    const array: unknown[] = [];
    array.push(array);

    expect(isCanonicalJsonValue(array)).toBe(false);
    expectCode(
      () => canonicalJson(array),
      CANONICAL_CODEC_ERROR_CODES.CYCLIC_VALUE,
      CanonicalCodecError,
    );
  });
});

describe("unsupported prototypes", () => {
  for (const [label, value] of [
    ["Date", new Date()],
    ["Map", new Map()],
    ["Set", new Set()],
    ["Error", new Error()],
  ] as const) {
    it(`stable encoding rejects ${label} as an unsupported value type`, () => {
      expectCode(
        () => stableEncode(value),
        STABLE_ENCODING_ERROR_CODES.UNSUPPORTED_VALUE_TYPE,
        StableCodecError,
      );
    });

    it(`canonical JSON rejects ${label} with an invalid-json-value code`, () => {
      expect(isCanonicalJsonValue(value)).toBe(false);
      expectCode(
        () => canonicalJson(value),
        CANONICAL_CODEC_ERROR_CODES.INVALID_JSON_VALUE,
        CanonicalCodecError,
      );
    });
  }
});

describe("non-finite numbers", () => {
  for (const [label, value] of [
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
  ] as const) {
    it(`stable encoding rejects ${label} with a non-finite-number code`, () => {
      expectCode(
        () => stableEncode(value),
        STABLE_ENCODING_ERROR_CODES.NON_FINITE_NUMBER,
        StableCodecError,
      );
    });

    it(`canonical JSON rejects ${label} with a non-finite-number code`, () => {
      expect(isCanonicalJsonValue(value)).toBe(false);
      expectCode(
        () => canonicalJson(value),
        CANONICAL_CODEC_ERROR_CODES.NON_FINITE_NUMBER,
        CanonicalCodecError,
      );
    });
  }
});

describe("duplicate keys after NFC normalization", () => {
  const duplicateNfcKeys = {
    "e\u0301": "decomposed",
    "é": "composed",
  };

  it("stable encoding rejects duplicate NFC keys", () => {
    expectCode(
      () => stableEncode(duplicateNfcKeys),
      STABLE_ENCODING_ERROR_CODES.DUPLICATE_OBJECT_KEY,
      StableCodecError,
    );
  });

  it("normalizes composed keys so equivalent NFC forms share one entry", () => {
    const single = { "é": 1 };
    expect(stableEncode(single)).toEqual(stableEncode({ "e\u0301": 1 }));
  });
});

describe("invalid tagged dates", () => {
  it("stable encoding rejects a malformed date value with an invalid-date-format code", () => {
    expectCode(
      () => stableEncode({ kind: "date", value: "not-a-date" }),
      STABLE_ENCODING_ERROR_CODES.INVALID_DATE_FORMAT,
      StableCodecError,
    );
  });

  it("stable encoding rejects a non-ISO date string", () => {
    expectCode(
      () => stableEncode({ kind: "date", value: "2026-01-02" }),
      STABLE_ENCODING_ERROR_CODES.INVALID_DATE_FORMAT,
      StableCodecError,
    );
  });

  it("canonical JSON treats a date-shaped object as a plain object", () => {
    expect(isCanonicalJsonValue({ kind: "date", value: "not-a-date" })).toBe(true);
    expect(canonicalJson({ kind: "date", value: "not-a-date" }))
      .toBe('{"kind":"date","value":"not-a-date"}');
  });
});

describe("malformed UTF-16 surrogates", () => {
  it("stable encoding rejects an unpaired high surrogate", () => {
    expectCode(
      () => stableEncode("high\ud800"),
      STABLE_ENCODING_ERROR_CODES.UNPAIRED_HIGH_SURROGATE,
      StableCodecError,
    );
  });

  it("stable encoding rejects an unpaired low surrogate", () => {
    expectCode(
      () => stableEncode("low\udc00"),
      STABLE_ENCODING_ERROR_CODES.UNPAIRED_LOW_SURROGATE,
      StableCodecError,
    );
  });

  it("accepts a well-formed surrogate pair as a single scalar", () => {
    // U+1F600 (😀) encoded as a surrogate pair.
    expect(stableEncode("\ud83d\ude00")).toEqual(stableEncode("😀"));
  });
});

describe("unsupported scalar types", () => {
  for (const [label, value] of [
    ["undefined", undefined],
    ["bigint", 0n],
    ["symbol", Symbol("x")],
    ["function", () => undefined],
  ] as const) {
    it(`stable encoding rejects ${label}`, () => {
      expectCode(
        () => stableEncode(value),
        STABLE_ENCODING_ERROR_CODES.UNSUPPORTED_VALUE_TYPE,
        StableCodecError,
      );
    });
  }
});
