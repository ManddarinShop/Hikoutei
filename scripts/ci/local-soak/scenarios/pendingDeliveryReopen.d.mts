/**
 * Type declarations for `scripts/ci/local-soak/scenarios/pendingDeliveryReopen.mjs`.
 */

/** Stable scenario id. */
export const id: "pending-delivery-reopen";
/** Lifecycle scenario (must not overlap another lifecycle scenario). */
export const kind: "lifecycle";
/** Allowed phase windows. */
export const allowedPhases: readonly string[];
/** Stable redacted parameter tag. */
export const TAG: string;

/** Builds the deterministic plan for one cycle. */
export function plan(input: {
  seed: number;
  cycle: number;
  phase: string;
  order: number;
  rng: object;
}): Record<string, unknown>;

/** Live action: burst writes, optional close/reopen, read-back. */
export function execute(input: { plan: object; context: object }): Promise<{
  status: string;
  expectedErrors: number;
  failures: number;
  reason?: string;
  reasonTag?: string;
  failureKinds?: string[];
}>;
