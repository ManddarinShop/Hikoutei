/**
 * Local multi-table soak runner orchestration.
 *
 * Executes deterministic cycles against the CURRENT LOCAL BUILD of
 * Hikoutei through the public API only. Each cycle touches every active
 * table (create/update/delete prologue), runs forked actors with seeded
 * mixed operations, verifies sampled queries against the in-memory oracle,
 * probes human-edit/CAS convergence every 10th cycle in live mode, and
 * rescans plus close/reopens the runtime every 60th cycle.
 *
 * Determinism contract: every actor operation is planned UP FRONT in a
 * sequential planning pass against the deterministic post-prologue oracle
 * state, so the planned stream is a pure function of (seed, cycle) and
 * never of actor scheduling. Execution keeps the forked actors but
 * serializes each oracle-touching operation through one async mutex, so
 * every query is verified against the oracle state committed at the same
 * instant — scheduling can never produce false mismatches.
 *
 * Reliability contract: any exception escaping a cycle (live convergence,
 * full scan, reopen, artifact I/O) becomes a stable redacted abort record
 * that counts toward the failure budget; the run always writes its cycle/
 * state/summary artifacts, closes the runtime, and collects the log.
 *
 * Bounded recovery invariant: the filesystem and SQLite cannot be one
 * transaction, so a process interruption at ANY point between them is
 * repaired by the resume path with idempotent, checkpointed recovery —
 * never by silently starting fresh. The durable order is: atomic
 * in-flight marker -> cycle SQLite work -> cycle record -> ATOMIC state
 * checkpoint -> resource sample -> atomic completed marker. Every resume
 * validates BOTH state.json and checkpoint.json, then verifies the
 * authority's EXACT row sets (ids AND content) against a deterministic
 * replay of the stored seed/params before trusting SQLite (rebuilt into
 * the oracle): checkpointed cycles must match exactly, an interrupted
 * cycle is bounded to its own deterministic planned rows — including the
 * exact committed-stage candidates of each planned actor op, so a
 * two-flush forkIsolation row caught between its flushes is a valid
 * interrupted stage — with sequential prologue stage rules, and any
 * abort cycle whose committed extent cannot be proven fails closed.
 *
 * HIGH 1: a recorded cycle ahead of state.lastCompletedCycle is NEVER
 * trusted merely because its JSONL record parses or carries a resource
 * sample — before completeRecordedCycle() advances state, the cycle is
 * re-proven against the exact deterministic plan (record totals plus the
 * full non-aborted actor identity grid) AND the exact SQLite rows/content
 * of that cycle; a missing, tampered, or partial row fails closed instead
 * of advancing from incomplete SQLite.
 *
 * HIGH 2: every recovery expectation and plan derives from the stored
 * seed/params and the deterministic generator ALONE (a pure replay
 * planner), never from whatever partial rows SQLite currently holds —
 * including a zero-cycle run (lastCompletedCycle 0) interrupted during
 * its first cycle. SQLite is only ever CHECKED against the independently
 * derived expected state (execution mirror), never used to change the
 * plan. The ONE deliberate exception is the DB-backed probe evidence:
 * an ok probe record is trusted for the replay oracle mutation only when
 * the authority contains the deterministic human-edit value for that
 * exact cycle/table/field, so a forged ok probe (adjusted counters,
 * unchanged DB) fails closed instead of mutating the replay or passing
 * the exact proof.
 *
 * MEDIUM 4: before the runtime opens, a resume inspects the EXISTING
 * SQLite schema read-only and fails when an expected entity table or
 * column is missing — a dropped table/column is never silently recreated
 * by the runtime's non-destructive migration and then accepted with zero
 * rows.
 *
 * HIGH 3: a FRESH run removes the prior state.json/checkpoint.json (with
 * the other runner-owned artifacts) BEFORE opening the new DB/runtime, so
 * a crash after the new DB opens but before the first state write can
 * never resume the previous run's identity or zero-cycle state — --resume
 * fails cleanly instead.
 *
 * The JSONL history is bound to the same replay (identity, kind, and
 * table of every record), the interrupted cycle's deterministic
 * mutations are reconciled idempotently (deduping cycle/operation/
 * resource records), and a redacted recovery reason is persisted. Each
 * interruption boundary either recovers deterministically or fails
 * safely before any runtime opens; a corrupt/partial state write can
 * never silently restart a run as if it were fresh.
 *
 * Mutation path: public `createTypedSheets()` / EntityManager only. The
 * direct Sheets client is used exclusively for test-only observation, the
 * simulated human edit probe, and cleanup.
 */


// The soak runner is split into logical modules; this file owns the
// orchestration (the public run entrypoint, the run/state setup, and the
// main cycle loop). `runnerStartup.mjs` owns live/local detection and
// state loading; `scripts/ci/local-soak/runner.mjs` is the thin facade
// re-exporting the public/helper surface so it remains the single import
// path used by the CLI and the Vitest suite.
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";

import {
  RECOVERY_REASONS,
  REOPEN_BUDGET_MARGIN_MS,
  REOPEN_EVERY_CYCLES,
  SoakDeadlineExpiredError,
  SoakReopenCleanupError,
  SoakSimulatedInterruptionError,
} from "./constants.mjs";
import {
  createArtifactWriter,
  cycleRecord,
  renderSummaryMarkdown,
  resourceRecord,
} from "./artifacts.mjs";
import {
  delayOpenPastDeadline,
  inFlightCycleFromCheckpoint,
  openRuntime,
  openRuntimeWithinDeadline,
  readObservedRows,
  validateResumeDatabaseFile,
  validateResumeDatabaseSchema,
  verifyResumeDatabaseContent,
} from "./database.mjs";
import { resetHikouteiInternalLoggerForTests } from "./distFallback.mjs";
import { SOAK_ENTITY_ORDER, SOAK_FIELD_PLANS, buildSoakEntities } from "./entities.mjs";
import { describeError, stableErrorTag } from "./errors.mjs";
import { abortedCycleResult, runOneCycle } from "./execute.mjs";
import { SoakOracle } from "./oracle.mjs";
import { parseSeed } from "./prng.mjs";
import { sanitizeErrorClass, sanitizeStableCode } from "./redact.mjs";
import {
  buildProbeEvidence,
  rebuildOracleFromSqlite,
  replayDeterministicHistory,
  requireProbeEvidenceOrFail,
} from "./replay.mjs";
import {
  checkpointMarker,
  completeRecordedCycle,
  createRecordingTracker,
  planResumeRecovery,
  readCheckpointOrUndefined,
  recordCycleIfAbsent,
  recordResourceIfAbsent,
  validateResumeHistory,
} from "./resume.mjs";
import { buildSummary, closeRuntimeWithFinalRetry } from "./summary.mjs";
import { deadlineRemainingMs, sleep } from "./timing.mjs";
import { detectLiveMode, loadOrInitState } from "./runnerStartup.mjs";


/**
 * Runs the soak loop.
 *
 * @param {object} options resolved options from parseSoakArgs().
 * @returns {Promise<object>} redacted summary (also written to artifacts).
 */
export async function runLocalMultiTableSoak(options) {
  const progress = (message) => process.stderr.write(`[soak] ${message}\n`);
  const outputDir = path.resolve(
    options.outputDir ?? path.join(".local", "soak", `run-${new Date().toISOString().replace(/[:.]/g, "-")}`),
  );
  const artifacts = createArtifactWriter(outputDir, progress);
  await artifacts.ensure();

  // Library file logging is opt-in through the documented env vars. The
  // runner pins the log into the artifact directory unless the operator
  // supplied --log-file, and the level unless already configured. The pin
  // is scoped to THIS run: the pre-run env values are restored and the
  // cached process logger dropped when the run ends (success or failure),
  // so repeated runLocalMultiTableSoak() calls in one Node process can
  // never retain the first run's HIKOUTEI_LOG_FILE or a logger bound to
  // its file. Caller-set env values still win over --log-file/defaults
  // during the run, and normal application env behavior is unchanged
  // after it.
  const priorLogFile = process.env.HIKOUTEI_LOG_FILE;
  const priorLogLevel = process.env.HIKOUTEI_LOG_LEVEL;
  process.env.HIKOUTEI_LOG_FILE = process.env.HIKOUTEI_LOG_FILE ?? options.logFile ?? artifacts.paths.internalLog;
  process.env.HIKOUTEI_LOG_LEVEL = process.env.HIKOUTEI_LOG_LEVEL ?? "info";
  resetHikouteiInternalLoggerForTests();
  try {
    return await runSoakWithArtifacts(options, progress, artifacts);
  } finally {
    restoreEnvValue("HIKOUTEI_LOG_FILE", priorLogFile);
    restoreEnvValue("HIKOUTEI_LOG_LEVEL", priorLogLevel);
    resetHikouteiInternalLoggerForTests();
  }
}

/**
 * Restores one environment key to its pre-run value (deleting it when the
 * caller never set it), so a run never leaks its pinned logger env.
 *
 * @param {string} key environment variable name.
 * @param {string | undefined} priorValue value before the run pinned it.
 */
function restoreEnvValue(key, priorValue) {
  if (priorValue === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = priorValue;
  }
}

/**
 * Runs the soak loop body with the per-run logger env already pinned.
 *
 * Kept separate from runLocalMultiTableSoak so the env pin/restore wrapper
 * owns every boundary of the run, including thrown failures.
 *
 * @param {object} options resolved options from parseSoakArgs().
 * @param {(message: string) => void} progress stderr progress sink.
 * @param {object} artifacts artifact writer for this run's output dir.
 * @returns {Promise<object>} redacted summary (also written to artifacts).
 */
async function runSoakWithArtifacts(options, progress, artifacts) {
  const parsedSeed = parseSeed(options.seed);
  const dbName = path.join(artifacts.dir, "soak.sqlite");
  // Durations stay on performance.now(); ALL deadline comparisons and
  // bounded sleeps use the epoch clock so live probe/convergence waits can
  // never disagree with the run budget (one clock domain per purpose). The
  // deadline derives from the CLI duration directly (resume overrides the
  // stored duration with the same value), so the live direct client can be
  // built with the deadline before the state loads.
  const startedClock = performance.now();
  const deadlineAtMs = Date.now() + options.durationMs;
  const live = await detectLiveMode(deadlineAtMs);
  const state = await loadOrInitState(artifacts, options, parsedSeed, live.mode, startedClock, progress);
  // Recovery contract: the atomic checkpoint marker plus the recorded JSONL
  // identity determine whether the interrupted cycle needs a full SQLite
  // reconciliation (no cycle record), a bookkeeping-only advance (cycle
  // record present), or only a stale-marker repair (state already ahead).
  const recording = await createRecordingTracker(artifacts, options.resume === true);
  const checkpoint = options.resume === true
    ? await readCheckpointOrUndefined(artifacts, state)
    : undefined;
  if (options.resume === true) {
    // HIGH 2: no parseable JSONL line is trusted as completion proof. The
    // exact cycle/operation/resource record schemas, cycle identity, gaps,
    // duplicates, cross-file totals, and the checkpoint/state counters are
    // all validated BEFORE any runtime opens or mutates; corrupt, partial,
    // or inconsistent history is a safe pre-mutation failure (or the
    // interrupted cycle is reconciled deterministically).
    await validateResumeHistory(artifacts, state, checkpoint);
  }
  const recovery = options.resume === true
    ? planResumeRecovery(checkpoint, state, recording.cycleRecords)
    : undefined;
  if (recovery !== undefined) {
    // The redacted recovery reason is persisted with the state and surfaced
    // in the final summary; it never carries ids, values, or messages.
    state.recovery = { cycle: recovery.cycle, reason: recovery.reason };
    progress(`recovery: cycle ${recovery.cycle} ${recovery.reason}`);
  }
  // The workload always derives from the RUN's seed: on resume that is the
  // stored seed of the interrupted run, so the continued cycles stay on the
  // same deterministic stream even when the operator passes a new --seed.
  const seed = state.seed;
  const { tokens, byName } = buildSoakEntities();
  const tokenByEntity = new Map(
    SOAK_ENTITY_ORDER.map((entry, index) => [entry.name, tokens[index]]),
  );
  // --tables scope: the runtime entity list, the workload, reopen, and
  // verification all use ONLY the resolved tables. A subset run never
  // provisions or projects tables outside the selection.
  const activeEntities = SOAK_ENTITY_ORDER.filter((entry) =>
    state.params.resolvedTables.includes(entry.tableName));
  const activeTokens = activeEntities.map((entry) => tokenByEntity.get(entry.name));
  const oracle = new SoakOracle(SOAK_FIELD_PLANS);
  // HIGH 1/HIGH 2: the resume replay is a pure function of the stored
  // seed/params and the deterministic generator — never of whatever
  // partial rows SQLite currently holds — and it is computed ONCE per
  // resume. Its ONLY SQLite-dependent input is the DB-backed probe
  // evidence set (which claims in the JSONL history must be trusted for
  // the replay oracle mutation; see buildProbeEvidence), so the replay is
  // computed right after the authority opens and its observed rows are
  // read. The SAME replay feeds the pre-mutation authority verification,
  // the recorded-cycle completion proof, and the reconciled cycle's
  // actor plan, so SQLite is only ever CHECKED against the
  // independently derived expected state and can never change what the
  // recovery expects or plans (including a zero-cycle run interrupted
  // during its first cycle).
  const inFlightCycle = options.resume === true
    ? inFlightCycleFromCheckpoint(checkpoint, state)
    : undefined;
  // Assigned inside the resume branch after the authority opens (its
  // probe evidence requires the observed rows); consumed by the
  // verification and the reconciled cycle's plan.
  let resumeReplay;

  let consecutiveFailures = 0;
  let stopReason;
  // A runtime close failure after the loop ends still fails the run; the
  // error is retained (redacted) for the summary's stable cleanup section.
  let closeError;
  // A replacement runtime that opened during a failed reopen handoff (the
  // old runtime closed but the replacement never became current) remains
  // tracked here until the finalizer closes it — it can never leak
  // silently. A persistent close failure becomes a stable redacted
  // cleanup failure in the summary.
  let replacementRuntime;
  let replacementCloseError;
  // Fresh run: reset the per-run JSONL history, the prior state/checkpoint
  // documents, the SQLite authority, AND the logger-owned log files
  // (current + rotated backups) BEFORE the runtime opens, so a reused
  // output directory can never leak prior cycle history, a previous run
  // identity, or old log content into the new run's artifacts. HIGH 3:
  // state.json/checkpoint.json are REMOVED (not overwritten in place) — a
  // crash after the new DB opens but before the first state write must
  // make a later --resume FAIL cleanly (no state.json) instead of
  // accepting the previous run identity or a zero-cycle state. A resume
  // keeps all prior history untouched. The log reset only ever removes
  // files matching the logger's exact ownership pattern inside the
  // output directory.
  if (!options.resume) {
    await artifacts.resetRunArtifacts();
    await artifacts.resetLoggerFiles({ logFile: process.env.HIKOUTEI_LOG_FILE });
  }
  // HIGH 1: a resumed run must never silently recreate an empty SQLite
  // authority. The database file must already exist, be a regular file,
  // and be non-empty BEFORE the runtime opens (opening a missing file
  // would create it) — otherwise resume fails with a stable reason and
  // the operator starts a fresh run instead.
  if (options.resume) {
    await validateResumeDatabaseFile(dbName);
    // MEDIUM 4: inspect the EXISTING authority's schema READ-ONLY before
    // the runtime opens. A missing entity table or column must fail the
    // resume with a stable reason instead of being silently recreated by
    // the runtime's non-destructive schema update and then passing with
    // zero expected rows. The inspection never mutates the database;
    // only the public runtime (fresh runs) may change the schema.
    await validateResumeDatabaseSchema(dbName, activeEntities);
  }
  // The initial open is deadline-gated: sync startup (live mode) that
  // returns after the run budget expired is closed and fails with the
  // stable deadline_expired class instead of claiming a within-budget run.
  // HIGH 3: a late-opened runtime is tracked in `lateRuntime` BEFORE the
  // deadline error is rethrown, and is closed again with the final retry —
  // a late initial open can never leak leases or be silently discarded.
  let hikoutei;
  let lateRuntime;
  const initialOpen = async () => {
    const runtime = await openRuntime(dbName, activeTokens);
    // Test-only injection: resolve the open just past the deadline so the
    // deadline-gated path can be exercised deterministically.
    await delayOpenPastDeadline(options.__testDelayInitialOpenMs, deadlineAtMs);
    return runtime;
  };
  try {
    hikoutei = await openRuntimeWithinDeadline(initialOpen, deadlineAtMs);
  } catch (error) {
    if (error instanceof SoakDeadlineExpiredError && error.runtime !== undefined) {
      // Track the late-open handle before rethrowing: the runtime that
      // finished opening after the deadline is never silently discarded.
      lateRuntime = error.runtime;
    }
    if (lateRuntime !== undefined) {
      // Finalization of the startup path: the deadline-gated close inside
      // openRuntimeWithinDeadline already ran with the final retry; when it
      // failed the runtime may still be open, so it is closed again here
      // with the final retry (Hikoutei close is idempotent, so a second
      // close is safe). A persistent failure is reported (progress) and
      // chained onto the rethrown deadline error — never swallowed.
      const lateCloseError = await closeRuntimeWithFinalRetry(lateRuntime, {
        failClosePersistent: options.__testCloseFailPersistent === true,
      });
      if (lateCloseError !== undefined) {
        progress(`late runtime close failed: ${stableErrorTag(lateCloseError)}`);
        if (typeof error === "object" && error !== null) {
          error.lateCloseError = lateCloseError;
        }
      }
    }
    throw error;
  }
  try {
    // HIGH 1: the resumed authority's schema and row counts are verified
    // through PUBLIC runtime reads BEFORE any workload mutation: every
    // active entity table must read cleanly (schema present) and its row
    // count must equal the checkpointed state.tableRows. A mismatch is a
    // stable pre-mutation failure — SQLite is the authority and is never
    // silently reconciled, recreated, or trusted with a drifted schema.
    if (options.resume) {
      // Read the FULL authority row sets exactly once; the same rows feed
      // the DB-backed probe evidence and the exact DB proof.
      const observedByTable = await readObservedRows(hikoutei, activeEntities, tokenByEntity);
      // Luna: a structurally valid same-target ok probe is trusted for
      // the replay oracle mutation ONLY when the SQLite authority
      // contains the deterministic human-edit value for that exact
      // cycle/table/field. A forged ok probe with adjusted counters but
      // an unchanged DB never mutates the replay oracle and fails the
      // resume closed here (requireProbeEvidenceOrFail) before the exact
      // proof can pass.
      const probeEvidence = buildProbeEvidence({
        state,
        activeEntities,
        cycleByNumber: recording.cycleRecords,
        inFlightCycle,
        observedByTable,
      });
      resumeReplay = replayDeterministicHistory({
        state,
        activeEntities,
        cycleByNumber: recording.cycleRecords,
        inFlightCycle,
        probeEvidence,
      });
      requireProbeEvidenceOrFail(resumeReplay);
      await verifyResumeDatabaseContent(
        state,
        activeEntities,
        resumeReplay,
        observedByTable,
      );
    }
    // HIGH 2: the EXECUTION oracle is rebuilt from SQLite even when no
    // cycle was ever checkpointed (lastCompletedCycle 0) whenever an
    // interrupted cycle must be reconciled or a recorded cycle's totals
    // advanced. SQLite remains the authority for the execution mirror;
    // planning always derives from the pure replay above, so the rebuilt
    // oracle can never change what the recovery plans.
    if (state.lastCompletedCycle > 0 || recovery !== undefined) {
      await rebuildOracleFromSqlite(hikoutei, oracle, activeEntities, tokenByEntity, progress);
    }
    // A resumed interrupted cycle (in-flight marker, no cycle record) is
    // re-run ONCE with reconciliation: the oracle was rebuilt from SQLite
    // (the authority), the prologue accepts already-committed deterministic
    // rows, and actor mutations reconcile instead of duplicating.
    const reconcileCycle = recovery?.reason === RECOVERY_REASONS.INTERRUPTED_CYCLE_RECONCILED
      ? recovery.cycle
      : undefined;
    if (recovery?.reason === RECOVERY_REASONS.COMPLETED_CYCLE_CHECKPOINT) {
      // The interrupted cycle fully completed (its cycle record landed) but
      // the state checkpoint never did: advance state from the recorded
      // record's own totals — no SQLite replay, no duplicate rows, and the
      // cumulative counters stay exactly consistent with the JSONL history.
      await completeRecordedCycle({
        cycle: recovery.cycle,
        state,
        artifacts,
        recording,
        oracle,
        activeEntities,
        tokenByEntity,
        hikoutei,
        dbName,
        progress,
      });
    } else if (recovery?.reason === RECOVERY_REASONS.STALE_IN_FLIGHT_MARKER) {
      // State already checkpointed the cycle; only the marker lagged. The
      // repair re-persists the state (with the redacted recovery reason),
      // backfills the resource sample if it never landed, and advances
      // the marker to completed — exactly the ordering the live loop uses:
      // cycle record + atomic state + resource BEFORE the completed marker.
      await artifacts.writeJson("state", state);
      await recordResourceIfAbsent(recording, artifacts, await resourceRecord(
        recovery.cycle,
        await artifacts.databaseSizeBytes(dbName),
      ));
      await artifacts.writeCheckpoint(checkpointMarker(state.runId, recovery.cycle, "completed"));
    }
    // The loop starts AFTER any recovery advance so an interrupted cycle is
    // never re-executed without reconciliation.
    let cycle = state.lastCompletedCycle;
    while (stopReason === undefined) {
      if (Date.now() >= deadlineAtMs) {
        stopReason = "duration-budget-reached";
        break;
      }
      // MEDIUM 5: never START a reopen handoff when the remaining budget
      // cannot safely fit it. The reopen cadence is deterministic (every
      // 60th cycle), so this guard is deterministic too: the run ends
      // cleanly on the budget instead of crossing the deadline mid-open
      // and failing with deadline_expired for a reopen that could never
      // have completed in time.
      const nextCycle = cycle + 1;
      if (nextCycle % REOPEN_EVERY_CYCLES === 0 &&
          deadlineRemainingMs(deadlineAtMs) < REOPEN_BUDGET_MARGIN_MS) {
        stopReason = "duration-budget-reached";
        break;
      }
      cycle += 1;
      // Reliability: any exception escaping the cycle (probe, convergence,
      // full scan, reopen, verification) becomes a stable redacted abort
      // record that counts toward the failure budget. Invariant failures
      // are preserved inside cycleResult; nothing is skipped as a success.
      let cycleResult;
      let bookkeepingFailed = false;
      try {
        // Atomic in-flight marker BEFORE any SQLite mutation of this cycle:
        // a process interruption after this write leaves a durable "started
        // but not checkpointed" record that resume validates and repairs.
        await artifacts.writeCheckpoint(checkpointMarker(state.runId, cycle, "in-flight"));
        try {
          cycleResult = await runOneCycle({
            cycle,
            hikoutei,
            oracle,
            tokenByEntity,
            activeEntities,
            activeTokens,
            seed,
            options: state.params,
            live,
            artifacts,
            recording,
            progress,
            dbName,
            deadlineAtMs,
            reconcile: cycle === reconcileCycle,
            replayCycleOps: resumeReplay?.cyclePlans,
            failOnCycle: options.__testFailOnCycle,
            failReopenOnCycle: options.__testFailReopenOnCycle,
            interruptOnCycle: options.__testInterruptDuringCycle,
            delayReopenOpenMs: options.__testDelayReplacementOpenMs,
            swapRowOnReopenCycle: options.__testSwapRowOnReopenCycle,
          });
        } catch (error) {
          if (error instanceof SoakSimulatedInterruptionError) {
            // Simulated process death mid-cycle: the cycle's SQLite work
            // committed but no cycle record, state advance, or completed
            // marker will ever land. Leave the in-flight marker exactly as
            // a real interruption would and stop, so a later --resume
            // re-runs the cycle with reconciliation instead of skipping
            // or duplicating it.
            stopReason = "simulated-interruption";
            break;
          }
          cycleResult = abortedCycleResult(cycle, error, hikoutei);
          progress(`cycle ${cycle} aborted: ${stableErrorTag(error)}`);
          if (error instanceof SoakReopenCleanupError) {
            // The reopen handoff closed the old runtime and the replacement
            // never opened: no runtime remains to continue with. The abort is
            // recorded above; stop with a stable reason instead of looping
            // against a closed runtime or reporting success. A replacement
            // that DID open before the failure stays tracked so the
            // finalizer closes it — never a silent leak.
            stopReason = "reopen-failed";
            if (error.runtime !== undefined) {
              replacementRuntime = error.runtime;
            }
          }
        }
        // Ownership transfer: a reopen cycle closed the previous runtime and
        // opened a replacement; the runner owns the replacement from here on
        // so a later artifact/stop path always closes the OPEN runtime.
        if (cycleResult.reopened) {
          hikoutei = cycleResult.hikoutei;
        }
        try {
          // Cycle record + state checkpoint + resource sample, then the
          // completed marker. The marker advances ONLY after the cycle
          // record and the state checkpoint landed, so resume can always
          // distinguish "fully checkpointed" from "started but unfinished".
          await recordCycleIfAbsent(recording, artifacts, cycleRecord(cycle, cycleResult.summary));
          if (options.__testInterruptAfterCycleRecord === cycle) {
            // Test-only simulated process interruption at the DB-before-state
            // boundary: the cycle's SQLite work and its cycle record landed,
            // but the state checkpoint never did.
            throw new Error("soak-test-injected-interruption");
          }
          state.lastCompletedCycle = cycle;
          state.cumulative.operations += cycleResult.summary.operations.total;
          state.cumulative.expectedErrors += cycleResult.summary.operations.expectedErrors;
          state.cumulative.failures += cycleResult.summary.operations.failures;
          state.cumulative.retries += cycleResult.summary.operations.retries;
          state.cumulative.probes.total += cycleResult.summary.probe === undefined ? 0 : 1;
          if (cycleResult.summary.probe?.status === "ok") state.cumulative.probes.ok += 1;
          if (cycleResult.summary.probe?.status === "skipped") state.cumulative.probes.skipped += 1;
          if (cycleResult.summary.probe?.status === "failed") state.cumulative.probes.failed += 1;
          if (cycleResult.summary.convergence !== undefined) {
            state.cumulative.convergenceChecks += 1;
            if (cycleResult.summary.convergence.status === "failed") {
              state.cumulative.convergenceFailed += 1;
            }
          }
          state.tableRows = Object.fromEntries(
            activeEntities.map((entry) => [entry.tableName, oracle.size(entry.name)]),
          );
          // Atomic state checkpoint: temp-file + rename, so a reader can
          // never observe a half-written state.json (a crash mid-write
          // leaves the PREVIOUS complete state in place).
          await artifacts.writeJson("state", state);
          if (options.__testInterruptAfterState === cycle) {
            // Test-only simulated process interruption at the
            // state-before-marker boundary: the cycle record and the
            // atomic state checkpoint landed, but the resource sample and
            // the completed marker never did.
            throw new Error("soak-test-injected-interruption");
          }
          await recordResourceIfAbsent(recording, artifacts, await resourceRecord(
            cycle,
            await artifacts.databaseSizeBytes(dbName),
          ));
          await artifacts.writeCheckpoint(checkpointMarker(state.runId, cycle, "completed"));
        } catch (error) {
          // Artifact I/O failed: count one more failure and stop with a
          // stable reason so the loop cannot spin on an unwritable sink.
          bookkeepingFailed = true;
          state.cumulative.failures += 1;
          progress(`cycle ${cycle} artifact write failed: ${stableErrorTag(error)}`);
        }
      } catch (error) {
        // The in-flight marker could not be written: the cycle never ran,
        // so nothing was recorded and the run stops like an artifact failure.
        bookkeepingFailed = true;
        state.cumulative.failures += 1;
        progress(`cycle ${cycle} checkpoint write failed: ${stableErrorTag(error)}`);
      }
      if (cycleResult === undefined) {
        stopReason = "artifact-write-failed";
        break;
      }
      if (cycleResult.summary.operations.failures > 0) {
        consecutiveFailures += cycleResult.summary.operations.failures;
        if (consecutiveFailures >= state.params.maxConsecutiveFailures) {
          stopReason = "max-consecutive-failures";
          break;
        }
      } else {
        consecutiveFailures = 0;
      }
      if (bookkeepingFailed) {
        stopReason = "artifact-write-failed";
        break;
      }
      progress(
        `cycle ${cycle} done in ${cycleResult.summary.durationMs} ms ` +
        `(${cycleResult.summary.operations.total} ops, ` +
        `${cycleResult.summary.operations.failures} failures)`,
      );
      // The deadline check must never overwrite an already-set stop reason
      // (e.g. a reopen-failed abort recorded by the cycle above): the run
      // reports the FIRST decisive reason, not the budget that happened to
      // expire during its final cycle.
      if (stopReason === undefined && Date.now() >= deadlineAtMs) {
        stopReason = "duration-budget-reached";
        break;
      }
      // The inter-cycle wait never extends past the run's epoch deadline.
      const waitMs = Math.max(0, state.params.intervalSeconds * 1000);
      if (stopReason === undefined && waitMs > 0) {
        await sleep(Math.min(waitMs, deadlineRemainingMs(deadlineAtMs)));
      }
    }
  } finally {
    // The finalizer owns every OPEN runtime: the current runtime plus any
    // replacement left over from a failed reopen handoff. Each close gets a
    // final second attempt; a persistent failure is a failed run with a
    // stable redacted cleanup reason, never a swallowed pass.
    closeError = await closeRuntimeWithFinalRetry(hikoutei, {
      failClose: options.__testCloseFail === true,
      failClosePersistent: options.__testCloseFailPersistent === true,
    });
    if (closeError !== undefined) {
      // A failed close is a failed run, never a swallowed pass: count it
      // against the failure budget (the summary and state then report
      // failed) and keep a stable redacted cleanup reason in the summary.
      state.cumulative.failures += 1;
      progress(`runtime close failed: ${stableErrorTag(closeError)}`);
    }
    if (replacementRuntime !== undefined && replacementRuntime !== hikoutei) {
      replacementCloseError = await closeRuntimeWithFinalRetry(replacementRuntime, {
        failClosePersistent: options.__testFailReplacementClose === true,
      });
      if (replacementCloseError !== undefined) {
        state.cumulative.failures += 1;
        progress(`replacement runtime close failed: ${stableErrorTag(replacementCloseError)}`);
      }
    }
  }

  // Final artifact finalization. Every step is independent so one failure
  // can never prevent the remaining artifacts (summary, markdown, log
  // collection, state) from landing. ANY final failure is a failed run:
  // the summary is rebuilt with a stable redacted finalization section and
  // forced to failed (the CLI then exits nonzero), and it is always
  // emitted to stdout — finalization never throws before the summary.
  const finalizationFailures = [];
  const finalizeStep = async (label, action) => {
    try {
      await action();
      if (options.__testFailFinalArtifactStep === label) {
        throw new Error("soak-test-injected-final-artifact-failure");
      }
    } catch (error) {
      finalizationFailures.push({ label, error });
      progress(`final artifact write failed (${label}): ${stableErrorTag(error)}`);
    }
  };
  let summary = buildSummary({
    state,
    stopReason,
    startedClock,
    live,
    closeError,
    replacementCloseError,
  });
  await finalizeStep("summary", () => artifacts.writeJson("summaryJson", summary));
  await finalizeStep("markdown", () => artifacts.writeMarkdown(renderSummaryMarkdown(summary)));
  await finalizeStep("log", () => artifacts.collectInternalLog({
    logFile: process.env.HIKOUTEI_LOG_FILE,
  }));

  // MEDIUM 4: every failed close/finalization step persists a redacted
  // failed marker in state (best effort) so a later --resume REJECTS the
  // state instead of silently continuing a failed run. The final state
  // write itself is part of the aggregation, so a failure of THAT write
  // joins finalizationFailures and the emitted summary is rebuilt to
  // report it — a passed summary can never omit a state-write failure.
  if (finalizationFailures.length > 0) {
    state.finalization = {
      status: "failed",
      reason: "artifact-write-failed",
      step: finalizationFailures[0].label,
    };
  }
  if (closeError !== undefined) {
    const described = describeError(closeError);
    state.cleanup = {
      status: "failed",
      reason: "runtime-close-failed",
      errorClass: sanitizeErrorClass(described.errorClass),
      ...(described.code === undefined ? {} : { code: sanitizeStableCode(described.code) }),
    };
  }
  if (replacementCloseError !== undefined) {
    const described = describeError(replacementCloseError);
    state.replacementCleanup = {
      status: "failed",
      reason: "replacement-close-failed",
      errorClass: sanitizeErrorClass(described.errorClass),
      ...(described.code === undefined ? {} : { code: sanitizeStableCode(described.code) }),
    };
  }

  // Bounded repair loop. Each pass: (1) sets the failed marker before any
  // state write, (2) rebuilds the summary from ALL collected failures,
  // (3) persists the final state (with markers) best effort — with ONE
  // retry when the state write itself failed, and (4) best-effort
  // re-persists the corrected summary/markdown. The loop is bounded so an
  // unwritable sink can never spin forever, and it always terminates with
  // the most complete summary emitted to stdout.
  //
  // HIGH 4: the final state write is skipped ONLY when the loop stopped on
  // an artifact-write failure AND no failed-run marker (close/replacement/
  // finalization) exists to persist. In that exact case the in-memory
  // state may be ahead of the last atomic checkpoint without any marker
  // that would make a later --resume reject it, so the disk state must
  // stay exactly as the recovery contract expects (the interrupted cycle
  // stays reconcilable). When ANY close/replacement/finalization failure
  // must be persisted, the state IS written (atomically, best effort): the
  // failed marker makes a later resume reject the state deterministically,
  // and a state-write failure joins the finalization summary — a passed
  // summary can never omit a state-write failure.
  let stateAttempts = 0;
  const persistFailedMarkers = closeError !== undefined ||
    replacementCloseError !== undefined ||
    finalizationFailures.length > 0;
  for (let pass = 0; pass < 3; pass += 1) {
    const failuresBeforePass = finalizationFailures.length;
    if (finalizationFailures.length > 0 && state.finalization === undefined) {
      state.finalization = {
        status: "failed",
        reason: "artifact-write-failed",
        step: finalizationFailures[0].label,
      };
    }
    if (finalizationFailures.length > 0) {
      summary = buildSummary({
        state,
        stopReason,
        startedClock,
        live,
        closeError,
        replacementCloseError,
        finalizationFailures,
      });
    }
    if (stateAttempts < 1 && (stopReason !== "artifact-write-failed" || persistFailedMarkers)) {
      await finalizeStep("state", () => artifacts.writeJson("state", state));
      stateAttempts += 1;
    } else if (stateAttempts < 2 &&
        finalizationFailures.some((failure) => failure.label === "state")) {
      // The state write itself failed: one best-effort retry now that the
      // failed marker is set, so a later resume can reject the state.
      await finalizeStep("state", () => artifacts.writeJson("state", state));
      stateAttempts += 1;
    }
    if (finalizationFailures.length > 0) {
      await finalizeStep("summary-retry", () => artifacts.writeJson("summaryJson", summary));
      await finalizeStep("markdown-retry", () => artifacts.writeMarkdown(renderSummaryMarkdown(summary)));
    }
    if (finalizationFailures.length === failuresBeforePass && stateAttempts >= 1) break;
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}
