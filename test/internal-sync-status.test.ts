/**
 * Tests for the internal read-only sync observability module
 * (`src/internal/syncStatus.ts`), exposed to first-party tooling through the
 * unstable `hikoutei/internal/sync-status` subpath.
 *
 * Sync-mode coverage reuses the credential-free `StubSheetsTransport` fixture:
 * a real sync runtime is opened against the in-memory spreadsheet model, so
 * the outbox counts and conflict rows read by the module come from the actual
 * engine, not fixtures. Local-only and never-initialized databases must map
 * to `{ mode: "local" }` / an empty conflict list without errors.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { defineTypedSheetsEntity } from "../src/index.js";
import {
  createTypedSheetsWithSync,
  SYNC_ENV_KEYS,
  type TypedSheetsWithSyncResult,
} from "../src/application/sync/service/syncAutoStart.js";
import type { InternalSyncService } from "../src/application/sync/service/SyncServiceBootstrap.js";
import {
  listHikouteiConflicts,
  HIKOUTEI_SYNC_STATUS_ERROR_CODES,
  readHikouteiSyncStatus,
} from "../src/internal/syncStatus.js";
import { StubSheetsTransport, StubSpreadsheet } from "./support/StubSheetsTransport.js";

const StatusUser = defineTypedSheetsEntity({
  name: "SyncStatusUser",
  tableName: "sync_status_users",
  properties: {
    id: { type: "string", primary: true },
    status: { type: "string" },
  },
});

const SPREADSHEET_ID = "sync-status-1";

describe("internal sync status reader", () => {
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

  function tempDbName(label: string): string {
    const db = join(tmpdir(), `hikoutei-status-${label}-${randomUUID()}.sqlite`);
    dbFiles.push(db);
    return db;
  }

  function writeCredentialsFile(): string {
    const dir = mkdtempSync(join(tmpdir(), "hikoutei-status-"));
    tempDirs.push(dir);
    const path = join(dir, "service-account.json");
    writeFileSync(path, JSON.stringify({
      type: "service_account",
      project_id: "hikoutei-test",
      private_key_id: "k1",
      private_key: "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n",
      client_email: "sync-status@example.com",
      client_id: "123456",
      token_uri: "https://oauth2.googleapis.com/token",
    }));
    return path;
  }

  function syncEnv(credentialsPath: string): Record<string, string | undefined> {
    return {
      [SYNC_ENV_KEYS.SPREADSHEET_URL]:
        `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit`,
      [SYNC_ENV_KEYS.CREDENTIALS_FILE]: credentialsPath,
      // Keep the auto-started polling loop asleep so state stays deterministic.
      [SYNC_ENV_KEYS.POLLING_INTERVAL_MS]: "3600000",
    };
  }

  async function openSync(
    transport: StubSheetsTransport,
    credentialsPath: string,
    dbName: string,
  ): Promise<InternalSyncService> {
    const result = await createTypedSheetsWithSync({
      dbName,
      entities: [StatusUser],
      env: syncEnv(credentialsPath),
      transport,
    });
    if (result.kind !== "sync") {
      throw new Error("expected the sync auto-start to start the sync service");
    }
    services.push(result.service);
    return result.service;
  }

  async function drainOutbox(service: InternalSyncService, maxPasses = 8): Promise<void> {
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

  it("reports local mode for a database file that does not exist", async () => {
    const missing = join(tmpdir(), `hikoutei-status-absent-${randomUUID()}.sqlite`);
    await expect(readHikouteiSyncStatus({ dbName: missing })).resolves.toEqual({ mode: "local" });
    await expect(listHikouteiConflicts({ dbName: missing })).resolves.toEqual([]);
  });

  it("reports local mode for a local-only runtime database", async () => {
    const dbName = tempDbName("local");
    const service = await openSync(new StubSheetsTransport(new StubSpreadsheet()), writeCredentialsFile(), dbName);
    await service.close();
    services.pop();

    // The closed database keeps sync tables only when sync ran; a local-only
    // database created without the sync env has no sync tables at all. Build
    // that case through the local factory path by opening without the env.
    const { createLocalTypedSheetsRuntime } = await import("../src/api/Hikoutei.js");
    const localDb = tempDbName("pure-local");
    const runtime = await createLocalTypedSheetsRuntime({
      dbName: localDb,
      entities: [StatusUser],
    });
    const em = runtime.em.fork();
    em.persist(em.create(StatusUser, { id: "l1", status: "ok" }));
    await em.flush();
    await expect(readHikouteiSyncStatus({ dbName: localDb })).resolves.toEqual({ mode: "local" });
    await expect(listHikouteiConflicts({ dbName: localDb })).resolves.toEqual([]);
    await runtime.close();
  });

  it("reports sync mode with the bound spreadsheet and drained outbox", async () => {
    const dbName = tempDbName("drained");
    const service = await openSync(new StubSheetsTransport(new StubSpreadsheet()), writeCredentialsFile(), dbName);

    const em = service.hikoutei.em.fork();
    em.persist(em.create(StatusUser, { id: "u1", status: "pending" }));
    await em.flush();
    await drainOutbox(service);

    await expect(readHikouteiSyncStatus({ dbName })).resolves.toEqual({
      mode: "sync",
      spreadsheetId: SPREADSHEET_ID,
      effects: { pending: 0, processing: 0, deliveryUncertain: 0, failed: 0 },
      conflicts: { open: 0, needsRebase: 0 },
    });
  });

  it("counts pending outbox effects written after the last delivery pass", async () => {
    const dbName = tempDbName("pending");
    const service = await openSync(new StubSheetsTransport(new StubSpreadsheet()), writeCredentialsFile(), dbName);

    const em = service.hikoutei.em.fork();
    em.persist(em.create(StatusUser, { id: "u1", status: "queued" }));
    await em.flush();
    // No drain: the durable outbox still holds the undelivered effect.

    const status = await readHikouteiSyncStatus({ dbName });
    expect(status).toMatchObject({
      mode: "sync",
      spreadsheetId: SPREADSHEET_ID,
      effects: { pending: expect.any(Number) },
    });
    if (status.mode === "sync") {
      expect(status.effects.pending).toBeGreaterThan(0);
    }
  });

  it("lists an OPEN human-edit conflict with decoded values", async () => {
    const credentialsPath = writeCredentialsFile();
    const dbName = tempDbName("conflict");
    const spreadsheet = new StubSpreadsheet();
    const transport = new StubSheetsTransport(spreadsheet);

    // Session 1: deliver u1, observe a polling baseline, then queue a
    // canonical update before shutdown (SQLite moves past the baseline while
    // the sheet still shows the old value).
    const session1 = await openSync(transport, credentialsPath, dbName);
    const em1 = session1.hikoutei.em.fork();
    em1.persist(em1.create(StatusUser, { id: "u1", status: "pending" }));
    await em1.flush();
    await drainOutbox(session1);
    await session1.pollingSupervisor.runOnce();
    await session1.stop();
    const writer = session1.hikoutei.em.fork();
    const row = await writer.findOne(StatusUser, { id: "u1" });
    if (row === null) throw new Error("expected the session-1 entity");
    row.status = "server-update";
    await writer.flush();
    await session1.storage.transaction(({ sql }) =>
      sql.run("UPDATE writer_lease SET lease_until = 0", []));
    await session1.hikoutei.close();
    services.pop();

    // Human edit during downtime on the User_Input projection.
    const inputTab = spreadsheet.findTab("SyncStatusUser_Input");
    if (inputTab === undefined) throw new Error("expected the input tab");
    inputTab.cells.set("1,1", { userEnteredValue: { stringValue: "human-edit" } });

    // Session 2: polling classifies the divergence as a durable OPEN conflict.
    const session2 = await openSync(transport, credentialsPath, dbName);
    await session2.pollingSupervisor.runOnce();

    const status = await readHikouteiSyncStatus({ dbName });
    expect(status.mode).toBe("sync");
    if (status.mode !== "sync") return;
    expect(status.conflicts.open).toBeGreaterThanOrEqual(1);

    const conflicts = await listHikouteiConflicts({ dbName });
    const conflict = conflicts.find(
      (candidate) => candidate.entityId === "entity:sync_status_users:u1" && candidate.fieldName === "status",
    );
    expect(conflict).toMatchObject({
      entityId: "entity:sync_status_users:u1",
      fieldName: "status",
      userValue: "human-edit",
      currentCanonicalValue: "server-update",
      status: "OPEN",
    });
    if (conflict !== undefined) {
      expect(conflict.conflictId).toEqual(expect.any(String));
      expect(conflict.currentCanonicalRevision).toEqual(expect.any(Number));
      expect(conflict.updatedAt).toEqual(expect.any(Number));
    }
  });

  it("rejects malformed arguments with structured codes", async () => {
    const dbName = tempDbName("guards");
    await expect(readHikouteiSyncStatus({ dbName })).resolves.toEqual({ mode: "local" });

    await expect(readHikouteiSyncStatus({ dbName: "" })).rejects.toMatchObject({
      code: HIKOUTEI_SYNC_STATUS_ERROR_CODES.INVALID_DB_NAME,
    });
    await expect(readHikouteiSyncStatus({ dbName: 7 as unknown as string })).rejects.toMatchObject({
      code: HIKOUTEI_SYNC_STATUS_ERROR_CODES.INVALID_DB_NAME,
    });
    await expect(listHikouteiConflicts({ dbName, limit: 0 })).rejects.toMatchObject({
      code: HIKOUTEI_SYNC_STATUS_ERROR_CODES.READ_FAILED,
    });
  });
});
