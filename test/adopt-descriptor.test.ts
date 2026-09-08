/**
 * `hikoutei adopt --descriptor` tests (issue #514 work item 4).
 *
 * Covers the file alternative to `--entity`: argument parsing, descriptor
 * loading (missing/unparseable/version-mismatched/duplicate), the
 * header→property columnMap derivation with `--map` precedence, and the
 * emit→file→adopt chain — all with temp-dir fixtures and a fake runner, no
 * network, no Google credentials.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseAdoptArgs } from "@hikoutei/cli/adoptArgs.js";
import {
  runAdoptCli,
  type AdoptRunner,
  type AdoptRunnerInput,
} from "@hikoutei/cli/adoptFlow.js";
import { loadDescriptorAdoption } from "@hikoutei/cli/adoptMain.js";
import {
  inferFromGrid,
  serializeInferDescriptorFile,
  type InferTabGrid,
} from "@hikoutei/cli/infer.js";
import { defineTypedSheetsEntity } from "../src/index.js";
import type { TypedSheetsWithSyncResult } from "../src/index.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "hikoutei-adopt-desc-"));
  tempDirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

/** Descriptor JSON fixture mirroring an `infer --emit` file. */
function descriptorJson(name = "AdoptDescWidget"): string {
  return JSON.stringify({
    hikouteiDescriptor: 1,
    name,
    tableName: "adopt_desc_widgets",
    properties: {
      widgetNo: { header: "Widget No", type: "string", primary: true },
      total: { header: "Total", type: "number" },
    },
  });
}

function headerCell(text: string): unknown {
  return { formattedValue: text };
}

function stringCell(value: string): unknown {
  return { userEnteredValue: { stringValue: value }, formattedValue: value };
}

function numberCell(value: number): unknown {
  return { userEnteredValue: { numberValue: value }, formattedValue: String(value) };
}

function typedGrid(): InferTabGrid {
  return {
    tabName: "Widgets",
    headerCells: [headerCell("Widget No"), headerCell("Total")],
    dataCells: [
      [stringCell("w1"), numberCell(10)],
      [stringCell("w2"), numberCell(20)],
    ],
  };
}

describe("parseAdoptArgs --descriptor", () => {
  it("accepts --descriptor with --tab and no --entity", () => {
    const parsed = parseAdoptArgs(["--descriptor", "desc.json", "--tab", "Widgets"]);
    expect(parsed.status).toBe("valid");
    if (parsed.status !== "valid") return;
    expect(parsed.options.descriptorPath).toBe("desc.json");
    expect(parsed.options.entityName).toBeUndefined();
    expect(parsed.options.tabName).toBe("Widgets");
  });

  it("rejects --descriptor mixed with --entity or --adopt", () => {
    expect(
      parseAdoptArgs(["--descriptor", "d.json", "--entity", "W", "--tab", "T"]).status,
    ).toBe("invalid");
    expect(
      parseAdoptArgs(["--descriptor", "d.json", "--tab", "T", "--adopt", "W=T"]).status,
    ).toBe("invalid");
  });

  it("still requires --tab and rejects an empty path", () => {
    expect(parseAdoptArgs(["--descriptor", "d.json"]).status).toBe("invalid");
    expect(parseAdoptArgs(["--tab", "T"]).status).toBe("invalid");
    expect(parseAdoptArgs(["--descriptor", "  ", "--tab", "T"]).status).toBe("invalid");
  });

  it("allows adopt mode with --descriptor and no --entities module", () => {
    const parsed = parseAdoptArgs([
      "--descriptor", "desc.json", "--tab", "Widgets", "--mode", "adopt", "--yes",
    ]);
    expect(parsed.status).toBe("valid");
  });

  it("still requires --entities in adopt mode without --descriptor", () => {
    expect(
      parseAdoptArgs(["--entity", "W", "--tab", "T", "--mode", "adopt"]).status,
    ).toBe("invalid");
  });
});

describe("loadDescriptorAdoption", () => {
  it("resolves the entity name, columnMap, and token from the file", async () => {
    const path = tempFile("desc.json", descriptorJson("AdoptDescBasic"));
    const resolved = await loadDescriptorAdoption({
      descriptorPath: path,
      tabName: "Widgets",
      identityFrom: "auto",
      mode: "dry-run",
      db: "./hikoutei.sqlite",
      yes: true,
      json: false,
    });
    expect(resolved.entityName).toBe("AdoptDescBasic");
    expect(resolved.columnMap).toEqual({ "Widget No": "widgetNo", Total: "total" });
    expect(resolved.entities).toHaveLength(1);
  });

  it("gives an explicit --map precedence over the file headers", async () => {
    const path = tempFile("desc.json", descriptorJson("AdoptDescMapWins"));
    const resolved = await loadDescriptorAdoption({
      descriptorPath: path,
      tabName: "Widgets",
      identityFrom: "auto",
      mode: "dry-run",
      db: "./hikoutei.sqlite",
      yes: true,
      json: false,
      columnMap: { Total: "amount" },
    });
    expect(resolved.columnMap).toEqual({ "Widget No": "widgetNo", Total: "amount" });
  });

  it("fails stable on a missing, unparseable, or version-mismatched file", async () => {
    const base = {
      tabName: "Widgets",
      identityFrom: "auto",
      mode: "dry-run",
      db: "./hikoutei.sqlite",
      yes: true,
      json: false,
    } as const;
    await expect(
      loadDescriptorAdoption({ ...base, descriptorPath: join(tmpdir(), "hikoutei-adopt-desc-missing.json") }),
    ).rejects.toMatchObject({ code: "invalid_entity_descriptor" });
    await expect(
      loadDescriptorAdoption({ ...base, descriptorPath: tempFile("bad.json", "{ not json") }),
    ).rejects.toMatchObject({ code: "invalid_entity_descriptor" });
    await expect(
      loadDescriptorAdoption({
        ...base,
        descriptorPath: tempFile("v2.json", descriptorJson().replace('"hikouteiDescriptor":1', '"hikouteiDescriptor":2')),
      }),
    ).rejects.toMatchObject({ code: "invalid_entity_descriptor" });
  });

  it("fails stable when the descriptor name is already registered", async () => {
    defineTypedSheetsEntity({
      name: "AdoptDescDupe",
      tableName: "adopt_desc_dupe",
      properties: { id: { type: "string", primary: true } },
    });
    const path = tempFile("dupe.json", descriptorJson("AdoptDescDupe"));
    await expect(
      loadDescriptorAdoption({
        descriptorPath: path,
        tabName: "Widgets",
        identityFrom: "auto",
        mode: "dry-run",
        db: "./hikoutei.sqlite",
        yes: true,
        json: false,
      }),
    ).rejects.toMatchObject({ code: "duplicate_entity" });
  });
});

describe("emit → file → adopt chain", () => {
  it("dry-runs READY with the file-derived spec through a fake runner", async () => {
    // Step 1: `infer --emit` (pure grid → JSON file, no credentials).
    const json = serializeInferDescriptorFile(inferFromGrid(typedGrid()));
    const path = tempFile("widgets.desc.json", json);

    // Step 2: `adopt --descriptor` resolves name + columnMap + token.
    const resolved = await loadDescriptorAdoption({
      descriptorPath: path,
      tabName: "Widgets",
      identityFrom: "auto",
      mode: "dry-run",
      db: "./hikoutei.sqlite",
      yes: true,
      json: false,
    });
    expect(resolved.entityName).toBe("Widgets");

    const seen: AdoptRunnerInput[] = [];
    const runner: AdoptRunner = async (input) => {
      seen.push(input);
      return {
        kind: "adopt-dry-run",
        report: {
          mode: "dry-run",
          ok: true,
          entities: [{
            entityName: resolved.entityName,
            tabName: "Widgets",
            status: "ready",
            sheetHeaders: ["Widget No", "Total"],
            totalRows: 2,
            emptyRows: 0,
            bindings: [
              { field: "widgetNo", columnIndex: 0, columnLetter: "A", header: "Widget No" },
              { field: "total", columnIndex: 1, columnLetter: "B", header: "Total" },
            ],
            ignoredColumns: [],
            missingFields: [],
            contiguity: "contiguous",
            segments: [{ startColumnIndex: 0, endColumnIndex: 1 }],
            pk: { source: "existing-column", column: "Widget No" },
            columnsToBeAdded: ["__hikoutei_row_id"],
            tabsToProvision: ["Widgets_System", "Widgets_Conflicts"],
            problems: [],
          }],
        },
      } as unknown as TypedSheetsWithSyncResult;
    };

    const stdout: string[] = [];
    const code = await runAdoptCli({
      options: {
        entityName: resolved.entityName,
        tabName: "Widgets",
        identityFrom: "auto",
        mode: "dry-run",
        db: "./hikoutei.sqlite",
        yes: true,
        json: false,
        columnMap: resolved.columnMap,
      },
      entities: resolved.entities,
      runner,
      input: (async function* () {})(),
      output: { write: (text: string) => { stdout.push(text); } },
      error: { write: () => undefined },
    });
    expect(code).toBe(0);
    expect(stdout.join("")).toContain("READY");
    expect(seen).toHaveLength(1);
    // The file headers ride into adopt's mapping machinery untouched.
    expect(seen[0]!.spec.entities.Widgets).toMatchObject({
      tabName: "Widgets",
      columnMap: { "Widget No": "widgetNo", Total: "total" },
    });
    expect(seen[0]!.entities).toEqual(resolved.entities);
  });
});
