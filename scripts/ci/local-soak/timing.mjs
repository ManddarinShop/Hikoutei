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

// Cross-module helpers split out of the monolithic runner.
// Plain setTimeout sleep used by execute/database/runner.
export {
  sleep,
};
