/**
 * Neutral write-batch executor (mirrors the banded read engine).
 *
 * Every provider write path runs the SAME mechanics: build the batch,
 * pace one atomic write start, and validate the reply so a malformed
 * success response never closes effects. `executeBatchUpdate` is the single
 * implementation of that sequence; the builders and the post-write result
 * encoding stay with the callers because their contents and bookkeeping
 * differ per operation.
 *
 * `executePreparedWrite` is the single implementation of the
 * initialization guard: a read-ahead preflight can observe shared state
 * absent before a concurrent write creates it, and two stale preflights
 * would otherwise both emit a duplicate creation. When the unit needs
 * initialization, refresh + write run as ONE atomic section on the
 * provider's init lock; steady state (present at preflight) never takes the
 * lock. Callers keep their own eligibility guard: a deterministic no-op
 * batch must not take the refresh, whose admission can be refused under
 * saturation and would turn the no-op into a requeue.
 *
 * `groupByRouteKey` is the single implementation of multi-route grouping:
 * items are bucketed by their canonical route key, first-seen group order
 * and per-group order preserved (the grouped plan order drives the combined
 * byte budget and the result walk, so both must stay stable).
 */

/** One built batch plus its serialized byte size (request shape is opaque). */
export interface BuiltBatch<TRequest> {
  readonly requests: readonly TRequest[];
  readonly bytes: number;
}

/** Per-operation effect counts attached to one write event's telemetry. */
export interface WriteBatchTelemetry {
  /** Effects requested for the whole operation (pre-budget). */
  readonly requestedEffects: number;
  /** Effects included in the written batch (the budget-fitting prefix). */
  readonly includedEffects: number;
}

/** Provider hooks for one atomic batch write. */
export interface BatchWriteHooks<TRequest> {
  /** Sends the caller's requests as ONE paced atomic write. */
  send(requests: readonly TRequest[]): Promise<unknown>;
  /**
   * Validates the write reply shape: one reply per request. A malformed
   * success response must throw the provider's delivery-uncertain invalid
   * state so a write that cannot be matched request-for-request never
   * closes effects.
   */
  validateReply(reply: unknown, requestCount: number): void;
}

/**
 * Sends one built batch as ONE paced atomic write and validates the reply.
 *
 * The batch contents here are exactly what the caller's builder produced:
 * the engine never rebuilds or reorders requests. Zero-request batches must
 * be skipped by the caller (no transport call and no telemetry event for an
 * empty batch).
 */
export async function executeBatchUpdate<TRequest>(
  batch: BuiltBatch<TRequest>,
  telemetry: WriteBatchTelemetry,
  hooks: BatchWriteHooks<TRequest>,
): Promise<void> {
  const response = await hooks.send(batch.requests);
  hooks.validateReply(response, batch.requests.length);
}

/**
 * Runs one prepared write unit behind the initialization guard.
 *
 * `context` is whatever the write closure needs. When `needsReceiptInit`
 * is true, `refresh` re-reads the shared state under the init `lock` and
 * `write` runs against the REFRESHED context inside the same lock section;
 * otherwise `write` runs against the preflight context with no lock.
 * Failure behavior is unchanged: a refused refresh admission or a rejected
 * write propagates with its own classification, and the tail lock still
 * releases for the next holder.
 */
export async function executePreparedWrite<C, R>(
  lock: { run<T>(task: () => Promise<T>): Promise<T> },
  unit: {
    readonly context: C;
    readonly needsReceiptInit: boolean;
    readonly refresh: (context: C) => Promise<C>;
    readonly write: (context: C) => Promise<R>;
  },
): Promise<R> {
  if (!unit.needsReceiptInit) return unit.write(unit.context);
  return lock.run(async () =>
    unit.write(await unit.refresh(unit.context)));
}

/**
 * Refreshes shared state through the FIRST route's context and returns the
 * route list with that context replaced.
 *
 * One definition per tab means every route of one combined batch sees the
 * SAME shared-state presence at preflight; refreshing the first context is
 * sufficient and later writers append instead of re-emitting creation. An
 * empty route list is returned unchanged (nothing to refresh or write).
 */
export async function refreshFirstRouteContext<
  C,
  R extends { readonly context: C },
>(
  refresh: (context: C) => Promise<C>,
  routes: readonly R[],
): Promise<readonly R[]> {
  const first = routes[0];
  if (first === undefined) return routes;
  const refreshed = await refresh(first.context);
  return routes.map((route, index) =>
    index === 0 ? { ...route, context: refreshed } : route);
}

/** True when a preflight observed the shared receipt state absent. */
export function receiptInitNeeded(receiptPresent: boolean): boolean {
  return !receiptPresent;
}

/**
 * Buckets items by their canonical route key: first-seen group order and
 * per-group order are preserved.
 */
export function groupByRouteKey<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
): readonly (readonly T[])[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [item]);
    } else {
      group.push(item);
    }
  }
  return [...groups.values()];
}
