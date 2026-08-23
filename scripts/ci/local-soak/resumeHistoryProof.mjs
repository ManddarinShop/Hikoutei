/**
 * Resume JSONL HISTORY cross-file integrity proof for the soak runner:
 * validates the COMPLETE recovery history — cycle window/identity,
 * cadence-derived sections, deterministic replay binding, actor-grid
 * prefix rules, and exact cumulative totals — BEFORE any runtime opens
 * or mutates. Split from the resume facade so each module stays
 * review-sized; `resumeHistory.mjs` re-exports the shared surface and
 * the per-record schema checks live in `resumeHistorySchema.mjs`. No
 * cycle with execute or probe.
 */
import { PROBE_EVERY_CYCLES, REOPEN_EVERY_CYCLES } from "./constants.mjs";
import { SOAK_ENTITY_ORDER } from "./entities.mjs";
import { composeScenarioBatch, SCENARIO_PHASE_VALUES } from "./scenarios/scheduler.mjs";
import { SCENARIO_REGISTRY } from "./scenarios/registry.mjs";
import {
  expectedTablesTouchedForCycle,
  hasEditableProbeField,
  operationIdentityKey,
  replayDeterministicHistory,
} from "./replay.mjs";
import {
  LIVE_PROBE_FAILURE_REASONS,
  readStrictJsonlRecords,
  validateCycleRecordShape,
  validateOperationRecordShape,
  validateResourceRecordShape,
} from "./resumeHistorySchema.mjs";

/**
 * True when an abort record's reason PROVES the full cycle executed
 * before the abort.
 *
 * The reopen-cleanup and deadline-expired aborts only fire in the reopen
 * phase of a cadence cycle, which runs AFTER every actor record landed
 * (the record loop appends actor-major before verification/probe/
 * convergence/reopen). Those cycles must therefore hold the EXACT full
 * actor grid like a completed cycle; every other abort reason may have
 * stopped mid-stream and is only ever allowed a contiguous prefix.
 *
 * @param {object | undefined} record one cycle record.
 * @returns {boolean}
 */
function isProvableFullCycleAbort(record) {
  return record?.abort !== undefined &&
    (record.abort.reason === "reopen-cleanup-failed" ||
     record.abort.reason === "deadline-expired");
}

/**
 * Binds one cycle record's scenario section to the DETERMINISTIC batch the
 * stored seed actually composes for that cycle.
 *
 * The recorded id/phase/order/tag must come from the seed's own
 * `composeScenarioBatch` for that cycle (a pure function of seed + cycle +
 * the registry), so a forged record that uses the right vocabulary but a
 * batch the seed never produces is tampered history. The batch is composed
 * with the SAME active entity/table subset the run used (reconstructed
 * from the persisted `state.params.resolvedTables`), so a subset run's
 * plans never point at an inactive entity and a full-registry recomposition
 * (which would select targets outside the persisted subset) is never
 * silently substituted.
 *
 * Completed (non-abort) cycles must hold the EXACT full batch: every
 * composed scenario, with the exact id/phase/order/tag, in order (status and
 * counters may reflect execution). An ABORT cycle may hold a valid ordered
 * subset/prefix consistent with STARTED PHASES: since phases execute in
 * order (after-prologue, concurrent-with-actors, after-actors) and a phase
 * only runs after the previous one completed, the recorded scenarios must
 * be the composed scenarios of the started phases — every earlier phase
 * fully present, the aborted phase present as a (possibly partial) subset,
 * and no later phase present. A record with NO scenario section (legacy)
 * is compatible and passes.
 *
 * @param {number} seed the stored run seed.
 * @param {number} cycle the cycle number.
 * @param {object} record the validated cycle record.
 * @param {readonly object[] | undefined} [activeEntities] the persisted
 *   active entity/table subset the run composed the batch with; undefined
 *   means a full run (every registered entity is active).
 * @returns {string | undefined} an error reason, or undefined when valid.
 */
export function validateCycleScenarioBatch(seed, cycle, record, activeEntities) {
  const recorded = record.scenarios;
  if (recorded === undefined) return undefined; // legacy: no scenario section
  const batch = composeScenarioBatch({ seed, cycle, registry: SCENARIO_REGISTRY, activeEntities });
  const expected = batch.scenarios
    .map((entry) => ({
      id: entry.id,
      phase: entry.phase,
      order: entry.order,
      tag: entry.plan?.tag,
      // HIGH target-table proof: the recomposed plan's allowlisted soak
      // table. The recorded batch must bind to the SAME active subset, so a
      // full-registry record (whose targetTables span tables outside a
      // one-table subset) fails even when id/phase/order/tag coincide.
      targetTable: entry.targetTable,
    }))
    .sort((a, b) => a.order - b.order);
  const byOrder = new Map(expected.map((entry) => [entry.order, entry]));
  // Every recorded scenario must be an entry the seed actually composed for
  // this cycle (same order, id, phase, tag) — vocabulary alone is never proof.
  for (const entry of recorded) {
    const exp = byOrder.get(entry.order);
    if (exp === undefined || exp.id !== entry.id || exp.phase !== entry.phase || exp.tag !== entry.tag) {
      return `recorded scenario order ${entry.order} (${entry.id}/${entry.phase}/${entry.tag}) is not in the seed's batch for this cycle`;
    }
    // HIGH target-table proof: EVERY recorded scenario entry must bind to
    // the SAME active subset the plan recomposes under — a missing,
    // unknown, or wrong-but-known targetTable fails even when
    // id/phase/order/tag coincide. Backward compatibility applies only when
    // the ENTIRE scenarios section is absent (legacy), never to an entry
    // that exists without a target-table proof. The expected target table is
    // the recomposed plan's allowlisted soak table, so an entry whose
    // targetTable differs (or is absent) is tampered history.
    if (entry.targetTable !== exp.targetTable) {
      return `recorded scenario order ${entry.order} (${entry.id}) targets table ${entry.targetTable}, but the active subset composes ${exp.targetTable}; the recorded batch does not bind to this subset`;
    }
  }
  const isAbort = record.abort !== undefined;
  if (!isAbort) {
    // Completed cycle: EXACT full batch, one entry per composed scenario.
    if (recorded.length !== expected.length) {
      return `completed cycle recorded ${recorded.length} scenarios but the seed composes ${expected.length}`;
    }
    return undefined;
  }
  // Abort cycle: a valid ordered subset/prefix consistent with started
  // phases. Every earlier phase is fully present, the aborted phase is a
  // subset, and no later phase is present.
  const phaseIndex = new Map(SCENARIO_PHASE_VALUES.map((phase, index) => [phase, index]));
  const recordedPhaseIndexes = recorded.map((entry) => phaseIndex.get(entry.phase) ?? -1);
  const maxPhase = Math.max(...recordedPhaseIndexes);
  for (const entry of expected) {
    const index = phaseIndex.get(entry.phase) ?? -1;
    if (index < maxPhase && !recorded.some((r) => r.order === entry.order)) {
      return `abort cycle omits a scenario (order ${entry.order}) from an earlier started phase`;
    }
    if (index > maxPhase && recorded.some((r) => r.order === entry.order)) {
      return `abort cycle records a scenario (order ${entry.order}) from a phase that cannot have started`;
    }
  }
  return undefined;
}

/**
 * HIGH 2: validates the COMPLETE JSONL recovery history of a resume.
 *
 * Runs BEFORE any runtime opens or mutates. No parseable line is trusted
 * as completion proof: every cycle/operation/resource record must match
 * the exact schema and redaction vocabularies, cycle identities must be
 * contiguous with no gaps or duplicates and nothing outside the
 * checkpointed window, abort records must match the runner's exact
 * one-failed-unit contract, every operation record must bind to the
 * deterministic stream the stored seed generates (identity inside
 * `actors x operationsPerActor`, kind/table equal to the seed's own
 * plan), non-aborted cycles must hold the EXACT full actor grid while
 * aborted/in-flight cycles may only hold a contiguous actor prefix, every
 * checkpointed cycle must have exactly one resource sample, and the
 * summed record totals must equal the state's cumulative counters
 * EXACTLY (states carrying close/finalization failure markers are
 * rejected earlier, so no unrecorded failure increment can exist here).
 * Every violation is a safe pre-mutation failure; the only deterministic
 * reconcile left to the recovery planner is the interrupted in-flight
 * cycle with no record.
 *
 * @param {object} artifacts artifact writer (paths only are used).
 * @param {object} state validated resume state.
 * @param {object | undefined} checkpoint validated checkpoint marker.
 * @returns {Promise<void>} throws with a stable `--resume failed: ...`
 *   reason on the first integrity violation.
 */
export async function validateResumeHistory(artifacts, state, checkpoint) {
  const fail = (message) => {
    throw new Error(`--resume failed: ${message}`);
  };
  const cycles = await readStrictJsonlRecords(
    artifacts.paths.cycles, "cycles.jsonl", fail);
  const operations = await readStrictJsonlRecords(
    artifacts.paths.operations, "operations.jsonl", fail);
  const resources = await readStrictJsonlRecords(
    artifacts.paths.resources, "resources.jsonl", fail);

  // Exact cycle-record schema + identity (one record per cycle).
  const cycleByNumber = new Map();
  for (const record of cycles) {
    const shape = validateCycleRecordShape(record);
    if (!shape.ok) fail(`cycles.jsonl contains an invalid record: ${shape.reason}`);
    if (cycleByNumber.has(record.cycle)) {
      fail(`cycles.jsonl contains a duplicate record for cycle ${record.cycle}`);
    }
    cycleByNumber.set(record.cycle, record);
  }

  // MEDIUM: a cycle's scenario section must bind to the DETERMINISTIC batch
  // the stored seed actually composes for that cycle (seed + cycle + active
  // entity subset + registry). Valid vocabulary alone is not enough: a
  // forged record with the right id/tag/phase vocabulary but a batch that
  // the seed never produces for that cycle is tampered history. The active
  // subset is reconstructed from the persisted `resolvedTables` and threaded
  // into the recomposition so a subset run's plans never point at an
  // inactive entity and the proof never silently recomposes under the full
  // registry when a persisted nonempty subset exists.
  const activeEntities = SOAK_ENTITY_ORDER.filter((entry) =>
    state.params.resolvedTables.includes(entry.tableName));
  for (const [cycle, record] of cycleByNumber) {
    const binding = validateCycleScenarioBatch(state.seed, cycle, record, activeEntities);
    if (binding !== undefined) {
      fail(`cycles.jsonl cycle ${cycle} scenario section does not match the deterministic batch the stored seed composes: ${binding}`);
    }
  }

  // Expected abort exceptions have an EXACT deterministic shape: one
  // attempted-and-failed unit, no executed-work fields, no sections.
  for (const record of cycleByNumber.values()) {
    if (record.abort === undefined) continue;
    if (record.operations !== 1 || record.expectedErrors !== 0 ||
        record.failures !== 1 || record.retries !== 0 ||
        record.durationMs !== 0 || (record.tablesTouched ?? []).length !== 0 ||
        record.probe !== undefined || record.convergence !== undefined ||
        record.reopen !== undefined) {
      fail(`cycles.jsonl cycle ${record.cycle} has an abort record whose shape does not match the runner's exact abort contract (operations 1, failures 1, no executed-work fields)`);
    }
  }

  // Contiguous cycle window: an in-flight marker for the NEXT cycle is the
  // only record that may exist beyond the checkpointed state.
  const inflightCycle = checkpoint?.status === "in-flight" ? checkpoint.cycle : undefined;
  for (const cycle of cycleByNumber.keys()) {
    if (cycle > state.lastCompletedCycle + 1) {
      fail(`cycles.jsonl contains a record for cycle ${cycle}, ahead of the checkpointed state`);
    }
  }
  if (cycleByNumber.has(state.lastCompletedCycle + 1) &&
      inflightCycle !== state.lastCompletedCycle + 1) {
    fail(`cycles.jsonl records cycle ${state.lastCompletedCycle + 1} but the checkpoint does not mark it in-flight`);
  }

  // MEDIUM 8: required redacted cycle sections are derived from the
  // CURRENT mode and cadence and validated BEFORE any state advance — a
  // recorded cycle can never omit a section the runner would have written
  // or carry a section the mode/cadence cannot produce. The abort record
  // is the ONLY shape exempt from these sections (the reopen cadence can
  // legitimately abort as the exact abort shape above); any other
  // missing/tampered section fails the resume closed. Runs after the
  // window checks so a forged record BEYOND the checkpointed window is
  // rejected as out-of-window first, never as a section anomaly.
  // Every cycle touches every active table in the prologue (table names)
  // and every planned actor operation touches the entity its deterministic
  // round-robin slot selects (entity names), so the runner's sorted deduped
  // `tablesTouched` is EXACTLY the plan-derived union — a low-workload
  // config (e.g. actors=1, operationsPerActor=1) only touches the entity
  // names the stored actor stream actually selects, never every active
  // entity.
  const expectedTablesTouched = expectedTablesTouchedForCycle(state, activeEntities);
  for (const [cycle, record] of cycleByNumber) {
    if (record.abort !== undefined) continue; // exact abort shape checked above
    // Every probe cadence cycle runs a probe; the runner never writes one
    // off-cadence, so a misplaced section is tampering too.
    if (cycle % PROBE_EVERY_CYCLES === 0 && record.probe === undefined) {
      fail(`cycles.jsonl cycle ${cycle} is on the probe cadence but has no probe section`);
    }
    if (record.probe !== undefined && cycle % PROBE_EVERY_CYCLES !== 0) {
      fail(`cycles.jsonl cycle ${cycle} carries a probe section off the probe cadence`);
    }
    if (record.probe !== undefined && state.mode === "local") {
      // The local probe is EXACTLY { status: "skipped", reason:
      // "local-mode" }: the runner writes no table or other field for it,
      // so any extra field is tampering.
      if (record.probe.status !== "skipped" || record.probe.reason !== "local-mode" ||
          Object.keys(record.probe).length !== 2) {
        fail(`cycles.jsonl cycle ${cycle} carries a probe shape a local-mode run can never produce (the documented local shape is exactly skipped/local-mode with no other fields)`);
      }
    }
    if (record.probe !== undefined && state.mode === "live") {
      // Live probes target the deterministic round-robin entity for the
      // cycle (the same rotation as runHumanEditProbe), so the recorded
      // table is provable from (cycle, active entities) alone.
      const probeTarget = activeEntities[
        Math.floor(cycle / PROBE_EVERY_CYCLES) % activeEntities.length
      ];
      const probeTable = probeTarget.tableName;
      if (record.probe.table !== probeTable) {
        fail(`cycles.jsonl cycle ${cycle} probe.table does not match the deterministic round-robin target (${probeTable})`);
      }
      if (record.probe.status === "ok") {
        // An accepted live probe is EXACTLY { status: "ok", table }.
        if (record.probe.reason !== undefined || Object.keys(record.probe).length !== 2) {
          fail(`cycles.jsonl cycle ${cycle} carries an ok probe with fields an ok probe never has (status/table only)`);
        }
      } else if (record.probe.status === "failed") {
        // A failed live probe is EXACTLY { status, reason, table } with a
        // reason the runner can actually record after redaction.
        if (!LIVE_PROBE_FAILURE_REASONS.includes(record.probe.reason)) {
          fail(`cycles.jsonl cycle ${cycle} probe failure reason is not one a live run can produce`);
        }
        if (Object.keys(record.probe).length !== 3) {
          fail(`cycles.jsonl cycle ${cycle} carries a failed probe with fields a failed probe never has (status/reason/table only)`);
        }
      } else if (record.probe.status === "skipped" &&
          (hasEditableProbeField(probeTarget) ||
           record.probe.reason !== "no-string-field" ||
           Object.keys(record.probe).length !== 2)) {
        // The only live skip shape is the no-editable-field case, which
        // none of the soak entities can produce.
        fail(`cycles.jsonl cycle ${cycle} carries a skipped probe a live run can never produce`);
      }
    }
    // Live cycles always run the convergence check; local cycles never do.
    if (state.mode === "live") {
      if (record.convergence === undefined) {
        fail(`cycles.jsonl cycle ${cycle} is a live-mode cycle but has no convergence section`);
      }
    } else if (record.convergence !== undefined) {
      fail(`cycles.jsonl cycle ${cycle} carries a convergence section in local mode`);
    }
    // Every reopen cadence cycle ends with a reopen result; the abort
    // shape above is the explicit exception (the reopen itself failed).
    if (cycle % REOPEN_EVERY_CYCLES === 0 && record.reopen === undefined) {
      fail(`cycles.jsonl cycle ${cycle} is on the reopen cadence but has no reopen result`);
    }
    if (record.reopen !== undefined && cycle % REOPEN_EVERY_CYCLES !== 0) {
      fail(`cycles.jsonl cycle ${cycle} carries a reopen result off the reopen cadence`);
    }
    // The touched-table set must equal the deterministic plan union
    // exactly: a missing or extra table/entity name means the record was
    // forged or the run's tables were tampered. The expectation is a pure
    // function of the stored params (prologue tables + the entity names of
    // the planned actor round-robin slots), so valid low-workload runs
    // pass and only tampered names are rejected.
    if (JSON.stringify(record.tablesTouched) !== JSON.stringify(expectedTablesTouched)) {
      fail(`cycles.jsonl cycle ${cycle} tablesTouched does not match the deterministic plan-derived table set`);
    }
  }

  // HIGH 2: bind every record to the deterministic stream the stored seed
  // generates. The replay reproduces the exact planning pass (sequential
  // prologue + up-front actor planning), so every (cycle, actor, index)
  // identity, kind, and table can be checked against what the seed
  // ACTUALLY produces — a forged record can never masquerade as a
  // different op of the same stream.
  const replay = replayDeterministicHistory({
    state,
    activeEntities,
    cycleByNumber,
    inFlightCycle: inflightCycle === state.lastCompletedCycle + 1 ? inflightCycle : undefined,
  });
  if (replay.ambiguousAbortCycles.length > 0) {
    fail(`cycles.jsonl records an abort for cycle ${replay.ambiguousAbortCycles[0]} whose committed extent cannot be proven; the recovery history cannot be trusted (start a fresh run without --resume)`);
  }

  // MEDIUM: the reopen section is bound to the exact active-table set AND
  // the deterministic replay. The reopen verify counts SQLite rows after
  // the full cycle executed, which the replay reproduces exactly, so a
  // missing/extra table or a tampered count is forged history.
  const expectedReopenTables = activeEntities
    .map((entry) => entry.tableName)
    .sort();
  for (const [cycle, record] of cycleByNumber) {
    if (record.reopen === undefined) continue;
    const reopenTables = Object.keys(record.reopen)
      .filter((key) => key !== "status" && key !== "scan")
      .sort();
    if (JSON.stringify(reopenTables) !== JSON.stringify(expectedReopenTables)) {
      fail(`cycles.jsonl cycle ${cycle} reopen counts do not cover exactly the active tables (${expectedReopenTables.join(", ")})`);
    }
    const expectedCounts = replay.cycleTableRows.get(cycle);
    if (expectedCounts === undefined) {
      fail(`cycles.jsonl cycle ${cycle} reopen counts cannot be bound to the deterministic replay`);
    }
    // Luna: the runner emits `status: "ok"` only when BOTH the full-scan
    // evidence and the post-reopen count evidence matched the oracle
    // exactly (the recorded counts are then exactly the replayed
    // post-cycle counts); it emits `status: "failed"` when EITHER the
    // scan or the counts differed (the recorded counts are the OBSERVED
    // counts, so a count-differing failure carries at least one count
    // that differs from the replay, while a same-count scan failure — id
    // loss/extra rows or content mismatch with equal counts — carries the
    // failed scan evidence with matching counts). A forged ok status with
    // failed scan evidence, a forged ok status carrying evidence-differing
    // counts, or a forged failed status with ok scan evidence AND exact
    // successful counts is tampered history.
    const mismatchedTables = expectedReopenTables.filter(
      (table) => record.reopen[table] !== expectedCounts[table],
    );
    if (record.reopen.status === "ok") {
      if (mismatchedTables.length > 0) {
        fail(`cycles.jsonl cycle ${cycle} reopen count for ${mismatchedTables[0]} (${record.reopen[mismatchedTables[0]]}) does not match the deterministic replay (${expectedCounts[mismatchedTables[0]]})`);
      }
      if (record.reopen.scan !== "ok") {
        fail(`cycles.jsonl cycle ${cycle} reports an ok reopen but the full-scan evidence is failed; an ok status requires ok scan evidence (a failed scan must never be accepted as ok)`);
      }
    }
    if (record.reopen.status === "failed" &&
        mismatchedTables.length === 0 && record.reopen.scan === "ok") {
      fail(`cycles.jsonl cycle ${cycle} reports a failed reopen but the full-scan evidence is ok and every count matches the deterministic replay; a failed reopen must carry evidence-differing counts or failed scan evidence`);
    }
  }

  // Exact operation-record schema + identity (unique cycle/actor/index),
  // plus the deterministic plan binding for EVERY record.
  const opKeys = new Set();
  const opKeysByCycle = new Map();
  for (const record of operations) {
    const shape = validateOperationRecordShape(record);
    if (!shape.ok) fail(`operations.jsonl contains an invalid record: ${shape.reason}`);
    if (record.cycle > state.lastCompletedCycle + 1) {
      fail(`operations.jsonl contains a record for cycle ${record.cycle}, ahead of the checkpointed state`);
    }
    if (record.cycle === state.lastCompletedCycle + 1 &&
        inflightCycle !== state.lastCompletedCycle + 1) {
      fail(`operations.jsonl records cycle ${state.lastCompletedCycle + 1} but the checkpoint does not mark it in-flight`);
    }
    const key = operationIdentityKey(record.cycle, record.actor, record.index);
    if (opKeys.has(key)) {
      fail(`operations.jsonl contains a duplicate record (cycle ${record.cycle}, actor ${record.actor}, index ${record.index})`);
    }
    opKeys.add(key);
    const plan = replay.plans.get(key);
    if (plan === undefined) {
      fail(`operations.jsonl records an identity (cycle ${record.cycle}, actor ${record.actor}, index ${record.index}) outside the deterministic actor stream of this seed`);
    }
    if (record.kind !== plan.kind || record.table !== plan.entityName) {
      fail(`operations.jsonl cycle ${record.cycle} actor ${record.actor} index ${record.index} records a kind/table the stored seed does not generate for that identity`);
    }
    let cycleKeys = opKeysByCycle.get(record.cycle);
    if (cycleKeys === undefined) {
      cycleKeys = new Set();
      opKeysByCycle.set(record.cycle, cycleKeys);
    }
    cycleKeys.add(`${record.actor}:${record.index}`);
  }

  // Exact resource-record schema + identity (unique sample per cycle).
  const resourceCycles = new Set();
  for (const record of resources) {
    const shape = validateResourceRecordShape(record);
    if (!shape.ok) fail(`resources.jsonl contains an invalid record: ${shape.reason}`);
    if (resourceCycles.has(record.cycle)) {
      fail(`resources.jsonl contains a duplicate sample for cycle ${record.cycle}`);
    }
    resourceCycles.add(record.cycle);
  }

  // Cycle identity: every completed cycle must have exactly one record. A
  // gap means records were lost AFTER the state checkpointed them
  // (history is append-only) — a safe pre-mutation failure.
  for (let cycle = 1; cycle <= state.lastCompletedCycle; cycle += 1) {
    if (!cycleByNumber.has(cycle)) {
      fail(`cycles.jsonl is missing the record for completed cycle ${cycle}; the history contradicts state.json`);
    }
  }

  // Exactly one resource sample per recorded/completed cycle, and none
  // out of the window. The ONLY tolerated absence is the stale in-flight
  // marker (cycle == lastCompletedCycle): its repair backfills the sample.
  const staleMarkerCycle = checkpoint?.status === "in-flight" &&
    checkpoint.cycle === state.lastCompletedCycle
    ? checkpoint.cycle
    : undefined;
  for (let cycle = 1; cycle <= state.lastCompletedCycle; cycle += 1) {
    if (!resourceCycles.has(cycle) && cycle !== staleMarkerCycle) {
      fail(`resources.jsonl is missing the sample for completed cycle ${cycle}; every checkpointed cycle must have exactly one resource sample`);
    }
  }
  for (const cycle of resourceCycles) {
    if (cycle > state.lastCompletedCycle) {
      fail(`resources.jsonl contains a sample for cycle ${cycle}, beyond the checkpointed state`);
    }
  }

  // Cross-file identity with the deterministic workload shape: each cycle
  // executes exactly `actors x operationsPerActor` actor operations (each
  // recorded once in operations.jsonl) plus the fixed prologue (4 ops per
  // active table: two inserts, one update, one delete). A non-aborted
  // cycle record must therefore report the exact flat total AND its
  // operation records must be EXACTLY the full (actor, index) grid of the
  // deterministic stream. A PROVABLE abort (reopen cleanup / deadline
  // expired) is NOT an exception: it only fires in the reopen phase after
  // every actor record landed, so its operation records must also be the
  // EXACT full grid — a truncated suffix is forged history. Only an
  // AMBIGUOUS abort (a mid-cycle error) or a recordless interrupted cycle
  // is the documented prefix exception: its record carries the synthetic
  // total of 1 while its actor records are whatever actually ran — a
  // contiguous actor prefix (the record loop appends actor-major, so an
  // interruption can only truncate the stream, never gap or reorder it).
  const expectedActorOpsPerCycle = state.params.actors * state.params.operationsPerActor;
  const expectedPrologueOpsPerCycle = 4 * state.params.resolvedTables.length;
  const fullActorGrid = new Set();
  for (let actor = 0; actor < state.params.actors; actor += 1) {
    for (let index = 0; index < state.params.operationsPerActor; index += 1) {
      fullActorGrid.add(`${actor}:${index}`);
    }
  }
  for (const [cycle, record] of cycleByNumber) {
    // A PROVABLE abort (reopen cleanup / deadline expired) only fires in
    // the reopen phase, after every actor record landed: those cycles must
    // hold the EXACT full actor grid like a completed cycle. Only an
    // ambiguous abort (a mid-cycle error) may hold a prefix, and the
    // recordless interrupted cycle is handled by the prefix rule below.
    if (record.abort !== undefined && !isProvableFullCycleAbort(record)) continue;
    if (record.abort === undefined &&
        record.operations !== expectedActorOpsPerCycle + expectedPrologueOpsPerCycle) {
      fail(`cycles.jsonl cycle ${cycle} reports ${record.operations} operations, but the params imply ${expectedActorOpsPerCycle + expectedPrologueOpsPerCycle}`);
    }
    const keys = opKeysByCycle.get(cycle) ?? new Set();
    if (keys.size !== fullActorGrid.size ||
        [...fullActorGrid].some((key) => !keys.has(key))) {
      fail(record.abort !== undefined
        ? `operations.jsonl cycle ${cycle} records ${keys.size} of ${expectedActorOpsPerCycle} actor operations, but a ${record.abort.reason} abort can only follow the FULL cycle`
        : `operations.jsonl has ${keys.size} record(s) for cycle ${cycle}, but the params imply ${expectedActorOpsPerCycle} actor operations`);
    }
  }
  for (const [cycle, keys] of opKeysByCycle) {
    const record = cycleByNumber.get(cycle);
    if (record !== undefined &&
        (record.abort === undefined || isProvableFullCycleAbort(record))) {
      continue; // full grid required above
    }
    if (actorPrefixExtent(keys, state.params.actors, state.params.operationsPerActor) < 0) {
      fail(`operations.jsonl cycle ${cycle} is gapped or out of order; an interrupted or aborted cycle must record a contiguous actor prefix`);
    }
  }

  // Consistent cumulative totals: the summed record history must equal the
  // state counters EXACTLY.
  let totalOperations = 0;
  let totalExpectedErrors = 0;
  let totalFailures = 0;
  let totalRetries = 0;
  let totalScenarioExpectedErrors = 0;
  let totalScenarioFailures = 0;
  let probesTotal = 0;
  let probesOk = 0;
  let probesSkipped = 0;
  let probesFailed = 0;
  let convergenceChecks = 0;
  let convergenceFailed = 0;
  for (let cycle = 1; cycle <= state.lastCompletedCycle; cycle += 1) {
    const record = cycleByNumber.get(cycle);
    totalOperations += record.operations;
    totalExpectedErrors += record.expectedErrors;
    totalFailures += record.failures;
    totalRetries += record.retries;
    if (record.scenarioTotals !== undefined) {
      totalScenarioExpectedErrors += record.scenarioTotals.expectedErrors;
      totalScenarioFailures += record.scenarioTotals.failures;
    }
    if (record.probe !== undefined) {
      probesTotal += 1;
      if (record.probe.status === "ok") probesOk += 1;
      else if (record.probe.status === "skipped") probesSkipped += 1;
      else probesFailed += 1;
    }
    if (record.convergence !== undefined) {
      convergenceChecks += 1;
      if (record.convergence.status === "failed") convergenceFailed += 1;
    }
  }
  const cumulative = state.cumulative;
  const mismatches = [];
  if (totalOperations !== cumulative.operations) mismatches.push("operations");
  if (totalExpectedErrors !== cumulative.expectedErrors) mismatches.push("expectedErrors");
  if (totalFailures !== cumulative.failures) mismatches.push("failures");
  if (totalRetries !== cumulative.retries) mismatches.push("retries");
  // Scenario totals are SEPARATE from the standard operation counters but
  // must still match the state's dedicated scenario counters exactly (a
  // legacy state without scenario counters defaults to zero).
  if (totalScenarioExpectedErrors !== (cumulative.scenarioExpectedErrors ?? 0)) {
    mismatches.push("scenarioExpectedErrors");
  }
  if (totalScenarioFailures !== (cumulative.scenarioFailures ?? 0)) {
    mismatches.push("scenarioFailures");
  }
  if (probesTotal !== cumulative.probes.total || probesOk !== cumulative.probes.ok ||
      probesSkipped !== cumulative.probes.skipped || probesFailed !== cumulative.probes.failed) {
    mismatches.push("probes");
  }
  if (convergenceChecks !== cumulative.convergenceChecks ||
      convergenceFailed !== cumulative.convergenceFailed) {
    mismatches.push("convergence");
  }
  if (mismatches.length > 0) {
    fail(`state.cumulative counters do not match the recorded cycle history (${mismatches.join(", ")})`);
  }
}

/**
 * HIGH 2: extent of one cycle's recorded (actor, index) key set as a
 * contiguous lexicographic prefix of the deterministic actor stream.
 *
 * The record loop appends actor-major, index-ascending, so an interrupted
 * or aborted cycle can only ever leave a prefix: actors before the cut
 * fully recorded, the cut actor partially, nothing after. Returns the
 * prefix length, or -1 when the set is gapped or contains keys beyond the
 * first gap (a forged or reordered history).
 *
 * @param {Set<string>} keys recorded `actor:index` keys.
 * @param {number} actors number of actors.
 * @param {number} opsPerActor operations per actor.
 * @returns {number} prefix length, or -1 for a non-prefix set.
 */
function actorPrefixExtent(keys, actors, opsPerActor) {
  let extent = 0;
  let cut = false;
  for (let actor = 0; actor < actors; actor += 1) {
    for (let index = 0; index < opsPerActor; index += 1) {
      const key = `${actor}:${index}`;
      if (cut) {
        if (keys.has(key)) return -1;
      } else if (keys.has(key)) {
        extent += 1;
      } else {
        cut = true;
      }
    }
  }
  return extent;
}

// Abort-extent classification consumed by the recorded-completion proof.
export { isProvableFullCycleAbort };
