/**
 * Type declarations for `scripts/ci/local-soak/scenarios/shiftedHumanEdit.mjs`.
 */

/** Stable scenario id. */
export const id: "shifted-human-edit";
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

/** True when a rejected direct-Sheet call is the fail-closed identity-shift guard. */
export function isIdentityShiftedRejection(error: unknown): boolean;

/** Classifies the raced edit/delete outcome against the identity invariant. */
export function classifyRaceOutcome(input: object): Promise<{
  status: string;
  expectedErrors: number;
  failures: number;
  reason: string;
  failureKinds?: string[];
}>;

/** Live action: race a human edit against a shifting row delete. */
export function execute(input: { plan: object; context: object }): Promise<{
  status: string;
  expectedErrors: number;
  failures: number;
  cleanupFailures?: number;
  reason?: string;
  reasonTag?: string;
  failureKinds?: string[];
}>;

/** Scenario-level proof that a resolved edit landed on the intended identity. */
export function verifyEditLanded(input: object): Promise<boolean>;

/** Deterministic idempotent orphan recovery for a process-death resume. */
export function recover(input: { plan: object; context: object }): Promise<{ removed: number }>;
