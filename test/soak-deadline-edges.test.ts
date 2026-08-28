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

/**
 * A coherent pre-write canonical baseline: the editable fields are empty,
 * matching the User_Input tab's displayed cells BEFORE the probe writes.
 * The coherent-baseline check requires the canonical row's editable values
 * to match the User_Input baseline, so the pre-write row must carry the
 * same empty cells the tab displays. Shared by both probe describes (the
 * polling edges and the User_Input readiness suites).
 */
function coherentBaselineRow() {
  return { id: "task-main-c0", ...Object.fromEntries(EDITABLE_FIELDS.map((field) => [field, ""])) };
}

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
  /**
   * Builds a probe context whose canonical-baseline read resolves through
   * `baselineRow` (the first two findOne calls: the readiness baseline and
   * the immediate pre-write revalidation) and whose acceptance read resolves
   * through `readRow` (after the write).
   */
  function probeContext(deadlineAtMs: number, readRow: () => Promise<unknown>, baselineRow: () => unknown = coherentBaselineRow) {
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
    const findOne = async (): Promise<unknown> => {
      findOneCalls += 1;
      // First two calls are the pre-write canonical-baseline checks (the
      // readiness loop and the immediate pre-write revalidation); later calls
      // are the post-write acceptance poll.
      return findOneCalls <= 2 ? baselineRow() : readRow();
    };
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
          fork: () => ({ findOne }),
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
    // Two readiness canonical-baseline reads ran BEFORE the write (the
    // readiness loop and the immediate pre-write revalidation); the
    // acceptance poll never started (the deadline was rechecked first).
    expect(findOneCalls()).toBe(2);
    expect(applyMutation).not.toHaveBeenCalled();
  });

  it("never accepts a success observed after the deadline: a slow poll read resolving late is failed", async () => {
    const startedAt = Date.now();
    const deadlineAtMs = startedAt + 10_000;
    const slowRead = deferred<unknown>();
    const { context, findOneCalls, applyMutation } = probeContext(
      deadlineAtMs,
      () => slowRead.promise,
      // The canonical baseline resolves immediately so the write happens;
      // only the acceptance read is slow and resolves after the deadline.
      coherentBaselineRow,
    );
    const probe = runHumanEditProbe(context, new Set());

    // The first sleep ends well inside the budget, so the poll read
    // STARTS before the deadline...
    await vi.advanceTimersByTimeAsync(PROBE_ACCEPT_POLL_MS);
    // Two canonical-baseline reads before the write (readiness + pre-write
    // revalidation), then the acceptance read that is about to start (and will
    // resolve late).
    expect(findOneCalls()).toBe(3);
    // ...but resolves only after it (a slow read that began pre-deadline).
    await vi.advanceTimersByTimeAsync(8_000);
    slowRead.release(matchingRow());
    const record = await probe;
    expect(record.record.status).toBe("failed");
    expect(record.record.reason).toBe("human-edit-not-accepted");
    // Two canonical-baseline reads before the write, one acceptance read that
    // began before the deadline and resolved late. The late acceptance is
    // never accepted as success.
    expect(findOneCalls()).toBe(3);
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
    // Two canonical-baseline reads before the write (readiness + pre-write
    // revalidation), one acceptance read.
    expect(findOneCalls()).toBe(3);
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
    let findOneCalls = 0;
    // The first two findOne calls are the pre-write canonical-baseline checks
    // (readiness + pre-write revalidation) and must be coherent with the
    // User_Input tab's empty editable cells; later calls are the acceptance
    // poll and must carry the accepted human value.
    const findOne = vi.fn(async () => {
      findOneCalls += 1;
      return findOneCalls <= 2
        ? { id: "task-main-c0", ...Object.fromEntries(EDITABLE_FIELDS.map((field) => [field, ""])) }
        : matchingRow();
    });
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
    // Two readiness reads (missing then ready) plus the immediate pre-write
    // revalidation read.
    expect(readTabRows).toHaveBeenCalledTimes(3);
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

  it("does not write to a stale baseline: the canonical row was deleted (binding tombstoned), so the probe fails missing_identity", async () => {
    // A present identity on the User_Input tab is not a current writable
    // baseline: the scenario cleanup may have already deleted the canonical
    // row (tombstoned its binding), so a human edit written there would
    // never be accepted. The probe must NOT write and fails with the stable
    // `missing_identity` class instead of a doomed write.
    const startedAt = Date.now();
    const deadlineAtMs = startedAt + PROBE_ACCEPT_POLL_MS;
    const applyMutation = vi.fn();
    const findOne = vi.fn(async () => null); // canonical row deleted
    const mutateInputCell = vi.fn(async () => undefined);
    const readTabRows = vi.fn().mockResolvedValue(readyInputTab());
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
    const probe = runHumanEditProbe(context, new Set());
    await vi.advanceTimersByTimeAsync(PROBE_ACCEPT_POLL_MS);
    const record = await probe;
    expect(record.record).toMatchObject({
      status: "failed",
      reason: "probe-error",
      statusClass: "missing_identity",
      table: "soak_tasks",
    });
    // The canonical baseline is required before any write.
    expect(findOne).toHaveBeenCalledTimes(1);
    expect(mutateInputCell).not.toHaveBeenCalled();
    expect(applyMutation).not.toHaveBeenCalled();
  });

  it("does not write to an incoherent baseline: the canonical row's editable values differ from the User_Input display", async () => {
    // A present identity whose canonical row exists is still not a current
    // writable baseline when the canonical editable values DIFFER from the
    // User_Input displayed cells (a stale projection that has not caught up
    // to a canonical update). The coherent-baseline check must fail closed
    // with zero writes and the stable `missing_identity` class.
    const startedAt = Date.now();
    const deadlineAtMs = startedAt + PROBE_ACCEPT_POLL_MS;
    const applyMutation = vi.fn();
    // The canonical row exists but its editable field values differ from the
    // User_Input tab's empty displayed cells.
    const findOne = vi.fn(async () => ({
      id: "task-main-c0",
      ...Object.fromEntries(EDITABLE_FIELDS.map((field) => [field, "stale-value"])),
    }));
    const mutateInputCell = vi.fn(async () => undefined);
    const readTabRows = vi.fn().mockResolvedValue(readyInputTab());
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
    const probe = runHumanEditProbe(context, new Set());
    await vi.advanceTimersByTimeAsync(PROBE_ACCEPT_POLL_MS);
    const record = await probe;
    expect(record.record).toMatchObject({
      status: "failed",
      reason: "probe-error",
      statusClass: "missing_identity",
      table: "soak_tasks",
    });
    // The coherent baseline is required before any write.
    expect(findOne).toHaveBeenCalledTimes(1);
    expect(mutateInputCell).not.toHaveBeenCalled();
    expect(applyMutation).not.toHaveBeenCalled();
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
    // One readiness read plus the immediate pre-write revalidation read.
    expect(readTabRows).toHaveBeenCalledTimes(2);
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

  it("never writes when the pre-write canonical revalidation read resolves after the deadline", async () => {
    // The readiness loop resolves a coherent baseline, but the immediate
    // pre-write canonical revalidation read (the second findOne) is slow and
    // resolves only after the phase deadline. The revalidation returns true
    // (its canonical read resolved late with a coherent row), so the final
    // atomic deadline check must stop the single write: zero writes, stable
    // missing_identity.
    const startedAt = Date.now();
    const deadlineAtMs = startedAt + 10_000;
    const slowCanonical = deferred<unknown>();
    const applyMutation = vi.fn();
    const mutateInputCell = vi.fn(async () => undefined);
    const readTabRows = vi.fn(async () => [
      ["id", ...EDITABLE_FIELDS],
      ["task-main-c0", ...EDITABLE_FIELDS.map(() => "")],
    ]);
    let findOneCalls = 0;
    const findOne = async (): Promise<unknown> => {
      findOneCalls += 1;
      // First call: the readiness canonical-baseline check (immediate).
      // Second call: the pre-write revalidation canonical read, which is slow
      // and resolves only after the phase deadline.
      if (findOneCalls === 1) return coherentBaselineRow();
      return slowCanonical.promise;
    };
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
    const probe = runHumanEditProbe(context, new Set());
    // The readiness read and its canonical check resolve immediately; the
    // pre-write revalidation read starts inside the budget. Flush the
    // microtask chain until the revalidation's canonical read is pending.
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 8 && findOneCalls < 2; i += 1) {
      await Promise.resolve();
    }
    expect(findOneCalls).toBe(2);
    // The pre-write canonical read resolves only AT/after the phase
    // deadline (start + 10s) with a coherent baseline: the revalidation
    // itself returns true, so the final atomic deadline check must be the
    // barrier that stops the write before it starts.
    await vi.advanceTimersByTimeAsync(10_000);
    slowCanonical.release(coherentBaselineRow());
    const record = await probe;
    expect(record.record).toMatchObject({
      status: "failed",
      reason: "probe-error",
      statusClass: "missing_identity",
      table: "soak_tasks",
    });
    expect(mutateInputCell).not.toHaveBeenCalled();
    expect(applyMutation).not.toHaveBeenCalled();
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
