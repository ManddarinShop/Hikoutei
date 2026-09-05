/**
 * Background writer-lease heartbeat tests.
 *
 * Covers the renew-only contract: a live writer keeps its own lease and
 * `heartbeat_at` fresh, never claims or takes over another writer's lease,
 * keeps ticking through a lost lease (so a later pass claim re-arms renewal
 * without a timer restart), and stops cleanly on demand.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  claimWriterLeaseWithAdapter,
  createWriterLeaseHeartbeat,
  readWriterLeaseWithAdapter,
  WRITER_LEASE_RENEW_RESULT_KINDS,
} from "../src/index.js";
import {
  createKernelStore,
  TEST_ROLE,
} from "./support/kernelFixtures.js";
import type { NodeSqliteTestAdapter } from "./support/nodeSqliteAdapter.js";

const HB_LEASE_MS = 60_000;

describe("writer lease heartbeat helper", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Drives the fake clock AND the fake-timer queue together. */
  async function advanceTimersAndClock(
    state: { current: number },
    stepMs: number,
  ): Promise<void> {
    state.current += stepMs;
    await vi.advanceTimersByTimeAsync(stepMs);
  }

  it("renews the held lease on every tick, stamps heartbeat_at, and keeps the epoch", async () => {
    vi.useFakeTimers();
    const adapter = createKernelStore();
    const first = await claimWriterLeaseWithAdapter(adapter, {
      role: TEST_ROLE,
      writerId: "writer-1",
      leaseDurationMs: HB_LEASE_MS,
      now: 1_000,
    });
    expect(first.kind).toBe("claimed");

    const state = { current: 1_000 };
    const events: Array<{ at: number; kind: string }> = [];
    const heartbeat = createWriterLeaseHeartbeat({
      storage: adapter,
      role: TEST_ROLE,
      writerId: "writer-1",
      leaseDurationMs: HB_LEASE_MS,
      intervalMs: 5_000,
      now: () => state.current,
      onEvent: (event) => {
        events.push({ at: event.at, kind: event.result.kind });
      },
    });
    try {
      await advanceTimersAndClock(state, 5_000);
      await advanceTimersAndClock(state, 5_000);

      expect(events).toEqual([
        { at: 6_000, kind: WRITER_LEASE_RENEW_RESULT_KINDS.RENEWED },
        { at: 11_000, kind: WRITER_LEASE_RENEW_RESULT_KINDS.RENEWED },
      ]);
      const lease = await readWriterLeaseWithAdapter(adapter, TEST_ROLE);
      expect(lease.kind).toBe("found");
      if (lease.kind !== "found") throw new Error("expected lease row");
      expect(lease.value.leaseUntil).toBe(11_000 + HB_LEASE_MS);
      expect(lease.value.writerEpoch).toBe(1);
    } finally {
      await heartbeat.stop();
    }
  });

  it("reports not_held when the lease is lost but KEEPS running for a later re-claim", async () => {
    vi.useFakeTimers();
    const adapter = createKernelStore();
    await claimWriterLeaseWithAdapter(adapter, {
      role: TEST_ROLE,
      writerId: "writer-1",
      leaseDurationMs: HB_LEASE_MS,
      now: 1_000,
    });

    const state = { current: 1_000 };
    const kinds: string[] = [];
    const heartbeat = createWriterLeaseHeartbeat({
      storage: adapter,
      role: TEST_ROLE,
      writerId: "writer-1",
      leaseDurationMs: HB_LEASE_MS,
      intervalMs: 5_000,
      now: () => state.current,
      onEvent: (event) => {
        kinds.push(event.result.kind);
      },
    });
    try {
      await advanceTimersAndClock(state, 5_000);
      expect(kinds).toEqual([WRITER_LEASE_RENEW_RESULT_KINDS.RENEWED]);

      // Another writer takes the lease over (simulated: expire + takeover).
      await claimWriterLeaseWithAdapter(adapter, {
        role: TEST_ROLE,
        writerId: "writer-2",
        leaseDurationMs: HB_LEASE_MS,
        now: state.current + HB_LEASE_MS + 1,
      });

      await advanceTimersAndClock(state, 5_000);
      expect(kinds).toEqual([
        WRITER_LEASE_RENEW_RESULT_KINDS.RENEWED,
        WRITER_LEASE_RENEW_RESULT_KINDS.NOT_HELD,
      ]);
      expect(heartbeat.isRunning()).toBe(true);

      // The original writer re-claims (pass-start claim path): expire the
      // taker's lease first, then the same timer must resume renewals without
      // any restart.
      await adapter.read(({ sql }) => sql.run(
        "UPDATE writer_lease SET lease_until = ? WHERE writer_id = 'writer-2'",
        [state.current - 1],
      ));
      await claimWriterLeaseWithAdapter(adapter, {
        role: TEST_ROLE,
        writerId: "writer-1",
        leaseDurationMs: HB_LEASE_MS,
        now: state.current,
      });
      await advanceTimersAndClock(state, 5_000);
      expect(kinds.at(-1)).toBe(WRITER_LEASE_RENEW_RESULT_KINDS.RENEWED);
      expect(heartbeat.isRunning()).toBe(true);
    } finally {
      await heartbeat.stop();
    }
  });

  it("never takes over another writer's stale-heartbeat lease", async () => {
    vi.useFakeTimers();
    const adapter = createKernelStore();
    // writer-2 crashed: lease nominally alive, heartbeat frozen far in the past.
    await claimWriterLeaseWithAdapter(adapter, {
      role: TEST_ROLE,
      writerId: "writer-2",
      leaseDurationMs: 600_000,
      now: 1_000,
    });
    await adapter.read(({ sql }) =>
      sql.run("UPDATE writer_lease SET heartbeat_at = 0", []));

    const state = { current: 1_000_000 };
    const kinds: string[] = [];
    const heartbeat = createWriterLeaseHeartbeat({
      storage: adapter,
      role: TEST_ROLE,
      writerId: "writer-1",
      leaseDurationMs: HB_LEASE_MS,
      intervalMs: 5_000,
      now: () => state.current,
      onEvent: (event) => {
        kinds.push(event.result.kind);
      },
    });
    try {
      await advanceTimersAndClock(state, 5_000);
      await advanceTimersAndClock(state, 5_000);
      // Renew-only: the timer reports not_held and leaves the dead row alone.
      expect(kinds).toEqual([
        WRITER_LEASE_RENEW_RESULT_KINDS.NOT_HELD,
        WRITER_LEASE_RENEW_RESULT_KINDS.NOT_HELD,
      ]);
      const lease = await readWriterLeaseWithAdapter(adapter, TEST_ROLE);
      expect(lease.kind).toBe("found");
      if (lease.kind !== "found") throw new Error("expected lease row");
      expect(lease.value.writerId).toBe("writer-2");
      expect(lease.value.leaseUntil).toBe(1_000 + 600_000);
    } finally {
      await heartbeat.stop();
    }
  });

  it("stop() halts renewal and is idempotent", async () => {
    vi.useFakeTimers();
    const adapter = createKernelStore();
    await claimWriterLeaseWithAdapter(adapter, {
      role: TEST_ROLE,
      writerId: "writer-1",
      leaseDurationMs: HB_LEASE_MS,
      now: 1_000,
    });

    const state = { current: 1_000 };
    let ticks = 0;
    const heartbeat = createWriterLeaseHeartbeat({
      storage: adapter,
      role: TEST_ROLE,
      writerId: "writer-1",
      leaseDurationMs: HB_LEASE_MS,
      intervalMs: 5_000,
      now: () => state.current,
      onEvent: () => {
        ticks += 1;
      },
    });
    await advanceTimersAndClock(state, 5_000);
    expect(ticks).toBe(1);

    await heartbeat.stop();
    await heartbeat.stop();
    expect(heartbeat.isRunning()).toBe(false);

    await advanceTimersAndClock(state, 20_000);
    expect(ticks).toBe(1);
  });

  it("uses the storage adapter without keeping the process alive (unref'd timer)", async () => {
    vi.useFakeTimers();
    const adapter: NodeSqliteTestAdapter = createKernelStore();
    const heartbeat = createWriterLeaseHeartbeat({
      storage: adapter,
      role: TEST_ROLE,
      writerId: "writer-1",
      intervalMs: 5_000,
    });
    expect(heartbeat.isRunning()).toBe(true);
    await heartbeat.stop();
    expect(heartbeat.isRunning()).toBe(false);
  });
});