/**
 * Check-column polling gate tests (storage side).
 *
 * Unit: `inspectChecksPollingTable` decisions (clean / targeted / escalate)
 * against canonical SQLite polling state — including the anchor-anomaly
 * escalations and the in-flight-own-write suppression.
 * Integration: a full `pollMappedUserInputWithMikroOrm` pass over the real
 * Google provider + the in-memory stub transport + a real SQLite store,
 * proving (a) a clean pass never reads a data column, (b) a human edit
 * escalates ONLY its row band, and (c) the conflict/applied outcome is
 * identical to the historical whole-table pass.
 */

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
  ROW_BINDING_STATES,
} from "@hikoutei/contracts/domain/model/constants.js";
import { stableHash } from "@hikoutei/contracts/encoding/stableEncode.js";
import type { NormalizedCell } from "@hikoutei/contracts/encoding/types.js";
import { NORMALIZED_CELL_KINDS } from "@hikoutei/contracts/encoding/constants.js";
import {
  computeRowCheckValue,
  renderRowCheckCell,
  SYNC_ROW_CHECK_HEADER,
} from "@hikoutei/contracts/sheets/rowCheck.js";
import { computeSyncVisibleHash, type SyncRowChecksResult } from "@hikoutei/contracts/sheets/syncSheets.js";
import { absentValue, presentValue } from "@hikoutei/contracts/state/index.js";
import type { RegisteredSyncProjectionDefinition } from "@hikoutei/contracts/sheets/sheetsProvisioning.js";
import { defineTypedSheetsEntityMapping } from "@hikoutei/sync-engine/orm/mapping/entityMapping.js";
import { registerTypedSheetsEntityMappings } from "@hikoutei/storage/orm/persistence/flush/flushCoordinator.js";
import { pollMappedUserInputWithMikroOrm, MAPPED_USER_INPUT_POLL_MODES } from "@hikoutei/storage/persistence/providers/mikro-orm/observation/MikroOrmUserInputPolling.js";
import {
  CHECKS_POLLING_DECISION_KINDS,
  inspectChecksPollingTable,
} from "@hikoutei/storage/persistence/providers/mikro-orm/observation/MikroOrmUserInputPollingChecks.js";
import type { MappedPollingState } from "@hikoutei/storage/persistence/providers/mikro-orm/observation/MikroOrmUserInputPollingState.js";
import { createMikroOrmSqliteAdapter } from "@hikoutei/storage/persistence/providers/mikro-orm/storage/MikroOrmSqliteAdapter.js";
import { migrateMikroOrmSqliteStorageSchema } from "@hikoutei/storage/persistence/providers/mikro-orm/storage/MikroOrmSqliteSchema.js";
import { GoogleSheetsApiSyncProvider } from "@hikoutei/sheets/sheets/providers/google-sheets-api/index.js";
import { GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME } from "@hikoutei/sheets/sheets/providers/google-sheets-api/constants.js";
import { buildRowCheckFormula } from "@hikoutei/sheets/sheets/providers/google-sheets-api/model/rowCheckFormula.js";
import {
  StubSheetsTransport,
  StubSpreadsheet,
  toStubCell,
  type StubSheet,
} from "./support/StubSheetsTransport.js";

interface GateProbe {
  readonly id: string;
  readonly status: string;
}

const ProbeSchema = defineEntity({
  name: "CheckGateProbe",
  tableName: "check_gate_probe",
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
  logicalSheetId: "check-gate-sheet",
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
      physicalSheetId: "check-gate-system",
      spreadsheetId: "spreadsheet",
      tabName: "Gate_System",
      registeredRange: "A:C",
      projection: "system_state",
    },
    {
      physicalSheetId: "check-gate-input",
      spreadsheetId: "spreadsheet",
      tabName: "Gate_Input",
      registeredRange: "A:C",
      projection: "user_input",
    },
  ],
});

const cell = {
  string: (value: string): NormalizedCell => ({ kind: "string", value }),
};

const ID_1 = cell.string("u1");
const ID_2 = cell.string("u2");
const PENDING = cell.string("pending");
const HUMAN_EDIT = cell.string("human-edit");

/** Check string of one row's (id, status) canonical pair (token encoding). */
function checkOf(id: NormalizedCell, status: NormalizedCell): string {
  return `${renderRowCheckCell(id)}|${renderRowCheckCell(status)}`;
}

/** Canonical polling state for both entities at (id, pending). */
function state(pendingDeliveryBindingIds: ReadonlySet<string> = new Set()): MappedPollingState {
  return {
    bindingsByEntityId: new Map([
      ["check-gate-sheet", new Map([
        ["u1", {
          rowBindingId: "binding-u1",
          logicalSheetId: "check-gate-sheet",
          anchorReference: "anchor-u1",
          entityId: "u1",
          state: ROW_BINDING_STATES.ACTIVE,
          candidateEpoch: 0,
        }],
        ["u2", {
          rowBindingId: "binding-u2",
          logicalSheetId: "check-gate-sheet",
          anchorReference: "anchor-u2",
          entityId: "u2",
          state: ROW_BINDING_STATES.ACTIVE,
          candidateEpoch: 0,
        }],
      ])],
    ]),
    entitiesById: new Map([
      ["u1", {
        entityId: "u1",
        entityRevision: 1,
        status: "active" as const,
        fields: new Map([
          ["id", { value: ID_1, fieldRevision: 1 }],
          ["status", { value: PENDING, fieldRevision: 1 }],
        ]),
      }],
      ["u2", {
        entityId: "u2",
        entityRevision: 1,
        status: "active" as const,
        fields: new Map([
          ["id", { value: ID_2, fieldRevision: 1 }],
          ["status", { value: PENDING, fieldRevision: 1 }],
        ]),
      }],
    ]),
    businessKeysByLogicalAndField: new Map([
      ["check-gate-sheet", new Map([
        ["id", new Map([
          [stableHash(ID_1), "u1"],
          [stableHash(ID_2), "u2"],
        ])],
      ])],
    ]),
    conflictsByBindingAndField: new Map(),
    visibleRevisionsByPhysicalAndBinding: new Map(),
    pendingDeliveryBindingIds,
  };
}

function checksResult(
  rows: SyncRowChecksResult["rows"],
  status: SyncRowChecksResult["status"] = "checks_available",
): SyncRowChecksResult {
  return { sheetName: "Gate_Input", registeredRange: "A:C", status, rows };
}

/** One clean gate row: identity + matching anchor + expected check token. */
function cleanRow(rowNumber: number, id: NormalizedCell, anchor: string) {
  return {
    rowNumber,
    identity: id,
    anchor: presentValue(anchor),
    check: presentValue(checkOf(id, PENDING)),
  };
}

describe("inspectChecksPollingTable", () => {
  it("returns clean when every check equals the canonical-derived value", () => {
    const decision = inspectChecksPollingTable(mapping, checksResult([
      cleanRow(2, ID_1, "anchor-u1"),
      cleanRow(3, ID_2, "anchor-u2"),
    ]), state());
    expect(decision.kind).toBe(CHECKS_POLLING_DECISION_KINDS.CLEAN);
    expect(decision.rowNumbers).toEqual([]);
    expect(decision.rowsScanned).toBe(2);
  });

  it("targets ONLY the mismatched rows for the band read", () => {
    const decision = inspectChecksPollingTable(mapping, checksResult([
      cleanRow(2, ID_1, "anchor-u1"),
      {
        rowNumber: 3,
        identity: ID_2,
        anchor: presentValue("anchor-u2"),
        check: presentValue(checkOf(ID_2, HUMAN_EDIT)),
      },
    ]), state());
    expect(decision.kind).toBe(CHECKS_POLLING_DECISION_KINDS.TARGETED);
    expect(decision.rowNumbers).toEqual([3]);
    expect(decision.changedRows).toBe(1);
    expect(decision.rowsScanned).toBe(2);
  });

  it("targets legacy rows with no check evidence (mixed mode)", () => {
    const decision = inspectChecksPollingTable(mapping, checksResult([
      { rowNumber: 2, identity: ID_1, anchor: presentValue("anchor-u1"), check: absentValue() },
      cleanRow(3, ID_2, "anchor-u2"),
    ]), state());
    expect(decision.kind).toBe(CHECKS_POLLING_DECISION_KINDS.TARGETED);
    expect(decision.rowNumbers).toEqual([2]);
  });

  it("skips a mismatching row whose own write delivery is still in flight", () => {
    // The Sheet still shows the PRE-write value while the outbox effect is
    // undelivered; treating that as human input would fabricate a conflict
    // against our own write, so a pending binding suppresses the mismatch.
    const staleRow = {
      rowNumber: 3,
      identity: ID_2,
      anchor: presentValue("anchor-u2"),
      check: presentValue("nonsense-not-the-expected-check"),
    };
    const pending = state(new Set(["binding-u2"]));
    expect(inspectChecksPollingTable(mapping, checksResult([
      cleanRow(2, ID_1, "anchor-u1"),
      staleRow,
    ]), pending).kind).toBe(CHECKS_POLLING_DECISION_KINDS.CLEAN);

    // Without the pending evidence the SAME row still targets normally.
    expect(inspectChecksPollingTable(mapping, checksResult([
      cleanRow(2, ID_1, "anchor-u1"),
      staleRow,
    ]), state()).kind).toBe(CHECKS_POLLING_DECISION_KINDS.TARGETED);
  });

  it("escalates a tab without the provisioned check column to the whole-table path", () => {
    const decision = inspectChecksPollingTable(
      mapping,
      checksResult([{ rowNumber: 2, identity: ID_1, anchor: absentValue(), check: absentValue() }], "checks_unavailable"),
      state(),
    );
    expect(decision.kind).toBe(CHECKS_POLLING_DECISION_KINDS.ESCALATE);
  });

  it("escalates unknown and duplicate identities", () => {
    const unknown = inspectChecksPollingTable(mapping, checksResult([
      { rowNumber: 2, identity: cell.string("intruder"), anchor: absentValue(), check: presentValue("x") },
    ]), state());
    expect(unknown.kind).toBe(CHECKS_POLLING_DECISION_KINDS.ESCALATE);

    const duplicate = inspectChecksPollingTable(mapping, checksResult([
      cleanRow(2, ID_1, "anchor-u1"),
      { ...cleanRow(3, ID_1, "anchor-u1") },
    ]), state());
    expect(duplicate.kind).toBe(CHECKS_POLLING_DECISION_KINDS.ESCALATE);
  });

  it("escalates an invalid identity cell and a vanished active entity", () => {
    const invalid = inspectChecksPollingTable(mapping, checksResult([
      { rowNumber: 2, identity: { kind: "number", value: 7 }, anchor: absentValue(), check: presentValue("7|pending") },
    ]), state());
    expect(invalid.kind).toBe(CHECKS_POLLING_DECISION_KINDS.ESCALATE);

    const vanished = inspectChecksPollingTable(mapping, checksResult([
      cleanRow(2, ID_1, "anchor-u1"),
    ]), state());
    expect(vanished.kind).toBe(CHECKS_POLLING_DECISION_KINDS.ESCALATE);
  });

  it("escalates anchor deletion, duplication, and misplacement", () => {
    // A human deleted the system row-id cell: only the whole-table
    // observation owns anchor re-assignment/orphan evidence.
    const deleted = inspectChecksPollingTable(mapping, checksResult([
      cleanRow(2, ID_1, "anchor-u1"),
      { rowNumber: 3, identity: ID_2, anchor: absentValue(), check: presentValue(checkOf(ID_2, PENDING)) },
    ]), state());
    expect(deleted.kind).toBe(CHECKS_POLLING_DECISION_KINDS.ESCALATE);

    // The anchor value moved to the wrong row (copy-paste of the row-id cell).
    const misplaced = inspectChecksPollingTable(mapping, checksResult([
      cleanRow(2, ID_1, "anchor-u1"),
      { rowNumber: 3, identity: ID_2, anchor: presentValue("anchor-u1"), check: presentValue(checkOf(ID_2, PENDING)) },
    ]), state());
    expect(misplaced.kind).toBe(CHECKS_POLLING_DECISION_KINDS.ESCALATE);

    // The same anchor appears on two rows (row copy).
    const duplicated = inspectChecksPollingTable(mapping, checksResult([
      cleanRow(2, ID_1, "anchor-shared"),
      { rowNumber: 3, identity: ID_2, anchor: presentValue("anchor-shared"), check: presentValue(checkOf(ID_2, PENDING)) },
    ]), state());
    expect(duplicated.kind).toBe(CHECKS_POLLING_DECISION_KINDS.ESCALATE);
  });
});

// ---------------------------------------------------------------------------
// Integration: real provider + stub transport + real SQLite polling pass.
// ---------------------------------------------------------------------------

function gateDefinition(): RegisteredSyncProjectionDefinition {
  return {
    sheet: {
      logicalSheetId: "check-gate-sheet",
      physicalSheetId: "check-gate-input",
      spreadsheetId: "stub-spreadsheet",
      tabName: "Gate_Input",
      registeredRange: "A:C",
      projection: "user_input",
      schemaVersion: 1,
      ownershipManifestJson: "{}",
      businessKeyField: "id",
      anchorMode: "business_key",
    },
    headers: ["id", "status"],
  };
}

/** Row-check formula for one seeded gate row (data columns A:B). */
function gateFormula(rowNumber: number): string {
  return buildRowCheckFormula(1, 2, rowNumber);
}

function seedGateSheet(humanEdit: boolean): {
  readonly transport: StubSheetsTransport;
  readonly tab: StubSheet;
} {
  const spreadsheet = new StubSpreadsheet();
  const tab = spreadsheet.addTab("Gate_Input", {
    headers: ["id", "status", "__hikoutei_row_id", SYNC_ROW_CHECK_HEADER],
  });
  spreadsheet.addTab(GOOGLE_SHEETS_API_RECEIPT_SHEET_NAME, {
    headers: ["effectId", "payloadHash", "status", "visibleHash", "visibleRevision", "updatedAt"],
    hidden: true,
  });
  const put = (row: number, col: number, value: NormalizedCell | string): void => {
    tab.cells.set(`${row - 1},${col}`, toStubCell(value));
  };
  put(2, 0, ID_1);
  put(2, 1, PENDING);
  put(2, 2, "anchor-u1");
  tab.cells.set("1,3", { userEnteredValue: { formulaValue: gateFormula(2) } });
  put(3, 0, ID_2);
  put(3, 1, humanEdit ? HUMAN_EDIT : PENDING);
  put(3, 2, "anchor-u2");
  tab.cells.set("2,3", { userEnteredValue: { formulaValue: gateFormula(3) } });
  return { transport: new StubSheetsTransport(spreadsheet), tab };
}

function deterministicWriter(role: string) {
  let nextId = 0;
  return {
    writerId: `check-gate-${role}-writer`,
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

async function seedStore(storage: ReturnType<typeof createMikroOrmSqliteAdapter>, writer: ReturnType<typeof deterministicWriter>) {
  await registerTypedSheetsEntityMappings(storage, [mapping], writer);
  await storage.transaction(async ({ sql }) => {
    sql.run(
      "INSERT INTO check_gate_probe (id, status) VALUES (?, ?), (?, ?)",
      ["u1", "pending", "u2", "pending"],
    );
    sql.run(
      `INSERT INTO row_binding (row_binding_id, logical_sheet_id, anchor_reference, entity_id, state, candidate_epoch) VALUES
        ('binding-u1', 'check-gate-sheet', 'anchor-u1', 'u1', 'active', 0),
        ('binding-u2', 'check-gate-sheet', 'anchor-u2', 'u2', 'active', 0)`,
      [],
    );
    sql.run(
      "INSERT INTO entity_state (entity_id, entity_revision, status) VALUES ('u1', 1, 'active'), ('u2', 1, 'active')",
      [],
    );
    sql.run(
      `INSERT INTO entity_field_state (entity_id, field_name, normalized_value, field_revision, ownership) VALUES
        ('u1', 'id', ?, 1, 'user'),
        ('u1', 'status', ?, 1, 'user'),
        ('u2', 'id', ?, 1, 'user'),
        ('u2', 'status', ?, 1, 'user')`,
      [JSON.stringify(ID_1), JSON.stringify(PENDING), JSON.stringify(ID_2), JSON.stringify(PENDING)],
    );
    sql.run(
      `INSERT INTO business_key_index (logical_sheet_id, field_name, normalized_key, entity_id, state) VALUES
        ('check-gate-sheet', 'id', ?, 'u1', 'active'),
        ('check-gate-sheet', 'id', ?, 'u2', 'active')`,
      [stableHash(ID_1), stableHash(ID_2)],
    );
    sql.run(
      `INSERT INTO sheet_visible_state (physical_sheet_id, projection, row_binding_id, confirmed_snapshot_hash, confirmed_visible_revision, confirmed_entity_revision) VALUES
        ('check-gate-input', 'user_input', 'binding-u1', ?, 1, 1),
        ('check-gate-input', 'user_input', 'binding-u2', ?, 1, 1)`,
      [
        computeSyncVisibleHash({ id: ID_1, status: PENDING }),
        computeSyncVisibleHash({ id: ID_2, status: PENDING }),
      ],
    );
  });
}

function gateProvider(transport: StubSheetsTransport): GoogleSheetsApiSyncProvider {
  return new GoogleSheetsApiSyncProvider({
    spreadsheetId: "stub-spreadsheet",
    definitions: [gateDefinition()],
    transport,
    requestTimeoutMs: 60_000,
    rateLimitIntervalMs: 0,
  });
}

describe("check-gated mapped polling pass (provider + storage)", () => {
  it("reads ONLY the identity/anchor/check bands when every row matches canonical state", async () => {
    const orm = await createOrm();
    try {
      const storage = createMikroOrmSqliteAdapter(orm);
      await migrateMikroOrmSqliteStorageSchema(storage);
      const writer = deterministicWriter("clean");
      await seedStore(storage, writer);
      const { transport } = seedGateSheet(false);
      const provider = gateProvider(transport);

      const report = await pollMappedUserInputWithMikroOrm({
        storage,
        provider,
        mappings: [mapping],
        writer,
        mode: MAPPED_USER_INPUT_POLL_MODES.ADAPTIVE,
      });

      expect(report.mode).toBe("adaptive");
      expect(report.changedRows).toBe(0);
      expect(report.rowsScanned).toBe(2);
      // The ONLY Gate_Input reads are the three narrow bands: identity
      // column A, anchor column C, check column D. No data column (B)
      // range was ever requested.
      const gateReads = transport.getSpreadsheetRequests.filter((request) =>
        request.ranges.some((range) => range.startsWith("'Gate_Input'")));
      expect(gateReads).toHaveLength(1);
      expect(gateReads[0]?.ranges).toEqual([
        "'Gate_Input'!A1:A1048576",
        "'Gate_Input'!C1:C1048576",
        "'Gate_Input'!D1:D1048576",
      ]);
      expect(gateReads[0]?.ranges.some((range) => /A1:C1048576|A1:D1048576/.test(range)))
        .toBe(false);
    } finally {
      await orm.close(true);
    }
  });

  it("band-reads ONLY the mismatched row, accepts the human edit, and matches the full-pass outcome", async () => {
    // Gated pass.
    const gatedOrm = await createOrm();
    let gatedReport;
    let gatedRanges: readonly string[][] = [];
    try {
      const storage = createMikroOrmSqliteAdapter(gatedOrm);
      await migrateMikroOrmSqliteStorageSchema(storage);
      const writer = deterministicWriter("gate");
      await seedStore(storage, writer);
      const { transport } = seedGateSheet(true);
      const provider = gateProvider(transport);
      gatedReport = await pollMappedUserInputWithMikroOrm({
        storage,
        provider,
        mappings: [mapping],
        writer,
        mode: MAPPED_USER_INPUT_POLL_MODES.ADAPTIVE,
      });
      gatedRanges = transport.getSpreadsheetRequests.map((request) => [...request.ranges]);
      const status = await storage.read(({ sql }) => sql.get<{ readonly normalized_value: string }>(
        "SELECT normalized_value FROM entity_field_state WHERE entity_id = 'u2' AND field_name = 'status'",
        [],
      ));
      expect(status?.normalized_value).toBe(JSON.stringify(HUMAN_EDIT));
    } finally {
      await gatedOrm.close(true);
    }
    expect(gatedReport?.changedRows).toBe(1);
    expect(gatedReport?.appliedRows).toBe(1);
    expect(gatedReport?.conflictRows).toBe(0);
    // The escalated read is the header band + the single dirty row band —
    // never the whole table.
    expect(gatedRanges.some((ranges) => ranges.includes("'Gate_Input'!A3:C3"))).toBe(true);
    expect(gatedRanges.some((ranges) => ranges.some((range) =>
      /^'Gate_Input'!A1:[CD]1048576$/.test(range)))).toBe(false);

    // Parity pass: the SAME scenario through the historical whole-table
    // observation (mode full) produces identical counts and canonical state.
    const fullOrm = await createOrm();
    try {
      const storage = createMikroOrmSqliteAdapter(fullOrm);
      await migrateMikroOrmSqliteStorageSchema(storage);
      const writer = deterministicWriter("full");
      await seedStore(storage, writer);
      const { transport } = seedGateSheet(true);
      const provider = gateProvider(transport);
      const fullReport = await pollMappedUserInputWithMikroOrm({
        storage,
        provider,
        mappings: [mapping],
        writer,
      });
      expect(fullReport.mode).toBe("full");
      expect({
        changedRows: fullReport.changedRows,
        appliedRows: fullReport.appliedRows,
        conflictRows: fullReport.conflictRows,
        quarantinedRows: fullReport.quarantinedRows,
      }).toEqual({
        changedRows: gatedReport?.changedRows ?? 0,
        appliedRows: gatedReport?.appliedRows ?? 0,
        conflictRows: gatedReport?.conflictRows ?? 0,
        quarantinedRows: gatedReport?.quarantinedRows ?? 0,
      });
      const status = await storage.read(({ sql }) => sql.get<{ readonly normalized_value: string }>(
        "SELECT normalized_value FROM entity_field_state WHERE entity_id = 'u2' AND field_name = 'status'",
        [],
      ));
      expect(status?.normalized_value).toBe(JSON.stringify(HUMAN_EDIT));
    } finally {
      await fullOrm.close(true);
    }
  });
});
