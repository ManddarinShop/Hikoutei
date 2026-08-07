/** Route grouping, chunking, and routing predicates for the effect worker. */

import type { Dispatcher } from "./dispatcher.js";
import type { ClaimedEffect } from "./contracts.js";
import type {
  FencingContext,
  PendingEffect,
  WriterLease,
} from "../index.js";
import { EFFECT_KINDS } from "../constants.js";
import {
  EFFECT_BATCH_LIMIT,
  OUTBOX_EFFECT_STATUSES,
} from "./constants.js";
import { throwWorkerError } from "./helpers.js";

/** One route-bound group of claimed effects. */
export interface EffectRouteGroup {
  readonly routeKey: string;
  readonly items: readonly ClaimedEffect[];
}

/** Groups claimed effects by the dispatcher-declared route key. */
export function groupEffectsByRoute(
  items: readonly ClaimedEffect[],
  routeKeyFor: Dispatcher["routeKeyFor"],
): readonly EffectRouteGroup[] {
  const groups = new Map<string, ClaimedEffect[]>();
  for (const item of items) {
    const key = routeKeyFor(item.pending);
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, [item]);
    } else {
      existing.push(item);
    }
  }
  return [...groups.entries()].map(([routeKey, grouped]) => ({ routeKey, items: grouped }));
}

/**
 * Splits each route group into sub-batches no larger than the dispatcher's
 * bounded effect batch (`EFFECT_BATCH_LIMIT`) so one apply call returns a
 * complete result set instead of a `hasMore` partial prefix.
 *
 * The route grouping and the per-target predecessor ordering of the supplied
 * items are preserved: every effect stays on its original route, and each
 * sub-batch keeps the order of the ready selection. Effects in one ready
 * selection target distinct logical targets (the outbox only marks the
 * earliest non-applied effect per target ready), so sub-batching never
 * reorders effects that depend on one another.
 */
export function chunkEffectGroups(
  groups: readonly EffectRouteGroup[],
  limit: number | ((group: EffectRouteGroup) => number) = EFFECT_BATCH_LIMIT,
): readonly EffectRouteGroup[] {
  if (groups.length === 0) return groups;
  const chunked: EffectRouteGroup[] = [];
  for (const group of groups) {
    const groupLimit = typeof limit === "function" ? limit(group) : limit;
    requireBatchLimit(groupLimit);
    if (group.items.length <= groupLimit) {
      chunked.push(group);
      continue;
    }
    for (let start = 0; start < group.items.length; start += groupLimit) {
      chunked.push({
        routeKey: group.routeKey,
        items: group.items.slice(start, start + groupLimit),
      });
    }
  }
  return chunked;
}

/**
 * Pending-level fast-append classification used to bound a bulk claim window
 * before claim. Recovery-status effects are excluded because the claim loop
 * diverts them to recovery regardless of their append shape; the dispatcher
 * owns the payload-derived candidacy decision.
 */
export function isFastAppendPendingEffect(
  pending: PendingEffect,
  dispatcher: Dispatcher,
): boolean {
  if (
    pending.status === OUTBOX_EFFECT_STATUSES.FAILED ||
    pending.status === OUTBOX_EFFECT_STATUSES.DELIVERY_UNCERTAIN
  ) {
    return false;
  }
  try {
    return dispatcher.isFastAppendCandidate(pending);
  } catch {
    // The candidate predicate is declared never to throw, but a violating
    // dispatcher must not abort the pass during selection. Treat the row as
    // a regular candidate here; if it is claimed, the claimed-item split
    // re-classifies it and fails it per-effect through the invalid-payload
    // path when the predicate still throws.
    return false;
  }
}

/**
 * Reconcile/delete effects whose visible fields protect a User_Input
 * candidate. Guard mismatches for these effects close as blocked_candidate
 * instead of conflict; the classification uses only kernel effect kinds.
 */
export function isCandidateProtectingUserInputEffect(pending: PendingEffect): boolean {
  return pending.effect_kind === EFFECT_KINDS.CANDIDATE_RECONCILE ||
    pending.effect_kind === EFFECT_KINDS.USER_INPUT_DELETE;
}

/** Builds the current fence from a claimed writer lease. */
export function fenceFromLease(lease: WriterLease, now: number): FencingContext {
  return {
    role: lease.role,
    writerEpoch: lease.writerEpoch,
    fencingToken: lease.fencingToken,
    now,
  };
}

function requireBatchLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throwWorkerError("provider effect batch limit must be a positive safe integer");
  }
}
