import { describe, expect, it } from "vitest";
import {
  CANONICAL_RESOLUTION_STATUSES,
  CANDIDATE_VISIBLE_EVIDENCE_STATUSES,
  CONFLICT_STATUSES,
  DELETE_EVIDENCE,
  FIELD_OWNERSHIPS,
  ROW_BINDING_STATES,
  ROW_OPERATIONS,
} from "../src/domain/model/constants.js";
import { NORMALIZED_CELL_KINDS } from "../src/shared/encoding/constants.js";
import { PRESENCE_KINDS } from "../src/shared/state/constants.js";
import type {
  ActiveRowBindingContext,
  CanonicalEntityState,
  ObservedDeleteRowChange,
  ObservedEditBatch,
  ObservedExistingRowChange,
  ObservedInsertRowChange,
} from "../src/domain/model/types.js";
import { evaluateBatch } from "../src/domain/evaluate/evaluateBatch.js";
import { acceptedDelete, evaluateUserFields } from "../src/domain/evaluate/fieldEvaluation.js";
import type { EvaluationContext as FieldEvaluationContext } from "../src/domain/evaluate/contracts.js";
import { ROW_OUTCOMES } from "../src/domain/evaluate/constants.js";
import {
  EVALUATION_ERROR_CODES,
  EvaluationContractError,
} from "../src/domain/errors/index.js";

const rowBindingId = "binding-1";
const entityId = "entity-1";

const canonical: CanonicalEntityState = {
  entityId,
  entityRevision: 3,
  businessKey: entityId,
  fields: new Map([
    [
      "name",
      {
        fieldName: "name",
        value: { kind: NORMALIZED_CELL_KINDS.STRING, value: "Ada" },
        fieldRevision: 2,
        ownership: FIELD_OWNERSHIPS.USER,
      },
    ],
    [
      "age",
      {
        fieldName: "age",
        value: { kind: NORMALIZED_CELL_KINDS.NUMBER, value: 36 },
        fieldRevision: 4,
        ownership: FIELD_OWNERSHIPS.USER,
      },
    ],
  ]),
};

const activeBinding: ActiveRowBindingContext = {
  rowBindingId,
  bindingState: ROW_BINDING_STATES.ACTIVE,
  entityId,
  businessKey: entityId,
  candidateEpoch: 1,
};

const baseContext = (): FieldEvaluationContext => ({
  manifest: new Map([
    [
      "name",
      {
        fieldName: "name",
        ownership: FIELD_OWNERSHIPS.USER,
        projection: "user_input",
        type: NORMALIZED_CELL_KINDS.STRING,
        required: true,
        unique: false,
      },
    ],
    [
      "age",
      {
        fieldName: "age",
        ownership: FIELD_OWNERSHIPS.USER,
        projection: "user_input",
        type: NORMALIZED_CELL_KINDS.NUMBER,
        required: false,
        unique: false,
      },
    ],
  ]),
  canonicalByBindingId: new Map([
    [rowBindingId, { status: CANONICAL_RESOLUTION_STATUSES.AVAILABLE, entity: canonical }],
  ]),
  bindingByBindingId: new Map([[rowBindingId, activeBinding]]),
  activeConflictsByBindingAndField: new Map(),
  businessKeyEntityIdsByField: new Map(),
  schemaVersion: 1,
});

const existingRow = (
  fields: ObservedExistingRowChange["fields"],
): ObservedExistingRowChange => ({
  rowBindingId,
  operation: ROW_OPERATIONS.UPDATE,
  beforeRow: { rowBindingId, fields: new Map() },
  afterRow: { rowBindingId, fields: new Map() },
  baseVisibleRevision: 4,
  baseEntityRevision: canonical.entityRevision,
  fields,
});

describe("field evaluation", () => {
  it("accepts an inserted field with its first field revision", () => {
    const row: ObservedInsertRowChange = {
      rowBindingId,
      operation: ROW_OPERATIONS.INSERT,
      afterRow: { rowBindingId, fields: new Map() },
      baseVisibleRevision: 1,
      fields: [
        {
          fieldName: "name",
          previousValue: null,
          nextValue: { kind: NORMALIZED_CELL_KINDS.STRING, value: "Ada" },
        },
      ],
    };

    const result = evaluateUserFields(
      row,
      { status: CANONICAL_RESOLUTION_STATUSES.MISSING },
      baseContext(),
    );

    expect(result).toEqual({
      rowBindingId,
      outcome: ROW_OUTCOMES.ACCEPTED,
      acceptedFields: [
        {
          fieldName: "name",
          nextValue: { kind: NORMALIZED_CELL_KINDS.STRING, value: "Ada" },
          nextFieldRevision: 1,
        },
      ],
      conflicts: [],
      nextEntityRevision: 1,
    });
  });

  it("partially accepts fields whose base revisions differ independently", () => {
    const result = evaluateUserFields(
      existingRow([
        {
          fieldName: "name",
          previousValue: { kind: NORMALIZED_CELL_KINDS.STRING, value: "Ada" },
          nextValue: { kind: NORMALIZED_CELL_KINDS.STRING, value: "Grace" },
          baseFieldRevision: 2,
        },
        {
          fieldName: "age",
          previousValue: { kind: NORMALIZED_CELL_KINDS.NUMBER, value: 36 },
          nextValue: { kind: NORMALIZED_CELL_KINDS.NUMBER, value: 37 },
          baseFieldRevision: 3,
        },
      ]),
      { status: CANONICAL_RESOLUTION_STATUSES.AVAILABLE, entity: canonical },
      baseContext(),
    );

    expect(result.outcome).toBe(ROW_OUTCOMES.PARTIALLY_ACCEPTED);
    if (result.outcome !== ROW_OUTCOMES.PARTIALLY_ACCEPTED) {
      throw new Error("expected partially accepted result");
    }
    expect(result.acceptedFields).toEqual([
      {
        fieldName: "name",
        nextValue: { kind: NORMALIZED_CELL_KINDS.STRING, value: "Grace" },
        nextFieldRevision: 3,
      },
    ]);
    expect(result.conflicts).toEqual([
      {
        fieldName: "age",
        userValue: { kind: NORMALIZED_CELL_KINDS.NUMBER, value: 37 },
        userBaseRevision: 3,
        canonicalValue: { kind: NORMALIZED_CELL_KINDS.NUMBER, value: 36 },
        canonicalRevision: 4,
      },
    ]);
    expect(result.nextEntityRevision).toBe(4);
  });

  it("returns a conflict result without an entity revision when every field is stale", () => {
    const result = evaluateUserFields(
      existingRow([
        {
          fieldName: "name",
          previousValue: { kind: NORMALIZED_CELL_KINDS.STRING, value: "Ada" },
          nextValue: { kind: NORMALIZED_CELL_KINDS.STRING, value: "Grace" },
          baseFieldRevision: 1,
        },
      ]),
      { status: CANONICAL_RESOLUTION_STATUSES.AVAILABLE, entity: canonical },
      baseContext(),
    );

    expect(result.outcome).toBe(ROW_OUTCOMES.CONFLICT);
    if (result.outcome !== ROW_OUTCOMES.CONFLICT) {
      throw new Error("expected conflict result");
    }
    expect(result.conflicts[0]?.userBaseRevision).toBe(1);
    expect(result).not.toHaveProperty("nextEntityRevision");
  });

  it("treats an active conflict as blocking the next field attempt", () => {
    const context: FieldEvaluationContext = {
      ...baseContext(),
      activeConflictsByBindingAndField: new Map([
        [
          rowBindingId,
          new Map([
            [
              "name",
              {
                conflictId: "conflict-1",
                conflictGroupId: { kind: PRESENCE_KINDS.ABSENT },
                eventId: "event-1",
                rowBindingId,
                entityId,
                fieldName: "name",
                userValue: { kind: NORMALIZED_CELL_KINDS.STRING, value: "Grace" },
                userBaseRevision: 1,
                canonicalValueAtDetection: { kind: NORMALIZED_CELL_KINDS.STRING, value: "Ada" },
                canonicalRevisionAtDetection: 2,
                currentCanonicalValue: { kind: NORMALIZED_CELL_KINDS.STRING, value: "Ada" },
                currentCanonicalRevision: 2,
                candidateEpoch: 1,
                candidateVisibleEvidence: { status: CANDIDATE_VISIBLE_EVIDENCE_STATUSES.UNAVAILABLE },
                status: CONFLICT_STATUSES.OPEN,
                resolutionCommandId: { kind: PRESENCE_KINDS.ABSENT },
              },
            ],
          ]),
        ],
      ]),
    };

    const result = evaluateUserFields(
      existingRow([
        {
          fieldName: "name",
          previousValue: { kind: NORMALIZED_CELL_KINDS.STRING, value: "Ada" },
          nextValue: { kind: NORMALIZED_CELL_KINDS.STRING, value: "Hopper" },
          baseFieldRevision: 2,
        },
      ]),
      { status: CANONICAL_RESOLUTION_STATUSES.AVAILABLE, entity: canonical },
      context,
    );

    expect(result.outcome).toBe(ROW_OUTCOMES.CONFLICT);
  });

  it("accepts a validated delete as a row-level revision transition", () => {
    const row: ObservedDeleteRowChange = {
      rowBindingId,
      operation: ROW_OPERATIONS.DELETE,
      beforeRow: { rowBindingId, fields: new Map() },
      baseVisibleRevision: 4,
      baseEntityRevision: canonical.entityRevision,
      deleteEvidence: DELETE_EVIDENCE.DELETED_CONFIRMED,
      fields: [
        {
          fieldName: "name",
          previousValue: { kind: NORMALIZED_CELL_KINDS.STRING, value: "Ada" },
          nextValue: null,
          baseFieldRevision: 2,
        },
      ],
    };

    expect(acceptedDelete(row, canonical)).toEqual({
      rowBindingId,
      outcome: ROW_OUTCOMES.ACCEPTED,
      acceptedFields: [],
      conflicts: [],
      nextEntityRevision: 4,
    });
  });

  it("routes a validated row through the batch evaluator", () => {
    const batch: ObservedEditBatch = {
      batchId: "batch-1",
      source: "onEdit",
      sheetId: "sheet-1",
      projection: "user_input",
      schemaVersion: 1,
      atomicity: "row_independent",
      baseSnapshotHash: "snapshot-1",
      ingressActorId: "service-1",
      editorActorId: { kind: PRESENCE_KINDS.ABSENT },
      editorActorSource: "unavailable",
      rows: [
        existingRow([
          {
            fieldName: "name",
            previousValue: { kind: NORMALIZED_CELL_KINDS.STRING, value: "Ada" },
            nextValue: { kind: NORMALIZED_CELL_KINDS.STRING, value: "Grace" },
            baseFieldRevision: 2,
          },
        ]),
      ],
    };

    const result = evaluateBatch(batch, baseContext());

    expect(result.overallOutcome).toBe(ROW_OUTCOMES.ACCEPTED);
    expect(result.rowResults[0]?.outcome).toBe(ROW_OUTCOMES.ACCEPTED);
  });

  it("throws a structured error when an existing row has no canonical state", () => {
    expect(() => evaluateUserFields(
      existingRow([
        {
          fieldName: "name",
          previousValue: { kind: NORMALIZED_CELL_KINDS.STRING, value: "Ada" },
          nextValue: { kind: NORMALIZED_CELL_KINDS.STRING, value: "Grace" },
          baseFieldRevision: 2,
        },
      ]),
      { status: CANONICAL_RESOLUTION_STATUSES.MISSING },
      baseContext(),
    )).toThrow(EvaluationContractError);

    try {
      evaluateUserFields(
        existingRow([
          {
            fieldName: "name",
            previousValue: { kind: NORMALIZED_CELL_KINDS.STRING, value: "Ada" },
            nextValue: { kind: NORMALIZED_CELL_KINDS.STRING, value: "Grace" },
            baseFieldRevision: 2,
          },
        ]),
        { status: CANONICAL_RESOLUTION_STATUSES.MISSING },
        baseContext(),
      );
    } catch (error) {
      expect(error).toMatchObject({
        domain: "evaluation",
        code: EVALUATION_ERROR_CODES.CANONICAL_STATE_REQUIRED,
      });
    }
  });
});
