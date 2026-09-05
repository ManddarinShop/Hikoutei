/**
 * Deterministic attack-scenario scheduler for the soak runner.
 *
 * Composes 1-3 attack scenarios per standard cycle from the scenario
 * registry, using a seeded shuffle bag so every registered scenario is
 * selected once before any repeat and no scenario is selected twice in
 * one cycle. Selection, injection count, phase assignment, order, short
 * jitter and target are all pure functions of (seed, cycle) — the same
 * seed reproduces the exact batch, different seeds vary it.
 *
 * The scheduler knows ONLY the scenario contract (id/kind/allowedPhases/
 * plan/execute) and never scenario internals. It is the composition and
 * execution engine: the cycle executor asks it for the batch, then calls
 * runScenario() per phase window. Scenario execution is live-only: without
 * a live Sheets/observation client the scheduler records each scenario as
 * `skipped` (local mode) and never mutates SQLite, so the baseline soak
 * workload and its deterministic oracle/resume proofs are unchanged.
 */
import {
  RECOVERY_DELETE_DRAIN_POLL_MS,
  RECOVERY_DELETE_DRAIN_TIMEOUT_MS,
  TOMBSTONE_HEADER,
} from "../constants.mjs";
import { soakTableNameForEntity } from "../entities.mjs";
import { stableErrorTag } from "../errors.mjs";
import { SeededRandom, deriveSeed } from "../prng.mjs";
import { extractProjectionIds } from "../probe.mjs";
import { sanitizeErrorTag, sanitizeFailureKind, sanitizeTableName } from "../redact.mjs";
import { boundedSleep } from "../timing.mjs";

/** The three scenario execution windows within one standard soak cycle. */
export const SCENARIO_PHASES = Object.freeze({
  AFTER_PROLOGUE: "after-prologue",
  CONCURRENT_WITH_ACTORS: "concurrent-with-actors",
  AFTER_ACTORS: "after-actors",
});

/** All scenario phase values (used for phase picking and validation). */
export const SCENARIO_PHASE_VALUES = Object.freeze([
  SCENARIO_PHASES.AFTER_PROLOGUE,
  SCENARIO_PHASES.CONCURRENT_WITH_ACTORS,
  SCENARIO_PHASES.AFTER_ACTORS,
]);

/**
 * Scenario kinds: data scenarios share a phase and may overlap the data/
 * base workload; lifecycle scenarios may overlap data/base workload but
 * must not overlap another lifecycle scenario.
 */
export const SCENARIO_KINDS = Object.freeze({
  DATA: "data",
  LIFECYCLE: "lifecycle",
});

/** Deterministic number of attack scenarios injected per cycle: 1-3. */
const MIN_INJECTIONS = 1;
const MAX_INJECTIONS = 3;
/** Seed mixing constant for the per-cycle shuffle-bag permutation. */
const BAG_SEED_MIX = 0x5eed;

/** Fisher-Yates shuffle over a seeded random source. */
function seededShuffle(rng, items) {
  const array = [...items];
  for (let index = array.length - 1; index > 0; index -= 1) {
    const swap = rng.int(index + 1);
    const tmp = array[index];
    array[index] = array[swap];
    array[swap] = tmp;
  }
  return array;
}

/**
 * Deterministic injection count for one cycle, clamped to the registry
 * size so the draw can never request more scenarios than exist.
 */
function countForCycle(seed, cycle, registrySize) {
  const rng = new SeededRandom(deriveSeed(seed, cycle * 1019 + 3));
  return Math.min(MIN_INJECTIONS + rng.int(MAX_INJECTIONS - MIN_INJECTIONS + 1), registrySize);
}

/** One permutation of every registered scenario id (a "bag"). */
function bagFor(seed, bagIndex, ids) {
  const size = ids.length;
  const base = basePermutation(seed, ids);
  // Consecutive bags are ROTATIONS of one base permutation, so the last id
  // of one bag and the first id of the next can never coincide at a bag
  // boundary. A cycle drawing up to 3 consecutive ids therefore never spans
  // a boundary with a duplicate, and the stream stays a concatenation of
  // full permutations (every registered scenario appears before any
  // repeat). Independent per-bag shuffles would allow boundary
  // coincidences that force within-cycle skips and break that guarantee.
  const offset = bagIndex % size;
  return base.slice(offset).concat(base.slice(0, offset));
}

/** The single seeded base permutation every bag is a rotation of. */
function basePermutation(seed, ids) {
  const rng = new SeededRandom(deriveSeed(seed, BAG_SEED_MIX));
  return seededShuffle(rng, ids);
}

/**
 * Draws `count` distinct scenario ids for one cycle by walking the seeded
 * shuffle bags. Each bag holds every registered scenario exactly once, and
 * a new bag starts only after the previous one is fully consumed, so every
 * registered scenario is selected once before any repeats and no scenario
 * is duplicated within a cycle.
 *
 * The starting bag position is the EXACT continuation of the prior cycles'
 * draws (including within-cycle skips at bag boundaries), so a run resumed
 * at any cycle reproduces the identical stream from that cycle onward.
 */
function drawIds(seed, cycle, count, ids) {
  const size = ids.length;
  let bagIndex = 0;
  let position = 0;
  // Simulate the draws of cycles 1..cycle-1 to find the exact bag position
  // where this cycle starts. Each prior cycle draws its own count of
  // distinct ids (skipping within-cycle duplicates at bag boundaries), and
  // the ACTUAL bag position consumed — not just the distinct count — is
  // carried forward, so the stream stays a concatenation of full
  // permutations and every registered scenario appears before any repeat.
  for (let index = 1; index < cycle; index += 1) {
    const priorCount = countForCycle(seed, index, size);
    ({ bagIndex, position } = walkBag(seed, bagIndex, position, priorCount, ids));
  }
  return walkBag(seed, bagIndex, position, count, ids).drawn;
}

/**
 * Walks the seeded shuffle bags from (bagIndex, position), drawing `count`
 * distinct ids (skipping ids already drawn in this walk) and returning the
 * drawn ids plus the exact ending position for the next walk.
 *
 * @returns {{ bagIndex: number, position: number, drawn: string[] }}
 */
function walkBag(seed, bagIndex, position, count, ids) {
  const seen = new Set();
  const drawn = [];
  let remaining = count;
  while (remaining > 0) {
    const bag = bagFor(seed, bagIndex, ids);
    while (position < bag.length && remaining > 0) {
      const id = bag[position];
      position += 1;
      if (seen.has(id)) continue;
      seen.add(id);
      drawn.push(id);
      remaining -= 1;
    }
    if (remaining > 0) {
      bagIndex += 1;
      position = 0;
    }
  }
  return { bagIndex, position, drawn };
}

/**
 * Assigns one allowed phase to a selected scenario, keeping lifecycle
 * scenarios off a phase already taken by another lifecycle scenario.
 */
function assignPhase(scenario, rng, usedLifecyclePhases) {
  const allowed = scenario.allowedPhases.length > 0
    ? scenario.allowedPhases
    : SCENARIO_PHASE_VALUES;
  const isLifecycle = scenario.kind === SCENARIO_KINDS.LIFECYCLE;
  const candidates = allowed.filter((phase) =>
    !isLifecycle || !usedLifecyclePhases.has(phase));
  const pool = candidates.length > 0 ? candidates : allowed;
  const phase = pool[rng.int(pool.length)];
  if (isLifecycle) usedLifecyclePhases.add(phase);
  return phase;
}

/**
 * Composes the deterministic scenario batch for one cycle.
 *
 * Pure function of (seed, cycle) plus the registry contract: returns the
 * selected scenario entries with their assigned phase, order, kind and a
 * fully deterministic plan (tag/jitter/target) produced by each scenario's
 * `plan()`. Reads no external run state.
 *
 * @param {{ seed: number, cycle: number, registry: readonly object[], activeEntities?: readonly object[] }} input
 * @returns {{ cycle: number, scenarios: Array<object> }} selected entries.
 */
export function composeScenarioBatch({ seed, cycle, registry, activeEntities }) {
  if (!Array.isArray(registry) || registry.length === 0) {
    return { cycle, scenarios: [] };
  }
  const ids = registry.map((scenario) => scenario.id);
  const byId = new Map(registry.map((scenario) => [scenario.id, scenario]));
  const count = countForCycle(seed, cycle, ids.length);
  const drawn = drawIds(seed, cycle, count, ids);
  const phaseRng = new SeededRandom(deriveSeed(seed, cycle * 613 + 7));
  const usedLifecyclePhases = new Set();
  const scenarios = [];
  for (let order = 0; order < drawn.length; order += 1) {
    const scenario = byId.get(drawn[order]);
    const phase = assignPhase(scenario, phaseRng, usedLifecyclePhases);
    const planRng = new SeededRandom(deriveSeed(seed, cycle * 401 + order * 17));
    // MEDIUM 2: every scenario plan targets an entity, and a subset run
    // (--tables) activates only SOME entities. The composed plan must select
    // its target entity ONLY from the active entity/table subset so a plan
    // never points at an inactive entity. Same seed/cycle/same subset
    // reproduces exactly; a different subset may compose a different plan.
    const plan = scenario.plan({ seed, cycle, phase, order, rng: planRng, activeEntities });
    // HIGH target-table proof: every composed entry carries a redacted
    // allowlisted `targetTable` derived from the plan's selected active
    // entity's known soak table name (never a raw entity id/value). The
    // record derives from this same field, so a resume proof can bind a
    // recorded scenario batch to the actual active subset — a full-registry
    // record fails under a one-table subset even when id/phase/order/tag
    // coincide.
    scenarios.push({
      id: scenario.id,
      kind: scenario.kind,
      phase,
      order,
      scenario,
      plan,
      ...(targetTableForPlan(plan) === undefined ? {} : { targetTable: targetTableForPlan(plan) }),
    });
  }
  return { cycle, scenarios };
}

/**
 * Deterministic soak table a scenario plan targets, or `undefined` when the
 * plan names no registered entity.
 *
 * Scenarios carry their target entity either on `plan.target.entityName` or
 * directly on `plan.entityName`; the known soak table name is derived so a
 * redacted allowlisted `targetTable` can be threaded into records and the
 * resume proof without ever recording raw entity ids/values.
 *
 * @param {object | undefined} plan a composed scenario plan.
 * @returns {string | undefined} the target entity's known soak table name.
 */
function targetTableForPlan(plan) {
  const entityName = plan?.target?.entityName ?? plan?.entityName;
  if (typeof entityName !== "string" || entityName.length === 0) return undefined;
  return soakTableNameForEntity(entityName);
}

/**
 * Returns the composed entries assigned to one phase, in execution order.
 *
 * @param {{ scenarios: Array<object> }} batch composed batch.
 * @param {string} phase a {@link SCENARIO_PHASES} value.
 * @returns {Array<object>} entries for the phase, ordered by `order`.
 */
export function scenariosForPhase(batch, phase) {
  return batch.scenarios
    .filter((entry) => entry.phase === phase)
    .sort((a, b) => a.order - b.order);
}

/**
 * Runs every scenario assigned to one phase CONCURRENTLY.
 *
 * Same-phase data scenarios execute in parallel (they overlap the data/base
 * workload by contract). Lifecycle scenarios may overlap data/base work but
 * never another lifecycle, and the scheduler's phase assignment guarantees
 * at most one lifecycle per phase, so concurrency can never overlap two
 * lifecycle owners. The returned records are sorted by deterministic
 * `order` — independent of completion order — so the durable artifact is
 * reproducible from (seed, cycle) alone.
 *
 * Every sibling settles before the phase resolves: each entry's scenario
 * promise is awaited through {@link Promise.allSettled} (not a fail-fast
 * Promise.all), so one scenario that rejects can never abandon or cancel its
 * siblings mid-flight, and a scenario throw becomes ITS OWN deterministic
 * redacted failure record rather than rejecting the whole phase. This also
 * means the phase promise itself never rejects — the concurrent-phase join in
 * the cycle executor never sees an unhandled rejection while the actors run.
 * `runScenario` already maps unexpected throws to a failed record, but the
 * allSettled fallback covers the case where `runScenario` itself rejects.
 *
 * @param {{ scenarios: Array<object> }} batch composed batch.
 * @param {string} phase a {@link SCENARIO_PHASES} value.
 * @param {object} context the cycle execution context (public seams).
 * @returns {Promise<object[]>} redacted scenario records sorted by order.
 */
export async function runScenarioPhase(batch, phase, context) {
  const entries = scenariosForPhase(batch, phase);
  const settled = await Promise.allSettled(
    entries.map((entry) => runScenario({ entry, context })),
  );
  const records = settled.map((result, index) =>
    result.status === "fulfilled"
      ? result.value
      : failedScenarioRecord(entries[index], result.reason),
  );
  return records.sort((a, b) => a.order - b.order);
}

/**
 * True when the live context exposes a usable direct-Sheet client: a
 * non-null, non-array object whose `readTabRows` and `mutateInputCell` are
 * callable — the direct-Sheet callables every registered scenario requires.
 * Optional methods are preserved untouched. An array, function, primitive,
 * null, or an object missing either callable is NOT usable, so a live
 * context that cannot actually drive a scenario fails closed instead of
 * being mistaken for a local-mode skip.
 *
 * @param {unknown} client the live context's direct-Sheet client.
 * @returns {boolean} true only for a usable direct-Sheet client object.
 */
function isUsableLiveClient(client) {
  return client !== null && typeof client === "object" && !Array.isArray(client) &&
    typeof client.readTabRows === "function" &&
    typeof client.mutateInputCell === "function";
}

/**
 * Builds the deterministic redacted failure record for a scenario that
 * threw. Used both as `runScenario`'s own catch and as the allSettled
 * fallback, so a scenario throw ALWAYS becomes one failed record in the
 * entry's deterministic order — never a phase rejection and never a
 * duplicate or missing record.
 *
 * @param {{ id: string, phase: string, order: number, plan?: object, targetTable?: unknown }} entry
 *   the composed scenario entry.
 * @param {unknown} reason the thrown reason (never recorded verbatim).
 * @returns {object} the redacted failed scenario record.
 */
function failedScenarioRecord(entry, reason) {
  return {
    id: entry.id,
    phase: entry.phase,
    order: entry.order,
    tag: entry.plan?.tag ?? "unknown",
    ...(recordTargetTable(entry) === undefined ? {} : { targetTable: recordTargetTable(entry) }),
    status: "failed",
    reason: "scenario-error",
    // Diagnostic-only stable tag for the thrown reason (class + allowlisted
    // code/status class, never the message, stack, or any raw value), so a
    // `scenario-error` record says WHICH error shape fired.
    reasonTag: sanitizeErrorTag(stableErrorTag(reason)),
    expectedErrors: 0,
    failures: 1,
  };
}

/**
 * Redacted, allowlisted target-table proof carried by one scenario record.
 *
 * Only a known soak table name survives (a scenario plan's target entity is
 * always an active subset entity, so its table name is fixed soak
 * vocabulary). An unknown or absent target collapses to `undefined` and the
 * field is omitted — which keeps legacy/test records (that carry no
 * target-table proof) compatible while every new composed scenario record
 * always binds to its active subset. Never records a raw entity id/value.
 *
 * @param {{ targetTable?: unknown }} entry a composed scenario entry.
 * @returns {string | undefined} the allowlisted target table name.
 */
function recordTargetTable(entry) {
  const table = sanitizeTableName(entry?.targetTable);
  return table === "unknown" ? undefined : table;
}

/**
 * Executes one scenario entry and returns its redacted record.
 *
 * A scenario is recorded as `skipped` ONLY in local-only mode and never
 * touches SQLite, the oracle, or any runtime state — the baseline workload
 * and resume proofs are unchanged. A sync-capable (live) context missing
 * its observation client or spreadsheet, and an unknown/malformed mode,
 * FAIL CLOSED as a deterministic redacted failure record instead of being
 * mistaken for a local-mode skip. With a complete live context the
 * scenario's own `execute()` runs; an unexpected throw is a scenario
 * failure, while the scenario's reported expected errors and failures stay
 * separate so a clear validation rejection is never a soak failure.
 *
 * @param {{ entry: object, context: object }} input the composed entry and
 *   the cycle execution context (public seams + live client).
 * @returns {Promise<object>} redacted scenario record.
 */
export async function runScenario({ entry, context }) {
  const live = context?.live;
  const targetTable = recordTargetTable(entry);
  const recordBase = {
    id: entry.id,
    phase: entry.phase,
    order: entry.order,
    tag: entry.plan?.tag ?? "unknown",
    ...(targetTable === undefined ? {} : { targetTable }),
  };
  const mode = live?.mode;
  // MEDIUM: `runScenario` may skip ONLY in local mode. A live/sync-capable
  // context is usable only when it has a non-null usable client object and a
  // non-empty string spreadsheetId; a missing/null client, a blank or
  // non-string spreadsheet id, or a malformed/unknown/missing mode fails
  // closed as one deterministic failure record (never a local-mode skip, and
  // never a scenario-reported `reopen-skipped`/limitation skip), so failure
  // accounting always catches it.
  if (mode === "local") {
    return {
      ...recordBase,
      status: "skipped",
      reason: "local-mode",
      expectedErrors: 0,
      failures: 0,
    };
  }
  const hasUsableClient = isUsableLiveClient(live?.client);
  const hasSpreadsheetId = typeof live?.spreadsheetId === "string" &&
    live.spreadsheetId.trim().length > 0;
  if (mode !== "live" || !hasUsableClient || !hasSpreadsheetId) {
    return {
      ...recordBase,
      status: "failed",
      reason: mode !== "live" ? "unknown-mode" : "live-context-incomplete",
      expectedErrors: 0,
      failures: 1,
    };
  }
  try {
    const result = await entry.scenario.execute({ plan: entry.plan, context });
    const expectedErrors = result.expectedErrors ?? 0;
    // Contract: `result.failures` is the TOTAL unexpected failure count and
    // the scenario adds any cleanup failures into it internally; the
    // reported `cleanupFailures` is an informational SUBSET that must never
    // be added again, so one cleanup failure yields exactly one total
    // failure. The invariant `cleanupFailures <= failures` is enforced by
    // clamping the subset to the total before recording.
    const failures = result.failures ?? 0;
    const cleanupFailures = Math.min(result.cleanupFailures ?? 0, failures);
    // The scenario's OWN status is authoritative and propagated: a scenario
    // that truthfully reports `skipped` (e.g. a live step the harness has
    // no seam to run) must never be recorded as `ok` just because it had no
    // failures. A `failed` status is recorded as failed; otherwise the
    // status derives from the failure counter.
    const status = result.status === "skipped"
      ? "skipped"
      : result.status === "failed"
        ? "failed"
        : failures > 0 ? "failed" : "ok";
    return {
      ...recordBase,
      status,
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
      // Pass through the scenario's own diagnostic tags (never raw text):
      // the stable error tag recorded when the scenario swallowed a throw
      // into `scenario-error`, and the allowlisted invariant kinds its
      // internal failure counters fired.
      ...(typeof result.reasonTag === "string" && result.reasonTag.length > 0
        ? { reasonTag: sanitizeErrorTag(result.reasonTag) } : {}),
      ...(Array.isArray(result.failureKinds) && result.failureKinds.length > 0
        ? { failureKinds: [...new Set(result.failureKinds.map(sanitizeFailureKind))].sort() } : {}),
      expectedErrors,
      failures,
      ...(cleanupFailures > 0 ? { cleanupFailures } : {}),
    };
  } catch (error) {
    // A scenario throw is ITS OWN deterministic redacted failure record,
    // shared with the allSettled fallback in runScenarioPhase.
    return failedScenarioRecord(entry, error);
  }
}

/**
 * Runs each selected mutating scenario's deterministic orphan-recovery hook
 * for one interrupted in-flight cycle, BEFORE resume DB/history proof.
 *
 * A process-death interruption during a scenario's execute can leave its
 * dedicated row in the authority (its guaranteed finally never ran); the
 * resume replay would reject that row as a foreign id. Recovery derives the
 * SAME deterministic batch from (seed, cycle) the interrupted run composed,
 * and for every selected scenario that exposes a `recover` hook invokes it
 * with the scenario's deterministic plan and the public EntityManager seams.
 * Each hook removes exactly its planned dedicated row(s), is idempotent, and
 * is restart-safe, so normal completed-cycle rows are never touched. Only
 * scenarios with a `recover` hook participate; non-mutating scenarios are
 * untouched.
 *
 * @param {{ seed: number, cycle: number, registry: readonly object[], context: object }} input
 * @returns {Promise<{ removed: number }>} total rows removed across hooks.
 */
export async function runInterruptedCycleRecovery({ seed, cycle, registry, context }) {
  // MEDIUM 2: recompose the interrupted cycle's batch with the SAME active
  // entity/table subset the run used, so recovery targets exactly the
  // deterministic plan the run composed (never an inactive entity).
  const batch = composeScenarioBatch({
    seed,
    cycle,
    registry,
    activeEntities: context?.activeEntities,
  });
  let removed = 0;
  for (const entry of batch.scenarios) {
    if (typeof entry.scenario.recover !== "function") continue;
    const result = await entry.scenario.recover({ plan: entry.plan, context });
    const count = result?.removed ?? 0;
    removed += count;
    // HIGH recovery delete race: an orphan public deletion produces an ASYNC
    // Sheet delete effect. Rerunning the same deterministic cycle recreates
    // the id before the delete may deliver, so a stale delete/tombstone could
    // remove the recreated row. After any orphan was actually removed, wait
    // for a bounded existing delivery/readiness + direct projection
    // absence/tombstone confirmation BEFORE resume proof/rerun. If drain/
    // absence cannot be proven by the run deadline the recovery fails closed
    // and never reruns/recreates. No orphan (removed 0) -> no barrier.
    if (count > 0) {
      const target = plannedOrphanTarget(entry.plan);
      if (target !== undefined) {
        await confirmDeleteDrained({ ...target, context });
      }
    }
  }
  return { removed };
}

/**
 * Extracts the deterministic dedicated orphan id + entity from a scenario
 * plan (a pure function of (seed, cycle)), or undefined when the plan has
 * no dedicated mutating id (a scenario without an orphan row).
 *
 * @param {object | undefined} plan the composed scenario plan.
 * @returns {{ entityName: string, id: string } | undefined}
 */
function plannedOrphanTarget(plan) {
  const target = plan?.target ?? {};
  const entityName = plan?.entityName ?? target?.entityName;
  const id = plan?.raceId ?? target?.targetId;
  if (typeof entityName !== "string" || typeof id !== "string") return undefined;
  return { entityName, id };
}

/**
 *
 * A recover hook removed the orphan's dedicated row through the public
 * EntityManager, producing an async Sheet delete effect. This barrier polls
 * the entity's System projection tab through the direct-Sheet read seam for
 * POSITIVE remote evidence that the delete delivered, bounded by the earlier
 * of the drain window and the run deadline. It uses only the public/direct-
 * Sheet seams and never inspects or cancels internal outbox/storage.
 *
 * A first observed absence is NOT proof of delivery: the orphan row may never
 * have projected while a pending delete effect could later remove the
 * recreated id. Success therefore requires positive remote evidence — either
 * (a) the id observed ACTIVE (present) and then later ABSENT, or (b) the
 * target's TOMBSTONE/deleted marker observed directly. An initial absence
 * with no prior active observation is never accepted and keeps polling; if
 * no positive evidence appears by the deadline the barrier FAILS CLOSED so
 * the runner never reruns/recreates over a pending delete effect.
 *
 * A local-only runtime (`live.mode === "local"`) creates no remote outbox or
 * Sheet delete, so it may bypass the barrier safely. A sync/live-capable
 * context that is missing the direct-Sheet client or spreadsheet MUST fail
 * closed: without the observation seam no positive evidence can ever be
 * gathered, and silently proceeding would rerun over an unproven effect.
 *
 * @param {{ entityName: string, id: string, context: object }} input
 * @returns {Promise<void>} throws fail-closed when drain cannot be proven.
 */
async function confirmDeleteDrained({ entityName, id, context }) {
  const live = context?.live;
  // Local-only runtime: no remote outbox / Sheet delete exists to drain, so
  // the barrier is safely bypassed (no positive evidence is required).
  if (live?.mode === "local") return;
  const client = live?.client;
  const spreadsheetId = live?.spreadsheetId;
  // Sync-capable context that cannot observe the projection fails closed:
  // without the direct-Sheet seam the delete can never be positively proven.
  if (client === undefined || spreadsheetId === undefined) {
    throw new Error(
      "--resume failed: interrupted-cycle orphan deletion cannot be confirmed " +
      "drained because the sync/live context has no direct-Sheet observation " +
      "client; refusing to rerun over a pending delete effect",
    );
  }
  const deadline = Math.min(
    Date.now() + RECOVERY_DELETE_DRAIN_TIMEOUT_MS,
    context.deadlineAtMs ?? Number.MAX_SAFE_INTEGER,
  );
  const tabName = `${entityName}_System`;
  // Positive-evidence state: true once the id was observed ACTIVE (present,
  // not tombstoned). An initial absence never sets this, so it is never
  // mistaken for proof that the delete delivered.
  let sawActive = false;
  while (true) {
    if (Date.now() >= deadline) {
      throw new Error(
        "--resume failed: interrupted-cycle orphan deletion could not be " +
        "confirmed drained in the Sheet projection before the deadline; " +
        "refusing to rerun over a pending delete effect",
      );
    }
    const rows = await client.readTabRows(spreadsheetId, tabName, { deadlineAtMs: deadline });
    const headers = rows[0] ?? [];
    const idColumn = headers.indexOf("id");
    if (idColumn < 0) {
      await boundedSleep(RECOVERY_DELETE_DRAIN_POLL_MS, deadline);
      continue;
    }
    const tombColumn = headers.indexOf(TOMBSTONE_HEADER);
    const dataRows = rows.slice(1);
    // (b) tombstone/deleted marker: positive evidence the delete delivered.
    const tombstoned = tombColumn >= 0 && dataRows.some(
      (row) => row[idColumn] === id && isDisplayedBooleanTrue(row[tombColumn]),
    );
    if (tombstoned) return;
    const { ids } = extractProjectionIds(
      dataRows,
      idColumn,
      tombColumn >= 0 ? tombColumn : undefined,
    );
    const activePresent = ids.includes(id);
    if (activePresent) {
      // Positive active presence observed: (a) requires this to later absent.
      sawActive = true;
      await boundedSleep(RECOVERY_DELETE_DRAIN_POLL_MS, deadline);
      continue;
    }
    // The id is absent now. (a) positive evidence: active presence then
    // absence. A first/initial absence alone (sawActive still false) is NOT
    // proof and keeps polling until the deadline fails closed.
    if (sawActive) return;
    await boundedSleep(RECOVERY_DELETE_DRAIN_POLL_MS, deadline);
  }
}

/**
 * True when a cell displays an explicit boolean-true value (the same
 * conservative display check the projection parser uses for tombstones).
 *
 * Only an actual `true` or a string equal to `TRUE` (case-insensitive)
 * counts; a non-empty string such as `"FALSE"` or `"yes"` is never a
 * deleted marker.
 *
 * @param {unknown} cell the tombstone cell's displayed value.
 * @returns {boolean} true only for explicit boolean-true displays.
 */
function isDisplayedBooleanTrue(cell) {
  if (cell === true) return true;
  return typeof cell === "string" && cell.toUpperCase() === "TRUE";
}
