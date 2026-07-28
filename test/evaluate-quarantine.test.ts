import { describe, expect, it } from "vitest";
import {
  CANONICAL_RESOLUTION_STATUSES,
  FIELD_OWNERSHIPS,
  QUARANTINE_REASONS,
  ROW_OPERATIONS,
} from "../src/domain/model/constants.js";
import type {
  CanonicalEntityState,
  ObservedRowChange,
} from "../src/domain/model/types.js";
import {
  quarantineRow,
  quarantineSystemRow,
} from "../src/domain/evaluate/quarantine.js";
import {
  QUARANTINE_REPAIR_NOT_PLANNED_REASONS,
  QUARANTINE_REPAIR_STATUSES,
  ROW_OUTCOMES,
} from "../src/domain/evaluate/constants.js";
import type { OwnershipCheckResult } from "../src/domain/evaluate/preconditions.js";

const row: ObservedRowChange = {
  rowBindingId: "binding-1",
  operation: ROW_OPERATIONS.UPDATE,
  beforeRow: {
    rowBindingId: "binding-1",
    fields: new Map(),
  },
  afterRow: {
    rowBindingId: "binding-1",
    fields: new Map(),
  },
  baseVisibleRevision: 4,
  baseEntityRevision: 2,
  fields: [
    {
      fieldName: "updatedAt",
      previousValue: { kind: "string", value: "before" },
      nextValue: { kind: "string", value: "after" },
      baseFieldRevision: 2,
    },
  ],
};

const ownership: OwnershipCheckResult = {
  hasSystemField: true,
  hasUserField: false,
  systemFields: [
    {
      fieldName: "updatedAt",
      value: { kind: "string", value: "after" },
    },
  ],
};

const canonical: CanonicalEntityState = {
  entityId: "entity-1",
  entityRevision: 2,
  businessKey: "entity-1",
  fields: new Map([
    [
      "updatedAt",
      {
        fieldName: "updatedAt",
        value: { kind: "string", value: "canonical" },
        fieldRevision: 2,
        ownership: FIELD_OWNERSHIPS.SYSTEM,
      },
    ],
  ]),
};

describe("quarantine result contracts", () => {
  it("marks generic quarantine without a repair plan or entity revision", () => {
    const result = quarantineRow(row, QUARANTINE_REASONS.INVALID_EVENT);

    expect(result.outcome).toBe(ROW_OUTCOMES.QUARANTINE);
    if (result.outcome !== ROW_OUTCOMES.QUARANTINE) throw new Error("expected quarantine result");

    expect(result.repair).toEqual({
      status: QUARANTINE_REPAIR_STATUSES.NOT_PLANNED,
      reason: QUARANTINE_REPAIR_NOT_PLANNED_REASONS.QUARANTINE_ONLY,
    });
    expect(result).not.toHaveProperty("nextEntityRevision");
  });

  it("creates an explicit repair decision for a system-only edit", () => {
    const result = quarantineSystemRow(
      row,
      { status: CANONICAL_RESOLUTION_STATUSES.AVAILABLE, entity: canonical },
      ownership,
    );

    expect(result.outcome).toBe(ROW_OUTCOMES.QUARANTINE);
    if (result.outcome !== ROW_OUTCOMES.QUARANTINE) throw new Error("expected quarantine result");

    expect(result.repair.status).toBe(QUARANTINE_REPAIR_STATUSES.PLANNED);
    if (result.repair.status !== QUARANTINE_REPAIR_STATUSES.PLANNED) {
      throw new Error("expected repair plan");
    }

    expect(result.repair.plan.canonicalTargetValues.get("updatedAt")).toEqual({
      kind: "string",
      value: "canonical",
    });
    expect(result).not.toHaveProperty("nextEntityRevision");
  });

  it("explains why system repair is not planned without canonical state", () => {
    const result = quarantineSystemRow(
      row,
      { status: CANONICAL_RESOLUTION_STATUSES.MISSING },
      ownership,
    );

    expect(result.outcome).toBe(ROW_OUTCOMES.QUARANTINE);
    if (result.outcome !== ROW_OUTCOMES.QUARANTINE) throw new Error("expected quarantine result");

    expect(result.repair).toEqual({
      status: QUARANTINE_REPAIR_STATUSES.NOT_PLANNED,
      reason: QUARANTINE_REPAIR_NOT_PLANNED_REASONS.CANONICAL_UNAVAILABLE,
    });
  });
});
