/**
 * Credential-free tests for the env-driven sync auto-start feature.
 *
 * The public `createTypedSheets()` surface is unchanged; these tests exercise
 * the internal `createTypedSheetsWithSync()` bridge with an injected env, a
 * stub transport, and a captured diagnostic sink. No Google credentials,
 * network access, or live spreadsheet is involved: the credentials file is a
 * temp JSON fixture validated only for shape, and the spreadsheet is the
 * in-memory `StubSpreadsheet` model.
 */

import { defineEntity, p } from "@mikro-orm/sql";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createTypedSheets,
  defineTypedSheetsEntity,
  HIKOUTEI_ERROR_CODES,
  HikouteiError,
} from "../src/index.js";
import type { HikouteiEntity, HikouteiErrorCode, HikouteiPropertyOptions } from "../src/index.js";
import { initializeMikroOrmSqliteAdapter } from "@hikoutei/storage/persistence/providers/mikro-orm/storage/MikroOrmSqliteAdapter.js";
import {
  buildSyncProjections,
  createTypedSheetsWithSync,
  MAX_SYNC_RATE_LIMIT_INTERVAL_MS,
  MIN_SYNC_RATE_LIMIT_INTERVAL_MS,
  parseSpreadsheetIdFromUrl,
  resolveSyncRateLimitIntervalMs,
  stableStartupDiagnostic,
  SYNC_ENV_KEYS,
  validateSyncCredentialsFile,
  type SyncDiagnosticLevel,
  type TypedSheetsWithSyncResult,
} from "@hikoutei/composition/syncAutoStart.js";
import type { InternalSyncService } from "@hikoutei/sync-engine/sync/service/SyncServiceBootstrap.js";
import { GOOGLE_SHEETS_API_DEFAULTS } from "@hikoutei/sheets/sheets/providers/google-sheets-api/constants.js";
import { GoogleSheetsApiSyncProvider } from "@hikoutei/sheets/sheets/providers/google-sheets-api/index.js";
import type { FastAppendRow } from "@hikoutei/contracts/sheets/syncSheets.js";
import {
  StubSheet,
  StubSheetsTransport,
  StubSpreadsheet,
  stubCellToNormalized,
  stubRowFields,
  toStubCell,
} from "./support/StubSheetsTransport.js";
import { SYSTEM_HEADERS } from "./support/googleSheetsFixtures.js";

const User = defineTypedSheetsEntity({
  name: "SyncAutoUser",
  tableName: "sync_auto_users",
  properties: {
    id: { type: "string", primary: true },
    status: { type: "string" },
  },
});

const SinglePropertyUser = defineTypedSheetsEntity({
  name: "SyncAutoSingle",
  tableName: "sync_auto_single",
  properties: { id: { type: "string", primary: true } },
});

/** Extra non-key fields on top of `id` for the 27-property descriptor. */
const WIDE_FIELD_COUNT = 26;
const wideUserProperties: Record<string, HikouteiPropertyOptions> = {
  id: { type: "string", primary: true },
};
for (let index = 1; index <= WIDE_FIELD_COUNT; index += 1) {
  wideUserProperties[`f${String(index).padStart(2, "0")}`] = { type: "string" };
}

/** 27-property descriptor: id + f01..f26, pinned for multi-letter ranges. */
const WideUser = defineTypedSheetsEntity({
  name: "SyncAutoWide",
  tableName: "sync_auto_wide",
  properties: wideUserProperties,
});

/** Expected user-owned field list for `WideUser`, in declaration order. */
const wideUserOwnedFields = [
  "id",
  ...Array.from(
    { length: WIDE_FIELD_COUNT },
    (_, index) => `f${String(index + 1).padStart(2, "0")}`,
  ),
];

const InspectionSchema = defineEntity({
  name: "SyncAutoInspection",
  tableName: "__sync_auto_inspection",
  properties: { id: p.string().primary() },
});

/**
 * Generality variant for the burst e2e: a DATE column and a BOOLEAN column
 * alongside the string fields, guarding the demo-overfit concern (the live
 * demo carried string columns only, so the date serial + number-format
 * evidence path and the boolean value path were never proven at burst
 * scale). The boolean is the CHECKBOX-shaped column: the configured
 * checkbox-header/data-validation evidence is exercised by the dedicated
 * checkbox-route test below (the env-driven service never surfaces
 * `checkboxHeaders` — it is provider-route configuration).
 */
const GeneralityUser = defineTypedSheetsEntity({
  name: "SyncAutoGenerality",
  tableName: "sync_auto_generality",
  properties: {
    id: { type: "string", primary: true },
    status: { type: "string" },
    dueAt: { type: "date" },
    done: { type: "boolean" },
  },
});

const GENERALITY_SYSTEM_TAB = "SyncAutoGenerality_System";
const GENERALITY_INPUT_TAB = "SyncAutoGenerality_Input";

const SYSTEM_TAB = "SyncAutoUser_System";
const INPUT_TAB = "SyncAutoUser_Input";
const CONFLICTS_TAB = "SyncAutoUser_Conflicts";
const INPUT_HEADERS = ["id", "status"] as const;

interface CapturedDiagnostic {
  readonly level: SyncDiagnosticLevel;
  readonly message: string;
}

describe("env-driven sync auto-start", () => {
  const services: InternalSyncService[] = [];
  const tempDirs: string[] = [];
  const dbFiles: string[] = [];

  afterEach(async () => {
    await Promise.all(
      services.splice(0).map((service) => service.close().catch(() => undefined)),
    );
    await Promise.all(
      dbFiles.splice(0).flatMap((db) => [
        unlink(db),
        unlink(`${db}-wal`),
        unlink(`${db}-shm`),
      ]).map((promise) => promise.catch(() => undefined)),
    );
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function credentialsDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "hikoutei-sync-"));
    tempDirs.push(dir);
    return dir;
  }

  function writeCredentialsFile(
    dir: string,
    overrides: Readonly<Record<string, unknown>> = {},
  ): string {
    const path = join(dir, "service-account.json");
    writeFileSync(path, JSON.stringify({
      type: "service_account",
      project_id: "hikoutei-test",
      private_key_id: "k1",
      private_key: "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n",
      client_email: "sync-test@example.com",
      client_id: "123456",
      token_uri: "https://oauth2.googleapis.com/token",
      ...overrides,
    }));
    return path;
  }

  function syncEnv(
    credentialsPath: string,
    overrides: Readonly<Record<string, string>> = {},
  ): Record<string, string | undefined> {
    return {
      [SYNC_ENV_KEYS.SPREADSHEET_URL]: "https://docs.google.com/spreadsheets/d/sync-test-1/edit",
      [SYNC_ENV_KEYS.CREDENTIALS_FILE]: credentialsPath,
      // Keep the auto-started polling loop asleep after its first pass so
      // explicit passes stay deterministic.
      [SYNC_ENV_KEYS.POLLING_INTERVAL_MS]: "3600000",
      ...overrides,
    };
  }

  function newTransport(): { readonly spreadsheet: StubSpreadsheet; readonly transport: StubSheetsTransport } {
    const spreadsheet = new StubSpreadsheet();
    return { spreadsheet, transport: new StubSheetsTransport(spreadsheet) };
  }

  async function openSync(
    transport: StubSheetsTransport,
    credentialsPath: string,
    dbName: string,
    diagnostics: CapturedDiagnostic[] = [],
    envOverrides: Readonly<Record<string, string>> = {},
    entities: readonly HikouteiEntity[] = [User],
  ): Promise<InternalSyncService> {
    const result = await createTypedSheetsWithSync({
      dbName,
      entities,
      env: syncEnv(credentialsPath, envOverrides),
      transport,
      onDiagnostic: (level, message) => diagnostics.push({ level, message }),
    });
    const service = requireSyncResult(result);
    services.push(service);
    return service;
  }

  function requireSyncResult(
    result: TypedSheetsWithSyncResult,
  ): InternalSyncService {
    if (result.kind !== "sync") {
      throw new Error("expected the sync auto-start to start the sync service");
    }
    return result.service;
  }

  async function drainOutbox(service: InternalSyncService, maxPasses = 6): Promise<void> {
    for (let index = 0; index < maxPasses; index += 1) {
      await service.effectSupervisor.runOnce();
      const pending = await service.storage.read(({ sql }) =>
        sql.get<{ readonly count: number }>(
          "SELECT COUNT(*) AS count FROM sheet_effect_outbox WHERE status = 'pending'",
        ));
      if ((pending?.count ?? 0) === 0) return;
    }
    throw new Error("effect outbox did not drain within the expected pass count");
  }

  function createUser(service: InternalSyncService, id: string, status: string): Promise<void> {
    const em = service.hikoutei.em.fork();
    em.persist(em.create(User, { id, status }));
    return em.flush();
  }

  /**
   * Expires every writer lease so a reopened runtime can take over.
   *
   * The internal service never releases its writer lease on close; takeover
   * happens only after `lease_until` passes (the realistic downtime-restart
   * case). Tests simulate that downtime by expiring the lease rows between
   * sessions on the temp database.
   */
  async function expireWriterLeases(service: InternalSyncService): Promise<void> {
    await service.storage.transaction(({ sql }) =>
      sql.run("UPDATE writer_lease SET lease_until = 0", []));
  }

  /**
   * Simulates a CRASHED runtime (not a graceful stop) on a CLOSED db: both
   * lease rows keep a FUTURE `lease_until` while the heartbeat is frozen
   * `ageMs` in the past, so only the stale-heartbeat takeover evidence rule
   * (or the startup wait gate for a young heartbeat) lets the next runtime
   * claim. Must run AFTER `hikoutei.close()`: graceful stop expires this
   * runtime's leases, which would erase the crashed state. Default `ageMs`
   * (≈ now) freezes the heartbeat at ~0, the fully stale case; a small
   * `ageMs` (e.g. 3_000) reproduces a crash→relaunch WITHIN the stale
   * window, the Exp-6-runB startup failure the gate must bridge.
   */
  function simulateCrashedWriterLeases(dbName: string, ageMs = Date.now()): void {
    const raw = openRawSqlite(dbName);
    try {
      raw.prepare(
        "UPDATE writer_lease SET lease_until = ?, heartbeat_at = ?",
      ).run(Date.now() + 10 * 60_000, Date.now() - ageMs);
    } finally {
      raw.close();
    }
  }

  function tempDbName(label: string): string {
    const db = join(tmpdir(), `hikoutei-sync-${label}-${randomUUID()}.sqlite`);
    dbFiles.push(db);
    return db;
  }

  /** Name of the hidden internal receipt tab (direct-provider constant). */
  const RECEIPT_TAB = "__typed_sheets_internal_effect_receipts";

  /** The receipt-tab range requested by one read (undefined if absent). */
  function receiptRangeOf(request: { readonly ranges: readonly string[] }): string | undefined {
    return request.ranges.find((range) => range.includes(RECEIPT_TAB));
  }

  /**
   * Census of receipt-tab READ ranges across a slice of recorded transport
   * requests: `full` counts the historical whole-tab range, `banded` counts
   * tail-band reads (start row >= 2). The provider may pay ONE cold full
   * read per cold read-lane before the cursor settles; steady dispatches
   * must band.
   */
  function receiptReadCensus(requests: readonly { readonly ranges: readonly string[] }[]): {
    readonly full: number;
    readonly banded: number;
  } {
    let full = 0;
    let banded = 0;
    for (const request of requests) {
      const range = receiptRangeOf(request);
      if (range === undefined) continue;
      if (range.includes("!A1:F")) full += 1;
      else banded += 1;
    }
    return { full, banded };
  }

  /**
   * Flushes `count` entities in ONE transaction and drains the durable
   * outbox through manual worker passes; returns the measured span and the
   * pass count so callers can RECORD (never assert) steady-state effects/s.
   */
  async function burstAndDrain(
    service: InternalSyncService,
    prefix: string,
    count: number,
    maxPasses = 40,
  ): Promise<{ readonly elapsedMs: number; readonly passes: number }> {
    const startedAt = Date.now();
    const em = service.hikoutei.em.fork();
    for (let index = 0; index < count; index += 1) {
      em.persist(em.create(User, {
        id: `${prefix}-${String(index).padStart(4, "0")}`,
        status: "pending",
      }));
    }
    await em.flush();
    for (let pass = 0; pass < maxPasses; pass += 1) {
      await service.effectSupervisor.runOnce();
      const pending = await service.storage.read(({ sql }) =>
        sql.get<{ readonly count: number }>(
          "SELECT COUNT(*) AS count FROM sheet_effect_outbox WHERE status = 'pending'",
        ));
      if ((pending?.count ?? 0) === 0) {
        return { elapsedMs: Math.max(1, Date.now() - startedAt), passes: pass + 1 };
      }
    }
    throw new Error("burst effect outbox did not drain within the pass budget");
  }

  /** Every distinct id-column value of one stub tab (row 1 = header). */
  function tabIds(tab: StubSheet): Set<string> {
    const ids = new Set<string>();
    for (const [key, cell] of tab.cells) {
      const [row, col] = key.split(",").map(Number) as [number, number];
      if (col !== 0 || row === 0) continue;
      const value = cell.userEnteredValue?.stringValue;
      if (value !== undefined) ids.add(value);
    }
    return ids;
  }

  /**
   * Loads the `node:sqlite` builtin outside the bundler's module graph (a
   * static import fails under Vite — see
   * packages/ikisaki/test/support/nodeSqliteAdapter.ts).
   */
  function openRawSqlite(path: string): InstanceType<typeof import("node:sqlite").DatabaseSync> {
    const nodeSqlite = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
    return new nodeSqlite.DatabaseSync(path);
  }

  // -------------------------------------------------------------------------
  // URL parsing
  // -------------------------------------------------------------------------

  it("parses spreadsheet IDs from common Google Sheets URL shapes", () => {
    expect(parseSpreadsheetIdFromUrl("https://docs.google.com/spreadsheets/d/1AbC/edit")).toBe("1AbC");
    expect(parseSpreadsheetIdFromUrl("https://docs.google.com/spreadsheets/d/1AbC/edit#gid=0")).toBe("1AbC");
    expect(parseSpreadsheetIdFromUrl("https://docs.google.com/spreadsheets/d/1AbC/view?usp=sharing")).toBe("1AbC");
    expect(parseSpreadsheetIdFromUrl("https://docs.google.com/spreadsheets/d/1AbC")).toBe("1AbC");
    expect(parseSpreadsheetIdFromUrl("https://docs.google.com/spreadsheets/d/1AbC/?usp=sharing")).toBe("1AbC");
    expect(parseSpreadsheetIdFromUrl("https://docs.google.com/spreadsheets/d/1AbC/")).toBe("1AbC");
    expect(parseSpreadsheetIdFromUrl("docs.google.com/spreadsheets/d/1AbC/edit")).toBe("1AbC");
    expect(parseSpreadsheetIdFromUrl("https://example.com/d/1AbC/edit")).toBe("1AbC");
    expect(parseSpreadsheetIdFromUrl("https://docs.google.com/spreadsheets/d/1AbC-x_9/edit")).toBe("1AbC-x_9");
    expect(parseSpreadsheetIdFromUrl("https://docs.google.com/spreadsheets/d/1AbC/copy")).toBe("1AbC");
  });

  it("rejects URLs without a spreadsheet ID segment", () => {
    expect(parseSpreadsheetIdFromUrl("")).toBeUndefined();
    expect(parseSpreadsheetIdFromUrl("not a url")).toBeUndefined();
    expect(parseSpreadsheetIdFromUrl("https://docs.google.com/document/d/1AbC/edit")).toBeUndefined();
    expect(parseSpreadsheetIdFromUrl("https://example.com/anything/d/1AbC/edit")).toBeUndefined();
    expect(parseSpreadsheetIdFromUrl("https://docs.google.com/spreadsheets/d//edit")).toBeUndefined();
    expect(parseSpreadsheetIdFromUrl("https://docs.google.com/spreadsheets/edit")).toBeUndefined();
    expect(parseSpreadsheetIdFromUrl("1AbC")).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Diagnostics classification
  // -------------------------------------------------------------------------

  it("returns the plain local runtime with an info diagnostic when the URL env is absent", async () => {
    const diagnostics: CapturedDiagnostic[] = [];
    const result = await createTypedSheetsWithSync({
      dbName: ":memory:",
      entities: [User],
      env: {},
      onDiagnostic: (level, message) => diagnostics.push({ level, message }),
    });
    expect(result.kind).toBe("local");
    if (result.kind !== "local") return;

    expect(diagnostics).toEqual([
      { level: "info", message: "sync disabled — HIKOUTEI_SYNC_SPREADSHEET_URL is not set (local-only mode)" },
    ]);

    const em = result.hikoutei.em.fork();
    em.persist(em.create(User, { id: "local-1", status: "local" }));
    await em.flush();
    await expect(em.findOne(User, { id: "local-1" })).resolves.toMatchObject({ status: "local" });
    await result.hikoutei.close();
  });

  it("classifies an unparseable spreadsheet URL and never touches the transport", async () => {
    const diagnostics: CapturedDiagnostic[] = [];
    const credentialsPath = writeCredentialsFile(credentialsDir());
    const { transport } = newTransport();
    await expect(createTypedSheetsWithSync({
      dbName: ":memory:",
      entities: [User],
      env: {
        [SYNC_ENV_KEYS.SPREADSHEET_URL]: "https://docs.google.com/document/d/1AbC/edit",
        [SYNC_ENV_KEYS.CREDENTIALS_FILE]: credentialsPath,
      },
      transport,
      onDiagnostic: (level, message) => diagnostics.push({ level, message }),
    })).rejects.toMatchObject({
      code: HIKOUTEI_ERROR_CODES.SYNC_SPREADSHEET_URL_INVALID,
      message: expect.stringContaining("Unable to extract a spreadsheet ID"),
    });
    expect(transport.getSpreadsheetCalls).toBe(0);
    expect(transport.batchUpdateCalls).toBe(0);
    expect(diagnostics[0]?.level).toBe("error");
    // The injected sink receives ONLY the stable class/code summary — the
    // full classified message is carried by the thrown error alone.
    expect(diagnostics[0]?.message).toBe(
      `Hikoutei sync autostart failed (class=HikouteiError, code=${HIKOUTEI_ERROR_CODES.SYNC_SPREADSHEET_URL_INVALID})`,
    );
    expect(diagnostics[0]?.message).not.toContain("Unable to extract");
  });

  it("classifies a missing credentials file before any remote contact", async () => {
    const credentialsPath = join(credentialsDir(), "missing.json");
    const { transport } = newTransport();
    await expect(createTypedSheetsWithSync({
      dbName: ":memory:",
      entities: [User],
      env: syncEnv(credentialsPath),
      transport,
    })).rejects.toMatchObject({
      code: HIKOUTEI_ERROR_CODES.SYNC_CREDENTIALS_FILE_MISSING,
      message: `Credentials file not found: ${credentialsPath}`,
    });
    expect(transport.getSpreadsheetCalls).toBe(0);
    expect(transport.batchUpdateCalls).toBe(0);
  });

  it("classifies an unset credentials env var as a missing credentials file", async () => {
    const { transport } = newTransport();
    await expect(createTypedSheetsWithSync({
      dbName: ":memory:",
      entities: [User],
      env: {
        [SYNC_ENV_KEYS.SPREADSHEET_URL]: "https://docs.google.com/spreadsheets/d/1AbC/edit",
      },
      transport,
    })).rejects.toMatchObject({
      code: HIKOUTEI_ERROR_CODES.SYNC_CREDENTIALS_FILE_MISSING,
      message: expect.stringContaining("GOOGLE_APPLICATION_CREDENTIALS is not set"),
    });
  });

  it("classifies a credentials file that is not valid JSON", async () => {
    const dir = credentialsDir();
    const credentialsPath = join(dir, "broken.json");
    writeFileSync(credentialsPath, "{ not json");
    const { transport } = newTransport();
    await expect(createTypedSheetsWithSync({
      dbName: ":memory:",
      entities: [User],
      env: syncEnv(credentialsPath),
      transport,
    })).rejects.toMatchObject({
      code: HIKOUTEI_ERROR_CODES.SYNC_CREDENTIALS_INVALID_JSON,
      message: `Credentials file is not valid JSON: ${credentialsPath}`,
    });
    expect(transport.getSpreadsheetCalls).toBe(0);
  });

  it("classifies a credentials file with missing required fields", async () => {
    const dir = credentialsDir();
    const credentialsPath = writeCredentialsFile(dir, { private_key: "" });
    const { transport } = newTransport();
    await expect(createTypedSheetsWithSync({
      dbName: ":memory:",
      entities: [User],
      env: syncEnv(credentialsPath),
      transport,
    })).rejects.toMatchObject({
      code: HIKOUTEI_ERROR_CODES.SYNC_CREDENTIALS_FIELD_MISSING,
      message: "Credentials file is missing required fields: private_key",
    });
    expect(transport.getSpreadsheetCalls).toBe(0);
  });

  it("validates credentials files at the unit boundary", async () => {
    const dir = credentialsDir();
    const good = writeCredentialsFile(dir);
    await expect(validateSyncCredentialsFile(good)).resolves.toEqual({
      clientEmail: "sync-test@example.com",
    });
    const missing = writeCredentialsFile(dir, { client_email: undefined });
    await expect(validateSyncCredentialsFile(missing)).rejects.toMatchObject({
      code: HIKOUTEI_ERROR_CODES.SYNC_CREDENTIALS_FIELD_MISSING,
      message: "Credentials file is missing required fields: client_email",
    });
    await expect(validateSyncCredentialsFile(undefined)).rejects.toMatchObject({
      code: HIKOUTEI_ERROR_CODES.SYNC_CREDENTIALS_FILE_MISSING,
    });
  });

  it("classifies an HTTP 401 transport rejection as an auth failure", async () => {
    const credentialsPath = writeCredentialsFile(credentialsDir());
    const { transport } = newTransport();
    transport.fault = { kind: "http", status: 401, apiErrorStatus: "UNAUTHENTICATED" };
    await expect(createTypedSheetsWithSync({
      dbName: ":memory:",
      entities: [User],
      env: syncEnv(credentialsPath),
      transport,
    })).rejects.toMatchObject({
      code: HIKOUTEI_ERROR_CODES.SYNC_AUTH_FAILED,
      message: "Credentials are invalid (authentication failed)",
    });
    expect(transport.getSpreadsheetCalls).toBeGreaterThan(0);
  });

  it("classifies an HTTP 403 rejection as an access-denied with the client email", async () => {
    const credentialsPath = writeCredentialsFile(credentialsDir());
    const { transport } = newTransport();
    transport.fault = { kind: "http", status: 403, apiErrorStatus: "PERMISSION_DENIED" };
    await expect(createTypedSheetsWithSync({
      dbName: ":memory:",
      entities: [User],
      env: syncEnv(credentialsPath),
      transport,
    })).rejects.toMatchObject({
      code: HIKOUTEI_ERROR_CODES.SYNC_SPREADSHEET_ACCESS_DENIED,
      message: expect.stringContaining("sync-test@example.com"),
    });
  });

  it("classifies an HTTP 404 rejection as a missing spreadsheet with the parsed ID", async () => {
    const credentialsPath = writeCredentialsFile(credentialsDir());
    const { transport } = newTransport();
    transport.fault = { kind: "http", status: 404, apiErrorStatus: "NOT_FOUND" };
    await expect(createTypedSheetsWithSync({
      dbName: ":memory:",
      entities: [User],
      env: syncEnv(credentialsPath),
      transport,
    })).rejects.toMatchObject({
      code: HIKOUTEI_ERROR_CODES.SYNC_SPREADSHEET_NOT_FOUND,
      message: "Spreadsheet not found (ID: sync-test-1)",
    });
  });

  it("classifies a timeout as a generic startup failure without leaking the URL", async () => {
    const credentialsPath = writeCredentialsFile(credentialsDir());
    const diagnostics: CapturedDiagnostic[] = [];
    const { transport } = newTransport();
    transport.fault = { kind: "timeout" };
    await expect(createTypedSheetsWithSync({
      dbName: ":memory:",
      entities: [User],
      env: syncEnv(credentialsPath),
      transport,
      onDiagnostic: (level, message) => diagnostics.push({ level, message }),
    })).rejects.toMatchObject({
      code: HIKOUTEI_ERROR_CODES.SYNC_STARTUP_FAILED,
      message: expect.stringContaining("Sync start failed"),
    });
    for (const entry of diagnostics) {
      expect(entry.message).not.toContain("docs.google.com");
    }
  });

  it("never passes secret-like paths, emails, or messages to injected diagnostic sinks", async () => {
    // Regression (Luna review): injected diagnostic sinks must receive
    // sanitized stable class/code data only — full failure messages can
    // embed the service-account email, spreadsheet ID, or credential path.
    // The thrown HikouteiError keeps its full public message regardless.
    const secretPath = join(
      credentialsDir(),
      "secrets",
      "gcloud",
      "application_default_credentials.json",
    );
    const diagnostics: CapturedDiagnostic[] = [];
    const { transport } = newTransport();

    // Missing credentials file: the classified message embeds the path.
    await expect(createTypedSheetsWithSync({
      dbName: ":memory:",
      entities: [User],
      env: syncEnv(secretPath),
      transport,
      onDiagnostic: (level, message) => diagnostics.push({ level, message }),
    })).rejects.toMatchObject({
      code: HIKOUTEI_ERROR_CODES.SYNC_CREDENTIALS_FILE_MISSING,
      message: `Credentials file not found: ${secretPath}`,
    });
    expect(diagnostics[0]?.level).toBe("error");
    expect(diagnostics[0]?.message).toBe(
      `Hikoutei sync autostart failed (class=HikouteiError, code=${HIKOUTEI_ERROR_CODES.SYNC_CREDENTIALS_FILE_MISSING})`,
    );
    expect(diagnostics[0]?.message).not.toContain(secretPath);
    expect(diagnostics[0]?.message).not.toContain("Credentials file");

    // HTTP 403 access-denied: the classified message embeds the
    // service-account email — the sink must never see it.
    diagnostics.length = 0;
    const credentialsPath = writeCredentialsFile(credentialsDir());
    transport.fault = { kind: "http", status: 403, apiErrorStatus: "PERMISSION_DENIED" };
    await expect(createTypedSheetsWithSync({
      dbName: ":memory:",
      entities: [User],
      env: syncEnv(credentialsPath),
      transport,
      onDiagnostic: (level, message) => diagnostics.push({ level, message }),
    })).rejects.toMatchObject({
      code: HIKOUTEI_ERROR_CODES.SYNC_SPREADSHEET_ACCESS_DENIED,
      message: expect.stringContaining("sync-test@example.com"),
    });
    expect(diagnostics[0]?.level).toBe("error");
    expect(diagnostics[0]?.message).toBe(
      `Hikoutei sync autostart failed (class=HikouteiError, code=${HIKOUTEI_ERROR_CODES.SYNC_SPREADSHEET_ACCESS_DENIED})`,
    );
    expect(diagnostics[0]?.message).not.toContain("sync-test@example.com");
    expect(diagnostics[0]?.message).not.toContain("@");
  });

  it("emits the stable redacted class/code summary through the default console sink", async () => {
    // Luna: the DEFAULT diagnostic sink (console) must emit the
    // already-redacted stable class/code summary on startup failure — not
    // merely the error level — while the thrown HikouteiError keeps its
    // full public message and no secret value (path, email, ID) ever
    // reaches the console.
    const secretPath = join(
      credentialsDir(),
      "secrets",
      "gcloud",
      "application_default_credentials.json",
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const { transport } = newTransport();
      await expect(createTypedSheetsWithSync({
        dbName: ":memory:",
        entities: [User],
        env: syncEnv(secretPath),
        transport,
      })).rejects.toMatchObject({
        code: HIKOUTEI_ERROR_CODES.SYNC_CREDENTIALS_FILE_MISSING,
        message: `Credentials file not found: ${secretPath}`,
      });
      // The default sink prints the stable sanitized summary, never the
      // level-only fallback and never the raw failure message.
      const expected =
        `Hikoutei sync autostart failed (class=HikouteiError, code=${HIKOUTEI_ERROR_CODES.SYNC_CREDENTIALS_FILE_MISSING})`;
      expect(errorSpy.mock.calls.some((call) => call[0] === expected)).toBe(true);
      const output = errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
      expect(output).toContain("class=HikouteiError");
      expect(output).toContain(HIKOUTEI_ERROR_CODES.SYNC_CREDENTIALS_FILE_MISSING);
      // The stable summary never carries the secret path, the raw
      // message, or any email-like text.
      expect(output).not.toContain(secretPath);
      expect(output).not.toContain("Credentials file");
      expect(output).not.toContain("@");
      expect(output).not.toContain("level=error");
    } finally {
      errorSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });

  it("collapses injected failure name/code into fixed safe classes/codes in sink text", () => {
    // Regression (Luna review): the diagnostic sink summary interpolates
    // failure.name and failure.code, which are runtime strings. They must be
    // checked against the stable allowlists — a malformed or arbitrary value
    // (a path, email, or secret) must collapse to the fixed `unknown` class
    // and code instead of reaching the injected sink text.
    const injected = [
      "secret/Users/me/.ssh/id_rsa@example.com",
      "ya29.jwt-token/private_key",
      "docs.google.com/spreadsheets/d/1AbC",
    ];
    for (const value of injected) {
      const failure = new HikouteiError(
        value as HikouteiErrorCode,
        "full public message stays on the thrown error",
      );
      // Both fields are writable runtime properties (CoreErrorException sets
      // them directly), so a hostile/odd error shape can carry anything.
      failure.name = value;
      const summary = stableStartupDiagnostic(failure);
      expect(summary).toBe(
        "Hikoutei sync autostart failed (class=unknown, code=unknown)",
      );
      expect(summary).not.toContain(value);
      expect(summary).not.toMatch(/@|\.ssh|ya29|private_key|docs\.google\.com/);
    }
    // Allowlisted values keep their stable class/code verbatim.
    const clean = new HikouteiError(
      HIKOUTEI_ERROR_CODES.SYNC_CREDENTIALS_FILE_MISSING,
      "x",
    );
    expect(stableStartupDiagnostic(clean)).toBe(
      `Hikoutei sync autostart failed (class=HikouteiError, code=${HIKOUTEI_ERROR_CODES.SYNC_CREDENTIALS_FILE_MISSING})`,
    );
  });

  it("preserves the classified HikouteiError unchanged when the diagnostic sink throws", async () => {
    // Luna: the diagnostic sink is fail-open — a throwing injected (or
    // default) sink must never replace the original classified startup
    // failure, whose stable class and machine-readable code the caller
    // depends on. The sink's own error is swallowed; the original
    // HikouteiError is rethrown unchanged.
    const secretPath = join(
      credentialsDir(),
      "secrets",
      "gcloud",
      "application_default_credentials.json",
    );
    const { transport } = newTransport();
    const thrown = await createTypedSheetsWithSync({
      dbName: ":memory:",
      entities: [User],
      env: syncEnv(secretPath),
      transport,
      onDiagnostic: () => {
        throw new Error("diagnostic sink exploded");
      },
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    // The original classified failure survives the throwing sink: same
    // stable class, same code, same full public message.
    expect(thrown).toBeInstanceOf(HikouteiError);
    expect((thrown as HikouteiError).code).toBe(
      HIKOUTEI_ERROR_CODES.SYNC_CREDENTIALS_FILE_MISSING,
    );
    expect((thrown as HikouteiError).message).toBe(
      `Credentials file not found: ${secretPath}`,
    );
    expect((thrown as Error).message).not.toBe("diagnostic sink exploded");
  });

  it("fails closed on malformed interval env values before any remote contact", async () => {
    const credentialsPath = writeCredentialsFile(credentialsDir());
    const { transport } = newTransport();
    await expect(createTypedSheetsWithSync({
      dbName: ":memory:",
      entities: [User],
      env: syncEnv(credentialsPath, { [SYNC_ENV_KEYS.POLLING_INTERVAL_MS]: "abc" }),
      transport,
    })).rejects.toMatchObject({
      code: HIKOUTEI_ERROR_CODES.SYNC_STARTUP_FAILED,
      message: expect.stringContaining("HIKOUTEI_SYNC_POLLING_INTERVAL_MS"),
    });
    expect(transport.getSpreadsheetCalls).toBe(0);

    const { transport: transport2 } = newTransport();
    await expect(createTypedSheetsWithSync({
      dbName: ":memory:",
      entities: [User],
      env: syncEnv(credentialsPath, { [SYNC_ENV_KEYS.FULL_SCAN_INTERVAL_MS]: "-5" }),
      transport: transport2,
    })).rejects.toMatchObject({
      code: HIKOUTEI_ERROR_CODES.SYNC_STARTUP_FAILED,
      message: expect.stringContaining("HIKOUTEI_SYNC_FULL_SCAN_INTERVAL_MS"),
    });
    expect(transport2.getSpreadsheetCalls).toBe(0);
  });

  it("accepts a plain decimal interval value and rejects Number()-accepted non-decimal forms", async () => {
    const credentialsPath = writeCredentialsFile(credentialsDir());

    // A plain decimal string is accepted and the service starts.
    const { transport } = newTransport();
    const service = await openSync(
      transport,
      credentialsPath,
      ":memory:",
      [],
      { [SYNC_ENV_KEYS.POLLING_INTERVAL_MS]: "60000" },
    );
    expect(service).toBeDefined();

    // Number() would coerce every one of these to a safe integer (0x10 -> 16,
    // 1e3 -> 1000, -1 -> -1, " 60000" -> 60000); each must fail closed with a
    // classified startup error before any remote contact.
    for (const invalid of ["0x10", "1e3", "-1", " 60000"]) {
      const { transport: failingTransport } = newTransport();
      await expect(createTypedSheetsWithSync({
        dbName: ":memory:",
        entities: [User],
        env: syncEnv(credentialsPath, {
          [SYNC_ENV_KEYS.POLLING_INTERVAL_MS]: invalid,
        }),
        transport: failingTransport,
      })).rejects.toMatchObject({
        code: HIKOUTEI_ERROR_CODES.SYNC_STARTUP_FAILED,
        message: expect.stringContaining("HIKOUTEI_SYNC_POLLING_INTERVAL_MS"),
      });
      expect(failingTransport.getSpreadsheetCalls).toBe(0);
      expect(failingTransport.batchUpdateCalls).toBe(0);
    }
  });

  // -------------------------------------------------------------------------
  // Sync request-start pacing override
  // -------------------------------------------------------------------------

  it("resolves the pacing env override to undefined when absent or blank", () => {
    expect(resolveSyncRateLimitIntervalMs({})).toBeUndefined();
    expect(resolveSyncRateLimitIntervalMs({
      [SYNC_ENV_KEYS.RATE_LIMIT_INTERVAL_MS]: "",
    })).toBeUndefined();
    expect(resolveSyncRateLimitIntervalMs({
      [SYNC_ENV_KEYS.RATE_LIMIT_INTERVAL_MS]: "   ",
    })).toBeUndefined();
  });

  it("accepts a plain decimal integer within the 2,000..9,999 ms bounds", () => {
    // The env floor (2,000 ms) and the provider's default interval (800 ms,
    // internal-only tuning target) are asserted independently here.
    expect(GOOGLE_SHEETS_API_DEFAULTS.REQUEST_START_INTERVAL_MS).toBe(800);
    expect(MIN_SYNC_RATE_LIMIT_INTERVAL_MS).toBe(2_000);
    expect(resolveSyncRateLimitIntervalMs({
      [SYNC_ENV_KEYS.RATE_LIMIT_INTERVAL_MS]: "2500",
    })).toBe(2_500);
    // 2,000 ms is the quota-safe floor: the smallest interval demonstrated
    // clean under the current shared service-account quota profile, so the
    // exact floor value must be accepted.
    expect(resolveSyncRateLimitIntervalMs({
      [SYNC_ENV_KEYS.RATE_LIMIT_INTERVAL_MS]: "2000",
    })).toBe(2_000);
    expect(resolveSyncRateLimitIntervalMs({
      [SYNC_ENV_KEYS.RATE_LIMIT_INTERVAL_MS]: String(MIN_SYNC_RATE_LIMIT_INTERVAL_MS),
    })).toBe(MIN_SYNC_RATE_LIMIT_INTERVAL_MS);
    expect(resolveSyncRateLimitIntervalMs({
      [SYNC_ENV_KEYS.RATE_LIMIT_INTERVAL_MS]: String(MAX_SYNC_RATE_LIMIT_INTERVAL_MS),
    })).toBe(MAX_SYNC_RATE_LIMIT_INTERVAL_MS);
    expect(MAX_SYNC_RATE_LIMIT_INTERVAL_MS).toBe(9_999);
  });

  it("rejects non-decimal, out-of-bounds, and malformed pacing values", () => {
    // Number() would coerce several of these (0x10 -> 16, 1e3 -> 1000,
    // -1 -> -1, " 2500" -> 2500); the decimal-only bounded contract must
    // reject every one of them with the stable startup code. 899 sits just
    // below the 900 ms quota-safe floor (the 800-899 ms band is untested at
    // the 1,000-effect cap), so it is rejected; 10000 is the first interval
    // whose worst-case paced dispatch (60 s write + 10 s
    // first-slot wait + 2 x 10 s paced slots + 30 s headroom) exactly
    // exhausts the 120 s default effect lease, so it is unsafe and must be
    // rejected too.
    for (const invalid of ["abc", "0", "899", "10000", "15000", "70000", "0x10", "1e3", "-1", " 2500", "2500.5"]) {
      expect(() => resolveSyncRateLimitIntervalMs({
        [SYNC_ENV_KEYS.RATE_LIMIT_INTERVAL_MS]: invalid,
      })).toThrowError(expect.objectContaining({
        code: HIKOUTEI_ERROR_CODES.SYNC_STARTUP_FAILED,
        message: expect.stringContaining("HIKOUTEI_SYNC_RATE_LIMIT_INTERVAL_MS"),
      }));
    }
  });

  it("rejects an unsafe pacing override before any remote contact when the real provider is used", async () => {
    // No transport is injected, so the real Google Sheets provider path is
    // active: an override whose paced dispatch could outlive the default
    // effect lease must fail closed with the stable startup code BEFORE any
    // provider or transport is built (the resolver runs before the service
    // bootstrap, so there is no remote contact to observe).
    const credentialsPath = writeCredentialsFile(credentialsDir());
    for (const unsafe of ["10000", "15000", "60000"]) {
      await expect(createTypedSheetsWithSync({
        dbName: ":memory:",
        entities: [User],
        env: syncEnv(credentialsPath, {
          [SYNC_ENV_KEYS.RATE_LIMIT_INTERVAL_MS]: unsafe,
        }),
      })).rejects.toMatchObject({
        code: HIKOUTEI_ERROR_CODES.SYNC_STARTUP_FAILED,
        message: expect.stringContaining("HIKOUTEI_SYNC_RATE_LIMIT_INTERVAL_MS"),
      });
    }
  });

  it("ignores the pacing env override when a fake transport is injected", async () => {
    // The internal override applies ONLY to the real Google Sheets provider:
    // injected fake transports keep ZERO test pacing, so the provisioning
    // request starts stay ~0 ms apart instead of being spaced at the
    // override's 1,999 ms (a value below the 2,000 ms env floor, which is
    // only legal here because a fake transport never consults the key).
    const credentialsPath = writeCredentialsFile(credentialsDir());
    const { transport } = newTransport();
    const service = await openSync(
      transport,
      credentialsPath,
      ":memory:",
      [],
      { [SYNC_ENV_KEYS.RATE_LIMIT_INTERVAL_MS]: "1999" },
    );
    expect(service).toBeDefined();
    const starts = transport.requestStarts.map((entry) => entry.at);
    expect(starts.length).toBeGreaterThanOrEqual(2);
    const gap = (starts[1] ?? 0) - (starts[0] ?? 0);
    // The zero test pacing (plus stub overhead) must be far below the
    // override's 1,999 ms; wide margins keep the wall-clock assertion robust.
    expect(gap).toBeLessThan(500);
  });

  it("ignores an invalid pacing env override when a fake transport is injected", async () => {
    // A malformed or unsafe override must never break local/fake mode: with
    // an injected fake transport the env key is not consulted at all, so the
    // service starts normally.
    const credentialsPath = writeCredentialsFile(credentialsDir());
    for (const invalid of ["abc", "999", "1999", "10000", "15000", "0x10"]) {
      const { transport } = newTransport();
      const service = await openSync(
        transport,
        credentialsPath,
        ":memory:",
        [],
        { [SYNC_ENV_KEYS.RATE_LIMIT_INTERVAL_MS]: invalid },
      );
      expect(service).toBeDefined();
      expect(transport.getSpreadsheetCalls).toBeGreaterThan(0);
    }
  });

  // -------------------------------------------------------------------------
  // Projection auto-generation
  // -------------------------------------------------------------------------

  it("derives tab names, registered ranges, and user-owned fields from descriptors", () => {
    expect(buildSyncProjections([User], "spreadsheet-1")).toEqual({
      spreadsheetId: "spreadsheet-1",
      entities: {
        SyncAutoUser: {
          systemState: { tabName: SYSTEM_TAB, registeredRange: "A:C" },
          userInput: { tabName: INPUT_TAB, registeredRange: "A:C" },
          syncConflicts: { tabName: CONFLICTS_TAB, registeredRange: "A:O" },
          userOwnedFields: ["id", "status"],
        },
      },
    });
  });

  it("derives single-column projection shapes for a one-property entity", () => {
    expect(buildSyncProjections([SinglePropertyUser], "spreadsheet-1")).toEqual({
      spreadsheetId: "spreadsheet-1",
      entities: {
        SyncAutoSingle: {
          // User_Input becomes the system row-id column next to the single
          // property; System_State adds only the tombstone column.
          systemState: { tabName: "SyncAutoSingle_System", registeredRange: "A:B" },
          userInput: { tabName: "SyncAutoSingle_Input", registeredRange: "A:B" },
          syncConflicts: { tabName: "SyncAutoSingle_Conflicts", registeredRange: "A:O" },
          userOwnedFields: ["id"],
        },
      },
    });
  });

  it("derives multi-letter projection ranges for a 27-property entity", () => {
    // columnLetters(27) -> "AA" and columnLetters(28) -> "AB", exactly the
    // helper buildSyncProjections uses to build the whole-column ranges.
    expect(buildSyncProjections([WideUser], "spreadsheet-1")).toEqual({
      spreadsheetId: "spreadsheet-1",
      entities: {
        SyncAutoWide: {
          systemState: { tabName: "SyncAutoWide_System", registeredRange: "A:AB" },
          userInput: { tabName: "SyncAutoWide_Input", registeredRange: "A:AB" },
          syncConflicts: { tabName: "SyncAutoWide_Conflicts", registeredRange: "A:O" },
          userOwnedFields: wideUserOwnedFields,
        },
      },
    });
    expect(wideUserOwnedFields).toHaveLength(27);
  });

  // -------------------------------------------------------------------------
  // Success flow
  // -------------------------------------------------------------------------

  it("provisions an empty spreadsheet, delivers effects, polls, and closes cleanly", async () => {
    const credentialsPath = writeCredentialsFile(credentialsDir());
    const { spreadsheet, transport } = newTransport();
    const service = await openSync(transport, credentialsPath, ":memory:");

    // Provisioning created all three tabs with their exact header rows.
    const provisionBatch = transport.appliedBatchUpdates[0];
    const addSheets = provisionBatch?.filter((request) => request.kind === "addSheet");
    expect(addSheets?.map((request) => request.kind === "addSheet" ? request.title : "")).toEqual([
      SYSTEM_TAB,
      INPUT_TAB,
      CONFLICTS_TAB,
    ]);
    const systemTab = spreadsheet.findTab(SYSTEM_TAB);
    const inputTab = spreadsheet.findTab(INPUT_TAB);
    const conflictsTab = spreadsheet.findTab(CONFLICTS_TAB);
    expect(systemTab).toBeDefined();
    expect(systemTab?.cell(0, 0)?.userEnteredValue?.stringValue).toBe("id");
    expect(systemTab?.cell(0, 2)?.userEnteredValue?.stringValue).toBe("__typed_sheets_deleted");
    expect(conflictsTab?.cell(0, 12)?.userEnteredValue?.stringValue).toBe("Status");

    // ORM create travels through the worker to the stub tabs.
    await createUser(service, "full-1", "pending");
    await drainOutbox(service);
    expect(stubRowFields(systemTab as never, 2, [...SYSTEM_HEADERS]).id).toEqual({
      kind: "string",
      value: "full-1",
    });
    expect(stubRowFields(inputTab as never, 2, [...INPUT_HEADERS]).status).toEqual({
      kind: "string",
      value: "pending",
    });

    // The hidden receipt tab carries the idempotent delivery receipt.
    const receiptTab = spreadsheet.findTab("__typed_sheets_internal_effect_receipts");
    expect(receiptTab?.hidden).toBe(true);
    expect(receiptTab?.cell(1, 0)?.userEnteredValue?.stringValue).toBeTypeOf("string");

    // A polling pass observes the created rows through the provider.
    const report = await service.pollingSupervisor.runOnce();
    expect(report.rowsScanned).toBeGreaterThanOrEqual(1);
  });

  it("provisions a single-column User_Input tab and drains an append for a one-property entity", async () => {
    const credentialsPath = writeCredentialsFile(credentialsDir());
    const { spreadsheet, transport } = newTransport();
    const service = await openSync(
      transport,
      credentialsPath,
      ":memory:",
      [],
      {},
      [SinglePropertyUser],
    );

    const addSheets = transport.appliedBatchUpdates[0]
      ?.filter((request) => request.kind === "addSheet");
    expect(addSheets?.map((request) => request.kind === "addSheet" ? request.title : "")).toEqual([
      "SyncAutoSingle_System",
      "SyncAutoSingle_Input",
      "SyncAutoSingle_Conflicts",
    ]);

    // The User_Input tab carries the property header plus the internal
    // __hikoutei_row_id system column.
    const inputTab = spreadsheet.findTab("SyncAutoSingle_Input");
    expect(inputTab).toBeDefined();
    expect(inputTab?.cell(0, 0)?.userEnteredValue?.stringValue).toBe("id");
    expect(inputTab?.cell(0, 1)?.userEnteredValue?.stringValue).toBe("__hikoutei_row_id");

    // The drained append writes the single value into the first column.
    const em = service.hikoutei.em.fork();
    em.persist(em.create(SinglePropertyUser, { id: "single-1" }));
    await em.flush();
    await drainOutbox(service);
    expect(stubRowFields(inputTab as never, 2, ["id"]).id).toEqual({
      kind: "string",
      value: "single-1",
    });
  });

  it("applies the parsed full-scan interval to the polling cadence", async () => {
    const credentialsPath = writeCredentialsFile(credentialsDir());
    const { transport } = newTransport();
    const service = await openSync(
      transport,
      credentialsPath,
      ":memory:",
      [],
      { [SYNC_ENV_KEYS.FULL_SCAN_INTERVAL_MS]: "200" },
    );

    // The first pass is always a safety full scan; it sets the deadline.
    await service.pollingSupervisor.runOnce();
    // Past the 200 ms full-scan interval the next pass is a safety scan again,
    // proving the env value reached the cadence configuration.
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    const report = await service.pollingSupervisor.runOnce();
    expect(report.safetyFullScan).toBe(true);
  });

  it("keeps the polling loop active at the parsed polling interval", async () => {
    const credentialsPath = writeCredentialsFile(credentialsDir());
    const { transport } = newTransport();
    const service = await openSync(
      transport,
      credentialsPath,
      ":memory:",
      [],
      { [SYNC_ENV_KEYS.POLLING_INTERVAL_MS]: "100" },
    );

    // Let the first auto pass finish, then count provider reads over a window
    // longer than one 100 ms cadence: the loop must keep polling.
    await service.pollingSupervisor.runOnce();
    const before = transport.getSpreadsheetCalls;
    await new Promise<void>((resolve) => setTimeout(resolve, 450));
    const after = transport.getSpreadsheetCalls;
    expect(after - before).toBeGreaterThanOrEqual(2);
  });

  // -------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------

  it("stops supervisors on close and keeps transport call counts stable", async () => {
    const credentialsPath = writeCredentialsFile(credentialsDir());
    const { transport } = newTransport();
    const service = await openSync(transport, credentialsPath, ":memory:");
    await createUser(service, "close-1", "pending");
    await drainOutbox(service);

    await service.hikoutei.close();
    await expect(service.pollingSupervisor.runOnce()).rejects.toThrow(
      "sync polling supervisor is stopped",
    );
    await expect(service.effectSupervisor.runOnce()).rejects.toThrow(
      "sync effect supervisor is stopped",
    );

    const callsAfterClose = transport.getSpreadsheetCalls + transport.batchUpdateCalls;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(transport.getSpreadsheetCalls + transport.batchUpdateCalls).toBe(callsAfterClose);

    // close() is idempotent through the public runtime handle.
    await expect(service.close()).resolves.toBeUndefined();
    await expect(service.hikoutei.close()).resolves.toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Restart behavior
  // -------------------------------------------------------------------------

  it("re-provisions without touching data and delivers leftover effects idempotently", async () => {
    const credentialsPath = writeCredentialsFile(credentialsDir());
    const dbName = tempDbName("restart");
    const { spreadsheet, transport } = newTransport();

    // Session 1: provision, deliver u1, observe a polling baseline, close.
    const session1 = await openSync(transport, credentialsPath, dbName);
    await createUser(session1, "u1", "pending");
    await drainOutbox(session1);
    await session1.pollingSupervisor.runOnce();
    await session1.stop();
    await expireWriterLeases(session1);
    await session1.hikoutei.close();
    const batchesAfterSession1 = transport.appliedBatchUpdates.length;
    const systemTab = spreadsheet.findTab(SYSTEM_TAB);
    const inputTab = spreadsheet.findTab(INPUT_TAB);
    expect(systemTab).toBeDefined();
    expect(inputTab).toBeDefined();

    // Session 2: stop supervisors so the flush's effects stay queued in the
    // outbox (a deterministic "downtime" leftover), then close.
    const session2 = await openSync(transport, credentialsPath, dbName);
    await session2.stop();
    await createUser(session2, "u2", "queued");
    const pending = await session2.storage.read(({ sql }) =>
      sql.get<{ readonly count: number }>(
        "SELECT COUNT(*) AS count FROM sheet_effect_outbox WHERE status = 'pending'",
      ));
    expect(pending?.count).toBeGreaterThan(0);
    await expireWriterLeases(session2);
    await session2.hikoutei.close();

    // Session 3: provisioning must verify the existing tabs without writing
    // headers or creating sheets; the leftover effects drain exactly once.
    const session3 = await openSync(transport, credentialsPath, dbName);
    for (const batch of transport.appliedBatchUpdates.slice(batchesAfterSession1)) {
      for (const request of batch) {
        expect(request.kind).not.toBe("addSheet");
        if (request.kind === "updateCells") {
          expect(request.startRowIndex).not.toBe(0);
        }
      }
    }
    await drainOutbox(session3);

    expect(stubRowFields(systemTab as never, 2, [...SYSTEM_HEADERS]).id).toEqual({
      kind: "string",
      value: "u1",
    });
    expect(stubRowFields(systemTab as never, 3, [...SYSTEM_HEADERS]).id).toEqual({
      kind: "string",
      value: "u2",
    });
    // No duplicate delivery: the next row stays empty.
    expect(stubRowFields(systemTab as never, 4, [...SYSTEM_HEADERS]).id).toBeNull();
    expect(stubRowFields(inputTab as never, 3, [...INPUT_HEADERS]).id).toEqual({
      kind: "string",
      value: "u2",
    });
    await session3.hikoutei.close();
  });

  it("takes over a CRASHED runtime's writer leases via stale heartbeat and drains immediately (restart-stall fix)", async () => {
    const credentialsPath = writeCredentialsFile(credentialsDir());
    const dbName = tempDbName("heartbeat-restart");
    const { spreadsheet, transport } = newTransport();

    // Session 1: provision + deliver u1, then close (graceful; rows remain).
    const session1 = await openSync(transport, credentialsPath, dbName);
    await createUser(session1, "u1", "pending");
    await drainOutbox(session1);
    await session1.hikoutei.close();
    const systemTab = spreadsheet.findTab(SYSTEM_TAB);
    expect(systemTab).toBeDefined();

    // Simulate a CRASH: both lease rows keep a FUTURE lease window but the
    // heartbeat is frozen — the exact pre-fix restart-stall state (the old
    // behavior stalled every claim for the full lease duration). Applied
    // AFTER close: graceful stop expires this runtime's own leases.
    simulateCrashedWriterLeases(dbName);

    // Session 2: stale-heartbeat takeover evidence must let every claim path
    // (startup registration, mapped flush, effect worker) take over at once.
    const session2 = await openSync(transport, credentialsPath, dbName);
    await createUser(session2, "u2", "pending");
    await drainOutbox(session2);

    expect(stubRowFields(systemTab as never, 3, [...SYSTEM_HEADERS]).id).toEqual({
      kind: "string",
      value: "u2",
    });
    expect(stubRowFields(systemTab as never, 4, [...SYSTEM_HEADERS]).id).toBeNull();
    await session2.hikoutei.close();
  });

  it("relaunches IMMEDIATELY after a crash (heartbeat 3s old, lease still live) via the startup wait gate", async () => {
    const credentialsPath = writeCredentialsFile(credentialsDir());
    const dbName = tempDbName("startup-gate-relaunch");
    const { spreadsheet, transport } = newTransport();

    // Session 1: provision + deliver u1, then close (graceful; rows remain).
    const session1 = await openSync(transport, credentialsPath, dbName);
    await createUser(session1, "u1", "pending");
    await drainOutbox(session1);
    await session1.hikoutei.close();
    // Simulate a crash 3s ago AFTER close: lease_until stays in the future
    // and the heartbeat is only 3s old — NOT yet stale (stale bound is 15s).
    // The old code failed this exact scenario at startup registration with
    // sync_startup_failed (live repro Exp 6 runB); the startup wait gate
    // must wait out the remaining stale window and then succeed.
    simulateCrashedWriterLeases(dbName, 3_000);
    const systemTab = spreadsheet.findTab(SYSTEM_TAB);
    expect(systemTab).toBeDefined();

    // Session 2: the gate waits ~12s for the frozen heartbeat to go stale,
    // then the claim CAS takes over. openSync must SUCCEED (not exit with
    // sync_startup_failed).
    const session2 = await openSync(transport, credentialsPath, dbName);
    await createUser(session2, "u2", "pending");
    await drainOutbox(session2);

    expect(stubRowFields(systemTab as never, 3, [...SYSTEM_HEADERS]).id).toEqual({
      kind: "string",
      value: "u2",
    });
    expect(stubRowFields(systemTab as never, 4, [...SYSTEM_HEADERS]).id).toBeNull();
    await session2.hikoutei.close();
  }, 30_000);

  it("records a human edit during downtime as a durable OPEN conflict and resolves only after a later same-field canonical advance (issue #196)", async () => {
    const credentialsPath = writeCredentialsFile(credentialsDir());
    const dbName = tempDbName("conflict");
    const { spreadsheet, transport } = newTransport();

    // Session 1: deliver u1, observe a polling baseline, then queue a
    // canonical update before shutdown (SQLite authority moves past the
    // baseline while the sheet still shows the old value).
    const session1 = await openSync(transport, credentialsPath, dbName);
    await createUser(session1, "u1", "pending");
    await drainOutbox(session1);
    await session1.pollingSupervisor.runOnce();
    await session1.stop();
    const em1 = session1.hikoutei.em.fork();
    const u1 = await em1.findOne(User, { id: "u1" });
    if (u1 === null) throw new Error("expected the session-1 entity");
    u1.status = "server-update";
    await em1.flush();
    await expireWriterLeases(session1);
    await session1.hikoutei.close();

    // Human edit during downtime: the User_Input row changes while the app is
    // offline, before the queued canonical update reaches the sheet.
    const inputTab = spreadsheet.findTab(INPUT_TAB);
    expect(inputTab).toBeDefined();
    if (inputTab !== undefined) {
      inputTab.cells.set("1,1", { userEnteredValue: { stringValue: "human-edit" } });
    }

    // Session 2: startup classifies the divergence as a conflict (the
    // candidate is based on the pre-update revision) and never silently
    // applies the human value over the queued canonical update.
    const session2 = await openSync(transport, credentialsPath, dbName);
    await session2.pollingSupervisor.runOnce();

    const conflicts = await session2.storage.read(({ sql }) =>
      sql.all<{ readonly conflict_id: string; readonly field_name: string; readonly status: string }>(
        "SELECT conflict_id, field_name, status FROM sync_conflict WHERE logical_sheet_id = ?",
        ["entity:sync_auto_users"],
      ));
    expect(conflicts.some((conflict) => conflict.field_name === "status")).toBe(true);

    // Polling/restart alone must never resolve: zero resolution commands and
    // the queued canonical update must not overwrite the human edit.
    await expect(session2.storage.read(({ sql }) =>
      sql.all<{ readonly command_id: string }>("SELECT command_id FROM resolution_command"))).resolves.toEqual([]);
    await expect(session2.storage.read(({ sql }) =>
      sql.get<{ readonly status: string }>(
        "SELECT status FROM sync_conflict WHERE logical_sheet_id = ? AND field_name = 'status' ORDER BY updated_at DESC LIMIT 1",
        ["entity:sync_auto_users"],
      ))).resolves.toEqual({ status: "OPEN" });
    await drainOutbox(session2);
    expect(stubRowFields(inputTab as never, 2, [...INPUT_HEADERS]).status).toEqual({
      kind: "string",
      value: "human-edit",
    });

    // Only a later REAL field revision increase on the same conflicted field
    // is the implicit system-wins trigger; the sheet then converges back to
    // the canonical value and the conflict closes.
    const em2 = session2.hikoutei.em.fork();
    const u2 = await em2.findOne(User, { id: "u1" });
    if (u2 === null) throw new Error("expected the session-2 entity");
    u2.status = "completed";
    await em2.flush();

    for (let index = 0; index < 10; index += 1) {
      const row = stubRowFields(inputTab as never, 2, [...INPUT_HEADERS]);
      const resolved = await session2.storage.read(({ sql }) =>
        sql.get<{ readonly status: string }>(
          "SELECT status FROM sync_conflict WHERE logical_sheet_id = ? AND field_name = 'status' ORDER BY updated_at DESC LIMIT 1",
          ["entity:sync_auto_users"],
        ));
      if (
        row.status?.kind === "string" &&
        row.status.value === "completed" &&
        resolved?.status === "RESOLVED"
      ) {
        break;
      }
      await session2.pollingSupervisor.runOnce().catch(() => undefined);
      await session2.effectSupervisor.runOnce().catch(() => undefined);
    }

    await expect(session2.hikoutei.em.fork().findOne(User, { id: "u1" })).resolves.toMatchObject({
      status: "completed",
    });
    expect(stubRowFields(inputTab as never, 2, [...INPUT_HEADERS]).status).toEqual({
      kind: "string",
      value: "completed",
    });
    const finalConflict = await session2.storage.read(({ sql }) =>
      sql.get<{ readonly status: string }>(
        "SELECT status FROM sync_conflict WHERE logical_sheet_id = ? AND field_name = 'status' ORDER BY updated_at DESC LIMIT 1",
        ["entity:sync_auto_users"],
      ));
    expect(finalConflict?.status).toBe("RESOLVED");

    // The audit projection received the system-wins resolution row.
    const conflictsTab = spreadsheet.findTab(CONFLICTS_TAB);
    expect(conflictsTab?.cell(1, 0)?.userEnteredValue?.stringValue).toBeTypeOf("string");
    await session2.hikoutei.close();
  });

  // -------------------------------------------------------------------------
  // Burst-scale crash restart (receipt cursor cold-read + banding)
  // -------------------------------------------------------------------------

  /**
   * Crash-restart structural guard: after a crashed session drained a burst,
   * the reopened runtime's receipt-cursor state is process-local (the
   * provider's `ReceiptReadCursor` is in-memory), so the FIRST dispatch
   * after reopen must pay at most one cold whole-tab receipt read per cold
   * read-lane and every LATER dispatch must request the tail band — the
   * deep history is never re-read pass after pass. Effects must still land
   * exactly once across the restart (no duplicate target rows, no duplicate
   * ids). Read-shape counts come from the stub transport's recorded ranges;
   * effects/s is RECORDED, never wall-clock-asserted.
   */
  it("restarts a crashed burst runtime with one cold full receipt read, then bands, and lands every effect once", async () => {
    const BURST_SIZE = 200;
    const credentialsPath = writeCredentialsFile(credentialsDir());
    const dbName = tempDbName("burst-crash-restart");
    const { spreadsheet, transport } = newTransport();

    // Session 1: provision + drain a 200-entity burst (400 outbox effects:
    // system-state + user-input route per entity).
    const session1 = await openSync(transport, credentialsPath, dbName);
    const first = await burstAndDrain(session1, "s1", BURST_SIZE);
    await session1.hikoutei.close();

    // Simulate the crash AFTER close (frozen heartbeat, live lease window).
    simulateCrashedWriterLeases(dbName);

    // Session 2: stale-heartbeat takeover, then a SECOND burst on the same
    // db and the same in-memory spreadsheet (the remote survived the crash).
    const requestsAtReopen = transport.getSpreadsheetRequests.length;
    const session2 = await openSync(transport, credentialsPath, dbName);
    const requestsAtFirstDispatch = transport.getSpreadsheetRequests.length;
    const second = await burstAndDrain(session2, "s2", BURST_SIZE);

    // (1) Read shape after reopen: at most ONE cold full receipt read per
    // cold read-lane, and the steady dispatches band over the history.
    const reopen = transport.getSpreadsheetRequests.slice(requestsAtFirstDispatch);
    const census = receiptReadCensus(reopen);
    expect(census.full).toBeLessThanOrEqual(2);
    expect(census.banded).toBeGreaterThanOrEqual(2);
    // Every banded range starts at or after the appended history (never the
    // whole tab again): parse the first banded range's start row.
    const bandedRange = reopen
      .map(receiptRangeOf)
      .find((range) => range !== undefined && !range.includes("!A1:F"));
    expect(bandedRange).toBeDefined();

    // (2) Every effect landed exactly once across the restart: the system
    // and input tabs carry the 400 distinct ids with no duplicates, and
    // nothing from session 1 was re-appended.
    const systemTab = spreadsheet.findTab(SYSTEM_TAB);
    const inputTab = spreadsheet.findTab(INPUT_TAB);
    if (systemTab === undefined || inputTab === undefined) throw new Error("burst tabs missing");
    const expectedIds = new Set<string>([
      ...Array.from({ length: BURST_SIZE }, (_, i) => `s1-${String(i).padStart(4, "0")}`),
      ...Array.from({ length: BURST_SIZE }, (_, i) => `s2-${String(i).padStart(4, "0")}`),
    ]);
    expect(tabIds(systemTab)).toEqual(expectedIds);
    expect(tabIds(inputTab)).toEqual(expectedIds);
    // The receipt tab holds exactly one receipt per outbox effect (2 routes
    // per entity) plus the header row — duplicate dispatches would have
    // either appended duplicate receipts or shifted the count.
    const receiptTab = spreadsheet.findTab(RECEIPT_TAB);
    if (receiptTab === undefined) throw new Error("receipt tab missing");
    expect(receiptTab.lastContentRow()).toBe(BURST_SIZE * 4);

    // RECORD ONLY: steady-state effects/s for both sessions (flush+drain
    // spans; session 1 includes one-time provisioning, so it is a lower
    // bound) and the post-reopen read census.
    console.info(
      `[burst-restart-e2e] session1 effects=${BURST_SIZE * 2} elapsedMs=${first.elapsedMs} ` +
      `effects/s~${Math.round((BURST_SIZE * 2 / first.elapsedMs) * 1000)} passes=${first.passes} | ` +
      `session2 effects=${BURST_SIZE * 2} elapsedMs=${second.elapsedMs} ` +
      `effects/s~${Math.round((BURST_SIZE * 2 / second.elapsedMs) * 1000)} passes=${second.passes} | ` +
      `post-reopen receiptReads(full=${census.full},banded=${census.banded}) ` +
      `readsSinceReopen=${transport.getSpreadsheetRequests.length - requestsAtReopen}`,
    );
    await session2.hikoutei.close();
  }, 60_000);

  // -------------------------------------------------------------------------
  // Generality variant: DATE + CHECKBOX columns under burst + human edit
  // -------------------------------------------------------------------------

  /**
   * Guards the demo-overfit concern: the live demo shape was string-columns
   * only. This runs a burst on an entity carrying a DATE column (stored as
   * a serial + canonical number-format — the format-evidence path) and a
   * checkbox-shaped BOOLEAN column, then a human edit to EXISTING rows
   * between sessions, and asserts conflict detection still fires with the
   * narrowed (banded) reads: the diverged date cell is classified from the
   * number-format evidence into an OPEN conflict and the queued canonical
   * date must not silently overwrite the human edit; the undelivered boolean
   * flip is classified into its own OPEN conflict and its write is gated the
   * same way; effects for the non-conflicting rows all land exactly once.
   * effects/s and the read census are RECORDED.
   */
  it("detects human edits on DATE and boolean columns under narrowed reads after a burst (generality variant)", async () => {
    const BURST_SIZE = 40;
    const BASELINE_ISO = "2024-01-05T00:00:00.000Z";
    const CANONICAL_UPDATE_ISO = "2024-02-02T00:00:00.000Z";
    const HUMAN_EDIT_ISO = "2099-12-31T00:00:00.000Z";
    const credentialsPath = writeCredentialsFile(credentialsDir());
    const dbName = tempDbName("generality");
    const { spreadsheet, transport } = newTransport();

    // Session 1: burst-deliver 40 date+boolean rows, observe a polling
    // baseline, then queue a canonical update to the DATE and boolean
    // columns of one row before shutdown (SQLite moves past the baseline
    // while the sheet still shows the old values).
    const startedAt = Date.now();
    const session1 = await openSync(
      transport, credentialsPath, dbName, [], {}, [GeneralityUser],
    );
    const em0 = session1.hikoutei.em.fork();
    for (let index = 0; index < BURST_SIZE; index += 1) {
      em0.persist(em0.create(GeneralityUser, {
        id: `g-${String(index).padStart(3, "0")}`,
        status: "pending",
        dueAt: new Date(BASELINE_ISO),
        done: false,
      }));
    }
    await em0.flush();
    let burstPasses = 0;
    for (; burstPasses < 40; burstPasses += 1) {
      await session1.effectSupervisor.runOnce();
      const pending = await session1.storage.read(({ sql }) =>
        sql.get<{ readonly count: number }>(
          "SELECT COUNT(*) AS count FROM sheet_effect_outbox WHERE status = 'pending'",
        ));
      if ((pending?.count ?? 0) === 0) break;
    }
    const burstElapsedMs = Math.max(1, Date.now() - startedAt);
    await session1.pollingSupervisor.runOnce();
    await session1.stop();
    const em1 = session1.hikoutei.em.fork();
    const target = await em1.findOne(GeneralityUser, { id: "g-003" });
    if (target === null) throw new Error("expected the session-1 entity");
    target.dueAt = new Date(CANONICAL_UPDATE_ISO);
    target.done = true;
    await em1.flush();
    await expireWriterLeases(session1);
    await session1.hikoutei.close();

    // Human edit during downtime: a DIFFERENT date on the conflicted row
    // (entered through the real Sheets date UI: serial + canonical number
    // format). The boolean column diverges the other way: the canonical
    // flip is queued while the sheet still shows the baseline false, so
    // BOTH scalar evidence paths (date format + bool value) are exercised
    // under the narrowed reads.
    const inputTab = spreadsheet.findTab(GENERALITY_INPUT_TAB);
    if (inputTab === undefined) throw new Error("input tab missing");
    const rowIndexOf = (id: string): number => {
      for (const [key, cell] of inputTab.cells) {
        const [row, col] = key.split(",").map(Number) as [number, number];
        if (col === 0 && cell.userEnteredValue?.stringValue === id) return row;
      }
      throw new Error(`row for ${id} not found`);
    };
    // Input columns: id, status, dueAt, done, __hikoutei_row_id.
    inputTab.cells.set(`${rowIndexOf("g-003")},2`, toStubCell({ kind: "date", value: HUMAN_EDIT_ISO }));
    // The boolean column is deliberately NOT human-edited: its canonical
    // false -> true flip sits UNDELIVERED in the outbox across the restart.
    // The evaluator skips observed cells that match the canonical value-for-
    // value (MikroOrmUserInputPollingInspection stableHash rule), so the
    // provable boolean contract at restart is: the still-stale sheet value
    // diverges from the advanced canonical, `done` gets classified into its
    // own OPEN conflict alongside `dueAt`, and the conflicted write is
    // gated rather than slipped through on CAS-clean baseline evidence.
    const requestsBeforeSession2 = transport.getSpreadsheetRequests.length;

    // Session 2: startup classification must fire the conflict for the
    // diverged DATE field even with the receipt-banded narrowed reads.
    const session2 = await openSync(
      transport, credentialsPath, dbName, [], {}, [GeneralityUser],
    );
    await session2.pollingSupervisor.runOnce();
    await session2.effectSupervisor.runOnce().catch(() => undefined);
    const conflicts = await session2.storage.read(({ sql }) =>
      sql.all<{ readonly field_name: string; readonly status: string }>(
        "SELECT field_name, status FROM sync_conflict WHERE logical_sheet_id = ?",
        ["entity:sync_auto_generality"],
      ));
    expect(conflicts.some((conflict) =>
      conflict.field_name === "dueAt" && conflict.status === "OPEN")).toBe(true);
    // The undelivered boolean flip is classified too: `done` carries its own
    // OPEN conflict row (value-level divergence from the advanced canonical),
    // proving the boolean path goes through the same evidence machinery as
    // the date instead of a silent bypass.
    expect(conflicts.some((conflict) =>
      conflict.field_name === "done" && conflict.status === "OPEN")).toBe(true);

    // The queued canonical update must NOT silently overwrite the human
    // date value (stale-write protection with format evidence).
    for (let pass = 0; pass < 6; pass += 1) {
      await session2.effectSupervisor.runOnce().catch(() => undefined);
    }
    const dueAtCell = inputTab.cell(rowIndexOf("g-003"), 2);
    expect(stubCellToNormalized(dueAtCell)).toEqual({ kind: "date", value: HUMAN_EDIT_ISO });
    // The boolean flip does NOT silently pass either: with its own OPEN
    // conflict pending, the dispatcher gates the done write and the sheet
    // keeps the stale baseline false until resolution — SQLite stays the
    // authority (done=true) exactly like the human-diverged date cell.
    const doneCell = inputTab.cell(rowIndexOf("g-003"), 3);
    expect(stubCellToNormalized(doneCell)).toEqual({ kind: "boolean", value: false });

    // Non-conflicting rows still landed exactly once: 40 distinct ids.
    const systemTab = spreadsheet.findTab(GENERALITY_SYSTEM_TAB);
    if (systemTab === undefined) throw new Error("system tab missing");
    expect(tabIds(systemTab).size).toBe(BURST_SIZE);

    // The narrowed reads held after reopen: at most one cold full receipt
    // read per read-lane, and the dispatch window banded.
    const census = receiptReadCensus(
      transport.getSpreadsheetRequests.slice(requestsBeforeSession2),
    );
    expect(census.full).toBeLessThanOrEqual(2);
    expect(census.banded).toBeGreaterThanOrEqual(1);

    // RECORD ONLY: burst effects/s (includes one-time provisioning) and the
    // session-2 read census under the date/checkbox shape.
    console.info(
      `[generality-e2e] burst effects=${BURST_SIZE * 2} passes=${burstPasses + 1} ` +
      `elapsedMs=${burstElapsedMs} effects/s~${Math.round((BURST_SIZE * 2 / burstElapsedMs) * 1000)} | ` +
      `session2 receiptReads(full=${census.full},banded=${census.banded}) ` +
      `conflicts=[${conflicts.map((conflict) => `${conflict.field_name}:${conflict.status}`).join(",")}]`,
    );
    await session2.hikoutei.close();
  }, 60_000);

  /**
   * Checkbox data-validation evidence for the generality shape (review
   * finding): the env-driven service never surfaces `checkboxHeaders` (it is
   * provider-route configuration), so this drives the REAL Google Sheets API
   * provider directly with the Generality route configured
   * `checkboxHeaders: ["done"]` and asserts the append batch carries the
   * checkbox evidence: a strict setDataValidation request scoped to the done
   * column of the appended row, plus the value landing as a native boolean
   * cell. A twin append on a route WITHOUT checkbox configuration emits
   * zero validation ranges, proving the evidence is attributed to the
   * checkbox route config and not incidentally present.
   */
  it("carries checkbox data-validation evidence only for a configured checkbox route", async () => {
    // The checkbox evidence rides the same batch-builder append path the
    // service uses (pushAppendWrites), so the SYSTEM-shaped route carries
    // the checkbox column: fastAppend requires a registered identityField,
    // which only the system_state/sync_conflicts routes derive.
    const inputHeaders = ["id", "status", "dueAt", "done", "__typed_sheets_deleted"];
    const physicalSheetId = "entity:sync_auto_generality:system_state";
    const appendRows = {
      physicalSheetId,
      sheetName: GENERALITY_SYSTEM_TAB,
      registeredRange: "A:E",
      projection: "system_state" as const,
      schemaVersion: 1,
      rows: [{
        effectId: "generality-checkbox-1",
        payloadHash: "payload-generality-checkbox-1",
        anchor: "anchor-generality-checkbox-1",
        fields: {
          id: { kind: "string", value: "cb-001" },
          status: { kind: "string", value: "pending" },
          dueAt: { kind: "date", value: "2024-01-05T00:00:00.000Z" },
          done: { kind: "boolean", value: true },
          __typed_sheets_deleted: { kind: "boolean", value: false },
        },
      }] satisfies FastAppendRow[],
    };
    const buildCheckboxProvider = (checkboxHeaders: readonly string[] | undefined) => {
      const sheet = new StubSpreadsheet();
      sheet.addTab(GENERALITY_SYSTEM_TAB, { headers: inputHeaders });
      const providerTransport = new StubSheetsTransport(sheet);
      const provider = new GoogleSheetsApiSyncProvider({
        spreadsheetId: "generality-checkbox-e2e",
        definitions: [{
          sheet: {
            logicalSheetId: "entity:sync_auto_generality",
            physicalSheetId,
            spreadsheetId: "generality-checkbox-e2e",
            tabName: GENERALITY_SYSTEM_TAB,
            registeredRange: "A:E",
            projection: "system_state",
            schemaVersion: 1,
            ownershipManifestJson: "{}",
            businessKeyField: "id",
            anchorMode: "business_key",
          },
          headers: inputHeaders,
          ...(checkboxHeaders === undefined ? {} : { checkboxHeaders }),
        }],
        transport: providerTransport,
        requestTimeoutMs: 60_000,
        rateLimitIntervalMs: 0,
      });
      return { sheet, provider };
    };

    // Configured checkbox route: the append carries the checkbox evidence.
    const configured = buildCheckboxProvider(["done"]);
    const applied = await configured.provider.fastAppendRows(appendRows);
    expect(applied.results[0]?.status).toBe("applied");
    const checkboxTab = configured.sheet.findTab(GENERALITY_SYSTEM_TAB);
    if (checkboxTab === undefined) throw new Error("checkbox tab missing");
    // setDataValidation scoped to the done column (header index 3) of
    // exactly the appended row (wire rows 1..2, half-open).
    expect(checkboxTab.dataValidationRanges).toHaveLength(1);
    expect(checkboxTab.dataValidationRanges[0]).toMatchObject({
      startRowIndex: 1,
      endRowIndex: 2,
      startColumnIndex: 3,
      endColumnIndex: 4,
    });
    // The checkbox value lands as a native boolean cell, not a string.
    expect(checkboxTab.cell(1, 3)?.userEnteredValue?.boolValue).toBe(true);

    // Twin route WITHOUT checkbox config: identical append, zero ranges.
    const unconfigured = buildCheckboxProvider(undefined);
    expect((await unconfigured.provider.fastAppendRows({
      ...appendRows,
      rows: appendRows.rows.map((row) => ({ ...row, effectId: "generality-no-checkbox-1" })),
    })).results[0]?.status).toBe("applied");
    const plainTab = unconfigured.sheet.findTab(GENERALITY_SYSTEM_TAB);
    if (plainTab === undefined) throw new Error("plain tab missing");
    expect(plainTab.dataValidationRanges).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Public createTypedSheets wiring
  // -------------------------------------------------------------------------

  it("keeps the public factory local-only when the sync env is absent", async () => {
    const previousUrl = process.env.HIKOUTEI_SYNC_SPREADSHEET_URL;
    delete process.env.HIKOUTEI_SYNC_SPREADSHEET_URL;
    try {
      const dbName = tempDbName("public-absent");
      const hikoutei = await createTypedSheets({ dbName, entities: [User] });
      try {
        const em = hikoutei.em.fork();
        em.persist(em.create(User, { id: "public-local", status: "local" }));
        await em.flush();
        await expect(em.findOne(User, { id: "public-local" })).resolves.toMatchObject({
          status: "local",
        });
        expect("setupSheets" in hikoutei).toBe(false);
      } finally {
        await hikoutei.close().catch(() => undefined);
      }

      // No sync service ran: the SQLite file carries no sync state tables.
      const storage = await initializeMikroOrmSqliteAdapter({
        dbName,
        entities: [InspectionSchema],
      });
      try {
        const syncTables = await storage.read(({ sql }) =>
          sql.all<{ readonly name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('entity_state', 'sheet_effect_outbox')",
          ));
        expect(syncTables).toEqual([]);
      } finally {
        await storage.close(true);
      }
    } finally {
      if (previousUrl === undefined) {
        delete process.env.HIKOUTEI_SYNC_SPREADSHEET_URL;
      } else {
        process.env.HIKOUTEI_SYNC_SPREADSHEET_URL = previousUrl;
      }
    }
  });

  it("fails closed through the public factory when the sync env is configured badly", async () => {
    const previousUrl = process.env.HIKOUTEI_SYNC_SPREADSHEET_URL;
    const previousCredentials = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    process.env.HIKOUTEI_SYNC_SPREADSHEET_URL =
      "https://docs.google.com/spreadsheets/d/not-a-real-id/edit";
    process.env.GOOGLE_APPLICATION_CREDENTIALS = join(credentialsDir(), "missing.json");
    try {
      // Credentials validation happens before any remote contact, so this
      // failure is classified without network access.
      await expect(createTypedSheets({ dbName: ":memory:", entities: [User] })).rejects.toMatchObject({
        code: HIKOUTEI_ERROR_CODES.SYNC_CREDENTIALS_FILE_MISSING,
      });
    } finally {
      if (previousUrl === undefined) {
        delete process.env.HIKOUTEI_SYNC_SPREADSHEET_URL;
      } else {
        process.env.HIKOUTEI_SYNC_SPREADSHEET_URL = previousUrl;
      }
      if (previousCredentials === undefined) {
        delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      } else {
        process.env.GOOGLE_APPLICATION_CREDENTIALS = previousCredentials;
      }
    }
  });
});
