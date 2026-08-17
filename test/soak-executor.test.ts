/**
 * Focused executor tests for the soak workload against a REAL local runtime.
 *
 * These tests drive `executeActorOperation` through the public EntityManager
 * on a temporary SQLite file and keep a SoakOracle in lockstep — the same
 * arrangement the runner uses. The regression block reproduces the original
 * soak failure sequence (forkIsolation creates a new row, then
 * transactionalRollback verifies a rollback) and asserts that oracle and
 * SQLite stay aligned and that rollback verification compares SQLite to
 * SQLite, never oracle to SQLite.
 *
 * Retry and redaction contracts are covered too: failed operations carry
 * stable redacted reason codes, never raw messages, ids, or values.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTypedSheets, defineTypedSheetsEntity } from "hikoutei";
import {
  executeActorOperation,
  EXPECTED_ERROR_CODES,
  FAILURE_REASON_CODES,
} from "../scripts/ci/local-soak/executor.mjs";
import { SoakOracle } from "../scripts/ci/local-soak/oracle.mjs";
import { SOAK_FIELD_PLANS } from "../scripts/ci/local-soak/entities.mjs";
import type { ExecutorContext } from "../scripts/ci/local-soak/executor.d.mts";

/** SoakTask token built from the PUBLIC factory (local source via alias). */
const SoakTask = defineTypedSheetsEntity({
  name: "SoakTask",
  tableName: "soak_tasks",
  properties: {
    id: { type: "string", primary: true },
    title: { type: "string" },
    priority: { type: "number" },
    done: { type: "boolean" },
    dueAt: { type: "date", nullable: true },
    tag: { type: "string", nullable: true },
  },
});

const FIELD_PLAN = SOAK_FIELD_PLANS.SoakTask!;

/** Base op with the fields every executor branch reads. */
function baseOp(kind: string, id: string) {
  return {
    kind,
    entityName: "SoakTask",
    actor: 0,
    opIndex: 0,
    cycle: 1,
    mutateId: id,
    updateTarget: id,
    deleteTarget: id,
    lookupId: id,
  };
}

/** Deterministic full row for one id (stable across the test). */
function rowFor(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `title-${id}`,
    priority: 5,
    done: false,
    dueAt: null,
    tag: "tag",
    ...overrides,
  };
}

type SoakRuntime = Awaited<ReturnType<typeof createTypedSheets>>;

describe("soak executor against a real runtime", () => {
  let runtime: SoakRuntime;
  let rootEm: ReturnType<SoakRuntime["em"]["fork"]>;
  let oracle: SoakOracle;
  let ctx: ExecutorContext;
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "soak-executor-"));
    runtime = await createTypedSheets({
      dbName: path.join(dir, "soak.sqlite"),
      entities: [SoakTask],
    });
    rootEm = runtime.em;
    oracle = new SoakOracle({ SoakTask: FIELD_PLAN });
    ctx = {
      em: rootEm.fork(),
      rootEm,
      oracle,
      tokenByEntity: new Map([["SoakTask", SoakTask]]),
      fieldPlans: { SoakTask: FIELD_PLAN },
    };
  });

  afterEach(async () => {
    await runtime.close();
    await rm(dir, { recursive: true, force: true });
  });

  const sqliteCount = async () => rootEm.fork().count(SoakTask, {});

  it("commits create/update/delete/batchPersist in lockstep with the oracle", async () => {
    const created = await executeActorOperation(
      { ...baseOp("create", "t-create"), row: rowFor("t-create") },
      ctx,
    );
    expect(created.status).toBe("ok");
    expect(await sqliteCount()).toBe(1);
    expect(oracle.size("SoakTask")).toBe(1);

    const updated = await executeActorOperation(
      { ...baseOp("update", "t-create"), patch: { priority: 9, done: true } },
      ctx,
    );
    expect(updated.status).toBe("ok");
    expect(oracle.row("SoakTask", "t-create")?.priority).toBe(9);

    const batch = await executeActorOperation(
      {
        ...baseOp("batchPersist", "t-batch"),
        row: rowFor("t-batch"),
        extraRows: [rowFor("t-batch-x0"), rowFor("t-batch-x1")],
      },
      ctx,
    );
    expect(batch.status).toBe("ok");
    expect(batch.counts).toEqual({ inserted: 3 });
    expect(await sqliteCount()).toBe(4);
    expect(oracle.size("SoakTask")).toBe(4);

    const removed = await executeActorOperation(
      { ...baseOp("delete", "t-batch") },
      ctx,
    );
    expect(removed.status).toBe("ok");
    expect(await sqliteCount()).toBe(3);
    expect(oracle.size("SoakTask")).toBe(3);

    // A delete of a missing row is a no-op success (deterministic state).
    const missing = await executeActorOperation(
      { ...baseOp("delete", "never-existed") },
      ctx,
    );
    expect(missing.status).toBe("ok");
    expect(missing.counts).toEqual({ skipped: 1 });
  });

  it("commits transactionalCommit and rolls back transactionalRollback fully", async () => {
    const committed = await executeActorOperation(
      {
        ...baseOp("transactionalCommit", "t-tx-commit"),
        row: rowFor("t-tx-commit"),
      },
      ctx,
    );
    expect(committed.status).toBe("ok");
    expect(committed.counts).toEqual({ committed: 1 });
    expect(await sqliteCount()).toBe(1);
    expect(oracle.size("SoakTask")).toBe(1);

    const rolled = await executeActorOperation(
      {
        ...baseOp("transactionalRollback", "t-tx-rollback"),
        row: rowFor("t-tx-rollback"),
      },
      ctx,
    );
    expect(rolled.status).toBe("ok");
    expect(rolled.counts).toEqual({ rolledBack: 1 });
    // Nothing leaked into SQLite and nothing entered the oracle.
    expect(await sqliteCount()).toBe(1);
    expect(oracle.size("SoakTask")).toBe(1);
    expect(await rootEm.fork().findOne(SoakTask, { id: "t-tx-rollback" })).toBeNull();
  });

  it("regression: forkIsolation followed by transactionalRollback stays aligned", async () => {
    // Original soak failure sequence: forkIsolation created a NEW row but the
    // oracle's replace skipped it, then transactionalRollback compared the
    // oracle count against the SQLite count and reported a false leak.
    const isolation = await executeActorOperation(
      {
        ...baseOp("forkIsolation", "t-isolated"),
        row: rowFor("t-isolated"),
        patch: { priority: 42 },
      },
      ctx,
    );
    expect(isolation.status).toBe("ok");
    expect(isolation.counts).toEqual({ isolated: 1 });
    expect(await sqliteCount()).toBe(1);
    expect(oracle.size("SoakTask")).toBe(1);
    expect(oracle.row("SoakTask", "t-isolated")?.priority).toBe(42);

    const rolled = await executeActorOperation(
      {
        ...baseOp("transactionalRollback", "t-rollback"),
        row: rowFor("t-rollback"),
      },
      ctx,
    );
    expect(rolled.status).toBe("ok");
    expect(await sqliteCount()).toBe(1);
    expect(oracle.size("SoakTask")).toBe(1);
  });

  it("expected_* ops assert the documented stable error codes", async () => {
    const invalidField = await executeActorOperation(
      { ...baseOp("expectedInvalidField", "t-invalid") },
      ctx,
    );
    expect(invalidField.status).toBe("expected_error");
    expect(invalidField.code).toBe(EXPECTED_ERROR_CODES.invalidField);

    const likeOnNumber = await executeActorOperation(
      { ...baseOp("expectedLikeOnNumber", "t-like") },
      ctx,
    );
    expect(likeOnNumber.status).toBe("expected_error");
    expect(likeOnNumber.code).toBe(EXPECTED_ERROR_CODES.invalidQuery);

    const unmanaged = await executeActorOperation(
      { ...baseOp("expectedUnmanagedPersist", "t-unmanaged") },
      ctx,
    );
    expect(unmanaged.status).toBe("expected_error");
    expect(unmanaged.code).toBe(EXPECTED_ERROR_CODES.unmanagedEntity);

    const negativeOffset = await executeActorOperation(
      { ...baseOp("expectedNegativeOffset", "t-neg") },
      ctx,
    );
    expect(negativeOffset.status).toBe("expected_error");
    expect(negativeOffset.code).toBe(EXPECTED_ERROR_CODES.invalidField);
  });

  it("verifies query ops (count/find/findOne/paging) against the oracle", async () => {
    // Seed two rows through the public API and the oracle together.
    const em = rootEm.fork();
    for (const id of ["t-a", "t-b"]) {
      const row = rowFor(id, { priority: id === "t-a" ? 1 : 2 });
      em.persist(em.create(SoakTask, row));
      await em.flush();
      oracle.applyMutation({ op: "insert", entity: "SoakTask", row });
    }

    const counted = await executeActorOperation(
      { ...baseOp("count", "t-count"), filter: { priority: { gte: 2 } } },
      ctx,
    );
    expect(counted.status).toBe("ok");
    expect(counted.counts).toEqual({ count: 1 });

    const filtered = await executeActorOperation(
      { ...baseOp("findFiltered", "t-filter"), filter: { done: { eq: false } } },
      ctx,
    );
    expect(filtered.status).toBe("ok");
    expect(filtered.counts).toEqual({ matched: 2 });

    const paged = await executeActorOperation(
      {
        ...baseOp("findPaged", "t-page"),
        filter: {},
        orderBy: { priority: "asc", id: "asc" },
        limit: 1,
        offset: 1,
      },
      ctx,
    );
    expect(paged.status).toBe("ok");
    expect(paged.counts).toEqual({ matched: 1 });

    const one = await executeActorOperation(
      { ...baseOp("findOne", "t-a"), lookupId: "t-a" },
      ctx,
    );
    expect(one.status).toBe("ok");
    expect(one.counts).toEqual({ found: 1 });

    const findAndCount = await executeActorOperation(
      { ...baseOp("findAndCount", "t-fac"), filter: {} },
      ctx,
    );
    expect(findAndCount.status).toBe("ok");
    expect(findAndCount.counts).toEqual({ count: 2 });

    const limitZero = await executeActorOperation(
      { ...baseOp("limitZero", "t-lz") },
      ctx,
    );
    expect(limitZero.status).toBe("ok");

    const offsetOnly = await executeActorOperation(
      { ...baseOp("offsetOnly", "t-oo") },
      ctx,
    );
    expect(offsetOnly.status).toBe("ok");

    const outOfRange = await executeActorOperation(
      { ...baseOp("offsetOutOfRange", "t-oor") },
      ctx,
    );
    expect(outOfRange.status).toBe("ok");

    const noOp = await executeActorOperation(
      { ...baseOp("noOpFlush", "t-nop") },
      ctx,
    );
    expect(noOp.status).toBe("ok");
  });

  it("reports failed operations with a stable redacted reason, never a message", async () => {
    // Deliberately desync the oracle (phantom row) so findOne fails: the
    // executor must report presence-mismatch and never the raw message.
    oracle.applyMutation({
      op: "insert",
      entity: "SoakTask",
      row: rowFor("phantom"),
    });
    const failed = await executeActorOperation(
      { ...baseOp("findOne", "phantom"), lookupId: "phantom" },
      ctx,
    );
    expect(failed.status).toBe("failed");
    expect(failed.reason).toBe(FAILURE_REASON_CODES.PRESENCE_MISMATCH);
    expect(failed.code).toBeUndefined();
    expect(JSON.stringify(failed)).not.toContain("phantom");
    expect(JSON.stringify(failed)).not.toContain("presence mismatch");

    // An unexpected library throw is categorized as unexpected-throw and
    // still carries the stable HikouteiError code when one exists (empty
    // orderBy is rejected by the public query normalizer).
    const unexpected = await executeActorOperation(
      {
        ...baseOp("findPaged", "t-broken"),
        filter: {},
        orderBy: {},
        limit: 1,
        offset: 0,
      },
      ctx,
    );
    expect(unexpected.status).toBe("failed");
    expect(unexpected.reason).toBe(FAILURE_REASON_CODES.UNEXPECTED_THROW);
    expect(unexpected.code).toBe(EXPECTED_ERROR_CODES.invalidQuery);
    expect(JSON.stringify(unexpected)).not.toMatch(/soak-intentional-rollback|rollback leaked/);
  });

  it("runner-style retry loop counts retries and honors bounded attempts", async () => {
    // Force a deterministic failure (oracle phantom) and replay the runner's
    // retry loop: 3 attempts, 2 retries, final record failed with a stable
    // reason. Then repair the oracle and show the same op succeeds.
    oracle.applyMutation({
      op: "insert",
      entity: "SoakTask",
      row: rowFor("phantom"),
    });
    const op = { ...baseOp("findOne", "phantom"), lookupId: "phantom" };
    const attempts = 3;
    let retries = 0;
    let result: Awaited<ReturnType<typeof executeActorOperation>> | undefined;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (attempt > 0) retries += 1;
      result = await executeActorOperation(op, ctx);
      if (result.status !== "failed") break;
    }
    expect(retries).toBe(2);
    expect(result!.status).toBe("failed");
    expect(result!.reason).toBe(FAILURE_REASON_CODES.PRESENCE_MISMATCH);

    oracle.applyMutation({ op: "delete", entity: "SoakTask", id: "phantom" });
    const recovered = await executeActorOperation(op, ctx);
    expect(recovered.status).toBe("ok");
  });

  it("never records raw ids, values, or messages in any result payload", async () => {
    const results = [];
    results.push(await executeActorOperation(
      { ...baseOp("create", "t-secret-id"), row: rowFor("t-secret-id", { title: "amber-7777" }) },
      ctx,
    ));
    results.push(await executeActorOperation(
      { ...baseOp("transactionalRollback", "t-secret-rb"), row: rowFor("t-secret-rb") },
      ctx,
    ));
    results.push(await executeActorOperation(
      { ...baseOp("forkIsolation", "t-secret-iso"), row: rowFor("t-secret-iso"), patch: { title: "zephyr-4242" } },
      ctx,
    ));
    const serialized = JSON.stringify(results);
    expect(serialized).not.toContain("t-secret");
    expect(serialized).not.toContain("amber-7777");
    expect(serialized).not.toContain("zephyr-4242");
    expect(serialized).not.toContain("soak-intentional-rollback");
    for (const result of results) {
      expect(result.status).toBe("ok");
      for (const key of Object.keys(result)) {
        expect(["status", "code", "reason", "counts", "durationMs"]).toContain(key);
      }
    }
  });

  it("maps arbitrary token/email/URL/path-like error codes to the fixed unknown category", async () => {
    // An unvalidated error.code is free text: it could be a JWT, email,
    // URL, or path. Only allowlisted stable codes may pass through; every
    // other value becomes the fixed `unknown` category.
    const secretCodes = [
      "ya29.jwt-abcdefghijklmnop",
      "service@project.iam.gserviceaccount.com",
      "https://docs.google.com/spreadsheets/d/1AbC",
      "/Users/me/.config/gcloud/application_default_credentials.json",
    ];
    for (const secretCode of secretCodes) {
      const brokenCtx = {
        ...ctx,
        em: {
          ...ctx.em,
          count: async () => {
            throw Object.assign(new Error("boom"), { code: secretCode });
          },
        },
      };
      const result = await executeActorOperation(
        { ...baseOp("count", "t-token"), filter: {} },
        brokenCtx,
      );
      expect(result.status).toBe("failed");
      expect(result.reason).toBe(FAILURE_REASON_CODES.UNEXPECTED_THROW);
      expect(result.code).toBe("unknown");
      expect(JSON.stringify(result)).not.toContain(secretCode);
      expect(JSON.stringify(result)).not.toContain("boom");
    }

    // Allowlisted stable codes still pass through unchanged.
    const allowlistedCtx = {
      ...ctx,
      em: {
        ...ctx.em,
        count: async () => {
          throw Object.assign(new Error("boom"), {
            code: EXPECTED_ERROR_CODES.invalidQuery,
          });
        },
      },
    };
    const result = await executeActorOperation(
      { ...baseOp("count", "t-ok-code"), filter: {} },
      allowlistedCtx,
    );
    expect(result.status).toBe("failed");
    expect(result.code).toBe(EXPECTED_ERROR_CODES.invalidQuery);
  });

  it("sanitizeStableCode maps unknown values and passes allowlisted codes", async () => {
    const { sanitizeStableCode } = await import("../scripts/ci/local-soak/executor.mjs");
    expect(sanitizeStableCode(EXPECTED_ERROR_CODES.invalidField)).toBe(
      EXPECTED_ERROR_CODES.invalidField,
    );
    expect(sanitizeStableCode("ya29.jwt-token")).toBe("unknown");
    expect(sanitizeStableCode("user@example.com")).toBe("unknown");
    expect(sanitizeStableCode("https://secret.example/x")).toBe("unknown");
    expect(sanitizeStableCode("/etc/secret.json")).toBe("unknown");
    expect(sanitizeStableCode(undefined)).toBe("unknown");
    expect(sanitizeStableCode(42)).toBe("unknown");
  });

  describe("replay reconciliation of an interrupted cycle", () => {
    it("create accepts an already-committed deterministic row instead of duplicating", async () => {
      const op = { ...baseOp("create", "rec-create"), row: rowFor("rec-create") };
      const first = await executeActorOperation(op, { ...ctx, reconcile: true });
      expect(first.status).toBe("ok");
      expect(await sqliteCount()).toBe(1);

      // Replay: the same deterministic create reconciles — no duplicate row,
      // no failure, and the oracle stays in lockstep.
      const replay = await executeActorOperation(op, { ...ctx, reconcile: true });
      expect(replay.status).toBe("ok");
      expect(replay.counts).toEqual({ reconciled: 1 });
      expect(await sqliteCount()).toBe(1);
      expect(oracle.size("SoakTask")).toBe(1);
    });

    it("create fails with reconcile-mismatch when the existing row diverges", async () => {
      const op = { ...baseOp("create", "rec-diverged"), row: rowFor("rec-diverged") };
      await executeActorOperation(op, { ...ctx, reconcile: true });

      // Simulate a REAL divergence committed by the interrupted run: the row
      // exists with content the deterministic plan would never produce.
      const loaded = await ctx.em.findOne(SoakTask, { id: "rec-diverged" }) as
        { id: string; title: string } | null;
      if (loaded === null) {
        throw new Error("reconcile fixture row must exist");
      }
      loaded.title = "changed-by-something-real";
      await ctx.em.persist(loaded);
      await ctx.em.flush();
      oracle.applyMutation({
        op: "update",
        entity: "SoakTask",
        id: "rec-diverged",
        patch: { title: "changed-by-something-real" },
      });

      const replay = await executeActorOperation(op, { ...ctx, reconcile: true });
      expect(replay.status).toBe("failed");
      expect(replay.reason).toBe("reconcile-mismatch");
      expect(await sqliteCount()).toBe(1); // never duplicated, never overwritten
    });

    it("batchPersist inserts only the missing rows on replay", async () => {
      const op = {
        ...baseOp("batchPersist", "rec-batch"),
        row: rowFor("rec-batch"),
        extraRows: [rowFor("rec-batch-x0"), rowFor("rec-batch-x1")],
      };
      const first = await executeActorOperation(op, { ...ctx, reconcile: true });
      expect(first.counts).toEqual({ inserted: 3, reconciled: 0 });

      const replay = await executeActorOperation(op, { ...ctx, reconcile: true });
      expect(replay.status).toBe("ok");
      expect(replay.counts).toEqual({ inserted: 0, reconciled: 3 });
      expect(await sqliteCount()).toBe(3);
      expect(oracle.size("SoakTask")).toBe(3);
    });

    it("transactionalCommit reconciles an already-committed row", async () => {
      const op = {
        ...baseOp("transactionalCommit", "rec-tx"),
        row: rowFor("rec-tx"),
      };
      await executeActorOperation(op, { ...ctx, reconcile: true });
      const replay = await executeActorOperation(op, { ...ctx, reconcile: true });
      expect(replay.status).toBe("ok");
      expect(replay.counts).toEqual({ reconciled: 1 });
      expect(await sqliteCount()).toBe(1);
    });

    it("forkIsolation replay accepts an already-committed post-patch row", async () => {
      const op = {
        ...baseOp("forkIsolation", "rec-fork"),
        row: rowFor("rec-fork"),
        patch: { priority: 42 },
      };
      const first = await executeActorOperation(op, { ...ctx, reconcile: true });
      expect(first.status).toBe("ok");
      expect(first.counts).toEqual({ isolated: 1 });

      // Replay against the post-patch committed row: accepted, patch
      // re-applied idempotently, fresh fork verification still passes.
      const replay = await executeActorOperation(op, { ...ctx, reconcile: true });
      expect(replay.status).toBe("ok");
      expect(replay.counts).toEqual({ isolated: 1, reconciled: 1 });
      expect(await sqliteCount()).toBe(1);
      expect(oracle.row("SoakTask", "rec-fork")?.priority).toBe(42);
    });

    it("forkIsolation recovers a pre-patch committed row (interrupted between the two flushes)", async () => {
      const op = {
        ...baseOp("forkIsolation", "rec-fork-pre"),
        row: rowFor("rec-fork-pre"),
        patch: { priority: 42 },
      };
      // Interruption between the two flushes: the first flush committed the
      // pre-patch row and the patch flush never ran. On resume the runner
      // rebuilds the oracle from SQLite (the authority), so mirror exactly
      // that committed stage: replay must accept this deterministic stage
      // (never arbitrary content) and complete the second stage idempotently.
      const interrupted = rootEm.fork();
      interrupted.persist(
        interrupted.create(SoakTask, rowFor("rec-fork-pre")),
      );
      await interrupted.flush();
      oracle.applyMutation({
        op: "replace",
        entity: "SoakTask",
        id: "rec-fork-pre",
        row: rowFor("rec-fork-pre"),
      });

      const replay = await executeActorOperation(op, { ...ctx, reconcile: true });
      expect(replay.status).toBe("ok");
      expect(replay.counts).toEqual({ isolated: 1, reconciled: 1 });
      expect(await sqliteCount()).toBe(1); // never duplicated
      // The patch flush completes the two-stage operation and the oracle
      // converges to the deterministic post-patch row.
      expect(oracle.row("SoakTask", "rec-fork-pre")?.priority).toBe(42);
      const converged = await rootEm.fork().findOne(SoakTask, { id: "rec-fork-pre" });
      expect(converged?.priority).toBe(42);
    });

    it("forkIsolation rejects a committed row that matches neither deterministic stage", async () => {
      const op = {
        ...baseOp("forkIsolation", "rec-fork-arbitrary"),
        row: rowFor("rec-fork-arbitrary"),
        patch: { priority: 42 },
      };
      // A committed row whose content matches NEITHER the pre-patch nor the
      // post-patch deterministic shape is never accepted as recovered: it is
      // a real divergence and must fail reconciliation without touching the
      // authority.
      const interrupted = rootEm.fork();
      interrupted.persist(
        interrupted.create(SoakTask, rowFor("rec-fork-arbitrary", { priority: 7, title: "arbitrary" })),
      );
      await interrupted.flush();
      oracle.applyMutation({
        op: "replace",
        entity: "SoakTask",
        id: "rec-fork-arbitrary",
        row: rowFor("rec-fork-arbitrary", { priority: 7, title: "arbitrary" }),
      });

      const replay = await executeActorOperation(op, { ...ctx, reconcile: true });
      expect(replay.status).toBe("failed");
      expect(replay.reason).toBe("reconcile-mismatch");
      expect(await sqliteCount()).toBe(1); // never duplicated, never overwritten
      expect(oracle.row("SoakTask", "rec-fork-arbitrary")?.priority).toBe(7);
    });

    it("update and delete remain idempotent on replay without reconcile flags", async () => {
      const created = await executeActorOperation(
        { ...baseOp("create", "rec-idem"), row: rowFor("rec-idem") },
        ctx,
      );
      expect(created.status).toBe("ok");

      // The interrupted run already applied the patch; replaying it converges.
      const updated = await executeActorOperation(
        { ...baseOp("update", "rec-idem"), patch: { title: "patched" } },
        { ...ctx, reconcile: true },
      );
      expect(updated.status).toBe("ok");
      const replayUpdate = await executeActorOperation(
        { ...baseOp("update", "rec-idem"), patch: { title: "patched" } },
        { ...ctx, reconcile: true },
      );
      expect(replayUpdate.status).toBe("ok");

      // Delete of an already-deleted row is a skipped no-op (never a failure).
      const removed = await executeActorOperation(
        { ...baseOp("delete", "rec-idem") },
        { ...ctx, reconcile: true },
      );
      expect(removed.status).toBe("ok");
      const replayDelete = await executeActorOperation(
        { ...baseOp("delete", "rec-idem") },
        { ...ctx, reconcile: true },
      );
      expect(replayDelete.status).toBe("ok");
      expect(replayDelete.counts).toEqual({ skipped: 1 });
      expect(await sqliteCount()).toBe(0);
    });
  });
});

