/**
 * `hikoutei adopt` CLI tests: pure argument parsing, the testable flow
 * (report rendering, confirmation, exit codes), and the bin router's
 * subcommand dispatch — all with injected runners and sinks, no network,
 * no filesystem, no entity registry.
 */

import { describe, expect, it } from "vitest";

import {
  ADOPT_HELP_TEXT,
  parseAdoptArgs,
} from "../src/cli/adoptArgs.js";
import {
  ADOPT_RUNTIME_ERROR_EXIT_CODE,
  ADOPT_SUCCESS_EXIT_CODE,
  renderAdoptionReport,
  runAdoptCli,
  type AdoptRunner,
  type AdoptRunnerInput,
} from "../src/cli/adoptFlow.js";
import { defineTypedSheetsEntity } from "../src/index.js";
import type {
  AdoptionEntityReport,
  TypedSheetsWithSyncResult,
} from "../src/index.js";

/** Minimal registered entity fixture for flow tests. */
const CliProbe = defineTypedSheetsEntity({
  name: "AdoptCliProbe",
  tableName: "adopt_cli_probe",
  properties: {
    invoiceNo: { type: "string", primary: true },
    customer: { type: "string" },
  },
});

function baseArgv(extra: readonly string[] = []): string[] {
  return ["--entity", "Invoice", "--tab", "Invoices", ...extra];
}

describe("parseAdoptArgs", () => {
  it("applies the documented defaults", () => {
    const parsed = parseAdoptArgs(baseArgv());
    expect(parsed.status).toBe("valid");
    if (parsed.status !== "valid") return;
    expect(parsed.options).toMatchObject({
      entityName: "Invoice",
      tabName: "Invoices",
      identityFrom: "auto",
      mode: "dry-run",
      yes: false,
      json: false,
    });
  });

  it("accepts the full flag surface", () => {
    const parsed = parseAdoptArgs([
      "--entity", "Invoice",
      "--tab", "Invoices",
      "--mode", "adopt",
      "--entities", "./dist/entities.js",
      "--identity-from", "InvoiceNo",
      "--system-tab", "Ledger_State",
      "--conflicts-tab", "Ledger_Conflicts",
      "--db", "/tmp/app.sqlite",
      "--spreadsheet-url", "https://docs.google.com/spreadsheets/d/x/edit",
      "--credentials", "/path/sa.json",
      "--yes",
      "--json",
    ]);
    expect(parsed.status).toBe("valid");
    if (parsed.status !== "valid") return;
    expect(parsed.options.mode).toBe("adopt");
    expect(parsed.options.entitiesModule).toBe("./dist/entities.js");
    expect(parsed.options.identityFrom).toBe("InvoiceNo");
    expect(parsed.options.systemTabName).toBe("Ledger_State");
    expect(parsed.options.conflictsTabName).toBe("Ledger_Conflicts");
    expect(parsed.options.yes).toBe(true);
    expect(parsed.options.json).toBe(true);
  });

  it("rejects unknown flags, missing values, and missing required flags", () => {
    expect(parseAdoptArgs(["--wat"]).status).toBe("invalid");
    expect(parseAdoptArgs(["--entity"]).status).toBe("invalid");
    expect(parseAdoptArgs(["--tab", "Invoices"]).status).toBe("invalid");
  });

  it("rejects an invalid --mode value", () => {
    const parsed = parseAdoptArgs([...baseArgv(), "--mode", "yolo"]);
    expect(parsed.status).toBe("invalid");
  });

  it("requires --entities in adopt mode but not in dry-run mode", () => {
    const adopt = parseAdoptArgs([...baseArgv(), "--mode", "adopt"]);
    expect(adopt.status).toBe("invalid");
    const dryRun = parseAdoptArgs(baseArgv());
    expect(dryRun.status).toBe("valid");
  });

  it("shows help on -h/--help", () => {
    for (const flag of ["-h", "--help"]) {
      const parsed = parseAdoptArgs([flag]);
      expect(parsed).toMatchObject({ status: "help", helpText: ADOPT_HELP_TEXT });
    }
  });
});

function readyEntityReport(): AdoptionEntityReport {
  return {
    entityName: "Invoice",
    tabName: "Invoices",
    status: "ready",
    sheetHeaders: ["memo", "invoiceNo", "customer", "total", ""],
    totalRows: 20,
    emptyRows: 0,
    bindings: [
      { field: "invoiceNo", columnIndex: 1, columnLetter: "B", header: "invoiceNo" },
      { field: "customer", columnIndex: 2, columnLetter: "C", header: "customer" },
      { field: "total", columnIndex: 3, columnLetter: "D", header: "total" },
    ],
    ignoredColumns: [{ columnLetter: "A", header: "memo" }],
    missingFields: [],
    contiguity: "contiguous",
    segments: [{ startColumnIndex: 1, endColumnIndex: 3 }],
    pk: { source: "existing-column", column: "invoiceNo" },
    columnsToBeAdded: ["__hikoutei_row_id"],
    tabsToProvision: ["Invoices_System", "Invoices_Conflicts"],
    problems: [],
  };
}

function blockedEntityReport(): AdoptionEntityReport {
  return {
    ...readyEntityReport(),
    status: "blocked",
    problems: [{
      severity: "error",
      code: "IDENTITY_ALIAS_UNSUPPORTED",
      message: "adoption MVP requires the identity header to equal the PK property name.",
    }],
  } as AdoptionEntityReport;
}

// The report union shape: the flow reads entities[0] + report.ok.
function dryRunResult(entity: AdoptionEntityReport, ok: boolean): TypedSheetsWithSyncResult {
  return { kind: "adopt-dry-run", report: { mode: "dry-run", ok, entities: [entity] } };
}

function runnerReturning(result: TypedSheetsWithSyncResult): { runner: AdoptRunner; calls: AdoptRunnerInput[] } {
  const calls: AdoptRunnerInput[] = [];
  return { calls, runner: async (input) => { calls.push(input); return result; } };
}

function runnerThrowing(error: unknown): AdoptRunner {
  return async () => { throw error; };
}

function sinks(stdout: string[], stderr: string[] = []) {
  return {
    input: (async function* () { /* no input in tests unless pushed */ })(),
    output: { write: (text: string) => { stdout.push(text); } },
    error: { write: (text: string) => { stderr.push(text); } },
  };
}

describe("renderAdoptionReport", () => {
  it("renders a ready report with bindings, ignored columns, and next step", () => {
    const text = renderAdoptionReport(readyEntityReport(), true);
    expect(text).toContain("READY");
    expect(text).toContain("invoiceNo → B");
    expect(text).toContain("A (memo)");
    expect(text).toContain('existing column "invoiceNo"');
    expect(text).toContain("(none)");
    expect(text).toContain("--mode adopt");
  });

  it("renders blocked reports with the problem list", () => {
    const text = renderAdoptionReport(blockedEntityReport(), false);
    expect(text).toContain("BLOCKED");
    expect(text).toContain("IDENTITY_ALIAS_UNSUPPORTED");
  });
});

describe("runAdoptCli", () => {
  const baseOptions = {
    entityName: "Invoice",
    tabName: "Invoices",
    identityFrom: "auto" as const,
    mode: "dry-run" as const,
    db: "./hikoutei.sqlite",
    yes: true,
    json: false,
  };

  it("dry-run: renders the report and exits 0 when READY", async () => {
    const stdout: string[] = [];
    const { runner } = runnerReturning(dryRunResult(readyEntityReport(), true));
    const code = await runAdoptCli({
      options: baseOptions,
      entities: [CliProbe],
      runner,
      ...sinks(stdout),
    });
    expect(code).toBe(ADOPT_SUCCESS_EXIT_CODE);
    expect(stdout.join("")).toContain("READY");
  });

  it("dry-run: exits 1 when BLOCKED", async () => {
    const stdout: string[] = [];
    const { runner } = runnerReturning(dryRunResult(blockedEntityReport(), false));
    const code = await runAdoptCli({
      options: baseOptions,
      entities: [CliProbe],
      runner,
      ...sinks(stdout),
    });
    expect(code).toBe(ADOPT_RUNTIME_ERROR_EXIT_CODE);
  });

  it("dry-run --json: emits the raw report JSON", async () => {
    const stdout: string[] = [];
    const { runner } = runnerReturning(dryRunResult(readyEntityReport(), true));
    const code = await runAdoptCli({
      options: { ...baseOptions, json: true },
      entities: [CliProbe],
      runner,
      ...sinks(stdout),
    });
    expect(code).toBe(ADOPT_SUCCESS_EXIT_CODE);
    const parsed = JSON.parse(stdout.join(""));
    expect(parsed).toMatchObject({ mode: "dry-run", ok: true });
  });

  it("passes the adopt spec and env overrides to the runner", async () => {
    const stdout: string[] = [];
    const { calls, runner } = runnerReturning(dryRunResult(readyEntityReport(), true));
    await runAdoptCli({
      options: { ...baseOptions, systemTabName: "Ledger_State", credentialsPath: "/sa.json", spreadsheetUrl: "https://x" },
      entities: [CliProbe],
      runner,
      ...sinks(stdout),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.spec).toEqual({
      mode: "dry-run",
      entities: {
        Invoice: { tabName: "Invoices", identityFrom: "auto", systemStateTabName: "Ledger_State" },
      },
    });
    expect(calls[0]!.dbName).toBe("./hikoutei.sqlite");
    expect(calls[0]!.env.GOOGLE_APPLICATION_CREDENTIALS).toBe("/sa.json");
    expect(calls[0]!.env.HIKOUTEI_SYNC_SPREADSHEET_URL).toBe("https://x");
    expect(calls[0]!.entities).toEqual([CliProbe]);
  });

  it("adopt mode: confirms before running; a DECLINED confirmation exits 1 on stderr with zero side effects", async () => {
    // Declined: the input yields "n". Terra S2/S3: exit 1 (automation must
    // not read a silently skipped adoption as success) and the prompt/cancel
    // lines go to STDERR so --json stdout stays clean.
    const stdout: string[] = [];
    const stderr: string[] = [];
    let called = 0;
    const code = await runAdoptCli({
      options: { ...baseOptions, mode: "adopt", yes: false },
      entities: [CliProbe],
      runner: (async () => { called += 1; return { kind: "sync", hikoutei: undefined } as unknown as TypedSheetsWithSyncResult; }),
      output: { write: (text: string) => { stdout.push(text); } },
      error: { write: (text: string) => { stderr.push(text); } },
      input: (async function* () { yield "n\n"; })(),
    });
    expect(code).toBe(ADOPT_RUNTIME_ERROR_EXIT_CODE);
    expect(called).toBe(0);
    expect(stderr.join("")).toContain("cancelled");
    expect(stdout).toEqual([]);
  });

  it("finalizes stdin exactly once on every outcome (Terra S1)", async () => {
    for (const options of [
      baseOptions,
      { ...baseOptions, mode: "adopt" as const },
    ]) {
      let finalizations = 0;
      const code = await runAdoptCli({
        options,
        entities: [CliProbe],
        runner: async () => dryRunResult(readyEntityReport(), true),
        ...sinks([]),
        finalizeStdin: () => { finalizations += 1; },
      });
      expect(code).toBe(ADOPT_SUCCESS_EXIT_CODE);
      expect(finalizations).toBe(1);
    }
  });

  it("finalizes stdin even when the runner throws (Terra S1)", async () => {
    let finalizations = 0;
    const code = await runAdoptCli({
      options: baseOptions,
      entities: [CliProbe],
      runner: runnerThrowing(Object.assign(new Error("boom"), { code: "sync_startup_failed" })),
      ...sinks([], []),
      finalizeStdin: () => { finalizations += 1; },
    });
    expect(code).toBe(ADOPT_RUNTIME_ERROR_EXIT_CODE);
    expect(finalizations).toBe(1);
  });

  it("adopt mode: --yes skips the prompt and reports success", async () => {
    const stdout: string[] = [];
    const code = await runAdoptCli({
      options: { ...baseOptions, mode: "adopt", yes: true },
      entities: [CliProbe],
      runner: async () => ({ kind: "sync", hikoutei: { async close() { /* noop */ } } } as unknown as TypedSheetsWithSyncResult),
      ...sinks(stdout),
    });
    expect(code).toBe(ADOPT_SUCCESS_EXIT_CODE);
    expect(stdout.join("")).toContain("Adoption complete");
  });

  it("maps a sync-disabled result to exit 1 with a stable error line", async () => {
    const stderr: string[] = [];
    const code = await runAdoptCli({
      options: baseOptions,
      entities: [CliProbe],
      runner: async () => ({ kind: "local", hikoutei: { async close() { /* noop */ } } } as unknown as TypedSheetsWithSyncResult),
      ...sinks([], stderr),
    });
    expect(code).toBe(ADOPT_RUNTIME_ERROR_EXIT_CODE);
    expect(stderr.join("")).toContain("hikoutei-adopt:sync_disabled:");
  });

  it("maps a runner throw with a code to the machine-readable error line", async () => {
    const stderr: string[] = [];
    const code = await runAdoptCli({
      options: baseOptions,
      entities: [CliProbe],
      runner: runnerThrowing(Object.assign(new Error("blocked by dry-run analysis"), { code: "sync_startup_failed" })),
      ...sinks([], stderr),
    });
    expect(code).toBe(ADOPT_RUNTIME_ERROR_EXIT_CODE);
    expect(stderr.join("")).toContain("hikoutei-adopt:sync_startup_failed: blocked by dry-run analysis");
  });
});
