/**
 * `hikoutei infer` tests: pure argument parsing, the pure grid inference,
 * and the testable flow — all with fake grids and injected readers, no
 * network, no filesystem, no Google credentials.
 */

import { describe, expect, it } from "vitest";

import {
  INFER_DEFAULT_LIMIT,
  parseInferArgs,
} from "@hikoutei/cli/inferArgs.js";
import {
  inferFromGrid,
  InferError,
  normalizeInferCell,
  type InferTabGrid,
} from "@hikoutei/cli/infer.js";
import { extractInferGrid, runInferCli } from "@hikoutei/cli/inferMain.js";
import { resolveEntityDescriptor } from "@hikoutei/contracts/api/entity.js";

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
      options: { tabName: "Invoices", limit: 100 },
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
      options: { tabName: "Invoices", limit: 100 },
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
      options: { tabName: "Invoices", limit: 100 },
      env: { GOOGLE_APPLICATION_CREDENTIALS: "/path/sa.json" },
      reader: async () => typedGrid(),
      output,
      error,
    });
    expect(missing).toBe(2);

    const notFound = await runInferCli({
      options: { tabName: "Missing", limit: 100 },
      env,
      reader: async () => { throw new InferError("tab_not_found", `Tab "Missing" was not found in the spreadsheet.`); },
      output: sink(),
      error,
    });
    expect(notFound).toBe(1);
    expect(error.text).toContain("hikoutei-infer:tab_not_found:");

    const badUrl = await runInferCli({
      options: { tabName: "T", limit: 100, spreadsheetUrl: "not a url" },
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
