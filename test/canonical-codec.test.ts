import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  NORMALIZED_CELL_KINDS,
  STABLE_ENCODING_ERROR_CODES,
} from "../src/shared/encoding/constants.js";
import {
  stableEncode,
  stableHash,
} from "../src/shared/encoding/index.js";
import type { StableValue } from "../src/shared/encoding/types.js";
import { StableEncodingError } from "../src/domain/errors/index.js";
import {
  canonicalSyncJson,
  syncSha256Hex,
} from "../src/adapter/sheets/providers/apps-script-gateway/protocol/syncProtocol.js";

type CanonicalCodecVector = {
  readonly name: string;
  readonly value: StableValue;
  readonly stableEncodeHex: string;
  readonly stableHash: string;
  readonly canonicalJson: string;
  readonly canonicalJsonSha256: string;
};

const vectors: readonly CanonicalCodecVector[] = JSON.parse(
  readFileSync(new URL("./fixtures/canonical-codec-vectors.json", import.meta.url), "utf8"),
);

describe("canonical codec characterization vectors", () => {
  it("preserves stable encoding bytes and hashes", () => {
    for (const vector of vectors) {
      expect(Buffer.from(stableEncode(vector.value)).toString("hex"), vector.name)
        .toBe(vector.stableEncodeHex);
      expect(stableHash(vector.value), vector.name).toBe(vector.stableHash);
    }
  });

  it("preserves canonical JSON text and hashes separately from stable encoding", () => {
    for (const vector of vectors) {
      const canonicalJson = canonicalSyncJson(vector.value);
      expect(canonicalJson, vector.name).toBe(vector.canonicalJson);
      expect(syncSha256Hex(canonicalJson), vector.name).toBe(vector.canonicalJsonSha256);
    }
  });

  it("keeps negative zero equivalent to zero for both formats", () => {
    expect(Buffer.from(stableEncode(-0)).toString("hex"))
      .toBe(Buffer.from(stableEncode(0)).toString("hex"));
    expect(canonicalSyncJson(-0)).toBe(canonicalSyncJson(0));
  });

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

  it("keeps tagged dates on the stable date path", () => {
    const dateValue = {
      kind: NORMALIZED_CELL_KINDS.DATE,
      value: "2026-01-02T03:04:05.000Z",
    } as const;

    expect(Buffer.from(stableEncode(dateValue)).toString("hex"))
      .toBe(vectors.find((vector) => vector.name === "date-shaped-value")?.stableEncodeHex);
  });
});
