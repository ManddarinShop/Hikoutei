/**
 * Background heartbeat renewal for a writer lease the host already holds.
 *
 * A live writer process must keep `writer_lease.heartbeat_at` fresh so a NEW
 * process starting after a crash can take the dead lease over quickly (the
 * takeover evidence rule) instead of waiting out the full lease duration.
 * Between worker passes the effect supervisor stamps the heartbeat at pass
 * cadence, but hosts that claim other roles (the mapped entity writer) on a
 * slower schedule need this timer to keep their lease provably alive.
 *
 * The heartbeat is STRICTLY renew-only (`renewWriterLeaseWithAdapter`): it
 * extends only the caller's own live lease and never claims or takes over.
 * Takeover decisions stay exclusively with the worker pass's claim path, so
 * a background timer can never steal the lease back from another live owner.
 * When the lease is not held the tick reports `not_held` through `onEvent`
 * and keeps running: once the pass (or the host's next claim) acquires the
 * lease again, renewals succeed without any timer restart.
 */

import type { SqlStorageAdapter } from "../sql/sql.js";
import {
  DEFAULT_WRITER_LEASE_HEARTBEAT_INTERVAL_MS,
  renewWriterLeaseWithAdapter,
  type WriterLeaseRenewResult,
} from "../outbox/writerLease.js";
import { DEFAULT_WRITER_LEASE_DURATION_MS } from "./constants.js";

/** Observable outcome of one heartbeat tick. */
export interface WriterLeaseHeartbeatEvent {
  readonly at: number;
  readonly result: WriterLeaseRenewResult;
}

export interface WriterLeaseHeartbeatOptions {
  readonly storage: SqlStorageAdapter;
  readonly role: string;
  readonly writerId: string;
  /**
   * Lease extension applied on every renewal. Must match the duration the
   * writer's own claim path uses so the lease never lapses between a pass
   * renewal and a heartbeat tick.
   */
  readonly leaseDurationMs?: number;
  /** Cadence of renewal ticks; must stay well under the stale-evidence bound. */
  readonly intervalMs?: number;
  readonly now?: () => number;
  /** Receives every tick outcome (renewed or not held). Never throws into the loop. */
  readonly onEvent?: (event: WriterLeaseHeartbeatEvent) => void;
  /** Receives tick errors (storage failures). Never throws into the loop. */
  readonly onError?: (error: unknown) => void;
}

/** Control handle for one background heartbeat timer. */
export interface WriterLeaseHeartbeatHandle {
  /** Stops the timer and waits for the in-flight tick to settle; idempotent. */
  stop(): Promise<void>;
  /** Whether the timer is currently running. */
  isRunning(): boolean;
}

/**
 * Starts a background writer-lease heartbeat. The timer is unref'd so it
 * never keeps a host process alive on its own; `stop()` must still be called
 * on graceful shutdown so the lease stops being renewed and expires (or is
 * released) for the next writer.
 */
export function createWriterLeaseHeartbeat(
  options: WriterLeaseHeartbeatOptions,
): WriterLeaseHeartbeatHandle {
  const now = options.now ?? Date.now;
  const leaseDurationMs = options.leaseDurationMs ?? DEFAULT_WRITER_LEASE_DURATION_MS;
  const intervalMs = requirePositiveInteger(
    options.intervalMs ?? DEFAULT_WRITER_LEASE_HEARTBEAT_INTERVAL_MS,
    "heartbeat interval",
  );
  if (options.role.length === 0 || options.writerId.length === 0) {
    throw new Error("writer lease heartbeat requires a role and writer ID");
  }

  let running = true;
  let inFlight: Promise<void> | undefined;

  const tick = async (): Promise<void> => {
    const at = now();
    try {
      const result = await renewWriterLeaseWithAdapter(options.storage, {
        role: options.role,
        writerId: options.writerId,
        leaseDurationMs,
        now: at,
      });
      options.onEvent?.({ at, result });
    } catch (error: unknown) {
      options.onError?.(error);
    }
  };

  const timer = setInterval(() => {
    if (!running || inFlight !== undefined) return;
    inFlight = tick().finally(() => {
      inFlight = undefined;
    });
  }, intervalMs);
  // A heartbeat must never keep a host process alive by itself.
  timer.unref?.();

  return {
    stop: async () => {
      running = false;
      clearInterval(timer);
      const pending = inFlight;
      if (pending !== undefined) await pending.catch(() => undefined);
      inFlight = undefined;
    },
    isRunning: () => running,
  };
}

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}