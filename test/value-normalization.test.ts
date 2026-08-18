/**
 * Focused regression coverage for the Sheets date-serial normalization
 * contract.
 *
 * A direct-live soak run surfaced a `visible_guard_mismatch` on a generated
 * FeatureFlag delete: the provider's conflict effect expected the pre-delete
 * System_State row, but the sheet row differed in `updatedAt` by a
 * sub-millisecond/millisecond date-serial round-trip drift. `dateSerialFromIso`
 * divides the canonical epoch milliseconds by 86_400_000, and multiplying the
 * resulting floating-point serial back can land a hair below the exact
 * millisecond, which the Date truncation then renders one millisecond earlier.
 * `isoFromDateSerial` now rounds the computed epoch milliseconds to the
 * nearest integer millisecond so the conversion is the identity for every
 * canonical ISO timestamp while the serial wire output stays unchanged.
 */

import { describe, expect, it } from "vitest";

import {
  dateSerialFromIso,
  isoFromDateSerial,
} from "../src/adapter/sheets/providers/google-sheets-api/model/valueNormalization.js";

const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);

describe("date serial round-trip normalization", () => {
  it("survives a date with non-zero milliseconds exactly", () => {
    // 2024-03-15T00:00:00.002Z is the drift case found in the live soak
    // class: its serial is a hair below the true day fraction, so the
    // unrounded conversion truncated to 00:00:00.001Z. Rounding recovers
    // the exact canonical millisecond.
    for (const iso of [
      "2024-03-15T00:00:00.002Z",
      "2024-03-15T10:30:00.123Z",
      "2024-01-15T00:00:00.789Z",
      "2025-07-04T23:59:59.999Z",
    ]) {
      expect(isoFromDateSerial(dateSerialFromIso(iso))).toBe(iso);
    }
  });

  it("preserves exact whole-second and whole-day dates", () => {
    // Dates whose serial is an exact binary fraction must keep their exact
    // canonical rendering (the existing provider tests rely on these).
    for (const iso of [
      "2024-03-15T10:30:00.000Z",
      "2024-03-15T00:00:00.000Z",
      "2024-06-01T12:00:00.000Z",
      "2026-01-02T03:04:05.000Z",
    ]) {
      expect(isoFromDateSerial(dateSerialFromIso(iso))).toBe(iso);
    }
  });

  it("keeps the serial wire output unchanged", () => {
    // The wire serial is the Excel 1900-system day offset; rounding is
    // applied only on the read-back conversion, never on writes.
    expect(dateSerialFromIso("2024-03-15T10:30:00.000Z")).toBe(
      (Date.parse("2024-03-15T10:30:00.000Z") - EXCEL_EPOCH_MS) / 86_400_000,
    );
    expect(dateSerialFromIso("2024-03-15T00:00:00.002Z")).toBe(
      (Date.parse("2024-03-15T00:00:00.002Z") - EXCEL_EPOCH_MS) / 86_400_000,
    );
  });

  it("fails on invalid serials exactly like the unrounded conversion", () => {
    // NaN and non-finite serials still produce an invalid Date whose
    // toISOString() throws a RangeError; rounding must not mask that.
    for (const serial of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => isoFromDateSerial(serial)).toThrow(RangeError);
    }
  });
});
