/**
 * Type declarations for `scripts/ci/local-soak/scenarios/no-op-human-edit.mjs`.
 */

/** Stable scenario id. */
export const id: "no-op-human-edit";
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
  activeEntities?: readonly object[];
}): Record<string, unknown>;

/** Live action: write the same value already present in a cell (a no-op). */
export function execute(input: { plan: object; context: object }): Promise<{
  status: string;
  expectedErrors: number;
  failures: number;
  cleanupFailures?: number;
  reason?: string;
}>;

/** Deterministic idempotent orphan recovery for a process-death resume. */
export function recover(input: { plan: object; context: object }): Promise<{ removed: number }>;
