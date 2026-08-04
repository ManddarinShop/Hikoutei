/**
 * Minimal FIFO async mutex used to serialize Gateway mutations.
 *
 * The coordinator owns one mutex per mutation lane. It is intentionally
 * in-process only: SQLite outbox, leases, and receipts remain the durable
 * authority. The mutex exists solely so the Node side never issues competing
 * mutations (and competing Apps Script `ScriptLock` acquisitions) for the same
 * spreadsheet within one process.
 *
 * Fairness is FIFO so an uncertain-recovery barrier cannot be starved by a
 * steady stream of new mutations.
 */
export interface AsyncMutexMetrics {
  /** Currently held by a mutation. */
  readonly locked: boolean;
  /** Mutations waiting for the lane. */
  readonly queued: number;
  /** Mutations completed (success or failure) since construction. */
  readonly completed: number;
}

/** Releases one acquired lane. Safe to call at most once. */
export type AsyncMutexRelease = () => void;

/**
 * A lockable, FIFO queue of deferred mutations.
 *
 * Serialization relies on a promise gate: the queue's tail resolves only when
 * the current holder releases, so every subsequent acquirer waits for the
 * previous holder rather than for the previous acquirer's microtask.
 */
export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();
  private active = false;
  private queueDepth = 0;
  private completedCount = 0;

  /**
   * Runs `task` once the lane is acquired. The lane is released even when the
   * task rejects, so a failing mutation never deadlocks the coordinator.
   */
  public async run<T>(task: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await task();
    } finally {
      release();
    }
  }

  /**
   * Acquires the lane and resolves with a release token. The caller must call
   * the returned release function exactly once, even on error, so the lane is
   * never left locked. This is the path used for multi-lane batch mutations
   * that must hold several lanes at once.
   */
  public acquire(): Promise<AsyncMutexRelease> {
    this.queueDepth += 1;
    const previous = this.tail;
    let gate: () => void;
    const next = new Promise<void>((resolve) => {
      gate = resolve;
    });
    this.tail = next;
    // The previous tail resolves when the prior holder releases; only then is
    // this acquirer allowed to mark the lane active and run.
    return previous.then(() => {
      this.active = true;
      return () => this.release(gate);
    });
  }

  /** Snapshot of queue depth and occupancy; diagnostic only. */
  public metrics(): AsyncMutexMetrics {
    return {
      locked: this.active,
      queued: Math.max(0, this.queueDepth - (this.active ? 1 : 0)),
      completed: this.completedCount,
    };
  }

  private release(gate: () => void): void {
    if (!this.active) return;
    this.active = false;
    this.queueDepth = Math.max(0, this.queueDepth - 1);
    this.completedCount += 1;
    // Resolve the gate so the next FIFO waiter proceeds.
    gate();
  }
}
