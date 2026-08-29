/**
 * Focused LIVE orchestration WIRING regression for the bounded close
 * deadline (issue #365, correction cycle 1).
 *
 * The helper (`resolveCycleDeadlineAtMs`) and the direct client are each
 * covered by their own unit tests, but those prove them in isolation:
 * reverting either orchestration call — `detectLiveMode(closeDeadlineAtMs)`
 * (the call that constructs the direct observation client with the bounded
 * CLOSE deadline) or `runOneCycle({ ... deadlineAtMs: cycleDeadlineAtMs })`
 * (the deadline the admitted live cycle actually runs under) — would pass
 * the isolated tests. This file drives the REAL `runLocalMultiTableSoak`
 * orchestration (the exact loop that computes both deadlines and passes them
 * at the two call sites) while mocking only the heavy/network-bound seams:
 *
 * - the runtime open is faked so no SQLite/runtime is opened and no
 *   credentials are needed (no deadlock);
 * - `runOneCycle` is faked so a cycle does no real work and returns a
 *   minimal success summary;
 * - `detectLiveMode` is wrapped to capture the deadline the orchestration
 *   passes to the client-construction call site.
 *
 * Date-only fake timers (`vi.useFakeTimers({ toFake: ["Date"] })`) control
 * the clock so the run admits exactly ONE live cycle (which must receive the
 * CLOSE deadline), then the BASE admission rule stops a new admission. Real
 * timers/SQLite are never touched. No production test-only callback was
 * added: Vitest module mocks prove the wiring.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  soakTestBeforeAll,
  soakTestBeforeEach,
  soakTestAfterEach,
  soakTestAfterAll,
  shortOptions,
} from "./support/soakRunnerShared.js";
import {
  CONVERGENCE_TIMEOUT_MS,
  runLocalMultiTableSoak,
} from "../scripts/ci/local-soak/runner.mjs";

vi.mock("@googleapis/sheets", async () => {
  const { liveSoakSheetsClient } = await import("./support/soakRunnerShared.js");
  return { sheets: () => liveSoakSheetsClient };
});
vi.mock("google-auth-library", () => ({ GoogleAuth: class {} }));

// Wiring spies: capture the exact deadlines the REAL orchestration passes to
// the two call sites under test. Hoisted so the module factories can read
// them regardless of vitest's import order.
const wiring = vi.hoisted(() => ({
  detectLiveDeadline: undefined as number | undefined,
  baseDeadline: undefined as number | undefined,
  cycleDeadlines: [] as number[],
  fakeRuntime: undefined as { close: () => Promise<void> } | undefined,
}));

// Replace the runtime OPEN (real SQLite/runtime) with a fake runtime so the
// orchestration loop runs against an inert handle instead of a live DB.
// `openRuntimeWithinDeadline` records the BASE workload-admission deadline
// the orchestration passes to the initial open, then returns the fake.
vi.mock("../scripts/ci/local-soak/database.mjs", async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  const fakeRuntime = { close: async () => undefined };
  wiring.fakeRuntime = fakeRuntime;
  return {
    ...real,
    openRuntime: async () => fakeRuntime,
    openRuntimeWithinDeadline: async (_open: () => Promise<unknown>, deadlineAtMs: number) => {
      wiring.baseDeadline = deadlineAtMs;
      return fakeRuntime;
    },
  };
});

// Replace `runOneCycle` so the loop does NO real SQLite work. It captures the
// `deadlineAtMs` each admitted cycle receives and advances the faked Date to
// just past the BASE deadline, so the orchestration's top-of-loop base
// admission check stops a second cycle.
vi.mock("../scripts/ci/local-soak/execute.mjs", async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  const fakeOneCycle = async (context: { deadlineAtMs: number }) => {
    wiring.cycleDeadlines.push(context.deadlineAtMs);
    // The ONE admitted live cycle returns a fabricated success summary (the
    // fields the orchestration loop reads).
    const summary = {
      durationMs: 1,
      tablesTouched: [],
      operations: { total: 0, expectedErrors: 0, failures: 0, retries: 0 },
      scenarioTotals: { expectedErrors: 0, failures: 0 },
    };
    // Advance past the base deadline so the loop's base admission check
    // stops here (no next cycle may be admitted after the base duration).
    if (wiring.baseDeadline !== undefined) {
      vi.setSystemTime(new Date(wiring.baseDeadline + 1));
    }
    return { hikoutei: wiring.fakeRuntime, reopened: false, summary };
  };
  return { ...real, runOneCycle: fakeOneCycle };
});

// Wrap `detectLiveMode` (runnerStartup) to capture the deadline the
// orchestration passes to the direct-client-construction call site and to
// return a live-mode descriptor (the client itself is never used because
// `runOneCycle` is faked).
vi.mock("../scripts/ci/local-soak/runnerStartup.mjs", async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  const fakeDetect = async (deadlineAtMs: number) => {
    wiring.detectLiveDeadline = deadlineAtMs;
    return { mode: "live", spreadsheetId: "wiring-spreadsheet", client: {} };
  };
  return { ...real, detectLiveMode: fakeDetect };
});

beforeAll(soakTestBeforeAll);
beforeEach(soakTestBeforeEach);
afterEach(soakTestAfterEach);
afterAll(soakTestAfterAll);

describe("soak runner live close-deadline orchestration wiring", () => {
  it(
    "constructs the direct client AND admits the live cycle with the SAME bounded close deadline, and base admission stops a new cycle",
    { timeout: 30_000 },
    async () => {
      // Reset captured wiring between runs (module factories persist).
      wiring.detectLiveDeadline = undefined;
      wiring.baseDeadline = undefined;
      wiring.cycleDeadlines.length = 0;

      // Date-only fake timers control the epoch clock; real timers and
      // SQLite stay untouched (the runtime open is faked above).
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(1_700_000_000_000));

      try {
        const summary = await runLocalMultiTableSoak(shortOptions({
          durationHours: 0.001,
        }));

        // The base workload-admission deadline was recorded at the initial
        // runtime open.
        expect(wiring.baseDeadline).toBeDefined();
        const base = wiring.baseDeadline!;

        // The orchestration constructs the direct client with the CLOSE
        // deadline (base + one convergence budget), never the base deadline.
        expect(wiring.detectLiveDeadline).toBe(base + CONVERGENCE_TIMEOUT_MS);

        // Exactly ONE live cycle was admitted, and it ran under the SAME
        // close deadline as the direct client.
        expect(wiring.cycleDeadlines).toEqual([base + CONVERGENCE_TIMEOUT_MS]);

        // The loop's base admission rule stopped a new cycle after the base
        // duration was reached (a second cycle would have pushed the fake
        // Date past base only if admission were broken).
        expect(summary.stopReason).toBe("duration-budget-reached");
        expect(summary.mode).toBe("live");
      } finally {
        vi.useRealTimers();
      }
    },
  );
});
