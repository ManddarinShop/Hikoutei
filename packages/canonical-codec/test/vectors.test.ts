import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  stableEncode,
} from "../src/index.js";
import vectors from "./fixtures/canonical-codec-vectors.json" with { "type": "json" };

/**
 * Golden-vector characterization for the package's own encoders.
 *
 * These vectors are the single source of truth shared with the root repository
 * characterization test and the deployed Apps Script mirror. The package asserts
 * only what it produces itself — stable bytes and canonical JSON text — and
 * intentionally does not recompute SHA-256 hashes, which are a host
 * responsibility (the package has no crypto dependency).
 */

/** Hex-encodes a byte array without relying on a Node `Buffer`. */
function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

describe("canonical codec golden vectors", () => {
  for (const vector of vectors) {
    describe(vector.name, () => {
      it("produces the stable_encode_v1 bytes", () => {
        expect(toHex(stableEncode(vector.value))).toBe(vector.stableEncodeHex);
      });

      it("produces the canonical JSON text", () => {
        expect(canonicalJson(vector.value)).toBe(vector.canonicalJson);
      });
    });
  }

  it("covers every documented scalar, date, array, and object shape", () => {
    const names = vectors.map((vector) => vector.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "null",
        "boolean-true",
        "boolean-false",
        "empty-string",
        "plain-string",
        "decomposed-unicode",
        "emoji",
        "number-zero",
        "number-exponent",
        "date-shaped-value",
        "array-nested",
        "object-insertion-order",
      ]),
    );
  });
});
