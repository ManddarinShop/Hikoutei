/**
 * Type declarations for `scripts/ci/local-soak/timing.mjs`.
 */

/** Clock-slop tolerance (milliseconds) for deadline-expiry checks. */
export const CLOCK_SLOP_MS: number;

/** Milliseconds left before an epoch deadline (never negative). */
export function deadlineRemainingMs(
  deadlineAtMs: number,
  nowMs?: number,
): number;

/** Bounded sleep honoring BOTH a poll interval and an epoch deadline. */
export function boundedSleep(
  pollMs: number,
  deadlineAtMs: number,
  nowMs?: number,
): Promise<void>;

/**
 * Deadline-expiry check with a small clock-slop tolerance (true when
 * `nowMs + slopMs >= deadlineAtMs`). Only for single-shot checks made after
 * a wait bounded by the same deadline.
 */
export function isDeadlineExpired(
  deadlineAtMs: number,
  nowMs?: number,
  slopMs?: number,
): boolean;

/** Plain setTimeout sleep used by execute/database/runner. */
export function sleep(ms: number): Promise<void>;