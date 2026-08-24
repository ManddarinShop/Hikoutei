/**
 * Type declarations for `scripts/ci/local-soak/scenarios/human-edit-public-delete.mjs`.
 */

/** Stable scenario id. */
export const id: "human-edit-public-delete";
/** Data scenario (overlaps data/base workload). */
export const kind: "data";
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

/** Live action: race a direct human edit against a public-API delete. */
export function execute(input: { plan: object; context: object }): Promise<{
  status: string;
  expectedErrors: number;
  failures: number;
  cleanupFailures?: number;
  reason?: string;
}>;

/** Deterministic idempotent orphan recovery for a process-death resume. */
export function recover(input: { plan: object; context: object }): Promise<{ removed: number }>;
