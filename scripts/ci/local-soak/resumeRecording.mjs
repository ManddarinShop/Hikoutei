/**
 * Resume recorded BOOKKEEPING for the soak runner: the in-memory record
 * tracker (dedupes by cycle/identity/sample across runs), the idempotent
 * JSONL appenders, and the exact SQLite-proofed completion of a fully
 * executed but uncheckpointed cycle. Split from the resume facade so
 * each module stays review-sized; `resume.mjs` re-exports the shared
 * surface. No cycle with execute or probe.
 */
import { readFile } from "node:fs/promises";
import { resourceRecord } from "./artifacts.mjs";
import { readObservedRows } from "./database.mjs";
import { SOAK_FIELD_PLANS } from "./entities.mjs";
import { rowValuesEqual } from "./executor.mjs";
import {
  buildProbeEvidence,
  operationIdentityKey,
  replayDeterministicHistory,
  requireProbeEvidenceOrFail,
} from "./replay.mjs";
import { isProvableFullCycleAbort } from "./resumeHistory.mjs";
import { checkpointMarker } from "./resumeState.mjs";

async function createRecordingTracker(artifacts, loadExisting) {
  const tracker = {
    /** @type {Map<number, object>} cycle records by cycle number. */
    cycleRecords: new Map(),
    /** @type {Set<string>} operation identity keys. */
    operations: new Set(),
    /** @type {Set<number>} resource sample cycles. */
    resources: new Set(),
  };
  if (!loadExisting) return tracker;
  const readLines = async (name) => {
    const content = await readFile(artifacts.paths[name], "utf8").catch(() => "");
    const records = [];
    for (const line of content.split("\n")) {
      if (line.trim() === "") continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        // A corrupt line is never trusted for identity; it is skipped.
      }
    }
    return records;
  };
  for (const record of await readLines("cycles")) {
    if (Number.isInteger(record?.cycle) && !tracker.cycleRecords.has(record.cycle)) {
      tracker.cycleRecords.set(record.cycle, record);
    }
  }
  for (const record of await readLines("operations")) {
    if (Number.isInteger(record?.cycle) && Number.isInteger(record?.actor) &&
        Number.isInteger(record?.index)) {
      tracker.operations.add(operationIdentityKey(record.cycle, record.actor, record.index));
    }
  }
  for (const record of await readLines("resources")) {
    if (Number.isInteger(record?.cycle)) tracker.resources.add(record.cycle);
  }
  return tracker;
}
/**
 * Appends one cycle record unless its cycle was already recorded; returns
 * true when the record was appended (false = deduplicated).
 */
async function recordCycleIfAbsent(recording, artifacts, record) {
  if (recording.cycleRecords.has(record.cycle)) return false;
  await artifacts.appendJsonl("cycles", record);
  recording.cycleRecords.set(record.cycle, record);
  return true;
}

/**
 * Appends one operation record unless its identity was already recorded.
 */
async function recordOperationIfAbsent(recording, artifacts, record) {
  const key = operationIdentityKey(record.cycle, record.actor, record.index);
  if (recording.operations.has(key)) return;
  await artifacts.appendJsonl("operations", record);
  recording.operations.add(key);
}

/**
 * Appends one resource sample unless its cycle was already recorded.
 */
async function recordResourceIfAbsent(recording, artifacts, record) {
  if (recording.resources.has(record.cycle)) return;
  await artifacts.appendJsonl("resources", record);
  recording.resources.add(record.cycle);
}

/**
 * Completes the bookkeeping of a cycle whose SQLite work AND cycle record
 * fully landed but whose state checkpoint never did (resume recovery).
 *
 * HIGH 1: the recorded cycle is NEVER trusted merely because its JSONL
 * record parses or carries a resource sample. Before ANY state advance,
 * the completion claim is re-proven here against the exact deterministic
 * plan AND the exact SQLite rows/content of that cycle:
 * - an ambiguous abort record cannot prove its committed extent (fail
 *   closed); a non-aborted record must report the exact deterministic
 *   full-cycle totals, and every non-aborted actor identity of the
 *   deterministic stream must be recorded in operations.jsonl,
 * - SQLite must contain EXACTLY the deterministic rows of the recorded
 *   cycle (every id present with matching content, nothing extra,
 *   nothing partial) — state is never advanced from incomplete SQLite.
 * The cycle's resource sample is written by this recovery (in the live
 * loop it lands after the state checkpoint, so it cannot pre-exist in
 * this interruption window); any existing sample already passed the
 * strict JSONL history validation.
 *
 * After the proof, the cumulative counters are advanced from the RECORDED
 * totals (so state stays exactly consistent with the JSONL history),
 * tableRows come from the oracle rebuilt from SQLite, the resource sample
 * and completed marker are written, and nothing is re-executed — no
 * duplicate rows, no duplicate records, no double-counted work.
 */
async function completeRecordedCycle({
  cycle,
  state,
  artifacts,
  recording,
  oracle,
  activeEntities,
  tokenByEntity,
  hikoutei,
  dbName,
  progress,
}) {
  const record = recording.cycleRecords.get(cycle);
  if (record === undefined) {
    throw new Error(`recovery invariant violated: cycle ${cycle} record missing`);
  }
  // Read the authority's FULL row sets exactly once: the same rows feed
  // the DB-backed probe evidence (an ok probe is trusted for the replay
  // oracle mutation only when the authority contains the deterministic
  // human-edit value for that exact cycle/table/field) and the exact
  // SQLite proof below.
  const observedByTable = await readObservedRows(hikoutei, activeEntities, tokenByEntity);
  const probeEvidence = buildProbeEvidence({
    state: { ...state, lastCompletedCycle: cycle - 1 },
    activeEntities,
    cycleByNumber: recording.cycleRecords,
    inFlightCycle: cycle,
    observedByTable,
  });
  // HIGH 1 completion proof (see function doc). The replay below is a pure
  // function of the stored seed/params — the recorded cycle's expected
  // rows never depend on what SQLite happens to hold (the only
  // SQLite-derived input is the DB-backed probe evidence above, which
  // decides which recorded ok probes are trusted for the oracle
  // mutation).
  const replay = replayDeterministicHistory({
    state: { ...state, lastCompletedCycle: cycle - 1 },
    activeEntities,
    // Luna: the COMPLETE validated cycle-record history is replayed, not
    // just the current cycle's record. Earlier recorded cycles carry
    // their own probe evidence, so a successful human-edit probe at an
    // earlier cycle (e.g. cycle 10) applies its exact content override at
    // THAT cycle/target during the replay — otherwise the oracle state at
    // the recorded cycle would differ from the authority and valid SQLite
    // content from earlier probes would be rejected as tampered when
    // resuming at a later recorded cycle (e.g. cycle 60). The map holds
    // only validated records within the checkpointed window (nothing
    // ahead of the in-flight cycle), so records before `cycle` replay
    // exactly with their probe overrides and the in-flight record itself
    // stays the completion proof.
    cycleByNumber: recording.cycleRecords,
    inFlightCycle: cycle,
    probeEvidence,
  });
  // A structurally valid ok probe WITHOUT the authority evidence (forged
  // record with adjusted counters, unchanged DB) is tampered history:
  // the replay oracle was never mutated by it and state never advances.
  requireProbeEvidenceOrFail(replay);
  if (replay.ambiguousAbortCycles.length > 0) {
    throw new Error(
      `--resume failed: cycle ${cycle} has an abort record whose committed ` +
      "extent cannot be proven; refusing to advance state from an unprovable recorded cycle",
    );
  }
  if (record.abort === undefined || isProvableFullCycleAbort(record)) {
    const expectedActorOpsPerCycle = state.params.actors * state.params.operationsPerActor;
    const expectedPrologueOpsPerCycle = 4 * activeEntities.length;
    if (record.abort === undefined &&
        record.operations !== expectedActorOpsPerCycle + expectedPrologueOpsPerCycle) {
      throw new Error(
        `--resume failed: cycle ${cycle} record reports ${record.operations} operations, ` +
        `but the deterministic plan implies ${expectedActorOpsPerCycle + expectedPrologueOpsPerCycle}`,
      );
    }
    // A PROVABLE reopen/deadline abort claims the FULL cycle ran too (the
    // abort only fires after every actor record landed), so its missing
    // suffix records are forged history and the exact grid is required
    // before state advances from the recorded totals.
    for (let actor = 0; actor < state.params.actors; actor += 1) {
      for (let index = 0; index < state.params.operationsPerActor; index += 1) {
        if (!recording.operations.has(operationIdentityKey(cycle, actor, index))) {
          throw new Error(
            `--resume failed: cycle ${cycle} record claims completion but operation ` +
            `identity (actor ${actor}, index ${index}) is missing from operations.jsonl`,
          );
        }
      }
    }
  }
  // Exact SQLite proof: the recorded cycle's deterministic rows (ids AND
  // content) must be present EXACTLY — a missing, tampered, or partial
  // row never advances state.
  for (const entry of activeEntities) {
    const observed = observedByTable.get(entry.tableName) ?? new Map();
    const exact = replay.exactRowsByTable.get(entry.tableName) ?? new Map();
    if (observed.size !== exact.size) {
      throw new Error(
        `--resume failed: recorded cycle ${cycle} is incomplete in soak.sqlite ` +
        `table ${entry.tableName} (found ${observed.size} rows, expected ${exact.size} ` +
        "deterministic rows); refusing to advance state from incomplete SQLite",
      );
    }
    const fieldPlan = SOAK_FIELD_PLANS[entry.name];
    for (const [id, contents] of exact) {
      const row = observed.get(id);
      if (row === undefined) {
        throw new Error(
          `--resume failed: recorded cycle ${cycle} is missing deterministic row ` +
          `${id} in table ${entry.tableName}; refusing to advance state from incomplete SQLite`,
        );
      }
      if (!contents.some((content) => rowValuesEqual(content, row, fieldPlan))) {
        throw new Error(
          `--resume failed: recorded cycle ${cycle} row ${id} in table ` +
          `${entry.tableName} has content that does not match the deterministic ` +
          "state; refusing to advance state from tampered SQLite",
        );
      }
    }
  }
  state.lastCompletedCycle = cycle;
  state.cumulative.operations += record.operations;
  state.cumulative.expectedErrors += record.expectedErrors;
  state.cumulative.failures += record.failures;
  state.cumulative.retries += record.retries;
  if (record.probe !== undefined) {
    state.cumulative.probes.total += 1;
    if (record.probe.status === "ok") state.cumulative.probes.ok += 1;
    if (record.probe.status === "skipped") state.cumulative.probes.skipped += 1;
    if (record.probe.status === "failed") state.cumulative.probes.failed += 1;
  }
  if (record.convergence !== undefined) {
    state.cumulative.convergenceChecks += 1;
    if (record.convergence.status === "failed") state.cumulative.convergenceFailed += 1;
  }
  state.tableRows = Object.fromEntries(
    activeEntities.map((entry) => [entry.tableName, oracle.size(entry.name)]),
  );
  await artifacts.writeJson("state", state);
  await recordResourceIfAbsent(recording, artifacts, await resourceRecord(
    cycle,
    await artifacts.databaseSizeBytes(dbName),
  ));
  await artifacts.writeCheckpoint(checkpointMarker(state.runId, cycle, "completed"));
  progress(`recovery: cycle ${cycle} was fully executed but uncheckpointed; advanced state from its recorded totals`);
}

// Recorded bookkeeping (tracking + idempotent appends) consumed by
// runner/execute/cycle orchestration; the completion proof is consumed by
// the runner's recovery path.
export {
  completeRecordedCycle,
  createRecordingTracker,
  recordCycleIfAbsent,
  recordOperationIfAbsent,
  recordResourceIfAbsent,
};
