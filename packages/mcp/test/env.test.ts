/**
 * Tests for the minimal `.env` gap-fill loader.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadEnvFile, parseEnvFileContent } from "../src/env.js";

describe("hikoutei-mcp env loader", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function writeEnv(content: string): string {
    const dir = mkdtempSync(join(tmpdir(), "hikoutei-mcp-env-"));
    tempDirs.push(dir);
    const path = join(dir, ".env");
    writeFileSync(path, content);
    return path;
  }

  it("parses comments, blank lines, spacing, and quotes", () => {
    expect(parseEnvFileContent(`
# managed by hikoutei setup
GOOGLE_APPLICATION_CREDENTIALS=/tmp/sa.json

  HIKOUTEI_SYNC_SPREADSHEET_URL = https://docs.google.com/spreadsheets/d/x/edit
QUOTED="  padded  "
SINGLE='value'
EMPTY=
`)).toEqual({
      GOOGLE_APPLICATION_CREDENTIALS: "/tmp/sa.json",
      HIKOUTEI_SYNC_SPREADSHEET_URL: "https://docs.google.com/spreadsheets/d/x/edit",
      QUOTED: "  padded  ",
      SINGLE: "value",
      EMPTY: "",
    });
  });

  it("skips malformed lines without failing the whole file", () => {
    expect(parseEnvFileContent("no-equals-line\n=noname\nA=1")).toEqual({ A: "1" });
  });

  it("fills gaps but never overrides existing process values", async () => {
    const path = writeEnv("A=set-by-file\nB=set-by-file\n");
    const target: Record<string, string | undefined> = { A: "set-by-process" };
    const result = await loadEnvFile(path, target);
    expect(result.applied).toBe(1);
    expect(result.skipped).toEqual(["A"]);
    expect(target).toEqual({ A: "set-by-process", B: "set-by-file" });
  });

  it("treats a missing file as zero applied, not an error", async () => {
    const result = await loadEnvFile(join(tmpdir(), "definitely-absent.env"), {});
    expect(result).toEqual({ applied: 0, skipped: [] });
  });
});
