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
} from "../src/application/sync/service/syncAutoStart.js";
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
});