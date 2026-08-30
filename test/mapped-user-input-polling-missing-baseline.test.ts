import {
  defineEntity,
  MikroORM,
  NodeSqliteDialect,
  p,
  SqliteDriver,
} from "@mikro-orm/sql";
import { describe, expect, it } from "vitest";

import {
  FIELD_OWNERSHIPS,
  QUARANTINE_REASONS,
  ROW_BINDING_STATES,
} from "@hikoutei/contracts/domain/model/constants.js";
import { stableHash } from "@hikoutei/contracts/encoding/stableEncode.js";
import type { NormalizedCell } from "@hikoutei/contracts/encoding/types.js";
import { NORMALIZED_CELL_KINDS } from "@hikoutei/contracts/encoding/constants.js";
import { defineTypedSheetsEntityMapping } from "../src/application/orm/mapping/entityMapping.js";
import {
  registerTypedSheetsEntityMappings,
} from "../src/application/orm/persistence/flush/flushCoordinator.js";
import {
  MAPPED_USER_INPUT_INVALID_REASONS,
  inspectSnapshot,
  type PreparedRow,
} from "@hikoutei/storage/persistence/providers/mikro-orm/observation/MikroOrmUserInputPollingInspection.js";
import { pollMappedUserInputWithMikroOrm } from "@hikoutei/storage/persistence/providers/mikro-orm/observation/MikroOrmUserInputPolling.js";
import type { MappedPollingState } from "@hikoutei/storage/persistence/providers/mikro-orm/observation/MikroOrmUserInputPollingState.js";
import { createMikroOrmSqliteAdapter } from "@hikoutei/storage/persistence/providers/mikro-orm/storage/MikroOrmSqliteAdapter.js";
import { migrateMikroOrmSqliteStorageSchema } from "@hikoutei/storage/persistence/providers/mikro-orm/storage/MikroOrmSqliteSchema.js";
import {
  SYNC_PROJECTIONS,
  SYNC_SNAPSHOT_READ_MODES,
} from "@hikoutei/contracts/sheets/constants.js";
import {
  computeSyncVisibleHash,
  observeSyncSnapshots,
  type ReadSyncSnapshotRequest,
} from "@hikoutei/contracts/sheets/syncSheets.js";
import { FakeSyncSheetsProvider } from "./support/FakeSyncSheetsProvider.js";

const ProbeSchema = defineEntity({
  name: "MissingBaselineProbe",
  tableName: "missing_baseline_probe",
  properties: {
    id: p.string().primary(),
    status: p.string(),
  },
});

class Probe extends ProbeSchema.class {
  declare id: string;
  declare status: string;
}

ProbeSchema.setClass(Probe);

const mapping = defineTypedSheetsEntityMapping<Probe>({
  entity: Probe,
  logicalSheetId: "missing-baseline-probe",
  primaryKey: "id",
  businessKey: "id",
  schemaVersion: 1,
  fields: [
    {
      property: "id",
      cellKind: NORMALIZED_CELL_KINDS.STRING,
      ownership: FIELD_OWNERSHIPS.USER,
      required: true,
      unique: true,
    },
    {
      property: "status",
      cellKind: NORMALIZED_CELL_KINDS.STRING,
      ownership: FIELD_OWNERSHIPS.USER,
      required: true,
    },
  ],
  projections: [
    {
      physicalSheetId: "missing-baseline-probe-system",
      spreadsheetId: "spreadsheet",
      tabName: "Probe_System",
      registeredRange: "A:C",
      projection: "system_state",
    },
    {
      physicalSheetId: "missing-baseline-probe-input",
      spreadsheetId: "spreadsheet",
      tabName: "Probe_Input",
      registeredRange: "A:C",
      projection: "user_input",
    },
  ],
});

const INPUT_PHYSICAL = "missing-baseline-probe-input";
const PENDING_STATUS: NormalizedCell = { kind: "string", value: "pending" };
const CHANGED_1: NormalizedCell = { kind: "string", value: "changed-1" };
const CHANGED_2: NormalizedCell = { kind: "string", value: "changed-2" };
const ID_1: NormalizedCell = { kind: "string", value: "q1" };
const ID_2: NormalizedCell = { kind: "string", value: "q2" };

function remote(id: NormalizedCell): Readonly<Record<string, NormalizedCell>> {
  return { id, status: id === ID_1 ? CHANGED_1 : CHANGED_2 };
}

function inputRequest(): ReadSyncSnapshotRequest {
  return {
    physicalSheetId: INPUT_PHYSICAL,
    sheetName: "Probe_Input",
    registeredRange: "A:C",
    projection: SYNC_PROJECTIONS.USER_INPUT,
    schemaVersion: 1,
    readMode: SYNC_SNAPSHOT_READ_MODES.FULL,
  };
}

/**
 * Polling state where q1 is an active canonical binding with NO User_Input
 * visible state (sheet_visible_state) record, and q2 is an active canonical
 * binding that does carry its visible state baseline.
 */
function state(): MappedPollingState {
  return {
    bindingsByEntityId: new Map([
      ["missing-baseline-probe", new Map([
        ["q1", {
          rowBindingId: "binding-q1",
          logicalSheetId: "missing-baseline-probe",
          anchorReference: "anchor-q1",
          entityId: "q1",
          state: ROW_BINDING_STATES.ACTIVE,
          candidateEpoch: 0,
        }],
        ["q2", {
          rowBindingId: "binding-q2",
          logicalSheetId: "missing-baseline-probe",
          anchorReference: "anchor-q2",
          entityId: "q2",
          state: ROW_BINDING_STATES.ACTIVE,
          candidateEpoch: 0,
        }],
      ])],
    ]),
    entitiesById: new Map([
      ["q1", {
        entityId: "q1",
        entityRevision: 1,
        status: "active",
        fields: new Map([
          ["id", { value: ID_1, fieldRevision: 1 }],
          ["status", { value: PENDING_STATUS, fieldRevision: 1 }],
        ]),
      }],
      ["q2", {
        entityId: "q2",
        entityRevision: 1,
        status: "active",
        fields: new Map([
          ["id", { value: ID_2, fieldRevision: 1 }],
          ["status", { value: PENDING_STATUS, fieldRevision: 1 }],
        ]),
      }],
    ]),
    businessKeysByLogicalAndField: new Map([
      ["missing-baseline-probe", new Map([
        ["id", new Map([
          [stableHash(ID_1), "q1"],
          [stableHash(ID_2), "q2"],
        ])],
      ])],
    ]),
    conflictsByBindingAndField: new Map(),
    visibleRevisionsByPhysicalAndBinding: new Map([
      [INPUT_PHYSICAL, new Map([
        ["binding-q2", {
          confirmedVisibleHash: computeSyncVisibleHash({ id: ID_2, status: PENDING_STATUS }),
          confirmedVisibleRevision: 0,
          confirmedEntityRevision: 1,
        }],
      ])],
    ]),
  };
}

function accumulator() {
  return {
    mapping,
    rowsScanned: 0,
    changedRows: 0,
    appliedRows: 0,
    conflictRows: 0,
    quarantinedRows: 0,
    duplicateRows: 0,
    staleRows: 0,
    fencedRows: 0,
    invalidRows: 0,
    unknownBusinessKeyRows: 0,
    duplicateBusinessKeyRows: 0,
  };
}

describe("mapped User_Input polling isolates a changed known-key row with no visible baseline", () => {
  it("does not block a valid row in the same pass when the missing-baseline row cannot build evidence", async () => {
    // The real Google provider leaves visibleRevision / visibleHash ABSENT on
    // every snapshot row; the confirmed baseline lives only in SQLite.
    const provider = new FakeSyncSheetsProvider([{
      physicalSheetId: INPUT_PHYSICAL,
      sheetName: "Probe_Input",
      registeredRange: "A:C",
      projection: SYNC_PROJECTIONS.USER_INPUT,
      schemaVersion: 1,
      headers: ["id", "status"],
      rows: [
        { targetId: "q1", physicalAnchor: "anchor-q1", fields: remote(ID_1) },
        { targetId: "q2", physicalAnchor: "anchor-q2", fields: remote(ID_2) },
      ],
    }], { realProviderSnapshotShape: true });

    const [observed] = await observeSyncSnapshots(provider, [inputRequest()]);
    expect(observed?.snapshot.rows).toHaveLength(2);

    const acc = accumulator();
    const prepared: PreparedRow[] = [];
    const invalid = inspectSnapshot(mapping, observed!, state(), acc, prepared);

    // q1 (changed known-key row with no sheet_visible_state) is quarantined
    // instead of becoming a synthetic observation without a baseline.
    expect(invalid).toHaveLength(1);
    expect(invalid[0]?.rowNumber).toBe(observed!.snapshot.rows[0]?.rowNumber);
    expect(invalid[0]?.reason).toBe(MAPPED_USER_INPUT_INVALID_REASONS.MISSING_VISIBLE_STATE);

    // q2 (changed known-key row with a baseline) continues through the same pass.
    expect(prepared).toHaveLength(1);
    expect(prepared[0]?.binding.rowBindingId).toBe("binding-q2");
    expect(acc.changedRows).toBe(1);
  });
});

describe("mapped User_Input polling coordinator isolates a missing-baseline row", () => {
  it("durably quarantines the missing-baseline row and applies an unrelated row in the same pass", async () => {
    const orm = await createOrm();
    try {
      const storage = createMikroOrmSqliteAdapter(orm);
      await migrateMikroOrmSqliteStorageSchema(storage);
      const writer = deterministicWriter("missing-baseline-coord-writer");
      await registerTypedSheetsEntityMappings(storage, [mapping], writer);

      const id1 = { kind: "string", value: "q1" } as const;
      const id2 = { kind: "string", value: "q2" } as const;
      const pending = { kind: "string", value: "pending" } as const;
      const changed2 = { kind: "string", value: "changed-2" } as const;

      await storage.transaction(async ({ sql }) => {
        // The in-memory ORM's entity table holds both rows so the accepted q2
        // update can be applied in the same pass.
        sql.run(
          "INSERT INTO missing_baseline_probe (id, status) VALUES (?, ?), (?, ?)",
          ["q1", "pending", "q2", "pending"],
        );
        sql.run(
          `INSERT INTO row_binding (row_binding_id, logical_sheet_id, anchor_reference, entity_id, state, candidate_epoch) VALUES
            ('binding-q1', 'missing-baseline-probe', 'anchor-q1', 'q1', 'active', 0),
            ('binding-q2', 'missing-baseline-probe', 'anchor-q2', 'q2', 'active', 0)`,
          [],
        );
        sql.run(
          "INSERT INTO entity_state (entity_id, entity_revision, status) VALUES ('q1', 1, 'active'), ('q2', 1, 'active')",
          [],
        );
        sql.run(
          `INSERT INTO entity_field_state (entity_id, field_name, normalized_value, field_revision, ownership) VALUES
            ('q1', 'id', ?, 1, 'user'),
            ('q1', 'status', ?, 1, 'user'),
            ('q2', 'id', ?, 1, 'user'),
            ('q2', 'status', ?, 1, 'user')`,
          [JSON.stringify(id1), JSON.stringify(pending), JSON.stringify(id2), JSON.stringify(pending)],
        );
        sql.run(
          `INSERT INTO business_key_index (logical_sheet_id, field_name, normalized_key, entity_id, state) VALUES
            ('missing-baseline-probe', 'id', ?, 'q1', 'active'),
            ('missing-baseline-probe', 'id', ?, 'q2', 'active')`,
          [stableHash(id1), stableHash(id2)],
        );
        // Only q2 carries a confirmed User_Input baseline; q1's row has none.
        sql.run(
          `INSERT INTO sheet_visible_state (physical_sheet_id, projection, row_binding_id, confirmed_snapshot_hash, confirmed_visible_revision, confirmed_entity_revision) VALUES
            ('missing-baseline-probe-input', 'user_input', 'binding-q2', ?, 0, 1)`,
          [computeSyncVisibleHash({ id: id2, status: pending })],
        );
      });

      const provider = new FakeSyncSheetsProvider([{
        physicalSheetId: INPUT_PHYSICAL,
        sheetName: "Probe_Input",
        registeredRange: "A:C",
        projection: SYNC_PROJECTIONS.USER_INPUT,
        schemaVersion: 1,
        headers: ["id", "status"],
        rows: [
          { targetId: "q1", physicalAnchor: "anchor-q1", fields: { id: id1, status: { kind: "string", value: "changed-1" } } },
          { targetId: "q2", physicalAnchor: "anchor-q2", fields: { id: id2, status: changed2 } },
        ],
      }], { realProviderSnapshotShape: true });

      // The whole pass must complete: the missing-baseline row is quarantined
      // instead of aborting the pass with an invalid_observation_input rejection.
      const report = await pollMappedUserInputWithMikroOrm({
        storage,
        provider,
        mappings: [mapping],
        writer,
      });

      expect(report.mode).toBe("full");
      expect(report.invalidRows).toBe(1);
      expect(report.quarantinedRows).toBe(1);
      expect(report.appliedRows).toBe(1);
      expect(report.sheets[0]).toMatchObject({
        invalidRows: 1,
        quarantinedRows: 1,
        appliedRows: 1,
      });

      // The missing-baseline row is durably quarantined with the shared polling
      // row-binding identity derived from its physical sheet + row number.
      const quarantine = await storage.read(({ sql }) => sql.all<{
        readonly reason: string;
        readonly row_binding_id: string;
      }>("SELECT reason, row_binding_id FROM quarantine_record", []));
      expect(quarantine).toHaveLength(1);
      expect(quarantine[0]).toMatchObject({
        reason: QUARANTINE_REASONS.INVALID_SNAPSHOT_METADATA,
        row_binding_id: `polling:${INPUT_PHYSICAL}:2`,
      });

      // The unrelated q2 row is applied in the same pass: canonical field state
      // reflects the accepted edit and no observation was lost to a conflict.
      await expect(storage.read(({ sql }) => sql.get<{ readonly normalized_value: string }>(
        "SELECT normalized_value FROM entity_field_state WHERE entity_id = 'q2' AND field_name = 'status'",
        [],
      ))).resolves.toEqual({ normalized_value: JSON.stringify(changed2) });
    } finally {
      await orm.close(true);
    }
  });
});

function deterministicWriter(role: string) {
  let nextId = 0;
  return {
    writerId: "missing-baseline-mapped-writer",
    role,
    leaseDurationMs: 1_000,
    now: () => 1_000,
    createId: () => `generated-${++nextId}`,
  };
}

async function createOrm() {
  const orm = await MikroORM.init({
    driver: SqliteDriver,
    dbName: ":memory:",
    driverOptions: new NodeSqliteDialect(":memory:"),
    entities: [Probe],
  });
  await orm.schema.create();
  return orm;
}
