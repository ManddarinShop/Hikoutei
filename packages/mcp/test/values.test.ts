/**
 * Tests for the JSON-boundary value guards: unknown fields, wrong scalar
 * types, operator misuse, primary-key rules, and date coercion.
 */

import { describe, expect, it } from "vitest";
import type { HikouteiMcpConfig } from "../src/config.js";
import { buildToolEntityInfos } from "../src/values.js";
import {
  validateOrderBy,
  validatePrimaryId,
  validateRecordData,
  validateWhereFilter,
  serializeRecord,
} from "../src/values.js";

const config: HikouteiMcpConfig = {
  entities: [
    {
      name: "tasks",
      tableName: "tasks",
      properties: {
        id: { type: "string", primary: true },
        title: { type: "string" },
        done: { type: "boolean" },
        effort: { type: "number", nullable: true },
        dueAt: { type: "date" },
      },
    },
    {
      name: "logs",
      tableName: "logs",
      properties: { seq: { type: "number", primary: true }, message: { type: "string" } },
    },
  ],
};

const infos = buildToolEntityInfos(config);
const tasks = infos.get("tasks");
const logs = infos.get("logs");
if (tasks === undefined || logs === undefined) throw new Error("fixture entities missing");

describe("validateRecordData", () => {
  it("coerces valid create payloads including dates", () => {
    const result = validateRecordData(tasks, {
      id: "t1",
      title: "write tests",
      done: false,
      effort: 3,
      dueAt: "2026-08-01T00:00:00.000Z",
    }, "create");
    expect(result.status).toBe("valid");
    if (result.status !== "valid") return;
    expect(result.value.id).toBe("t1");
    expect(result.value.effort).toBe(3);
    expect(result.value.dueAt).toBeInstanceOf(Date);
  });

  it("accepts null only for nullable fields", () => {
    const ok = validateRecordData(tasks, {
      id: "t1",
      title: "x",
      done: true,
      effort: null,
      dueAt: "2026-08-01T00:00:00.000Z",
    }, "create");
    expect(ok.status).toBe("valid");

    const bad = validateRecordData(tasks, {
      id: "t1",
      title: null,
      done: true,
      dueAt: "2026-08-01T00:00:00.000Z",
    }, "create");
    expect(bad.status).toBe("invalid");
    if (bad.status === "invalid") {
      expect(bad.reason).toContain('"title"');
    }
  });

  it("rejects unknown fields with the declared list", () => {
    const result = validateRecordData(tasks, {
      id: "t1",
      title: "x",
      done: true,
      dueAt: "2026-08-01T00:00:00.000Z",
      bogus: 1,
    }, "create");
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.reason).toContain('"bogus"');
      expect(result.reason).toContain("title");
    }
  });

  it("requires every non-nullable field on create", () => {
    const result = validateRecordData(tasks, { id: "t1" }, "create");
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.reason).toContain('"title"');
      expect(result.reason).toContain('"done"');
      expect(result.reason).toContain('"dueAt"');
    }
  });

  it("rejects malformed scalars with the expected type", () => {
    const result = validateRecordData(tasks, {
      id: "t1",
      title: 42,
      done: true,
      dueAt: "not-a-date",
    }, "create");
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.reason).toContain('"title"');
      expect(result.reason).toContain('"dueAt"');
      expect(result.reason).toContain("ISO 8601");
    }
  });

  it("allows partial updates but never the primary key", () => {
    const ok = validateRecordData(tasks, { title: "renamed" }, "update");
    expect(ok.status).toBe("valid");

    const bad = validateRecordData(tasks, { id: "t2" }, "update");
    expect(bad.status).toBe("invalid");
    if (bad.status === "invalid") {
      expect(bad.reason).toContain("cannot be updated");
    }
  });
});

describe("validatePrimaryId", () => {
  it("accepts string ids for string primaries and numbers for number primaries", () => {
    expect(validatePrimaryId(tasks, "t1")).toEqual({ status: "valid", value: "t1" });
    expect(validatePrimaryId(logs, 7)).toEqual({ status: "valid", value: 7 });
    expect(validatePrimaryId(logs, "7")).toEqual({ status: "valid", value: 7 });
  });

  it("rejects mismatched or empty ids with guidance", () => {
    const numeric = validatePrimaryId(tasks, 7);
    expect(numeric.status).toBe("invalid");
    if (numeric.status === "invalid") {
      expect(numeric.reason).toContain("non-empty string");
    }
    const emptyString = validatePrimaryId(tasks, "");
    expect(emptyString.status).toBe("invalid");
  });
});

describe("validateWhereFilter", () => {
  it("accepts equality shorthand and operator objects", () => {
    const result = validateWhereFilter(tasks, {
      title: { like: "%test%" },
      effort: { gte: 2 },
      done: true,
    });
    expect(result.status).toBe("valid");
    if (result.status !== "valid") return;
    expect(result.value.title).toEqual({ like: "%test%" });
    expect(result.value.effort).toEqual({ gte: 2 });
    expect(result.value.done).toBe(true);
  });

  it("coerces dates inside filters", () => {
    const result = validateWhereFilter(tasks, { dueAt: { gt: "2026-01-01T00:00:00.000Z" } });
    expect(result.status).toBe("valid");
    if (result.status !== "valid") return;
    const filter = result.value.dueAt as { gt?: unknown };
    expect(filter.gt).toBeInstanceOf(Date);
  });

  it("rejects unknown fields, operators, and type-mismatched operators", () => {
    const unknownField = validateWhereFilter(tasks, { bogus: 1 });
    expect(unknownField.status).toBe("invalid");

    const unknownOperator = validateWhereFilter(tasks, { title: { contains: "x" } });
    expect(unknownOperator.status).toBe("invalid");
    if (unknownOperator.status === "invalid") {
      expect(unknownOperator.reason).toContain('"contains"');
    }

    const likeOnNumber = validateWhereFilter(tasks, { effort: { like: "2" } });
    expect(likeOnNumber.status).toBe("invalid");
    if (likeOnNumber.status === "invalid") {
      expect(likeOnNumber.reason).toContain("requires a string field");
    }

    const gtOnBoolean = validateWhereFilter(tasks, { done: { gt: true } });
    expect(gtOnBoolean.status).toBe("invalid");
  });

  it("requires non-empty arrays for set operators", () => {
    const result = validateWhereFilter(tasks, { effort: { in: [] } });
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.reason).toContain("non-empty array");
    }
  });
});

describe("validateOrderBy", () => {
  it("accepts asc/desc on declared fields and rejects anything else", () => {
    const ok = validateOrderBy(tasks, { title: "asc", dueAt: "desc" });
    expect(ok.status).toBe("valid");

    const unknownField = validateOrderBy(tasks, { bogus: "asc" });
    expect(unknownField.status).toBe("invalid");

    const badDirection = validateOrderBy(tasks, { title: "descending" });
    expect(badDirection.status).toBe("invalid");
  });
});

describe("serializeRecord", () => {
  it("renders dates as ISO strings and passes other scalars through", () => {
    const dueAt = new Date("2026-08-01T12:00:00.000Z");
    const serialized = serializeRecord(tasks, { id: "t1", done: false, effort: null, dueAt });
    expect(serialized).toEqual({
      id: "t1",
      done: false,
      effort: null,
      dueAt: "2026-08-01T12:00:00.000Z",
    });
  });
});
