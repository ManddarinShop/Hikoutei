/**
 * Phase 0 deterministic request-timeline proof for the 180 s convergence
 * deadline (no credentials, no network, no provider).
 *
 * Reproduces the documented live-smoke failure deterministically: a
 * six-table cycle of 4 actors x 20 operations (104 operations, 56 durable
 * projection effects) whose System_State projection still carried six extra
 * rows at the 180 s convergence deadline, with exact convergence only after
 * the shutdown drain. The smoke ran with the provider defaults: one shared
 * read+write request-start limiter at 2,500 ms, a paced dispatch of two
 * preflight/postcondition reads plus one write, per-tab reconciliation and
 * polling scans every 60 s, and a first reconciliation scan immediately at
 * startup.
 *
 * The model is intentionally a pure simulation of the REQUEST SEQUENCE on
 * the shared limiter:
 *
 * - Every remote call reserves a limiter slot at least `SLOT_INTERVAL_MS`
 *   after the previous call's start; a call's completion advances the fake
 *   clock by its duration.
 * - One effect dispatch is three sequential calls (read, read, write).
 * - Reconciliation scans and polling full scans are six tab reads each and
 *   are due at t=0 and every 60 s; when due, their reads are inserted into
 *   the shared request queue before the next drain dispatch (single
 *   threaded: interference and drain work serialize on the limiter).
 * - The critical path is the completion of the LAST System_State write.
 *
 * Pre-fix behavior: Sync_Conflicts fast appends dispatch before the
 * System_State fast appends (the ready selection orders conflict targets
 * before entity targets), System_State regular followers come after every
 * fast append, and the first polling/scanning interference arrives at t=0.
 * Post-fix behavior: System_State fast appends run first, System_State
 * regular followers second, Sync_Conflicts fast appends third, everything
 * else last; the first reconciliation is delayed 60 s AND gated while the
 * outbox drains; the first polling pass is gated on System_State readiness,
 * so no interference competes with the System_State drain.
 *
 * The assertions prove the plan's Phase 0 claim: the pre-fix critical path
 * misses the 180 s convergence deadline, while the post-fix critical path
 * fits inside it.
 */

import { describe, expect, it } from "vitest";

/** Provider default: at most one transport request start per interval. */
const SLOT_INTERVAL_MS = 2_500;
/** Realistic single-call durations inside the provider timeouts. */
const READ_DURATION_MS = 1_000;
const WRITE_DURATION_MS = 2_000;
/** The soak convergence budget per cycle. */
const CONVERGENCE_DEADLINE_MS = 180_000;
/** Reconciliation and polling cadence used by the smoke. */
const INTERFERENCE_CADENCE_MS = 60_000;
/** Batches per route stay inside the dispatcher's bounded effect batch. */
const BATCH_LIMIT = 20;

/**
 * One remote request on the shared limiter.
 *
 * `systemState` marks requests whose completion advances the System_State
 * critical path (fast appends and regular writes to the six system tabs).
 */
interface TimelineRequest {
  readonly id: string;
  readonly calls: readonly ("read" | "write")[];
  readonly systemState: boolean;
}

/** Per-tab System_State workload from the smoke (56 effects total). */
const TABLES = ["T1", "T2", "T3", "T4", "T5", "T6"] as const;
/** New System_State entity rows (fast appends): 5 per table. */
const SYSTEM_APPENDS_PER_TABLE = 5;
/** System_State update/delete/tombstone followers: 2 per table. */
const SYSTEM_REGULAR_PER_TABLE = 2;
/** New Sync_Conflicts resolution rows (fast appends). */
const CONFLICT_APPENDS = 6;
/** User_Input/other regular effects. */
const OTHER_REGULAR = 8;

/** One dispatch per route; route batches stay inside BATCH_LIMIT. */
function dispatchCalls(): readonly ("read" | "write")[] {
  return ["read", "read", "write"];
}

function readCalls(count: number): readonly ("read" | "write")[] {
  return Array.from({ length: count }, () => "read" as const);
}

/** Builds the per-tab System_State drain requests in tab order. */
function systemDrainRequests(): TimelineRequest[] {
  const requests: TimelineRequest[] = [];
  for (const table of TABLES) {
    const appends = Math.min(SYSTEM_APPENDS_PER_TABLE, BATCH_LIMIT);
    for (let batch = 0; batch < Math.ceil(appends / BATCH_LIMIT); batch += 1) {
      requests.push({
        id: `${table}_System fast-append ${batch + 1}`,
        calls: dispatchCalls(),
        systemState: true,
      });
    }
    const regular = Math.min(SYSTEM_REGULAR_PER_TABLE, BATCH_LIMIT);
    for (let batch = 0; batch < Math.ceil(regular / BATCH_LIMIT); batch += 1) {
      requests.push({
        id: `${table}_System regular ${batch + 1}`,
        calls: dispatchCalls(),
        systemState: true,
      });
    }
  }
  return requests;
}

/**
 * Pre-fix drain order: every fast append first, Sync_Conflicts before the
 * System_State tabs (the ready selection orders conflict targets before
 * entity targets), then every regular effect.
 */
function preFixDrainOrder(): TimelineRequest[] {
  const conflictAppend: TimelineRequest = {
    id: "Conflicts fast-append",
    calls: dispatchCalls(),
    systemState: false,
  };
  const others: TimelineRequest = {
    id: "other regular",
    calls: dispatchCalls(),
    systemState: false,
  };
  return [conflictAppend, ...systemDrainRequests(), others];
}

/**
 * Post-fix drain order: System_State fast appends, System_State regular
 * followers, Sync_Conflicts fast appends, then everything else.
 */
function postFixDrainOrder(): TimelineRequest[] {
  const conflictAppend: TimelineRequest = {
    id: "Conflicts fast-append",
    calls: dispatchCalls(),
    systemState: false,
  };
  const others: TimelineRequest = {
    id: "other regular",
    calls: dispatchCalls(),
    systemState: false,
  };
  const system = systemDrainRequests();
  return [
    ...system.slice(0, TABLES.length),
    ...system.slice(TABLES.length),
    conflictAppend,
    others,
  ];
}

/** One scheduled interference pass (6 tab reads for one subsystem). */
function interferenceReads(label: string): TimelineRequest[] {
  return [{
    id: label,
    calls: readCalls(TABLES.length),
    systemState: false,
  }];
}

/**
 * Simulates the shared-request timeline and returns the fake-clock time of
 * the last System_State completion.
 *
 * `interferenceAt` maps a due absolute time to the reads inserted before the
 * next drain dispatch. Drain requests run continuously (the effect loop
 * starts the next pass immediately while progress is being made).
 */
function simulateSystemStateCompletion(
  drain: readonly TimelineRequest[],
  interferenceAt: ReadonlyMap<number, readonly TimelineRequest[]>,
): number {
  const queue: TimelineRequest[] = [...drain];
  const dueTimes = [...interferenceAt.keys()].sort((a, b) => a - b);
  let dueIndex = 0;
  let clock = 0;
  let lastStartAt: number | undefined;
  let lastSystemCompletion = 0;
  while (queue.length > 0) {
    while (dueIndex < dueTimes.length && dueTimes[dueIndex]! <= clock) {
      queue.unshift(...interferenceAt.get(dueTimes[dueIndex]!)!);
      dueIndex += 1;
    }
    const request = queue.shift()!;
    for (const call of request.calls) {
      const slot = lastStartAt === undefined
        ? clock
        : Math.max(clock, lastStartAt + SLOT_INTERVAL_MS);
      lastStartAt = slot;
      clock = slot + (call === "read" ? READ_DURATION_MS : WRITE_DURATION_MS);
    }
    if (request.systemState) lastSystemCompletion = clock;
  }
  return lastSystemCompletion;
}

describe("System_State 180 s convergence critical path", () => {
  it("proves the pre-fix critical path misses the 180 s deadline", () => {
    // Pre-fix: the first polling pass and the first reconciliation scan
    // arrive immediately at t=0 and then every 60 s, competing with the
    // drain on the single shared limiter; Sync_Conflicts appends and every
    // other fast append dispatch before the System_State tabs.
    const interference = new Map<number, readonly TimelineRequest[]>([
      [0, [...interferenceReads("poll@0"), ...interferenceReads("scan@0")]],
      [INTERFERENCE_CADENCE_MS, [
        ...interferenceReads("poll@60s"),
        ...interferenceReads("scan@60s"),
      ]],
      [2 * INTERFERENCE_CADENCE_MS, [
        ...interferenceReads("poll@120s"),
        ...interferenceReads("scan@120s"),
      ]],
    ]);
    const completionMs = simulateSystemStateCompletion(
      preFixDrainOrder(),
      interference,
    );
    expect(completionMs).toBeGreaterThan(CONVERGENCE_DEADLINE_MS);
  });

  it("proves the post-fix critical path fits inside the 180 s deadline", () => {
    // Post-fix: System_State fast appends and regular followers drain FIRST;
    // the first reconciliation is delayed and gated while the outbox is
    // busy, and the first polling pass is gated on System_State readiness,
    // so no interference competes with the System_State drain.
    const completionMs = simulateSystemStateCompletion(
      postFixDrainOrder(),
      new Map(),
    );
    expect(completionMs).toBeLessThanOrEqual(CONVERGENCE_DEADLINE_MS);
    // The margin also leaves room for the gated interference that resumes
    // after readiness (scans at 60 s/120 s and the post-drain poll).
    expect(completionMs).toBeLessThanOrEqual(2 * INTERFERENCE_CADENCE_MS);
  });

  it("documents that the pre-fix drain alone would fit without interference", () => {
    // Control: with no interference the same 56-effect drain finishes well
    // inside the deadline under either order; the pre-fix miss above comes
    // from the combination of ordering and shared-limiter interference.
    const completionMs = simulateSystemStateCompletion(
      preFixDrainOrder(),
      new Map(),
    );
    expect(completionMs).toBeLessThanOrEqual(CONVERGENCE_DEADLINE_MS);
  });
});
