/**
 * Type declarations for `scripts/ci/local-soak/constants.mjs`.
 * Declares the constants imported by offline soak tests.
 */

export const CONVERGENCE_POLL_MS: number;
export const PROBE_ACCEPT_POLL_MS: number;
export const SYSTEM_STATE_READINESS_POLL_MS: number;
export const SCENARIO_OBSERVE_POLL_MS: number;
export const SCENARIO_REJECTION_SETTLE_OBSERVATIONS: number;
export const SCENARIO_RACE_WINNER_SETTLE_OBSERVATIONS: number;
export const RECOVERY_DELETE_DRAIN_TIMEOUT_MS: number;
export const RECOVERY_DELETE_DRAIN_POLL_MS: number;

export const RECOVERY_REASONS: Readonly<{
  INTERRUPTED_CYCLE_RECONCILED: "interrupted-cycle-reconciled";
  COMPLETED_CYCLE_CHECKPOINT: "completed-cycle-checkpoint";
  STALE_IN_FLIGHT_MARKER: "stale-in-flight-marker";
}>;

/** True when a value is a finite epoch-millis timestamp safe to ISO-render. */
export function isSafeEpochTimestampMs(value: unknown): boolean;
