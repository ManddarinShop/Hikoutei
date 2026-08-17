/**
 * Focused tests for the soak in-memory oracle.
 *
 * The oracle mirrors the public EntityManager query semantics; these tests
 * pin the mutation semantics (including the replace upsert that keeps the
 * oracle aligned with SQLite when forkIsolation creates new rows) and the
 * query operators, ordering, null handling, and paging behavior.
 */

import { describe, expect, it } from "vitest";
import {
  SoakOracle,
  sqlLikeMatch,
} from "../scripts/ci/local-soak/oracle.mjs";
import type { OracleFieldSpec, OracleMutation } from "../scripts/ci/local-soak/oracle.d.mts";

/** Two-table field plan exercising every scalar type. */
const FIELD_PLANS: Record<string, Record<string, OracleFieldSpec>> = {
  SoakTask: {
    id: { type: "string", primary: true },
    title: { type: "string" },
    priority: { type: "number" },
    done: { type: "boolean" },
    dueAt: { type: "date", nullable: true },
    tag: { type: "string", nullable: true },
  },
  SoakCustomer: {
    id: { type: "string", primary: true },
    tier: { type: "string" },
    active: { type: "boolean" },
  },
};

function seededOracle() {
  const oracle = new SoakOracle(FIELD_PLANS);
  oracle.applyMutation({
    op: "insert",
    entity: "SoakTask",
    row: { id: "t-1", title: "alpha", priority: 10, done: false, dueAt: null, tag: null },
  });
  oracle.applyMutation({
    op: "insert",
    entity: "SoakTask",
    row: { id: "t-2", title: "beta", priority: 20, done: true, dueAt: new Date("2024-06-01T00:00:00Z"), tag: "x" },
  });
  oracle.applyMutation({
    op: "insert",
    entity: "SoakTask",
    row: { id: "t-3", title: "gamma", priority: 30, done: false, dueAt: null, tag: "y" },
  });
  return oracle;
}

describe("soak oracle: mutation semantics", () => {
  it("tracks insert/update/delete with string-key identity", () => {
    const oracle = seededOracle();
    expect(oracle.size("SoakTask")).toBe(3);

    oracle.applyMutation({
      op: "update",
      entity: "SoakTask",
      id: "t-2",
      patch: { priority: 21 },
    });
    expect(oracle.row("SoakTask", "t-2")?.priority).toBe(21);

    oracle.applyMutation({ op: "delete", entity: "SoakTask", id: "t-3" });
    expect(oracle.size("SoakTask")).toBe(2);
    expect(oracle.row("SoakTask", "t-3")).toBeUndefined();
  });

  it("rejects duplicate inserts (deterministic failure, never silent)", () => {
    const oracle = seededOracle();
    expect(() => oracle.applyMutation({
      op: "insert",
      entity: "SoakTask",
      row: { id: "t-1", title: "dup" },
    })).toThrow(/duplicate insert/);
  });

  it("replace upserts: inserts a brand-new id instead of skipping it", () => {
    // Regression: forkIsolation creates a NEW row and records it as
    // `replace`; a skip-on-missing implementation desyncs the oracle from
    // SQLite by exactly these rows (the original soak count mismatch).
    const oracle = seededOracle();
    const changed = oracle.applyMutation({
      op: "replace",
      entity: "SoakTask",
      id: "t-new",
      row: { id: "t-new", title: "iso", priority: 5, done: false, dueAt: null, tag: null },
    });
    expect(changed).toBe(true);
    expect(oracle.size("SoakTask")).toBe(4);
    expect(oracle.row("SoakTask", "t-new")?.title).toBe("iso");

    // Replacing an existing id still overwrites the full row.
    oracle.applyMutation({
      op: "replace",
      entity: "SoakTask",
      id: "t-1",
      row: { id: "t-1", title: "alpha2", priority: 11, done: true, dueAt: null, tag: null },
    });
    expect(oracle.row("SoakTask", "t-1")?.title).toBe("alpha2");
  });

  it("rejects unknown entities and mutations loudly", () => {
    const oracle = seededOracle();
    expect(() => oracle.size("SoakGhost")).toThrow(/unknown oracle entity/);
    expect(() => oracle.applyMutation({ op: "nope", entity: "SoakTask" } as never)).toThrow(
      /unknown oracle mutation/,
    );
  });
});

describe("soak oracle: query semantics", () => {
  it("applies equality, inequality, ordered, and in/nin operators", () => {
    const oracle = seededOracle();
    expect(oracle.query("SoakTask", { where: { priority: { gt: 15 } } }).total).toBe(2);
    expect(oracle.query("SoakTask", { where: { priority: { lte: 20 } } }).total).toBe(2);
    expect(oracle.query("SoakTask", { where: { done: { eq: true } } }).total).toBe(1);
    expect(oracle.query("SoakTask", { where: { title: { ne: "alpha" } } }).total).toBe(2);
    expect(oracle.query("SoakTask", { where: { title: { in: ["alpha", "gamma"] } } }).total).toBe(2);
    expect(oracle.query("SoakTask", { where: { priority: { nin: [10] } } }).total).toBe(2);
  });

  it("mirrors the normalizer null semantics on nullable fields", () => {
    const oracle = seededOracle();
    // eq:null matches only rows whose value is null.
    expect(oracle.query("SoakTask", { where: { tag: { eq: null } } }).total).toBe(1);
    // ne on a nullable field passes null rows.
    expect(oracle.query("SoakTask", { where: { tag: { ne: "x" } } }).total).toBe(2);
    // ordered operators exclude null rows.
    expect(oracle.query("SoakTask", { where: { dueAt: { gte: new Date("2024-01-01T00:00:00Z") } } }).total).toBe(1);
    // nin passes null rows on nullable fields.
    expect(oracle.query("SoakTask", { where: { tag: { nin: ["x"] } } }).total).toBe(2);
  });

  it("mirrors the normalizer is_not_null semantics for null operands", () => {
    const oracle = seededOracle();
    // Regression: ne:null and nin containing null map to is_not_null in the
    // normalizer, so null rows must be EXCLUDED even on nullable fields
    // (only non-null operands keep the null-passing widening). The soak
    // runner hit a findAndCount mismatch at cycle 100 when the generator
    // anchored a filter to a live row whose tag was null.
    // ne:null matches only rows whose value is not null.
    expect(oracle.query("SoakTask", { where: { tag: { ne: null } } }).ids).toEqual(["t-2", "t-3"]);
    // nin containing null also excludes null rows (is_not_null AND nin-set).
    expect(oracle.query("SoakTask", { where: { tag: { nin: [null] } } }).ids).toEqual(["t-2", "t-3"]);
    expect(oracle.query("SoakTask", { where: { tag: { nin: [null, "x"] } } }).ids).toEqual(["t-3"]);
    // in containing null still accepts null rows (is_null OR in-set).
    expect(oracle.query("SoakTask", { where: { tag: { in: [null, "y"] } } }).ids).toEqual(["t-1", "t-3"]);
    // Multi-field conjunction stays a plain AND of both predicates.
    expect(oracle.query("SoakTask", {
      where: { tag: { ne: null }, title: { eq: "beta" } },
    }).ids).toEqual(["t-2"]);
  });

  it("evaluates string-only like with SQLite wildcard semantics", () => {
    const oracle = seededOracle();
    expect(oracle.query("SoakTask", { where: { title: { like: "%ph%" } } }).total).toBe(1);
    expect(oracle.query("SoakTask", { where: { title: { like: "a%" } } }).total).toBe(1);
    expect(oracle.query("SoakTask", { where: { title: { like: "_eta" } } }).total).toBe(1);
    expect(sqlLikeMatch("Alpha", "a%")).toBe(true);
    expect(sqlLikeMatch("alpha", "A%")).toBe(true);
    expect(sqlLikeMatch("alpha", "a_pha")).toBe(true);
    expect(sqlLikeMatch("alpha", "b%")).toBe(false);
  });

  it("orders by the requested fields with the primary-key tiebreaker", () => {
    const oracle = seededOracle();
    const asc = oracle.query("SoakTask", { orderBy: { priority: "asc" } });
    expect(asc.ids).toEqual(["t-1", "t-2", "t-3"]);
    const desc = oracle.query("SoakTask", { orderBy: { priority: "desc" } });
    expect(desc.ids).toEqual(["t-3", "t-2", "t-1"]);
    const pkOnly = oracle.query("SoakTask", { orderBy: { id: "desc" } });
    expect(pkOnly.ids).toEqual(["t-3", "t-2", "t-1"]);
  });

  it("applies limit/offset paging with limit 0 and out-of-range offsets", () => {
    const oracle = seededOracle();
    expect(oracle.query("SoakTask", { limit: 0 }).ids).toEqual([]);
    expect(oracle.query("SoakTask", { limit: 2, offset: 1 }).ids).toEqual(["t-2", "t-3"]);
    expect(oracle.query("SoakTask", { offset: 50 }).ids).toEqual([]);
    // total is the pre-paging count.
    expect(oracle.query("SoakTask", { limit: 1 }).total).toBe(3);
  });

  it("rejects unknown filter fields and empty orderBy", () => {
    const oracle = seededOracle();
    expect(() => oracle.query("SoakTask", { where: { ghost: 1 } })).toThrow(/unknown filter field/);
    expect(() => oracle.query("SoakTask", { orderBy: {} })).toThrow(/orderBy must not be empty/);
  });
});
