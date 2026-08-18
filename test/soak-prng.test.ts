/**
 * Focused tests for the soak PRNG and spreadsheet-URL parsing.
 *
 * Determinism is the soak contract: the same seed must reproduce the same
 * stream, and the runner must never print a spreadsheet ID. The URL parser
 * is the single place the live-mode spreadsheet ID is derived; these tests
 * pin the accepted URL shapes and the refusal of secret-looking inputs.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  deriveSeed,
  parseSeed,
  SeededRandom,
} from "../scripts/ci/local-soak/prng.mjs";
import {
  parseSpreadsheetIdFromUrl,
  shouldFallBackToDistOnSourceFailure,
} from "../scripts/ci/local-soak/runner.mjs";

describe("soak PRNG determinism", () => {
  it("reproduces the identical stream for the same seed", () => {
    const first = new SeededRandom(20260814);
    const second = new SeededRandom(20260814);
    const a = Array.from({ length: 50 }, () => first.next());
    const b = Array.from({ length: 50 }, () => second.next());
    expect(a).toEqual(b);
  });

  it("produces different streams for different seeds", () => {
    const a = Array.from({ length: 20 }, () => new SeededRandom(1).next());
    const b = Array.from({ length: 20 }, () => new SeededRandom(2).next());
    expect(a).not.toEqual(b);
  });

  it("bounds int() and pick() to their inputs", () => {
    const rng = new SeededRandom(7);
    for (let index = 0; index < 100; index += 1) {
      const value = rng.int(10);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(10);
    }
    expect(rng.pick(["only"])).toBe("only");
    expect(() => rng.pick([])).toThrow(/non-empty/);
    expect(() => new SeededRandom(1.5)).toThrow(/seed/);
  });

  it("derives child seeds deterministically and within range", () => {
    expect(deriveSeed(20260814, 7)).toBe(deriveSeed(20260814, 7));
    const derived = deriveSeed(20260814, 7);
    expect(Number.isSafeInteger(derived)).toBe(true);
    expect(derived).toBeGreaterThanOrEqual(0);
    expect(derived).toBeLessThanOrEqual(0xffffffff);
  });
});

describe("soak seed parsing", () => {
  it("accepts decimal and hex seeds", () => {
    expect(parseSeed("20260814")).toBe(20260814);
    expect(parseSeed("0x1f")).toBe(31);
  });

  it("applies the documented default when absent", () => {
    expect(parseSeed(undefined)).toBe(0x50414b53);
    expect(parseSeed("")).toBe(0x50414b53);
  });

  it("rejects malformed or out-of-range seeds", () => {
    expect(() => parseSeed("abc")).toThrow(/--seed/);
    expect(() => parseSeed("-1")).toThrow(/--seed/);
    expect(() => parseSeed("4294967296")).toThrow(/--seed/);
  });
});

describe("soak spreadsheet URL parsing", () => {
  it("extracts the ID from documented spreadsheet URL shapes", () => {
    expect(parseSpreadsheetIdFromUrl(
      "https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/edit",
    )).toBe("1AbCdEfGhIjKlMnOpQrStUvWxYz");
    expect(parseSpreadsheetIdFromUrl(
      "https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz",
    )).toBe("1AbCdEfGhIjKlMnOpQrStUvWxYz");
    expect(parseSpreadsheetIdFromUrl(
      "https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/edit#gid=0",
    )).toBe("1AbCdEfGhIjKlMnOpQrStUvWxYz");
  });

  it("returns undefined for non-spreadsheet or malformed URLs", () => {
    expect(parseSpreadsheetIdFromUrl("https://example.com/not-sheets")).toBeUndefined();
    expect(parseSpreadsheetIdFromUrl("https://docs.google.com/spreadsheets/d/")).toBeUndefined();
    expect(parseSpreadsheetIdFromUrl("")).toBeUndefined();
  });

  it("requires HTTPS for schemed URLs but keeps documented scheme-less forms", () => {
    // A schemed URL must be https; a non-https scheme (even with the
    // documented host) must be refused so a hostile or stale env value can
    // never resolve to a spreadsheet target.
    expect(parseSpreadsheetIdFromUrl(
      "ftp://docs.google.com/spreadsheets/d/1AbC",
    )).toBeUndefined();
    expect(parseSpreadsheetIdFromUrl(
      "javascript://docs.google.com/spreadsheets/d/1AbC",
    )).toBeUndefined();
    expect(parseSpreadsheetIdFromUrl(
      "http://docs.google.com/spreadsheets/d/1AbC",
    )).toBeUndefined();
    expect(parseSpreadsheetIdFromUrl(
      "ws://docs.google.com/spreadsheets/d/1AbC/edit",
    )).toBeUndefined();
    // The documented scheme-less form remains supported.
    expect(parseSpreadsheetIdFromUrl(
      "docs.google.com/spreadsheets/d/1AbC/edit",
    )).toBe("1AbC");
    expect(parseSpreadsheetIdFromUrl(
      "https://docs.google.com/spreadsheets/d/1AbC/edit",
    )).toBe("1AbC");
  });

  it("rejects spreadsheet IDs with invalid characters", () => {
    // Only URL-safe base64 ID characters (letters, digits, `-`, `_`) are
    // accepted; whitespace, punctuation, and percent-encoded octets are not.
    expect(parseSpreadsheetIdFromUrl(
      "https://docs.google.com/spreadsheets/d/ab cd",
    )).toBeUndefined();
    expect(parseSpreadsheetIdFromUrl(
      "https://docs.google.com/spreadsheets/d/a+b",
    )).toBeUndefined();
    expect(parseSpreadsheetIdFromUrl(
      "https://docs.google.com/spreadsheets/d/a=b",
    )).toBeUndefined();
    expect(parseSpreadsheetIdFromUrl(
      "https://docs.google.com/spreadsheets/d/a.b",
    )).toBeUndefined();
    expect(parseSpreadsheetIdFromUrl(
      "https://docs.google.com/spreadsheets/d/a%b",
    )).toBeUndefined();
    expect(parseSpreadsheetIdFromUrl(
      "https://docs.google.com/spreadsheets/d/a:b",
    )).toBeUndefined();
    // Encoded slash and query-owned punctuation are also invalid IDs.
    expect(parseSpreadsheetIdFromUrl(
      "https://docs.google.com/spreadsheets/d/a%2Fb",
    )).toBeUndefined();
    // A mixed canary ID with the allowed `-` and `_` still parses.
    expect(parseSpreadsheetIdFromUrl(
      "https://docs.google.com/spreadsheets/d/1AbC-x_9/edit",
    )).toBe("1AbC-x_9");
  });

  it("rejects malformed path prefixes before the d segment", () => {
    // Only the documented host + `d/<ID>` / `spreadsheets/d/<ID>` layouts are
    // accepted. Any arbitrary prefix segment placed before `spreadsheets/d`
    // (or directly before `d`) must be refused rather than scanned for a `d`
    // segment anywhere in the path.
    expect(parseSpreadsheetIdFromUrl(
      "https://docs.google.com/foo/spreadsheets/d/id",
    )).toBeUndefined();
    expect(parseSpreadsheetIdFromUrl(
      "https://docs.google.com/foo/d/id",
    )).toBeUndefined();
    expect(parseSpreadsheetIdFromUrl(
      "https://docs.google.com/bar/baz/spreadsheets/d/id/edit",
    )).toBeUndefined();
    expect(parseSpreadsheetIdFromUrl(
      "https://docs.google.com/spreadsheets/foo/d/id",
    )).toBeUndefined();
    // The documented scheme-less form is still rejected for a bad prefix.
    expect(parseSpreadsheetIdFromUrl(
      "docs.google.com/foo/spreadsheets/d/id",
    )).toBeUndefined();
    // Valid layouts (with and without the parent segment) still resolve.
    expect(parseSpreadsheetIdFromUrl(
      "https://docs.google.com/d/1AbC/edit",
    )).toBe("1AbC");
    expect(parseSpreadsheetIdFromUrl(
      "https://docs.google.com/spreadsheets/d/1AbC/edit",
    )).toBe("1AbC");
  });

  it("rejects unsupported suffix segments after the ID", () => {
    // Only the documented trailing forms are allowed: `/edit` and/or a
    // trailing slash. Any other suffix segment must be refused.
    expect(parseSpreadsheetIdFromUrl(
      "https://docs.google.com/spreadsheets/d/1AbC/extra",
    )).toBeUndefined();
    expect(parseSpreadsheetIdFromUrl(
      "https://docs.google.com/spreadsheets/d/1AbC/print",
    )).toBeUndefined();
    expect(parseSpreadsheetIdFromUrl(
      "https://docs.google.com/d/1AbC/extra",
    )).toBeUndefined();
    expect(parseSpreadsheetIdFromUrl(
      "https://docs.google.com/d/1AbC/edit/extra",
    )).toBeUndefined();
    // Trailing slash and `/edit` (optionally trailed) remain valid.
    expect(parseSpreadsheetIdFromUrl(
      "https://docs.google.com/spreadsheets/d/1AbC/",
    )).toBe("1AbC");
    expect(parseSpreadsheetIdFromUrl(
      "https://docs.google.com/d/1AbC/edit/",
    )).toBe("1AbC");
  });

  it("rejects arbitrary hosts so cleanup can never target an unintended spreadsheet", () => {
    // The documented URL authority is docs.google.com; any other host with a
    // spreadsheet-shaped path must be rejected, never resolved to an id.
    expect(parseSpreadsheetIdFromUrl("https://evil.example/d/id")).toBeUndefined();
    expect(parseSpreadsheetIdFromUrl("https://evil.example/spreadsheets/d/id")).toBeUndefined();
    expect(parseSpreadsheetIdFromUrl("https://attacker.test/spreadsheets/d/id/edit")).toBeUndefined();
    expect(parseSpreadsheetIdFromUrl("http://example.com/d/id")).toBeUndefined();
    expect(parseSpreadsheetIdFromUrl(
      "https://docs.google.com.evil.example/spreadsheets/d/id",
    )).toBeUndefined();
  });

  it("never returns whitespace or query fragments", () => {
    expect(parseSpreadsheetIdFromUrl(
      "https://docs.google.com/spreadsheets/d/ab cd",
    )).toBeUndefined();
    expect(parseSpreadsheetIdFromUrl(
      "https://docs.google.com/spreadsheets/d/a?b=c",
    )).toBe("a");
  });
});

describe("soak source-vs-dist import fallback guard", () => {
  afterEach(() => {
    delete process.env.VITEST;
  });

  it("falls back to dist only outside Vitest (the plain-Node CLI case)", () => {
    // Plain Node CLI: the TS source is never loadable, so a source-load
    // failure is the expected unsupported-TS-loader case and falls back to
    // the built dist module.
    delete process.env.VITEST;
    expect(shouldFallBackToDistOnSourceFailure()).toBe(true);
  });

  it("rethrows source failures under Vitest so a compile error is never masked by stale dist", () => {
    // Vitest always loads the TS source; any failure there is a real source
    // bug and must be rethrown, never silently swapped for a stale dist copy.
    process.env.VITEST = "true";
    expect(shouldFallBackToDistOnSourceFailure()).toBe(false);
  });
});
