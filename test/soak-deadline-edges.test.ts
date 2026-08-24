/**
 * Fake-clock deadline-edge tests for the live probe polling and
 * convergence loops.
 *
 * Luna: probe polling rechecks the phase deadline immediately BEFORE the
 * poll read (`findOne`) after a bounded sleep AND before accepting a
 * success; convergence rechecks before every read (including the final
 * read of a multi-entity iteration) AND before returning success. A value
 * or converging projection observed only AFTER the deadline must be
 * recorded as a failed check — never a post-deadline `ok`.
 *
 * The fake clock (`vi.useFakeTimers` + `vi.setSystemTime`) drives
 * `Date.now()` and the runner's `sleep`/`setTimeout` in lockstep, so the
 * deadline cannot pass between a bounded sleep and the next check except
 * through the exact edge being tested. The deferred read gates are manual
 * promises resolved by the test, so a read can be made to resolve after
 * the deadline deterministically.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkSheetsConvergence,
  CONVERGENCE_POLL_MS,
  PROBE_ACCEPT_POLL_MS,
  runHumanEditProbe,
} from "../scripts/ci/local-soak/runner.mjs";
import { SOAK_FIELD_PLANS } from "../scripts/ci/local-soak/entities.mjs";
import { DirectSheetsError } from "../scripts/ci/local-soak/sheetsDirect.mjs";

/** Editable string fields of SoakTask (non-primary string fields). */
const EDITABLE_FIELDS = Object.entries(SOAK_FIELD_PLANS.SoakTask ?? {})
  .filter(([, spec]) => !spec.primary && spec.type === "string")
  .map(([field]) => field);

/** Deferred that the test resolves explicitly (never a timer). */
function deferred<T = void>(): { promise: Promise<T>; release: (value: T) => void } {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("probe polling deadline edges", () => {
  /** Builds a probe context whose findOne resolves through `readRow`. */
  function probeContext(deadlineAtMs: number, readRow: () => Promise<unknown>) {
    let findOneCalls = 0;
    const applyMutation = vi.fn();
    const mutateInputCell = vi.fn(async () => undefined);
    // The readiness barrier reads the User_Input tab; the target identity is
    // already visible under the probe's editable-field headers so the single
    // write proceeds immediately.
    const readTabRows = vi.fn(async () => [
      ["id", ...EDITABLE_FIELDS],
      ["task-main-c0", ...EDITABLE_FIELDS.map(() => "")],
    ]);
    const context = {
      cycle: 0,
      oracle: { applyMutation },
      tokenByEntity: new Map([["SoakTask", {}]]),
      activeEntities: [{ name: "SoakTask", tableName: "soak_tasks" }],
      live: {
        mode: "live" as const,
        spreadsheetId: "stub-spreadsheet",
        client: { mutateInputCell, readTabRows },
      },
      seed: 12345,
      deadlineAtMs,
      hikoutei: {
        em: {
          fork: () => ({
            findOne: async () => {
              findOneCalls += 1;
              return readRow();
            },
          }),
        },
      },
    };
    return {
      context,
      findOneCalls: () => findOneCalls,
      applyMutation,
      mutateInputCell,
      readTabRows,
    };
  }

  /**
   * A matching row for the probe's deterministic target id. The probe
   * picks its editable field through the seeded RNG (deterministically),
   * so the human value is carried under EVERY editable field.
   */
  function matchingRow() {
    return { id: "task-main-c0", ...Object.fromEntries(EDITABLE_FIELDS.map((field) => [field, "human-edit-c0"])) };
  }

  it("never runs a poll read after the deadline: the bounded sleep overshoot is rechecked first", async () => {
    const startedAt = Date.now();
    const deadlineAtMs = startedAt + PROBE_ACCEPT_POLL_MS;
    const { context, findOneCalls, applyMutation } = probeContext(
      deadlineAtMs,
      async () => matchingRow(),
    );
    const probe = runHumanEditProbe(context, new Set());

    // The first bounded sleep ends EXACTLY at the deadline (the poll
    // interval equals the remaining budget). The recheck must break
    // before findOne, even though the row would have matched.
    await vi.advanceTimersByTimeAsync(PROBE_ACCEPT_POLL_MS);
    const record = await probe;
    expect(record.record.status).toBe("failed");
    expect(record.record.reason).toBe("human-edit-not-accepted");
    expect(findOneCalls()).toBe(0);
    expect(applyMutation).not.toHaveBeenCalled();
  });

  it("never accepts a success observed after the deadline: a slow poll read resolving late is failed", async () => {
    const startedAt = Date.now();
    const deadlineAtMs = startedAt + 10_000;
    const slowRead = deferred<unknown>();
    const { context, findOneCalls, applyMutation } = probeContext(
      deadlineAtMs,
      () => slowRead.promise,
    );
    const probe = runHumanEditProbe(context, new Set());

    // The first sleep ends well inside the budget, so the poll read
    // STARTS before the deadline...
    await vi.advanceTimersByTimeAsync(PROBE_ACCEPT_POLL_MS);
    expect(findOneCalls()).toBe(1);
    // ...but resolves only after it (a slow read that began pre-deadline).
    await vi.advanceTimersByTimeAsync(8_000);
    slowRead.release(matchingRow());
    const record = await probe;
    expect(record.record.status).toBe("failed");
    expect(record.record.reason).toBe("human-edit-not-accepted");
    expect(applyMutation).not.toHaveBeenCalled();
  });

  it("accepts a success only while the deadline still holds (control)", async () => {
    const startedAt = Date.now();
    const deadlineAtMs = startedAt + 10_000;
    const { context, findOneCalls, applyMutation } = probeContext(
      deadlineAtMs,
      async () => matchingRow(),
    );
    const probe = runHumanEditProbe(context, new Set());
    await vi.advanceTimersByTimeAsync(PROBE_ACCEPT_POLL_MS);
    const record = await probe;
    expect(record.record.status).toBe("ok");
    expect(record.record.table).toBe("soak_tasks");
    expect(findOneCalls()).toBe(1);
    expect(applyMutation).toHaveBeenCalledTimes(1);
    expect(record.applied).toEqual({
      entityName: "SoakTask",
      field: expect.stringMatching(/^(title|tag)$/) as unknown as string,
      value: "human-edit-c0",
      targetId: "task-main-c0",
    });
  });
});

describe("probe User_Input readiness", () => {
  /** A matching row for the deterministic probe target. */
  function matchingRow() {
    return { id: "task-main-c0", ...Object.fromEntries(EDITABLE_FIELDS.map((field) => [field, "human-edit-c0"])) };
  }

  /** Valid User_Input rows for the probe's editable-field headers. */
  function readyInputTab(): unknown[][] {
    return [
      ["id", ...EDITABLE_FIELDS],
      ["task-main-c0", ...EDITABLE_FIELDS.map(() => "")],
    ];
  }

  /** Builds a live probe context with scripted readiness readTabRows. */
  function readinessProbeContext(
    deadlineAtMs: number,
    readTabRows: () => Promise<unknown[][]>,
    mutateInputCell = vi.fn(async () => undefined),
  ) {
    const applyMutation = vi.fn();
    const findOne = vi.fn(async () => matchingRow());
    const context = {
      cycle: 0,
      oracle: { applyMutation },
      tokenByEntity: new Map([["SoakTask", {}]]),
      activeEntities: [{ name: "SoakTask", tableName: "soak_tasks" }],
      live: {
        mode: "live" as const,
        spreadsheetId: "stub-spreadsheet",
        client: { mutateInputCell, readTabRows },
      },
      seed: 12345,
      deadlineAtMs,
      hikoutei: { em: { fork: () => ({ findOne }) } },
    };
    return { context, applyMutation, mutateInputCell, readTabRows };
  }

  it("waits for the identity to appear across readiness reads, then issues exactly ONE write and accepts", async () => {
    // System_State convergence passed but the User_Input row had not yet
    // projected: the probe must reread until the identity is observable
    // BEFORE issuing its single write.
    const startedAt = Date.now();
    const deadlineAtMs = startedAt + 10_000;
    const readTabRows = vi.fn()
      .mockResolvedValueOnce([["id", ...EDITABLE_FIELDS]])
      .mockResolvedValue(readyInputTab());
    const { context, applyMutation, mutateInputCell } =
      readinessProbeContext(deadlineAtMs, readTabRows);
    const probe = runHumanEditProbe(context, new Set());
    // First (missing) readiness read resolves and its bounded sleep ends;
    // the second (ready) read then issues the single write.
    await vi.advanceTimersByTimeAsync(PROBE_ACCEPT_POLL_MS);
    // The acceptance poll observes the accepted human value in SQLite.
    await vi.advanceTimersByTimeAsync(PROBE_ACCEPT_POLL_MS);
    const record = await probe;
    expect(record.record.status).toBe("ok");
    expect(readTabRows).toHaveBeenCalledTimes(2);
    expect(mutateInputCell).toHaveBeenCalledTimes(1);
    expect(applyMutation).toHaveBeenCalledTimes(1);
  });

  it("never writes when the identity never appears: stable missing_identity, zero writes, no post-deadline read", async () => {
    const startedAt = Date.now();
    // The phase budget equals one poll, so the deadline expires after the
    // first missing readiness read and its bounded sleep.
    const deadlineAtMs = startedAt + PROBE_ACCEPT_POLL_MS;
    const readTabRows = vi.fn().mockResolvedValue([["id", ...EDITABLE_FIELDS]]);
    const { context, mutateInputCell } =
      readinessProbeContext(deadlineAtMs, readTabRows);
    const probe = runHumanEditProbe(context, new Set());
    await vi.advanceTimersByTimeAsync(PROBE_ACCEPT_POLL_MS);
    const record = await probe;
    expect(record.record).toMatchObject({
      status: "failed",
      reason: "probe-error",
      statusClass: "missing_identity",
      table: "soak_tasks",
    });
    // One readiness read (before the deadline); the write never happens
    // and no read starts after the deadline.
    expect(readTabRows).toHaveBeenCalledTimes(1);
    expect(mutateInputCell).not.toHaveBeenCalled();
  });

  it("fails closed immediately without a write on a duplicated intended identity", async () => {
    const startedAt = Date.now();
    const deadlineAtMs = startedAt + 10_000;
    const readTabRows = vi.fn().mockResolvedValue([
      ["id", ...EDITABLE_FIELDS],
      ["task-main-c0", ...EDITABLE_FIELDS.map(() => "")],
      ["task-main-c0", ...EDITABLE_FIELDS.map(() => "")],
    ]);
    const { context, mutateInputCell } =
      readinessProbeContext(deadlineAtMs, readTabRows);
    const record = await runHumanEditProbe(context, new Set());
    expect(record.record).toMatchObject({
      status: "failed",
      reason: "probe-error",
      statusClass: "identity_shifted",
    });
    expect(mutateInputCell).not.toHaveBeenCalled();
    expect(readTabRows).toHaveBeenCalledTimes(1);
  });

  it("fails closed immediately without a write when the id header is missing or malformed", async () => {
    const startedAt = Date.now();
    const deadlineAtMs = startedAt + 10_000;
    const readTabRows = vi.fn().mockResolvedValue([["name"], ["x"]]);
    const { context, mutateInputCell } =
      readinessProbeContext(deadlineAtMs, readTabRows);
    const record = await runHumanEditProbe(context, new Set());
    expect(record.record).toMatchObject({
      status: "failed",
      reason: "probe-error",
      statusClass: "missing_header",
    });
    expect(mutateInputCell).not.toHaveBeenCalled();
    expect(readTabRows).toHaveBeenCalledTimes(1);
  });

  it("does not retry a rejected write and preserves the stable status class", async () => {
    const startedAt = Date.now();
    const deadlineAtMs = startedAt + 10_000;
    const readTabRows = vi.fn().mockResolvedValue(readyInputTab());
    // #364's fail-closed guard: the identity vanished before the write's
    // own snapshot, so the write rejects. It is never retried and its
    // status class is preserved.
    const mutateInputCell = vi.fn().mockRejectedValue(
      new DirectSheetsError("identity row not found", "missing_identity"),
    );
    const { context, mutateInputCell: mutate } =
      readinessProbeContext(deadlineAtMs, readTabRows, mutateInputCell);
    const record = await runHumanEditProbe(context, new Set());
    expect(record.record).toMatchObject({
      status: "failed",
      reason: "probe-error",
      statusClass: "missing_identity",
    });
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it("fails closed on a duplicated id header: malformed_header, zero writes", async () => {
    const startedAt = Date.now();
    const deadlineAtMs = startedAt + 10_000;
    const readTabRows = vi.fn().mockResolvedValue([
      ["id", "id", ...EDITABLE_FIELDS.filter((f) => f !== "id")],
      ["task-main-c0", "", ...EDITABLE_FIELDS.filter((f) => f !== "id").map(() => "")],
    ]);
    const { context, mutateInputCell } =
      readinessProbeContext(deadlineAtMs, readTabRows);
    const record = await runHumanEditProbe(context, new Set());
    expect(record.record).toMatchObject({
      status: "failed",
      reason: "probe-error",
      statusClass: "malformed_header",
    });
    expect(mutateInputCell).not.toHaveBeenCalled();
    expect(readTabRows).toHaveBeenCalledTimes(1);
  });

  it("fails closed before a whitespace/non-string header: malformed, zero writes", async () => {
    const startedAt = Date.now();
    const deadlineAtMs = startedAt + 10_000;
    const readTabRows = vi.fn().mockResolvedValue([
      ["id", "   ", ...EDITABLE_FIELDS.slice(1)],
      ["task-main-c0", "x", ...EDITABLE_FIELDS.slice(1).map(() => "")],
    ]);
    const { context, mutateInputCell } =
      readinessProbeContext(deadlineAtMs, readTabRows);
    const record = await runHumanEditProbe(context, new Set());
    expect(record.record).toMatchObject({
      status: "failed",
      reason: "probe-error",
      statusClass: "malformed_header",
    });
    expect(mutateInputCell).not.toHaveBeenCalled();
    expect(readTabRows).toHaveBeenCalledTimes(1);
  });

  it("fails closed on a malformed sparse non-empty row: identity_shifted, zero writes", async () => {
    const startedAt = Date.now();
    const deadlineAtMs = startedAt + 10_000;
    // A non-empty row whose id cell is blank is malformed and must fail
    // closed even though the intended identity is present and unique.
    const readTabRows = vi.fn().mockResolvedValue([
      ["id", ...EDITABLE_FIELDS],
      ["task-main-c0", ...EDITABLE_FIELDS.map(() => "")],
      ["", ...EDITABLE_FIELDS.map((_, i) => (i === 0 ? "stray" : ""))],
    ]);
    const { context, mutateInputCell } =
      readinessProbeContext(deadlineAtMs, readTabRows);
    const record = await runHumanEditProbe(context, new Set());
    expect(record.record).toMatchObject({
      status: "failed",
      reason: "probe-error",
      statusClass: "identity_shifted",
    });
    expect(mutateInputCell).not.toHaveBeenCalled();
    expect(readTabRows).toHaveBeenCalledTimes(1);
  });

  it("fails closed on a duplicated NON-target identity: identity_shifted, zero writes", async () => {
    const startedAt = Date.now();
    const deadlineAtMs = startedAt + 10_000;
    const readTabRows = vi.fn().mockResolvedValue([
      ["id", ...EDITABLE_FIELDS],
      ["task-main-c0", ...EDITABLE_FIELDS.map(() => "")],
      ["other", ...EDITABLE_FIELDS.map(() => "")],
      ["other", ...EDITABLE_FIELDS.map(() => "")],
    ]);
    const { context, mutateInputCell } =
      readinessProbeContext(deadlineAtMs, readTabRows);
    const record = await runHumanEditProbe(context, new Set());
    expect(record.record).toMatchObject({
      status: "failed",
      reason: "probe-error",
      statusClass: "identity_shifted",
    });
    expect(mutateInputCell).not.toHaveBeenCalled();
    expect(readTabRows).toHaveBeenCalledTimes(1);
  });

  it("treats fully blank padding rows as valid and writes once (control)", async () => {
    const startedAt = Date.now();
    const deadlineAtMs = startedAt + 10_000;
    // Blank/null/empty padding rows below the target carry no identity and
    // must NOT fail readiness; the single write still proceeds.
    const readTabRows = vi.fn().mockResolvedValue([
      ["id", ...EDITABLE_FIELDS],
      ["task-main-c0", ...EDITABLE_FIELDS.map(() => "")],
      [null, null],
      ["", ""],
    ]);
    const { context, applyMutation, mutateInputCell } =
      readinessProbeContext(deadlineAtMs, readTabRows);
    const probe = runHumanEditProbe(context, new Set());
    await vi.advanceTimersByTimeAsync(PROBE_ACCEPT_POLL_MS);
    const record = await probe;
    expect(record.record.status).toBe("ok");
    expect(mutateInputCell).toHaveBeenCalledTimes(1);
    expect(applyMutation).toHaveBeenCalledTimes(1);
    expect(readTabRows).toHaveBeenCalledTimes(1);
  });

  it("never writes when a slow readiness read resolves ready AT/after the deadline", async () => {
    const startedAt = Date.now();
    const deadlineAtMs = startedAt + 10_000;
    const slowRead = deferred<unknown[][]>();
    const readTabRows = vi.fn(() => slowRead.promise);
    const { context, mutateInputCell } =
      readinessProbeContext(deadlineAtMs, readTabRows);
    const probe = runHumanEditProbe(context, new Set());
    // The readiness read STARTS inside the budget (the first poll elapses)...
    await vi.advanceTimersByTimeAsync(PROBE_ACCEPT_POLL_MS);
    expect(readTabRows).toHaveBeenCalledTimes(1);
    // ...but resolves only after the deadline with a ready row: the write
    // must never start and the stable missing_identity failure is returned.
    await vi.advanceTimersByTimeAsync(8_000);
    slowRead.release(readyInputTab());
    const record = await probe;
    expect(record.record).toMatchObject({
      status: "failed",
      reason: "probe-error",
      statusClass: "missing_identity",
      table: "soak_tasks",
    });
    expect(mutateInputCell).not.toHaveBeenCalled();
    expect(readTabRows).toHaveBeenCalledTimes(1);
  });
});

describe("convergence deadline edges", () => {
  /** Builds a convergence context over two entities with scripted reads. */
  function convergenceContext(
    deadlineAtMs: number,
    readFor: (entryName: string) => Promise<unknown[][]>,
  ) {
    const called: string[] = [];
    const context = {
      cycle: 7,
      oracle: { ids: () => ["r1", "r2"] },
      activeEntities: [{ name: "E1" }, { name: "E2" }],
      live: {
        spreadsheetId: "stub-spreadsheet",
        client: {
          readTabRows: async (_spreadsheetId: string, tabName: string) => {
            const entryName = tabName.replace(/_System$/, "");
            called.push(entryName);
            return readFor(entryName);
          },
        },
      },
      deadlineAtMs,
    };
    return { context, called };
  }

  /** Converging rows for one entity: exactly the oracle id set. */
  function convergingRows(): string[][] {
    return [["id"], ["r1"], ["r2"]];
  }

  it("never starts a read after the deadline: the final read of an iteration is rechecked", async () => {
    const startedAt = Date.now();
    const deadlineAtMs = startedAt + 100;
    const firstRead = deferred<string[][]>();
    const { context, called } = convergenceContext(deadlineAtMs, (entryName) =>
      entryName === "E1" ? firstRead.promise : Promise.resolve(convergingRows()),
    );
    const convergence = checkSheetsConvergence(context, undefined);

    // E1's read is in flight; the deadline expires while it is pending.
    await vi.advanceTimersByTimeAsync(200);
    firstRead.release(convergingRows());
    // The iteration resumes past the deadline: E2's read must NEVER start
    // (the loop breaks at the pre-read recheck).
    await vi.advanceTimersByTimeAsync(1); // the trailing sleep(0) fires
    const record = await convergence;
    expect(record.status).toBe("failed");
    expect(called).toEqual(["E1"]);
    expect(called).not.toContain("E2");
  });

  it("never returns success when the last read resolved after the deadline", async () => {
    const startedAt = Date.now();
    const deadlineAtMs = startedAt + 100;
    const lastRead = deferred<string[][]>();
    const { context, called } = convergenceContext(deadlineAtMs, (entryName) =>
      entryName === "E1" ? Promise.resolve(convergingRows()) : lastRead.promise,
    );
    const convergence = checkSheetsConvergence(context, undefined);

    // Both reads START inside the budget (E2's begins while E1's result
    // is already converging)...
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    expect(called).toEqual(["E1", "E2"]);
    // ...but E2's read resolves after the deadline with converging data:
    // the success must NOT be accepted.
    await vi.advanceTimersByTimeAsync(200);
    lastRead.release(convergingRows());
    const record = await convergence;
    expect(record.status).toBe("failed");
    expect(record.missingRows).toBe(0);
    expect(record.duplicateRows).toBe(0);
  });

  it("returns ok only while the phase deadline still holds (control)", async () => {
    const startedAt = Date.now();
    const deadlineAtMs = startedAt + 1_000;
    const { context, called } = convergenceContext(
      deadlineAtMs,
      async () => convergingRows(),
    );
    const convergence = checkSheetsConvergence(context, undefined);
    await vi.advanceTimersByTimeAsync(0);
    const record = await convergence;
    expect(record).toEqual({ status: "ok", cycle: 7 });
    expect(called).toEqual(["E1", "E2"]);
  });
});
