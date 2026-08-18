/**
 * Deterministic replay PLANNING of the soak workload from the stored
 * seed/params. Pure function of the seed; never reads SQLite (callers
 * pass probe evidence when available). Split from the replay facade
 * (planning/verification) so each module stays review-sized;
 * `replay.mjs` re-exports the shared surface. No cycle with
 * resume/database.
 */
import { PROBE_EVERY_CYCLES } from "./constants.mjs";
import { SOAK_FIELD_PLANS } from "./entities.mjs";
import { SoakOracle } from "./oracle.mjs";
import {
  generatePatch,
  generateRow,
  planActorOperation,
  sharedEntityId,
} from "./operations.mjs";
import { SeededRandom, deriveSeed } from "./prng.mjs";

/** Stable identity key for one operation record. */
function operationIdentityKey(cycle, actor, index) {
  return `${cycle}:${actor}:${index}`;
}
export { operationIdentityKey };

/**
 * HIGH 1/HIGH 2: deterministic replay of the exact soak workload the
 * stored seed/params generate.
 *
 * Replays every checkpointed cycle (prologue + up-front actor planning +
 * deterministic per-op final row sets) and, when an in-flight marker names
 * the next cycle, that interrupted cycle's prologue and plans too. The
 * replay is a pure function of (seed, params, resolved tables), so it can
 * prove what the authority MUST contain and what every recorded
 * (cycle, actor, index) identity MUST have been.
 *
 * HIGH 1: an in-flight cycle whose record EXISTS (non-aborted, or a
 * provably full-cycle reopen/deadline abort) claims completion and is
 * replayed EXACT — the SQLite verification then demands every
 * deterministic row of that cycle, so a missing/tampered/partial row can
 * never pass as a plausible interrupted prefix. An ambiguous abort
 * record's committed extent cannot be proven and replays as a bounded
 * prefix that verification fails CLOSED on.
 *
 * HIGH 2: the full planned op objects of every replayed cycle are
 * returned (cyclePlans) so the recovery can re-execute the interrupted
 * cycle from the pure deterministic plan instead of re-planning against
 * whatever partial rows SQLite holds.
 *
 * Interrupted-stage fidelity: for a prefix (interrupted) cycle, each
 * planned creating op records the deterministic committed-stage
 * candidates its execution can legitimately leave behind — the
 * two-flush forkIsolation op contributes BOTH its pre-patch row (the
 * valid state after its create flush, before its patch flush) and its
 * post-patch row, while every other creating op contributes exactly one
 * row. Candidates are bound to the exact (cycle, actor, index) op and
 * never leak into completed-cycle proof: an exact cycle records only
 * each op's FINAL post-execution content (forkIsolation post-patch).
 *
 * Returns per-table exact row maps (id -> allowed deterministic contents)
 * for cycles whose full extent is provable, per-table interrupted-cycle
 * plans (main/churn rows plus the planned actor row candidate set) for
 * prefix cycles, the full row counts at the last checkpointed cycle, the
 * full post-cycle row counts per replayed cycle (for reopening the recorded
 * reopen section), the planned kind/table of every (cycle, actor, index),
 * the full planned op objects per cycle, and the list of abort cycles
 * whose committed extent cannot be proven (they are replayed fully for
 * planning continuity but their rows verify as a bounded prefix).
 *
 * @param {object} args { state, activeEntities, cycleByNumber, inFlightCycle,
 *   probeEvidence }.
 * @returns {{ exactRowsByTable: Map<string, Map<string, object[]>>,
 *   prefixCycles: Array<{ cycle: number, byTable: Map<string, object> }>,
 *   checkpointTableRows: Record<string, number>,
 *   cycleTableRows: Map<number, Record<string, number>>,
 *   plans: Map<string, { kind: string, entityName: string }>,
 *   cyclePlans: Map<number, object[]>,
 *   ungrantedProbeOverrides: Array<{ cycle: number, tableName: string }>,
 *   ambiguousAbortCycles: number[] }}
 */
export function replayDeterministicHistory({ state, activeEntities, cycleByNumber, inFlightCycle, probeEvidence }) {
  const oracle = new SoakOracle(SOAK_FIELD_PLANS);
  const seed = state.seed;
  const actors = state.params.actors;
  const opsPerActor = state.params.operationsPerActor;
  const replayThrough = inFlightCycle ?? state.lastCompletedCycle;
  const exactRowsByTable = new Map();
  // Post-cycle final row counts per replayed cycle (table name -> rows):
  // the reopen verify counts SQLite rows after the full cycle, which this
  // oracle state reproduces exactly, so recorded reopen counts are bound
  // to these deterministic values during resume validation.
  const cycleTableRows = new Map();
  const prefixCycles = [];
  const plans = new Map();
  const cyclePlans = new Map();
  const ambiguousAbortCycles = [];
  // Structurally valid ok-probe override candidates for the replay window
  // (cadence, deterministic round-robin target, recorded ok probe naming
  // that target) and the DB-backed grant decision:
  //
  // - `probeEvidence === undefined` (JSONL-only validation, no authority
  //   available): every structurally valid candidate is granted — none of
  //   that consumer's outputs (kind/table plans, row counts, abort
  //   classification) depends on the oracle mutation.
  // - `probeEvidence` provided (resume paths with the authority open): a
  //   candidate is granted ONLY when the SQLite authority contains the
  //   deterministic human-edit value for that exact cycle/table/field;
  //   a structurally valid ok probe WITHOUT the DB evidence is recorded
  //   in `ungrantedProbeOverrides` so DB-backed callers fail closed — a
  //   forged ok probe must never mutate the replay oracle or pass the
  //   exact proof.
  const probeCandidates = probeOverrideCandidates(state, activeEntities, cycleByNumber, replayThrough);
  const ungrantedProbeOverrides = [];
  // Dedupes ungranted claims: the same candidate is consulted by the
  // prologue exact-content branch AND the post-actor oracle mutation, so
  // one missing-evidence claim is reported once per cycle/table.
  const ungrantedKeys = new Set();
  const probeOverrideFor = (cycle, entry) => {
    const key = probeEvidenceKey(cycle, entry.tableName);
    const candidate = probeCandidates.get(key);
    if (candidate === undefined) return undefined;
    if (probeEvidence !== undefined && !probeEvidence.has(key)) {
      if (!ungrantedKeys.has(key)) {
        ungrantedKeys.add(key);
        ungrantedProbeOverrides.push({ cycle, tableName: entry.tableName });
      }
      return undefined;
    }
    return { field: candidate.field, value: candidate.value };
  };
  let checkpointTableRows;
  // Entity name -> table name, for the per-table exact/prefix maps (ops
  // carry entity names; the maps are keyed by table name).
  const entityToTable = new Map(
    activeEntities.map((entry) => [entry.name, entry.tableName]),
  );

  const snapshotCheckpointCounts = () => {
    if (checkpointTableRows === undefined) {
      checkpointTableRows = Object.fromEntries(
        activeEntities.map((entry) => [entry.tableName, oracle.size(entry.name)]),
      );
    }
  };

  for (let cycle = 1; cycle <= replayThrough; cycle += 1) {
    const record = cycleByNumber.get(cycle);
    const abort = record?.abort;
    let prefixCycle;
    if (cycle === inFlightCycle) {
      // HIGH 1: an in-flight cycle with a recorded record claims
      // completion. A non-aborted record (or a provably full-cycle
      // reopen/deadline abort) replays EXACT so every deterministic row of
      // the cycle must exist in the authority. A recordless interrupted
      // cycle stays a bounded prefix (the reconciliation re-runs it), and
      // an ambiguous abort record's committed extent cannot be proven and
      // fails closed later.
      if (record === undefined) {
        prefixCycle = { cycle, byTable: new Map() };
        prefixCycles.push(prefixCycle);
      } else if (abort !== undefined &&
          abort.reason !== "reopen-cleanup-failed" && abort.reason !== "deadline-expired") {
        ambiguousAbortCycles.push(cycle);
        prefixCycle = { cycle, byTable: new Map() };
        prefixCycles.push(prefixCycle);
      }
    } else if (abort !== undefined) {
      // A reopen/deadline abort can only follow the FULL cycle (the reopen
      // runs after every actor record landed): its extent is provable and
      // the cycle replays EXACTLY. Any other abort may have stopped
      // mid-prologue or mid-actor-stream, so its extent is unknowable from
      // the record — verification fails closed on it later.
      if (abort.reason === "reopen-cleanup-failed" || abort.reason === "deadline-expired") {
        // fully executed: exact rows below
      } else {
        ambiguousAbortCycles.push(cycle);
        prefixCycle = { cycle, byTable: new Map() };
        prefixCycles.push(prefixCycle);
      }
    }
    const exact = prefixCycle === undefined;

    // Sequential prologue (same RNG consumption order as runOneCycle).
    for (let tableIndex = 0; tableIndex < activeEntities.length; tableIndex += 1) {
      const entry = activeEntities[tableIndex];
      const fieldPlan = SOAK_FIELD_PLANS[entry.name];
      const rng = new SeededRandom(deriveSeed(seed, cycle * 7919 + tableIndex));
      const mainId = sharedEntityId(entry.name, cycle, "main");
      const churnId = sharedEntityId(entry.name, cycle, "churn");
      const mainRow = { id: mainId, ...generateRow(rng, fieldPlan) };
      const churnRow = { id: churnId, ...generateRow(rng, fieldPlan) };
      const patch = generatePatch(rng, fieldPlan);
      const postPatch = { ...mainRow, ...patch };
      oracle.applyMutation({ op: "insert", entity: entry.name, row: mainRow });
      oracle.applyMutation({ op: "insert", entity: entry.name, row: churnRow });
      oracle.applyMutation({ op: "update", entity: entry.name, id: mainId, patch });
      oracle.applyMutation({ op: "delete", entity: entry.name, id: churnId });
      if (exact) {
        const contents = [postPatch];
        const probe = probeOverrideFor(cycle, entry);
        if (probe !== undefined) {
          contents.push({ ...postPatch, [probe.field]: probe.value });
        }
        let tableExact = exactRowsByTable.get(entry.tableName);
        if (tableExact === undefined) {
          tableExact = new Map();
          exactRowsByTable.set(entry.tableName, tableExact);
        }
        tableExact.set(mainId, contents);
      } else {
        prefixCycle.byTable.set(entry.tableName, {
          mainId,
          churnId,
          mainPre: mainRow,
          mainPost: postPatch,
          churnRow,
          probeOverride: probeOverrideFor(cycle, entry),
          actorRows: new Map(),
        });
      }
    }

    // Up-front planning pass against the post-prologue state (the same
    // two-phase shape as runOneCycle: ALL plans are computed before ANY
    // op is applied, so the plan is never a function of execution order).
    const plannedOps = [];
    for (let actor = 0; actor < actors; actor += 1) {
      for (let opIndex = 0; opIndex < opsPerActor; opIndex += 1) {
        const entry = activeEntities[
          (actor * opsPerActor + opIndex) % activeEntities.length
        ];
        const op = planActorOperation({
          seed,
          cycle,
          actor,
          opIndex,
          entityName: entry.name,
          fieldPlan: SOAK_FIELD_PLANS[entry.name],
          oracle,
        });
        plannedOps.push(op);
        plans.set(operationIdentityKey(cycle, actor, opIndex), {
          kind: op.kind,
          entityName: op.entityName,
        });
      }
    }
    // HIGH 2: the full op objects are retained so the recovery can
    // re-execute the interrupted cycle from this pure plan (never from a
    // re-plan against partial SQLite rows).
    cyclePlans.set(cycle, plannedOps);

    // Apply the planned ops in deterministic final-state order (each op
    // touches only its own actor-scoped id, so the final row set is a pure
    // function of the plan).
    for (const op of plannedOps) {
      const created = applyReplayedOp(oracle, op);
      if (exact) {
        const tableExact = exactRowsByTable.get(entityToTable.get(op.entityName));
        for (const entry of created) {
          // HIGH 1: a COMPLETED cycle (its record landed, or a provably
          // full-cycle abort) demands the FINAL post-execution content —
          // the two-flush forkIsolation row is only provable post-patch
          // once the cycle claims completion, so its pre-patch stage is
          // never accepted here.
          tableExact.set(String(entry.id), [entry.finalRow]);
        }
      } else {
        const tablePlan = prefixCycle.byTable.get(entityToTable.get(op.entityName));
        for (const entry of created) {
          // Interrupted-stage candidates, bound to this exact op/cycle:
          // the forkIsolation pre-patch row is a legitimate committed
          // stage when the cycle died between its two flushes; every
          // other creating op has exactly one candidate. Verification
          // accepts only these contents for the op's id.
          tablePlan.actorRows.set(String(entry.id), entry.contents);
        }
      }
    }
    // Proven human-edit probe override on the replay oracle. The live
    // loop applies the accepted probe edit AFTER the cycle's actor stream
    // (never before), so the replay applies the same proven override at
    // the same point — after this cycle's deterministic prologue and
    // actor state, before the NEXT cycle's filters/operation plan is
    // derived. Without this, a later cycle's planned filter operands
    // (which anchor on live oracle row values) would diverge from the
    // plan the live run actually executed, and a resumed reconciliation
    // would re-execute different queries against the edited authority.
    // The override is granted ONLY by the exact evidence the candidates
    // above encode: cycle cadence, the deterministic round-robin target
    // table, a recorded ok probe naming that table, AND (on DB-backed
    // paths) the SQLite authority containing the deterministic
    // human-edit value for that exact cycle/table/field — a forged ok
    // probe with adjusted counters but an unchanged authority never
    // mutates the replay oracle (and fails the resume closed via
    // ungrantedProbeOverrides). The post-cycle row-count snapshots below
    // are unaffected because the probe edit is an update, never a create
    // or delete.
    const probeEntry = activeEntities[
      Math.floor(cycle / PROBE_EVERY_CYCLES) % activeEntities.length
    ];
    const probe = probeOverrideFor(cycle, probeEntry);
    if (probe !== undefined) {
      oracle.applyMutation({
        op: "update",
        entity: probeEntry.name,
        id: sharedEntityId(probeEntry.name, cycle, "main"),
        patch: { [probe.field]: probe.value },
      });
    }
    // Snapshot the FULL post-cycle row counts: the reopen verify counts
    // the authority right after this cycle's work, so the deterministic
    // replay must reproduce exactly those counts (mode affects probe
    // content only, never counts).
    cycleTableRows.set(cycle, Object.fromEntries(
      activeEntities.map((entry) => [entry.tableName, oracle.size(entry.name)]),
    ));
    // Snapshot the full row counts at the last checkpointed cycle: the
    // in-flight cycle's rows (when present) must NOT be counted, because
    // state.tableRows was written before that cycle started.
    if (cycle === state.lastCompletedCycle) snapshotCheckpointCounts();
  }
  // No completed cycles at all (lastCompletedCycle 0): the checkpointed
  // counts are the empty table set.
  if (checkpointTableRows === undefined) {
    checkpointTableRows = Object.fromEntries(
      activeEntities.map((entry) => [entry.tableName, 0]),
    );
  }
  return { exactRowsByTable, prefixCycles, checkpointTableRows, plans, cyclePlans, cycleTableRows, ambiguousAbortCycles, ungrantedProbeOverrides };
}

/**
 * Applies one planned actor op to the replay oracle and returns the rows
 * it deterministically creates (empty for non-creating kinds).
 *
 * Mirrors executeActorOperation's final-state semantics WITHOUT SQLite:
 * each op touches only its own actor-scoped id, so deletes never remove a
 * planned row, updates always fall back to the deterministic synthesized
 * create, and batchPersist/forkIsolation/transactionalCommit create their
 * exact rows. The oracle always advances with each op's FINAL row, so
 * every later plan sees the completed stage regardless of where an
 * interruption could have cut the op.
 *
 * Each returned entry carries the deterministic `contents` the op may
 * legitimately leave committed in an INTERRUPTED cycle (the candidates
 * resume verification accepts for that exact op/cycle) plus the `finalRow`
 * the op's COMPLETED execution must leave. The two-flush forkIsolation op
 * can be caught between its create flush and its patch flush, so its
 * pre-patch row is a valid interrupted-stage candidate — but only there:
 * completed-cycle proof uses `finalRow`, which is always post-patch.
 *
 * @param {SoakOracle} oracle replay oracle.
 * @param {object} op planned operation.
 * @returns {Array<{ id: string, contents: object[], finalRow: object }>}
 *   created rows (in plan order).
 */
function applyReplayedOp(oracle, op) {
  const entries = [];
  switch (op.kind) {
    case "create": {
      const row = { id: op.mutateId, ...op.row };
      entries.push({ id: op.mutateId, contents: [row], finalRow: row });
      break;
    }
    case "update": {
      const row = { id: op.mutateId, ...synthesizedUpdateRow(op, SOAK_FIELD_PLANS[op.entityName]) };
      entries.push({ id: op.mutateId, contents: [row], finalRow: row });
      break;
    }
    case "delete":
      break; // the actor-scoped row never existed (disjoint ids)
    case "batchPersist": {
      const rows = [
        { id: op.mutateId, ...op.row },
        { id: `${op.mutateId}-x0`, ...op.extraRows[0] },
        { id: `${op.mutateId}-x1`, ...op.extraRows[1] },
      ];
      for (const row of rows) entries.push({ id: row.id, contents: [row], finalRow: row });
      break;
    }
    case "transactionalCommit": {
      const row = { id: op.mutateId, ...op.row };
      entries.push({ id: op.mutateId, contents: [row], finalRow: row });
      break;
    }
    case "transactionalRollback":
      break; // rolled back atomically; no row survives
    case "forkIsolation": {
      // Two committed stages: the create flush alone (pre-patch — a valid
      // committed state ONLY when the cycle was interrupted between the
      // two flushes) and the completed post-patch row. The replay oracle
      // advances with the FINAL row so later plans see the completed
      // stage; exact-cycle proof also uses only the final row.
      const prePatch = { id: op.mutateId, ...op.row };
      const postPatch = { ...prePatch, ...op.patch };
      entries.push({ id: op.mutateId, contents: [prePatch, postPatch], finalRow: postPatch });
      break;
    }
    default:
      break; // read-only / expected-error kinds create no rows
  }
  for (const entry of entries) {
    oracle.applyMutation({ op: "insert", entity: op.entityName, row: entry.finalRow });
  }
  return entries;
}

/**
 * Deterministic row for an `update` op whose actor-scoped row never
 * existed: the patch plus the executor's neutral defaults (mirrors
 * rowForCreate in executor.mjs exactly).
 *
 * @param {object} op planned operation.
 * @param {object} fieldPlan entity field plan.
 * @returns {object}
 */
function synthesizedUpdateRow(op, fieldPlan) {
  const row = { ...op.patch };
  for (const [field, spec] of Object.entries(fieldPlan)) {
    if (spec.primary || row[field] !== undefined) continue;
    row[field] = spec.type === "number" ? 0
      : spec.type === "boolean" ? false
        : spec.type === "date" ? new Date(0)
          : "init";
    if (spec.nullable && spec.type === "date") row[field] = null;
  }
  return row;
}

/**
 * True when the entity has at least one editable (non-primary string)
 * field, so a live human-edit probe can run on it.
 *
 * The six soak entities all qualify; the check keeps the resume validation
 * honest if the field plans ever change.
 *
 * @param {object} entry one active entity.
 * @returns {boolean}
 */
function hasEditableProbeField(entry) {
  const plan = SOAK_FIELD_PLANS[entry.name];
  if (plan === undefined) return false;
  return Object.values(plan).some((spec) => !spec.primary && spec.type === "string");
}

/**
 * Deterministic `tablesTouched` union of ONE fully executed cycle.
 *
 * The prologue touches every active table (table names) and every planned
 * actor operation touches the entity its deterministic round-robin slot
 * selects (entity names). Low-workload configurations (e.g. actors=1,
 * operationsPerActor=1) therefore touch only the entity names the stored
 * actor stream actually plans — never every active entity — and the
 * expected set is a pure function of the stored params, so resume rejects
 * only tampered names without assuming every actor stream touches every
 * entity.
 *
 * @param {object} state validated resume state (params.actors,
 *   params.operationsPerActor, params.resolvedTables).
 * @param {object[]} activeEntities resolved active entities in order.
 * @returns {string[]} sorted deduped expected table/entity names.
 */
function expectedTablesTouchedForCycle(state, activeEntities) {
  const touched = new Set(activeEntities.map((entry) => entry.tableName));
  for (let actor = 0; actor < state.params.actors; actor += 1) {
    for (let opIndex = 0; opIndex < state.params.operationsPerActor; opIndex += 1) {
      const entry = activeEntities[
        (actor * state.params.operationsPerActor + opIndex) % activeEntities.length
      ];
      touched.add(entry.name);
    }
  }
  return [...touched].sort();
}

/**
 * Map key naming one probe override candidate: `"<cycle>:<tableName>"`.
 *
 * The same key is used by `probeOverrideCandidates` (structural
 * candidates) and the DB-backed `probeEvidence` set (authority rows that
 * contain the deterministic human-edit value), so the grant decision is
 * exact per cycle/table/field.
 *
 * @param {number} cycle cycle number.
 * @param {string} tableName soak table name.
 * @returns {string}
 */
function probeEvidenceKey(cycle, tableName) {
  return `${cycle}:${tableName}`;
}

/**
 * Deterministic human-edit probe override candidates for a replay window
 * (live mode only): the probe table, field, and value are pure functions
 * of (seed, cycle), and a candidate exists ONLY when the recorded probe
 * section is structurally valid (ok status naming the deterministic
 * round-robin target table).
 *
 * The candidates themselves never decide the grant: DB-backed resume
 * paths derive `probeEvidence` from the authority and pass it to
 * `replayDeterministicHistory`, which mutates the replay oracle only for
 * evidence-backed candidates and reports the rest as
 * `ungrantedProbeOverrides` (fail closed). JSONL-only validation passes
 * no evidence and grants every structural candidate — none of its
 * consumed outputs depends on the oracle mutation.
 *
 * @param {object} state validated resume state (mode, seed).
 * @param {object[]} activeEntities resolved active entities in order.
 * @param {Map<number, object>} cycleByNumber validated cycle records.
 * @param {number} replayThrough last cycle of the replay window.
 * @returns {Map<string, { entry: object, mainId: string, field: string,
 *   value: string }>} candidates keyed by `probeEvidenceKey`.
 */
function probeOverrideCandidates(state, activeEntities, cycleByNumber, replayThrough) {
  const candidates = new Map();
  if (state.mode !== "live") return candidates;
  for (let cycle = 1; cycle <= replayThrough; cycle += 1) {
    if (cycle % PROBE_EVERY_CYCLES !== 0) continue;
    const probeEntry = activeEntities[
      Math.floor(cycle / PROBE_EVERY_CYCLES) % activeEntities.length
    ];
    const recordedProbe = cycleByNumber.get(cycle)?.probe;
    // The human-edit override is only ever a CANDIDATE when the
    // corresponding recorded probe is successful AND names the same
    // deterministic target table. A failed, missing, or altered probe
    // never qualifies — changed SQLite content then stays tampered, and
    // the oracle is never mutated.
    if (recordedProbe === undefined || recordedProbe.status !== "ok" ||
        recordedProbe.table !== probeEntry.tableName) {
      continue;
    }
    const fieldPlan = SOAK_FIELD_PLANS[probeEntry.name];
    const editableFields = Object.entries(fieldPlan)
      .filter(([, spec]) => !spec.primary && spec.type === "string")
      .map(([field]) => field);
    if (editableFields.length === 0) continue;
    const rng = new SeededRandom(deriveSeed(state.seed, cycle * 31 + 7));
    candidates.set(probeEvidenceKey(cycle, probeEntry.tableName), {
      entry: probeEntry,
      mainId: sharedEntityId(probeEntry.name, cycle, "main"),
      field: editableFields[rng.int(editableFields.length)],
      value: `human-edit-c${cycle}`,
    });
  }
  return candidates;
}

// Deterministic-replay planning helpers consumed by the replay facade and
// the replay verification module (probe evidence grant).
export {
  expectedTablesTouchedForCycle,
  hasEditableProbeField,
  probeEvidenceKey,
  probeOverrideCandidates,
};
