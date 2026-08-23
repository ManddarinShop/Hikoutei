/**
 * Type declarations for `scripts/ci/local-soak/resumeHistoryProof.mjs`.
 * Declares the cycle-scenario batch proof used by offline soak tests.
 */

/** A recorded scenario entry within a cycle's scenario section. */
export interface RecordedScenario {
  id: string;
  phase: string;
  order: number;
  tag?: string;
  /** Allowlisted soak table the plan targets (binds the batch to its subset). */
  targetTable?: string;
}

/** The cycle record slice validated by the batch proof. */
export interface ScenarioBatchRecord {
  scenarios?: RecordedScenario[];
  abort?: unknown;
  /** Other cycle-record fields (e.g. `cycle`) are read by the schema, not the batch proof. */
  [key: string]: unknown;
}

/**
 * Validates the recorded per-cycle scenario batch against the deterministic
 * batch the (seed, cycle, active entity subset) composes. Returns `undefined`
 * when the batch is a valid full-completed or aborted ordered subset (or the
 * legacy record omits the scenario section entirely), otherwise a stable
 * failure reason string.
 *
 * `activeEntities` is the persisted active entity/table subset the run
 * composed the batch with; when undefined the full registry is assumed.
 */
export function validateCycleScenarioBatch(
  seed: number,
  cycle: number,
  record: ScenarioBatchRecord,
  activeEntities?: readonly object[],
): string | undefined;
