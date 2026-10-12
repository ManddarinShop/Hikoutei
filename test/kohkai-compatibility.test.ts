/**
 * Compatibility tests pinning the canonical codec characterization vectors.
 * Verifies stable encoding bytes, hashes, and canonical JSON text stay aligned
 * with the `@hikoutei/kohkai` contract, including edge cases like negative
 * zero, sparse arrays, duplicate keys, and tagged dates.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  NORMALIZED_CELL_KINDS,
  STABLE_ENCODING_ERROR_CODES,
} from "@hikoutei/contracts/encoding/constants.js";
import {
  stableEncode,
  stableHash,
} from "@hikoutei/contracts/encoding/index.js";
import {
  canonicalJson as genericCanonicalJson,
  isCanonicalJsonValue,
  CanonicalCodecError,
  CANONICAL_CODEC_ERROR_CODES,
} from "@hikoutei/kohkai";
import { stableEncode as genericStableEncode } from "@hikoutei/kohkai";
import type { StableValue } from "@hikoutei/contracts/encoding/types.js";
import { StableEncodingError } from "@hikoutei/contracts/domain/errors/index.js";

type CanonicalCodecVector = {
  readonly name: string;
  readonly value: StableValue;
  readonly stableEncodeHex: string;
  readonly stableHash: string;
  readonly canonicalJson: string;
  readonly canonicalJsonSha256: string;
};

// These vectors are pinned from the @hikoutei/kohkai compatibility contract so
// the Hikoutei provider characterization test cannot drift from the package.
const vectors: readonly CanonicalCodecVector[] = JSON.parse(
  readFileSync(
    new URL("./fixtures/kohkai-vectors.json", import.meta.url),
    "utf8",
  ),
);

// Verifies the canonical codec characterization vectors from the kohkai contract.
describe("canonical codec characterization vectors", () => {
  // Verifies stable encoding bytes and hashes are preserved.
  it("preserves stable encoding bytes and hashes", () => {
    for (const vector of vectors) {
      expect(Buffer.from(stableEncode(vector.value)).toString("hex"), vector.name)
        .toBe(vector.stableEncodeHex);
      expect(stableHash(vector.value), vector.name).toBe(vector.stableHash);
    }
  });

  // Verifies the generic core bytes and JSON text are preserved.
  it("preserves the generic core bytes and JSON text", () => {
    for (const vector of vectors) {
      expect(Buffer.from(genericStableEncode(vector.value)).toString("hex"), vector.name)
        .toBe(vector.stableEncodeHex);
      expect(genericCanonicalJson(vector.value), vector.name).toBe(vector.canonicalJson);
    }
  });

  // Verifies negative zero stays equivalent to zero for stable encoding.
  it("keeps negative zero equivalent to zero for stable encoding", () => {
    expect(Buffer.from(stableEncode(-0)).toString("hex"))
      .toBe(Buffer.from(stableEncode(0)).toString("hex"));
    expect(genericCanonicalJson(-0)).toBe(genericCanonicalJson(0));
  });

  // Verifies canonical JSON values are validated without stable encoding rules.
  it("validates canonical JSON values without applying stable encoding rules", () => {
    expect(isCanonicalJsonValue({ kind: "date", value: "not-a-date" })).toBe(true);
    expect(isCanonicalJsonValue(Number.NaN)).toBe(false);
    expect(() => genericCanonicalJson(Number.NaN)).toThrowError(
      expect.objectContaining({
        name: CanonicalCodecError.name,
        code: CANONICAL_CODEC_ERROR_CODES.NON_FINITE_NUMBER,
      }),
    );
  });

  // Verifies sparse arrays are rejected at the canonical JSON boundary.
  it("rejects sparse arrays at the canonical JSON boundary", () => {
    const sparse: unknown[] = [];
    sparse.length = 1;

    expect(isCanonicalJsonValue(sparse)).toBe(false);
    expect(() => genericCanonicalJson(sparse)).toThrowError(
      expect.objectContaining({
        code: CANONICAL_CODEC_ERROR_CODES.INVALID_JSON_VALUE,
      }),
    );
  });

  // Verifies unsupported object prototypes and cyclic values are rejected.
  it("rejects unsupported object prototypes and cyclic values", () => {
    expect(() => genericStableEncode(new Date())).toThrowError(
      expect.objectContaining({
        code: STABLE_ENCODING_ERROR_CODES.UNSUPPORTED_VALUE_TYPE,
      }),
    );
    expect(() => genericStableEncode(new Map())).toThrowError(
      expect.objectContaining({
        code: STABLE_ENCODING_ERROR_CODES.UNSUPPORTED_VALUE_TYPE,
      }),
    );

    const stableCycle: Record<string, unknown> = {};
    stableCycle.self = stableCycle;
    expect(() => genericStableEncode(stableCycle)).toThrowError(
      expect.objectContaining({
        code: STABLE_ENCODING_ERROR_CODES.CYCLIC_VALUE,
      }),
    );

    const canonicalCycle: Record<string, unknown> = {};
    canonicalCycle.self = canonicalCycle;
    expect(isCanonicalJsonValue(canonicalCycle)).toBe(false);
    expect(() => genericCanonicalJson(canonicalCycle)).toThrowError(
      expect.objectContaining({
        code: CANONICAL_CODEC_ERROR_CODES.CYCLIC_VALUE,
      }),
    );
  });

  // Verifies duplicate keys after NFC normalization are rejected.
  it("rejects duplicate keys after stable-encoding NFC normalization", () => {
    const duplicateKeys = {
      "e\u0301": "decomposed",
      "é": "composed",
    };

    expect(() => stableEncode(duplicateKeys)).toThrowError(
      expect.objectContaining({
        code: STABLE_ENCODING_ERROR_CODES.DUPLICATE_OBJECT_KEY,
      }),
    );
  });

  // Verifies unpaired UTF-16 surrogates are rejected before UTF-8 replacement.
  it("rejects unpaired UTF-16 surrogates before UTF-8 replacement", () => {
    let thrown: unknown;
    try {
      stableEncode("high\ud800");
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(StableEncodingError);
    expect(thrown).toMatchObject({
      code: STABLE_ENCODING_ERROR_CODES.UNPAIRED_HIGH_SURROGATE,
    });
  });

  // Verifies tagged dates stay on the stable date path.
  it("keeps tagged dates on the stable date path", () => {
    const dateValue = {
      kind: NORMALIZED_CELL_KINDS.DATE,
      value: "2026-01-02T03:04:05.000Z",
    } as const;

    expect(Buffer.from(stableEncode(dateValue)).toString("hex"))
      .toBe(vectors.find((vector) => vector.name === "date-shaped-value")?.stableEncodeHex);
  });
});
