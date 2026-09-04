/**
 * Unified write engine executor (mirrors the read side's `readEngine.ts`).
 *
 * Every provider write path (fast-append single/multi, apply target + inline
 * receipt follow-up, combined multi-route apply) runs the SAME mechanics:
 * build the batch (model/batchBuilder), pace one `batchUpdate` start on the
 * WRITE limiter (`runWrite`), and validate the reply
 * (`requireValidBatchUpdateReply`) so a malformed 2xx never closes effects.
 * `executeBatchUpdate` is the single implementation of that sequence; the
 * builders and the post-write result encoding stay with the callers because
 * their contents and bookkeeping differ per operation.
 *
 * `executePreparedWrite` is the single implementation of the receipt-tab
 * initialization guard: a read-ahead preflight can observe the shared receipt
 * tab absent before a concurrent write creates it, and two stale preflights
 * would otherwise both emit a duplicate `addSheet` (the second fails 400).
 * When the unit needs initialization, refresh + write run as ONE atomic
 * section on the per-spreadsheet `receiptInitLock`; steady state (receipt
 * present at preflight) never takes the lock. Callers keep their own
 * eligibility guard: a deterministic no-op batch must not take the refresh,
 * whose write-lane admission can be refused under saturation and would turn
 * the no-op into a delivery-uncertain requeue.
 *
 * `groupByRouteKey` is the single implementation of multi-route grouping:
 * items are bucketed by their canonical route key, first-seen group order and
 * per-group order preserved (the grouped plan order drives the combined byte
 * budget and the result walk, so both must stay stable).
 */

import { PRESENCE_KINDS } from "@hikoutei/contracts/state/index.js";
import type { BuiltApplyBatch } from "../model/batchBuilder.js";
import type { PreflightContext } from "../model/preflightContext.js";
import { refreshReceiptForWrite } from "./preflightOp.js";
import {
  requireValidBatchUpdateReply,
  runWrite,
  type GoogleSheetsApiProviderDeps,
} from "./shared.js";

/** Per-operation effect counts attached to one write event's telemetry. */
export interface WriteBatchTelemetry {
  /** Effects requested for the whole operation (pre-budget). */
  readonly requestedEffects: number;
  /** Effects included in the written batch (the budget-fitting prefix). */
  readonly includedEffects: number;
}

/**
 * Sends one built batch as ONE paced `batchUpdate` and validates the reply.
 *
 * `BuiltApplyBatch` is the shared return shape of every batch builder (apply,
 * append, and their combined variants), and the batch contents here are
 * exactly what the caller's builder produced: the engine never rebuilds or
 * reorders requests. A malformed or short reply throws the existing
 * delivery-uncertain invalid-state classification, so a 2xx that cannot be
 * matched request-for-request never closes effects. Zero-request batches must
 * be skipped by the caller (no transport call and no telemetry event for an
 * empty batch, exactly like before).
 */
export async function executeBatchUpdate(
  deps: GoogleSheetsApiProviderDeps,
  batch: BuiltApplyBatch,
  telemetry: WriteBatchTelemetry,
): Promise<void> {
  const response = await runWrite(deps, () =>
    deps.transport.batchUpdate({
      spreadsheetId: deps.spreadsheetId,
      requests: batch.requests,
    }), {
    requestCount: batch.requests.length,
    bodyBytes: batch.bytes,
    ...telemetry,
  });
  requireValidBatchUpdateReply(response, batch.requests.length);
}

/**
 * Runs one prepared write unit behind the receipt-init guard.
 *
 * `context` is whatever the write closure needs (a single route's
 * `PreflightContext` or a multi-route list). When `needsReceiptInit` is true,
 * `refresh` re-reads the shared receipt tab under the `receiptInitLock` and
 * `write` runs against the REFRESHED context inside the same lock section;
 * otherwise `write` runs against the preflight context with no lock. Failure
 * behavior is unchanged: a refused refresh admission or a rejected write
 * propagates with its own classification, and the tail lock still releases
 * for the next holder.
 */
export async function executePreparedWrite<C, R>(
  deps: GoogleSheetsApiProviderDeps,
  unit: {
    readonly context: C;
    readonly needsReceiptInit: boolean;
    readonly refresh: (context: C) => Promise<C>;
    readonly write: (context: C) => Promise<R>;
  },
): Promise<R> {
  if (!unit.needsReceiptInit) return unit.write(unit.context);
  return deps.receiptInitLock.run(async () =>
    unit.write(await unit.refresh(unit.context)));
}

/**
 * Refreshes the shared receipt tab through the FIRST route's context and
 * returns the route list with that context replaced (multi-route units).
 *
 * Provisioning guarantees one definition per tab, so every route of one
 * combined batch sees the SAME receipt-tab presence at preflight; refreshing
 * the first context is sufficient and later writers append instead of
 * re-emitting `addSheet`. An empty route list is returned unchanged (nothing
 * to refresh or write).
 */
export async function refreshFirstRouteContext<
  R extends { readonly context: PreflightContext },
>(
  deps: GoogleSheetsApiProviderDeps,
  routes: readonly R[],
): Promise<readonly R[]> {
  const first = routes[0];
  if (first === undefined) return routes;
  const refreshed = await refreshReceiptForWrite(deps, first.context);
  return routes.map((route, index) =>
    index === 0 ? { ...route, context: refreshed } : route);
}

/** True when a preflight context observed the shared receipt tab absent. */
export function receiptInitNeeded(context: PreflightContext): boolean {
  return context.receiptSheetId.kind === PRESENCE_KINDS.ABSENT;
}

/**
 * Buckets items by their canonical route key (see `routeKeyOf` in
 * applyEffects): first-seen group order and per-group order are preserved.
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
