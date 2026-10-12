/**
 * Shared validation predicate tests for contracts and storage boundaries.
 *
 * Pins the non-empty, safe-integer, normalized-cell, UTC-date, semantic-identity,
 * and SQL-row decoding helpers that guard untrusted input across the codebase.
 */
import { describe, expect, it } from "vitest";
import { isNormalizedCell } from "@hikoutei/contracts/encoding/normalizedCell.js";
import {
  isCanonicalUtcIsoDate,
  isNonEmptyList,
  isNonEmptyString,
  isNonNegativeSafeInteger,
  isPositiveSafeInteger,
} from "@hikoutei/contracts/validation.js";
import {
  isSemanticRevision,
  requireHash,
  requireSemanticRevision,
  requireSemanticString,
} from "@hikoutei/contracts/identity/types.js";
import {
  CONTRACTS_INPUT_ERROR_CODES,
  ContractsInputError,
} from "@hikoutei/contracts/domain/errors/index.js";
import { decodeSqlRow } from "@hikoutei/contracts/storage/sql.js";

// Verifies the shared validation predicates suite.
describe("shared validation predicates", () => {
  // Verifies: recognizes non-empty strings.
  it("recognizes non-empty strings", () => {
    expect(isNonEmptyString("value")).toBe(true);
    expect(isNonEmptyString("")).toBe(false);
    expect(isNonEmptyString(null)).toBe(false);
  });

  // Verifies: recognizes safe integer ranges.
  it("recognizes safe integer ranges", () => {
    expect(isPositiveSafeInteger(1)).toBe(true);
    expect(isPositiveSafeInteger(0)).toBe(false);
    expect(isPositiveSafeInteger(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(isPositiveSafeInteger(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
    expect(isNonNegativeSafeInteger(0)).toBe(true);
    expect(isNonNegativeSafeInteger(-1)).toBe(false);
  });

  // Verifies: recognizes canonical normalized cells.
  it("recognizes canonical normalized cells", () => {
    expect(isNormalizedCell(null)).toBe(true);
    expect(isNormalizedCell({ kind: "string", value: "text" })).toBe(true);
    expect(isNormalizedCell({ kind: "number", value: 1 })).toBe(true);
    expect(isNormalizedCell({ kind: "boolean", value: false })).toBe(true);
    expect(isNormalizedCell({ kind: "date", value: "2026-01-02T03:04:05.000Z" })).toBe(true);
    expect(isNormalizedCell({ kind: "number", value: Number.NaN })).toBe(false);
    expect(isNormalizedCell({ kind: "date", value: "2026-01-02T03:04:05Z" })).toBe(false);
    expect(isNormalizedCell({ kind: "unknown", value: "text" })).toBe(false);
    expect(isNormalizedCell({ kind: "string" })).toBe(false);
    expect(isNormalizedCell({ kind: "string", value: "text", extra: true })).toBe(false);
  });

  // Verifies: recognizes canonical UTC dates.
  it("recognizes canonical UTC dates", () => {
    expect(isCanonicalUtcIsoDate("2026-01-02T03:04:05.000Z")).toBe(true);
    expect(isCanonicalUtcIsoDate("2026-01-02T03:04:05Z")).toBe(false);
    expect(isCanonicalUtcIsoDate("not-a-date")).toBe(false);
  });

  // Verifies: promotes semantic identifiers only after runtime validation.
  it("promotes semantic identifiers only after runtime validation", () => {
    expect.assertions(18);
    expect(requireSemanticString<"entity-id">("entity-1", "entity ID")).toBe("entity-1");
    expect(requireSemanticRevision(0)).toBe(0);
    expect(isSemanticRevision(1)).toBe(true);
    expect(requireHash("a".repeat(64), "payload hash")).toBe("a".repeat(64));
    expect(() => requireSemanticString("", "entity ID")).toThrow();
    expect(() => requireSemanticRevision(-1)).toThrow();
    expect(() => requireHash("not-a-hash", "payload hash")).toThrow();

    // ContractsInputError code assertions
    expect(() => requireSemanticString("", "entity ID")).toThrow(ContractsInputError);
    try {
      requireSemanticString("", "entity ID");
    } catch (e) {
      expect(e).toBeInstanceOf(ContractsInputError);
      expect(e).toBeInstanceOf(TypeError);
      expect((e as ContractsInputError).code).toBe(CONTRACTS_INPUT_ERROR_CODES.NON_EMPTY_STRING_REQUIRED);
      expect(e).toHaveProperty("message", "entity ID must be a non-empty string");
    }
    try {
      requireSemanticRevision(-1, "revision");
    } catch (e) {
      expect(e).toBeInstanceOf(ContractsInputError);
      expect((e as ContractsInputError).code).toBe(CONTRACTS_INPUT_ERROR_CODES.NON_NEGATIVE_INTEGER_REQUIRED);
      expect(e).toHaveProperty("message", "revision must be a non-negative safe integer");
    }
    try {
      requireHash("not-a-hash", "payload hash");
    } catch (e) {
      expect(e).toBeInstanceOf(ContractsInputError);
      expect((e as ContractsInputError).code).toBe(CONTRACTS_INPUT_ERROR_CODES.SHA256_HASH_REQUIRED);
      expect(e).toHaveProperty("message", "payload hash must be a SHA-256 hexadecimal hash");
    }
  });

  // Verifies: decodeSqlRow throws ContractsInputError for non-object values.
  it("decodeSqlRow throws ContractsInputError for non-object values", () => {
    expect.assertions(6);
    try {
      decodeSqlRow(null, (r) => r);
    } catch (e) {
      expect(e).toBeInstanceOf(ContractsInputError);
      expect((e as ContractsInputError).code).toBe(CONTRACTS_INPUT_ERROR_CODES.OBJECT_REQUIRED);
      expect(e).toHaveProperty("message", "SQL row must be an object");
    }
    try {
      decodeSqlRow([1], (r) => r);
    } catch (e) {
      expect(e).toBeInstanceOf(ContractsInputError);
      expect((e as ContractsInputError).code).toBe(CONTRACTS_INPUT_ERROR_CODES.OBJECT_REQUIRED);
      expect(e).toHaveProperty("message", "SQL row must be an object");
    }
  });

  // Verifies: recognizes non-empty lists.
  it("recognizes non-empty lists", () => {
    expect(isNonEmptyList(["item"])).toBe(true);
    expect(isNonEmptyList([])).toBe(false);
  });
});
