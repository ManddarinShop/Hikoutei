import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";
import { defineEntity, p } from "@mikro-orm/sql";

import {
  claimWriterLeaseWithAdapter,
  WRITER_LEASE_CLAIM_RESULT_KINDS,
} from "@hikoutei/ikisaki";
import { initializeMikroOrmSqliteAdapter } from "../src/adapter/persistence/providers/mikro-orm/storage/MikroOrmSqliteAdapter.js";
import { migrateSqliteSchema } from "../src/infrastructure/storage/sqlite/migrateSchema.js";
import {
  registerSyncSheetWithAdapter,
} from "../src/infrastructure/storage/sync/shared/syncRegistry.js";
import {
  readDurableSyncManifestsWithAdapter,
} from "../src/infrastructure/storage/sync/shared/syncManifest.js";

const ManifestEntity = defineEntity({
  name: "SyncManifestTestEntity",
  tableName: "sync_manifest_test_entity",
  properties: { id: p.string().primary() },
});

describe("durable sync manifest", () => {
  const tempDirectories: string[] = [];
  const adapters: Array<Awaited<ReturnType<typeof initializeMikroOrmSqliteAdapter>>> = [];

  afterEach(async () => {
    await Promise.all(adapters.splice(0).map((adapter) => adapter.close(true)));
    for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("is readable from a second SQLite connection with exact ordered headers", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hikoutei-sync-manifest-"));
    tempDirectories.push(directory);
    const dbName = join(directory, "manifest.sqlite");
    const writerAdapter = await initializeMikroOrmSqliteAdapter({ dbName, entities: [ManifestEntity] });
    const readerAdapter = await initializeMikroOrmSqliteAdapter({ dbName, entities: [ManifestEntity] });
    adapters.push(writerAdapter, readerAdapter);
    await migrateSqliteSchema(writerAdapter);
    await migrateSqliteSchema(readerAdapter);

    const claim = await claimWriterLeaseWithAdapter(writerAdapter, {
      role: "sync_writer",
      writerId: "manifest-writer",
      leaseDurationMs: 60_000,
      now: 1_000,
    });
    if (claim.kind !== WRITER_LEASE_CLAIM_RESULT_KINDS.CLAIMED) {
      throw new Error("expected the manifest writer lease");
    }
    const result = await registerSyncSheetWithAdapter(writerAdapter, {
      role: claim.lease.role,
      writerEpoch: claim.lease.writerEpoch,
      fencingToken: claim.lease.fencingToken,
      now: 1_000,
    }, {
      logicalSheetId: "users",
      physicalSheetId: "users-system",
      spreadsheetId: "spreadsheet-1",
      tabName: "Users_System",
      registeredRange: "A:C",
      projection: "system_state",
      schemaVersion: 1,
      projectionHeaders: ["id", "name", "__deleted"],
      ownershipManifestJson: JSON.stringify({ fields: [] }),
      businessKeyField: "id",
    });
    expect(result.kind).toBe("registered");

    await expect(readDurableSyncManifestsWithAdapter(readerAdapter)).resolves.toEqual([
      expect.objectContaining({
        route: expect.objectContaining({
          physicalSheetId: "users-system",
          projectionHeaders: ["id", "name", "__deleted"],
        }),
        ownershipManifest: { fields: [] },
      }),
    ]);
  });

  it("fails closed when persisted projection headers are malformed", async () => {
    const directory = mkdtempSync(join(tmpdir(), "hikoutei-sync-manifest-"));
    tempDirectories.push(directory);
    const dbName = join(directory, "manifest.sqlite");
    const adapter = await initializeMikroOrmSqliteAdapter({ dbName, entities: [ManifestEntity] });
    adapters.push(adapter);
    await migrateSqliteSchema(adapter);
    await adapter.transaction(({ sql }) => sql.run(
      "INSERT INTO sheet_registry (sheet_id, schema_version, ownership_manifest_json, business_key_field) VALUES (?, ?, ?, ?)",
      ["users", 1, JSON.stringify({ fields: [] }), "id"],
    ));
    await adapter.transaction(({ sql }) => sql.run(
      "INSERT INTO physical_sheet_registry (physical_sheet_id, logical_sheet_id, spreadsheet_id, tab_name, registered_range, projection, schema_version, projection_headers_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ["users-system", "users", "spreadsheet-1", "Users_System", "A:C", "system_state", 1, "not-json"],
    ));

    await expect(readDurableSyncManifestsWithAdapter(adapter)).rejects.toMatchObject({
      code: "sync_registry_target_unavailable",
    });
  });
});
