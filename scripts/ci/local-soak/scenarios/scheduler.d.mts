/**
 * Type declarations for `scripts/ci/local-soak/scenarios/scheduler.mjs`.
 */

/** The three scenario execution windows within one standard soak cycle. */
export const SCENARIO_PHASES: Readonly<{
  AFTER_PROLOGUE: "after-prologue";
  CONCURRENT_WITH_ACTORS: "concurrent-with-actors";
  AFTER_ACTORS: "after-actors";
}>;

/** All scenario phase values. */
export const SCENARIO_PHASE_VALUES: readonly string[];

/** Scenario kinds: data vs lifecycle. */
export const SCENARIO_KINDS: Readonly<{ DATA: "data"; LIFECYCLE: "lifecycle" }>;

/** The deterministic plan a scenario module produces for a composed entry. */
export interface ScenarioPlan {
  /** Stable redacted scenario parameter tag (contract-required). */
  tag: string;
  /** Deterministic short execution jitter (ms). */
  jitterMs: number;
  [key: string]: unknown;
}

/** A composed scenario entry for one cycle. */
export interface ScenarioEntry {
  id: string;
  kind: string;
  phase: string;
  order: number;
  plan: ScenarioPlan;
  /** Allowlisted soak table the plan targets (required on composed entries). */
  targetTable: string;
  /** The registered scenario module (id/kind/allowedPhases/plan/execute). */
  scenario: object;
}

/** Composed batch: the deterministic scenario set for one cycle. */
export interface ScenarioBatch {
  cycle: number;
  scenarios: ScenarioEntry[];
}

/**
 * Composes the deterministic scenario batch for one cycle from (seed, cycle),
 * the registry contract, and the active entity subset.
 */
export function composeScenarioBatch(input: {
  seed: number;
  cycle: number;
  registry: readonly object[];
  /** Persisted active entity/table subset; full registry when omitted. */
  activeEntities?: readonly object[];
}): ScenarioBatch;

/** Returns the composed entries assigned to one phase, in execution order. */
export function scenariosForPhase(batch: ScenarioBatch, phase: string): ScenarioEntry[];

/** Executes one scenario entry and returns its redacted record. */
export function runScenario(input: {
  entry: ScenarioEntry;
  context: object;
}): Promise<Record<string, unknown>>;

/**
 * Runs every scenario assigned to one phase concurrently and returns the
 * redacted records sorted by deterministic `order`.
 */
export function runScenarioPhase(
  batch: ScenarioBatch,
  phase: string,
  context: object,
): Promise<Record<string, unknown>[]>;

/**
 * Runs each selected mutating scenario's deterministic orphan-recovery hook
 * for one interrupted in-flight cycle, through the public EntityManager
 * seams, before resume DB/history proof.
 */
export function runInterruptedCycleRecovery(input: {
  seed: number;
  cycle: number;
  registry: readonly object[];
  context: object;
}): Promise<{ removed: number }>;
