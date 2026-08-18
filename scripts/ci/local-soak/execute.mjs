/**
 * Soak cycle execution: prologue, forked actors, verification, reopen.
 * Depends on database/probe/resume plus the leaf modules.
 */
import { performance } from "node:perf_hooks";
import process from "node:process";
import { operationRecord } from "./artifacts.mjs";
import {
  OPERATION_ATTEMPTS,
  PROBE_EVERY_CYCLES,
  REOPEN_EVERY_CYCLES,
  SoakDeadlineExpiredError,
  SoakReopenCleanupError,
  SoakSimulatedInterruptionError,
} from "./constants.mjs";
import {
  delayOpenPastDeadline,
  openRuntime,
  openRuntimeWithinDeadline,
} from "./database.mjs";
import { SOAK_FIELD_PLANS } from "./entities.mjs";
import { describeError } from "./errors.mjs";
import {
  executeActorOperation,
  FAILURE_REASON_CODES,
  rowValuesEqual,
  SoakAssertionError,
} from "./executor.mjs";
import {
  generatePatch,
  generateRow,
  planActorOperation,
  sharedEntityId,
} from "./operations.mjs";
import { SeededRandom, deriveSeed } from "./prng.mjs";
import { checkSheetsConvergence, runHumanEditProbe } from "./probe.mjs";
import {
  sanitizeErrorClass,
  sanitizeReason,
  sanitizeStableCode,
} from "./redact.mjs";
import { recordOperationIfAbsent } from "./resume.mjs";
import { sleep } from "./timing.mjs";

/**
 * Executes one full soak cycle and returns its redacted summary.
 *
 * The actor stream is planned UP FRONT, sequentially, against the
 * deterministic post-prologue oracle state; execution then runs the forked
 * actors concurrently but serializes every oracle-touching operation
 * through one mutex so verification always sees the committed state.
 */
async function runOneCycle(context) {
  const { cycle, oracle, tokenByEntity, activeEntities, seed, options, live, artifacts, recording, progress } =
    context;
  const cycleStart = performance.now();
  const tablesTouched = new Set();
  let operations = 0;
  let expectedErrors = 0;
  let failures = 0;
  let retries = 0;
  const rootEm = context.hikoutei.em;
  const reconcile = context.reconcile === true;

  if (context.failOnCycle === cycle) {
    throw new Error("soak-test-injected-cycle-failure");
  }

  // Sequential deterministic prologue: every table gets one create, one
  // update, and one delete per cycle (churn row created and deleted inside
  // the cycle, main row accumulates updates across cycles). On REPLAY
  // (resume of an interrupted cycle) the prologue is idempotent: rows the
  // interrupted run already committed are accepted when their content
  // matches the deterministic expectation (pre- or post-patch for the main
  // row), and a content mismatch is a real failure, never a silent
  // overwrite. The PRNG consumption order is identical in both paths so
  // the generated rows and patch are exactly the same values.
  const prologueEm = rootEm.fork();
  for (let tableIndex = 0; tableIndex < activeEntities.length; tableIndex += 1) {
    const entry = activeEntities[tableIndex];
    const token = tokenByEntity.get(entry.name);
    const fieldPlan = SOAK_FIELD_PLANS[entry.name];
    const rng = new SeededRandom(deriveSeed(seed, cycle * 7919 + tableIndex));
    const mainId = sharedEntityId(entry.name, cycle, "main");
    const churnId = sharedEntityId(entry.name, cycle, "churn");
    const mainRow = { id: mainId, ...generateRow(rng, fieldPlan) };
    const churnRow = { id: churnId, ...generateRow(rng, fieldPlan) };
    const patch = generatePatch(rng, fieldPlan);
    const inserts = [];
    if (reconcile) {
      const mainInsert = resolvePrologueInsert({
        oracle,
        entityName: entry.name,
        id: mainId,
        row: mainRow,
        fieldPlan,
        postPatchRow: { ...mainRow, ...patch },
      });
      const churnInsert = resolvePrologueInsert({
        oracle,
        entityName: entry.name,
        id: churnId,
        row: churnRow,
        fieldPlan,
      });
      if (mainInsert !== undefined) inserts.push(mainInsert);
      if (churnInsert !== undefined) inserts.push(churnInsert);
    } else {
      inserts.push(mainRow, churnRow);
    }
    for (const row of inserts) {
      prologueEm.persist(prologueEm.create(token, row));
    }
    await prologueEm.flush();
    for (const row of inserts) {
      oracle.applyMutation({ op: "insert", entity: entry.name, row });
    }
    operations += 2;

    const main = await prologueEm.findOne(token, { id: mainId });
    Object.assign(main, patch);
    await prologueEm.flush();
    oracle.applyMutation({ op: "update", entity: entry.name, id: mainId, patch });
    operations += 1;

    const churn = await prologueEm.findOne(token, { id: churnId });
    prologueEm.remove(churn);
    await prologueEm.flush();
    oracle.applyMutation({ op: "delete", entity: entry.name, id: churnId });
    operations += 1;
    tablesTouched.add(entry.tableName);
  }

  // Test-only simulated process interruption: the cycle's deterministic
  // prologue SQLite work has FULLY committed, but nothing else will ever
  // land (no cycle record, no state advance, no completed marker). The
  // sentinel escapes runOneCycle without becoming an abort record; resume
  // later re-runs this cycle with reconciliation (INTERRUPTED_CYCLE_
  // RECONCILED), which accepts the already-committed deterministic rows.
  if (context.interruptOnCycle === cycle) {
    throw new SoakSimulatedInterruptionError();
  }

  // Sequential planning pass: every actor op is planned against the oracle
  // state that exists NOW (after the prologue), which is itself a pure
  // function of (seed, cycle). Planning never observes concurrent actors,
  // so the same seed reproduces the same operation stream bit-for-bit.
  //
  // HIGH 2: on REPLAY of an interrupted cycle, the actor stream is taken
  // from the PURE deterministic replay (a function of the stored
  // seed/params alone) instead of being re-planned against the
  // SQLite-rebuilt oracle — partial rows committed by the interrupted run
  // can never change the operation kinds, ids, filters, or rows the
  // recovery expects and re-executes.
  const actorPlans = [];
  if (context.reconcile === true && context.replayCycleOps !== undefined) {
    const replayed = context.replayCycleOps.get(cycle) ?? [];
    for (let actorIndex = 0; actorIndex < options.actors; actorIndex += 1) {
      const start = actorIndex * options.operationsPerActor;
      actorPlans.push(replayed.slice(start, start + options.operationsPerActor));
    }
  } else {
    for (let actorIndex = 0; actorIndex < options.actors; actorIndex += 1) {
      const plan = [];
      for (let opIndex = 0; opIndex < options.operationsPerActor; opIndex += 1) {
        const entry = activeEntities[
          (actorIndex * options.operationsPerActor + opIndex) % activeEntities.length
        ];
        plan.push(planActorOperation({
          seed,
          cycle,
          actor: actorIndex,
          opIndex,
          entityName: entry.name,
          fieldPlan: SOAK_FIELD_PLANS[entry.name],
          oracle,
        }));
      }
      actorPlans.push(plan);
    }
  }

  // One mutex serializes the oracle-touching sections of concurrent actors:
  // each flush+oracle-apply and each verify pair runs atomically, so a query
  // is always compared to the oracle state committed at the same instant.
  const oracleLock = createAsyncMutex();
  const actorSummaries = await Promise.all(
    actorPlans.map((plan, actorIndex) =>
      runActor({ ...context, actorIndex, plan, oracleLock, rootEm, tablesTouched, counters: {
        operations: 0, expectedErrors: 0, failures: 0, retries: 0,
      } })),
  );
  for (const actor of actorSummaries) {
    operations += actor.counters.operations;
    expectedErrors += actor.counters.expectedErrors;
    failures += actor.counters.failures;
    retries += actor.counters.retries;
    // Op records are appended in actor order so the JSONL stream is
    // reproducible from (seed, cycle) alone; per-op timestamps stay
    // wall-clock but every other field is deterministic. On replay the
    // identity (cycle, actor, index) dedupes records the interrupted run
    // already wrote, so a repeated resume can never duplicate history.
    for (const record of actor.records) {
      await recordOperationIfAbsent(recording, artifacts, record);
    }
  }

  // Verification phase: sampled oracle comparisons per table.
  const verification = await verifyAgainstOracle(context);
  failures += verification.failures;

  // Periodic probes.
  let probe;
  let appliedProbe;
  if (cycle % PROBE_EVERY_CYCLES === 0) {
    const probeResult = await runHumanEditProbe(context, tablesTouched);
    probe = probeResult.record;
    appliedProbe = probeResult.applied;
    if (probe.status === "failed") failures += 1;
  }

  // Live convergence + invariants (duplicate/lost/extra/silent-overwrite).
  let convergence;
  if (live.mode === "live") {
    convergence = await checkSheetsConvergence(context, appliedProbe);
    if (convergence.status === "failed") failures += 1;
  }

  // Every 60th cycle: full scan + close/reopen. The old runtime closes
  // BEFORE the replacement opens — the safe handoff for live mode, where
  // each runtime's sync auto-start claims writer leases under a fresh
  // random writer id and a replacement opened first would fail with
  // WRITER_LEASE_UNAVAILABLE. Ownership is tracked so exactly one runtime
  // is current at any instant: any failure after the old close wraps into
  // SoakReopenCleanupError (the runner records the abort and stops) and a
  // failure before the close keeps the old runtime owned by the runner,
  // closed exactly once by its own finally. A replacement that opened
  // before the handoff failed stays attached to the error and is closed
  // by the runner's finalizer with a final retry — never leaked
  // silently. Only after the swap is proven does ownership transfer to
  // the replacement.
  let reopened = false;
  let reopenedRuntime = context.hikoutei;
  let reopen;
  if (cycle % REOPEN_EVERY_CYCLES === 0) {
    let replacement;
    let closeAttempted = false;
    try {
      if (context.swapRowOnReopenCycle === cycle) {
        // Test-only injection: a SAME-COUNT authority mutation (one row
        // removed, one foreign-id row added through the public API) so the
        // full-scan compare below fails on row identity while the
        // post-reopen table counts stay unchanged — the exact same-count
        // full-scan failure the reopen status must reflect.
        await swapOneRowForForeignId(context);
      }
      const scan = await fullScanCompare(context);
      failures += scan.failures;
      // Release the old runtime's leases and SQLite handle before the
      // replacement claims them. Hikoutei close() is retryable: a throwing
      // close leaves the runtime open and rethrows, so the reopen handoff
      // still fails here (the runner records a cleanup failure below).
      closeAttempted = true;
      await context.hikoutei.close();
      // The replacement open is deadline-gated too: a sync startup that
      // returns after the budget expired is closed immediately and fails
      // with the stable deadline_expired class (wrapped below into the
      // reopen cleanup abort so the run stops, never continues late).
      replacement = await openRuntimeWithinDeadline(async () => {
        const runtime = await openRuntime(context.dbName, context.activeTokens);
        // Test-only injection: resolve the replacement open just past the
        // deadline so the late-replacement path is deterministic.
        await delayOpenPastDeadline(context.delayReopenOpenMs, context.deadlineAtMs);
        return runtime;
      }, context.deadlineAtMs);
      if (context.failReopenOnCycle === cycle) {
        throw new Error("soak-test-injected-reopen-failure");
      }
      const after = await verifyCounts(replacement, context);
      failures += after.failures;
      reopenedRuntime = replacement;
      reopened = true;
      // Luna: the reopen status reflects the FULL evidence, not just the
      // post-reopen table counts. A same-count full-scan failure (row id
      // lost/extra with equal counts) or a content mismatch fails the
      // scan while every count still matches — the recorded status must
      // be failed and the scan evidence is recorded separately so resume
      // can bind the status to both the counts and the identity/content
      // result.
      reopen = {
        status: scan.failures === 0 && after.failures === 0 ? "ok" : "failed",
        scan: scan.failures === 0 ? "ok" : "failed",
        ...after.counts,
      };
      progress(`cycle ${cycle}: runtime closed and reopened`);
    } catch (error) {
      if (closeAttempted) {
        // The old runtime is closed (or close failed after marking it
        // closed) and the replacement never became the current runtime:
        // continuing would run every subsequent cycle against a closed
        // runtime. Wrap the failure so the runner records a stable
        // abort/cleanup failure and stops instead of reporting success.
        // A replacement that DID open stays attached to the error so the
        // runner's finalizer closes it — never a silent leak.
        // A deadline-expired replacement open carries its own runtime
        // (HIGH 3): the wrapped cleanup error keeps it attached so the
        // runner tracks and closes the late replacement — never a leak.
        throw new SoakReopenCleanupError(
          error,
          error instanceof SoakDeadlineExpiredError ? error.runtime : replacement,
        );
      }
      throw error;
    }
  }

  return {
    hikoutei: reopenedRuntime,
    reopened,
    summary: {
      durationMs: Math.round(performance.now() - cycleStart),
      // Deduped and sorted so the record is order-stable regardless of
      // actor completion order.
      tablesTouched: [...new Set(tablesTouched)].sort(),
      // Explicit numeric operations shape so no caller can confuse the
      // per-cycle count (a number) with the summary object and produce NaN
      // accumulations.
      operations: {
        total: operations,
        ok: operations - expectedErrors - failures,
        expectedErrors,
        failures,
        retries,
      },
      ...(probe === undefined ? {} : { probe }),
      ...(convergence === undefined ? {} : { convergence }),
      ...(reopen === undefined ? {} : { reopen }),
    },
  };
}

/**
 * Runs one actor's pre-planned operation stream on its own fork.
 *
 * Each operation executes under the shared oracle mutex so the oracle
 * never desyncs from SQLite between plan, mutation, and verification.
 */
async function runActor(context) {
  const { actorIndex, plan, oracleLock, rootEm, oracle, tokenByEntity, counters } =
    context;
  const em = rootEm.fork();
  const records = [];
  for (let opIndex = 0; opIndex < plan.length; opIndex += 1) {
    const op = plan[opIndex];
    let result;
    let attempt = 0;
    for (; attempt < OPERATION_ATTEMPTS; attempt += 1) {
      if (attempt > 0) {
        await sleep(250 * attempt);
        counters.retries += 1;
      }
      result = await oracleLock.withLock(() =>
        executeActorOperation(op, {
          em,
          rootEm,
          oracle,
          tokenByEntity,
          fieldPlans: SOAK_FIELD_PLANS,
          reconcile: context.reconcile === true,
        }));
      if (result.status !== "failed") break;
    }
    counters.operations += 1;
    if (result.status === "expected_error") counters.expectedErrors += 1;
    if (result.status === "failed") counters.failures += 1;
    records.push(operationRecord(
      context.cycle,
      actorIndex,
      op,
      result,
    ));
    context.tablesTouched.add(op.entityName);
  }
  return { actorIndex, counters, records };
}

/**
 * Resolves one prologue row on REPLAY: returns the row to insert, or
 * `undefined` when the interrupted run already committed it.
 *
 * The existing row is accepted only when its content equals the
 * deterministic row this cycle would produce at that point (for the main
 * row either the pre-patch or post-patch content, since the interruption
 * may have landed after the prologue update). Any other content is a real
 * mismatch — a stable failure, never a silent overwrite.
 *
 * @returns {object | undefined}
 */
function resolvePrologueInsert({ oracle, entityName, id, row, fieldPlan, postPatchRow }) {
  const existing = oracle.row(entityName, id);
  if (existing === undefined) return row;
  if (!rowValuesEqual(row, existing, fieldPlan) &&
      (postPatchRow === undefined || !rowValuesEqual(postPatchRow, existing, fieldPlan))) {
    throw new SoakAssertionError(
      FAILURE_REASON_CODES.RECONCILE_MISMATCH,
      `reconcile mismatch on prologue row ${entityName} ${String(id)}`,
    );
  }
  // Already committed with matching deterministic content: the oracle
  // (rebuilt from SQLite, the authority) already mirrors it.
  return undefined;
}

/**
 * Builds the redacted record for a cycle that threw.
 *
 * The abort is a FAILURE, never a silent skip: it counts one operation
 * failure, feeds the consecutive-failure budget, and carries only stable
 * class/code fields (never the raw message, stack, id, or value). Class
 * and code pass their allowlists; unknown values collapse to `unknown`.
 * A SoakAssertionError (e.g. a replay reconcile mismatch) records its
 * stable reason category instead of the generic cycle-error tag.
 */
function abortedCycleResult(cycle, error, hikoutei) {
  const described = describeError(error);
  const cleanupFailure = error instanceof SoakReopenCleanupError;
  const reason = error !== null && typeof error === "object" &&
    typeof error?.reasonCode === "string"
    ? sanitizeReason(error.reasonCode)
    : cleanupFailure
      ? "reopen-cleanup-failed"
      : "cycle-error";
  return {
    hikoutei,
    reopened: false,
    summary: {
      durationMs: 0,
      tablesTouched: [],
      // The aborted cycle counts as one attempted-and-failed unit so the
      // invariant total = ok + expectedErrors + failures holds everywhere.
      operations: { total: 1, ok: 0, expectedErrors: 0, failures: 1, retries: 0 },
      abort: {
        reason,
        errorClass: sanitizeErrorClass(described.errorClass),
        ...(described.code === undefined ? {} : { code: sanitizeStableCode(described.code) }),
      },
    },
  };
}


/** One async mutex serializing oracle-touching sections. */
function createAsyncMutex() {
  let tail = Promise.resolve();
  return {
    /** Runs `action` after every previously queued action settles. */
    withLock(action) {
      const result = tail.then(() => action());
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}

/** Sampled per-table query verification against the oracle. */
async function verifyAgainstOracle(context) {
  const { hikoutei, oracle, tokenByEntity, activeEntities } = context;
  const em = hikoutei.em.fork();
  let failures = 0;
  for (const entry of activeEntities) {
    const token = tokenByEntity.get(entry.name);
    const expectedCount = oracle.query(entry.name, {}).total;
    const actualCount = await em.count(token, {});
    if (actualCount !== expectedCount) {
      failures += 1;
      process.stderr.write(
        `[soak] count mismatch on ${entry.tableName}: oracle ${expectedCount}, sqlite ${actualCount}\n`,
      );
      continue;
    }
    const page = oracle.query(entry.name, { orderBy: { id: "asc" }, limit: 10 });
    const rows = await em.find(token, {}, { orderBy: { id: "asc" }, limit: 10 });
    const actualIds = rows.map((row) => String(row.id));
    if (JSON.stringify(actualIds) !== JSON.stringify(page.ids)) {
      failures += 1;
      process.stderr.write(`[soak] sampled page mismatch on ${entry.tableName}\n`);
    }
  }
  return { failures };
}

/**
 * Test-only injection: swaps one row of the first active table for a
 * foreign-id row through the PUBLIC EntityManager, keeping the table count
 * unchanged.
 *
 * The full-scan compare must then fail on row identity (the expected id is
 * lost, an impossible id appears) while every post-reopen table count still
 * matches the deterministic replay — the exact same-count full-scan failure
 * the reopen status/evidence contract must reflect.
 */
async function swapOneRowForForeignId(context) {
  const { hikoutei, tokenByEntity, activeEntities } = context;
  const entry = activeEntities[0];
  const token = tokenByEntity.get(entry.name);
  const em = hikoutei.em.fork();
  const rows = await em.find(token, {});
  if (rows.length === 0) return;
  const victim = rows[0];
  em.remove(victim);
  em.create(token, { ...victim, id: `${String(victim.id)}-swap` });
  await em.flush();
}

/** Full-scan id-set and content comparison for every table (60th-cycle cadence). */
async function fullScanCompare(context) {
  const { hikoutei, oracle, tokenByEntity, activeEntities } = context;
  const em = hikoutei.em.fork();
  let failures = 0;
  for (const entry of activeEntities) {
    const token = tokenByEntity.get(entry.name);
    const rows = await em.find(token, {});
    const actualIds = new Set(rows.map((row) => String(row.id)));
    const expectedIds = new Set(oracle.query(entry.name, {}).ids);
    if (actualIds.size !== expectedIds.size) {
      failures += 1;
      process.stderr.write(
        `[soak] full scan size mismatch on ${entry.tableName}: oracle ${expectedIds.size}, sqlite ${actualIds.size}\n`,
      );
      continue;
    }
    for (const id of expectedIds) {
      if (!actualIds.has(id)) {
        failures += 1;
        process.stderr.write(`[soak] full scan lost row on ${entry.tableName}\n`);
        break;
      }
    }
    if (failures > 0) continue;
    // Luna: the full scan also verifies CONTENT (identity rows), so a
    // same-count mutation that keeps every id but changes a value is a
    // scan failure too — not only id loss/extra rows. The oracle mirrors
    // SQLite exactly in both modes (live probes update it on accept), so
    // a mismatch is a real scan failure.
    const fieldPlan = SOAK_FIELD_PLANS[entry.name];
    for (const row of rows) {
      const expected = oracle.row(entry.name, String(row.id));
      if (expected === undefined) continue;
      const plain = {};
      for (const [field, spec] of Object.entries(fieldPlan)) {
        plain[field] = row[field] ?? null;
        if (spec.type === "date" && plain[field] instanceof Date === false) {
          plain[field] = plain[field] === null ? null : new Date(plain[field]);
        }
      }
      if (!rowValuesEqual(expected, plain, fieldPlan)) {
        failures += 1;
        process.stderr.write(`[soak] full scan content mismatch on ${entry.tableName}\n`);
        break;
      }
    }
  }
  return { failures };
}

/** Verifies per-table counts against the oracle after a reopen. */
async function verifyCounts(hikoutei, context) {
  const { oracle, tokenByEntity, activeEntities } = context;
  const em = hikoutei.em.fork();
  let failures = 0;
  const counts = {};
  for (const entry of activeEntities) {
    const token = tokenByEntity.get(entry.name);
    const actual = await em.count(token, {});
    counts[entry.tableName] = actual;
    if (actual !== oracle.query(entry.name, {}).total) {
      failures += 1;
      process.stderr.write(`[soak] post-reopen count mismatch on ${entry.tableName}\n`);
    }
  }
  return { failures, counts };
}

// Cross-module helpers split out of the monolithic runner.
// Cycle execution helpers consumed by runner.mjs.
export {
  abortedCycleResult,
  runOneCycle,
};
