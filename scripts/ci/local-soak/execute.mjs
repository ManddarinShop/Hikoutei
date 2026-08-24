/**
 * Soak cycle execution: prologue, forked actors, verification, reopen.
 * Depends on database/probe/resume plus the leaf modules.
 */
import { performance } from "node:perf_hooks";
import process from "node:process";
import { operationRecord } from "./artifacts.mjs";
import { SCENARIO_REGISTRY } from "./scenarios/registry.mjs";
import {
  SCENARIO_PHASES,
  composeScenarioBatch,
  runScenarioPhase,
} from "./scenarios/scheduler.mjs";
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
  sanitizeStatusClass,
} from "./redact.mjs";
import { recordOperationIfAbsent } from "./resume.mjs";
import { sleep } from "./timing.mjs";

/**
 * Explicit abort envelope: carries the ORIGINAL thrown value (an Error, a
 * primitive, or undefined) plus the partial scenario records collected
 * before the abort. Because a rejection reason may be a primitive or
 * undefined — a value that cannot carry properties — the envelope separates
 * the thrown reason from the scenario records instead of annotating the
 * thrown value, so the abort handoff works for every rejection kind.
 *
 * The envelope is a subclass of Error so it can be thrown and caught through
 * normal async channels; the original reason is preserved verbatim in
 * `cause` and never reconstructed or sanitized here.
 */
export class SoakCycleAbortError extends Error {
  constructor(cause, scenarioRecords) {
    super(cause instanceof Error ? cause.message : "soak-cycle-aborted");
    this.name = "SoakCycleAbortError";
    this.cause = cause;
    this.scenarioRecords = scenarioRecords;
  }
}

/**
 * Unwraps an abort envelope back into the original error and its partial
 * scenario records. A value that is not an abort envelope is returned as-is
 * with no records, so callers that may also receive raw errors stay safe.
 *
 * @param {unknown} caught the thrown value.
 * @returns {{ original: unknown, records: readonly object[] }}
 */
export function unwrapSoakAbort(caught) {
  if (caught instanceof SoakCycleAbortError) {
    return { original: caught.cause, records: caught.scenarioRecords };
  }
  return { original: caught, records: [] };
}

/**
 * Executes one full soak cycle and returns its redacted summary.
 *
 * The actor stream is planned UP FRONT, sequentially, against the
 * deterministic post-prologue oracle state; execution then runs the forked
 * actors concurrently but serializes every oracle-touching operation
 * through one mutex so verification always sees the committed state.
 */
async function runOneCycle(context) {
  // scenarioRecords must be visible to BOTH the cycle body and the abort
  // path, so a mid-cycle throw can preserve the scenario work already done.
  const scenarioRecords = [];
  const collectScenarioRecords = (records) => { scenarioRecords.push(...records); };
  try {
    return await runOneCycleBody(context, scenarioRecords, collectScenarioRecords);
  } catch (error) {
    // HIGH 2 abort handoff: wrap the ORIGINAL thrown value (an Error, a
    // primitive, or undefined) in an explicit envelope that also carries the
    // partial scenario records collected before the throw. The thrown value
    // itself is never mutated or annotated, so the envelope preserves the
    // reason for Error, primitive, and undefined rejections alike and threads
    // the completed scenario work into the abort artifact. The runner unwraps
    // via `unwrapSoakAbort` before reasoning about the error class.
    throw new SoakCycleAbortError(error, [...scenarioRecords]);
  }
}

async function runOneCycleBody(context, scenarioRecords, collectScenarioRecords) {
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

  // Attack-scenario composition: deterministic per-cycle selection of 1-3
  // scenarios (seeded shuffle bag over the registry) with assigned phase,
  // order, jitter and target — all pure functions of (seed, cycle). The
  // scenario plan is recorded redacted per cycle; the live action runs only
  // when a live Sheets/observation client exists (local mode records
  // `skipped` and never touches SQLite or the oracle, so the baseline
  // workload, verification, and resume proofs are unchanged).
  const scenarioBatch = composeScenarioBatch({ seed, cycle, registry: SCENARIO_REGISTRY, activeEntities });
  // One mutex serializes the SHARED oracle-touching critical sections of
  // BOTH concurrent actors AND scenarios: each scenario's public-DB
  // mutation + oracle mirror/cleanup runs atomically against actor
  // verification, so an actor can never observe an intermediate scenario
  // row and falsely fail. External/direct Sheet calls and jitter stay
  // outside the lock.
  const oracleLock = createAsyncMutex();
  const scenarioContext = {
    cycle,
    seed,
    oracle,
    hikoutei: context.hikoutei,
    em: rootEm,
    tokenByEntity,
    activeEntities,
    live,
    deadlineAtMs: context.deadlineAtMs,
    fieldPlans: SOAK_FIELD_PLANS,
    oracleLock,
    ...(context.dbName === undefined ? {} : { dbName: context.dbName }),
    ...(context.activeTokens === undefined ? {} : { activeTokens: context.activeTokens }),
  };

  // Sequential planning pass: every actor op is planned against the oracle
  // state that exists NOW (immediately after the prologue, before any
  // attack scenario runs), which is itself a pure function of (seed, cycle).
  // Planning never observes concurrent actors or scenario mutations, so the
  // same seed reproduces the same operation stream bit-for-bit.
  //
  // HIGH actor-planning-vs-replay: the plans are FROZEN here — right after
  // the prologue, BEFORE the after-prologue attack scenarios execute — so
  // an after-prologue scenario that mutates the oracle (in live mode) can
  // never change the operation kinds, ids, filters, or rows the production
  // run plans. Replay derives its plans from the same prologue-only oracle,
  // so production and replay are identical even when a scenario mutates the
  // oracle; the public phase semantics are unchanged (planning is not actor
  // execution, and the after-prologue scenarios still run after the prologue
  // and before the actors).
  //
  // HIGH 2: on REPLAY of an interrupted cycle, the actor stream is taken
  // from the PURE deterministic replay (a function of the stored
  // seed/params alone) instead of being re-planned against the
  // SQLite-rebuilt oracle — partial rows committed by the interrupted run
  // can never change the operation kinds, ids, filters, or rows the
  // recovery expects and re-executes.
  //
  // MEDIUM: the actor stream is planned by the EXPORTED `planActorStream`
  // helper so production, replay continuity, and the actor-freeze tests
  // all exercise the exact same planning pass — never a duplicated loop.
  const actorPlans = planActorStream({
    seed,
    cycle,
    options,
    activeEntities,
    oracle,
    reconcile: context.reconcile === true,
    replayCycleOps: context.replayCycleOps,
  });

  // Phase 1: after the prologue, before the actors begin. Same-phase
  // scenarios run CONCURRENTLY; the records are sorted by deterministic
  // order (independent of completion order) before collection. These
  // after-prologue scenarios execute AFTER the actor plans above were
  // frozen, so their oracle mutations (live mode) never change the planned
  // actor stream.
  await runScenarioPhase(
    scenarioBatch, SCENARIO_PHASES.AFTER_PROLOGUE, scenarioContext,
  ).then(collectScenarioRecords);

  // Phase 2 (concurrent-with-actors): start the assigned scenarios now so
  // they run in parallel with the forked actors, then join them after the
  // actors settle — the scenario action overlaps the base workload.
  // (The shared oracleLock was created before Phase 1 above and is wired
  // into scenarioContext so every scenario phase serializes its public-DB
  // + oracle critical sections against the actors.)
  const concurrentScenarios = runScenarioPhase(
    scenarioBatch, SCENARIO_PHASES.CONCURRENT_WITH_ACTORS, scenarioContext,
  ).then(collectScenarioRecords);
  // HIGH abort accounting: once the concurrent scenarios have started they
  // are ALWAYS settled — even when an actor rejects — so their completed
  // scenario records are collected into the cycle before the actor's
  // original error propagates to the abort path. The concurrent scenario
  // promise never itself rejects (runScenario maps unexpected throws to a
  // failed record), so this join can never mask the actor error.
  //
  // HIGH 1: await EVERY actor with Promise.allSettled so all sibling actors
  // fully settle (each releasing the oracle mutex and finishing its SQLite/
  // oracle work) before the cycle aborts. A fail-fast Promise.all would
  // reject on the first actor error while sibling actors still mutated
  // SQLite/oracle during shutdown. allSettled never itself rejects, so we
  // collect the fulfilled summaries and deterministically rethrow the FIRST
  // actor rejection (lowest actor index — allSettled preserves input order)
  // only after every actor AND the concurrent scenarios have settled.
  const actorTasks = actorPlans.map((plan, actorIndex) =>
    runActor({ ...context, actorIndex, plan, oracleLock, rootEm, tablesTouched, counters: {
      operations: 0, expectedErrors: 0, failures: 0, retries: 0,
    } }));
  // HIGH 1 + finding 4: settle EVERY actor AND the already-started
  // concurrent scenario phase through the SHARED `settleCycleWorkload`
  // helper — the exact settlement algorithm this harness uses — so every
  // promise settles (each actor releases the oracle mutex and finishes its
  // SQLite/oracle work) before the cycle can abort, no unhandled rejection
  // is left while the actors run, and the deterministic FIRST actor
  // rejection (or the scenario phase rejection when no actor rejected) is
  // rethrown only after everything has settled. The helper consumes the
  // fulfilled actor summaries (counters + op records) only on the success
  // path, so a rejected cycle writes no per-operation records — matching
  // the resume contract.
  await settleCycleWorkload({
    actorTasks,
    scenarioPhase: concurrentScenarios,
    consumeActor: async (actor) => {
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
    },
  });

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

  // Phase 3 (after-actors/before-final-convergence): scenario actions that
  // own a post-workload window run before the live convergence check.
  await runScenarioPhase(
    scenarioBatch, SCENARIO_PHASES.AFTER_ACTORS, scenarioContext,
  ).then(collectScenarioRecords);

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
      // Dedicated scenario totals, SEPARATE from the standard operation
      // totals: a scenario failure must feed the run's failure budget and
      // result without ever perturbing the baseline workload counters. The
      // totals are the sum of the per-scenario records' counters, so the
      // resume schema can bind them to the recorded scenario section.
      scenarioTotals: {
        expectedErrors: scenarioRecords.reduce((sum, record) => sum + (record.expectedErrors ?? 0), 0),
        failures: scenarioRecords.reduce((sum, record) => sum + (record.failures ?? 0), 0),
      },
      // Per-cycle redacted attack scenarios, sorted deterministically by
      // order. These are separate from the operation totals — scenario
      // expected/failure counts never perturb the baseline workload counts.
      ...(scenarioRecords.length === 0 ? {} : {
        scenarios: scenarioRecords.sort((a, b) => a.order - b.order),
      }),
    },
  };
}

/**
 * Settles one cycle's actor stream AND its already-started concurrent
 * scenario phase — the exact settlement algorithm the cycle executor uses.
 *
 * Every actor promise settles (Promise.allSettled), so each releases the
 * shared oracle mutex and finishes its SQLite/oracle work before the cycle
 * can abort; a fail-fast Promise.all would reject on the first actor error
 * while sibling actors still mutated state during shutdown. The concurrent
 * scenario phase — already started by the caller and wired to collect its
 * records — is ALWAYS awaited too, so its scenario work is never abandoned
 * and no rejection is left unhandled while the actors run.
 *
 * A rejection whose reason is `undefined` is tracked with an explicit
 * boolean discriminant so it can never be mistaken for "no rejection". On
 * failure the FIRST actor rejection (in actor order — allSettled preserves
 * input order) is rethrown RAW (Error, string, or undefined); a
 * concurrent-scenario rejection is rethrown only when NO actor rejected, so
 * a real actor error is never masked by a scenario error. Fulfilled actor
 * summaries are delivered to `consumeActor` ONLY on the success path (in
 * actor order), so a rejected cycle writes no per-operation records,
 * matching the resume contract.
 *
 * The returned promise rejects with the original actor/scenario rejection
 * only after every actor and the scenario phase have settled.
 *
 * @param {{ actorTasks: readonly (Promise<object>)[], scenarioPhase: Promise<unknown>, consumeActor: (actor: object, index: number) => Promise<void> }} input
 * @returns {Promise<void>}
 */
async function settleCycleWorkload({ actorTasks, scenarioPhase, consumeActor }) {
  const actorResults = await Promise.allSettled(actorTasks);
  const fulfilledActors = [];
  let firstActorRejection;
  let hasActorRejection = false;
  for (let index = 0; index < actorResults.length; index += 1) {
    const result = actorResults[index];
    if (result.status === "fulfilled") {
      fulfilledActors.push(result.value);
    } else if (!hasActorRejection) {
      firstActorRejection = result.reason;
      hasActorRejection = true;
    }
  }
  let scenarioError;
  let scenarioRejected = false;
  try {
    await scenarioPhase;
  } catch (error) {
    scenarioError = error;
    scenarioRejected = true;
  }
  if (hasActorRejection) throw firstActorRejection;
  if (scenarioRejected) throw scenarioError;
  for (let index = 0; index < fulfilledActors.length; index += 1) {
    await consumeActor(fulfilledActors[index], index);
  }
}

/**
 * Plans one cycle's full actor stream up front.
 *
 * The EXACT planning pass the cycle executor uses, extracted so production,
 * replay continuity, and the actor-freeze tests all exercise the same loop
 * (never a duplicated plan). On a replay of an interrupted cycle the actor
 * stream is taken from the pure deterministic replay (`replayCycleOps`);
 * otherwise every op is planned against the given oracle state. Either way
 * the stream is a pure function of (seed, cycle, params, active subset,
 * oracle) and is frozen BEFORE any after-prologue scenario runs.
 *
 * @param {{ seed: number, cycle: number, options: { actors: number,
 *   operationsPerActor: number }, activeEntities: readonly object[],
 *   oracle: object, reconcile: boolean, replayCycleOps?: Map<number, object[]> }} input
 * @returns {object[][]} per-actor arrays of planned ops, in actor order.
 */
export function planActorStream({ seed, cycle, options, activeEntities, oracle, reconcile, replayCycleOps }) {
  const actorPlans = [];
  if (reconcile === true && replayCycleOps !== undefined) {
    const replayed = replayCycleOps.get(cycle) ?? [];
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
  return actorPlans;
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
function abortedCycleResult(cycle, error, hikoutei, partialScenarioRecords = []) {
  const described = describeError(error);
  const cleanupFailure = error instanceof SoakReopenCleanupError;
  const reason = error !== null && typeof error === "object" &&
    typeof error?.reasonCode === "string"
    ? sanitizeReason(error.reasonCode)
    : cleanupFailure
      ? "reopen-cleanup-failed"
      : "cycle-error";
  // The DirectSheetsError status class is preserved through the abort
  // artifact (allowlisted only) so a live direct-client failure keeps a
  // useful stable category; arbitrary status text collapses to `unknown`.
  const statusClass = error !== null && typeof error === "object" &&
    typeof error?.statusClass === "string"
    ? sanitizeStatusClass(error.statusClass)
    : undefined;
  // HIGH 2 abort accounting: the partial scenario records are delivered in
  // the EXPLICIT abort envelope (the fourth argument), NOT by annotating the
  // thrown value — the reason may be a primitive or undefined and cannot
  // carry properties. The envelope preserves the scenario work that did
  // complete before the abort instead of silently dropping it.
  const partialRecords = Array.isArray(partialScenarioRecords)
    ? partialScenarioRecords
    : [];
  return {
    hikoutei,
    reopened: false,
    summary: {
      durationMs: 0,
      tablesTouched: [],
      // The aborted cycle counts as one attempted-and-failed unit so the
      // invariant total = ok + expectedErrors + failures holds everywhere.
      operations: { total: 1, ok: 0, expectedErrors: 0, failures: 1, retries: 0 },
      // Dedicated scenario totals derived from the partial scenario
      // records the abort preserved (zero when none had completed).
      scenarioTotals: {
        expectedErrors: partialRecords.reduce((sum, record) => sum + (record.expectedErrors ?? 0), 0),
        failures: partialRecords.reduce((sum, record) => sum + (record.failures ?? 0), 0),
      },
      // Partial scenario records, sorted deterministically by order.
      ...(partialRecords.length === 0 ? {} : {
        scenarios: partialRecords.sort((a, b) => a.order - b.order),
      }),
      abort: {
        reason,
        errorClass: sanitizeErrorClass(described.errorClass),
        ...(described.code === undefined ? {} : { code: sanitizeStableCode(described.code) }),
        ...(statusClass === undefined ? {} : { statusClass }),
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
  settleCycleWorkload,
};
