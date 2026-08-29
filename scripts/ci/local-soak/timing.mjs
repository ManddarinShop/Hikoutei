/**
 * Deadline clock and bounded-sleep helpers.
 * Leaf module: no soak-module dependencies.
 */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Milliseconds left before an epoch deadline (never negative).
 *
 * @param {number} deadlineAtMs epoch milliseconds (same clock as Date.now()).
 * @param {number} [nowMs] current epoch milliseconds (default Date.now()).
 * @returns {number} remaining budget in milliseconds, floor 0.
 */
export function deadlineRemainingMs(deadlineAtMs, nowMs = Date.now()) {
  return Math.max(0, deadlineAtMs - nowMs);
}

/**
 * Bounded sleep honoring BOTH a poll interval and an epoch deadline.
 *
 * Resolves after `pollMs`, or at the deadline when it comes first, so a
 * live wait can never outlive the run budget by even one tick.
 *
 * @param {number} pollMs maximum sleep in milliseconds.
 * @param {number} deadlineAtMs epoch deadline (same clock as Date.now()).
 * @param {number} [nowMs] current epoch milliseconds (default Date.now()).
 */
export function boundedSleep(pollMs, deadlineAtMs, nowMs = Date.now()) {
  return sleep(Math.min(pollMs, deadlineRemainingMs(deadlineAtMs, nowMs)));
}

/**
 * Clock-slop tolerance (milliseconds) for deadline-expiry checks.
 *
 * A deadline-bounded wait (boundedSleep) can wake with `Date.now()` reading
 * up to ~1-2ms short of the nominal deadline: libuv timers are not guaranteed
 * to observe their nominal delay exactly in `Date.now()` terms, and coarse
 * or virtualized CI clocks under load can round the wake time low. A
 * single-shot expiry check immediately after such a wait must therefore
 * treat that sliver as expired — otherwise the invariant "a bounded sleep
 * ended => the deadline expired" flakily reads false and a doomed write
 * starts against an expired budget.
 */
export const CLOCK_SLOP_MS = 2;

/**
 * Deadline-expiry check with a small clock-slop tolerance.
 *
 * Use ONLY for single-shot checks made after a wait bounded by the SAME
 * deadline (e.g. a barrier jitter sleep): the slop exists so the
 * "deadline-bounded sleep ended => deadline expired" invariant holds even
 * when the clock reads marginally short after waking. Loop-head early exits
 * do NOT need it — a check that fires 1ms early there is harmless because
 * the loop exits via its other branch.
 *
 * @param {number} deadlineAtMs epoch deadline (same clock as Date.now()).
 * @param {number} [nowMs] current epoch milliseconds (default Date.now()).
 * @param {number} [slopMs] tolerance added to `nowMs` (default CLOCK_SLOP_MS).
 * @returns {boolean} true when `nowMs + slopMs` reaches `deadlineAtMs`.
 */
export function isDeadlineExpired(deadlineAtMs, nowMs = Date.now(), slopMs = CLOCK_SLOP_MS) {
  return nowMs + slopMs >= deadlineAtMs;
}

// Cross-module helpers split out of the monolithic runner.
// Plain setTimeout sleep used by execute/database/runner.
export {
  sleep,
};
