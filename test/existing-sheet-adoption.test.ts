/**
 * Existing-sheet adoption (MVP Phase 1 — dry-run introspection) tests.
 *
 * Covers the pure header-name binding analyzer and the fail-closed bootstrap
 * gate: a dry-run reads the foreign tab, produces the full report, and
 * refuses to start any supervisor (the spreadsheet is never mutated).
 * `design/existing-sheet-adoption-design.md` D1–D7 are the source of truth.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  defineTypedSheetsEntity,
} from "../src/api/entity.js";
import {
  resolveEntityDescriptors,
} from "../src/api/internalEntityRegistry.js";
import {
  columnLetters,
  quoteA1SheetName,
} from "../src/adapter/sheets/providers/google-sheets-api/model/valueNormalization.js";
import {
  adoptionTabRange,
  analyzeExistingSheetAdoptionEntity,
  EXISTING_SHEET_ADOPTION_ERROR_CODES,
  ExistingSheetAdoptionDryRunReportError,
  type ExistingSheetAdoptionRunReport,
} from "../src/application/sync/service/adopt/existingSheetAdoption.js";
import {
  planExistingSheetAdoptionStartup,
} from "../src/application/sync/service/adopt/existingSheetAdoption.js";
import {
  createInternalSyncService,
} from "../src/application/sync/service/SyncServiceBootstrap.js";
import {
  SYNC_SERVICE_ERROR_CODES,
} from "../src/application/sync/service/errors.js";

const AdoptInvoice = defineTypedSheetsEntity({
  name: "AdoptInvoice",
  tableName: "adopt_invoices",
  properties: {
    invoiceNo: { type: "string", primary: true },
    customer: { type: "string" },
    total: { type: "number" },
    note: { type: "string", nullable: true },
  },
});
const descriptors = resolveEntityDescriptors([AdoptInvoice], () => {
  throw new Error("descriptor resolution failed");
});
const adoptDescriptor = descriptors.get("AdoptInvoice")!;
const USER_OWNED = ["invoiceNo", "customer", "total", "note"];

describe("adoptionColumnLetter via the shared 1-based helper", () => {
  it("converts 1-based column numbers to spreadsheet letters", () => {
    expect(columnLetters(1)).toBe("A");
    expect(columnLetters(26)).toBe("Z");
    expect(columnLetters(27)).toBe("AA");
    expect(columnLetters(702)).toBe("ZZ");
    expect(columnLetters(703)).toBe("AAA");
  });
});

function analyze(headers: readonly string[], rows: readonly (readonly (string | undefined)[])[]) {
  return analyzeExistingSheetAdoptionEntity({
    entityName: "AdoptInvoice",
    tabName: "Invoices",
    snapshot: { headers, rows },
    descriptor: adoptDescriptor,
    userOwnedFields: USER_OWNED,
    identityFrom: "auto",
    systemStateTabName: "Invoices_System",
    syncConflictsTabName: "Invoices_Conflicts",
  });
}

describe("analyzeExistingSheetAdoptionEntity", () => {
  it("binds by header name with position-independent bindings on a contiguous sheet", () => {
    const report = analyze(
      ["invoiceNo", "customer", "total", "note"],
      [["INV-1", "Acme", "100", ""], ["INV-2", "Beta", "200", "ok"]],
    );
    expect(report.status).toBe("ready");
    expect(report.bindings.map((b) => `${b.field}:${b.columnLetter}`)).toEqual([
      "invoiceNo:A",
      "customer:B",
      "total:C",
      "note:D",
    ]);
    expect(report.contiguity).toBe("contiguous");
    expect(report.pk).toEqual({ source: "existing-column", column: "invoiceNo" });
    expect(report.ignoredColumns).toEqual([]);
    expect(report.columnsToBeAdded).toEqual(["__hikoutei_row_id"]);
    expect(report.tabsToProvision).toEqual(["Invoices_System", "Invoices_Conflicts"]);
  });

  it("binds out-of-order headers, ignores extra columns, and flags segmented writes", () => {
    const report = analyze(
      ["customer", "memo", "invoiceNo", "total", "note"],
      [["Acme", "keep", "INV-1", "100", ""], ["Beta", "keep2", "INV-2", "200", "ok"]],
    );
    expect(report.status).toBe("ready");
    expect(report.bindings.map((b) => `${b.field}:${b.columnLetter}`)).toEqual([
      "customer:A",
      "invoiceNo:C",
      "total:D",
      "note:E",
    ]);
    expect(report.ignoredColumns).toEqual([{ columnLetter: "B", header: "memo" }]);
    expect(report.contiguity).toBe("segmented");
    expect(report.segments).toEqual([
      { startColumnIndex: 0, endColumnIndex: 0 },
      { startColumnIndex: 2, endColumnIndex: 4 },
    ]);
  });

  it("blocks when a non-nullable entity field has no matching column", () => {
    const report = analyze(["invoiceNo", "customer"], [["INV-1", "Acme"]]);
    expect(report.status).toBe("blocked");
    expect(report.missingFields).toContain("total");
    const missing = report.problems.find((p) => p.code === "MISSING_FIELD" && p.detail?.field === "total");
    expect(missing?.severity).toBe("error");
  });

  it("reports a nullable missing field as a warning while staying ready", () => {
    const report = analyze(["invoiceNo", "customer", "total"], [["INV-1", "Acme", "100"]]);
    expect(report.status).toBe("ready");
    const missing = report.problems.find((p) => p.code === "MISSING_FIELD" && p.detail?.field === "note");
    expect(missing?.severity).toBe("warning");
  });

  it("falls back to a generated PK column when no column matches the primary key", () => {
    const report = analyze(
      ["customer", "total"],
      [["Acme", "100"], ["Beta", "200"]],
    );
    expect(report.status).toBe("ready");
    expect(report.pk.source).toBe("auto-generate");
    expect(report.pk.generatedCount).toBe(2);
    expect(report.columnsToBeAdded).toEqual(["__hikoutei_row_id", "invoiceNo"]);
    expect(report.problems.some((p) => p.code === "NO_PK_CANDIDATE" && p.severity === "warning")).toBe(true);
  });

  it("uses an explicit identityFrom column that differs from the property name", () => {
    const report = analyzeExistingSheetAdoptionEntity({
      entityName: "AdoptInvoice",
      tabName: "Invoices",
      snapshot: { headers: ["InvoiceNo", "customer", "total"], rows: [["INV-1", "Acme", "100"]] },
      descriptor: adoptDescriptor,
      userOwnedFields: USER_OWNED,
      identityFrom: "InvoiceNo",
      systemStateTabName: "Invoices_System",
      syncConflictsTabName: "Invoices_Conflicts",
    });
    expect(report.status).toBe("ready");
    expect(report.pk).toEqual({ source: "existing-column", column: "InvoiceNo" });
    expect(report.bindings.some((b) => b.field === "invoiceNo" && b.header === "InvoiceNo")).toBe(true);
  });

  it("blocks with row numbers when identity values duplicate", () => {
    const report = analyzeExistingSheetAdoptionEntity({
      entityName: "AdoptInvoice",
      tabName: "Invoices",
      snapshot: {
        headers: ["id", "customer", "total", "note"],
        rows: [["INV-1", "Acme", "100", ""], ["INV-1", "Beta", "200", ""], ["INV-3", "C", "300", ""]],
      },
      descriptor: adoptDescriptor,
      userOwnedFields: USER_OWNED,
      identityFrom: "id",
      systemStateTabName: "Invoices_System",
      syncConflictsTabName: "Invoices_Conflicts",
    });
    expect(report.status).toBe("blocked");
    const dup = report.problems.find((p) => p.code === "DUPLICATE_IDENTITY_VALUE");
    expect(dup?.severity).toBe("error");
    expect(report.pk.duplicates).toEqual([{ value: "INV-1", rowNumbers: [2, 3] }]);
  });

  it("blocks when identity cells are empty and reports their row numbers", () => {
    const report = analyzeExistingSheetAdoptionEntity({
      entityName: "AdoptInvoice",
      tabName: "Invoices",
      snapshot: {
        headers: ["id", "customer", "total", "note"],
        rows: [["", "Acme", "100", ""], ["INV-2", "Beta", "200", ""]],
      },
      descriptor: adoptDescriptor,
      userOwnedFields: USER_OWNED,
      identityFrom: "id",
      systemStateTabName: "Invoices_System",
      syncConflictsTabName: "Invoices_Conflicts",
    });
    expect(report.status).toBe("blocked");
    expect(report.problems.some((p) => p.code === "EMPTY_IDENTITY_VALUE")).toBe(true);
  });

  it("counts fully empty rows without treating them as identity duplicates", () => {
    const report = analyze(
      ["id", "customer", "total", "note"],
      [["INV-1", "Acme", "100", ""], ["", "", "", ""], ["INV-3", "C", "300", ""]],
    );
    expect(report.emptyRows).toBe(1);
    expect(report.status).toBe("ready");
  });

  it("trims header whitespace when binding by name", () => {
    const report = analyze(
      ["invoiceNo ", "customer", "total", "note"],
      [["INV-1", "Acme", "100", ""]],
    );
    expect(report.status).toBe("ready");
    expect(report.bindings[0]).toMatchObject({ field: "invoiceNo", columnIndex: 0, header: "invoiceNo " });
  });
});

describe("review regression: adopt-mode layout blockers surface in dry-run", () => {
  const projections = {
    spreadsheetId: "adopt-spreadsheet",
    entities: {
      AdoptInvoice: {
        systemState: { tabName: "Invoices_System", registeredRange: "A:C" },
        syncConflicts: { tabName: "Invoices_Conflicts", registeredRange: "A:O" },
        userInput: { tabName: "Invoices", registeredRange: "A:E" },
        userOwnedFields: USER_OWNED,
      },
    },
  } as const;
  const planWith = (headers: readonly string[], rows: readonly (readonly (string | undefined)[])[]) =>
    planExistingSheetAdoptionStartup({
      adopt: { mode: "dry-run", entities: { AdoptInvoice: { tabName: "Invoices", identityFrom: "auto" } } },
      spreadsheetId: "adopt-spreadsheet",
      transport: {
        async getSpreadsheet() {
          return { sheets: [{ properties: { sheetId: 7, title: "Invoices", gridProperties: { columnCount: headers.length } } }] };
        },
        async getValues() {
          return { values: [headers, ...rows.map((row) => row.map((cell) => cell ?? null))] };
        },
        async batchUpdate() {
          return {};
        },
      },
      descriptors: [adoptDescriptor],
      projections,
      userOwnedFieldsByEntity: { AdoptInvoice: USER_OWNED },
    });

  it("blocks a segmented layout in the REPORT (never ready-then-rejected)", async () => {
    try {
      await planWith(
        ["customer", "memo", "invoiceNo", "total"],
        [["Acme", "keep", "INV-1", "100"]],
      );
      expect.unreachable("segmented layout must block");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ExistingSheetAdoptionDryRunReportError);
      const report = (error as ExistingSheetAdoptionDryRunReportError).report;
      expect(report.ok).toBe(false);
      expect(report.entities[0]!.problems.some((p) => p.code === "COLUMN_SEGMENTATION")).toBe(true);
    }
  });

  it("blocks a declaration-order mismatch in the REPORT", async () => {
    try {
      await planWith(
        ["customer", "total", "invoiceNo", "note"],
        [["Acme", "100", "INV-1", ""]],
      );
      expect.unreachable("declaration-order mismatch must block");
    } catch (error: unknown) {
      const report = (error as ExistingSheetAdoptionDryRunReportError).report;
      expect(report.entities[0]!.problems.some((p) => p.code === "DECLARATION_ORDER_MISMATCH")).toBe(true);
    }
  });

  it("blocks when the row-id append column is occupied", async () => {
    try {
      await planWith(
        ["invoiceNo", "customer", "total", "note", "extra"],
        [["INV-1", "Acme", "100", "", "keep"]],
      );
      expect.unreachable("occupied append column must block");
    } catch (error: unknown) {
      const report = (error as ExistingSheetAdoptionDryRunReportError).report;
      expect(report.entities[0]!.problems.some((p) => p.code === "COLUMN_OCCUPIED")).toBe(true);
    }
  });
});

describe("existing-sheet adoption bootstrap gate", () => {
  const services: { close: () => Promise<void> }[] = [];

  afterEach(async () => {
    for (const service of services.splice(0)) await service.close().catch(() => undefined);
  });

  const projections = {
    spreadsheetId: "adopt-spreadsheet",
    entities: {
      AdoptInvoice: {
        systemState: { tabName: "Invoices_System", registeredRange: "A:C" },
        syncConflicts: { tabName: "Invoices_Conflicts", registeredRange: "A:O" },
        userInput: { tabName: "Invoices", registeredRange: "A:E" },
        userOwnedFields: USER_OWNED,
      },
    },
  } as const;

  class ForeignTabTransport {
    public async getSpreadsheet(): Promise<unknown> {
      return { sheets: [{ properties: { sheetId: 1, title: "Invoices" } }] };
    }
    public async getValues(): Promise<{ values?: readonly (readonly (string | number | boolean | null)[])[] }> {
      return {
        values: [
          ["invoiceNo", "customer", "total", "note"],
          ["INV-1", "Acme", 100, null],
          ["INV-2", "Beta", 200, "ok"],
        ],
      };
    }
    public async batchUpdate(): Promise<unknown> {
      return {};
    }
  }

  it("dry-run reads the foreign tab and throws the full report without starting the service", async () => {
    let report: ExistingSheetAdoptionRunReport | undefined;
    try {
      await createInternalSyncService({
        dbName: ":memory:",
        entities: [AdoptInvoice],
        projections,
        googleSheetsApi: { transport: new ForeignTabTransport() as never },
        adopt: { mode: "dry-run", entities: { AdoptInvoice: { tabName: "Invoices", identityFrom: "auto" } } },
      });
      expect.unreachable("dry-run must not start the service");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ExistingSheetAdoptionDryRunReportError);
      report = (error as ExistingSheetAdoptionDryRunReportError).report;
    }
    expect(report.mode).toBe("dry-run");
    expect(report.ok).toBe(true);
    expect(report.entities[0]!.status).toBe("ready");
    expect(report.entities[0]!.totalRows).toBe(2);
    expect(report.entities[0]!.pk).toEqual({ source: "existing-column", column: "invoiceNo" });
    expect(report.entities[0]!.columnsToBeAdded).toEqual(["__hikoutei_row_id"]);
  });

  it("dry-run blocks with problems when identity values duplicate", async () => {
    class DuplicateTabTransport extends ForeignTabTransport {
      public override async getValues(): Promise<{ values?: readonly (readonly (string | number | boolean | null)[])[] }> {
        return { values: [["invoiceNo", "customer", "total", "note"], ["INV-1", "Acme", 100, null], ["INV-1", "Beta", 200, null]] };
      }
    }
    try {
      await createInternalSyncService({
        dbName: ":memory:",
        entities: [AdoptInvoice],
        projections,
        googleSheetsApi: { transport: new DuplicateTabTransport() as never },
        adopt: { mode: "dry-run", entities: { AdoptInvoice: { tabName: "Invoices" } } },
      });
      expect.unreachable("duplicates must block the adoption");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ExistingSheetAdoptionDryRunReportError);
      const report = (error as ExistingSheetAdoptionDryRunReportError).report;
      expect(report.ok).toBe(false);
      expect(report.entities[0]!.status).toBe("blocked");
      expect(report.entities[0]!.pk.duplicates).toEqual([{ value: "INV-1", rowNumbers: [2, 3] }]);
    }
  });

  it("rejects adoption without the direct googleSheetsApi provider", async () => {
    await expect(createInternalSyncService({
      dbName: ":memory:",
      entities: [AdoptInvoice],
      projections,
      adopt: { mode: "dry-run", entities: { AdoptInvoice: { tabName: "Invoices" } } },
    })).rejects.toMatchObject({
      code: SYNC_SERVICE_ERROR_CODES.INVALID_OPTIONS,
      message: expect.stringContaining("requires the direct googleSheetsApi provider"),
    });
  });

  it("rejects more than one adopted entity (MVP constraint)", async () => {
    await expect(createInternalSyncService({
      dbName: ":memory:",
      entities: [AdoptInvoice],
      projections,
      googleSheetsApi: { transport: new ForeignTabTransport() as never },
      adopt: {
        mode: "dry-run",
        entities: {
          AdoptInvoice: { tabName: "Invoices" },
          Ghost: { tabName: "Invoices" },
        },
      },
    })).rejects.toMatchObject({
      code: SYNC_SERVICE_ERROR_CODES.INVALID_OPTIONS,
      message: expect.stringContaining("exactly one entity"),
    });
  });

  it("requires the adopt tabName to equal the configured userInput route", async () => {
    await expect(createInternalSyncService({
      dbName: ":memory:",
      entities: [AdoptInvoice],
      projections,
      googleSheetsApi: { transport: new ForeignTabTransport() as never },
      adopt: { mode: "dry-run", entities: { AdoptInvoice: { tabName: "SomewhereElse" } } },
    })).rejects.toMatchObject({
      code: SYNC_SERVICE_ERROR_CODES.INVALID_OPTIONS,
      message: expect.stringContaining("must equal the userInput route tab"),
    });
  });
});


describe("review regression: header ambiguity and layout edge cases", () => {
  const analyze = (headers: readonly string[], rows: readonly (readonly (string | undefined)[])[], identityFrom?: string) =>
    analyzeExistingSheetAdoptionEntity({
      entityName: "AdoptInvoice",
      tabName: "Invoices",
      snapshot: { headers, rows },
      descriptor: adoptDescriptor,
      userOwnedFields: USER_OWNED,
      identityFrom,
      systemStateTabName: "Invoices_System",
      syncConflictsTabName: "Invoices_Conflicts",
    });

  it("binds an interleaved identityFrom column without listing it as ignored", () => {
    // Custom identity column at an interleaved position: it must appear in
    // the bindings (with correct segments) and never in ignoredColumns.
    const report = analyze(
      ["customer", "InvoiceNo", "memo", "total", "note"],
      [["Acme", "INV-1", "keep", "100", ""], ["Beta", "INV-2", "keep", "200", ""]],
      "InvoiceNo",
    );
    expect(report.status).toBe("ready");
    expect(report.bindings.map((b) => `${b.field}:${b.columnLetter}`)).toEqual([
      "customer:A",
      "invoiceNo:B",
      "total:D",
      "note:E",
    ]);
    expect(report.contiguity).toBe("segmented");
    expect(report.segments).toEqual([
      { startColumnIndex: 0, endColumnIndex: 1 },
      { startColumnIndex: 3, endColumnIndex: 4 },
    ]);
    expect(report.ignoredColumns.map((c) => c.header)).toEqual(["memo"]);
    expect(report.pk).toEqual({ source: "existing-column", column: "InvoiceNo" });
  });

  it("fails closed on duplicate normalized headers", () => {
    const report = analyze(["invoiceNo", "invoiceNo ", "customer", "total", "note"], [["INV-1", "dup", "Acme", "100", ""]]);
    expect(report.status).toBe("blocked");
    const dup = report.problems.find((p) => p.code === "DUPLICATE_HEADER");
    expect(dup?.severity).toBe("error");
expect(dup?.detail?.columns).toEqual(["A", "B"]);
  });

  it("fails closed on an empty tab instead of reporting ready", () => {
    const report = analyze([], []);
    expect(report.status).toBe("blocked");
    expect(report.problems.some((p) => p.code === "EMPTY_TAB")).toBe(true);
  });

  it("builds a quoted, grid-wide read range", () => {
    expect(adoptionTabRange("Invoices", 26)).toBe("'Invoices'!A1:Z");
    expect(adoptionTabRange("Team's Sheet", 100)).toBe("'Team''s Sheet'!A1:CV");
  });
});

describe("review round 2 regressions", () => {
  const projections = {
    spreadsheetId: "adopt-spreadsheet",
    entities: {
      AdoptInvoice: {
        systemState: { tabName: "Invoices_System", registeredRange: "A:C" },
        syncConflicts: { tabName: "Invoices_Conflicts", registeredRange: "A:O" },
        userInput: { tabName: "Invoices", registeredRange: "A:E" },
        userOwnedFields: USER_OWNED,
      },
    },
  } as const;
  const planWith = (
    headers: readonly string[],
    rows: readonly (readonly (string | undefined)[])[],
    mode: "dry-run" | "adopt" = "dry-run",
    identityFrom: string | "auto" = "auto",
    columnMap?: Readonly<Record<string, string>>,
  ) =>
    planExistingSheetAdoptionStartup({
      adopt: {
        mode,
        entities: { AdoptInvoice: { tabName: "Invoices", identityFrom, ...(columnMap === undefined ? {} : { columnMap }) } },
      },
      spreadsheetId: "adopt-spreadsheet",
      transport: {
        async getSpreadsheet() {
          return { sheets: [{ properties: { sheetId: 7, title: "Invoices", gridProperties: { columnCount: headers.length } } }] };
        },
        async getValues() {
          return { values: [headers, ...rows.map((row) => row.map((cell) => cell ?? null))] };
        },
        async batchUpdate() {
          return {};
        },
      },
      descriptors: [adoptDescriptor],
      projections,
      userOwnedFieldsByEntity: { AdoptInvoice: USER_OWNED },
    });

  it("blocks when the row-id append column has DATA below an EMPTY header (data loss guard)", async () => {
    // The appended column's header is blank but live data sits below it:
    // header-only inspection would treat the column as free and
    // applyAdoptionSystemColumns would overwrite that data.
    try {
      await planWith(
        ["invoiceNo", "customer", "total", "note", ""],
        [["INV-1", "Acme", "100", "", "old data"], ["INV-2", "Beta", "200", "", "more"]],
      );
      expect.unreachable("occupied data column must block");
    } catch (error: unknown) {
      const report = (error as ExistingSheetAdoptionDryRunReportError).report;
      expect(report.entities[0]!.problems.some((p) => p.code === "COLUMN_OCCUPIED" && p.severity === "error")).toBe(true);
    }
  });

  it("does NOT block generated-PK adoption: virtual PK appended last satisfies the declaration order", async () => {
    const plan = await planWith(
      ["customer", "total", "note"],
      [["Acme", "100", ""], ["Beta", "200", "ok"]],
      "adopt",
    );
    expect(plan.report.ok).toBe(true);
    const layout = plan.entities[0]!.layout;
    expect(plan.report.entities[0]!.pk.source).toBe("auto-generate");
    expect(layout.pkGenerated).toBe(true);
    expect(layout.pkColumnIndex).toBe(3);
    expect(layout.rowIdColumnIndex).toBe(4);
    // The registered range covers the managed columns + generated PK + row-id.
    expect(layout.registeredRange).toBe("A:E");
    expect(layout.appendedColumns).toEqual([
      { columnIndex: 3, header: "invoiceNo" },
      { columnIndex: 4, header: "__hikoutei_row_id" },
    ]);
    expect(plan.entities[0]!.pkAppend).toEqual({ columnIndex: 3, header: "invoiceNo" });
    expect(plan.entities[0]!.dataRows).toHaveLength(2);
  });

  it("blocks an identityFrom alias whose header differs from the PK property name", async () => {
    try {
      await planWith(
        ["InvoiceNo", "customer", "total", "note"],
        [["INV-1", "Acme", "100", ""]],
        "dry-run",
        "InvoiceNo",
      );
      expect.unreachable("identityFrom aliases must block (MVP)");
    } catch (error: unknown) {
      const report = (error as ExistingSheetAdoptionDryRunReportError).report;
      expect(report.entities[0]!.status).toBe("blocked");
      const alias = report.entities[0]!.problems.find((p) => p.code === "IDENTITY_ALIAS_UNSUPPORTED");
      expect(alias?.severity).toBe("error");
    }
  });

  it("blocks whitespace-padded headers (provisioning requires exact headers)", async () => {
    try {
      await planWith(
        ["invoiceNo ", "customer", "total", "note"],
        [["INV-1", "Acme", "100", ""]],
      );
      expect.unreachable("whitespace header must block");
    } catch (error: unknown) {
      const report = (error as ExistingSheetAdoptionDryRunReportError).report;
      expect(report.entities[0]!.problems.some((p) => p.code === "EXACT_HEADER_MISMATCH")).toBe(true);
    }
  });

  it("does not duplicate a single-entity ready report", async () => {
    const plan = await planWith(
      ["invoiceNo", "customer", "total", "note"],
      [["INV-1", "Acme", "100", ""]],
    ).catch((error: unknown) => {
      if (error instanceof ExistingSheetAdoptionDryRunReportError) return error.report;
      throw error;
    });
    expect(plan.entities).toHaveLength(1);
  });
});
describe("columnMap — explicit header → property bindings (design §12)", () => {
  // Legacy headers that do NOT match the property names. Column order still
  // follows the entity declaration order (C4): invoiceNo, customer, total.
  const legacyHeaders = ["memo", "Invoice No", "Customer Name", "Total (USD)", "note"];
  const legacyRows = [
    ["legacy note", "INV-1", "Acme", "100", ""],
    ["", "INV-2", "Beta", "200", ""],
  ];
  const legacyColumnMap = {
    "Invoice No": "invoiceNo",
    "Customer Name": "customer",
    "Total (USD)": "total",
  };

  const legacyPlanWith = (
    headers: readonly string[],
    rows: readonly (readonly (string | undefined)[])[],
    columnMap: Readonly<Record<string, string>> | undefined,
    mode: "dry-run" | "adopt" = "dry-run",
    identityFrom: string | "auto" = "auto",
  ) =>
    planExistingSheetAdoptionStartup({
      adopt: {
        mode,
        entities: { AdoptInvoice: { tabName: "Invoices", identityFrom, ...(columnMap === undefined ? {} : { columnMap }) } },
      },
      spreadsheetId: "adopt-spreadsheet",
      transport: {
        async getSpreadsheet() {
          return { sheets: [{ properties: { sheetId: 7, title: "Invoices", gridProperties: { columnCount: headers.length } } }] };
        },
        async getValues() {
          return { values: [headers, ...rows.map((row) => row.map((cell) => cell ?? null))] };
        },
        async batchUpdate() {
          return {};
        },
      },
      descriptors: [adoptDescriptor],
      projections: {
        spreadsheetId: "adopt-spreadsheet",
        entities: {
          AdoptInvoice: {
            systemState: { tabName: "Invoices_System", registeredRange: "A:C" },
            syncConflicts: { tabName: "Invoices_Conflicts", registeredRange: "A:O" },
            userInput: { tabName: "Invoices", registeredRange: "A:E" },
            userOwnedFields: USER_OWNED,
          },
        },
      },
      userOwnedFieldsByEntity: { AdoptInvoice: USER_OWNED },
    });

  function dryRunReport(headers: readonly string[], rows: readonly (readonly (string | undefined)[])[], columnMap: Readonly<Record<string, string>> | undefined, mode: "dry-run" | "adopt" = "dry-run", identityFrom: string | "auto" = "auto") {
    // dry-run ALWAYS throws the report; adopt mode resolves the plan for a
    // READY analysis and throws the same report error when blocked.
    return legacyPlanWith(headers, rows, columnMap, mode, identityFrom).then(
      (plan) => plan.report,
      (error: unknown) => {
        if (error instanceof ExistingSheetAdoptionDryRunReportError) return error.report;
        throw error;
      },
    );
  }

  it("binds headers through the map and reports the mapped-from headers", async () => {
    const report = await dryRunReport(legacyHeaders, legacyRows, legacyColumnMap);
    const entity = report.entities[0]!;
    expect(entity.status).toBe("ready");
    expect(entity.bindings).toEqual([
      { field: "invoiceNo", columnIndex: 1, columnLetter: "B", header: "Invoice No", mappedFromHeader: "Invoice No" },
      { field: "customer", columnIndex: 2, columnLetter: "C", header: "Customer Name", mappedFromHeader: "Customer Name" },
      { field: "total", columnIndex: 3, columnLetter: "D", header: "Total (USD)", mappedFromHeader: "Total (USD)" },
      { field: "note", columnIndex: 4, columnLetter: "E", header: "note" },
    ]);
    // C3: the unmapped `memo` header is an ignored column (sitting LEFT of
    // the managed block, per the MVP layout rule).
    expect(entity.ignoredColumns).toEqual([
      { columnLetter: "A", header: "memo" },
    ]);
  });

  it("keeps name-binding for fields not in the map", async () => {
    const report = await dryRunReport(
      ["memo", "Invoice No", "customer", "Total (USD)", "note"],
      legacyRows,
      { "Invoice No": "invoiceNo", "Total (USD)": "total" },
    );
    const entity = report.entities[0]!;
    expect(entity.status).toBe("ready");
    const byField = Object.fromEntries(entity.bindings.map((b) => [b.field, b]));
    expect(byField.customer).toMatchObject({ columnLetter: "C", header: "customer" });
    expect(byField.customer!.mappedFromHeader).toBeUndefined();
    expect(byField.note).toMatchObject({ columnLetter: "E", header: "note" });
  });

  it("absorbs the D4 identityFrom alias when the map binds the PK header", async () => {
    const report = await dryRunReport(legacyHeaders, legacyRows, legacyColumnMap, "adopt", "Invoice No");
    expect(report.entities[0]!.status).toBe("ready");
    expect(report.entities[0]!.problems.some((p) => p.code === "IDENTITY_ALIAS_UNSUPPORTED")).toBe(false);
  });

  it("still blocks an identityFrom alias WITHOUT a map (D4 unchanged)", async () => {
    const report = await dryRunReport(
      ["Invoice No", "customer", "total"],
      [["INV-1", "Acme", "100"]],
      undefined,
      "adopt",
      "Invoice No",
    );
    expect(report.entities[0]!.problems.some((p) => p.code === "IDENTITY_ALIAS_UNSUPPORTED")).toBe(true);
  });

  it("resolves the PK through the map with identityFrom auto", async () => {
    const report = await dryRunReport(legacyHeaders, legacyRows, legacyColumnMap);
    const entity = report.entities[0]!;
    expect(entity.pk).toMatchObject({ source: "existing-column", column: "Invoice No" });
  });

  it("flags a map header that does not exist in the tab (typo exposure)", async () => {
    const report = await dryRunReport(
      ["Invoice No", "customer", "Total (USD)"],
      [["INV-1", "Acme", "100"]],
      { "Invoice No": "invoiceNo", "Custmer Name": "customer", "Total (USD)": "total" },
    );
    const entity = report.entities[0]!;
    expect(entity.problems.some((p) => p.code === "COLUMN_MAP_UNKNOWN_HEADER" && p.severity === "error")).toBe(true);
    // The typo'd field falls back to name matching (still binds here), but
    // the unknown-header error blocks the adoption either way.
    expect(entity.status).toBe("blocked");
  });

  it("flags a map value that the entity does not declare", async () => {
    const report = await dryRunReport(
      ["Invoice No", "customer", "total"],
      [["INV-1", "Acme", "100"]],
      { "Invoice No": "invoiceNo", customer: "custmer" },
    );
    expect(report.entities[0]!.problems.some((p) => p.code === "COLUMN_MAP_UNKNOWN_PROPERTY")).toBe(true);
  });

  it("flags two headers mapping to one property", async () => {
    const report = await dryRunReport(
      ["Invoice No", "Other Invoice", "customer", "total"],
      [["INV-1", "INV-1x", "Acme", "100"]],
      { "Invoice No": "invoiceNo", "Other Invoice": "invoiceNo" },
    );
    expect(report.entities[0]!.problems.some((p) => p.code === "COLUMN_MAP_DUPLICATE_PROPERTY")).toBe(true);
  });

  it("enforces the declaration ORDER over mapped fields (C4)", async () => {
    // The map cannot reorder: sheet order invoiceNo, total, customer vs the
    // declaration order invoiceNo, customer, total must block.
    const report = await dryRunReport(
      ["memo", "Invoice No", "Total (USD)", "customer"],
      [["legacy", "INV-1", "100", "Acme"]],
      { "Invoice No": "invoiceNo", "Total (USD)": "total" },
    );
    expect(report.entities[0]!.problems.some((p) => p.code === "DECLARATION_ORDER_MISMATCH")).toBe(true);
  });

  it("adopt mode with the legacy map is READY end to end", async () => {
    const report = await dryRunReport(legacyHeaders, legacyRows, legacyColumnMap, "adopt");
    expect(report.ok).toBe(true);
  });
});
