/**
 * Focused tests for the soak direct-Sheets cleanup selection and the
 * per-request deadline timeouts.
 *
 * The shared internal receipt tab must be deleted ONLY by a full-table
 * cleanup; a `--tables` subset cleanup keeps it so the untouched tables
 * can keep projecting. Selection logic is pure and tested without
 * credentials.
 *
 * MEDIUM 5: every SDK request resolves its OWN deadline timeout at the
 * moment it starts. The Google SDK is mocked (no credentials) and the
 * clock is faked, so tests prove that later requests of one multi-request
 * call get a reduced timeout — or abort with `deadline_expired` — instead
 * of reusing a timeout computed before the earlier requests.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertWithinRequestDeadline,
  combinedDeadlineAtMs,
  createDirectSheetsClient,
  DEFAULT_REQUEST_START_INTERVAL_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DirectSheetsError,
  RECEIPT_TAB_NAME,
  resolveDeadlineTimeout,
  resolveRequestTimeoutMs,
  resolveTabsToDelete,
} from "../scripts/ci/local-soak/sheetsDirect.mjs";

/** Fake SDK request log shared by the mocked client. */
const { fakeRequests, fakeRanges, fakeClient, gates, missingTabs, extraTabs } = vi.hoisted(() => {
  const fakeRequests: { method: "get" | "batchUpdate"; timeout: number }[] = [];
  /** Ranges of each issued get, parallel to fakeRequests (batch-proof). */
  const fakeRanges: string[][] = [];
  /** Requested tab names to OMIT from the formatted-value response. */
  const missingTabs: Set<string> = new Set();
  /** Extra sheet titles to append to the formatted-value response. */
  const extraTabs: Set<string> = new Set();
  /** Gates released by the test to control when each SDK call resolves. */
  const gates: ((value: unknown) => void)[] = [];
  const gate = () => new Promise((resolve) => { gates.push(resolve); });
  const fakeClient = {
    spreadsheets: {
      get: async (
        params: { fields?: string; ranges?: string[] },
        options: { timeout: number },
      ) => {
        fakeRequests.push({ method: "get", timeout: options.timeout });
        fakeRanges.push([...(params?.ranges ?? [])]);
        await gate();
        const fields = params?.fields ?? "";
        if (fields.includes("formattedValue")) {
          // The formatted-value response mirrors the requested ranges:
          // one sheet per requested tab (minus missingTabs), plus any
          // extraTabs — so tests can prove the batch keys rows by title
          // and ignores unrequested response sheets.
          const requestedTitles = (params?.ranges ?? [])
            .map((range) => range.slice(1, range.indexOf("'", 1)))
            .filter((title) => !missingTabs.has(title));
          const sheets = [...requestedTitles, ...extraTabs].map((title) => ({
            properties: { title },
            data: [{ rowData: [
              { values: [{ formattedValue: "id" }, { formattedValue: "title" }] },
              { values: [{ formattedValue: "task-main-c1" }, { formattedValue: "old" }] },
            ] }],
          }));
          return { data: { sheets } };
        }
        return {
          data: {
            sheets: [
              { properties: { sheetId: 11, title: "SoakTask_System" } },
              { properties: { sheetId: 12, title: "SoakTask_Input" } },
              { properties: { sheetId: 13, title: "SoakTask_Conflicts" } },
            ],
          },
        };
      },
      batchUpdate: async (_params: unknown, options: { timeout: number }) => {
        fakeRequests.push({ method: "batchUpdate", timeout: options.timeout });
        await gate();
        return { data: {} };
      },
    },
  };
  return { fakeRequests, fakeRanges, fakeClient, gates, missingTabs, extraTabs };
});

vi.mock("@googleapis/sheets", () => ({ sheets: () => fakeClient }));
vi.mock("google-auth-library", () => ({ GoogleAuth: class {} }));

/** Fake sheet properties: three tables' projection tabs plus the receipt. */
function fakeProperties() {
  return [
    { sheetId: 1, title: "SoakTask_System" },
    { sheetId: 2, title: "SoakTask_Input" },
    { sheetId: 3, title: "SoakTask_Conflicts" },
    { sheetId: 4, title: "SoakCustomer_System" },
    { sheetId: 5, title: "SoakCustomer_Input" },
    { sheetId: 6, title: "SoakCustomer_Conflicts" },
    { sheetId: 7, title: RECEIPT_TAB_NAME },
    { sheetId: 8, title: "SomeOtherSheet" },
  ];
}

describe("soak sheets direct: request deadline and timeout", () => {
  it("uses the configured default timeout when no deadline is set", () => {
    expect(resolveRequestTimeoutMs(DEFAULT_REQUEST_TIMEOUT_MS, undefined, 1_000)).toBe(
      DEFAULT_REQUEST_TIMEOUT_MS,
    );
    expect(resolveRequestTimeoutMs(5_000, undefined, 1_000)).toBe(5_000);
  });

  it("caps the timeout at the remaining deadline when the deadline is nearer", () => {
    // 40s left of a 120s default: the request must use 40s, never the full
    // default that could outlive the run budget.
    expect(resolveRequestTimeoutMs(DEFAULT_REQUEST_TIMEOUT_MS, 10_000 + 40_000, 10_000))
      .toBe(40_000);
  });

  it("keeps the default when the deadline is farther away than the default", () => {
    expect(resolveRequestTimeoutMs(DEFAULT_REQUEST_TIMEOUT_MS, 10_000 + 400_000, 10_000))
      .toBe(DEFAULT_REQUEST_TIMEOUT_MS);
  });

  it("floors the timeout at zero for an already-past deadline", () => {
    expect(resolveRequestTimeoutMs(DEFAULT_REQUEST_TIMEOUT_MS, 10_000, 12_000)).toBe(0);
    expect(resolveRequestTimeoutMs(DEFAULT_REQUEST_TIMEOUT_MS, 10_000, 10_000)).toBe(0);
  });

  it("aborts with the stable deadline_expired status class once expired", () => {
    expect(() => assertWithinRequestDeadline(10_000, 9_999)).not.toThrow();
    expect(() => assertWithinRequestDeadline(10_000, 10_000)).toThrow(DirectSheetsError);
    try {
      assertWithinRequestDeadline(10_000, 10_001);
      throw new Error("expected the deadline abort to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(DirectSheetsError);
      expect((error as DirectSheetsError).statusClass).toBe("deadline_expired");
    }
    // Without a deadline the check never aborts.
    expect(() => assertWithinRequestDeadline(undefined, 1_000_000)).not.toThrow();
  });

  it("resolveDeadlineTimeout computes the check and timeout from ONE atomic clock read", () => {
    // MEDIUM 5: the guard and the timeout share a single remaining-budget
    // calculation, so the deadline can never cross between two checks and
    // silently produce a 0ms (no-abort) timeout.
    expect(resolveDeadlineTimeout(DEFAULT_REQUEST_TIMEOUT_MS, 10_000 + 40_000, 10_000))
      .toBe(40_000);
    expect(resolveDeadlineTimeout(DEFAULT_REQUEST_TIMEOUT_MS, 10_000 + 400_000, 10_000))
      .toBe(DEFAULT_REQUEST_TIMEOUT_MS);
    expect(resolveDeadlineTimeout(5_000, undefined, 1_000)).toBe(5_000);
  });

  it("resolveDeadlineTimeout never returns a 0ms timeout once the deadline is reached", () => {
    // MEDIUM 5: at/past the deadline the atomic resolver THROWS the stable
    // deadline_expired error instead of returning 0 — a 0ms timeout would
    // be interpreted by HTTP clients as "no timeout" and the request would
    // run unbounded after the budget.
    for (const nowMs of [10_000, 10_001, 60_000]) {
      try {
        resolveDeadlineTimeout(DEFAULT_REQUEST_TIMEOUT_MS, 10_000, nowMs);
        throw new Error("expected resolveDeadlineTimeout to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(DirectSheetsError);
        expect((error as DirectSheetsError).statusClass).toBe("deadline_expired");
      }
    }
  });
});

describe("soak sheets direct: cleanup tab selection", () => {
  it("subset cleanup deletes only the named projection tabs, never the receipt tab", () => {
    const targets = resolveTabsToDelete(
      fakeProperties(),
      ["SoakTask_System", "SoakTask_Input", "SoakTask_Conflicts"],
      false,
    );
    expect(targets).toEqual([1, 2, 3]);
    expect(targets).not.toContain(7); // receipt tab survives a subset cleanup
  });

  it("full cleanup additionally removes the shared receipt tab", () => {
    const targets = resolveTabsToDelete(
      fakeProperties(),
      ["SoakTask_System", "SoakTask_Input", "SoakTask_Conflicts"],
      true,
    );
    expect(targets).toEqual([1, 2, 3, 7]);
  });

  it("skips entries without a usable sheetId or title", () => {
    const targets = resolveTabsToDelete(
      [
        { sheetId: 1, title: "SoakTask_System" },
        { title: "SoakTask_Input" }, // no sheetId
        { sheetId: 2 }, // no title
        undefined,
        { sheetId: 3, title: RECEIPT_TAB_NAME },
      ],
      ["SoakTask_System", "SoakTask_Input"],
      true,
    );
    expect(targets).toEqual([1, 3]);
  });

  it("returns an empty list when nothing matches", () => {
    expect(resolveTabsToDelete(fakeProperties(), ["SoakOrder_System"], false)).toEqual([]);
  });
});

describe("soak sheets direct: operation (phase) deadline", () => {
  afterEach(() => {
    vi.useRealTimers();
    fakeRequests.length = 0;
    fakeRanges.length = 0;
    missingTabs.clear();
    extraTabs.clear();
    // Drain any unreleased gates so a failed test cannot leak pending
    // promises into the next test.
    while (gates.length > 0) {
      gates.shift()!(undefined);
    }
  });

  /** Releases the next gated SDK call. */
  function releaseNextGate(): void {
    const release = gates.shift();
    expect(release).toBeTypeOf("function");
    release!(undefined);
  }

  it("combines the run deadline with the phase deadline as the earlier bound", () => {
    // No deadlines at all: no effective deadline.
    expect(combinedDeadlineAtMs(undefined, undefined)).toBeUndefined();
    // One side undefined: the other side rules unchanged.
    expect(combinedDeadlineAtMs(50_000, undefined)).toBe(50_000);
    expect(combinedDeadlineAtMs(undefined, 30_000)).toBe(30_000);
    // Both set: the EARLIER deadline is the effective one, so a phase can
    // never outlive its own timeout just because the run budget is larger.
    expect(combinedDeadlineAtMs(100_000, 10_000)).toBe(10_000);
    expect(combinedDeadlineAtMs(10_000, 100_000)).toBe(10_000);
    expect(combinedDeadlineAtMs(10_000, 10_000)).toBe(10_000);
  });

  it(
    "readTabRows timeouts against the phase deadline and aborts when the phase expires",
    async () => {
      vi.useFakeTimers();
      const startMs = 4_000_000;
      vi.setSystemTime(new Date(startMs));
      // The RUN deadline is far away (100s); the OPERATION (phase)
      // deadline is 5s away and must be the bound for every request.
      const client = createDirectSheetsClient({
        deadlineAtMs: startMs + 100_000,
        requestStartIntervalMs: 0,
      });

      const pending = client.readTabRows("s", "SoakTask_System", {
        deadlineAtMs: startMs + 5_000,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(fakeRequests).toEqual([{ method: "get", timeout: 5_000 }]);

      // The phase deadline passes while the request is in flight: the NEXT
      // request must abort with deadline_expired even though the run
      // deadline still has ~95s left — never a stale 95s timeout.
      vi.setSystemTime(new Date(startMs + 5_001));
      const rejection = expect(client.readTabRows("s", "SoakTask_System", {
        deadlineAtMs: startMs + 5_000,
      })).rejects.toMatchObject({
        name: "DirectSheetsError",
        statusClass: "deadline_expired",
      });
      await rejection;
      releaseNextGate(); // settle the first request
      await pending;
      // Only the first request ever started.
      expect(fakeRequests).toHaveLength(1);
    },
  );

  it(
    "mutateInputCell uses the phase deadline for EVERY request and aborts after the phase expires",
    async () => {
      vi.useFakeTimers();
      const startMs = 5_000_000;
      vi.setSystemTime(new Date(startMs));
      const client = createDirectSheetsClient({
        deadlineAtMs: startMs + 100_000,
        requestStartIntervalMs: 0,
      });
      const phaseDeadlineAtMs = startMs + 10_000;

      const pending = client.mutateInputCell({
        spreadsheetId: "s",
        tabName: "SoakTask_Input",
        identity: "task-main-c1",
        headerName: "title",
        value: "human-edit",
        deadlineAtMs: phaseDeadlineAtMs,
      });
      const rejection = expect(pending).rejects.toMatchObject({
        name: "DirectSheetsError",
        statusClass: "deadline_expired",
      });
      await vi.advanceTimersByTimeAsync(0);
      // Request #1 timeouts at the 10s phase budget, never the 100s run.
      expect(fakeRequests).toEqual([{ method: "get", timeout: 10_000 }]);

      // 8s later: request #2 has only 2s left of the phase.
      vi.setSystemTime(new Date(startMs + 8_000));
      releaseNextGate();
      await vi.advanceTimersByTimeAsync(0);
      expect(fakeRequests).toEqual([
        { method: "get", timeout: 10_000 },
        { method: "get", timeout: 2_000 },
      ]);

      // The phase expires before the write: the write must abort with
      // deadline_expired — the run deadline is still ~90s away, so only
      // the phase deadline can explain the abort.
      vi.setSystemTime(new Date(startMs + 10_001));
      releaseNextGate();
      await vi.advanceTimersByTimeAsync(0);
      await rejection;
      expect(fakeRequests).toHaveLength(2);
    },
  );

  it(
    "deleteTabs caps BOTH requests at the phase deadline",
    async () => {
      vi.useFakeTimers();
      const startMs = 6_000_000;
      vi.setSystemTime(new Date(startMs));
      const client = createDirectSheetsClient({
        deadlineAtMs: startMs + 100_000,
        requestStartIntervalMs: 0,
      });
      const phaseDeadlineAtMs = startMs + 6_000;

      const pending = client.deleteTabs(
        "s",
        ["SoakTask_System", "SoakTask_Input", "SoakTask_Conflicts"],
        { includeReceiptTab: true, deadlineAtMs: phaseDeadlineAtMs },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(fakeRequests).toEqual([{ method: "get", timeout: 6_000 }]);

      // 4s later the batch delete starts with the 2s that remain in the
      // phase — never the ~96s that remain in the run.
      vi.setSystemTime(new Date(startMs + 4_000));
      releaseNextGate();
      await vi.advanceTimersByTimeAsync(0);
      expect(fakeRequests).toEqual([
        { method: "get", timeout: 6_000 },
        { method: "batchUpdate", timeout: 2_000 },
      ]);
      releaseNextGate(); // settle the write
      await expect(pending).resolves.toEqual({ deleted: 3 });
    },
  );
});

describe("soak sheets direct: per-request deadline timeouts (MEDIUM 5)", () => {
  afterEach(() => {
    vi.useRealTimers();
    fakeRequests.length = 0;
    fakeRanges.length = 0;
    missingTabs.clear();
    extraTabs.clear();
    // Drain any unreleased gates so a failed test cannot leak pending
    // promises into the next test.
    while (gates.length > 0) {
      gates.shift()!(undefined);
    }
  });

  /** Releases the next gated SDK call. */
  function releaseNextGate(): void {
    const release = gates.shift();
    expect(release).toBeTypeOf("function");
    release!(undefined);
  }

  it(
    "mutateInputCell resolves a fresh timeout immediately before EVERY request",
    async () => {
      vi.useFakeTimers();
      const startMs = 1_000_000;
      vi.setSystemTime(new Date(startMs));
      const deadlineAtMs = startMs + 10_000;
      const client = createDirectSheetsClient({ deadlineAtMs, requestStartIntervalMs: 0 });

      // get #1 (tab rows read) starts at T0 with the full remaining budget.
      const pending = client.mutateInputCell({
        spreadsheetId: "s",
        tabName: "SoakTask_Input",
        identity: "task-main-c1",
        headerName: "title",
        value: "human-edit",
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(fakeRequests).toEqual([{ method: "get", timeout: 10_000 }]);

      // get #2 (sheet-id lookup) starts 3s later: its timeout is 7s, NOT
      // the stale 10s computed before the read.
      vi.setSystemTime(new Date(startMs + 3_000));
      releaseNextGate();
      await vi.advanceTimersByTimeAsync(0);
      expect(fakeRequests).toEqual([
        { method: "get", timeout: 10_000 },
        { method: "get", timeout: 7_000 },
      ]);

      // The write starts 2s later still: its timeout is 5s — a fresh clock
      // read right before the write request.
      vi.setSystemTime(new Date(startMs + 5_000));
      releaseNextGate();
      await vi.advanceTimersByTimeAsync(0);
      expect(fakeRequests).toEqual([
        { method: "get", timeout: 10_000 },
        { method: "get", timeout: 7_000 },
        { method: "batchUpdate", timeout: 5_000 },
      ]);
      releaseNextGate(); // settle the write
      await pending;
    },
  );

  it(
    "deleteTabs resolves a fresh timeout for the write after the sheet-list read",
    async () => {
      vi.useFakeTimers();
      const startMs = 2_000_000;
      vi.setSystemTime(new Date(startMs));
      const deadlineAtMs = startMs + 10_000;
      const client = createDirectSheetsClient({ deadlineAtMs, requestStartIntervalMs: 0 });

      const pending = client.deleteTabs(
        "s",
        ["SoakTask_System", "SoakTask_Input", "SoakTask_Conflicts"],
        { includeReceiptTab: true },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(fakeRequests).toEqual([{ method: "get", timeout: 10_000 }]);

      // 8s later the batch delete starts: it must use the 2s that remain,
      // never the 10s computed before the read.
      vi.setSystemTime(new Date(startMs + 8_000));
      releaseNextGate();
      await vi.advanceTimersByTimeAsync(0);
      expect(fakeRequests).toEqual([
        { method: "get", timeout: 10_000 },
        { method: "batchUpdate", timeout: 2_000 },
      ]);
      releaseNextGate(); // settle the write
      await pending;
    },
  );

  it(
    "a later request aborts with deadline_expired once the deadline passed",
    async () => {
      vi.useFakeTimers();
      const startMs = 3_000_000;
      vi.setSystemTime(new Date(startMs));
      const deadlineAtMs = startMs + 10_000;
      const client = createDirectSheetsClient({ deadlineAtMs, requestStartIntervalMs: 0 });

      const pending = client.mutateInputCell({
        spreadsheetId: "s",
        tabName: "SoakTask_Input",
        identity: "task-main-c1",
        headerName: "title",
        value: "human-edit",
      });
      // Attach the rejection handler NOW so the deadline abort can never
      // surface as an unhandled rejection while the clock advances.
      const rejection = expect(pending).rejects.toMatchObject({
        name: "DirectSheetsError",
        statusClass: "deadline_expired",
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(fakeRequests).toEqual([{ method: "get", timeout: 10_000 }]);

      // The deadline passes while the read is in flight: the next request
      // must NOT run with a stale timeout — it aborts with the stable
      // deadline_expired class.
      vi.setSystemTime(new Date(startMs + 10_001));
      releaseNextGate();
      await vi.advanceTimersByTimeAsync(0);
      await rejection;
      // Only the read actually started; nothing after the deadline ran.
      expect(fakeRequests).toHaveLength(1);
    },
  );
});

describe("soak sheets direct: request-start pacing", () => {
  afterEach(() => {
    vi.useRealTimers();
    fakeRequests.length = 0;
    fakeRanges.length = 0;
    missingTabs.clear();
    extraTabs.clear();
    // Drain any unreleased gates so a failed test cannot leak pending
    // promises into the next test.
    while (gates.length > 0) {
      gates.shift()!(undefined);
    }
  });

  it("defaults to the library-compatible 2,500 ms pacing", () => {
    expect(DEFAULT_REQUEST_START_INTERVAL_MS).toBe(2_500);
    expect(() => createDirectSheetsClient({ requestStartIntervalMs: -1 }))
      .toThrow(RangeError);
  });

  it("spaces consecutive observation reads one interval apart", async () => {
    vi.useFakeTimers();
    const startMs = 7_000_000;
    vi.setSystemTime(new Date(startMs));
    const client = createDirectSheetsClient({ requestStartIntervalMs: 2_500 });

    const first = client.readTabRows("s", "SoakTask_Input");
    await vi.advanceTimersByTimeAsync(0);
    // The first request starts immediately (no prior slot).
    expect(fakeRequests).toEqual([{ method: "get", timeout: DEFAULT_REQUEST_TIMEOUT_MS }]);

    const second = client.readTabRows("s", "SoakTask_Input");
    await vi.advanceTimersByTimeAsync(0);
    // The second request is held by the shared pacing gate: it must NOT
    // start beside the first (an unpaced burst would invalidate the
    // library quota test the soak observes).
    expect(fakeRequests).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(2_500);
    expect(fakeRequests).toHaveLength(2);
    releasePacingGate();
    releasePacingGate();
    await Promise.all([first, second]);
  });

  it("paces reads AND writes of one mutation through the shared gate", async () => {
    vi.useFakeTimers();
    const startMs = 8_000_000;
    vi.setSystemTime(new Date(startMs));
    const client = createDirectSheetsClient({ requestStartIntervalMs: 2_500 });

    const pending = client.mutateInputCell({
      spreadsheetId: "s",
      tabName: "SoakTask_Input",
      identity: "task-main-c1",
      headerName: "title",
      value: "human-edit",
    });
    await vi.advanceTimersByTimeAsync(0);
    // Request 1 (tab rows read) starts immediately.
    expect(fakeRequests).toEqual([{ method: "get", timeout: DEFAULT_REQUEST_TIMEOUT_MS }]);
    releasePacingGate();
    await vi.advanceTimersByTimeAsync(2_500);
    // Request 2 (sheet-id lookup) starts one interval later.
    expect(fakeRequests).toHaveLength(2);
    releasePacingGate();
    await vi.advanceTimersByTimeAsync(2_500);
    // Request 3 (the human-edit write) starts one interval later still:
    // the write shares the SAME gate as the reads.
    expect(fakeRequests).toEqual([
      { method: "get", timeout: DEFAULT_REQUEST_TIMEOUT_MS },
      { method: "get", timeout: DEFAULT_REQUEST_TIMEOUT_MS },
      { method: "batchUpdate", timeout: DEFAULT_REQUEST_TIMEOUT_MS },
    ]);
    releasePacingGate();
    await pending;
  });

  it("holds concurrent callers so no two requests start within one interval", async () => {
    vi.useFakeTimers();
    const startMs = 9_000_000;
    vi.setSystemTime(new Date(startMs));
    const client = createDirectSheetsClient({ requestStartIntervalMs: 2_500 });

    const first = client.readTabRows("s", "SoakTask_Input");
    const second = client.readTabRows("s", "SoakTask_Input");
    await vi.advanceTimersByTimeAsync(0);
    // Both callers reserved their slots synchronously: the first starts
    // immediately, the second only after the interval.
    expect(fakeRequests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_500);
    expect(fakeRequests).toHaveLength(2);
    releasePacingGate();
    releasePacingGate();
    await Promise.all([first, second]);
  });

  it("aborts with deadline_expired when the pacing wait overshoots the deadline", async () => {
    vi.useFakeTimers();
    const startMs = 10_000_000;
    vi.setSystemTime(new Date(startMs));
    const client = createDirectSheetsClient({
      deadlineAtMs: startMs + 1_000,
      requestStartIntervalMs: 2_500,
    });

    const first = client.readTabRows("s", "SoakTask_Input");
    await vi.advanceTimersByTimeAsync(0);
    expect(fakeRequests).toHaveLength(1);
    // Attach the rejection handler NOW so the deadline abort can never
    // surface as an unhandled rejection while the clock advances.
    const second = expect(client.readTabRows("s", "SoakTask_Input")).rejects
      .toMatchObject({ name: "DirectSheetsError", statusClass: "deadline_expired" });
    // The pacing wait (2,500 ms) overshoots the run deadline (1,000 ms):
    // the request must abort with deadline_expired instead of firing after
    // the budget — never a post-deadline start.
    await vi.advanceTimersByTimeAsync(2_500);
    await second;
    expect(fakeRequests).toHaveLength(1);
    releasePacingGate();
    await first;
  });
});

/** Releases the next gated SDK call (shared by the pacing describe). */
function releasePacingGate(): void {
  const release = gates.shift();
  expect(release).toBeTypeOf("function");
  release!(undefined);
}

describe("soak sheets direct: batched tab reads (readTabsRows)", () => {
  afterEach(() => {
    vi.useRealTimers();
    fakeRequests.length = 0;
    fakeRanges.length = 0;
    missingTabs.clear();
    extraTabs.clear();
    // Drain any unreleased gates so a failed test cannot leak pending
    // promises into the next test.
    while (gates.length > 0) {
      gates.shift()!(undefined);
    }
  });

  /** Releases the next gated SDK call. */
  function releaseNextGate(): void {
    const release = gates.shift();
    expect(release).toBeTypeOf("function");
    release!(undefined);
  }

  it("reads every requested tab in ONE get with one range per tab, in order", async () => {
    vi.useFakeTimers();
    const startMs = 20_000_000;
    vi.setSystemTime(new Date(startMs));
    const client = createDirectSheetsClient({
      deadlineAtMs: startMs + 60_000,
      requestStartIntervalMs: 0,
    });

    const pending = client.readTabsRows(
      "s",
      ["SoakTask_System", "SoakTask_Input", "SoakTask_Conflicts"],
      { deadlineAtMs: startMs + 60_000 },
    );
    await vi.advanceTimersByTimeAsync(0);
    // ONE request covers all three tabs — never one GET per tab.
    expect(fakeRequests).toEqual([{ method: "get", timeout: 60_000 }]);
    expect(fakeRanges).toEqual([[
      "'SoakTask_System'!A1:ZZ",
      "'SoakTask_Input'!A1:ZZ",
      "'SoakTask_Conflicts'!A1:ZZ",
    ]]);
    releaseNextGate();
    const rowsByTab = await pending;
    // Rows are keyed by REQUESTED tab name in requested order.
    expect(Object.keys(rowsByTab)).toEqual([
      "SoakTask_System",
      "SoakTask_Input",
      "SoakTask_Conflicts",
    ]);
    expect(rowsByTab.SoakTask_Input).toEqual([
      ["id", "title"],
      ["task-main-c1", "old"],
    ]);
  });

  it("keys rows by title, ignores unrequested response sheets, and maps absent tabs to empty rows", async () => {
    vi.useFakeTimers();
    const startMs = 20_100_000;
    vi.setSystemTime(new Date(startMs));
    const client = createDirectSheetsClient({
      deadlineAtMs: startMs + 60_000,
      requestStartIntervalMs: 0,
    });
    // The response carries an extra unrequested sheet AND omits one
    // requested tab: the batch must key by title, skip the extra sheet,
    // and still return every requested name (empty rows when absent).
    extraTabs.add("SoakCustomer_System");
    missingTabs.add("SoakTask_Conflicts");

    const pending = client.readTabsRows(
      "s",
      ["SoakTask_System", "SoakTask_Input", "SoakTask_Conflicts"],
      { deadlineAtMs: startMs + 60_000 },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(fakeRequests).toHaveLength(1);
    releaseNextGate();
    const rowsByTab = await pending;
    expect(Object.keys(rowsByTab)).toEqual([
      "SoakTask_System",
      "SoakTask_Input",
      "SoakTask_Conflicts",
    ]);
    expect(rowsByTab.SoakTask_Conflicts).toEqual([]);
    expect(rowsByTab).not.toHaveProperty("SoakCustomer_System");
    expect(rowsByTab.SoakTask_System).toEqual([
      ["id", "title"],
      ["task-main-c1", "old"],
    ]);
  });

  it("readTabRows routes through the batch helper with a single range", async () => {
    vi.useFakeTimers();
    const startMs = 20_200_000;
    vi.setSystemTime(new Date(startMs));
    const client = createDirectSheetsClient({
      deadlineAtMs: startMs + 60_000,
      requestStartIntervalMs: 0,
    });

    const pending = client.readTabRows("s", "SoakTask_Input", {
      deadlineAtMs: startMs + 60_000,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fakeRequests).toEqual([{ method: "get", timeout: 60_000 }]);
    expect(fakeRanges).toEqual([["'SoakTask_Input'!A1:ZZ"]]);
    releaseNextGate();
    await expect(pending).resolves.toEqual([
      ["id", "title"],
      ["task-main-c1", "old"],
    ]);
  });

  it("holds the whole batch under ONE pacing slot", async () => {
    vi.useFakeTimers();
    const startMs = 20_300_000;
    vi.setSystemTime(new Date(startMs));
    const client = createDirectSheetsClient({ requestStartIntervalMs: 2_500 });

    const first = client.readTabsRows("s", ["SoakTask_System", "SoakTask_Input"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(fakeRequests).toHaveLength(1);

    const second = client.readTabsRows("s", ["SoakTask_System", "SoakTask_Input"]);
    await vi.advanceTimersByTimeAsync(0);
    // The whole multi-tab batch is ONE request start: the second batch
    // waits one interval instead of starting beside the first.
    expect(fakeRequests).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(2_500);
    expect(fakeRequests).toHaveLength(2);
    releaseNextGate();
    releaseNextGate();
    await Promise.all([first, second]);
  });

  it("uses ONE atomic timeout for the whole batch and aborts once the phase expires", async () => {
    vi.useFakeTimers();
    const startMs = 20_400_000;
    vi.setSystemTime(new Date(startMs));
    const client = createDirectSheetsClient({
      deadlineAtMs: startMs + 100_000,
      requestStartIntervalMs: 0,
    });
    const phaseDeadlineAtMs = startMs + 5_000;

    const pending = client.readTabsRows(
      "s",
      ["SoakTask_System", "SoakTask_Input", "SoakTask_Conflicts"],
      { deadlineAtMs: phaseDeadlineAtMs },
    );
    await vi.advanceTimersByTimeAsync(0);
    // The ONE batched request timeouts at the phase budget, never the
    // 100s run deadline.
    expect(fakeRequests).toEqual([{ method: "get", timeout: 5_000 }]);

    // The phase expires: the next batch must abort with deadline_expired
    // even though the run deadline still has ~95s left.
    vi.setSystemTime(new Date(startMs + 5_001));
    const rejection = expect(client.readTabsRows(
      "s",
      ["SoakTask_System", "SoakTask_Input", "SoakTask_Conflicts"],
      { deadlineAtMs: phaseDeadlineAtMs },
    )).rejects.toMatchObject({
      name: "DirectSheetsError",
      statusClass: "deadline_expired",
    });
    await rejection;
    releaseNextGate(); // settle the first request
    await pending;
    // Only the first batch ever started.
    expect(fakeRequests).toHaveLength(1);
  });
});
