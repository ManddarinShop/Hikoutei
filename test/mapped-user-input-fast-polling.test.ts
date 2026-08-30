import { describe, expect, it } from "vitest";

import { FIELD_OWNERSHIPS } from "@hikoutei/contracts/domain/model/constants.js";
import { stableHash } from "@hikoutei/contracts/encoding/stableEncode.js";
import type { NormalizedCell } from "@hikoutei/contracts/encoding/types.js";
import { NORMALIZED_CELL_KINDS } from "@hikoutei/contracts/encoding/constants.js";
import { defineTypedSheetsEntityMapping } from "../src/application/orm/mapping/entityMapping.js";
import { inspectFastPollingTable } from "@hikoutei/storage/persistence/providers/mikro-orm/observation/MikroOrmUserInputPollingFastPath.js";
import type { MappedPollingState } from "@hikoutei/storage/persistence/providers/mikro-orm/observation/MikroOrmUserInputPollingState.js";
import type { SyncTableRowsResult } from "@hikoutei/contracts/sheets/syncSheets.js";

interface Probe {
  readonly id: string;
  readonly status: string;
}

interface RichRow {
  readonly id: string;
  readonly score: number;
  readonly active: boolean;
  readonly createdAt: string;
  readonly note: string;
}

const mapping = defineTypedSheetsEntityMapping<Probe>({
  entity: "FastPollingProbe",
  logicalSheetId: "fast-polling-probe",
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
      physicalSheetId: "fast-polling-probe-system",
      spreadsheetId: "spreadsheet",
      tabName: "Probe_System",
      registeredRange: "A:C",
      projection: "system_state",
    },
    {
      physicalSheetId: "fast-polling-probe-input",
      spreadsheetId: "spreadsheet",
      tabName: "Probe_Input",
      registeredRange: "A:C",
      projection: "user_input",
    },
  ],
});

const pendingId: NormalizedCell = { kind: "string", value: "u1" };
const pendingStatus: NormalizedCell = { kind: "string", value: "pending" };

function state(): MappedPollingState {
  return {
    bindingsByEntityId: new Map(),
    entitiesById: new Map([
      ["u1", {
        entityId: "u1",
        entityRevision: 1,
        status: "active",
        fields: new Map([
          ["id", { value: pendingId, fieldRevision: 1 }],
          ["status", { value: pendingStatus, fieldRevision: 1 }],
        ]),
      }],
    ]),
    businessKeysByLogicalAndField: new Map([
      ["fast-polling-probe", new Map([
        ["id", new Map([[stableHash(pendingId), "u1"]])],
      ])],
    ]),
    conflictsByBindingAndField: new Map(),
    visibleRevisionsByPhysicalAndBinding: new Map(),
  };
}

function result(rows: SyncTableRowsResult["rows"]): SyncTableRowsResult {
  return {
    sheetName: "Probe_Input",
    registeredRange: "A:C",
    headers: ["id", "status"],
    rows,
  };
}

describe("values-only mapped User_Input preflight", () => {
  it("skips metadata when every visible value matches canonical state", () => {
    const decision = inspectFastPollingTable(mapping, result([
      {
        rowNumber: 2,
        fields: { id: pendingId, status: pendingStatus },
      },
    ]), state());

    expect(decision).toEqual({
      needsFullMetadata: false,
      rowsScanned: 1,
      changedRows: 0,
    });
  });

  it("escalates a visible edit without accepting it in the preflight", () => {
    const decision = inspectFastPollingTable(mapping, result([
      {
        rowNumber: 2,
        fields: {
          id: pendingId,
          status: { kind: "string", value: "approved" },
        },
      },
    ]), state());

    expect(decision).toEqual({
      needsFullMetadata: true,
      rowsScanned: 1,
      changedRows: 1,
    });
  });

  it("escalates ambiguous, unknown, and missing rows for full inspection", () => {
    const unknown = inspectFastPollingTable(mapping, result([
      {
        rowNumber: 2,
        fields: {
          id: { kind: "string", value: "unknown" },
          status: pendingStatus,
        },
      },
    ]), state());
    const duplicate = inspectFastPollingTable(mapping, result([
      { rowNumber: 2, fields: { id: pendingId, status: pendingStatus } },
      { rowNumber: 3, fields: { id: pendingId, status: pendingStatus } },
    ]), state());
    const missing = inspectFastPollingTable(mapping, result([]), state());

    expect(unknown.needsFullMetadata).toBe(true);
    expect(duplicate.needsFullMetadata).toBe(true);
    expect(missing.needsFullMetadata).toBe(true);
  });
});

const richMapping = defineTypedSheetsEntityMapping<RichRow>({
  entity: "FastPollingRich",
  logicalSheetId: "fast-polling-rich",
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
      property: "score",
      cellKind: NORMALIZED_CELL_KINDS.NUMBER,
      ownership: FIELD_OWNERSHIPS.USER,
      required: true,
    },
    {
      property: "active",
      cellKind: NORMALIZED_CELL_KINDS.BOOLEAN,
      ownership: FIELD_OWNERSHIPS.USER,
      required: true,
    },
    {
      property: "createdAt",
      cellKind: NORMALIZED_CELL_KINDS.DATE,
      ownership: FIELD_OWNERSHIPS.USER,
      required: true,
    },
    {
      property: "note",
      cellKind: NORMALIZED_CELL_KINDS.STRING,
      ownership: FIELD_OWNERSHIPS.USER,
      required: false,
    },
  ],
  projections: [
    {
      physicalSheetId: "fast-polling-rich-system",
      spreadsheetId: "spreadsheet",
      tabName: "Rich_System",
      registeredRange: "A:F",
      projection: "system_state",
    },
    {
      physicalSheetId: "fast-polling-rich-input",
      spreadsheetId: "spreadsheet",
      tabName: "Rich_Input",
      registeredRange: "A:F",
      projection: "user_input",
    },
  ],
});

const richId: NormalizedCell = { kind: "string", value: "r1" };
const richScore: NormalizedCell = { kind: "number", value: 42 };
const richActive: NormalizedCell = { kind: "boolean", value: true };
const richCreatedAt: NormalizedCell = { kind: "date", value: "2024-01-15T00:00:00.000Z" };
const richNote: NormalizedCell = null;

function richFields(overrides: Readonly<Record<string, NormalizedCell>> = {}): Readonly<Record<string, NormalizedCell>> {
  return {
    id: richId,
    score: richScore,
    active: richActive,
    createdAt: richCreatedAt,
    note: richNote,
    ...overrides,
  };
}

function richState(): MappedPollingState {
  return {
    bindingsByEntityId: new Map(),
    entitiesById: new Map([
      ["r1", {
        entityId: "r1",
        entityRevision: 1,
        status: "active",
        fields: new Map([
          ["id", { value: richId, fieldRevision: 1 }],
          ["score", { value: richScore, fieldRevision: 1 }],
          ["active", { value: richActive, fieldRevision: 1 }],
          ["createdAt", { value: richCreatedAt, fieldRevision: 1 }],
          ["note", { value: richNote, fieldRevision: 1 }],
        ]),
      }],
    ]),
    businessKeysByLogicalAndField: new Map([
      ["fast-polling-rich", new Map([
        ["id", new Map([[stableHash(richId), "r1"]])],
      ])],
    ]),
    conflictsByBindingAndField: new Map(),
    visibleRevisionsByPhysicalAndBinding: new Map(),
  };
}

function richResult(rows: SyncTableRowsResult["rows"]): SyncTableRowsResult {
  return {
    sheetName: "Rich_Input",
    registeredRange: "A:F",
    headers: ["id", "score", "active", "createdAt", "note"],
    rows,
  };
}

describe("values-only preflight field-type and escalation coverage", () => {
  it("treats matching string/number/boolean/date and optional-null cells as unchanged", () => {
    const decision = inspectFastPollingTable(richMapping, richResult([
      { rowNumber: 2, fields: richFields() },
    ]), richState());

    expect(decision).toEqual({
      needsFullMetadata: false,
      rowsScanned: 1,
      changedRows: 0,
    });
  });

  it("escalates when a number, boolean, or date value changes", () => {
    const numberChanged = inspectFastPollingTable(richMapping, richResult([
      { rowNumber: 2, fields: richFields({ score: { kind: "number", value: 43 } }) },
    ]), richState());
    const booleanChanged = inspectFastPollingTable(richMapping, richResult([
      { rowNumber: 2, fields: richFields({ active: { kind: "boolean", value: false } }) },
    ]), richState());
    const dateChanged = inspectFastPollingTable(richMapping, richResult([
      { rowNumber: 2, fields: richFields({ createdAt: { kind: "date", value: "2024-02-01T00:00:00.000Z" } }) },
    ]), richState());

    expect(numberChanged).toMatchObject({ needsFullMetadata: true, changedRows: 1 });
    expect(booleanChanged).toMatchObject({ needsFullMetadata: true, changedRows: 1 });
    expect(dateChanged).toMatchObject({ needsFullMetadata: true, changedRows: 1 });
  });

  it("escalates without counting a change when a required cell is blank, empty, or the wrong kind", () => {
    const blankRequired = inspectFastPollingTable(richMapping, richResult([
      { rowNumber: 2, fields: richFields({ score: null }) },
    ]), richState());
    const emptyStringRequired = inspectFastPollingTable(richMapping, richResult([
      { rowNumber: 2, fields: richFields({ id: { kind: "string", value: "" } }) },
    ]), richState());
    const wrongKind = inspectFastPollingTable(richMapping, richResult([
      { rowNumber: 2, fields: richFields({ score: { kind: "string", value: "not-a-number" } }) },
    ]), richState());

    expect(blankRequired.needsFullMetadata).toBe(true);
    expect(blankRequired.changedRows).toBe(0);
    expect(emptyStringRequired.needsFullMetadata).toBe(true);
    expect(emptyStringRequired.changedRows).toBe(0);
    expect(wrongKind.needsFullMetadata).toBe(true);
    expect(wrongKind.changedRows).toBe(0);
  });

  it("throws on a header or registered-range mismatch instead of silently skipping", () => {
    const mismatchedHeaders = {
      sheetName: "Rich_Input",
      registeredRange: "A:F",
      headers: ["id", "score", "active", "createdAt", "renamed"],
      rows: [{ rowNumber: 2, fields: richFields() }],
    } as unknown as SyncTableRowsResult;
    expect(() => inspectFastPollingTable(richMapping, mismatchedHeaders, richState())).toThrow();

    const mismatchedRange = {
      sheetName: "Rich_Input",
      registeredRange: "A:E",
      headers: ["id", "score", "active", "createdAt", "note"],
      rows: [],
    } as unknown as SyncTableRowsResult;
    expect(() => inspectFastPollingTable(richMapping, mismatchedRange, richState())).toThrow();
  });

  it("escalates the whole table when one row changes among several unchanged rows", () => {
    const secondId: NormalizedCell = { kind: "string", value: "r2" };
    const stateWithTwo: MappedPollingState = {
      bindingsByEntityId: new Map(),
      entitiesById: new Map([
        ...richState().entitiesById,
        ["r2", {
          entityId: "r2",
          entityRevision: 1,
          status: "active",
          fields: new Map([
            ["id", { value: secondId, fieldRevision: 1 }],
            ["score", { value: richScore, fieldRevision: 1 }],
            ["active", { value: richActive, fieldRevision: 1 }],
            ["createdAt", { value: richCreatedAt, fieldRevision: 1 }],
            ["note", { value: richNote, fieldRevision: 1 }],
          ]),
        }],
      ]),
      businessKeysByLogicalAndField: new Map([
        ["fast-polling-rich", new Map([
          ["id", new Map([
            [stableHash(richId), "r1"],
            [stableHash(secondId), "r2"],
          ])],
        ])],
      ]),
      conflictsByBindingAndField: new Map(),
      visibleRevisionsByPhysicalAndBinding: new Map(),
    };

    const decision = inspectFastPollingTable(richMapping, richResult([
      { rowNumber: 2, fields: richFields() },
      { rowNumber: 3, fields: { ...richFields({ id: secondId }), score: { kind: "number", value: 99 } } },
    ]), stateWithTwo);

    expect(decision).toEqual({
      needsFullMetadata: true,
      rowsScanned: 2,
      changedRows: 1,
    });
  });

  it("escalates when an active canonical entity has no visible User_Input row", () => {
    const decision = inspectFastPollingTable(richMapping, richResult([]), richState());

    expect(decision.needsFullMetadata).toBe(true);
    expect(decision.rowsScanned).toBe(0);
    expect(decision.changedRows).toBe(0);
  });
});
