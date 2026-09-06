/**
 * Neutral request-start admission for one paced provider lane.
 *
 * Google Sheets quota is enforced per principal, so a pool of N identities
 * paces N independent slots: each slot's read scheduler, write limiter,
 * per-minute budgets, and AIMD governor pace only against that identity's
 * own horizon. This module owns the slot table, the round-robin cursor, and
 * the bounded admission search; providers supply the limiter instances and
 * map the outcome (telemetry, transport-outcome feedback, refusal errors) at
 * their own boundary. A refusal returns `null` (never throws) so the caller
 * reports it in its own vocabulary.
 */

import {
  RATE_LIMIT_OPTIONS_ERROR_CODES,
  RateLimitOptionsError,
  type ReadQoSScheduler,
  type RequestStartLimiter,
} from "./rateLimiter.js";
import {
  QUOTA_GOVERNOR_LANES,
  type QuotaGovernorLane,
  type QuotaPacingGovernor,
  type RollingQuotaBudget,
} from "./quotaGovernor.js";

/** Read-class pacing selectors routed through the shared read QoS scheduler. */
export type ReadPacing = "polling" | "preflight";
/** Any request-start pacing lane (the read classes plus the write lane). */
export type RequestStartPacing = ReadPacing | "write";

/**
 * The complete admission stack for ONE pooled credential: the slot's read
 * scheduler, write limiter, per-minute budgets, and AIMD governor pace only
 * against that identity's own horizon. A refusal in one slot never advances
 * that slot's horizon, and one saturated slot never blocks another.
 */
export interface CredentialPacingSlot {
  readonly readScheduler: ReadQoSScheduler;
  readonly writeLimiter: RequestStartLimiter;
  readonly readBudget: RollingQuotaBudget;
  readonly writeBudget: RollingQuotaBudget;
  readonly quotaGovernor: QuotaPacingGovernor;
}

/**
 * Shared per-provider credential pool: the slot table plus the round-robin
 * cursor every request start advances. The cursor moves ONE step per request
 * start at selection time (even when every later slot attempt is refused — no
 * binding was made, and the rotation only needs to stay even over time); the
 * admission search then walks the remaining slots from the cursor onward,
 * trying each at most once under the shared admission deadline.
 */
export interface CredentialPacingPool {
  readonly slots: readonly CredentialPacingSlot[];
  nextIndex: number;
}

/**
 * Everything one bounded admission needs from the provider.
 *
 * The single-credential path passes its flat limiters as the one slot with
 * no pool; a pooled provider passes the same flat limiters (slot 0) plus
 * the pool. Quota/backoff markers (`timingDefaults`) are owned by the
 * governors the provider constructed, so they are not repeated here.
 */
export interface RequestStartPacingDeps {
  readonly maxRequestStartWaitMs: number;
  readonly now: () => number;
  readonly readScheduler: ReadQoSScheduler;
  readonly writeLimiter: RequestStartLimiter;
  readonly readBudget: RollingQuotaBudget;
  readonly writeBudget: RollingQuotaBudget;
  readonly quotaGovernor: QuotaPacingGovernor;
  /**
   * Per-credential pacing pool (credential pools with 2+ identities only).
   * `undefined` — the historical single-credential path — keeps admission
   * byte-identical: the flat fields above ARE the one slot.
   */
  readonly credentialPacing?: CredentialPacingPool;
}

/**
 * Outcome of one bounded admission: the enforced wait, the pooled identity
 * the wait was paid against (`undefined` on the single-credential path),
 * and that identity's slot so the transport-error path feeds AIMD feedback
 * to the SAME governor admission paced.
 */
export interface RequestStartAdmissionOutcome {
  readonly pacingWaitMs: number;
  readonly credentialIndex: number | undefined;
  readonly slot: CredentialPacingSlot;
}

/**
 * Builds the `{ credentialIndex }` request decoration that binds one paced
 * transport call to the identity admission selected. Returns an EMPTY object
 * on the single-credential path, so un-pooled requests stay byte-identical
 * to the pre-pool wire contract (the key is absent, not `undefined`).
 */
export function credentialBinding(
  credentialIndex: number | undefined,
): { credentialIndex?: number } {
  return credentialIndex === undefined ? {} : { credentialIndex };
}

/**
 * Acquires one bounded request-start slot, returning `null` (and logging
 * nothing) only when EVERY pooled identity refuses within the shared
 * admission deadline. Round-robin picks the STARTING slot from the pool
 * cursor, but a budget-or-lane refusal on that slot moves the search on to
 * the remaining slots (each tried at most once, from the cursor onward) with
 * only the time still left under the SAME deadline: a busy identity never
 * blocks a healthy sibling. The request is bound to the index ACTUALLY
 * admitted, so pacing and signing stay on one identity. A refusal NEVER
 * advances any limiter/scheduler horizon on any identity.
 *
 * Composition order per slot: the per-minute budget gates FIRST (it is the
 * outer quota ceiling), then the lane's interval pacing — both against that
 * slot's limiters. A class-pacing refusal AFTER a budget admission leaks
 * that one budget reservation until the window slides — accepted because
 * pacing refusals are already rare and the leak over-counts (never
 * under-counts) the budget, which is the safe direction for quota safety.
 * AIMD/budget bookkeeping happens only on the slot that was admitted.
 *
 * The whole search shares ONE admission budget: a single deadline
 * (`now + maxRequestStartWaitMs`) is computed once and every gate on every
 * slot attempt is bounded by the time still remaining, so total
 * bounded-admission waiting never exceeds `maxRequestStartWaitMs` (the
 * effect-lease headroom contract assumes exactly one bounded wait per
 * request start) — on a pooled run as on the single-credential path. A
 * deadline spent by earlier attempts makes every later gate refuse any
 * nonzero predicted wait immediately, so the loop itself stays bounded.
 *
 * Returns the summed budget + pacing wait for the granted slot (0 when both
 * were already available) PLUS the admitted identity, so callers bind the
 * transport call to the credential that was paced (admitted index = signing
 * client, no skew).
 */
export async function admitRequestStart(
  deps: RequestStartPacingDeps,
  pacing: RequestStartPacing,
): Promise<RequestStartAdmissionOutcome | null> {
  // Validate the bound ONCE before any deadline arithmetic: the limiters
  // validate their own `maxWaitMs` argument, but this helper pre-derives the
  // remaining-time bound, so an invalid configured bound (negative,
  // non-integer, NaN) must fail here with the SAME structured error the
  // limiters would have thrown when the raw bound reached them.
  const maxWaitMs = deps.maxRequestStartWaitMs;
  if (!Number.isSafeInteger(maxWaitMs) || maxWaitMs < 0) {
    throw new RateLimitOptionsError(
      RATE_LIMIT_OPTIONS_ERROR_CODES.MAX_WAIT_NON_NEGATIVE_REQUIRED,
    );
  }
  const lane = pacing === "write"
    ? QUOTA_GOVERNOR_LANES.WRITE
    : QUOTA_GOVERNOR_LANES.READ;
  // One shared admission deadline for the WHOLE search (every gate, every
  // slot): each waitForSlot bound is the time still remaining (never above
  // the validated bound), so bounded waits can never stack past
  // maxRequestStartWaitMs across slots.
  const admissionDeadline = deps.now() + maxWaitMs;
  const pool = deps.credentialPacing;
  if (pool !== undefined && pool.slots.length >= 2) {
    // Exactly ONE rotation step is consumed per request start, decided up
    // front (see CredentialPacingPool) even when every attempt is refused.
    const startIndex = pool.nextIndex % pool.slots.length;
    pool.nextIndex = (startIndex + 1) % pool.slots.length;
    for (let step = 0; step < pool.slots.length; step += 1) {
      const index = (startIndex + step) % pool.slots.length;
      const slot = pool.slots[index];
      if (slot === undefined) {
        // Unreachable while the provider owns the pool (indexes are always
        // taken modulo the slot count); fail closed rather than pace
        // against nothing.
        throw new Error("credential pacing cursor escaped the slot table");
      }
      const outcome = await tryAdmitOnSlot(
        deps, slot, lane, pacing, admissionDeadline, maxWaitMs, index,
      );
      if (outcome !== null) {
        return outcome;
      }
    }
    return null;
  }
  // Single-credential path (no pool, or a degenerate <2-slot pool): the flat
  // fields ARE the one slot, NO index is bound, and the attempt order is
  // byte-identical to the pre-pool admission.
  return tryAdmitOnSlot(deps, {
    readScheduler: deps.readScheduler,
    writeLimiter: deps.writeLimiter,
    readBudget: deps.readBudget,
    writeBudget: deps.writeBudget,
    quotaGovernor: deps.quotaGovernor,
  }, lane, pacing, admissionDeadline, maxWaitMs, undefined);
}

/**
 * Runs the full budget-then-pacing admission stack on ONE slot under the
 * shared deadline. Returns `null` when THIS slot refused (either gate) so
 * the caller can try the next sibling. A budget refusal reserves nothing;
 * a budget admission reserves PROVISIONALLY and is rolled back when the
 * later lane gate refuses, so a tried-and-refused slot always leaves its
 * budgets untouched and only the admitted slot pays AIMD/budget bookkeeping.
 */
async function tryAdmitOnSlot(
  deps: RequestStartPacingDeps,
  slot: CredentialPacingSlot,
  lane: QuotaGovernorLane,
  pacing: RequestStartPacing,
  admissionDeadline: number,
  maxWaitMs: number,
  credentialIndex: number | undefined,
): Promise<RequestStartAdmissionOutcome | null> {
  const budget = pacing === "write" ? slot.writeBudget : slot.readBudget;
  const budgetAdmission = await budget.waitForSlot(
    remainingAdmissionMs(admissionDeadline, deps.now(), maxWaitMs),
  );
  if (budgetAdmission.status === "refused") {
    return null;
  }
  const remainingMs = remainingAdmissionMs(admissionDeadline, deps.now(), maxWaitMs);
  const admission = pacing === "write"
    ? await slot.writeLimiter.waitForSlot(remainingMs)
    : await slot.readScheduler.waitForSlot(pacing, remainingMs);
  if (admission.status === "refused") {
    // The budget reserved provisionally above; this slot never starts a
    // request, so hand the reservation back. Rollback is identity-matched
    // and never advances the window (see RollingQuotaBudget.rollback).
    budget.rollback(budgetAdmission.reservation);
    return null;
  }
  // One successful request START counts toward this lane's AIMD quiet
  // period on THIS identity's governor (recovery steps advance only while
  // starts keep succeeding).
  slot.quotaGovernor.recordRequestStart(lane);
  return { pacingWaitMs: budgetAdmission.waitedMs + admission.waitedMs, credentialIndex, slot };
}

/**
 * Whole-millisecond time still left under the shared admission deadline,
 * clamped into [0, maxWaitMs]: a spent budget (clock past the deadline) makes
 * the next gate refuse any nonzero predicted wait, and a backward-moving
 * clock between the two gates can otherwise re-derive a bound ABOVE the
 * configured maximum. `maxWaitMs` is pre-validated by the caller, so the
 * result is always a non-negative safe integer (waitForSlot's own contract).
 */
function remainingAdmissionMs(deadline: number, now: number, maxWaitMs: number): number {
  return Math.min(maxWaitMs, Math.max(0, Math.floor(deadline - now)));
}
