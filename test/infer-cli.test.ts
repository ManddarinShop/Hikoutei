/**
 * `hikoutei infer` tests: pure argument parsing, the pure grid inference,
 * the testable flow, and `--emit` descriptor files — all with fake grids
 * and injected readers, no network, no Google credentials (emit touches
 * only temp-dir fixtures).
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  INFER_DEFAULT_LIMIT,
  parseInferArgs,
} from "@hikoutei/cli/inferArgs.js";
import {
  inferFromGrid,
  InferError,
  inferResultToDescriptorFile,
  normalizeInferCell,
  serializeInferDescriptorFile,
  type InferTabGrid,
} from "@hikoutei/cli/infer.js";
import { emitDescriptorFile, extractInferGrid, runInferCli } from "@hikoutei/cli/inferMain.js";
import { resolveEntityDescriptor } from "@hikoutei/contracts/api/entity.js";
import { parseDescriptorFile } from "@hikoutei/contracts/api/descriptorFile.js";

const DATE_FORMAT = 'yyyy"-"mm"-"dd"T"hh:mm:ss.000"Z"';

function headerCell(text: string): unknown {
  return { formattedValue: text };
}

function stringCell(value: string): unknown {
  return { userEnteredValue: { stringValue: value }, formattedValue: value };
}

function numberCell(value: number): unknown {
  return { userEnteredValue: { numberValue: value }, formattedValue: String(value) };
}

function booleanCell(value: boolean): unknown {
  return { userEnteredValue: { boolValue: value }, formattedValue: value ? "TRUE" : "FALSE" };
}

function dateCell(serial: number): unknown {
  return {
    userEnteredValue: { numberValue: serial },
    userEnteredFormat: { numberFormat: { type: "DATE_TIME", pattern: DATE_FORMAT } },
    formattedValue: "2023-01-01",
  };
}

function typedGrid(): InferTabGrid {
  return {
    tabName: "Invoices",
    headerCells: [headerCell("Invoice No"), headerCell("Total"), headerCell("Paid"), headerCell("Since")],
    dataCells: [
      [stringCell("a1"), numberCell(10), booleanCell(true), dateCell(45000)],
      [stringCell("a2"), numberCell(20), booleanCell(false), dateCell(45001)],
    ],
  };
}

function sink(): { text: string; write: (text: string) => void } {
  const state = {
    text: "",
    write: (text: string): void => {
      state.text += text;
    },
  };
  return state;
}

describe("parseInferArgs", () => {
  it("applies the documented defaults", () => {
    const parsed = parseInferArgs(["--tab", "Invoices"]);
    expect(parsed.status).toBe("valid");
    if (parsed.status !== "valid") return;
    expect(parsed.options).toMatchObject({ tabName: "Invoices", limit: INFER_DEFAULT_LIMIT });
    expect(parsed.options.pkHeader).toBeUndefined();
  });

  it("accepts the full flag surface", () => {
    const parsed = parseInferArgs([
      "--tab", "Invoices",
      "--spreadsheet", "https://docs.google.com/spreadsheets/d/x/edit",
      "--pk", "Invoice No",
      "--limit", "10",
      "--credentials", "/path/sa.json",
    ]);
    expect(parsed.status).toBe("valid");
    if (parsed.status !== "valid") return;
    expect(parsed.options).toMatchObject({
      tabName: "Invoices",
      pkHeader: "Invoice No",
      limit: 10,
      credentialsPath: "/path/sa.json",
    });
  });

  it("rejects a missing --tab", () => {
    const parsed = parseInferArgs(["--limit", "10"]);
    expect(parsed.status).toBe("invalid");
  });

  it("rejects bad limits and unknown flags", () => {
    for (const argv of [["--tab", "T", "--limit", "0"], ["--tab", "T", "--limit", "1001"], ["--tab", "T", "--limit", "abc"]]) {
      expect(parseInferArgs(argv).status).toBe("invalid");
    }
    expect(parseInferArgs(["--tab", "T", "--bogus"]).status).toBe("invalid");
  });

  it("answers --help", () => {
    expect(parseInferArgs(["--help"]).status).toBe("help");
    expect(parseInferArgs(["-h"]).status).toBe("help");
  });
});

describe("normalizeInferCell", () => {
  it("normalizes all four scalar kinds with Sheets types winning", () => {
    expect(normalizeInferCell(stringCell("Ada"))).toEqual({ kind: "string", value: "Ada" });
    expect(normalizeInferCell(numberCell(3))).toEqual({ kind: "number", value: 3 });
    expect(normalizeInferCell(booleanCell(true))).toEqual({ kind: "boolean", value: true });
    expect(normalizeInferCell(dateCell(45000))).toMatchObject({ kind: "date" });
  });

  it("treats blanks as null and resolves formulas to effective values", () => {
    expect(normalizeInferCell({})).toBeNull();
    expect(normalizeInferCell(null)).toBeNull();
    expect(normalizeInferCell({ userEnteredValue: { stringValue: "" } })).toBeNull();
    expect(normalizeInferCell({
      userEnteredValue: { formulaValue: "=1+1" },
      effectiveValue: { numberValue: 2 },
    })).toEqual({ kind: "number", value: 2 });
  });
});

describe("inferFromGrid", () => {
  it("emits the expected descriptor snapshot for typed columns", () => {
    const result = inferFromGrid(typedGrid());
    expect(result.tsBlock).toBe(
      [
        `import { defineTypedSheetsEntity } from "hikoutei";`,
        ``,
        `export const Invoices = defineTypedSheetsEntity({`,
        `  name: "Invoices",`,
        `  tableName: "invoices",`,
        `  properties: {`,
        `    // "Invoice No"`,
        `    invoiceNo: { type: "string", primary: true },`,
        `    // "Total"`,
        `    total: { type: "number" },`,
        `    // "Paid"`,
        `    paid: { type: "boolean" },`,
        `    // "Since"`,
        `    since: { type: "date" },`,
        `  },`,
        `});`,
      ].join("\n"),
    );
    expect(result.distribution).toEqual({ string: 1, number: 1, boolean: 1, date: 1 });
    expect(result.sampledRows).toBe(2);
    expect(result.pkProperty).toBe("invoiceNo");
    expect(result.summary).toContain('Tab "Invoices": 2 sampled rows, 4 columns.');
  });

  it("emits a descriptor the entity contract accepts", () => {
    const result = inferFromGrid(typedGrid());
    const descriptor = evaluateDescriptorBlock(result.tsBlock, result.entityName);
    expect(() => resolveEntityDescriptor(descriptor)).not.toThrow();
    expect(resolveEntityDescriptor(descriptor).primaryKey).toBe("invoiceNo");
  });

  it("defaults empty and mixed columns to string with column-name-only warnings", () => {
    const grid: InferTabGrid = {
      tabName: "T",
      headerCells: [headerCell("Id"), headerCell("Notes"), headerCell("Mix")],
      dataCells: [
        [stringCell("SECRET-VALUE-9"), {}, stringCell("x")],
        [stringCell("b"), {}, numberCell(1)],
      ],
    };
    const result = inferFromGrid(grid);
    expect(result.tsBlock).toContain(`notes: { type: "string" }`);
    expect(result.tsBlock).toContain(`mix: { type: "string" }`);
    expect(result.warnings.map((warning) => warning.column).sort()).toEqual(["Mix", "Notes"]);
    expect(result.tsBlock).not.toContain("SECRET-VALUE-9");
    expect(result.summary).not.toContain("SECRET-VALUE-9");
  });

  it("keeps the emitted block valid when a header contains a line break", () => {
    const grid: InferTabGrid = {
      tabName: "T",
      headerCells: [headerCell("Invoice\nNo"), headerCell("Bad\r\nHeader")],
      dataCells: [[stringCell("a"), stringCell("b")]],
    };
    const result = inferFromGrid(grid);
    expect(result.tsBlock).toContain(`// "Invoice No"`);
    expect(result.tsBlock).toContain(`// "Bad Header"`);
    const descriptor = evaluateDescriptorBlock(result.tsBlock, result.entityName);
    expect(() => resolveEntityDescriptor(descriptor)).not.toThrow();
    expect(descriptor.properties.invoiceNo).toBeDefined();
  });

  it("suffixes duplicate and colliding headers and sanitizes special chars", () => {
    const grid: InferTabGrid = {
      tabName: "T",
      headerCells: [headerCell("Name"), headerCell("Name"), headerCell("Invoice No."), headerCell("총액"), headerCell("123abc")],
      dataCells: [[stringCell("a"), stringCell("b"), stringCell("c"), stringCell("d"), stringCell("e")]],
    };
    const result = inferFromGrid(grid);
    expect(result.tsBlock).toContain(`name: { type: "string", primary: true }`);
    expect(result.tsBlock).toContain(`name2: { type: "string" }`);
    expect(result.tsBlock).toContain(`invoiceNo: { type: "string" }`);
    expect(result.tsBlock).toContain(`field4: { type: "string" }`);
    expect(result.tsBlock).toContain(`abc: { type: "string" }`);
  });

  it("honors the --pk override and coerces a non-string/number PK to string", () => {
    const byHeader = inferFromGrid(typedGrid(), { pkHeader: "Total" });
    expect(byHeader.pkProperty).toBe("total");
    expect(byHeader.tsBlock).toContain(`total: { type: "number", primary: true },`);

    const coerced = inferFromGrid(typedGrid(), { pkHeader: "Paid" });
    expect(coerced.pkProperty).toBe("paid");
    expect(coerced.tsBlock).toContain(`paid: { type: "string", primary: true },`);
    expect(coerced.warnings.some((warning) => warning.column === "Paid")).toBe(true);
  });

  it("fails closed on an empty tab and an unknown PK header", () => {
    expect(() => inferFromGrid({ tabName: "T", headerCells: [], dataCells: [] }))
      .toThrowError(InferError);
    expect(() => inferFromGrid({ tabName: "T", headerCells: [{ formattedValue: "  " }], dataCells: [] }))
      .toThrowError(/no header row/);
    expect(() => inferFromGrid(typedGrid(), { pkHeader: "Nope" }))
      .toThrowError(/names no column/);
  });
});

describe("runInferCli", () => {
  const env = {
    HIKOUTEI_SYNC_SPREADSHEET_URL: "https://docs.google.com/spreadsheets/d/abc123/edit",
    GOOGLE_APPLICATION_CREDENTIALS: "/path/sa.json",
  };

  it("prints the block plus summary on stdout", async () => {
    const output = sink();
    const error = sink();
    const code = await runInferCli({
      options: { tabName: "Invoices", limit: 100, force: false },
      env,
      reader: async () => typedGrid(),
      output,
      error,
    });
    expect(code).toBe(0);
    expect(output.text).toContain(`export const Invoices = defineTypedSheetsEntity({`);
    expect(output.text).toContain('Tab "Invoices": 2 sampled rows, 4 columns.');
    expect(error.text).toBe("");
  });

  it("reports missing credentials with the setup pointer", async () => {
    const output = sink();
    const error = sink();
    const code = await runInferCli({
      options: { tabName: "Invoices", limit: 100, force: false },
      env: { HIKOUTEI_SYNC_SPREADSHEET_URL: env.HIKOUTEI_SYNC_SPREADSHEET_URL },
      reader: async () => typedGrid(),
      output,
      error,
    });
    expect(code).toBe(1);
    expect(error.text).toContain("hikoutei-infer:missing_credentials:");
    expect(error.text).toContain("npx hikoutei setup");
  });

  it("exits 2 without a spreadsheet URL and maps reader failures", async () => {
    const output = sink();
    const error = sink();
    const missing = await runInferCli({
      options: { tabName: "Invoices", limit: 100, force: false },
      env: { GOOGLE_APPLICATION_CREDENTIALS: "/path/sa.json" },
      reader: async () => typedGrid(),
      output,
      error,
    });
    expect(missing).toBe(2);

    const notFound = await runInferCli({
      options: { tabName: "Missing", limit: 100, force: false },
      env,
      reader: async () => { throw new InferError("tab_not_found", `Tab "Missing" was not found in the spreadsheet.`); },
      output: sink(),
      error,
    });
    expect(notFound).toBe(1);
    expect(error.text).toContain("hikoutei-infer:tab_not_found:");

    const badUrl = await runInferCli({
      options: { tabName: "T", limit: 100, spreadsheetUrl: "not a url", force: false },
      env,
      reader: async () => typedGrid(),
      output: sink(),
      error: sink(),
    });
    expect(badUrl).toBe(1);
  });
});

describe("extractInferGrid", () => {
  it("finds the tab grid and rejects unknown or headerless tabs", () => {
    const data = {
      sheets: [{
        properties: { title: "Invoices" },
        data: [{ rowData: [{ values: [headerCell("A")] }, { values: [stringCell("x")] }] }],
      }],
    };
    const grid = extractInferGrid(data, "Invoices", 100);
    expect(grid.headerCells).toHaveLength(1);
    expect(grid.dataCells).toHaveLength(1);

    expect(() => extractInferGrid({ sheets: [] }, "Invoices", 100)).toThrowError(/not found/);
    expect(() => extractInferGrid({ sheets: [{ properties: { title: "Other" }, data: [] }] }, "Invoices", 100))
      .toThrowError(/not found/);
    expect(() => extractInferGrid({ sheets: [{ properties: { title: "Invoices" }, data: [] }] }, "Invoices", 100))
      .toThrowError(/no header row/);
  });
});

/**
 * Executes the printed block against a capturing `defineTypedSheetsEntity`
 * stub (the block is annotation-free, so it runs as plain JavaScript) and
 * returns the descriptor the stub received.
 */
function evaluateDescriptorBlock(block: string, entityName: string): Parameters<typeof resolveEntityDescriptor>[0] {
  // Drop the import line: the stub arrives as a function parameter instead.
  const runnable = block
    .split("\n")
    .filter((line) => !line.startsWith("import "))
    .join("\n")
    .replace("export const", "const");
  const factory = new Function(
    "defineTypedSheetsEntity",
    `${runnable}\nreturn ${entityName};`,
  ) as (stub: (input: unknown) => { descriptor: unknown }) => { descriptor: unknown };
  const token = factory((input: unknown) => ({ descriptor: input }));
  return token.descriptor as Parameters<typeof resolveEntityDescriptor>[0];
}

describe("parseInferArgs --emit/--force", () => {
  it("defaults to no emission without overwriting", () => {
    const parsed = parseInferArgs(["--tab", "Invoices"]);
    expect(parsed.status).toBe("valid");
    if (parsed.status !== "valid") return;
    expect(parsed.options.emitPath).toBeUndefined();
    expect(parsed.options.force).toBe(false);
  });

  it("accepts --emit with --force", () => {
    const parsed = parseInferArgs(["--tab", "Invoices", "--emit", "desc.json", "--force"]);
    expect(parsed.status).toBe("valid");
    if (parsed.status !== "valid") return;
    expect(parsed.options.emitPath).toBe("desc.json");
    expect(parsed.options.force).toBe(true);
  });

  it("rejects a missing or empty --emit value", () => {
    expect(parseInferArgs(["--tab", "T", "--emit"]).status).toBe("invalid");
    expect(parseInferArgs(["--tab", "T", "--emit", "  "]).status).toBe("invalid");
  });
});

describe("inferResultToDescriptorFile", () => {
  it("builds the versioned JSON form with preserved headers", () => {
    const file = inferResultToDescriptorFile(inferFromGrid(typedGrid()));
    expect(file).toEqual({
      hikouteiDescriptor: 1,
      name: "Invoices",
      tableName: "invoices",
      properties: {
        invoiceNo: { header: "Invoice No", type: "string", primary: true },
        total: { header: "Total", type: "number" },
        paid: { header: "Paid", type: "boolean" },
        since: { header: "Since", type: "date" },
      },
    });
    // The file's scalar core satisfies the same contract as the block.
    expect(() => parseDescriptorFile(file)).not.toThrow();
    expect(serializeInferDescriptorFile(inferFromGrid(typedGrid()))).toBe(
      `${JSON.stringify(file, null, 2)}\n`,
    );
  });

  it("agrees with the printed block column-for-column", () => {
    const result = inferFromGrid(typedGrid());
    for (const column of result.columns) {
      expect(result.tsBlock).toContain(`${column.property}: { type: "${column.type}"`);
    }
    expect(result.columns.find((column) => column.primary)?.property).toBe(result.pkProperty);
  });
});

describe("emitDescriptorFile", () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "hikoutei-infer-"));
    tempDirs.push(dir);
    return dir;
  }

  it("writes the file and refuses to overwrite without --force", async () => {
    const path = join(tempDir(), "desc.json");
    await emitDescriptorFile(path, '{}\n', { force: false });
    expect(readFileSync(path, "utf8")).toBe('{}\n');
    await expect(emitDescriptorFile(path, '{}\n', { force: false }))
      .rejects.toMatchObject({ name: "InferError", code: "emit_exists" });
    await emitDescriptorFile(path, '{"a":1}\n', { force: true });
    expect(readFileSync(path, "utf8")).toBe('{"a":1}\n');
  });

  it("fails with a stable code when the parent directory is missing", async () => {
    await expect(
      emitDescriptorFile(join(tempDir(), "nope", "desc.json"), '{}\n', { force: false }),
    ).rejects.toMatchObject({ name: "InferError", code: "emit_parent_missing" });
  });

  it("never echoes the path in the error message", async () => {
    const path = join(tempDir(), "desc.json");
    writeFileSync(path, "x");
    const error = await emitDescriptorFile(path, "y", { force: false }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(InferError);
    expect((error as Error).message).not.toContain("desc.json");
  });
});

describe("runInferCli --emit", () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const env = {
    HIKOUTEI_SYNC_SPREADSHEET_URL: "https://docs.google.com/spreadsheets/d/abc123/edit",
    GOOGLE_APPLICATION_CREDENTIALS: "/path/sa.json",
  };

  it("keeps the stdout contract and writes a registrable descriptor file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hikoutei-infer-"));
    tempDirs.push(dir);
    const path = join(dir, "desc.json");
    const output = sink();
    const error = sink();
    const code = await runInferCli({
      options: { tabName: "Invoices", limit: 100, force: false, emitPath: path },
      env,
      reader: async () => typedGrid(),
      output,
      error,
    });
    expect(code).toBe(0);
    // Stdout contract unchanged: block + summary, no file chatter.
    expect(output.text).toContain(`export const Invoices = defineTypedSheetsEntity({`);
    expect(output.text).toContain('Tab "Invoices": 2 sampled rows, 4 columns.');
    expect(error.text).toBe("");
    // The emitted file parses through the same contract startup uses.
    const file = parseDescriptorFile(JSON.parse(readFileSync(path, "utf8")));
    expect(file.name).toBe("Invoices");
    expect(resolveEntityDescriptor({
      name: file.name,
      tableName: file.tableName,
      properties: Object.fromEntries(
        Object.entries(file.properties).map(([property, entry]) => [
          property,
          { type: entry.type, ...(entry.primary === true ? { primary: true } : {}) },
        ]),
      ),
    }).primaryKey).toBe("invoiceNo");
  });

  it("reports an existing emit target with a stable code and exit 1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hikoutei-infer-"));
    tempDirs.push(dir);
    const path = join(dir, "desc.json");
    writeFileSync(path, "{}");
    const error = sink();
    const code = await runInferCli({
      options: { tabName: "Invoices", limit: 100, force: false, emitPath: path },
      env,
      reader: async () => typedGrid(),
      output: sink(),
      error,
    });
    expect(code).toBe(1);
    expect(error.text).toContain("hikoutei-infer:emit_exists:");
  });
});
