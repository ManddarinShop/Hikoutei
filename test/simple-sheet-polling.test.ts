import { afterEach, describe, expect, it } from "vitest";
import { defineEntity, p } from "@mikro-orm/sql";

import {
  initializeMikroOrmSqliteAdapter,
  type MikroOrmSqliteAdapter,
} from "../src/adapter/persistence/providers/mikro-orm/storage/MikroOrmSqliteAdapter.js";
import { migrateMikroOrmSqliteStorageSchema } from "../src/adapter/persistence/providers/mikro-orm/storage/MikroOrmSqliteSchema.js";
import { pollSimpleSheetRowsWithAdapter } from "../src/application/sync/inbound/polling/SimpleSheetPolling.js";
import type {
  SyncSheetTableReaderGateway,
  SyncTableRowsResult,
} from "../src/application/sync/gateway/syncGateway.js";
import type { RegisteredSyncProjectionDefinition } from "../src/application/sync/gateway/SyncGatewayBootstrap.js";

const TestEntitySchema = defineEntity({
  name: "SimpleSheetPollingTestEntity",
  tableName: "simple_sheet_polling_test_entity",
  properties: { id: p.string().primary() },
});
class TestEntity extends TestEntitySchema.class {
  declare id: string;
}
TestEntitySchema.setClass(TestEntity);

describe("simple Sheet polling", () => {
  const adapters: MikroOrmSqliteAdapter[] = [];

  afterEach(async () => {
    await Promise.all(adapters.splice(0).map((adapter) => adapter.close(true)));
  });

  it("reads values once, compares canonical rows, and returns only changed rows", async () => {
    const adapter = await initializeMikroOrmSqliteAdapter({
      dbName: ":memory:",
      entities: [TestEntity],
    });
    adapters.push(adapter);
    await migrateMikroOrmSqliteStorageSchema(adapter);
    await seedCanonicalRows(adapter);

    const definition = createDefinition();
    let batchReadCount = 0;
    const result: SyncTableRowsResult = {
      sheetName: "Orders",
      registeredRange: "A:C",
      headers: ["id", "name", "status"],
      rows: [
        {
          rowNumber: 2,
          fields: {
            id: { kind: "string", value: "order-1" },
            name: { kind: "string", value: "Ada" },
            status: { kind: "string", value: "paid" },
          },
        },
        {
          rowNumber: 3,
          fields: {
            id: { kind: "string", value: "order-2" },
            name: { kind: "string", value: "Grace Hopper" },
            status: { kind: "string", value: "paid" },
          },
        },
        {
          rowNumber: 4,
          fields: {
            id: { kind: "string", value: "order-unknown" },
            name: { kind: "string", value: "Unknown" },
            status: { kind: "string", value: "pending" },
          },
        },
      ],
    };
    const gateway: SyncSheetTableReaderGateway = {
      readRows: async () => result,
      readRowsBatch: async () => {
        batchReadCount += 1;
        return [result];
      },
    };

    const polling = await pollSimpleSheetRowsWithAdapter({
      storage: adapter,
      gateway,
      definitions: [definition],
    });

    expect(batchReadCount).toBe(1);
    expect(polling.rowsScanned).toBe(3);
    expect(polling.unchangedRows).toBe(1);
    expect(polling.unknownRows).toBe(1);
    expect(polling.invalidRows).toBe(0);
    expect(polling.changedRows).toEqual([{
      entityId: "order-2",
      rowNumber: 3,
      fields: result.rows[1]?.fields,
      changedFields: ["name"],
    }]);
  });

  it("rejects malformed canonical cells at the JSON boundary", async () => {
    const adapter = await initializeMikroOrmSqliteAdapter({
      dbName: ":memory:",
      entities: [TestEntity],
    });
    adapters.push(adapter);
    await migrateMikroOrmSqliteStorageSchema(adapter);
    await seedCanonicalRows(adapter);
    await adapter.transaction(({ sql }) => sql.run(
      "UPDATE entity_field_state SET normalized_value = ? WHERE entity_id = ? AND field_name = ?",
      [JSON.stringify({ kind: "date", value: "not-a-date" }), "order-1", "name"],
    ));

    const gateway: SyncSheetTableReaderGateway = {
      readRows: async () => ({
        sheetName: "Orders",
        registeredRange: "A:C",
        headers: ["id", "name", "status"],
        rows: [],
      }),
      readRowsBatch: async () => [{
        sheetName: "Orders",
        registeredRange: "A:C",
        headers: ["id", "name", "status"],
        rows: [],
      }],
    };

    await expect(
      pollSimpleSheetRowsWithAdapter({
        storage: adapter,
        gateway,
        definitions: [createDefinition()],
      }),
    ).rejects.toThrow("canonical value is not a normalized cell");
  });
});

function createDefinition(): RegisteredSyncProjectionDefinition {
  return {
    sheet: {
      logicalSheetId: "logical-orders",
      physicalSheetId: "physical-orders",
      spreadsheetId: "spreadsheet-1",
      tabName: "Orders",
      registeredRange: "A:C",
      projection: "system_state",
      schemaVersion: 1,
      ownershipManifestJson: "{}",
      businessKeyField: "id",
      anchorMode: "developer_metadata",
    },
    headers: ["id", "name", "status"],
  };
}

async function seedCanonicalRows(adapter: MikroOrmSqliteAdapter): Promise<void> {
  await adapter.transaction(async ({ sql }) => {
    await sql.run(
      "INSERT INTO sheet_registry (sheet_id, schema_version, ownership_manifest_json, business_key_field) VALUES (?, ?, ?, ?)",
      ["logical-orders", 1, "{}", "id"],
    );
    for (const [entityId, name] of [["order-1", "Ada"], ["order-2", "Grace"]] as const) {
      await sql.run(
        "INSERT INTO entity_state (entity_id, entity_revision, accepted_snapshot_hash, status) VALUES (?, ?, ?, ?)",
        [entityId, 1, null, "active"],
      );
      await sql.run(
        "INSERT INTO row_binding (row_binding_id, logical_sheet_id, anchor_reference, entity_id, state) VALUES (?, ?, ?, ?, ?)",
        [`binding-${entityId}`, "logical-orders", `anchor-${entityId}`, entityId, "active"],
      );
      for (const [fieldName, value] of [
        ["id", { kind: "string", value: entityId }],
        ["name", { kind: "string", value: name }],
        ["status", { kind: "string", value: "paid" }],
      ] as const) {
        await sql.run(
          "INSERT INTO entity_field_state (entity_id, field_name, normalized_value, field_revision, ownership) VALUES (?, ?, ?, ?, ?)",
          [entityId, fieldName, JSON.stringify(value), 1, "system"],
        );
      }
    }
  });
}
