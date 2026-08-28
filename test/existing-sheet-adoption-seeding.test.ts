/**
 * Existing-sheet adoption seeding engine tests (Phase 2).
 *
 * Proves the core D5/D6 guarantees at the storage + provider level:
 *  - `extractAdoptedSeedRows` + `seedAdoptedEntityRows` bind every observed
 *    User_Input row (row_binding + canonical INSERT + business-key index +
 *    visible state confirmed to the observed hash) in one transaction.
 *  - A seeded row's first human edit is ABSORBED (D6): the polling pass
 *    CAS-matches the confirmed observed baseline and applies the update
 *    with no quarantine.
 *  - Deterministic anchors (`entity:<pk>`, `mapping.anchorForEntity`) match
 *    the row bindings the seeding writes.
 */
import { describe, expect, it } from "vitest";
import {
  defineEntity,
  MikroORM,
  NodeSqliteDialect,
  p,
  SqliteDriver,
} from "@mikro-orm/sql";

import {
  FIELD_OWNERSHIPS,
  ROW_BINDING_STATES,
} from "../src/domain/model/constants.js";
import { NORMALIZED_CELL_KINDS } from "../src/shared/encoding/constants.js";
import type { NormalizedCell } from "../src/shared/encoding/types.js";
import { presentValue } from "../src/shared/state/constructors.js";
import { defineTypedSheetsEntityMapping } from "../src/application/orm/mapping/entityMapping.js";
import {
  registerTypedSheetsEntityMappings,
} from "../src/application/orm/persistence/flush/flushCoordinator.js";
import { pollMappedUserInputWithMikroOrm } from "../src/adapter/persistence/providers/mikro-orm/observation/MikroOrmUserInputPolling.js";
import { createMikroOrmSqliteAdapter } from "../src/adapter/persistence/providers/mikro-orm/storage/MikroOrmSqliteAdapter.js";
import { migrateMikroOrmSqliteStorageSchema } from "../src/adapter/persistence/providers/mikro-orm/storage/MikroOrmSqliteSchema.js";
import {
  SYNC_PROJECTIONS,
  SYNC_SNAPSHOT_READ_MODES,
} from "../src/application/sync/sheetsContract/constants.js";
import {
  computeSyncVisibleHash,
  observeSyncSnapshots,
} from "../src/application/sync/sheetsContract/syncSheets.js";
import {
  completeExistingSheetAdoption,
  extractAdoptedSeedRows,
  seedAdoptedEntityRows,
} from "../src/application/sync/service/adopt/adoptionSeeding.js";
import {
  SYNC_SERVICE_ERROR_CODES,
} from "../src/application/sync/service/errors.js";
import { FakeSyncSheetsProvider } from "./support/FakeSyncSheetsProvider.js";

const AdoptProbeSchema = defineEntity({
  name: "AdoptProbe",
  tableName: "adopt_seed_probe",
  properties: {
    invoiceNo: p.string().primary(),
    customer: p.string(),
    total: p.string(),
  },
});

class AdoptProbe extends AdoptProbeSchema.class {
  declare invoiceNo: string;
  declare customer: string;
      declare total: string;
}

AdoptProbeSchema.setClass(AdoptProbe);

const mapping = defineTypedSheetsEntityMapping<AdoptProbe>({
  entity: "AdoptProbe",
  logicalSheetId: "adopt-seed-probe",
  primaryKey: "invoiceNo",
  businessKey: "invoiceNo",
  schemaVersion: 1,
  fields: [
    { property: "invoiceNo", cellKind: NORMALIZED_CELL_KINDS.STRING, ownership: FIELD_OWNERSHIPS.USER, required: true, unique: true },
    { property: "customer", cellKind: NORMALIZED_CELL_KINDS.STRING, ownership: FIELD_OWNERSHIPS.USER, required: true },
    { property: "total", cellKind: NORMALIZED_CELL_KINDS.STRING, ownership: FIELD_OWNERSHIPS.USER, required: true },
  ],
  projections: [
    { physicalSheetId: "adopt-seed-probe-system", spreadsheetId: "spreadsheet", tabName: "Probe_System", registeredRange: "A:D", projection: "system_state" },
    { physicalSheetId: "adopt-seed-probe-input", spreadsheetId: "spreadsheet", tabName: "Probe_Input", registeredRange: "A:D", projection: "user_input" },
  ],
});

const INPUT_PHYSICAL = "adopt-seed-probe-input";
const INV_1: NormalizedCell = { kind: "string", value: "INV-1" };
const INV_2: NormalizedCell = { kind: "string", value: "INV-2" };
const ACME: NormalizedCell = { kind: "string", value: "Acme" };
const BETA: NormalizedCell = { kind: "string", value: "Beta" };
const TOTAL_1: NormalizedCell = { kind: "string", value: "100" };
const TOTAL_2: NormalizedCell = { kind: "string", value: "200" };

function observedSnapshot() {
  const cells = (fields: Record<string, NormalizedCell>) =>
    Object.fromEntries(
      Object.entries(fields).map(([fieldName, value]) => [
        fieldName,
        {
          cellKind: "value",
          normalizedCell: value,
          stableHash: { kind: "absent" },
          formulaHash: { kind: "absent" },
          mergeRange: { kind: "absent" },
          errorCode: { kind: "absent" },
        },
      ]),
    );
  return {
    anchors: { assigned: 0, existing: 2, duplicateAnchors: [] },
    snapshot: {
      protocolVersion: "v1" as const,
      sheetName: "Probe_Input",
      registeredRange: "A:D",
      projection: SYNC_PROJECTIONS.USER_INPUT,
      schemaVersion: 1,
      headers: ["invoiceNo", "customer", "total"],
      rows: [
        {
          rowNumber: 2,
          physicalAnchor: presentValue("entity:INV-1"),
          visibleRevision: { kind: "absent" },
          visibleHash: { kind: "absent" },
          cells: cells({ invoiceNo: INV_1, customer: ACME, total: TOTAL_1 }),
        },
        {
          rowNumber: 3,
          physicalAnchor: presentValue("entity:INV-2"),
          visibleRevision: { kind: "absent" },
          visibleHash: { kind: "absent" },
          cells: cells({ invoiceNo: INV_2, customer: BETA, total: TOTAL_2 }),
        },
      ],
      snapshotHash: "snapshot-hash",
      unanchoredRows: [],
      duplicateAnchors: [],
    },
  };
}

async function createStorage() {
  const orm = await MikroORM.init({
    driver: SqliteDriver,
    dbName: ":memory:",
    driverOptions: new NodeSqliteDialect(":memory:"),
    entities: [AdoptProbe],
  });
  await orm.schema.create();
  const storage = createMikroOrmSqliteAdapter(orm);
  await migrateMikroOrmSqliteStorageSchema(storage);
  await registerTypedSheetsEntityMappings(storage, [mapping], {
    writerId: "adopt-seed-mapped-writer",
    role: "adopt-seed-mapped",
    leaseDurationMs: 1_000,
    now: () => 1_000,
    createId: () => "generated-0",
  });
  return { orm, storage };
}

describe("existing-sheet adoption seeding engine", () => {
  it("binds every observed row: binding, canonical INSERT, business key, observed visible state", async () => {
    const { orm, storage } = await createStorage();
    try {
      const observed = observedSnapshot() as never;
      const [observedSnap] = await observeSyncSnapshots(
        {
          async ensureRowAnchors() {
            return { assigned: 0, existing: 2, duplicateAnchors: [] };
          },
          async readSnapshot() {
            return observed.snapshot;
          },
        },
        [{
          physicalSheetId: INPUT_PHYSICAL,
          sheetName: "Probe_Input",
          registeredRange: "A:D",
          projection: SYNC_PROJECTIONS.USER_INPUT,
          schemaVersion: 1,
          readMode: SYNC_SNAPSHOT_READ_MODES.FULL,
        }],
      );
      void observed;
      const rows = extractAdoptedSeedRows({ mapping, observed: observedSnap });
      expect(rows.map((row) => row.visibleEntityId)).toEqual(["INV-1", "INV-2"]);
      expect(rows.map((row) => row.canonicalEntityId)).toEqual(["INV-1", "INV-2"]);
      expect(rows[0]!.anchor).toBe("entity:INV-1");

      const seeded = await seedAdoptedEntityRows({
        storage,
        mapping,
        entityTableName: "adopt_seed_probe",
        physicalSheetId: INPUT_PHYSICAL,
        rows,
        writerRole: "adopt-seeding",
        writerId: "adopt-seeding-writer",
        leaseDurationMs: 1_000,
        now: 1_000,
      });
      expect(seeded.seeded).toBe(2);

      const bindings = await storage.transaction(async ({ sql }) =>
        sql.all<{ anchor_reference: string; state: string }>(
          "SELECT anchor_reference, state, entity_id FROM row_binding WHERE logical_sheet_id = ? ORDER BY entity_id",
          ["adopt-seed-probe"],
        ));
      console.log("BINDING-ROW:", JSON.stringify(bindings[0]));
      expect(bindings).toEqual([
        { anchor_reference: "entity:INV-1", entity_id: "INV-1", state: "active" },
        { anchor_reference: "entity:INV-2", entity_id: "INV-2", state: "active" },
      ]);
      const entities = await storage.transaction(async ({ sql }) =>
        sql.all<{ entity_id: string; entity_revision: number; status: string }>(
          "SELECT entity_id, entity_revision, status FROM entity_state ORDER BY entity_id",
          [],
        ));
      expect(entities).toEqual([
        { entity_id: "INV-1", entity_revision: 1, status: "active" },
        { entity_id: "INV-2", entity_revision: 1, status: "active" },
      ]);
      const visible = await storage.transaction(async ({ sql }) =>
        sql.all<{ confirmed_snapshot_hash: string }>(
          "SELECT confirmed_snapshot_hash FROM sheet_visible_state WHERE projection = 'user_input' ORDER BY row_binding_id",
          [],
        ));
      expect(visible[0]!.confirmed_snapshot_hash).toBe(
        computeSyncVisibleHash({ invoiceNo: INV_1, customer: ACME, total: TOTAL_1 }),
      );
    } finally {
      await orm.close(true);
    }
  });

  it("rejects provider-generated anchors that are not derived from the PK (stability gate)", async () => {
    const { orm, storage } = await createStorage();
    try {
      const snapshot = observedSnapshot() as { snapshot: { rows: { physicalAnchor: unknown }[] } };
      // A provider-generated anchor (e.g. sync-anchor:<uuid>) can never be
      // re-derived from the PK, so the stability gate must refuse startup.
      snapshot.snapshot.rows[0]!.physicalAnchor = presentValue("sync-anchor:7f3c");
      const provider = {
        async ensureRowAnchors() {
          return { assigned: 0, existing: 2, duplicateAnchors: [] };
        },
        async readSnapshot() {
          return snapshot.snapshot;
        },
      };
      await expect(completeExistingSheetAdoption({
        plan: {
          report: { mode: "dry-run", ok: true, entities: [] },
          entities: [{
            entityName: "AdoptProbe",
            tabName: "Probe_Input",
            entityTableName: "adopt_seed_probe",
            sheetId: 1,
            tabTitle: "Probe_Input",
            layout: {
              entityName: "AdoptProbe",
              tabName: "Probe_Input",
              managedColumns: [],
              rowIdColumnIndex: 3,
              pkColumnIndex: 0,
              pkGenerated: false,
              pkHeader: "invoiceNo",
              registeredRange: "A:D",
              appendedColumns: [],
            },
            rowIdColumnIndex: 3,
            dataRows: [],
          }],
        },
        provider,
        storage,
        mappings: [mapping],
        writer: {
          writerId: "adopt-stability-writer",
          role: "adopt-stability",
          leaseDurationMs: 1_000,
          now: () => 1_000,
        },
      })).rejects.toMatchObject({
        code: SYNC_SERVICE_ERROR_CODES.STARTUP_FAILED,
        message: expect.stringContaining('row 2: anchor "sync-anchor:7f3c" is not the derived anchor "entity:INV-1"'),
      });
    } finally {
      await orm.close(true);
    }
  });

  it("absorbs the first human edit of a seeded row without quarantine (D6)", async () => {
    const { orm, storage } = await createStorage();
    try {
      const observed = observedSnapshot() as never;
      const [observedSnap] = await observeSyncSnapshots(
        {
          async ensureRowAnchors() {
            return { assigned: 0, existing: 2, duplicateAnchors: [] };
          },
          async readSnapshot() {
            return observed.snapshot;
          },
        },
        [{
          physicalSheetId: INPUT_PHYSICAL,
          sheetName: "Probe_Input",
          registeredRange: "A:D",
          projection: SYNC_PROJECTIONS.USER_INPUT,
          schemaVersion: 1,
          readMode: SYNC_SNAPSHOT_READ_MODES.FULL,
        }],
      );
      const rows = extractAdoptedSeedRows({ mapping, observed: observedSnap });
      await seedAdoptedEntityRows({
        storage,
        mapping,
        entityTableName: "adopt_seed_probe",
        physicalSheetId: INPUT_PHYSICAL,
        rows,
        writerRole: "adopt-seeding",
        writerId: "adopt-seeding-writer",
        leaseDurationMs: 1_000,
        now: 1_000,
      });

      // The human edits INV-1's total in the adopted tab.
      const provider = new FakeSyncSheetsProvider([{
        physicalSheetId: INPUT_PHYSICAL,
        sheetName: "Probe_Input",
        registeredRange: "A:D",
        projection: SYNC_PROJECTIONS.USER_INPUT,
        schemaVersion: 1,
        headers: ["invoiceNo", "customer", "total"],
        rows: [
          {
            targetId: "INV-1",
            physicalAnchor: "entity:INV-1",
            fields: { invoiceNo: INV_1, customer: ACME, total: { kind: "string", value: "999" } },
          },
          {
            targetId: "INV-2",
            physicalAnchor: "entity:INV-2",
            fields: { invoiceNo: INV_2, customer: BETA, total: TOTAL_2 },
          },
        ],
      }], { realProviderSnapshotShape: true });

      const writer = {
        writerId: "adopt-seed-mapped-writer",
        role: "adopt-seed-mapped",
        leaseDurationMs: 1_000,
        now: () => 2_000,
        createId: () => "generated-0",
      };
      const report = await pollMappedUserInputWithMikroOrm({
        storage,
        provider,
        mappings: [mapping],
        writer,
      });
      console.log("REPORT:", JSON.stringify(report.sheets?.[0], null, 1));
      console.log("QUARANTINE:", JSON.stringify(await storage.transaction(async ({ sql }) =>
        sql.all("SELECT reason, row_binding_id FROM quarantine_record", []))));
      console.log("BINDINGS:", JSON.stringify(await storage.transaction(async ({ sql }) =>
        sql.all("SELECT row_binding_id, anchor_reference, entity_id, state FROM row_binding", []))));
      console.log("BIZKEY:", JSON.stringify(await storage.transaction(async ({ sql }) =>
        sql.all("SELECT field_name, normalized_key, entity_id, state FROM business_key_index", []))));
      expect(report.quarantinedRows).toBe(0);
      expect(report.invalidRows).toBe(0);
      expect(report.appliedRows).toBe(1);

      const total = await storage.transaction(async ({ sql }) =>
        sql.get<{ normalized_value: string }>(
          "SELECT normalized_value FROM entity_field_state WHERE entity_id = 'INV-1' AND field_name = 'total'",
          [],
        ));
      expect(JSON.parse(total!.normalized_value)).toEqual({ kind: "string", value: "999" });
      expect(ROW_BINDING_STATES.ACTIVE).toBe("active");
    } finally {
      await orm.close(true);
    }
  });
});