/**
 * Public existing-sheet adoption API tests (design §4/§10, milestone ②).
 *
 * Two layers are exercised:
 *  - the PUBLIC wrapper `createTypedSheetsWithSync()` from `src/index.js`:
 *    export existence, the local-only path, and the unknown-entity fail-fast —
 *    with NO transport injection (production shape; the result union exposes
 *    only the runtime handle, never the internal service);
 *  - the internal bridge with a stub transport (credential-free) proves the
 *    adoption behavior behind the same plumbing: the dry-run report result,
 *    adopted-tab projection overrides, fail-closed blocked reports in adopt
 *    mode, and the full adopt pipeline (provisioning + anchors + seeding).
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createTypedSheetsWithSync,
  defineTypedSheetsEntity,
  HIKOUTEI_ERROR_CODES,
} from "../src/index.js";
import type {
  AdoptDryRunResult,
  AdoptSpec,
  TypedSheetsWithSyncResult,
} from "../src/index.js";
import {
  createTypedSheetsWithSync as createTypedSheetsWithSyncInternal,
  SYNC_ENV_KEYS,
} from "@hikoutei/composition/syncAutoStart.js";
import {
  StubSheetsTransport,
  StubSpreadsheet,
} from "./support/StubSheetsTransport.js";

const AdoptApiInvoice = defineTypedSheetsEntity({
  name: "AdoptApiInvoice",
  tableName: "adopt_api_invoices",
  properties: {
    invoiceNo: { type: "string", primary: true },
    customer: { type: "string" },
    total: { type: "number" },
  },
});

const AdoptApiCustomer = defineTypedSheetsEntity({
  name: "AdoptApiCustomer",
  tableName: "adopt_api_customers",
  properties: {
    customerId: { type: "string", primary: true },
    company: { type: "string" },
  },
});


  /** Foreign tab exactly as the MVP smoke fixture: memo | invoiceNo | customer | total. */
function foreignSpreadsheet(
  rows: readonly (readonly (string | number | null)[])[] = [
    ["", "INV-1", "Acme", 100],
    ["legacy note", "INV-2", "Beta", 200],
  ],
): StubSpreadsheet {
  const spreadsheet = new StubSpreadsheet();
  spreadsheet.addTab("Invoices", {
    headers: ["memo", "invoiceNo", "customer", "total"],
    rows,
  });
  return spreadsheet;
}

/** Two-entity adoption fixture: one tab per entity, each header-matched. */
function twoEntitySpreadsheet(): StubSpreadsheet {
  const spreadsheet = new StubSpreadsheet();
  spreadsheet.addTab("Invoices", {
    headers: ["memo", "invoiceNo", "customer", "total"],
    rows: [
      ["", "INV-1", "Acme", 100],
      ["legacy note", "INV-2", "Beta", 200],
    ],
  });
  spreadsheet.addTab("Customers", {
    headers: ["customerId", "company"],
    rows: [
      ["C-1", "Acme Corp"],
      ["C-2", "Beta Inc"],
    ],
  });
  return spreadsheet;
}


  function syncEnv(credentialsPath: string): Record<string, string | undefined> {
  return {
    [SYNC_ENV_KEYS.SPREADSHEET_URL]: "https://docs.google.com/spreadsheets/d/adopt-api-test-1/edit",
    [SYNC_ENV_KEYS.CREDENTIALS_FILE]: credentialsPath,
    [SYNC_ENV_KEYS.POLLING_INTERVAL_MS]: "3600000",
  };
}


function expectAdoptDryRun(result: TypedSheetsWithSyncResult): AdoptDryRunResult {
  if (result.kind !== "adopt-dry-run") {
    throw new Error(`expected kind "adopt-dry-run", received "${result.kind}"`);
  }
  return result;
}

describe("public adoption API (createTypedSheetsWithSync + adopt)", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  function credentialsDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "hikoutei-adopt-api-"));
    tempDirs.push(dir);
    return dir;
  }

  function writeCredentialsFile(dir: string): string {
    const path = join(dir, "service-account.json");
    writeFileSync(path, JSON.stringify({
      type: "service_account",
      project_id: "hikoutei-test",
      private_key_id: "k1",
      private_key: "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n",
      client_email: "adopt-api-test@example.com",
      client_id: "123456",
      token_uri: "https://oauth2.googleapis.com/token",
    }));
    return path;
  }

  it("exports the adoption surface from the public barrel", () => {
    expect(typeof createTypedSheetsWithSync).toBe("function");
  });

  it("public result union exposes only the runtime handle (no internal service)", async () => {
    // Local-only path (no spreadsheet URL): proves the wrapper loads and the
    // union shape is the public contract, without credentials or network.
    const result = await createTypedSheetsWithSync({
      dbName: `:memory:${randomUUID()}`,
      entities: [AdoptApiInvoice],
      env: {},
    });
    expect(result.kind).toBe("local");
    expect((result as { hikoutei: unknown }).hikoutei).toBeDefined();
    expect((result as unknown as Record<string, unknown>).service).toBeUndefined();
  });

  it("fails fast when adopt references an entity outside the runtime (public path, no transport)", async () => {
    const dir = credentialsDir();
    const credentialsPath = writeCredentialsFile(dir);
    await expect(createTypedSheetsWithSync({
      dbName: `:memory:${randomUUID()}`,
      entities: [AdoptApiInvoice],
      env: syncEnv(credentialsPath),
      adopt: { mode: "dry-run", entities: { NoSuchEntity: { tabName: "Invoices" } } },
    })).rejects.toMatchObject({ code: HIKOUTEI_ERROR_CODES.SYNC_STARTUP_FAILED });
  });
});

describe("adoption behavior behind the public bridge (stub transport)", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  function credentialsPath(): string {
    const dir = mkdtempSync(join(tmpdir(), "hikoutei-adopt-bridge-"));
    tempDirs.push(dir);
    const path = join(dir, "service-account.json");
    writeFileSync(path, JSON.stringify({
      type: "service_account",
      project_id: "hikoutei-test",
      private_key_id: "k1",
      private_key: "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n",
      client_email: "adopt-bridge-test@example.com",
      client_id: "123456",
      token_uri: "https://oauth2.googleapis.com/token",
    }));
    return path;
  }

  async function runDryRun(
    spreadsheet: StubSpreadsheet,
    adopt: AdoptSpec,
  ): Promise<TypedSheetsWithSyncResult> {
    return createTypedSheetsWithSyncInternal({
      dbName: `:memory:${randomUUID()}`,
      entities: [AdoptApiInvoice],
      env: {
        [SYNC_ENV_KEYS.SPREADSHEET_URL]: "https://docs.google.com/spreadsheets/d/adopt-api-test-1/edit",
        [SYNC_ENV_KEYS.CREDENTIALS_FILE]: credentialsPath(),
        [SYNC_ENV_KEYS.POLLING_INTERVAL_MS]: "3600000",
      },
      transport: new StubSheetsTransport(spreadsheet),
      adopt,
    });
  }

  it("dry-run returns the report result and does NOT mutate the spreadsheet", async () => {
    const spreadsheet = foreignSpreadsheet();
    const result = await runDryRun(spreadsheet, {
      mode: "dry-run",
      entities: { AdoptApiInvoice: { tabName: "Invoices", identityFrom: "auto" } },
    });

    const { report } = expectAdoptDryRun(result);
    expect(report.ok).toBe(true);
    expect(report.entities).toHaveLength(1);
    const entity = report.entities[0]!;
    expect(entity.status).toBe("ready");
    expect(entity.bindings.map((b) => `${b.field}->${b.columnLetter}`)).toEqual([
      "invoiceNo->B",
      "customer->C",
      "total->D",
    ]);
    expect(entity.ignoredColumns).toEqual([{ columnLetter: "A", header: "memo" }]);
    expect(entity.contiguity).toBe("contiguous");
    expect(entity.pk).toMatchObject({ source: "existing-column", column: "invoiceNo" });
    // Fresh tabs derive from the adopted tab name by default.
    expect(entity.tabsToProvision).toEqual(["Invoices_System", "Invoices_Conflicts"]);
    // Dry-run NEVER mutates: no batch updates reached the stub and the tab
    // has no appended column.
    expect(spreadsheet.sheets.map((s) => s.title)).toEqual(["Invoices"]);
    expect(spreadsheet.sheets[0]!.cells.has("0,4")).toBe(false);
  });

  it("respects explicit systemState/syncConflicts tab-name overrides", async () => {
    const result = await runDryRun(foreignSpreadsheet(), {
      mode: "dry-run",
      entities: {
        AdoptApiInvoice: {
          tabName: "Invoices",
          systemStateTabName: "Ledger_State",
          syncConflictsTabName: "Ledger_Conflicts",
        },
      },
    });

    expect(expectAdoptDryRun(result).report.entities[0]!.tabsToProvision).toEqual([
      "Ledger_State",
      "Ledger_Conflicts",
    ]);
  });

  it("adopt mode with a BLOCKED report stays fail-closed (diagnosed error, no result shape)", async () => {
    const spreadsheet = foreignSpreadsheet();
    // identityFrom alias whose header differs from the PK property name is an
    // MVP blocker (IDENTITY_ALIAS_UNSUPPORTED).
    await expect(createTypedSheetsWithSyncInternal({
      dbName: `:memory:${randomUUID()}`,
      entities: [AdoptApiInvoice],
      env: {
        [SYNC_ENV_KEYS.SPREADSHEET_URL]: "https://docs.google.com/spreadsheets/d/adopt-api-test-1/edit",
        [SYNC_ENV_KEYS.CREDENTIALS_FILE]: credentialsPath(),
        [SYNC_ENV_KEYS.POLLING_INTERVAL_MS]: "3600000",
      },
      transport: new StubSheetsTransport(spreadsheet),
      adopt: { mode: "adopt", entities: { AdoptApiInvoice: { tabName: "Invoices", identityFrom: "InvoiceNo" } } },
    })).rejects.toMatchObject({
      code: HIKOUTEI_ERROR_CODES.SYNC_STARTUP_FAILED,
      message: expect.stringContaining("IDENTITY_ALIAS_UNSUPPORTED"),
    });
    // Still zero mutations: the block happened BEFORE any provisioning.
    expect(spreadsheet.sheets[0]!.cells.has("0,4")).toBe(false);
  });

  it("adopt mode refuses a cell-kind mismatch before ANY mutation (live-incident regression)", async () => {
    // The live-smoke incident: numeric sheet `total` cells bound to a
    // string-declared property. The seeding must fail closed at startup —
    // otherwise the first poll quarantines every adopted row.
    const spreadsheet = foreignSpreadsheet();
    const StringTotalInvoice = defineTypedSheetsEntity({
      name: "AdoptApiStringTotal",
      tableName: "adopt_api_string_total",
      properties: {
        invoiceNo: { type: "string", primary: true },
        customer: { type: "string" },
        total: { type: "string" }, // mismatch: the sheet holds numeric cells
      },
    });

    await expect(createTypedSheetsWithSyncInternal({
      dbName: `:memory:${randomUUID()}`,
      entities: [StringTotalInvoice],
      env: {
        [SYNC_ENV_KEYS.SPREADSHEET_URL]: "https://docs.google.com/spreadsheets/d/adopt-api-test-1/edit",
        [SYNC_ENV_KEYS.CREDENTIALS_FILE]: credentialsPath(),
        [SYNC_ENV_KEYS.POLLING_INTERVAL_MS]: "3600000",
      },
      transport: new StubSheetsTransport(spreadsheet),
      adopt: { mode: "adopt", entities: { AdoptApiStringTotal: { tabName: "Invoices", identityFrom: "auto" } } },
    })).rejects.toMatchObject({
      // The public path classifies to sync_startup_failed but PRESERVES the
      // precise cell-kind diagnosis in the message; internal callers see the
      // stable existing_sheet_adoption_cell_kind_mismatch SyncServiceError.
      code: HIKOUTEI_ERROR_CODES.SYNC_STARTUP_FAILED,
      message: expect.stringContaining("row 2 field \"total\" (declared string, sheet number)"),
    });
    // D5 checkpoint semantics: provisioning + the row-id/anchor pass run
    // BEFORE seeding observation (snapshot_taken → row_id_written → seeded),
    // so the failure leaves an IDEMPOTENT-RESUMABLE sheet state — the system
    // tabs exist and the row-id column is appended, but NO SQLite state was
    // written and the EXISTING cells are untouched. Re-running after fixing
    // the declaration resumes cleanly.
    expect(spreadsheet.sheets.map((s) => s.title)).toEqual([
      "Invoices",
      "Invoices_System",
      "Invoices_Conflicts",
    ]);
    expect(spreadsheet.sheets[0]!.cell(0, 4)?.userEnteredValue?.stringValue).toBe("__hikoutei_row_id");
    // Existing business cells preserved.
    expect(spreadsheet.sheets[0]!.cell(1, 1)?.userEnteredValue?.stringValue).toBe("INV-1");
    expect(spreadsheet.sheets[0]!.cell(1, 3)?.userEnteredValue?.numberValue).toBe(100);
  });

  it("adopt mode with columnMap: legacy headers survive, seeding works end to end (design §12)", async () => {
    // The §12 scenario: sheet headers differ from the property names. The
    // translation table rides on the adopted route's definition — the tab's
    // legacy headers are NEVER rewritten, and every downstream consumer keys
    // by the canonical field names.
    const spreadsheet = new StubSpreadsheet();
    spreadsheet.addTab("Invoices", {
      headers: ["memo", "Invoice No", "Customer Name", "Total (USD)"],
      rows: [
        ["legacy note", "INV-1", "Acme", 100],
        ["", "INV-2", "Beta", 200],
      ],
    });
    const result = await createTypedSheetsWithSyncInternal({
      dbName: join(tmpdir(), `hikoutei-adopt-colmap-${randomUUID()}.sqlite`),
      entities: [AdoptApiInvoice],
      env: {
        [SYNC_ENV_KEYS.SPREADSHEET_URL]: "https://docs.google.com/spreadsheets/d/adopt-api-test-1/edit",
        [SYNC_ENV_KEYS.CREDENTIALS_FILE]: credentialsPath(),
        [SYNC_ENV_KEYS.POLLING_INTERVAL_MS]: "3600000",
      },
      transport: new StubSheetsTransport(spreadsheet),
      adopt: {
        mode: "adopt",
        entities: {
          AdoptApiInvoice: {
            tabName: "Invoices",
            columnMap: {
              "Invoice No": "invoiceNo",
              "Customer Name": "customer",
              "Total (USD)": "total",
            },
          },
        },
      },
    });

    expect(result.kind).toBe("sync");
    const runtime = (result as { kind: "sync"; hikoutei: { close(): Promise<void> } }).hikoutei;
    try {
      // System tabs provisioned alongside the LEGACY-header tab.
      const titles = spreadsheet.sheets.map((s) => s.title);
      expect(titles).toContain("Invoices_System");
      expect(titles).toContain("Invoices_Conflicts");

      const invoices = spreadsheet.findTab("Invoices")!;
      // The legacy headers are PRESERVED (adoption never rewrites them) and
      // the row-id system column is appended after the managed block.
      expect(invoices.cell(0, 1)?.userEnteredValue?.stringValue).toBe("Invoice No");
      expect(invoices.cell(0, 2)?.userEnteredValue?.stringValue).toBe("Customer Name");
      expect(invoices.cell(0, 3)?.userEnteredValue?.stringValue).toBe("Total (USD)");
      expect(invoices.cell(0, 0)?.userEnteredValue?.stringValue).toBe("memo");
      expect(invoices.cell(0, 4)?.userEnteredValue?.stringValue).toBe("__hikoutei_row_id");
      // Deterministic anchors derived from the MAPPED PK values.
      expect(invoices.cell(1, 4)?.userEnteredValue?.stringValue).toBe("entity:INV-1");
      expect(invoices.cell(2, 4)?.userEnteredValue?.stringValue).toBe("entity:INV-2");
      // Existing cells untouched.
      expect(invoices.cell(1, 2)?.userEnteredValue?.stringValue).toBe("Acme");

      // D6 absorption through the translated route: a human edit on the
      // LEGACY header column flows sheet → SQLite → System_State.
      const service = (result as { kind: "sync"; service: import("@hikoutei/sync-engine/sync/service/SyncServiceBootstrap.js").InternalSyncService }).service;
      invoices.cell(1, 2)?.userEnteredValue?.stringValue;
      spreadsheet.findTab("Invoices")!.cells.set("1,2", { userEnteredValue: { stringValue: "EditedLive" } });
      await service.pollingSupervisor.runOnce();
      const customerValue = await service.storage.read(({ sql }) =>
        sql.get<{ normalized_value: string }>(
          "SELECT normalized_value FROM entity_field_state WHERE field_name = 'customer' AND entity_id LIKE '%INV-1'",
        ));
      expect(JSON.parse(customerValue!.normalized_value).value).toBe("EditedLive");

      // Drain the outbox: the System_State projection refreshes to the
      // absorbed edit.
      for (let pass = 0; pass < 6; pass += 1) {
        await service.effectSupervisor.runOnce();
        const pending = await service.storage.read(({ sql }) =>
          sql.get<{ count: number }>(
            "SELECT COUNT(*) AS count FROM sheet_effect_outbox WHERE status = 'pending'",
          ));
        if ((pending?.count ?? 0) === 0) break;
      }
      const systemTab = spreadsheet.findTab("Invoices_System")!;
      const systemRow = [1, 2].map((row) =>
        [0, 1].map((col) => systemTab.cell(row, col)?.userEnteredValue?.stringValue));
      expect(systemRow).toContainEqual(["INV-1", "EditedLive"]);
    } finally {
      await runtime.close().catch(() => undefined);
    }
  });

  it("adopt mode runs the full pipeline over the stub transport", async () => {
    const spreadsheet = foreignSpreadsheet();
    const result = await createTypedSheetsWithSyncInternal({
      dbName: join(tmpdir(), `hikoutei-adopt-e2e-${randomUUID()}.sqlite`),
      entities: [AdoptApiInvoice],
      env: {
        [SYNC_ENV_KEYS.SPREADSHEET_URL]: "https://docs.google.com/spreadsheets/d/adopt-api-test-1/edit",
        [SYNC_ENV_KEYS.CREDENTIALS_FILE]: credentialsPath(),
        [SYNC_ENV_KEYS.POLLING_INTERVAL_MS]: "3600000",
      },
      transport: new StubSheetsTransport(spreadsheet),
      adopt: { mode: "adopt", entities: { AdoptApiInvoice: { tabName: "Invoices", identityFrom: "auto" } } },
    });

    expect(result.kind).toBe("sync");
    const runtime = (result as { kind: "sync"; hikoutei: { close(): Promise<void> } }).hikoutei;
    try {
      // System_State + Sync_Conflicts tabs were provisioned on the stub.
      const titles = spreadsheet.sheets.map((s) => s.title);
      expect(titles).toContain("Invoices_System");
      expect(titles).toContain("Invoices_Conflicts");

      // The adopted tab gained the row-id column with deterministic anchors,
      // and the original cells are untouched.
      const invoices = spreadsheet.findTab("Invoices")!;
      expect(invoices.cell(0, 4)?.userEnteredValue?.stringValue).toBe("__hikoutei_row_id");
      expect(invoices.cell(1, 4)?.userEnteredValue?.stringValue).toBe("entity:INV-1");
      expect(invoices.cell(2, 4)?.userEnteredValue?.stringValue).toBe("entity:INV-2");
      expect(invoices.cell(1, 1)?.userEnteredValue?.stringValue).toBe("INV-1");
      expect(invoices.cell(2, 2)?.userEnteredValue?.stringValue).toBe("Beta");
    } finally {
      await runtime.close().catch(() => undefined);
    }
  });

  it("B1: dry-run reports BOTH entities ready in one runtime (two-entity adopt)", async () => {
    const spreadsheet = twoEntitySpreadsheet();
    const result = await createTypedSheetsWithSyncInternal({
      dbName: `:memory:${randomUUID()}`,
      entities: [AdoptApiInvoice, AdoptApiCustomer],
      env: {
        [SYNC_ENV_KEYS.SPREADSHEET_URL]: "https://docs.google.com/spreadsheets/d/adopt-api-test-1/edit",
        [SYNC_ENV_KEYS.CREDENTIALS_FILE]: credentialsPath(),
        [SYNC_ENV_KEYS.POLLING_INTERVAL_MS]: "3600000",
      },
      transport: new StubSheetsTransport(spreadsheet),
      adopt: {
        mode: "dry-run",
        entities: {
          AdoptApiInvoice: { tabName: "Invoices" },
          AdoptApiCustomer: { tabName: "Customers" },
        },
      },
    });

    const { report } = expectAdoptDryRun(result);
    expect(report.ok).toBe(true);
    expect(report.entities).toHaveLength(2);
    const byEntity = Object.fromEntries(report.entities.map((entity) => [entity.entityName, entity]));
    expect(byEntity.AdoptApiInvoice!.status).toBe("ready");
    expect(byEntity.AdoptApiCustomer!.status).toBe("ready");
    // Distinct derived System/Conflicts tabs per entity.
    expect(byEntity.AdoptApiInvoice!.tabsToProvision).toEqual(["Invoices_System", "Invoices_Conflicts"]);
    expect(byEntity.AdoptApiCustomer!.tabsToProvision).toEqual(["Customers_System", "Customers_Conflicts"]);
    // Dry-run never mutates.
    expect(spreadsheet.sheets.map((sheet) => sheet.title)).toEqual(["Invoices", "Customers"]);
  });

  it("B1: adopts TWO entities; a human edit on one leaves the other's projection untouched", async () => {
    const spreadsheet = twoEntitySpreadsheet();
    const result = await createTypedSheetsWithSyncInternal({
      dbName: join(tmpdir(), `hikoutei-adopt-2entity-${randomUUID()}.sqlite`),
      entities: [AdoptApiInvoice, AdoptApiCustomer],
      env: {
        [SYNC_ENV_KEYS.SPREADSHEET_URL]: "https://docs.google.com/spreadsheets/d/adopt-api-test-1/edit",
        [SYNC_ENV_KEYS.CREDENTIALS_FILE]: credentialsPath(),
        [SYNC_ENV_KEYS.POLLING_INTERVAL_MS]: "3600000",
      },
      transport: new StubSheetsTransport(spreadsheet),
      adopt: {
        mode: "adopt",
        entities: {
          AdoptApiInvoice: { tabName: "Invoices", identityFrom: "auto" },
          AdoptApiCustomer: { tabName: "Customers", identityFrom: "auto" },
        },
      },
    });

    expect(result.kind).toBe("sync");
    const runtime = (result as { kind: "sync"; hikoutei: { close(): Promise<void> } }).hikoutei;
    try {
      // Each entity got its own System_State + Sync_Conflicts projection.
      const titles = spreadsheet.sheets.map((sheet) => sheet.title);
      expect(titles).toContain("Invoices_System");
      expect(titles).toContain("Invoices_Conflicts");
      expect(titles).toContain("Customers_System");
      expect(titles).toContain("Customers_Conflicts");

      // Both adopted tabs gained the row-id system column with anchors.
      const invoices = spreadsheet.findTab("Invoices")!;
      expect(invoices.cell(0, 4)?.userEnteredValue?.stringValue).toBe("__hikoutei_row_id");
      expect(invoices.cell(1, 4)?.userEnteredValue?.stringValue).toBe("entity:INV-1");
      const customers = spreadsheet.findTab("Customers")!;
      expect(customers.cell(0, 2)?.userEnteredValue?.stringValue).toBe("__hikoutei_row_id");
      expect(customers.cell(1, 2)?.userEnteredValue?.stringValue).toBe("entity:C-1");

      const service = (result as { kind: "sync"; service: import("@hikoutei/sync-engine/sync/service/SyncServiceBootstrap.js").InternalSyncService }).service;

      // D6 absorption on ONE entity only: edit the Invoices tab's customer cell.
      invoices.cells.set("1,2", { userEnteredValue: { stringValue: "EditedAcme" } });
      await service.pollingSupervisor.runOnce();

      const invoiceCustomer = await service.storage.read(({ sql }) =>
        sql.get<{ normalized_value: string }>(
          "SELECT normalized_value FROM entity_field_state WHERE field_name = 'customer' AND entity_id LIKE '%INV-1'"));
      expect(JSON.parse(invoiceCustomer!.normalized_value).value).toBe("EditedAcme");

      // The OTHER entity's seeded state is untouched.
      const customerCompany = await service.storage.read(({ sql }) =>
        sql.get<{ normalized_value: string }>(
          "SELECT normalized_value FROM entity_field_state WHERE field_name = 'company' AND entity_id LIKE '%C-1'"));
      expect(JSON.parse(customerCompany!.normalized_value).value).toBe("Acme Corp");

      // Drain the outbox; only Invoices_System reflects the edit. (Adopted
      // rows materialize their System_State projection on change; the
      // unedited entity is left untouched here and backfilled separately
      // below.)
      const drain = async () => {
        for (let pass = 0; pass < 6; pass += 1) {
          await service.effectSupervisor.runOnce();
          const pending = await service.storage.read(({ sql }) =>
            sql.get<{ count: number }>("SELECT COUNT(*) AS count FROM sheet_effect_outbox WHERE status = 'pending'"));
          if ((pending?.count ?? 0) === 0) break;
        }
      };
      await drain();

      const invoiceSystem = spreadsheet.findTab("Invoices_System")!;
      expect([1, 2].map((row) => [0, 1].map((col) => invoiceSystem.cell(row, col)?.userEnteredValue?.stringValue)))
        .toContainEqual(["INV-1", "EditedAcme"]);

      // The OTHER entity is unaffected by the Invoices edit: its System_State
      // carries no Invoices data and its adopted tab is untouched.
      const customerSystem = spreadsheet.findTab("Customers_System")!;
      expect([1, 2].map((row) => [0, 1].map((col) => customerSystem.cell(row, col)?.userEnteredValue?.stringValue)))
        .not.toContainEqual(["INV-1", "EditedAcme"]);
      expect(customers.cell(1, 0)?.userEnteredValue?.stringValue).toBe("C-1");
      expect(customers.cell(1, 1)?.userEnteredValue?.stringValue).toBe("Acme Corp");

      // Backfill the OTHER entity's System_State with its own edit: a human
      // edit on the Customers tab flows to Customers_System only.
      customers.cells.set("1,1", { userEnteredValue: { stringValue: "EditedCorp" } });
      await service.pollingSupervisor.runOnce();
      await drain();
      expect([1, 2].map((row) => [0, 1].map((col) => customerSystem.cell(row, col)?.userEnteredValue?.stringValue)))
        .toContainEqual(["C-1", "EditedCorp"]);
      // Invoices_System still holds only its own row — no cross-entity leak.
      expect([1, 2].map((row) => [0, 1].map((col) => invoiceSystem.cell(row, col)?.userEnteredValue?.stringValue)))
        .not.toContainEqual(["C-1", "EditedCorp"]);
    } finally {
      await runtime.close().catch(() => undefined);
    }
  });
});