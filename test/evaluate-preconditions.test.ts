import { describe, expect, it } from "vitest";
import {
  DELETE_EVIDENCE,
  PRECONDITION_RESULTS,
  QUARANTINE_REASONS,
  ROW_OPERATIONS,
} from "../src/domain/model/constants.js";
import type { RawObservedRowChange } from "../src/domain/model/types.js";
import { validateStructuralPreconditions } from "../src/domain/evaluate/preconditions.js";

const snapshot = {
  rowBindingId: "binding-1",
  fields: new Map(),
};

describe("structural preconditions", () => {
  it("promotes a raw insert into an insert-specific row type", () => {
    const rawRow: RawObservedRowChange = {
      rowBindingId: "binding-1",
      operation: ROW_OPERATIONS.INSERT,
      afterRow: snapshot,
      baseVisibleRevision: 1,
      fields: [
        {
          fieldName: "name",
          previousValue: null,
          nextValue: { kind: "string", value: "Ada" },
        },
      ],
    };

    const result = validateStructuralPreconditions(rawRow);

    expect(result.status).toBe(PRECONDITION_RESULTS.VALID);
    if (result.status !== PRECONDITION_RESULTS.VALID) throw new Error("expected valid row");

    expect(result.row.operation).toBe(ROW_OPERATIONS.INSERT);
    expect("beforeRow" in result.row).toBe(false);
    expect("baseEntityRevision" in result.row).toBe(false);
    expect("deleteEvidence" in result.row).toBe(false);
  });

  it("rejects an existing-row shape without its after snapshot", () => {
    const rawRow = {
      rowBindingId: "binding-1",
      operation: ROW_OPERATIONS.UPDATE,
      beforeRow: snapshot,
      afterRow: null,
      baseVisibleRevision: 1,
      baseEntityRevision: 1,
      deleteEvidence: null,
      fields: [
        {
          fieldName: "name",
          previousValue: { kind: "string", value: "Ada" },
          nextValue: { kind: "string", value: "Grace" },
          baseFieldRevision: 1,
        },
      ],
    };

    const result = validateStructuralPreconditions(rawRow);

    expect(result).toEqual({
      status: PRECONDITION_RESULTS.INVALID,
      reason: QUARANTINE_REASONS.INVALID_EVENT,
    });
  });

  it("rejects non-finite or negative visible revisions at the raw boundary", () => {
    for (const baseVisibleRevision of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const result = validateStructuralPreconditions({
        rowBindingId: "binding-1",
        operation: ROW_OPERATIONS.INSERT,
        afterRow: snapshot,
        baseVisibleRevision,
        fields: [
          {
            fieldName: "name",
            previousValue: null,
            nextValue: { kind: "string", value: "Ada" },
          },
        ],
      });
      expect(result).toEqual({
        status: PRECONDITION_RESULTS.INVALID,
        reason: QUARANTINE_REASONS.INVALID_EVENT,
      });
    }
  });

  it("rejects a snapshot whose fields are not a normalized row map", () => {
    const result = validateStructuralPreconditions({
      rowBindingId: "binding-1",
      operation: ROW_OPERATIONS.INSERT,
      afterRow: { rowBindingId: "binding-1", fields: {} },
      baseVisibleRevision: 1,
      fields: [
        {
          fieldName: "name",
          previousValue: null,
          nextValue: { kind: "string", value: "Ada" },
        },
      ],
    });
    expect(result).toEqual({
      status: PRECONDITION_RESULTS.INVALID,
      reason: QUARANTINE_REASONS.INVALID_EVENT,
    });
  });

  it("keeps delete evidence as an explicit state instead of null", () => {
    const rawRow: RawObservedRowChange = {
      rowBindingId: "binding-1",
      operation: ROW_OPERATIONS.DELETE,
      beforeRow: snapshot,
      baseVisibleRevision: 1,
      baseEntityRevision: 1,
      deleteEvidence: DELETE_EVIDENCE.ANCHOR_LOST,
      fields: [
        {
          fieldName: "name",
          previousValue: { kind: "string", value: "Ada" },
          nextValue: null,
          baseFieldRevision: 1,
        },
      ],
    };

    const result = validateStructuralPreconditions(rawRow);

    expect(result.status).toBe(PRECONDITION_RESULTS.VALID);
    if (result.status !== PRECONDITION_RESULTS.VALID) throw new Error("expected valid row");
    if (result.row.operation !== ROW_OPERATIONS.DELETE) throw new Error("expected delete row");

    expect(result.row.deleteEvidence).toBe(DELETE_EVIDENCE.ANCHOR_LOST);
    expect("afterRow" in result.row).toBe(false);
  });
});
