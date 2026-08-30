import { describe, expect, it } from "vitest";

import {
  FIELD_OWNERSHIPS,
  ROW_BINDING_STATES,
} from "@hikoutei/contracts/domain/model/constants.js";
import { stableHash } from "@hikoutei/contracts/encoding/stableEncode.js";
import type { NormalizedCell } from "@hikoutei/contracts/encoding/types.js";
import { APPLICABILITY_KINDS } from "@hikoutei/contracts/state/constants.js";
import { NORMALIZED_CELL_KINDS } from "@hikoutei/contracts/encoding/constants.js";
import { CELL_OBSERVATION_KINDS } from "@hikoutei/contracts/encoding/constants.js";
import { PRESENCE_KINDS } from "@hikoutei/contracts/state/constants.js";
import { OBSERVATION_WRITE_RESULT_KINDS } from "@hikoutei/storage/storage/state/observation/observationConstants.js";
import {
  isAuthoritativeObservationResult,
} from "@hikoutei/storage/persistence/providers/mikro-orm/observation/MikroOrmUserInputPollingPersistence.js";
import type { PersistObservedRowResult } from "@hikoutei/storage/storage/state/observation/observationTypes.js";
import { defineTypedSheetsEntityMapping } from "@hikoutei/sync-engine/orm/mapping/entityMapping.js";
import {
  MAPPED_USER_INPUT_INVALID_REASONS,
  inspectSnapshot,
  type PreparedRow,
} from "@hikoutei/storage/persistence/providers/mikro-orm/observation/MikroOrmUserInputPollingInspection.js";
import { inspectFastPollingTable } from "@hikoutei/storage/persistence/providers/mikro-orm/observation/MikroOrmUserInputPollingFastPath.js";
import type { MappedPollingState } from "@hikoutei/storage/persistence/providers/mikro-orm/observation/MikroOrmUserInputPollingState.js";
import { SYNC_PROTOCOL_VERSIONS } from "@hikoutei/contracts/sheets/constants.js";
import { SYNC_PROJECTIONS } from "@hikoutei/contracts/sheets/constants.js";
import type {
  SyncObservedSnapshot,
  SyncSnapshotCell,
  SyncSnapshotRow,
  SyncTableRowsResult,
} from "@hikoutei/contracts/sheets/syncSheets.js";

interface Probe {
  readonly id: string;
  readonly status: string;
}

const mapping = defineTypedSheetsEntityMapping<Probe>({
  entity: "QuarantineProbe",
  logicalSheetId: "quarantine-probe",
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
      physicalSheetId: "quarantine-probe-system",
      spreadsheetId: "spreadsheet",
      tabName: "Probe_System",
      registeredRange: "A:C",
      projection: "system_state",
    },
    {
      physicalSheetId: "quarantine-probe-input",
      spreadsheetId: "spreadsheet",
      tabName: "Probe_Input",
      registeredRange: "A:C",
      projection: "user_input",
    },
  ],
});

const probeId: NormalizedCell = { kind: "string", value: "q1" };
const pendingStatus: NormalizedCell = { kind: "string", value: "pending" };
const ROW_BINDING_ID = "binding-q1";

function state(): MappedPollingState {
  return {
    bindingsByEntityId: new Map([
      ["quarantine-probe", new Map([
        ["q1", {
          rowBindingId: ROW_BINDING_ID,
          logicalSheetId: "quarantine-probe",
          anchorReference: "anchor-q1",
          entityId: "q1",
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
          ["id", { value: probeId, fieldRevision: 1 }],
          ["status", { value: pendingStatus, fieldRevision: 1 }],
        ]),
      }],
    ]),
    businessKeysByLogicalAndField: new Map([
      ["quarantine-probe", new Map([
        ["id", new Map([[stableHash(probeId), "q1"]])],
      ])],
    ]),
    conflictsByBindingAndField: new Map(),
    visibleRevisionsByPhysicalAndBinding: new Map(),
  };
}

function present<T>(value: T): { kind: typeof PRESENCE_KINDS.PRESENT; value: T } {
  return { kind: PRESENCE_KINDS.PRESENT, value };
}

function absent<T>(): { kind: typeof PRESENCE_KINDS.ABSENT } {
  return { kind: PRESENCE_KINDS.ABSENT };
}

function literalCell(value: NormalizedCell): SyncSnapshotCell {
  return {
    cellKind: CELL_OBSERVATION_KINDS.LITERAL,
    normalizedCell: value,
    formulaHash: absent(),
    mergeRange: absent(),
    errorCode: absent(),
    stableHash: present(stableHash(value)),
  };
}

/** A non-literal cell whose cached value still equals canonical state. */
function metadataCell(
  kind: typeof CELL_OBSERVATION_KINDS.FORMULA | typeof CELL_OBSERVATION_KINDS.MERGED | typeof CELL_OBSERVATION_KINDS.ERROR,
  value: NormalizedCell,
): SyncSnapshotCell {
  return {
    cellKind: kind,
    normalizedCell: value,
    formulaHash: kind === CELL_OBSERVATION_KINDS.FORMULA ? present(stableHash("=B2")) : absent(),
    mergeRange: kind === CELL_OBSERVATION_KINDS.MERGED ? present("A2:B2") : absent(),
    errorCode: kind === CELL_OBSERVATION_KINDS.ERROR ? present("#REF!") : absent(),
    stableHash: present(stableHash(value)),
  };
}

function snapshotRow(statusCell: SyncSnapshotCell): SyncSnapshotRow {
  return {
    rowNumber: 2,
    physicalAnchor: present("anchor-q1"),
    visibleRevision: present(0),
    visibleHash: present(stableHash({ id: probeId, status: pendingStatus })),
    cells: { id: literalCell(probeId), status: statusCell },
  };
}

function observed(statusCell: SyncSnapshotCell): SyncObservedSnapshot {
  const snapshot = {
    protocolVersion: SYNC_PROTOCOL_VERSIONS.V1,
    sheetName: "Probe_Input",
    registeredRange: "A:C",
    projection: SYNC_PROJECTIONS.USER_INPUT,
    schemaVersion: 1,
    headers: ["id", "status"],
    rows: [snapshotRow(statusCell)],
    snapshotHash: stableHash({ cells: statusCell.cellKind }),
    unanchoredRows: [],
    duplicateAnchors: [],
  };
  return { anchors: { assigned: 0, existing: 1, duplicateAnchors: [] }, snapshot };
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

describe("deferred conflict evidence eligibility", () => {
  it("excludes stale, duplicate, quarantined, and fenced observations", () => {
    const results: PersistObservedRowResult[] = [
      { kind: OBSERVATION_WRITE_RESULT_KINDS.FENCED_OUT },
      {
        kind: OBSERVATION_WRITE_RESULT_KINDS.STALE,
      },
      {
        kind: OBSERVATION_WRITE_RESULT_KINDS.DUPLICATE,
        observationId: "observation-duplicate",
        eventId: present("event-duplicate"),
        reason: "candidate",
      },
      {
        kind: OBSERVATION_WRITE_RESULT_KINDS.QUARANTINED,
        observationId: "observation-quarantined",
        eventId: absent(),
        quarantineId: "q-quarantined",
      },
      {
        kind: OBSERVATION_WRITE_RESULT_KINDS.PERSISTED,
        observationId: "observation-persisted",
        eventId: "event-persisted",
        eventSequence: 1,
        outcome: "conflict",
        entityRevision: { kind: APPLICABILITY_KINDS.NOT_APPLICABLE },
        conflictIds: ["conflict-persisted"],
      },
    ];

    expect(results.map(isAuthoritativeObservationResult)).toEqual([
      false,
      false,
      false,
      false,
      true,
    ]);
  });
});

describe("full metadata observation quarantines non-literal User_Input cells", () => {
  it("accepts a matching literal row and escalates a changed literal value", () => {
    const unchanged = inspectSnapshot(mapping, observed(literalCell(pendingStatus)), state(), accumulator(), []);
    expect(unchanged).toEqual([]);

    const approved: NormalizedCell = { kind: "string", value: "approved" };
    const acc = accumulator();
    const prepared: PreparedRow[] = [];
    inspectSnapshot(mapping, observed(literalCell(approved)), state(), acc, prepared);
    expect(acc.changedRows).toBe(1);
    expect(prepared).toHaveLength(1);
  });

  it("quarantines formula, merged, and error cells even when the cached value matches canonical", () => {
    // The cached value equals canonical "pending"; only the full metadata
    // observation can see the non-literal cell kind and quarantine it.
    for (const kind of [
      CELL_OBSERVATION_KINDS.FORMULA,
      CELL_OBSERVATION_KINDS.MERGED,
      CELL_OBSERVATION_KINDS.ERROR,
    ] as const) {
      const acc = accumulator();
      const invalid = inspectSnapshot(mapping, observed(metadataCell(kind, pendingStatus)), state(), acc, []);
      expect(invalid).toHaveLength(1);
      const reasonByKind = {
        [CELL_OBSERVATION_KINDS.FORMULA]: MAPPED_USER_INPUT_INVALID_REASONS.FORMULA_CELL,
        [CELL_OBSERVATION_KINDS.MERGED]: MAPPED_USER_INPUT_INVALID_REASONS.MERGED_CELL,
        [CELL_OBSERVATION_KINDS.ERROR]: MAPPED_USER_INPUT_INVALID_REASONS.ERROR_CELL,
      } as const;
      expect(invalid[0]?.reason).toBe(reasonByKind[kind]);
      expect(acc.changedRows).toBe(0);
    }
  });

  it("defers a formula-valued row to full scan: the values-only preflight cannot see the formula", () => {
    // The fast path reads values only. A formula cell whose cached value
    // matches canonical looks unchanged, so the preflight skips metadata.
    // The periodic safety full scan (above) is what eventually quarantines it.
    const valuesResult: SyncTableRowsResult = {
      sheetName: "Probe_Input",
      registeredRange: "A:C",
      headers: ["id", "status"],
      rows: [{ rowNumber: 2, fields: { id: probeId, status: pendingStatus } }],
    };
    const decision = inspectFastPollingTable(mapping, valuesResult, state());
    expect(decision.needsFullMetadata).toBe(false);
    expect(decision.changedRows).toBe(0);
  });
});
